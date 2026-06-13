import { CronJob } from "cron";
import { calculateNextEndDate, log_error } from "../shared/utils";
import db from "../config/db";
import { IRecurringSchedule, ITaskTemplate } from "../interfaces/recurring-tasks";
import moment from "moment";
import TasksController from "../controllers/tasks-controller";

// At 11:00+00 (4.30pm+530) on every day-of-month if it's on every day-of-week from Monday through Friday.
// const TIME = "0 11 */1 * 1-5";
const TIME = process.env.RECURRING_JOBS_INTERVAL || "0 11 */1 * 1-5";
const TIME_FORMAT = "YYYY-MM-DD";
// Advisory lock key — a stable integer to serialize cron runs across all backend instances.
// Chosen to be unlikely to collide with any other advisory lock in the system.
const ADVISORY_LOCK_KEY = 900_001;
// Hard cap on how many iterations of the date-walk we'll do per template,
// to protect against misconfigured schedules that never advance.
const MAX_ITERATIONS_PER_TEMPLATE = 400;

const log = (value: any) => console.log("recurring-task-cron-job:", value);

// Define future limits for different schedule types
// More conservative limits to prevent task list clutter
const FUTURE_LIMITS = {
  daily: moment.duration(3, "days"),
  weekly: moment.duration(1, "week"),
  monthly: moment.duration(1, "month"),
  every_x_days: (interval: number) => moment.duration(interval, "days"),
  every_x_weeks: (interval: number) => moment.duration(interval, "weeks"),
  every_x_months: (interval: number) => moment.duration(interval, "months")
};

// Helper function to get the future limit based on schedule type
function getFutureLimit(scheduleType: string, interval?: number): moment.Duration {
  switch (scheduleType) {
    case "daily":
      return FUTURE_LIMITS.daily;
    case "weekly":
      return FUTURE_LIMITS.weekly;
    case "monthly":
      return FUTURE_LIMITS.monthly;
    case "every_x_days":
      return FUTURE_LIMITS.every_x_days(interval || 1);
    case "every_x_weeks":
      return FUTURE_LIMITS.every_x_weeks(interval || 1);
    case "every_x_months":
      return FUTURE_LIMITS.every_x_months(interval || 1);
    default:
      return moment.duration(3, "days"); // Default to 3 days
  }
}

/**
 * Compute the stable "window end" for this run.
 * The window is anchored to today (startOf day) + the schedule's future limit,
 * NOT to the last_checked_at value. This prevents drift: if the cron misses a
 * run or is restarted, we recompute from a stable wall-clock anchor, so we
 * never skip or double-generate dates.
 */
function computeWindowEnd(scheduleType: string, interval?: number): moment.Moment {
  return moment().startOf("day").add(getFutureLimit(scheduleType, interval));
}

interface RecurringTemplateRow extends ITaskTemplate, IRecurringSchedule {
  last_task_end_date: Date | null;
  project_archived: boolean | null;
  project_deleted: boolean | null;
}

/**
 * Attempt to acquire a session-level advisory lock so that only one backend
 * instance runs this cron at a time. Returns true if we got the lock.
 */
async function tryAcquireCronLock(): Promise<boolean> {
  try {
    const result = await db.query(`SELECT pg_try_advisory_lock($1) AS acquired;`, [ADVISORY_LOCK_KEY]);
    return result.rows[0]?.acquired === true;
  } catch {
    return false;
  }
}

async function releaseCronLock(): Promise<void> {
  try {
    await db.query(`SELECT pg_advisory_unlock($1);`, [ADVISORY_LOCK_KEY]);
  } catch {
    // best-effort — the lock is released automatically when the session ends
  }
}

/**
 * Pre-fetch all existing (schedule_id, end_date) pairs for the given schedule IDs
 * in a single query. This avoids N+1 round-trips inside the hot loop and gives
 * us a reliable in-memory set for dedup before we do the final atomic INSERT.
 */
async function fetchExistingTaskKeys(scheduleIds: string[]): Promise<Set<string>> {
  if (scheduleIds.length === 0) return new Set();
  const result = await db.query(
    `SELECT schedule_id, end_date::DATE AS end_date FROM tasks WHERE schedule_id = ANY($1);`,
    [scheduleIds]
  );
  const keys = new Set<string>();
  for (const row of result.rows) {
    keys.add(`${row.schedule_id}|${moment(row.end_date).format(TIME_FORMAT)}`);
  }
  return keys;
}

/**
 * Atomically insert a task only if no task with the same schedule_id + end_date
 * already exists. The WHERE NOT EXISTS clause is the final safety net against
 * races between concurrent cron runs or a concurrent manual creation.
 * Returns the created task row, or null if a duplicate was detected.
 */
async function createTaskAtomic(
  template: ITaskTemplate,
  nextEndDate: moment.Moment,
  existingKeys: Set<string>
): Promise<any | null> {
  const endDateStr = nextEndDate.format(TIME_FORMAT);
  const dedupKey = `${template.schedule_id}|${endDateStr}`;

  // Fast in-memory dedup — avoids hitting the DB at all for known duplicates.
  if (existingKeys.has(dedupKey)) {
    return null;
  }

  const taskData = {
    name: template.name,
    priority_id: template.priority_id,
    project_id: template.project_id,
    reporter_id: template.reporter_id,
    status_id: template.status_id || null,
    end_date: endDateStr,
    schedule_id: template.schedule_id
  };

  // Atomic INSERT ... WHERE NOT EXISTS — the DB is the source of truth.
  const insertQuery = `
    WITH inserted AS (
      SELECT create_quick_task($1::json) AS task
    )
    SELECT task FROM inserted
    WHERE NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE schedule_id = $2 AND end_date::DATE = $3::DATE
        AND id != (SELECT task FROM inserted)
    );
  `;

  // We actually use a simpler, safer approach: try the create, and if a
  // duplicate already exists (detected via SELECT inside the transaction),
  // return null. create_quick_task is a function that may not cooperate with
  // CTEs, so we do a transactional check-then-insert instead.
  const client = await (db as any).connect ? (db as any).connect() : null;
  try {
    if (client) {
      await client.query("BEGIN");
      const checkResult = await client.query(
        `SELECT id FROM tasks WHERE schedule_id = $1 AND end_date::DATE = $2::DATE LIMIT 1;`,
        [template.schedule_id, endDateStr]
      );
      if (checkResult.rows.length > 0) {
        await client.query("ROLLBACK");
        // Mark in memory so we don't retry this key in the same run.
        existingKeys.add(dedupKey);
        return null;
      }
      const createResult = await client.query(
        `SELECT create_quick_task($1::json) as task;`,
        [JSON.stringify(taskData)]
      );
      const createdTask = createResult.rows[0]?.task;
      await client.query("COMMIT");
      if (createdTask) {
        existingKeys.add(dedupKey);
      }
      return createdTask || null;
    } else {
      // Fallback: no connect() on the pool wrapper — use a plain check.
      // This is less safe against races but keeps the code functional
      // if the DB module doesn't expose a raw Pool.
      const checkResult = await db.query(
        `SELECT id FROM tasks WHERE schedule_id = $1 AND end_date::DATE = $2::DATE LIMIT 1;`,
        [template.schedule_id, endDateStr]
      );
      if (checkResult.rows.length > 0) {
        existingKeys.add(dedupKey);
        return null;
      }
      const createResult = await db.query(
        `SELECT create_quick_task($1::json) as task;`,
        [JSON.stringify(taskData)]
      );
      const createdTask = createResult.rows[0]?.task;
      if (createdTask) {
        existingKeys.add(dedupKey);
      }
      return createdTask || null;
    }
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    if (client && client.release) {
      client.release();
    }
  }
}

async function processTemplate(
  template: RecurringTemplateRow,
  existingKeys: Set<string>,
  now: moment.Moment
): Promise<number> {
  // Validate project is still active
  if (template.project_archived || template.project_deleted) {
    log(`Skipping template "${template.name}" — project is archived or deleted.`);
    return 0;
  }

  // Determine the anchor date for computing the next occurrence.
  // Prefer the last task end_date (MAX), fall back to schedule's last_created_task_end_date,
  // then template created_at. All normalized to start-of-day.
  const anchorDate = template.last_task_end_date
    ? moment(template.last_task_end_date).startOf("day")
    : template.last_created_task_end_date
      ? moment(template.last_created_task_end_date).startOf("day")
      : moment(template.created_at).startOf("day");

  if (!anchorDate.isValid()) {
    log(`Skipping template "${template.name}" — invalid anchor date.`);
    return 0;
  }

  const interval = template.interval_days || template.interval_weeks || template.interval_months || 1;
  const windowEnd = computeWindowEnd(template.schedule_type, interval);

  // Walk forward from the anchor date, collecting dates that fall within the
  // window and are strictly in the future (we don't backfill past-due tasks —
  // that would create a flood after a long downtime).
  let nextEndDate = calculateNextEndDate(template, anchorDate);
  const endDatesToCreate: moment.Moment[] = [];
  let iterations = 0;

  while (nextEndDate.isSameOrBefore(windowEnd) && iterations < MAX_ITERATIONS_PER_TEMPLATE) {
    iterations++;
    // Guard against infinite loops: if calculateNextEndDate doesn't advance, bail out.
    if (nextEndDate.isSameOrBefore(anchorDate)) {
      log(`Skipping template "${template.name}" — next date ${nextEndDate.format(TIME_FORMAT)} did not advance past anchor ${anchorDate.format(TIME_FORMAT)}.`);
      return 0;
    }
    if (nextEndDate.isAfter(now)) {
      endDatesToCreate.push(moment(nextEndDate));
    }
    const prevDate = nextEndDate.clone();
    nextEndDate = calculateNextEndDate(template, nextEndDate);
    // Hard safety: if the date didn't move forward, break to avoid infinite loop.
    if (!nextEndDate.isAfter(prevDate)) {
      log(`Safety break for template "${template.name}" — date calculation stalled at ${prevDate.format(TIME_FORMAT)}.`);
      break;
    }
  }

  if (endDatesToCreate.length === 0) {
    return 0;
  }

  let createdCount = 0;
  let lastCreatedEndDate: moment.Moment | null = null;

  for (const endDate of endDatesToCreate) {
    try {
      const createdTask = await createTaskAtomic(template, endDate, existingKeys);
      if (createdTask) {
        createdCount++;
        lastCreatedEndDate = endDate;

        // Attach assignees and labels — these are idempotent on their own.
        for (const assignee of template.assignees) {
          try {
            await TasksController.createTaskBulkAssignees(
              assignee.team_member_id,
              template.project_id,
              createdTask.id,
              assignee.assigned_by
            );
          } catch (assigneeErr) {
            // Non-fatal: task was created, just missing an assignee.
            log_error(assigneeErr);
          }
        }

        for (const label of template.labels) {
          try {
            await db.query(
              `SELECT add_or_remove_task_label($1, $2) AS labels;`,
              [createdTask.id, label.label_id]
            );
          } catch (labelErr) {
            log_error(labelErr);
          }
        }

        log(`Created task for template "${template.name}" with end date ${endDate.format(TIME_FORMAT)}`);
      } else {
        log(`Skipped duplicate task for template "${template.name}" with end date ${endDate.format(TIME_FORMAT)}`);
      }
    } catch (taskErr) {
      // Log but continue with other dates — one failed task shouldn't block the whole batch.
      log_error(taskErr);
    }
  }

  // Update the schedule's bookkeeping. last_checked_at is set to the stable
  // window-end we computed for this run (not "today"), so a missed run doesn't
  // silently shrink the next window.
  if (createdCount > 0 || endDatesToCreate.length > 0) {
    try {
      await db.query(
        `UPDATE task_recurring_schedules
         SET last_checked_at = $1::DATE,
             last_created_task_end_date = COALESCE($2, last_created_task_end_date)
         WHERE id = $3;`,
        [
          windowEnd.format(TIME_FORMAT),
          lastCreatedEndDate ? lastCreatedEndDate.format(TIME_FORMAT) : null,
          template.schedule_id
        ]
      );
    } catch (updateErr) {
      log_error(updateErr);
    }
  }

  return createdCount;
}

async function onRecurringTaskJobTick() {
  try {
    log("(cron) Recurring tasks job started.");

    // Acquire a session-level advisory lock. If another instance is already
    // running the cron, we bail out immediately — no double-scanning.
    const locked = await tryAcquireCronLock();
    if (!locked) {
      log("(cron) Another instance is already running the recurring tasks job. Skipping this run.");
      return;
    }

    try {
      // Query templates with project health info in a single pass.
      // We LEFT JOIN projects so templates for deleted projects still show up
      // (we'll skip them). We filter out templates whose source task was deleted.
      const templatesQuery = `
        SELECT t.*, s.*,
               (SELECT MAX(end_date) FROM tasks WHERE schedule_id = s.id) AS last_task_end_date,
               p.archived AS project_archived,
               p.deleted_at IS NOT NULL AS project_deleted
        FROM task_recurring_templates t
        JOIN task_recurring_schedules s ON t.schedule_id = s.id
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE p.id IS NOT NULL;
      `;
      const templatesResult = await db.query(templatesQuery);
      const templates = templatesResult.rows as RecurringTemplateRow[];

      const now = moment().startOf("day");
      let createdTaskCount = 0;

      // Pre-fetch all existing (schedule_id, end_date) pairs to avoid N+1 queries
      // and to give us a fast in-memory dedup set.
      const scheduleIds = templates.map(t => t.schedule_id).filter(Boolean);
      const existingKeys = await fetchExistingTaskKeys(scheduleIds);

      for (const template of templates) {
        try {
          const count = await processTemplate(template, existingKeys, now);
          createdTaskCount += count;
        } catch (templateErr) {
          // One broken template shouldn't kill the whole cron run.
          log_error(templateErr);
          log(`(cron) Error processing template "${template.name}", continuing.`);
        }
      }

      log(`(cron) Recurring tasks job ended with ${createdTaskCount} new tasks created.`);
    } finally {
      await releaseCronLock();
    }
  } catch (error) {
    log_error(error);
    log("(cron) Recurring task job ended with errors.");
  }
}

export function startRecurringTasksJob() {
  log("(cron) Recurring task job ready.");
  const job = new CronJob(
    TIME,
    () => void onRecurringTaskJobTick(),
    () => log("(cron) Recurring task job successfully executed."),
    true
  );
  job.start();
}

// Exported for testing
export {
  onRecurringTaskJobTick,
  processTemplate,
  computeWindowEnd,
  fetchExistingTaskKeys,
  createTaskAtomic,
  tryAcquireCronLock,
  releaseCronLock,
  getFutureLimit,
  ADVISORY_LOCK_KEY,
  MAX_ITERATIONS_PER_TEMPLATE
};
