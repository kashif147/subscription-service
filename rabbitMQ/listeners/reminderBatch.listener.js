const mongoose = require("mongoose");
const { resolveEventTenant } = require("../../helpers/eventTenant");
const { consumer, publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");
const reminderBatchService = require("../../services/reminderBatch.service");
const ReminderBatch = require("../../models/reminderBatch.model");
const ReminderBatchMember = require("../../models/reminderBatchMember.model");
const { REMINDER_BATCH_STATUS } = require("../../constants/enums");
const Subscription = require("../../models/subscription.model");
const { createInternalWorkerReq } = require("../../helpers/serviceClient");

function eventData(payload) {
  return payload?.data && typeof payload.data === "object"
    ? payload.data
    : payload;
}

const { safeCorrelationId } = require("../../jobs/reminderBatch.rabbit.js");

/**
 * P5 service authority: the worker runs every reminder job with subscription-service's own internal
 * service authority (createInternalWorkerReq: x-internal-request + the trusted event tenant). It
 * NEVER replays request headers stored in a payload. Only the verified actor id (audit attribution)
 * and a correlation id are taken from the job.
 */
function buildWorkerReq(payload) {
  const data = eventData(payload);
  const tenantId = resolveEventTenant(payload); // envelope canonical; mismatch/missing -> quarantine
  const req = createInternalWorkerReq(tenantId, { userId: data?.actorUserId || null });
  const correlationId = safeCorrelationId(data?.correlationId || payload?.correlationId);
  if (correlationId) {
    req.correlationId = correlationId;
    req.headers["x-correlation-id"] = correlationId;
  }
  return req;
}

/**
 * Legacy payloads (published before the P5 service-authority migration) embed the triggering user's
 * request headers - bearer token and gateway identity - under `data.headers`. Such a job was queued
 * WITHOUT the trigger-time permission check (the only finance gate was account-service evaluating the
 * replayed identity), so running it now with service authority would execute work whose requester was
 * never authorized, and replaying the identity is the defect being removed. Decision: REFUSE.
 *   - never replayed, never processed, never re-published;
 *   - the handler RETURNS (message acked): throwing would retry (republish) and finally dead-letter the
 *     message, i.e. write the credential to the DLQ again;
 *   - build: a still-queued batch (status pending_build, tenant-scoped) is marked failed so the CRM
 *     user can simply re-run the build; execute / monthly-orchestrate: no state change (re-trigger);
 *   - a safe counter + warning with no header names or values and no stored identity.
 */
const legacyCredentialPayloadRefusals = { build: 0, execute: 0, orchestrate: 0 };

function getLegacyCredentialPayloadRefusals() {
  return { ...legacyCredentialPayloadRefusals };
}

function isLegacyCredentialPayload(payload) {
  const data = eventData(payload);
  return Boolean(data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "headers"));
}

const LEGACY_REFUSED_MESSAGE =
  "Queued request predates the service-authority migration and was not processed; re-run it from the CRM";

async function refuseLegacyCredentialPayload(kind, payload) {
  legacyCredentialPayloadRefusals[kind] += 1;
  const data = eventData(payload);
  let tenantId = null;
  try {
    tenantId = resolveEventTenant(payload);
  } catch (_e) {
    tenantId = null; // mismatch/missing: drop without any mutation (and without a DLQ copy)
  }
  console.warn("[reminder-batch] LegacyCredentialPayloadRefused", {
    kind,
    eventId: payload?.eventId || null,
    tenantResolved: Boolean(tenantId),
    refusedTotal: legacyCredentialPayloadRefusals[kind],
  });
  if (kind !== "build" || !tenantId) return;
  const batchId = data?.batchId;
  if (!batchId || !mongoose.Types.ObjectId.isValid(String(batchId))) return;
  try {
    await ReminderBatch.updateOne(
      { _id: String(batchId), tenantId, status: REMINDER_BATCH_STATUS.PENDING_BUILD },
      {
        $set: {
          status: REMINDER_BATCH_STATUS.FAILED,
          error: LEGACY_REFUSED_MESSAGE,
          "buildProgress.lastError": LEGACY_REFUSED_MESSAGE,
        },
      }
    );
  } catch (err) {
    console.warn("[reminder-batch] legacy build refusal: batch status not updated", {
      eventId: payload?.eventId || null,
      message: err?.message || String(err),
    });
  }
}

async function handleReminderBuildRequested(payload) {
  if (isLegacyCredentialPayload(payload)) return refuseLegacyCredentialPayload("build", payload);
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
  if (isLegacyCredentialPayload(payload)) return refuseLegacyCredentialPayload("execute", payload);
  const data = eventData(payload);
  const req = buildWorkerReq(payload);
  await reminderBatchService.executeReminderBatch(req, data?.batchId);
}

async function handleReminderMonthlyOrchestrateRequested(payload) {
  if (isLegacyCredentialPayload(payload)) return refuseLegacyCredentialPayload("orchestrate", payload);
  const data = eventData(payload);
  const req = buildWorkerReq(payload);
  await reminderBatchService.runMonthlyOrchestration(req, {
    cancellationBatchId: data?.cancellationBatchId,
    reminderBatchId: data?.reminderBatchId,
  });
}

async function handleReminderCommsRequested(payload) {
  const data = payload?.data || payload;
  const tenantId = resolveEventTenant(payload); // envelope canonical; mismatch/missing -> quarantine
  const batchMemberId = data?.batchMemberId;
  const tier = data?.tier;
  const kind = data?.kind;
  if (!tenantId || !batchMemberId) return;

  // Phase A / A2: the batch member and its subscription must belong to the event tenant; ownership is
  // never inferred from an id alone. A record of another tenant is treated as not found (no mutation).
  if (!mongoose.Types.ObjectId.isValid(String(batchMemberId))) {
    console.warn("[reminder-batch] comms skipped — malformed batchMemberId", { eventId: payload?.eventId || null });
    return;
  }
  const row = await ReminderBatchMember.findOne({ _id: batchMemberId, tenantId }).lean();
  if (!row) {
    console.warn("[reminder-batch] EventTenantRecordMismatch: no batch member for this tenant", {
      batchMemberId: String(batchMemberId),
      eventId: payload?.eventId || null,
    });
    return;
  }

  const sub = row.subscriptionId
    ? await Subscription.findOne({ _id: row.subscriptionId, tenantId }).select("userId").lean()
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
    { _id: batchMemberId, tenantId },
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
  // exported for tests (Phase A / A2 tenant binding; P5 service authority)
  handleReminderCommsRequested,
  handleReminderBuildRequested,
  handleReminderExecuteRequested,
  handleReminderMonthlyOrchestrateRequested,
  buildWorkerReq,
  getLegacyCredentialPayloadRefusals,
};
