const ReminderBatch = require("../models/reminderBatch.model");
const reminderBatchService = require("../services/reminderBatch.service");
const {
  REMINDER_BATCH_KIND,
  REMINDER_BATCH_STATUS,
} = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const {
  fetchTenantLifecycleConfigs,
  fetchNotificationRecipients,
} = require("../helpers/tenantLifecycleClient");
const { createInternalWorkerReq } = require("../helpers/serviceClient");

const INTERVAL_MS = parseInt(
  process.env.LIFECYCLE_BATCH_SCHEDULER_MS || String(60 * 60 * 1000),
  10
);

let timer = null;
let running = false;

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

function dayNumberFor(date, timezone) {
  return Number(partsInTimezone(date, timezone).day);
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
  const cursor = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  ));
  const until = Number.isNaN(end.getTime()) ? cursor : new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  ));
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

function isScheduledRunDay(config, now = new Date()) {
  const timezone = config.regionalSettings?.timezone || "Europe/Dublin";
  const mode =
    config.lifecycleBatches?.schedule?.dayMode || "FIRST_WORKING_DAY";
  if (mode === "FIRST_DAY") {
    return dayNumberFor(now, timezone) === 1;
  }

  const nowYmd = ymdInTimezone(now, timezone);
  const currentMonth = referencePeriodFor(now, timezone);
  const closed = buildClosedDateSet(config, timezone);
  for (let day = 1; day <= 7; day += 1) {
    const probe = new Date(`${currentMonth}-${String(day).padStart(2, "0")}T12:00:00.000Z`);
    const ymd = ymdInTimezone(probe, timezone);
    if (!isWeekend(probe, timezone) && !closed.has(ymd)) {
      return nowYmd === ymd;
    }
  }
  return false;
}

async function notifyTenant(config, title, body, metadata = {}) {
  const tenantId = config.tenantId;
  const roleCodes =
    config.lifecycleBatches?.notificationRecipientRoleCodes || [
      "MO",
    ];
  const users = await fetchNotificationRecipients(tenantId, roleCodes).catch(
    () => []
  );
  await Promise.all(
    users.map((user) =>
      publisher
        .publish(
          MEMBERSHIP_EVENTS.MEMBER_NOTIFICATION_REQUESTED,
          {
            tenantId,
            userId: String(user._id),
            title,
            body,
            metadata: {
              type: "LIFECYCLE_BATCH",
              ...metadata,
            },
          },
          {
            tenantId,
            exchange: "membership.events",
            routingKey: MEMBERSHIP_EVENTS.MEMBER_NOTIFICATION_REQUESTED,
            metadata: { service: "subscription-service", version: "1.0" },
          }
        )
        .catch(() => {})
    )
  );
}

async function findMonthlyBatch(tenantId, kind, referencePeriod) {
  return ReminderBatch.findOne({ tenantId, kind, referencePeriod })
    .sort({ createdAt: -1 })
    .lean();
}

async function ensureMonthlyBatch(config, kind, req, now) {
  const timezone = config.regionalSettings?.timezone || "Europe/Dublin";
  const referencePeriod = referencePeriodFor(now, timezone);
  const existing = await findMonthlyBatch(config.tenantId, kind, referencePeriod);
  if (existing) return existing;
  const label = kind === REMINDER_BATCH_KIND.CANCELLATION
    ? "Cancellation"
    : "Reminder";
  return reminderBatchService.createReminderBatch(req, {
    name: `${label} batch ${referencePeriod}`,
    kind,
    batchDate: now.toISOString(),
    referencePeriod,
  });
}

async function buildIfNeeded(config, batch, req, label) {
  if (!batch) return null;
  if (batch.status === REMINDER_BATCH_STATUS.READY ||
      batch.status === REMINDER_BATCH_STATUS.COMPLETED) {
    return batch;
  }
  if (
    batch.status === REMINDER_BATCH_STATUS.DRAFT ||
    batch.status === REMINDER_BATCH_STATUS.FAILED ||
    batch.status === REMINDER_BATCH_STATUS.PENDING_BUILD
  ) {
    await notifyTenant(config, `${label} generation queued`, `${label} batch generation has started.`, {
      batchId: String(batch._id),
      step: "generate",
      status: "queued",
    });
    try {
      const built = await reminderBatchService.buildReminderBatch(req, batch._id);
      await notifyTenant(config, `${label} generation completed`, `${label} batch is ready for review.`, {
        batchId: String(batch._id),
        step: "generate",
        status: "completed",
      });
      return built;
    } catch (error) {
      await notifyTenant(config, `${label} generation failed`, error.message || `${label} batch generation failed.`, {
        batchId: String(batch._id),
        step: "generate",
        status: "failed",
      });
      throw error;
    }
  }
  return batch;
}

async function executeIfReady(config, batch, req, label) {
  if (!batch) return null;
  if (batch.status === REMINDER_BATCH_STATUS.COMPLETED) return batch;
  if (batch.status !== REMINDER_BATCH_STATUS.READY) return batch;
  await notifyTenant(config, `${label} execution queued`, `${label} batch execution has started.`, {
    batchId: String(batch._id),
    step: "execute",
    status: "queued",
  });
  try {
    const executed = await reminderBatchService.executeReminderBatch(req, batch._id);
    await notifyTenant(config, `${label} execution completed`, `${label} batch execution completed.`, {
      batchId: String(batch._id),
      step: "execute",
      status: "completed",
    });
    return executed;
  } catch (error) {
    await notifyTenant(config, `${label} execution failed`, error.message || `${label} batch execution failed.`, {
      batchId: String(batch._id),
      step: "execute",
      status: "failed",
    });
    throw error;
  }
}

function blocksReminderExecution(cancellationBatch, cancellationExecuteMode) {
  if (!cancellationBatch) return false;
  if (cancellationBatch.status === REMINDER_BATCH_STATUS.COMPLETED) return false;
  if (cancellationExecuteMode === "automatic") {
    return cancellationBatch.status !== REMINDER_BATCH_STATUS.COMPLETED;
  }
  return true;
}

async function processTenant(config, now = new Date()) {
  if (!isScheduledRunDay(config, now)) return { skipped: "not_scheduled_day" };
  const req = createInternalWorkerReq(config.tenantId, {
    email: "system@lifecycle-batch",
  });
  const settings = config.lifecycleBatches || {};
  const timezone = config.regionalSettings?.timezone || "Europe/Dublin";
  const referencePeriod = referencePeriodFor(now, timezone);

  let cancellationBatch = await findMonthlyBatch(
    config.tenantId,
    REMINDER_BATCH_KIND.CANCELLATION,
    referencePeriod
  );
  if (settings.cancellation?.generateMode === "automatic") {
    cancellationBatch = await ensureMonthlyBatch(
      config,
      REMINDER_BATCH_KIND.CANCELLATION,
      req,
      now
    );
    cancellationBatch = await buildIfNeeded(
      config,
      cancellationBatch,
      req,
      "Cancellation"
    );
  }
  if (
    settings.cancellation?.executeMode === "automatic" &&
    cancellationBatch?.status === REMINDER_BATCH_STATUS.READY
  ) {
    cancellationBatch = await executeIfReady(
      config,
      cancellationBatch,
      req,
      "Cancellation"
    );
  }

  let reminderBatch = await findMonthlyBatch(
    config.tenantId,
    REMINDER_BATCH_KIND.REMINDER,
    referencePeriod
  );
  if (settings.reminder?.generateMode === "automatic") {
    reminderBatch = await ensureMonthlyBatch(
      config,
      REMINDER_BATCH_KIND.REMINDER,
      req,
      now
    );
    reminderBatch = await buildIfNeeded(config, reminderBatch, req, "Reminder");
  }
  if (
    settings.reminder?.executeMode === "automatic" &&
    reminderBatch?.status === REMINDER_BATCH_STATUS.READY
  ) {
    if (blocksReminderExecution(
      cancellationBatch,
      settings.cancellation?.executeMode
    )) {
      await notifyTenant(
        config,
        "Reminder execution blocked",
        "Reminder batch execution is waiting for the cancellation batch to be completed first.",
        {
          reminderBatchId: String(reminderBatch._id),
          cancellationBatchId: cancellationBatch?._id
            ? String(cancellationBatch._id)
            : null,
          step: "execute",
          status: "blocked",
        }
      );
    } else {
      reminderBatch = await executeIfReady(config, reminderBatch, req, "Reminder");
    }
  }

  return { referencePeriod, cancellationBatch, reminderBatch };
}

async function runLifecycleBatchSchedulerOnce(now = new Date()) {
  if (running) return { skipped: "already_running" };
  running = true;
  try {
    const configs = await fetchTenantLifecycleConfigs();
    const results = [];
    for (const config of configs) {
      try {
        results.push(await processTenant(config, now));
      } catch (error) {
        console.error("[LIFECYCLE_BATCH_SCHEDULER] Tenant failed", {
          tenantId: config.tenantId,
          error: error.message,
        });
        results.push({ tenantId: config.tenantId, error: error.message });
      }
    }
    return { processed: results.length, results };
  } finally {
    running = false;
  }
}

function startLifecycleBatchScheduler() {
  if (timer) return;
  if (process.env.LIFECYCLE_BATCH_SCHEDULER_ENABLED !== "true") {
    return;
  }
  if (!process.env.RABBIT_URL || !process.env.RABBIT_URL.trim()) {
    console.warn(
      "⚠️ [LIFECYCLE_BATCH_SCHEDULER] RABBIT_URL not set; scheduler not started"
    );
    return;
  }
  timer = setInterval(() => {
    runLifecycleBatchSchedulerOnce().catch((err) =>
      console.error("[LIFECYCLE_BATCH_SCHEDULER] Interval error:", err.message)
    );
  }, INTERVAL_MS);
  setTimeout(() => {
    runLifecycleBatchSchedulerOnce().catch((err) =>
      console.error("[LIFECYCLE_BATCH_SCHEDULER] Initial run error:", err.message)
    );
  }, 20000);
}

function stopLifecycleBatchScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  isScheduledRunDay,
  runLifecycleBatchSchedulerOnce,
  startLifecycleBatchScheduler,
  stopLifecycleBatchScheduler,
};
