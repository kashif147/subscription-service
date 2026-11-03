const mongoose = require("mongoose");
const { resolveEventTenant } = require("../../helpers/eventTenant");
const { consumer, publisher, connectionManager } = require("@projectShell/rabbitmq-middleware");
const { startExplicitAckConsumer } = require("../explicitAckConsumer");
const { MEMBERSHIP_EVENTS } = require("../events");
const reminderBatchService = require("../../services/reminderBatch.service");
const ReminderBatch = require("../../models/reminderBatch.model");
const ReminderBatchMember = require("../../models/reminderBatchMember.model");
const { REMINDER_BATCH_STATUS } = require("../../constants/enums");
const Subscription = require("../../models/subscription.model");
const { createInternalWorkerReq } = require("../../helpers/serviceClient");
const ReminderJobQuarantine = require("../../models/reminderJobQuarantine.model");
const crypto = require("crypto");

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
 * never authorized, and replaying the identity is the defect being removed. Decision: REFUSE, durably.
 *   1. QUARANTINE FIRST: a credential-free record (models/reminderJobQuarantine.model.js) is upserted
 *      on a dedupe key (event id, else a hash of the non-credential fields). Only the job kind, tenant,
 *      batch ids, verified actor id, correlation id and presence flags are stored - never a header name
 *      or value, a token, a gateway identity or an email. Redelivery updates the same record.
 *   2. build: a still-queued batch (status pending_build, tenant-scoped) is then marked failed so the
 *      CRM user can re-run the build; execute / monthly-orchestrate: no state change (re-trigger).
 *   3. Only when 1 (and 2) succeeded does the handler return, so the explicit-ack adapter
 *      (rabbitMQ/explicitAckConsumer.js) acks the delivery. If the record (or the batch update) cannot
 *      be written the handler THROWS and the delivery is never acked: first delivery -> nack(requeue=true)
 *      (one broker-side redelivery), redelivered -> nack(requeue=false) -> broker dead-letters it to
 *      subscription-service.reminder-batch.jobs.dlq. No in-memory retry, no copy, no loop; a crash at any
 *      point before the ack leaves the delivery with the broker.
 *   - never replayed, never processed, never re-published by this service;
 *   - logs carry kind, event id, tenant-resolved flag and delivery count only.
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

const EVENT_TYPE_BY_KIND = {
  build: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
  execute: MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
  orchestrate: MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
};
const ID_FIELDS_BY_KIND = {
  build: ["batchId"],
  execute: ["batchId"],
  orchestrate: ["cancellationBatchId", "reminderBatchId"],
};
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
// Payload keys that are expected in a legacy job and are either stored (ids) or summarised (flags).
const KNOWN_LEGACY_KEYS = new Set([
  "tenantId", "batchId", "cancellationBatchId", "reminderBatchId", "actorUserId", "actorEmail",
  "correlationId", "headers",
]);

function safeToken(v) {
  const s = v == null ? "" : String(v).trim();
  return SAFE_TOKEN.test(s) ? s : null;
}

function legacyTenant(payload) {
  try {
    return { tenantId: resolveEventTenant(payload), tenantStatus: "resolved" };
  } catch (e) {
    return { tenantId: null, tenantStatus: e?.code === "EVENT_TENANT_MISMATCH" ? "mismatch" : "missing" };
  }
}

/** Presence flags only: what the refused payload carried. Never names or values. */
function carriedFlags(data) {
  const h = data?.headers && typeof data.headers === "object" ? data.headers : {};
  const present = Object.entries(h)
    .filter(([, v]) => v != null && v !== "")
    .map(([k]) => String(k).toLowerCase());
  const has = (re) => present.some((k) => re.test(k));
  return {
    storedRequestContext: true,
    credential: has(/^authorization$/) || has(/^cookie$/),
    gatewayIdentity: has(/^x-(user|jwt|auth|gateway|platform)-/),
    tenantHeader: has(/^x-tenant-id$/),
    internalFlag: has(/^x-internal-request$/),
    actorPii: Boolean(data?.actorEmail),
    otherFieldCount: Object.keys(data || {}).filter((k) => !KNOWN_LEGACY_KEYS.has(k)).length,
  };
}

/** The credential-free quarantine record for a refused legacy job (exported for tests). */
function buildQuarantineRecord(kind, payload) {
  const data = eventData(payload) || {};
  const { tenantId, tenantStatus } = legacyTenant(payload);
  const ids = {};
  const invalidIdFields = [];
  for (const f of ID_FIELDS_BY_KIND[kind]) {
    const v = data[f];
    if (v == null || v === "") ids[f] = null;
    else if (mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f0-9]{24}$/i.test(String(v))) ids[f] = String(v);
    else {
      ids[f] = null;
      invalidIdFields.push(f);
    }
  }
  const eventId = safeToken(payload?.eventId);
  const correlationId = safeCorrelationId(data?.correlationId || payload?.correlationId);
  const actorUserId = safeToken(data?.actorUserId);
  const basis = { kind, eventId, tenantId, tenantStatus, ...ids, actorUserId, correlationId };
  const dedupeKey = eventId
    ? `evt:${kind}:${eventId}`
    : `sha:${crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex")}`;
  return {
    dedupeKey,
    reason: "LEGACY_CREDENTIAL_PAYLOAD",
    kind,
    eventType: EVENT_TYPE_BY_KIND[kind],
    eventId,
    correlationId,
    tenantId,
    tenantStatus,
    batchId: ids.batchId ?? null,
    cancellationBatchId: ids.cancellationBatchId ?? null,
    reminderBatchId: ids.reminderBatchId ?? null,
    actorUserId,
    invalidIdFields,
    carried: carriedFlags(data),
  };
}

async function refuseLegacyCredentialPayload(kind, payload) {
  const record = buildQuarantineRecord(kind, payload);
  const now = new Date();
  // 1. Durable, credential-free record BEFORE anything else. Throws -> no ack (see above).
  const { dedupeKey, ...insertFields } = record;
  const stored = await ReminderJobQuarantine.findOneAndUpdate(
    { dedupeKey },
    {
      $setOnInsert: { ...insertFields, firstSeenAt: now, status: "quarantined" },
      $set: { lastSeenAt: now },
      $inc: { deliveryCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  // 2. build: fail the still-queued batch so the CRM user can re-run it. Throws -> no ack; the
  //    redelivery updates the same quarantine record and retries this step.
  if (kind === "build" && record.tenantId && record.batchId) {
    const r = await ReminderBatch.updateOne(
      { _id: record.batchId, tenantId: record.tenantId, status: REMINDER_BATCH_STATUS.PENDING_BUILD },
      {
        $set: {
          status: REMINDER_BATCH_STATUS.FAILED,
          error: LEGACY_REFUSED_MESSAGE,
          "buildProgress.lastError": LEGACY_REFUSED_MESSAGE,
        },
      }
    );
    if (r?.modifiedCount) {
      await ReminderJobQuarantine.updateOne({ dedupeKey }, { $set: { batchMarkedFailed: true } });
    }
  }

  legacyCredentialPayloadRefusals[kind] += 1;
  console.warn("[reminder-batch] LegacyCredentialPayloadQuarantined", {
    kind,
    eventId: record.eventId,
    tenantResolved: record.tenantStatus === "resolved",
    deliveryCount: stored?.deliveryCount ?? null,
  });
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

const REMINDER_JOBS_QUEUE = "subscription-service.reminder-batch.jobs";
const REMINDER_JOBS_PREFETCH = 2;
let reminderJobsConsumer = null;

/** Event type -> handler for the reminder jobs queue (consumed by the explicit-ack adapter). */
function reminderJobHandlers() {
  return {
    [MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED]: handleReminderBuildRequested,
    [MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED]: handleReminderExecuteRequested,
    [MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED]: handleReminderMonthlyOrchestrateRequested,
    [MEMBERSHIP_EVENTS.REMINDER_BATCH_COMMS_REQUESTED]: handleReminderCommsRequested,
  };
}

async function registerReminderBatchConsumers() {
  const queueName = REMINDER_JOBS_QUEUE;
  await consumer.createQueue(queueName, { durable: true });
  await consumer.bindQueue(queueName, "membership.events", [
    MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    MEMBERSHIP_EVENTS.REMINDER_BATCH_EXECUTE_REQUESTED,
    MEMBERSHIP_EVENTS.REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED,
    MEMBERSHIP_EVENTS.REMINDER_BATCH_COMMS_REQUESTED,
  ]);

  // P5: explicit acknowledgement (rabbitMQ/explicitAckConsumer.js) instead of the shared consumer, whose
  // ack-then-republish-from-a-timer retry can lose a job on a crash. The four reminder handlers are NOT
  // registered in the shared consumer's handler map.
  reminderJobsConsumer = await startExplicitAckConsumer({
    connectionManager,
    queueName,
    handlers: reminderJobHandlers(),
    prefetch: REMINDER_JOBS_PREFETCH,
  });
}

async function stopReminderBatchConsumers() {
  if (reminderJobsConsumer) await reminderJobsConsumer.stop();
  reminderJobsConsumer = null;
}

module.exports = {
  registerReminderBatchConsumers,
  stopReminderBatchConsumers,
  reminderJobHandlers,
  REMINDER_JOBS_QUEUE,
  REMINDER_JOBS_PREFETCH,
  // exported for tests (Phase A / A2 tenant binding; P5 service authority)
  handleReminderCommsRequested,
  handleReminderBuildRequested,
  handleReminderExecuteRequested,
  handleReminderMonthlyOrchestrateRequested,
  buildWorkerReq,
  getLegacyCredentialPayloadRefusals,
  buildQuarantineRecord,
};
