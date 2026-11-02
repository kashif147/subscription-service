const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const { isValidTenantId } = require("../helpers/requestTenant");

function isRabbitConfigured() {
  return Boolean(process.env.RABBIT_URL && String(process.env.RABBIT_URL).trim());
}

const CORRELATION_ID_FORMAT = /^[A-Za-z0-9._:-]{1,128}$/;

function safeCorrelationId(value) {
  const v = value == null ? "" : String(value).trim();
  return CORRELATION_ID_FORMAT.test(v) ? v : null;
}

/**
 * P5 service authority: a queued reminder job carries NO user credential (no bearer token, no
 * gateway identity headers) and no actor PII (no email). It carries only the trusted
 * tenant, the verified actor id (audit attribution), a correlation id and the job parameters. The
 * consumer runs the job with subscription-service's internal service authority; the user's
 * permission to start it was checked at the trigger (middlewares/reminderBatchAuthz.mw.js).
 */
function buildJobPayload(req, params) {
  const tenantId = req?.tenantId == null ? "" : String(req.tenantId).trim();
  if (!isValidTenantId(tenantId)) {
    throw new Error("Reminder job requires a trusted tenant (no default tenant)");
  }
  return {
    ...params,
    tenantId,
    actorUserId: req.userId ? String(req.userId) : null,
    correlationId: safeCorrelationId(req.correlationId || req.headers?.["x-correlation-id"]),
  };
}

async function publishJob(eventType, data) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  await publisher.publish(eventType, data, {
    tenantId: data.tenantId,
    correlationId: data.correlationId || undefined,
    exchange: "membership.events",
    routingKey: eventType,
    metadata: { service: "subscription-service", version: "1.0" },
  });
  return { queued: true, transport: "rabbitmq", event: eventType };
}

async function publishReminderBuildRequested(req, batchId) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  return publishJob(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    buildJobPayload(req, { batchId: String(batchId) })
  );
}

async function publishReminderExecuteRequested(req, batchId) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  return publishJob(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
    buildJobPayload(req, { batchId: String(batchId) })
  );
}

async function publishReminderMonthlyOrchestrateRequested(req, body) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  return publishJob(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
    buildJobPayload(req, {
      cancellationBatchId: String(body.cancellationBatchId),
      reminderBatchId: String(body.reminderBatchId),
    })
  );
}

module.exports = {
  isRabbitConfigured,
  safeCorrelationId,
  publishReminderBuildRequested,
  publishReminderExecuteRequested,
  publishReminderMonthlyOrchestrateRequested,
};
