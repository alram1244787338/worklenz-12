import slug from "slugify";
import moment from "moment";
import lodash from "lodash";
import sanitizeHtml from "sanitize-html";

import { customAlphabet } from "nanoid";
import { AvatarNamesMap, NumbersColorMap, WorklenzColorCodes } from "./constants";
import { send_to_slack } from "./slack";
import { IActivityLogChangeType } from "../services/activity-logs/interfaces";
import { IRecurringSchedule } from "../interfaces/recurring-tasks";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const error_codes = require("./postgresql-error-codes");

export function log_error(error: any, user: any | null = null, sendToSlack = true) {
  const msg = error_codes[error.code];
  if (msg) {
    console.log("\n==== BEGIN ERROR ====\n");
    console.trace(`ERROR [${error.code}]: ${msg}\n`);
  }

  console.log("\n");
  console.error(error);
  console.log("\n==== END ERROR ====\n");

  const err = user ? {
    user: user || null,
    error
  } : error;
  if (sendToSlack)
    send_to_slack(err);
}

/** Returns true if node env is production */
export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** Returns true if uat or dev */
export function isTestServer() {
  const hostname = process.env.HOSTNAME;
  return hostname === "dev.worklenz.com" || hostname === "uat.app.worklenz.com";
}

/** Returns true if localhost:3000 or localhost:4200 */
export function isLocalServer() {
  const frontendUrl = process.env.FRONTEND_URL;
  return frontendUrl === "localhost:5173" || frontendUrl === "localhost:4200" || frontendUrl === "localhost:3000" || frontendUrl === "127.0.0.1:3000";
}

/** Returns true of isLocal or isTest server */
export function isInternalServer() {
  return isLocalServer() || isTestServer();
}

/**
 * String value to a URL-friendly string
 * @param str {String}
 * @returns string
 */
export function slugify(str: string): string {
  return slug(str || "", {
    replacement: "-", // replace spaces with replacement
    remove: /[*+~.()'"!:@]/g, // regex to remove characters
    lower: true, // result in lower case
  });
}

export function smallId(len: number) {
  /**
   * Create nanoid instance with a specific alphabet
   * `Alphabet: 0123456789`
   * @returns e.g. 458652
   */
  return customAlphabet("0123456789", len)();
}

export function isValidateEmail(email: string) {
  const re =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
}

export function toTsQuery(value: string) {
  return `${value.replace(/\s/g, "+").replace(/\(|\)/g, "")}:*`;
}

function nextChar(c: string) {
  return String.fromCharCode(c.charCodeAt(0) + 1);
}

function numberToAlpha(num: number) {
  if (num < 1 || num > 26) {
    throw new Error("Number must be between 1 and 26.");
  }

  // Convert the number to an ASCII code by adding 64
  const asciiCode = num + 64;

  // Convert the ASCII code to the corresponding character
  return String.fromCharCode(asciiCode);
}

export function getColor(name?: string, next = false) {
  const char = name?.replace(/[^a-zA-Z0-9]/g, "").charAt(0).toUpperCase() || "A";

  const map = /\d/.test(char)
    ? NumbersColorMap
    : AvatarNamesMap;

  return map[next ? nextChar(char) || char : char];
}

export function toMinutes(hours?: number, minutes?: number) {
  return ~~((hours || 0) * 60) + (minutes || 0);
}

export function toSeconds(hours: number, minutes: number, seconds: number) {
  return (hours * 3600) + (minutes * 60) + seconds;
}

export function toMilliseconds(hours: number, minutes: number, seconds: number) {
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

export function toRound(value: string | number) {
  return /\d+/.test(value as string)
    ? Math.ceil(+value)
    : 0;
}

/** Convert bytes to human-readable format (e.g. 1000 bytes - 1 kb) */
export function humanFileSize(size: number) {
  const i = size == 0 ? 0 : ~~(Math.log(size) / Math.log(1024));
  return `${(+(size / Math.pow(1024, i)).toFixed(2))} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}

export function getRandomColorCode() {
  // Using bitwise is faster than Math.floor
  return WorklenzColorCodes[~~(Math.random() * WorklenzColorCodes.length)];
}

export function sanitize(value: string) {
  if (!value) return "";

  const escapedString = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

  return sanitizeHtml(escapedString);
}

export function escape(value: string) {
  return lodash.escape(sanitizeHtml(value));
}

export function unescape(value: string) {
  return lodash.unescape(value);
}

export function isUnicode(value: string) {
  for (let i = 0, n = value.length; i < n; i++) {
    if (value.charCodeAt(i) > 255) return true;
  }
  return false;
}

export function formatDuration(duration: moment.Duration) {
  const empty = "0h 0m";
  let format = "";

  if (duration.asMilliseconds() === 0) return empty;

  const h = ~~(duration.asHours());
  const m = duration.minutes();
  const s = duration.seconds();

  if (h === 0 && s > 0) {
    format = `${m}m ${s}s`;
  } else if (h > 0 && s === 0) {
    format = `${h}h ${m}m`;
  } else if (h > 0 && s > 0) {
    format = `${h}h ${m}m ${s}s`;
  } else {
    format = `${h}h ${m}m`;
  }

  return format;
}

export function calculateMonthDays(startDate: string, endDate: string): string {
  const start: Date = new Date(startDate);
  const end: Date = new Date(endDate);

  const diffInMilliseconds: number = Math.abs(end.getTime() - start.getTime());
  const days: number = Math.floor(diffInMilliseconds / (1000 * 60 * 60 * 24));
  const months: number = Math.floor(days / 30);
  const remainingDays: number = days % 30;


  return `${months} ${months > 1 ? "months" : "month"} ${remainingDays} ${remainingDays !== 1 ? "days" : "day"}`;
}

export function int<T>(value: T) {
  return isNaN(+value) ? 0 : +value;
}

export function formatLogText(log: { log_type: IActivityLogChangeType; }) {
  if (log.log_type === IActivityLogChangeType.ASSIGN) return "added an ";
  if (log.log_type === IActivityLogChangeType.UNASSIGN) return "removed an ";
  if (log.log_type === IActivityLogChangeType.UPDATE) return "updated the ";
  if (log.log_type === IActivityLogChangeType.CREATE) return "added a ";
  if (log.log_type === IActivityLogChangeType.DELETE) return "removed a ";
  return log.log_type;
}

/**
 * Find the Nth occurrence of a given weekday in a specific month.
 * e.g. the 2nd Tuesday (day_of_month=2, week_of_month=2) of March 2024.
 * If the Nth occurrence doesn't exist (e.g. 5th Monday in a month with only 4),
 * returns the last valid occurrence.
 */
export function getNthWeekdayOfMonth(year: number, month: number, dayOfWeek: number, n: number): moment.Moment {
  // Start from the 1st of the target month
  const first = moment({ year, month, date: 1 });
  // Find the first occurrence of the target weekday in this month
  const firstDayOfMonth = first.day(); // 0=Sun..6=Sat
  let diff = dayOfWeek - firstDayOfMonth;
  if (diff < 0) diff += 7;
  const firstOccurrence = first.clone().add(diff, "days");

  // Advance by (n - 1) weeks
  const target = firstOccurrence.clone().add(n - 1, "weeks");

  // If we overflowed into the next month, fall back to the last valid occurrence
  if (target.month() !== month) {
    return firstOccurrence.clone().add(n - 2, "weeks");
  }
  return target;
}

/**
 * Clamp a date to the last day of the target month if the requested day
 * exceeds the number of days in that month.
 * e.g. date_of_month=31 in February → Feb 28 (or 29 in leap year)
 */
function clampDateToMonth(base: moment.Moment, targetDay: number): moment.Moment {
  const daysInMonth = base.daysInMonth();
  const clampedDay = Math.min(targetDay, daysInMonth);
  return base.clone().date(clampedDay);
}

// Calculate the next start date based on the recurring schedule.
// Always operates on date-only (startOf day) to prevent time drift across runs.
export function calculateNextEndDate(schedule: IRecurringSchedule, lastDate: moment.Moment): moment.Moment {
  // Normalize to start-of-day to prevent time-of-day drift
  const normalized = moment(lastDate).startOf("day");

  switch (schedule.schedule_type) {
    case "daily":
      return normalized.add(1, "day").startOf("day");

    case "weekly":
      if (schedule.days_of_week && schedule.days_of_week.length > 0) {
        // Sort target days ascending so we always find the *next* one
        const sortedDays = [...schedule.days_of_week].sort((a, b) => a - b);
        const currentDay = normalized.day();
        // Find the next day-of-week strictly after today
        let nextDay = sortedDays.find(d => d > currentDay);
        if (nextDay === undefined) {
          // Wrap to the first target day in the following week
          nextDay = sortedDays[0];
          const daysUntilNextWeek = 7 - currentDay + nextDay;
          return normalized.add(daysUntilNextWeek, "days").startOf("day");
        }
        return normalized.add(nextDay - currentDay, "days").startOf("day");
      } else {
        return normalized.add(1, "week").startOf("day");
      }

    case "monthly": {
      if (schedule.date_of_month) {
        // Advance to the 1st of the next month, then clamp the requested day
        const nextMonthFirst = normalized.clone().add(1, "month").startOf("month");
        return clampDateToMonth(nextMonthFirst, schedule.date_of_month).startOf("day");
      } else if (schedule.day_of_month != null && schedule.week_of_month != null) {
        // Nth weekday of the next month (e.g. "2nd Tuesday")
        const nextMonth = normalized.clone().add(1, "month");
        const result = getNthWeekdayOfMonth(
          nextMonth.year(),
          nextMonth.month(),
          schedule.day_of_month,
          schedule.week_of_month
        );
        return result.startOf("day");
      } else {
        // Plain "same day next month" — clamp if the day doesn't exist
        const dayOfMonth = normalized.date();
        const nextMonthFirst = normalized.clone().add(1, "month").startOf("month");
        return clampDateToMonth(nextMonthFirst, dayOfMonth).startOf("day");
      }
    }

    case "yearly":
      return normalized.add(1, "year").startOf("day");

    case "every_x_days":
      return normalized.add(schedule.interval_days || 1, "days").startOf("day");

    case "every_x_weeks":
      return normalized.add(schedule.interval_weeks || 1, "weeks").startOf("day");

    case "every_x_months": {
      // Same clamping logic as monthly to handle e.g. Jan 31 + 2 months → March 28/31
      const dayOfMonth = normalized.date();
      const targetMonthFirst = normalized.clone().add(schedule.interval_months || 1, "months").startOf("month");
      return clampDateToMonth(targetMonthFirst, dayOfMonth).startOf("day");
    }

    default:
      throw new Error(`Invalid schedule type: ${schedule.schedule_type}`);
  }
}


export function calculateNextEndDates(schedule: IRecurringSchedule, lastEndDate: moment.Moment, count: number): moment.Moment[] {
  const endDates: moment.Moment[] = [];
  let currentDate = moment(lastEndDate).startOf("day");

  for (let i = 0; i < count; i++) {
    currentDate = calculateNextEndDate(schedule, currentDate);
    endDates.push(moment(currentDate));
  }

  return endDates;
}

export function megabytesToBytes(megabytes: number): number {
  return megabytes * 1024 * 1024; // 1 MB = 1024 KB = 1024 * 1024 bytes
}

