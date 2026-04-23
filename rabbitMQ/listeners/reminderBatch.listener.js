const { consumer } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");
const reminderBatchService = require("../../services/reminderBatch.service");
const { createInternalWorkerReq } = require("../../helpers/serviceClient");

function buildWorkerReq(payload) {
  const tenantId = payload?.tenantId;
  return createInternalWorkerReq(tenantId, {
    userId: payload?.actorUserId || null,
    email: payload?.actorEmail || null,
  });
}

async function handleReminderBuildRequested(payload) {
  const req = buildWorkerReq(payload);
  await reminderBatchService.buildReminderBatch(req, payload.batchId);
}

async function handleReminderExecuteRequested(payload) {
  const req = buildWorkerReq(payload);
  await reminderBatchService.executeReminderBatch(req, payload.batchId);
}

async function handleReminderMonthlyOrchestrateRequested(payload) {
  const req = buildWorkerReq(payload);
  await reminderBatchService.runMonthlyOrchestration(req, {
    cancellationBatchId: payload.cancellationBatchId,
    reminderBatchId: payload.reminderBatchId,
  });
}

async function handleReminderCommsRequested(payload) {
  console.log("[reminder-batch] comms request received", {
    idempotencyKey: payload?.idempotencyKey,
    tenantId: payload?.tenantId,
    batchMemberId: payload?.batchMemberId,
  });
}

async function registerReminderBatchConsumers() {
  const queueName = "subscription-service.reminder-batch.jobs";
  await consumer.createQueue(queueName, { durable: true });
  await consumer.bindQueue(queueName, "membership.events", [
    MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
    MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
    MEMBERSHIP_EVENTS.REMINDER_BATCH_COMMS_REQUESTED,
  ]);

  consumer.registerHandler(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    handleReminderBuildRequested
  );
  consumer.registerHandler(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
    handleReminderExecuteRequested
  );
  consumer.registerHandler(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
    handleReminderMonthlyOrchestrateRequested
  );
  consumer.registerHandler(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_COMMS_REQUESTED,
    handleReminderCommsRequested
  );

  await consumer.consume(queueName, { prefetch: 2 });
}

module.exports = {
  registerReminderBatchConsumers,
};
