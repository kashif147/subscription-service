const { consumer, publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");
const reminderBatchService = require("../../services/reminderBatch.service");
const ReminderBatchMember = require("../../models/reminderBatchMember.model");
const Subscription = require("../../models/subscription.model");
const { createInternalWorkerReq } = require("../../helpers/serviceClient");

function eventData(payload) {
  return payload?.data && typeof payload.data === "object"
    ? payload.data
    : payload;
}

function buildWorkerReq(payload) {
  const data = eventData(payload);
  const tenantId = data?.tenantId ?? payload?.tenantId;
  const req = createInternalWorkerReq(tenantId, {
    userId: data?.actorUserId || null,
    email: data?.actorEmail || null,
  });
  if (data?.headers && typeof data.headers === "object") {
    req.headers = {
      ...req.headers,
      ...data.headers,
      "x-tenant-id": tenantId,
      "x-internal-request": "true",
    };
  }
  return req;
}

async function handleReminderBuildRequested(payload) {
  const data = eventData(payload);
  const req = buildWorkerReq(payload);
  try {
    await reminderBatchService.buildReminderBatch(req, data?.batchId);
  } catch (err) {
    console.error("[reminder-batch] build consumer failed", {
      batchId: data?.batchId,
      tenantId: data?.tenantId ?? payload?.tenantId,
      message: err?.message || String(err),
    });
    throw err;
  }
}

async function handleReminderExecuteRequested(payload) {
  const data = eventData(payload);
  const req = buildWorkerReq(payload);
  await reminderBatchService.executeReminderBatch(req, data?.batchId);
}

async function handleReminderMonthlyOrchestrateRequested(payload) {
  const data = eventData(payload);
  const req = buildWorkerReq(payload);
  await reminderBatchService.runMonthlyOrchestration(req, {
    cancellationBatchId: data?.cancellationBatchId,
    reminderBatchId: data?.reminderBatchId,
  });
}

async function handleReminderCommsRequested(payload) {
  const data = payload?.data || payload;
  const tenantId = data?.tenantId ?? payload?.tenantId;
  const batchMemberId = data?.batchMemberId;
  const tier = data?.tier;
  const kind = data?.kind;
  if (!tenantId || !batchMemberId) return;

  const row = await ReminderBatchMember.findById(batchMemberId).lean();
  if (!row) return;

  const sub = row.subscriptionId
    ? await Subscription.findById(row.subscriptionId).select("userId").lean()
    : null;
  const userId = sub?.userId;
  if (!userId) {
    console.warn("[reminder-batch] comms skipped — no userId", {
      batchMemberId,
      memberId: row.memberId,
    });
    return;
  }

  const isCancel = kind === "CANCELLATION" || tier === "CANCEL";
  const title = isCancel
    ? "Membership cancellation notice"
    : `Membership payment reminder (${tier || "notice"})`;
  const body = isCancel
    ? "Your membership is scheduled for cancellation due to outstanding subscription fees. Please contact us or pay your balance to avoid cancellation."
    : `You have an outstanding membership balance. This is reminder ${String(tier || "").replace("R", "") || "1"} of 3. Please arrange payment to keep your membership active.`;

  await publisher.publish(
    MEMBERSHIP_EVENTS.MEMBER_NOTIFICATION_REQUESTED,
    {
      tenantId,
      userId: String(userId),
      title,
      body,
      metadata: {
        type: isCancel ? "REMINDER_CANCELLATION" : "REMINDER_BATCH",
        tier: tier || null,
        batchId: data?.batchId || null,
        batchMemberId: String(batchMemberId),
        memberId: row.memberId,
      },
    },
    {
      tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.MEMBER_NOTIFICATION_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );

  await ReminderBatchMember.updateOne(
    { _id: batchMemberId },
    { $set: { commsEnqueuedAt: new Date() } }
  );
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
