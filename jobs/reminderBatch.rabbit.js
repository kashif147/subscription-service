const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");

function isRabbitConfigured() {
  return Boolean(process.env.RABBIT_URL && String(process.env.RABBIT_URL).trim());
}

async function publishReminderBuildRequested(req, batchId) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  await publisher.publish(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    {
      batchId: String(batchId),
      tenantId: String(req.tenantId),
      actorUserId: req.userId || null,
      actorEmail: req.user?.email || null,
    },
    {
      tenantId: req.tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );
  return { queued: true, transport: "rabbitmq", event: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED };
}

async function publishReminderExecuteRequested(req, batchId) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  await publisher.publish(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
    {
      batchId: String(batchId),
      tenantId: String(req.tenantId),
      actorUserId: req.userId || null,
      actorEmail: req.user?.email || null,
    },
    {
      tenantId: req.tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );
  return {
    queued: true,
    transport: "rabbitmq",
    event: MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
  };
}

async function publishReminderMonthlyOrchestrateRequested(req, body) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  await publisher.publish(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
    {
      cancellationBatchId: String(body.cancellationBatchId),
      reminderBatchId: String(body.reminderBatchId),
      tenantId: String(req.tenantId),
      actorUserId: req.userId || null,
      actorEmail: req.user?.email || null,
    },
    {
      tenantId: req.tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );
  return {
    queued: true,
    transport: "rabbitmq",
    event: MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
  };
}

module.exports = {
  isRabbitConfigured,
  publishReminderBuildRequested,
  publishReminderExecuteRequested,
  publishReminderMonthlyOrchestrateRequested,
};
