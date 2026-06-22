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
const {
  formatLifecycleBatchName,
  isScheduledRunDay,
  referencePeriodFor,
  scheduledBatchDateFor,
} = require("../helpers/lifecycleBatchSchedule");


let timer = null;
let running = false;

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
  const batchDate = scheduledBatchDateFor(config, now);
  const name = formatLifecycleBatchName(kind, batchDate, timezone);
  return reminderBatchService.createReminderBatch(req, {
    name,
    kind,
    batchDate: batchDate.toISOString(),
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

function msUntilNextMinute() {
  const now = new Date();
  return 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}

function scheduleNextLifecycleBatchRun() {
  timer = setTimeout(() => {
    runLifecycleBatchSchedulerOnce()
      .catch((err) =>
        console.error("[LIFECYCLE_BATCH_SCHEDULER] Interval error:", err.message)
      )
      .finally(() => {
        scheduleNextLifecycleBatchRun();
      });
  }, msUntilNextMinute());
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
  setTimeout(() => {
    runLifecycleBatchSchedulerOnce().catch((err) =>
      console.error("[LIFECYCLE_BATCH_SCHEDULER] Initial run error:", err.message)
    );
  }, 20000);
  scheduleNextLifecycleBatchRun();
}

function stopLifecycleBatchScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  isScheduledRunDay,
  runLifecycleBatchSchedulerOnce,
  startLifecycleBatchScheduler,
  stopLifecycleBatchScheduler,
};
