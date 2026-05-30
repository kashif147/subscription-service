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
} = require("../helpers/reminderBatchTier");
const { REMINDER_BATCH_KIND, REMINDER_BATCH_EXCLUSION_REASON } = require("../constants/enums");

describe("isFinanciallyDelinquent", () => {
  const asOf = new Date("2026-06-01T12:00:00.000Z");
  const category = "FULL_TIME"; // €540/yr → ~€133 min at 90 days

  it("returns false when 1400 balance is below pro-rata minimum", () => {
    const snap = {
      net1400ArrearsCents: 5000,
      net1400CurrentCents: 0,
      lastReceiptGlDate: "2026-05-01T00:00:00.000Z",
    };
    assert.equal(isFinanciallyDelinquent(snap, asOf, category, 2026), false);
  });

  it("returns true when balance meets minimum even if last receipt is recent", () => {
    const snap = {
      net1400ArrearsCents: 200_00,
      net1400CurrentCents: 0,
      lastReceiptGlDate: "2026-05-30T00:00:00.000Z",
    };
    assert.equal(isFinanciallyDelinquent(snap, asOf, category, 2026), true);
  });

  it("returns true when balance meets minimum and there is no receipt", () => {
    const snap = {
      net1400ArrearsCents: 540_00,
      net1400CurrentCents: 0,
      lastReceiptGlDate: null,
    };
    assert.equal(isFinanciallyDelinquent(snap, asOf, category, 2026), true);
  });
});

describe("classifyMaxReminderTier", () => {
  const asOf = new Date("2026-06-01T12:00:00.000Z");
  const anchor = new Date("2026-05-01T12:00:00.000Z");
  const snap = {
    net1400ArrearsCents: 540_00,
    net1400CurrentCents: 0,
    lastReceiptGlDate: null,
  };

  it("assigns R1 when no reminders sent", () => {
    assert.equal(
      classifyMaxReminderTier({}, snap, asOf, anchor, 2026),
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
        { reminders: { reminder1At: null } },
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
        {},
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

  it("maps low balance to NOT_DELINQUENT", () => {
    assert.equal(
      resolveBatchExclusionReason(
        { membershipCategory: "FULL_TIME" },
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
