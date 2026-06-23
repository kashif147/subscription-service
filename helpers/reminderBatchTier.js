const {
  REMINDER_BATCH_MIN_BALANCE_CENTS,
  REMINDER_BATCH_DELINQUENCY_DAYS,
} = require("../constants/reminderBatch.constants");
const {
  REMINDER_BATCH_TIER,
  REMINDER_BATCH_EXCLUSION_REASON,
  REMINDER_BATCH_KIND,
} = require("../constants/enums");
const { getExpectedAnnualFeeCents } = require("./serviceClient");

/** Batch pipeline state on subscription (`reminders` subdoc object). */
function remindersState(subLean) {
  const r = subLean?.reminders;
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  return {};
}

/**
 * Cutoff for R2 / R3 tier steps: last **same-kind** completed batch
 * `executeCompletedAt` only. `null` if this is the first such batch in history (e.g. first
 * April reminder run) — there is no calendar-month fallback.
 * @param {Date|string|null|undefined} previousExecuteCompletedAt
 * @returns {Date|null}
 */
function reminderTierAnchorDate(previousExecuteCompletedAt) {
  if (previousExecuteCompletedAt == null) return null;
  const p =
    previousExecuteCompletedAt instanceof Date
      ? previousExecuteCompletedAt
      : new Date(previousExecuteCompletedAt);
  if (Number.isNaN(p.getTime())) return null;
  return p;
}

function calendarDaysBetween(fromDate, toDate) {
  const a = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const b = toDate instanceof Date ? toDate : new Date(toDate);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (86400 * 1000));
}

function paymentAfterPreviousBatch(lastReceiptIso, previousExecuteCompletedAt) {
  if (!previousExecuteCompletedAt || !lastReceiptIso) return false;
  const r = new Date(lastReceiptIso);
  const p = new Date(previousExecuteCompletedAt);
  if (Number.isNaN(r.getTime()) || Number.isNaN(p.getTime())) return false;
  return r > p;
}

/**
 * Calendar days in `year` (1 Jan through 31 Dec) — 365, or 366 in a leap year. Uses UTC.
 * @param {number} year - full year (e.g. 2024)
 * @returns {number}
 */
function daysInCalendarYear(year) {
  if (!Number.isFinite(year)) return 365;
  return Math.round(
    (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000
  );
}

/** Net amount owed after member credit is applied to 1400 arrears/current. */
function net1400OwedCents(snap) {
  const netAfterCredit = Number(snap?.netOutstandingAfterCreditCents);
  if (Number.isFinite(netAfterCredit)) return Math.max(0, netAfterCredit);

  const ar = Number(snap?.net1400ArrearsCents) || 0;
  const cur = Number(snap?.net1400CurrentCents) || 0;
  const availableCredit = Number(snap?.availableCreditCents) || 0;
  return Math.max(0, ar + cur - availableCredit);
}

/**
 * Inclusive UTC calendar days from `fromDate` through `toDate` (same day = 1).
 * @returns {number}
 */
function inclusiveCalendarDaysBetweenUtc(fromDate, toDate) {
  const a = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const b = toDate instanceof Date ? toDate : new Date(toDate);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const startMs = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const endMs = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  if (endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

/**
 * Pro-rated subscription fee accrued from current subscription start through `asOf`
 * (inclusive days × annual fee ÷ days in the fee calendar year).
 * @param {object|null|undefined} subLean
 * @param {Date|string} asOf
 * @param {string|null|undefined} membershipCategory
 * @param {number} [proRataCalendarYear]
 * @returns {number} cents
 */
function amountOwedToDateCents(subLean, asOf, membershipCategory, proRataCalendarYear) {
  const category = subLean?.membershipCategory || membershipCategory;
  const feeCents = getExpectedAnnualFeeCents(category);
  if (!feeCents) return 0;

  const startDate = subLean?.startDate;
  if (!startDate) return 0;

  const asOfDate = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(asOfDate.getTime())) return 0;

  const year = Number.isFinite(proRataCalendarYear)
    ? proRataCalendarYear
    : asOfDate.getUTCFullYear();
  const yearDays = daysInCalendarYear(year);
  const inclusiveDays = inclusiveCalendarDaysBetweenUtc(startDate, asOfDate);
  if (inclusiveDays <= 0) return 0;

  return Math.max(0, Math.round((feeCents / yearDays) * inclusiveDays));
}

/** Prior-year / carried 1400 arrears only (positive = member owes). */
function priorArrearsCents(snap) {
  return Math.max(0, Number(snap?.net1400ArrearsCents) || 0);
}

/**
 * Total obligation used for reminder-batch inclusion:
 * accrued fee since subscription start + prior arrears.
 * @param {object|null|undefined} subLean
 */
function qualifyingReminderOwedCents(
  snap,
  asOf,
  membershipCategory,
  proRataCalendarYear,
  subLean = null
) {
  const accrued = amountOwedToDateCents(
    subLean,
    asOf,
    membershipCategory,
    proRataCalendarYear
  );
  return accrued + priorArrearsCents(snap);
}

/**
 * Pro-rata min 1400 (cents) for a **calendar year** (365 or 366 days in that year).
 * Unknown category (no fee in map) falls back to {@link REMINDER_BATCH_MIN_BALANCE_CENTS}.
 * @param {string|null|undefined} membershipCategory
 * @param {number} calendarYear
 */
function getReminderMinBalanceCentsForCalendarYear(membershipCategory, calendarYear) {
  const annualCents = getExpectedAnnualFeeCents(membershipCategory);
  if (!annualCents) return REMINDER_BATCH_MIN_BALANCE_CENTS;
  if (!Number.isFinite(calendarYear)) return REMINDER_BATCH_MIN_BALANCE_CENTS;
  const yearDays = daysInCalendarYear(calendarYear);
  const d = Number(REMINDER_BATCH_DELINQUENCY_DAYS) || 90;
  const proRataCents = Math.round((annualCents / yearDays) * d);
  return Math.max(REMINDER_BATCH_MIN_BALANCE_CENTS, proRataCents);
}

/**
 * Pro-rata min using the **current** calendar year in UTC (when batch logic runs), not the balance `asOf` date.
 */
function getReminderMinBalanceCents(membershipCategory) {
  return getReminderMinBalanceCentsForCalendarYear(
    membershipCategory,
    new Date().getUTCFullYear()
  );
}

/**
 * Delinquent when (amount owed to date from subscription start + prior arrears) is at least
 * the pro-rata minimum (~90 days of annual fee). Payments and advance credit are not part of
 * this gate — a new member with only a few days accrued stays excluded even if GL current
 * balance was invoiced for the full year.
 *
 * @param {number} [proRataCalendarYear] - fee year for daily rate and minimum threshold
 * @param {object|null|undefined} [subLean] - current subscription (`startDate`, `membershipCategory`)
 */
function isFinanciallyDelinquent(
  snap,
  asOf,
  membershipCategory,
  proRataCalendarYear,
  subLean = null
) {
  const minCents = Number.isFinite(proRataCalendarYear)
    ? getReminderMinBalanceCentsForCalendarYear(
        membershipCategory,
        proRataCalendarYear
      )
    : getReminderMinBalanceCents(membershipCategory);
  return (
    qualifyingReminderOwedCents(
      snap,
      asOf,
      membershipCategory,
      proRataCalendarYear,
      subLean
    ) >= minCents
  );
}

/**
 * Why a member was excluded from an included batch row (audit / UI).
 * @param {string} batchKind - REMINDER | CANCELLATION
 */
function resolveBatchExclusionReason(
  subLean,
  snap,
  asOf,
  previousExecuteCompletedAt,
  proRataCalendarYear,
  batchKind
) {
  if (
    paymentAfterPreviousBatch(
      snap?.lastReceiptGlDate,
      previousExecuteCompletedAt
    )
  ) {
    return REMINDER_BATCH_EXCLUSION_REASON.PAYMENT_IN_WINDOW;
  }
  if (
    !isFinanciallyDelinquent(
      snap,
      asOf,
      subLean?.membershipCategory,
      proRataCalendarYear,
      subLean
    )
  ) {
    return REMINDER_BATCH_EXCLUSION_REASON.NOT_DELINQUENT;
  }

  const st = remindersState(subLean);
  if (batchKind === REMINDER_BATCH_KIND.REMINDER && st.reminder3At) {
    return REMINDER_BATCH_EXCLUSION_REASON.TIER_GATE;
  }
  if (batchKind === REMINDER_BATCH_KIND.CANCELLATION && !st.reminder3At) {
    return REMINDER_BATCH_EXCLUSION_REASON.TIER_GATE;
  }
  return REMINDER_BATCH_EXCLUSION_REASON.TIER_GATE;
}

/** True when subscription has any batch-pipeline reminder timestamp set. */
function hasActiveReminderPipeline(st) {
  const r = remindersState(st);
  return !!(r.reminder1At || r.reminder2At || r.reminder3At);
}

/**
 * Highest reminder step already recorded (3 > 2 > 1 > 0).
 * @param {object} subLean
 * @returns {0|1|2|3}
 */
function highestReminderStep(subLean) {
  const st = remindersState(subLean);
  if (st.reminder3At) return 3;
  if (st.reminder2At) return 2;
  if (st.reminder1At) return 1;
  return 0;
}

/**
 * Which reminder field to clear for a one-step partial-payment rollback.
 * @returns {"reminder3At"|"reminder2At"|"reminder1At"|null}
 */
function reminderFieldToStepBack(subLean) {
  const st = remindersState(subLean);
  if (st.reminder3At) return "reminder3At";
  if (st.reminder2At) return "reminder2At";
  if (st.reminder1At) return "reminder1At";
  return null;
}

/**
 * Highest tier for REMINDER kind batch (R1 / R2 / R3 tabs). Members with reminder3At already set
 * are excluded here — they belong on the cancellation batch only.
 */
function classifyMaxReminderTier(
  subLean,
  snap,
  asOf,
  previousExecuteCompletedAt,
  proRataCalendarYear
) {
  const a = asOf instanceof Date ? asOf : new Date(asOf);
  if (paymentAfterPreviousBatch(snap?.lastReceiptGlDate, previousExecuteCompletedAt)) {
    return null;
  }
  if (
    !isFinanciallyDelinquent(
      snap,
      a,
      subLean?.membershipCategory,
      proRataCalendarYear,
      subLean
    )
  ) {
    return null;
  }

  const anchor = reminderTierAnchorDate(previousExecuteCompletedAt);

  const st = remindersState(subLean);
  const r1 = st.reminder1At ? new Date(st.reminder1At) : null;
  const r2 = st.reminder2At ? new Date(st.reminder2At) : null;
  const r3 = st.reminder3At ? new Date(st.reminder3At) : null;

  if (r3) return null;

  if (r2 && !r3 && anchor && r2 < anchor) return REMINDER_BATCH_TIER.R3;
  if (r1 && !r2 && anchor && r1 < anchor) return REMINDER_BATCH_TIER.R2;
  if (!r1) return REMINDER_BATCH_TIER.R1;
  return null;
}

/** CANCEL tier for CANCELLATION kind batch */
function classifyCancellationTier(
  subLean,
  snap,
  asOf,
  previousExecuteCompletedAt,
  proRataCalendarYear
) {
  const a = asOf instanceof Date ? asOf : new Date(asOf);
  if (paymentAfterPreviousBatch(snap?.lastReceiptGlDate, previousExecuteCompletedAt)) {
    return null;
  }
  if (
    !isFinanciallyDelinquent(
      snap,
      a,
      subLean?.membershipCategory,
      proRataCalendarYear,
      subLean
    )
  ) {
    return null;
  }
  const anchor = reminderTierAnchorDate(previousExecuteCompletedAt);
  const st = remindersState(subLean);
  const r3 = st.reminder3At ? new Date(st.reminder3At) : null;
  if (!r3) return null;
  if (anchor == null || r3 < anchor) return REMINDER_BATCH_TIER.CANCEL;
  return null;
}

module.exports = {
  reminderTierAnchorDate,
  calendarDaysBetween,
  daysInCalendarYear,
  classifyMaxReminderTier,
  classifyCancellationTier,
  isFinanciallyDelinquent,
  resolveBatchExclusionReason,
  hasActiveReminderPipeline,
  highestReminderStep,
  reminderFieldToStepBack,
  remindersState,
  getReminderMinBalanceCents,
  getReminderMinBalanceCentsForCalendarYear,
  net1400OwedCents,
  inclusiveCalendarDaysBetweenUtc,
  amountOwedToDateCents,
  priorArrearsCents,
  qualifyingReminderOwedCents,
  paymentAfterPreviousBatch,
};
