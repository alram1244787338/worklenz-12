import {CronJob} from "cron";
import db from "../config/db";
import {log_error} from "../shared/utils";
import {getBaseUrl} from "./helpers";
import {IProjectDigest, IProjectDigestTask, IProjectDigestSubscriber} from "../interfaces/project-digest";
import {sendProjectDailyDigest} from "../shared/email-notifications";
import {getTimeWindow, wasDigestSentToday, markDigestSent, cleanupOldDigestLogs} from "./digest-utils";

// At 11:00+00 (4.30pm+530) on every day-of-month if it's on every day-of-week from Monday through Friday.
const TIME = "0 11 */1 * 1-5";

const log = (value: any) => console.log("project-digest-cron-job:", value);

/**
 * Build task URLs without mutating the original array.
 * Returns a new array of tasks with urls set.
 */
function withTaskUrls(projectId: string, tasks: IProjectDigestTask[]): IProjectDigestTask[] {
  const baseUrl = getBaseUrl();
  return (tasks || []).map(task => ({
    ...task,
    url: `${baseUrl}/worklenz/projects/${projectId}?tab=tasks-list&task=${task.id}`
  }));
}

/**
 * Build a per-subscriber copy of the project digest so that metadata set for
 * subscriber A never leaks into subscriber B's email.
 */
function buildSubscriberDigest(
  project: IProjectDigest,
  subscriber: IProjectDigestSubscriber
): IProjectDigest {
  const baseUrl = getBaseUrl();
  return {
    ...project,
    greeting: `Hi ${subscriber.name},`,
    summary: `Here's the "${project.name}" summary | ${project.team_name}`,
    settings_url: `${baseUrl}/worklenz/settings/notifications`,
    project_url: `${baseUrl}/worklenz/projects/${project.id}?tab=tasks-list`,
    today_completed: withTaskUrls(project.id, project.today_completed),
    today_new: withTaskUrls(project.id, project.today_new),
    due_tomorrow: withTaskUrls(project.id, project.due_tomorrow),
    // shallow copy subscribers so we don't mutate the original
    subscribers: project.subscribers,
  };
}

function hasContent(project: IProjectDigest): boolean {
  return (project.today_completed?.length > 0) ||
         (project.today_new?.length > 0) ||
         (project.due_tomorrow?.length > 0);
}

async function onProjectDigestJobTick() {
  try {
    log("(cron) Project digest job started.");
    const timeWindow = getTimeWindow();

    const q = "SELECT get_project_daily_digest() AS digest;";
    const result = await db.query(q, []);
    const [fn] = result.rows;

    const dataset: IProjectDigest[] = fn.digest || [];

    let sentCount = 0;
    let skippedIdempotent = 0;
    let errors = 0;

    for (const project of dataset) {
      if (!hasContent(project)) continue;

      for (const subscriber of (project.subscribers || [])) {
        // ── Validate subscriber ────────────────────────────────────────
        if (!subscriber.email || !subscriber.user_id) {
          log(`(cron) Skipping subscriber with missing email/user_id in project ${project.name}`);
          continue;
        }

        // ── Idempotency: one project-digest per user per day ──────────
        const idempotencyKey = `project_digest_${project.id}`;
        const alreadySent = await wasDigestSentToday(
          subscriber.user_id, idempotencyKey, timeWindow.todayStr
        );
        if (alreadySent) {
          skippedIdempotent++;
          continue;
        }

        // ── Build an immutable per-subscriber digest ──────────────────
        const subscriberDigest = buildSubscriberDigest(project, subscriber);

        try {
          await sendProjectDailyDigest(subscriber.email, subscriberDigest);
          await markDigestSent(subscriber.user_id, idempotencyKey, subscriber.email);
          sentCount++;
        } catch (err) {
          errors++;
          log_error(err);
          log(`(cron) Failed to send project digest to ${subscriber.email} for project ${project.name}`);
        }
      }
    }

    void cleanupOldDigestLogs();

    log(`(cron) Project digest job ended: ${sentCount} sent, ${skippedIdempotent} skipped (idempotent), ${errors} errors.`);
  } catch (error) {
    log_error(error);
    log("(cron) Project digest job ended with errors.");
  }
}

export function startProjectDigestJob() {
  log("(cron) Project digest job ready.");
  const job = new CronJob(
    TIME,
    () => void onProjectDigestJobTick(),
    () => log("(cron) Project Digest job successfully executed."),
    true
  );
  job.start();
}

// Exported for testing
export {onProjectDigestJobTick, buildSubscriberDigest, hasContent};
