const { REMINDER_BATCH_KIND } = require("../constants/enums");

function partsInTimezone(date, timezone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

function ymdInTimezone(date, timezone) {
  const p = partsInTimezone(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function referencePeriodFor(date, timezone) {
  const p = partsInTimezone(date, timezone);
  return `${p.year}-${p.month}`;
}


function isWeekend(date, timezone) {
  const weekday = partsInTimezone(date, timezone).weekday;
  return weekday === "Sat" || weekday === "Sun";
}

function eachDateYmd(startDate, endDate, timezone) {
  const out = [];
  const start = new Date(startDate);
  const end = new Date(endDate || startDate);
  if (Number.isNaN(start.getTime())) return out;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  );
  const until = Number.isNaN(end.getTime())
    ? cursor
    : new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
      );
  while (cursor <= until) {
    out.push(ymdInTimezone(cursor, timezone));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function buildClosedDateSet(config, timezone) {
  const closed = new Set();
  for (const h of config.publicHolidays || []) {
    eachDateYmd(h.startDate, h.endDate, timezone).forEach((x) => closed.add(x));
  }
  for (const h of config.primaryOffice?.nonWorkingDays || []) {
    eachDateYmd(h.startDate, h.endDate, timezone).forEach((x) => closed.add(x));
  }
  return closed;
}

function dateProbeForYmd(ymd) {
  return new Date(`${ymd}T12:00:00.000Z`);
}

function firstCalendarDateOfMonth(referencePeriod) {
  return dateProbeForYmd(`${referencePeriod}-01`);
}

function firstWorkingDateOfMonth(config, referencePeriod, timezone) {
  const closed = buildClosedDateSet(config, timezone);
  for (let day = 1; day <= 7; day += 1) {
    const ymd = `${referencePeriod}-${String(day).padStart(2, "0")}`;
    const probe = dateProbeForYmd(ymd);
    if (!isWeekend(probe, timezone) && !closed.has(ymd)) {
      return probe;
    }
  }
  return firstCalendarDateOfMonth(referencePeriod);
}

function scheduledBatchDateFor(config, now = new Date()) {
  const timezone = config.regionalSettings?.timezone || "Europe/Dublin";
  const mode =
    config.lifecycleBatches?.schedule?.dayMode || "FIRST_WORKING_DAY";
  const referencePeriod = referencePeriodFor(now, timezone);
  if (mode === "FIRST_DAY") {
    return firstCalendarDateOfMonth(referencePeriod);
  }
  return firstWorkingDateOfMonth(config, referencePeriod, timezone);
}

function formatLifecycleBatchName(kind, date, timezone = "Europe/Dublin") {
  const label =
    kind === REMINDER_BATCH_KIND.CANCELLATION ? "Cancellations" : "Reminders";
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    year: "numeric",
  }).format(date instanceof Date ? date : new Date(date));
  return `${label} - ${formatted}`;
}

function isScheduledRunDay(config, now = new Date()) {
  const timezone = config.regionalSettings?.timezone || "Europe/Dublin";
  const scheduledDate = scheduledBatchDateFor(config, now);
  return ymdInTimezone(now, timezone) === ymdInTimezone(scheduledDate, timezone);
}

module.exports = {
  buildClosedDateSet,
  dateProbeForYmd,
  eachDateYmd,
  formatLifecycleBatchName,
  isScheduledRunDay,
  referencePeriodFor,
  scheduledBatchDateFor,
  ymdInTimezone,
};
