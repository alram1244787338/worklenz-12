import {CronJob} from "cron";
import db from "../config/db";
import {IDailyDigest} from "../interfaces/daily-digest";
import {sendDailyDigest} from "../shared/email-notifications";
import {log_error} from "../shared/utils";
import {getBaseUrl, mapTeams} from "./helpers";
import {getTimeWindow, wasDigestSentToday, markDigestSent, cleanupOldDigestLogs} from "./digest-utils";

// At 11:00+00 (4.30pm+530) on every day-of-month if it's on every day-of-week from Monday through Friday.
const TIME = "0 11 */1 * 1-5";

const log = (value: any) => console.log("daily-digest-cron-job:", value);

async function onDailyDigestJobTick() {
  try {
    log("(cron) Daily digest job started.");
    const timeWindow = getTimeWindow();

    const q = "SELECT get_daily_digest() AS digest;";
    const result = await db.query(q, []);
    const [fn] = result.rows;

    const dataset: IDailyDigest[] = fn.digest || [];

    let sentCount = 0;
    let skippedIdempotent = 0;
    let errors = 0;

    for (const digest of dataset) {
      // ── Skip users without a valid email ──────────────────────────────
      if (!digest.email) continue;

      // ── Skip users without a user_id (pre-migration safety) ───────────
      if (!digest.user_id) {
        log(`(cron) Skipping digest for ${digest.email}: missing user_id`);
        continue;
      }

      // ── Idempotency: skip if already sent today ──────────────────────
      const alreadySent = await wasDigestSentToday(
        digest.user_id, "daily_digest", timeWindow.todayStr
      );
      if (alreadySent) {
        skippedIdempotent++;
        continue;
      }

      digest.greeting = `Hi ${digest.name},`;
      digest.note = `Here's your ${timeWindow.now.toLocaleDateString("en-US", {weekday: "long"})} update!`;
      digest.base_url = `${getBaseUrl()}/worklenz`;
      digest.settings_url = `${getBaseUrl()}/worklenz/settings/notifications`;

      digest.recently_assigned = mapTeams(digest.recently_assigned);
      digest.overdue = mapTeams(digest.overdue);
      digest.recently_completed = mapTeams(digest.recently_completed);

      if (digest.recently_assigned?.length || digest.overdue?.length || digest.recently_completed?.length) {
        try {
          await sendDailyDigest(digest.email, digest);
          await markDigestSent(digest.user_id, "daily_digest", digest.email);
          sentCount++;
        } catch (err) {
          errors++;
          log_error(err);
          log(`(cron) Failed to send daily digest to ${digest.email}`);
        }
      }
    }

    // Clean up old logs (best-effort, non-blocking)
    void cleanupOldDigestLogs();

    log(`(cron) Daily digest job ended: ${sentCount} sent, ${skippedIdempotent} skipped (idempotent), ${errors} errors.`);
  } catch (error) {
    log_error(error);
    log("(cron) Daily digest job ended with errors.");
  }
}

export function startDailyDigestJob() {
  log("(cron) Daily digest job ready.");
  const job = new CronJob(
    TIME,
    () => void onDailyDigestJobTick(),
    () => log("(cron) Daily Digest job successfully executed."),
    true
  );
  job.start();
}

// Exported for testing
export {onDailyDigestJobTick};
