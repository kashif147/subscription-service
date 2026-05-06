const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { MEMBERSHIP_STATUS } = require("../constants/enums");
const {
  utcDayStartMs,
  graduationEligibleForRun,
  matchesUndergraduateCategory,
  isSkippedTerminalStatus,
  readEnvConfig,
  NOTIFICATION_TITLE,
  NOTIFICATION_BODY,
} = require("../services/undergraduateGraduationCancellation.service.js");

describe("undergraduateGraduationCancellation (date rules)", () => {
  it("member before graduation date is not eligible", () => {
    const today = new Date(Date.UTC(2026, 4, 4, 12, 0, 0, 0));
    const todayStart = utcDayStartMs(today);
    const grad = new Date(Date.UTC(2026, 4, 5, 0, 0, 0, 0));
    assert.equal(graduationEligibleForRun(grad, todayStart), false);
  });

  it("member on graduation date is eligible", () => {
    const today = new Date(Date.UTC(2026, 4, 4, 12, 0, 0, 0));
    const todayStart = utcDayStartMs(today);
    const grad = new Date(Date.UTC(2026, 4, 4, 23, 59, 59, 999));
    assert.equal(graduationEligibleForRun(grad, todayStart), true);
  });

  it("member after graduation date is eligible", () => {
    const today = new Date(Date.UTC(2026, 4, 10, 12, 0, 0, 0));
    const todayStart = utcDayStartMs(today);
    const grad = new Date(Date.UTC(2026, 4, 4, 0, 0, 0, 0));
    assert.equal(graduationEligibleForRun(grad, todayStart), true);
  });

  it("null graduation date is not eligible", () => {
    const today = new Date(Date.UTC(2026, 4, 4, 12, 0, 0, 0));
    const todayStart = utcDayStartMs(today);
    assert.equal(graduationEligibleForRun(null, todayStart), false);
  });
});

describe("undergraduateGraduationCancellation (category + status)", () => {
  it("matches configured Undergraduate Student label (case-insensitive)", () => {
    assert.equal(
      matchesUndergraduateCategory("  undergraduate Student ", "Undergraduate Student"),
      true
    );
  });

  it("already cancelled status is terminal skip", () => {
    assert.equal(isSkippedTerminalStatus(MEMBERSHIP_STATUS.CANCELLED), true);
  });

  it("active status is not terminal skip", () => {
    assert.equal(isSkippedTerminalStatus(MEMBERSHIP_STATUS.ACTIVE), false);
  });
});

describe("undergraduateGraduationCancellation (notification copy)", () => {
  it("exports required title and body for graduation comms", () => {
    assert.ok(NOTIFICATION_TITLE.includes("Graduation"));
    assert.ok(NOTIFICATION_BODY.includes("Undergraduate Student"));
  });
});

describe("readEnvConfig", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    delete process.env.UGRAD_GRADUATION_FROM_CATEGORY;
    delete process.env.FROM_CATEGORY;
    delete process.env.UGRAD_GRADUATION_CANCELLATION_REASON;
    delete process.env.CANCELLATION_REASON;
    delete process.env.UGRAD_GRADUATION_DRY_RUN;
    delete process.env.DRY_RUN;
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it("uses defaults when env unset", () => {
    const c = readEnvConfig();
    assert.equal(c.fromCategory, "Undergraduate Student");
    assert.equal(c.cancellationReason, "Graduated");
    assert.equal(c.dryRun, false);
  });

  it("honours FROM_CATEGORY and CANCELLATION_REASON aliases", () => {
    process.env.FROM_CATEGORY = "Custom UG";
    process.env.CANCELLATION_REASON = "Custom reason";
    const c = readEnvConfig();
    assert.equal(c.fromCategory, "Custom UG");
    assert.equal(c.cancellationReason, "Custom reason");
  });

  it("DRY_RUN true when set", () => {
    process.env.DRY_RUN = "true";
    assert.equal(readEnvConfig().dryRun, true);
  });
});
