// Unmock the modules we need to test with real implementations
jest.unmock("../shared/utils");
jest.unmock("moment");

import moment from "moment";
import { calculateNextEndDate, calculateNextEndDates, getNthWeekdayOfMonth } from "../shared/utils";
import { IRecurringSchedule } from "../interfaces/recurring-tasks";

// Helper to build a partial schedule with defaults
function schedule(overrides: Partial<IRecurringSchedule>): IRecurringSchedule {
  return {
    id: "test-schedule",
    schedule_type: "daily",
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
    created_at: new Date("2024-01-01"),
    ...overrides
  };
}

describe("getNthWeekdayOfMonth", () => {
  it("should find the 1st Monday of January 2024 (Jan 1 is Monday)", () => {
    const result = getNthWeekdayOfMonth(2024, 0, 1, 1); // month=0 is January, day=1 is Monday
    expect(result.format("YYYY-MM-DD")).toBe("2024-01-01");
  });

  it("should find the 2nd Tuesday of January 2024", () => {
    const result = getNthWeekdayOfMonth(2024, 0, 2, 2); // 2nd Tuesday
    expect(result.format("YYYY-MM-DD")).toBe("2024-01-09");
  });

  it("should find the 4th Friday of March 2024", () => {
    const result = getNthWeekdayOfMonth(2024, 2, 5, 4); // 4th Friday (day=5)
    expect(result.format("YYYY-MM-DD")).toBe("2024-03-22");
  });

  it("should fall back to last occurrence when 5th exceeds month (5th Monday of Feb 2024)", () => {
    // Feb 2024 has only 4 Mondays (5, 12, 19, 26)
    const result = getNthWeekdayOfMonth(2024, 1, 1, 5);
    expect(result.format("YYYY-MM-DD")).toBe("2024-02-26");
  });

  it("should find the 3rd Wednesday of June 2024", () => {
    const result = getNthWeekdayOfMonth(2024, 5, 3, 3); // 3rd Wednesday (day=3)
    expect(result.format("YYYY-MM-DD")).toBe("2024-06-19");
  });

  it("should find the 1st Sunday of September 2024 (Sep 1 is Sunday)", () => {
    const result = getNthWeekdayOfMonth(2024, 8, 0, 1);
    expect(result.format("YYYY-MM-DD")).toBe("2024-09-01");
  });
});

describe("calculateNextEndDate", () => {
  describe("daily schedule", () => {
    it("should advance by 1 day", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2024-03-15"));
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-16");
    });

    it("should cross month boundary", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2024-01-31"));
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-01");
    });

    it("should cross year boundary", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2024-12-31"));
      expect(result.format("YYYY-MM-DD")).toBe("2025-01-01");
    });

    it("should handle leap year Feb 28 -> Feb 29", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2024-02-28"));
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-29");
    });

    it("should handle leap year Feb 29 -> Mar 1", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2024-02-29"));
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-01");
    });

    it("should handle non-leap year Feb 28 -> Mar 1", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2023-02-28"));
      expect(result.format("YYYY-MM-DD")).toBe("2023-03-01");
    });

    it("should strip time components to prevent drift", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), moment("2024-03-15T23:59:59"));
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-16");
      expect(result.format("HH:mm:ss")).toBe("00:00:00");
    });
  });

  describe("weekly schedule", () => {
    it("should advance by 1 week when no days_of_week specified", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "weekly" }), moment("2024-03-15"));
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-22");
    });

    it("should find the next Monday when days_of_week=[1] and today is Friday", () => {
      // March 15, 2024 is a Friday
      const result = calculateNextEndDate(
        schedule({ schedule_type: "weekly", days_of_week: [1] }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-18"); // Next Monday
    });

    it("should find the next Wednesday when days_of_week=[3] and today is Monday", () => {
      // March 11, 2024 is a Monday
      const result = calculateNextEndDate(
        schedule({ schedule_type: "weekly", days_of_week: [3] }),
        moment("2024-03-11")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-13"); // This Wednesday
    });

    it("should wrap to next week when target day is before current day", () => {
      // March 15, 2024 is a Friday. Target is Tuesday (2).
      // Since Tuesday < Friday, it should go to next Tuesday.
      const result = calculateNextEndDate(
        schedule({ schedule_type: "weekly", days_of_week: [2] }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-19"); // Next Tuesday
    });

    it("should pick the closest target day from multiple options", () => {
      // March 11, 2024 is Monday. Target days are Tue(2) and Thu(4).
      // Closest is Tuesday.
      const result = calculateNextEndDate(
        schedule({ schedule_type: "weekly", days_of_week: [2, 4] }),
        moment("2024-03-11")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-12"); // Tuesday
    });

    it("should handle multiple workdays (Mon-Fri) and skip weekends", () => {
      // March 15, 2024 is Friday. Target days: Mon(1), Tue(2), Wed(3), Thu(4), Fri(5).
      // Next workday after Friday is Monday.
      const result = calculateNextEndDate(
        schedule({ schedule_type: "weekly", days_of_week: [1, 2, 3, 4, 5] }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-18"); // Next Monday
    });

    it("should go to the same day next week if today matches the target", () => {
      // March 11, 2024 is Monday. Target day is Monday.
      // "next Monday" = March 18
      const result = calculateNextEndDate(
        schedule({ schedule_type: "weekly", days_of_week: [1] }),
        moment("2024-03-11")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-18");
    });
  });

  describe("monthly schedule", () => {
    it("should advance by 1 month with date_of_month=15", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", date_of_month: 15 }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-15");
    });

    it("should clamp date_of_month=31 to April 30", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", date_of_month: 31 }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-30");
    });

    it("should clamp date_of_month=31 to Feb 29 in leap year", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", date_of_month: 31 }),
        moment("2024-01-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-29");
    });

    it("should clamp date_of_month=31 to Feb 28 in non-leap year", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", date_of_month: 31 }),
        moment("2023-01-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2023-02-28");
    });

    it("should clamp date_of_month=30 to Feb 29 in leap year", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", date_of_month: 30 }),
        moment("2024-01-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-29");
    });

    it("should not drift when called repeatedly with date_of_month=31", () => {
      // Simulate repeated calls: Jan 31 → Feb 29 → Mar 31 → Apr 30 → ...
      let current = moment("2024-01-31");
      const dates: string[] = [current.format("YYYY-MM-DD")];
      for (let i = 0; i < 12; i++) {
        current = calculateNextEndDate(
          schedule({ schedule_type: "monthly", date_of_month: 31 }),
          current
        );
        dates.push(current.format("YYYY-MM-DD"));
      }
      // Every date should be the last day of its month (clamped from 31)
      const expected = [
        "2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30",
        "2024-05-31", "2024-06-30", "2024-07-31", "2024-08-31",
        "2024-09-30", "2024-10-31", "2024-11-30", "2024-12-31",
        "2025-01-31"
      ];
      expect(dates).toEqual(expected);
    });

    it("should handle plain monthly (no date_of_month, no day_of_month) with day clamping", () => {
      // From Jan 31, plain monthly should go to Feb 29 (leap year), not March 2
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly" }),
        moment("2024-01-31")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-29");
    });

    it("should handle plain monthly from March 31 to April 30", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly" }),
        moment("2024-03-31")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-30");
    });

    it("should find the 2nd Tuesday of next month using day_of_month + week_of_month", () => {
      // From March 12, 2024 (2nd Tuesday of March), next should be 2nd Tuesday of April = Apr 9
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", day_of_month: 2, week_of_month: 2 }),
        moment("2024-03-12")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-09");
    });

    it("should find the 1st Friday of next month", () => {
      // From March 1, 2024, next 1st Friday of April = Apr 5
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", day_of_month: 5, week_of_month: 1 }),
        moment("2024-03-01")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-05");
    });

    it("should handle 5th Monday falling back when month has only 4 Mondays", () => {
      // April 2024 has Mondays: 1, 8, 15, 22, 29 → 5 Mondays
      // Feb 2024 has Mondays: 5, 12, 19, 26 → only 4 Mondays
      // From Jan 29, 2024 (5th Monday of Jan), next should try 5th Monday of Feb → fall back to 4th = Feb 26
      const result = calculateNextEndDate(
        schedule({ schedule_type: "monthly", day_of_month: 1, week_of_month: 5 }),
        moment("2024-01-29")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-26");
    });
  });

  describe("yearly schedule", () => {
    it("should advance by 1 year", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "yearly" }), moment("2024-06-15"));
      expect(result.format("YYYY-MM-DD")).toBe("2025-06-15");
    });

    it("should handle leap day (Feb 29 → Feb 28)", () => {
      const result = calculateNextEndDate(schedule({ schedule_type: "yearly" }), moment("2024-02-29"));
      // moment: Feb 29 + 1 year = Feb 28 (2025 is not a leap year)
      expect(result.format("YYYY-MM-DD")).toBe("2025-02-28");
    });
  });

  describe("every_x_days schedule", () => {
    it("should advance by the specified interval", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_days", interval_days: 3 }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-18");
    });

    it("should default to 1 day if interval_days is null", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_days", interval_days: null }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-16");
    });

    it("should cross month boundary with large interval", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_days", interval_days: 30 }),
        moment("2024-01-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-14");
    });
  });

  describe("every_x_weeks schedule", () => {
    it("should advance by the specified number of weeks", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_weeks", interval_weeks: 2 }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-29");
    });

    it("should cross month boundary", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_weeks", interval_weeks: 3 }),
        moment("2024-03-20")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-10");
    });
  });

  describe("every_x_months schedule", () => {
    it("should advance by the specified number of months", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_months", interval_months: 2 }),
        moment("2024-03-15")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-05-15");
    });

    it("should clamp day when target month is shorter (Jan 31 + 2 months → Mar 31)", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_months", interval_months: 2 }),
        moment("2024-01-31")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-03-31");
    });

    it("should clamp day when target month is shorter (Jan 31 + 1 month → Feb 29)", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_months", interval_months: 1 }),
        moment("2024-01-31")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-02-29");
    });

    it("should clamp day when target month is shorter (Mar 31 + 1 month → Apr 30)", () => {
      const result = calculateNextEndDate(
        schedule({ schedule_type: "every_x_months", interval_months: 1 }),
        moment("2024-03-31")
      );
      expect(result.format("YYYY-MM-DD")).toBe("2024-04-30");
    });
  });

  describe("time drift prevention", () => {
    it("should always return start of day regardless of input time", () => {
      const inputWithTime = moment("2024-03-15T14:30:45");
      const result = calculateNextEndDate(schedule({ schedule_type: "daily" }), inputWithTime);
      expect(result.format("HH:mm:ss")).toBe("00:00:00");
    });

    it("should not drift when called 100 times in a daily chain", () => {
      let current = moment("2024-01-01T23:59:59");
      for (let i = 0; i < 100; i++) {
        current = calculateNextEndDate(schedule({ schedule_type: "daily" }), current);
      }
      expect(current.format("YYYY-MM-DD")).toBe("2024-04-10");
      expect(current.format("HH:mm:ss")).toBe("00:00:00");
    });

    it("should not drift when called 365 times in a daily chain", () => {
      let current = moment("2024-01-01T12:00:00");
      for (let i = 0; i < 365; i++) {
        current = calculateNextEndDate(schedule({ schedule_type: "daily" }), current);
      }
      // 2024 is a leap year, so 365 days from Jan 1 = Dec 31
      expect(current.format("YYYY-MM-DD")).toBe("2024-12-31");
      expect(current.format("HH:mm:ss")).toBe("00:00:00");
    });
  });

  describe("error handling", () => {
    it("should throw on invalid schedule type", () => {
      expect(() => {
        calculateNextEndDate(schedule({ schedule_type: "invalid" as any }), moment("2024-03-15"));
      }).toThrow("Invalid schedule type: invalid");
    });
  });
});

describe("calculateNextEndDates", () => {
  it("should generate multiple consecutive dates", () => {
    const dates = calculateNextEndDates(
      schedule({ schedule_type: "daily" }),
      moment("2024-03-15"),
      5
    );
    expect(dates.map(d => d.format("YYYY-MM-DD"))).toEqual([
      "2024-03-16",
      "2024-03-17",
      "2024-03-18",
      "2024-03-19",
      "2024-03-20"
    ]);
  });

  it("should generate weekly dates across month boundary", () => {
    const dates = calculateNextEndDates(
      schedule({ schedule_type: "weekly" }),
      moment("2024-02-22"),
      3
    );
    expect(dates.map(d => d.format("YYYY-MM-DD"))).toEqual([
      "2024-02-29",
      "2024-03-07",
      "2024-03-14"
    ]);
  });

  it("should generate monthly dates with clamping", () => {
    const dates = calculateNextEndDates(
      schedule({ schedule_type: "monthly", date_of_month: 31 }),
      moment("2024-01-31"),
      4
    );
    expect(dates.map(d => d.format("YYYY-MM-DD"))).toEqual([
      "2024-02-29",
      "2024-03-31",
      "2024-04-30",
      "2024-05-31"
    ]);
  });
});
