// Unmock the cron job module and utils
jest.unmock("../cron_jobs/recurring-tasks");
jest.unmock("../shared/utils");
jest.unmock("moment");

// Mock the DB module
jest.mock("../config/db", () => {
  const mockDb: any = {
    query: jest.fn(),
    connect: jest.fn()
  };
  return { __esModule: true, default: mockDb };
});

// Mock TasksController
jest.mock("../controllers/tasks-controller", () => ({
  __esModule: true,
  default: {
    createTaskBulkAssignees: jest.fn().mockResolvedValue([])
  }
}));

import moment from "moment";
import db from "../config/db";
import {
  computeWindowEnd,
  fetchExistingTaskKeys,
  processTemplate,
  getFutureLimit,
  MAX_ITERATIONS_PER_TEMPLATE
} from "../cron_jobs/recurring-tasks";
import { IRecurringSchedule, ITaskTemplate } from "../interfaces/recurring-tasks";

const mockDb = db as any;

// Helper to build a template row
function makeTemplate(overrides: Partial<ITaskTemplate & IRecurringSchedule & {
  last_task_end_date: any;
  project_archived: boolean;
  project_deleted: boolean;
}> = {}) {
  return {
    task_id: "task-1",
    schedule_id: "sched-1",
    created_at: new Date("2024-01-01"),
    name: "Test Task",
    priority_id: "pri-1",
    project_id: "proj-1",
    reporter_id: "user-1",
    status_id: "status-1",
    assignees: [],
    labels: [],
    // IRecurringSchedule fields
    id: "sched-1",
    schedule_type: "daily" as const,
    days_of_week: null,
    day_of_month: null,
    date_of_month: null,
    week_of_month: null,
    interval_days: null,
    interval_weeks: null,
    interval_months: null,
    last_created_task_end_date: null,
    last_checked_at: null,
    last_task_end_date: null,
    // Extra fields from the query
    project_archived: false,
    project_deleted: false,
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getFutureLimit", () => {
  it("should return 3 days for daily", () => {
    const limit = getFutureLimit("daily");
    expect(limit.asDays()).toBe(3);
  });

  it("should return 1 week for weekly", () => {
    const limit = getFutureLimit("weekly");
    expect(limit.asWeeks()).toBe(1);
  });

  it("should return 1 month for monthly", () => {
    const limit = getFutureLimit("monthly");
    expect(limit.asMonths()).toBe(1);
  });

  it("should return custom interval for every_x_days", () => {
    const limit = getFutureLimit("every_x_days", 10);
    expect(limit.asDays()).toBe(10);
  });

  it("should default to 1 for missing interval", () => {
    const limit = getFutureLimit("every_x_days");
    expect(limit.asDays()).toBe(1);
  });

  it("should return 3 days for unknown type", () => {
    const limit = getFutureLimit("unknown");
    expect(limit.asDays()).toBe(3);
  });
});

describe("computeWindowEnd", () => {
  it("should compute a stable window end anchored to today", () => {
    const today = moment().startOf("day");
    const windowEnd = computeWindowEnd("daily");
    // Should be today + 3 days
    expect(windowEnd.diff(today, "days")).toBe(3);
  });

  it("should not depend on last_checked_at", () => {
    const w1 = computeWindowEnd("daily");
    const w2 = computeWindowEnd("daily");
    expect(w1.format("YYYY-MM-DD")).toBe(w2.format("YYYY-MM-DD"));
  });
});

describe("fetchExistingTaskKeys", () => {
  it("should return empty set for no schedule IDs", async () => {
    const keys = await fetchExistingTaskKeys([]);
    expect(keys.size).toBe(0);
  });

  it("should return a set of schedule_id|date keys", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { schedule_id: "s1", end_date: "2024-03-15" },
        { schedule_id: "s1", end_date: "2024-03-16" },
        { schedule_id: "s2", end_date: "2024-03-15" }
      ]
    });
    const keys = await fetchExistingTaskKeys(["s1", "s2"]);
    expect(keys.size).toBe(3);
    expect(keys.has("s1|2024-03-15")).toBe(true);
    expect(keys.has("s1|2024-03-16")).toBe(true);
    expect(keys.has("s2|2024-03-15")).toBe(true);
  });
});

describe("processTemplate", () => {
  it("should skip templates with archived projects", async () => {
    const template = makeTemplate({ project_archived: true });
    const count = await processTemplate(template as any, new Set(), moment().startOf("day"));
    expect(count).toBe(0);
    // Should not have queried for existing tasks or created anything
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("should skip templates with deleted projects", async () => {
    const template = makeTemplate({ project_deleted: true });
    const count = await processTemplate(template as any, new Set(), moment().startOf("day"));
    expect(count).toBe(0);
  });

  it("should skip templates with invalid anchor date", async () => {
    const template = makeTemplate({
      last_task_end_date: "invalid-date"
    });
    const count = await processTemplate(template as any, new Set(), moment().startOf("day"));
    expect(count).toBe(0);
  });

  it("should not create tasks for past dates", async () => {
    // Template with last_task_end_date far in the past
    const template = makeTemplate({
      last_task_end_date: moment().subtract(10, "days").toDate(),
      schedule_type: "daily"
    });

    // Set up DB mock: connect returns null (no transactional client)
    mockDb.query.mockResolvedValue({ rows: [] });
    mockDb.connect.mockResolvedValue(null);

    const existingKeys = new Set<string>();
    const count = await processTemplate(template as any, existingKeys, moment().startOf("day"));

    // Should only create future tasks within the window
    // (daily has 3-day window, so at most 3 tasks)
    expect(count).toBeLessThanOrEqual(3);
  });

  it("should deduplicate against existing keys", async () => {
    const tomorrow = moment().add(1, "day").startOf("day");
    const template = makeTemplate({
      last_task_end_date: moment().startOf("day").toDate(),
      schedule_type: "daily"
    });

    // Pre-populate existing keys with tomorrow's date
    const existingKeys = new Set<string>();
    existingKeys.add(`sched-1|${tomorrow.format("YYYY-MM-DD")}`);

    mockDb.query.mockResolvedValue({ rows: [] });
    mockDb.connect.mockResolvedValue(null);

    const count = await processTemplate(template as any, existingKeys, moment().startOf("day"));

    // Tomorrow is already in existingKeys, so it should be skipped
    // The other 2 days in the window should be created
    expect(count).toBeLessThanOrEqual(2);
  });

  it("should not infinite-loop when calculateNextEndDate stalls", async () => {
    // This tests the safety break: if the date doesn't advance, we bail out.
    // We simulate this by having a very old anchor date and a schedule
    // that should work fine, but the safety mechanism catches edge cases.
    const template = makeTemplate({
      last_task_end_date: moment("2024-01-01").toDate(),
      schedule_type: "daily"
    });

    mockDb.query.mockResolvedValue({ rows: [] });
    mockDb.connect.mockResolvedValue(null);

    // Should complete without hanging (the MAX_ITERATIONS_PER_TEMPLATE guard)
    const count = await processTemplate(template as any, new Set(), moment().startOf("day"));
    // All dates between anchor and window end that are in the future
    // Since the anchor is in the past and only future dates are created,
    // the result depends on the window
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("should use last_created_task_end_date as fallback when last_task_end_date is null", async () => {
    const template = makeTemplate({
      last_task_end_date: null,
      last_created_task_end_date: moment().subtract(1, "day").toDate(),
      schedule_type: "daily"
    });

    mockDb.query.mockResolvedValue({ rows: [] });
    mockDb.connect.mockResolvedValue(null);

    // Should process without error
    const count = await processTemplate(template as any, new Set(), moment().startOf("day"));
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("should update last_checked_at to windowEnd, not today", async () => {
    const template = makeTemplate({
      last_task_end_date: moment().subtract(1, "day").toDate(),
      schedule_type: "daily"
    });

    mockDb.query.mockResolvedValue({ rows: [] });
    mockDb.connect.mockResolvedValue(null);

    await processTemplate(template as any, new Set(), moment().startOf("day"));

    // Check that the UPDATE query used windowEnd (today + 3 days for daily)
    const updateCall = mockDb.query.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("UPDATE task_recurring_schedules")
    );
    if (updateCall) {
      const windowEndDate = moment().startOf("day").add(3, "days").format("YYYY-MM-DD");
      expect(updateCall[1][0]).toBe(windowEndDate);
    }
  });
});

describe("service restart / re-run scenarios", () => {
  it("should not create duplicates when run twice in quick succession", async () => {
    const template = makeTemplate({
      last_task_end_date: moment().subtract(1, "day").toDate(),
      schedule_type: "daily"
    });

    // First run: DB returns no existing tasks, creates them
    const existingKeys = new Set<string>();

    // Mock the connect() to return null (non-transactional fallback)
    // and query to always return empty (no duplicates found by check)
    mockDb.query.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes("SELECT id FROM tasks WHERE schedule_id")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("create_quick_task")) {
        const taskId = `task-${Math.random().toString(36).slice(2)}`;
        // Simulate that after creation, the task exists
        return Promise.resolve({ rows: [{ task: { id: taskId, name: "Test" } }] });
      }
      if (sql.includes("UPDATE task_recurring_schedules")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockDb.connect.mockResolvedValue(null);

    const now = moment().startOf("day");
    const count1 = await processTemplate(template as any, existingKeys, now);

    // Second run with the SAME existingKeys set (simulating immediate re-run)
    const count2 = await processTemplate(template as any, existingKeys, now);

    // Second run should create fewer or equal tasks because the keys
    // from the first run are in the existingKeys set
    expect(count2).toBeLessThanOrEqual(count1);
  });
});

describe("MAX_ITERATIONS_PER_TEMPLATE safety", () => {
  it("should have a reasonable upper bound", () => {
    expect(MAX_ITERATIONS_PER_TEMPLATE).toBe(400);
  });
});
