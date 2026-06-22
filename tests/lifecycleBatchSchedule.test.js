const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { REMINDER_BATCH_KIND } = require("../constants/enums");
const {
  formatLifecycleBatchName,
  isScheduledRunDay,
  scheduledBatchDateFor,
  ymdInTimezone,
} = require("../helpers/lifecycleBatchSchedule");

const timezone = "Europe/Dublin";

describe("lifecycleBatchSchedule", () => {
  it("formats reminder batch name as Reminders - MMM YYYY", () => {
    const name = formatLifecycleBatchName(
      REMINDER_BATCH_KIND.REMINDER,
      new Date("2026-06-15T12:00:00.000Z"),
      timezone
    );
    assert.equal(name, "Reminders - Jun 2026");
  });

  it("formats cancellation batch name as Cancellations - MMM YYYY", () => {
    const name = formatLifecycleBatchName(
      REMINDER_BATCH_KIND.CANCELLATION,
      new Date("2026-03-01T12:00:00.000Z"),
      timezone
    );
    assert.equal(name, "Cancellations - Mar 2026");
  });

  it("uses first calendar day when dayMode is FIRST_DAY", () => {
    const config = {
      regionalSettings: { timezone },
      lifecycleBatches: { schedule: { dayMode: "FIRST_DAY" } },
    };
    const now = new Date("2026-06-01T00:05:00.000Z");
    const batchDate = scheduledBatchDateFor(config, now);
    assert.equal(ymdInTimezone(batchDate, timezone), "2026-06-01");
    assert.equal(isScheduledRunDay(config, now), true);
    assert.equal(
      isScheduledRunDay(config, new Date("2026-06-02T00:05:00.000Z")),
      false
    );
  });

  it("uses first working day when dayMode is FIRST_WORKING_DAY", () => {
    const config = {
      regionalSettings: { timezone },
      lifecycleBatches: { schedule: { dayMode: "FIRST_WORKING_DAY" } },
      publicHolidays: [],
      primaryOffice: { nonWorkingDays: [] },
    };
    const june2026FirstWorking = new Date("2026-06-01T00:05:00.000Z");
    const batchDate = scheduledBatchDateFor(config, june2026FirstWorking);
    assert.equal(ymdInTimezone(batchDate, timezone), "2026-06-01");
    assert.equal(isScheduledRunDay(config, june2026FirstWorking), true);

    const may2026Config = { ...config };
    const mayFirstWorking = new Date("2026-05-01T00:05:00.000Z");
    const mayBatchDate = scheduledBatchDateFor(may2026Config, mayFirstWorking);
    assert.equal(ymdInTimezone(mayBatchDate, timezone), "2026-05-01");
  });

  it("skips weekend and holiday for first working day", () => {
    const config = {
      regionalSettings: { timezone },
      lifecycleBatches: { schedule: { dayMode: "FIRST_WORKING_DAY" } },
      publicHolidays: [{ startDate: "2026-05-01", endDate: "2026-05-01" }],
      primaryOffice: { nonWorkingDays: [] },
    };
    const batchDate = scheduledBatchDateFor(
      config,
      new Date("2026-05-04T00:05:00.000Z")
    );
    assert.equal(ymdInTimezone(batchDate, timezone), "2026-05-04");
    assert.equal(
      isScheduledRunDay(config, new Date("2026-05-04T00:05:00.000Z")),
      true
    );
    assert.equal(
      isScheduledRunDay(config, new Date("2026-05-01T00:05:00.000Z")),
      false
    );
  });
});
