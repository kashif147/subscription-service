const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");

function isRabbitConfigured() {
  return Boolean(process.env.RABBIT_URL && String(process.env.RABBIT_URL).trim());
}

async function publishRenewalExecuteRequested(req, batchId) {
  if (!isRabbitConfigured()) throw new Error("RABBIT_URL not configured");
  await publisher.publish(
    MEMBERSHIP_EVENTS.RENEWAL_BATCH_EXECUTE_REQUESTED,
    {
      batchId: String(batchId),
      tenantId: String(req.tenantId),
      actorUserId: req.userId || null,
      actorEmail: req.user?.email || null,
    },
    {
      tenantId: req.tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.RENEWAL_BATCH_EXECUTE_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );

  return {
    queued: true,
    transport: "rabbitmq",
    event: MEMBERSHIP_EVENTS.RENEWAL_BATCH_EXECUTE_REQUESTED,
  };
}

module.exports = {
  isRabbitConfigured,
  publishRenewalExecuteRequested,
};
