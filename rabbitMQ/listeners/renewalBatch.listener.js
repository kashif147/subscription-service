const { resolveEventTenant } = require("../../helpers/eventTenant");
const { consumer } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");
const { processRenewalBatchExecute } = require("../../services/renewalBatch.service");

async function handleRenewalExecuteRequested(payload) {
  const data =
    payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const batchId = data?.batchId ? String(data.batchId) : null;
  if (!batchId) return;
  // The batch is claimed only within the event's tenant (envelope canonical).
  const tenantId = resolveEventTenant(payload);
  await processRenewalBatchExecute(batchId, tenantId);
}

async function registerRenewalBatchConsumers() {
  const queueName = "subscription-service.renewal-batch.jobs";
  await consumer.createQueue(queueName, { durable: true });
  await consumer.bindQueue(queueName, "membership.events", [
    MEMBERSHIP_EVENTS.RENEWAL_BATCH_EXECUTE_REQUESTED,
  ]);

  consumer.registerHandler(
    MEMBERSHIP_EVENTS.RENEWAL_BATCH_EXECUTE_REQUESTED,
    handleRenewalExecuteRequested
  );

  await consumer.consume(queueName, { prefetch: 1 });
}

module.exports = {
  registerRenewalBatchConsumers,
};
