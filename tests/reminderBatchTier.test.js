/**
 * Unit tests for reminder batch tier / delinquency rules.
 * Run: npm test --prefix backend/subscription-service
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isFinanciallyDelinquent,
  classifyMaxReminderTier,
  resolveBatchExclusionReason,
  paymentAfterPreviousBatch,
  highestReminderStep,
  reminderFieldToStepBack,
  amountOwedToDateCents,
  qualifyingReminderOwedCents,
} = require("../helpers/reminderBatchTier");
const { REMINDER_BATCH_KIND, REMINDER_BATCH_EXCLUSION_REASON } = require("../constants/enums");

describe("isFinanciallyDelinquent", () => {
  const asOf = new Date("2026-06-01T12:00:00.000Z");
  const category = "FULL_TIME"; // €540/yr → ~€133 min at 90 days

  it("returns false when accrued + arrears is below the 90-day minimum", () => {
    const snap = { net1400ArrearsCents: 5000, net1400CurrentCents: 0 };
    const sub = { startDate: "2026-05-31", membershipCategory: category };
    assert.equal(
      isFinanciallyDelinquent(snap, asOf, category, 2026, sub),
      false
    );
  });

  it("returns false for a new member with only a few days accrued and no arrears", () => {
    const snap = {
      net1400ArrearsCents: 0,
      net1400CurrentCents: 540_00,
      availableCreditCents: 160_00,
    };
    const sub = { startDate: "2026-05-31", membershipCategory: category };
    assert.equal(
      isFinanciallyDelinquent(snap, asOf, category, 2026, sub),
      false
    );
  });

  it("returns true when prior arrears alone meets the minimum", () => {
    const snap = {
      net1400ArrearsCents: 200_00,
      net1400CurrentCents: 0,
      lastReceiptGlDate: "2026-05-30T00:00:00.000Z",
    };
    const sub = { startDate: "2026-05-31", membershipCategory: category };
    assert.equal(
      isFinanciallyDelinquent(snap, asOf, category, 2026, sub),
      true
    );
  });

  it("returns true when subscription accrual since year start meets the minimum", () => {
    const snap = {
      net1400ArrearsCents: 0,
      net1400CurrentCents: 0,
      lastReceiptGlDate: null,
    };
    const sub = { startDate: "2026-01-01", membershipCategory: category };
    assert.equal(
      isFinanciallyDelinquent(snap, asOf, category, 2026, sub),
      true
    );
  });

  it("returns true when accrual plus arrears exceeds the 90-day minimum", () => {
    const snap = {
      net1400ArrearsCents: 90_00,
      net1400CurrentCents: 0,
      lastReceiptGlDate: null,
    };
    const sub = { startDate: "2026-01-01", membershipCategory: category };
    assert.equal(
      isFinanciallyDelinquent(snap, asOf, category, 2026, sub),
      true
    );
  });
});

describe("amountOwedToDateCents", () => {
  it("counts inclusive days from subscription start through asOf", () => {
    const sub = { startDate: "2026-05-31", membershipCategory: "FULL_TIME" };
    const asOf = new Date("2026-06-01T12:00:00.000Z");
    const owed = amountOwedToDateCents(sub, asOf, "FULL_TIME", 2026);
    // 2 days × (54000 / 365) ≈ 296 cents
    assert.equal(owed, 296);
  });
});

describe("qualifyingReminderOwedCents", () => {
  it("sums accrued subscription fee and prior arrears", () => {
    const sub = { startDate: "2026-05-31", membershipCategory: "FULL_TIME" };
    const snap = { net1400ArrearsCents: 10_00 };
    const asOf = new Date("2026-06-01T12:00:00.000Z");
    assert.equal(
      qualifyingReminderOwedCents(snap, asOf, "FULL_TIME", 2026, sub),
      1296
    );
  });
});

describe("classifyMaxReminderTier", () => {
  const asOf = new Date("2026-06-01T12:00:00.000Z");
  const anchor = new Date("2026-05-01T12:00:00.000Z");
  const snap = {
    net1400ArrearsCents: 0,
    net1400CurrentCents: 0,
    lastReceiptGlDate: null,
  };
  const sub = { startDate: "2026-01-01", membershipCategory: "FULL_TIME" };

  it("assigns R1 when no reminders sent", () => {
    assert.equal(
      classifyMaxReminderTier(sub, snap, asOf, anchor, 2026),
      "R1"
    );
  });

  it("excludes when paid after previous batch", () => {
    const paidSnap = {
      ...snap,
      lastReceiptGlDate: "2026-05-15T00:00:00.000Z",
    };
    assert.equal(
      classifyMaxReminderTier(
        { reminders: { reminder1At: null }, startDate: "2026-01-01", membershipCategory: "FULL_TIME" },
        paidSnap,
        asOf,
        anchor,
        2026
      ),
      null
    );
  });
});

describe("resolveBatchExclusionReason", () => {
  const asOf = new Date("2026-06-01T12:00:00.000Z");
  const anchor = new Date("2026-05-01T12:00:00.000Z");

  it("maps payment after batch to PAYMENT_IN_WINDOW", () => {
    assert.equal(
      resolveBatchExclusionReason(
        { membershipCategory: "FULL_TIME", startDate: "2026-01-01" },
        {
          net1400ArrearsCents: 540_00,
          net1400CurrentCents: 0,
          lastReceiptGlDate: "2026-05-15T00:00:00.000Z",
        },
        asOf,
        anchor,
        2026,
        REMINDER_BATCH_KIND.REMINDER
      ),
      REMINDER_BATCH_EXCLUSION_REASON.PAYMENT_IN_WINDOW
    );
  });

  it("maps low qualifying balance to NOT_DELINQUENT", () => {
    assert.equal(
      resolveBatchExclusionReason(
        { membershipCategory: "FULL_TIME", startDate: "2026-05-31" },
        { net1400ArrearsCents: 100, net1400CurrentCents: 0 },
        asOf,
        anchor,
        2026,
        REMINDER_BATCH_KIND.REMINDER
      ),
      REMINDER_BATCH_EXCLUSION_REASON.NOT_DELINQUENT
    );
  });
});

describe("buildMemberInclusionSummary", () => {
  const asOf = new Date("2026-06-01T12:00:00.000Z");
  const anchor = new Date("2026-05-01T12:00:00.000Z");
  const { buildMemberInclusionSummary } = require("../helpers/reminderBatchTier");

  it("describes included R1 member", () => {
    const summary = buildMemberInclusionSummary({
      batchKind: REMINDER_BATCH_KIND.REMINDER,
      subLean: { startDate: "2026-01-01", membershipCategory: "FULL_TIME" },
      snap: { net1400ArrearsCents: 0, net1400CurrentCents: 0 },
      asOf,
      previousExecuteCompletedAt: anchor,
      proRataCalendarYear: 2026,
      tier: "R1",
    });
    assert.match(summary, /Included for Reminder 1/);
    assert.match(summary, /Qualifying balance/);
  });

  it("describes NOT_DELINQUENT exclusion", () => {
    const summary = buildMemberInclusionSummary({
      batchKind: REMINDER_BATCH_KIND.REMINDER,
      subLean: { startDate: "2026-05-31", membershipCategory: "FULL_TIME" },
      snap: { net1400ArrearsCents: 100, net1400CurrentCents: 0 },
      asOf,
      previousExecuteCompletedAt: anchor,
      proRataCalendarYear: 2026,
      tier: null,
    });
    assert.match(summary, /Excluded: qualifying balance is below/);
  });
});

describe("paymentAfterPreviousBatch", () => {
  it("detects receipt after batch execute", () => {
    assert.equal(
      paymentAfterPreviousBatch(
        "2026-05-20T00:00:00.000Z",
        "2026-05-01T12:00:00.000Z"
      ),
      true
    );
  });
});

describe("reminder step-back (partial payment)", () => {
  it("highestReminderStep returns 3 when R3 set", () => {
    assert.equal(
      highestReminderStep({
        reminders: {
          reminder1At: new Date(),
          reminder2At: new Date(),
          reminder3At: new Date(),
        },
      }),
      3
    );
  });

  it("reminderFieldToStepBack clears highest step only", () => {
    assert.equal(
      reminderFieldToStepBack({
        reminders: { reminder3At: new Date(), reminder2At: new Date() },
      }),
      "reminder3At"
    );
    assert.equal(
      reminderFieldToStepBack({ reminders: { reminder2At: new Date() } }),
      "reminder2At"
    );
    assert.equal(
      reminderFieldToStepBack({ reminders: { reminder1At: new Date() } }),
      "reminder1At"
    );
    assert.equal(reminderFieldToStepBack({ reminders: {} }), null);
  });
});
