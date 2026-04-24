const {
  REMINDER_BATCH_MIN_BALANCE_CENTS,
  REMINDER_BATCH_DELINQUENCY_DAYS,
} = require("../constants/reminderBatch.constants");
const { REMINDER_BATCH_TIER } = require("../constants/enums");

/** Batch pipeline state on subscription (`reminders` subdoc object). */
function remindersState(subLean) {
  const r = subLean?.reminders;
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  return {};
}

function utcStartOfMonth(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
}

function utcPrevMonthStart(asOf) {
  const s = utcStartOfMonth(asOf);
  if (!s) return null;
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 1, 1));
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

/** Net amount owed on 1400: materialized arrears + current (both credit member liability). */
function net1400OwedCents(snap) {
  const ar = Number(snap?.net1400ArrearsCents) || 0;
  const cur = Number(snap?.net1400CurrentCents) || 0;
  return ar + cur;
}

function isFinanciallyDelinquent(snap, asOf) {
  if (net1400OwedCents(snap) < REMINDER_BATCH_MIN_BALANCE_CENTS) return false;
  const last = snap?.lastReceiptGlDate ? new Date(snap.lastReceiptGlDate) : null;
  const as = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(as.getTime())) return false;
  if (!last || Number.isNaN(last.getTime())) return true;
  const days = calendarDaysBetween(last, as);
  return days != null && days >= REMINDER_BATCH_DELINQUENCY_DAYS;
}

/**
 * Highest tier for REMINDER kind batch (R1 / R2 / R3 tabs). Members with reminder3At already set
 * are excluded here — they belong on the cancellation batch only.
 */
function classifyMaxReminderTier(subLean, snap, asOf, previousExecuteCompletedAt) {
  const a = asOf instanceof Date ? asOf : new Date(asOf);
  if (paymentAfterPreviousBatch(snap?.lastReceiptGlDate, previousExecuteCompletedAt)) {
    return null;
  }
  if (!isFinanciallyDelinquent(snap, a)) return null;

  const prevStart = utcPrevMonthStart(a);
  if (!prevStart) return null;

  const st = remindersState(subLean);
  const r1 = st.reminder1At ? new Date(st.reminder1At) : null;
  const r2 = st.reminder2At ? new Date(st.reminder2At) : null;
  const r3 = st.reminder3At ? new Date(st.reminder3At) : null;

  if (r3) return null;

  if (r2 && !r3 && r2 < prevStart) return REMINDER_BATCH_TIER.R3;
  if (r1 && !r2 && r1 < prevStart) return REMINDER_BATCH_TIER.R2;
  if (!r1) return REMINDER_BATCH_TIER.R1;
  return null;
}

/** CANCEL tier for CANCELLATION kind batch */
function classifyCancellationTier(subLean, snap, asOf, previousExecuteCompletedAt) {
  const a = asOf instanceof Date ? asOf : new Date(asOf);
  if (paymentAfterPreviousBatch(snap?.lastReceiptGlDate, previousExecuteCompletedAt)) {
    return null;
  }
  if (!isFinanciallyDelinquent(snap, a)) return null;
  const prevStart = utcPrevMonthStart(a);
  if (!prevStart) return null;
  const st = remindersState(subLean);
  const r3 = st.reminder3At ? new Date(st.reminder3At) : null;
  if (r3 && r3 < prevStart) return REMINDER_BATCH_TIER.CANCEL;
  return null;
}

module.exports = {
  utcStartOfMonth,
  utcPrevMonthStart,
  calendarDaysBetween,
  classifyMaxReminderTier,
  classifyCancellationTier,
  isFinanciallyDelinquent,
  net1400OwedCents,
  paymentAfterPreviousBatch,
};
