import db from "../config/db";
import moment from "moment";
import {log_error} from "../shared/utils";

// ─── Unified time window ─────────────────────────────────────────────────────
// All three jobs (daily digest, project digest, notifications) must share the
// same time window so that statistics and reminders line up.

export interface ITimeWindow {
  now: Date;
  todayStr: string;       // "YYYY-MM-DD" in server-local time
  tomorrowStr: string;
  todayStart: Date;
  todayEnd: Date;
  tomorrowStart: Date;
  tomorrowEnd: Date;
}

export function getTimeWindow(referenceDate?: Date): ITimeWindow {
  const now = referenceDate ? moment(referenceDate) : moment();
  return {
    now: now.toDate(),
    todayStr: now.format("YYYY-MM-DD"),
    tomorrowStr: now.clone().add(1, "day").format("YYYY-MM-DD"),
    todayStart: now.clone().startOf("day").toDate(),
    todayEnd: now.clone().endOf("day").toDate(),
    tomorrowStart: now.clone().add(1, "day").startOf("day").toDate(),
    tomorrowEnd: now.clone().add(1, "day").endOf("day").toDate(),
  };
}

// ─── Digest idempotency ──────────────────────────────────────────────────────
// Uses the digest_logs table to prevent duplicate sends within the same
// calendar day for a given (user, digest_type) pair.

export type DigestType = "daily_digest" | "project_digest" | "task_update_notification";

export async function wasDigestSentToday(
  userId: string,
  digestType: DigestType,
  todayStr: string
): Promise<boolean> {
  try {
    const q = `
      SELECT 1 FROM digest_logs
      WHERE user_id = $1::uuid
        AND digest_type = $2
        AND sent_at::date = $3::date
      LIMIT 1;
    `;
    const result = await db.query(q, [userId, digestType, todayStr]);
    return result.rows.length > 0;
  } catch (error) {
    // Table may not exist yet (pre-migration); allow send
    log_error(error);
    return false;
  }
}

export async function markDigestSent(
  userId: string,
  digestType: DigestType,
  email: string
): Promise<void> {
  try {
    const q = `
      INSERT INTO digest_logs (user_id, digest_type, email, sent_at)
      VALUES ($1::uuid, $2, $3, NOW())
      ON CONFLICT (user_id, digest_type, sent_at_date) DO NOTHING;
    `;
    await db.query(q, [userId, digestType, email]);
  } catch (error) {
    log_error(error);
  }
}

// ─── Per-user task_update marking ────────────────────────────────────────────
// Replaces the old global UPDATE that caused race conditions. Each user's
// batch of task_updates is now marked independently so a failure for user A
// does not corrupt user B's records.

export async function markTaskUpdatesSentForUser(
  userId: string,
  taskUpdateIds: string[]
): Promise<boolean> {
  if (!taskUpdateIds.length) return true;
  try {
    const q = `
      UPDATE task_updates SET is_sent = TRUE
      WHERE id = ANY($1::uuid[]) AND user_id = $2::uuid;
    `;
    await db.query(q, [taskUpdateIds, userId]);
    return true;
  } catch (error) {
    log_error(error);
    return false;
  }
}

export async function revertTaskUpdatesForUser(
  userId: string,
  taskUpdateIds: string[]
): Promise<void> {
  if (!taskUpdateIds.length) return;
  try {
    const q = `
      UPDATE task_updates SET is_sent = FALSE
      WHERE id = ANY($1::uuid[]) AND user_id = $2::uuid;
    `;
    await db.query(q, [taskUpdateIds, userId]);
  } catch (error) {
    log_error(error);
  }
}

// ─── Housekeeping ────────────────────────────────────────────────────────────

export async function cleanupOldDigestLogs(retentionDays = 90): Promise<void> {
  try {
    const q = `DELETE FROM digest_logs WHERE sent_at < NOW() - $1 * INTERVAL '1 day';`;
    await db.query(q, [retentionDays]);
  } catch (error) {
    log_error(error);
  }
}
