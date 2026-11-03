const mongoose = require("mongoose");

/**
 * P5 service authority: durable record of a queued reminder job that was REFUSED because it was
 * published before the migration and carries the triggering user's stored request headers.
 *
 * The record keeps only what an operator needs to re-run the work from the CRM (job kind, tenant,
 * batch ids, verified actor id, correlation id) plus presence flags describing what the refused
 * payload carried. It never stores a header name or value, a bearer token, a gateway identity or an
 * email address. Written (upsert on dedupeKey) BEFORE the message is acknowledged; redelivery of the
 * same job updates the one record (deliveryCount / lastSeenAt) instead of creating another.
 *
 * Not tenant-plugin guarded on purpose: a refused payload may have no resolvable tenant (mismatch or
 * missing), which is recorded as tenantStatus with tenantId null. Operational record, not member data.
 */
const ReminderJobQuarantineSchema = new mongoose.Schema(
  {
    dedupeKey: { type: String, required: true, unique: true },
    reason: { type: String, required: true, enum: ["LEGACY_CREDENTIAL_PAYLOAD"] },
    kind: { type: String, required: true, enum: ["build", "execute", "orchestrate"] },
    eventType: { type: String, default: null },
    eventId: { type: String, default: null },
    correlationId: { type: String, default: null },
    tenantId: { type: String, default: null, index: true },
    tenantStatus: { type: String, required: true, enum: ["resolved", "mismatch", "missing"] },
    batchId: { type: String, default: null },
    cancellationBatchId: { type: String, default: null },
    reminderBatchId: { type: String, default: null },
    actorUserId: { type: String, default: null },
    invalidIdFields: { type: [String], default: [] },
    carried: {
      storedRequestContext: { type: Boolean, default: false },
      credential: { type: Boolean, default: false },
      gatewayIdentity: { type: Boolean, default: false },
      tenantHeader: { type: Boolean, default: false },
      internalFlag: { type: Boolean, default: false },
      actorPii: { type: Boolean, default: false },
      otherFieldCount: { type: Number, default: 0 },
    },
    batchMarkedFailed: { type: Boolean, default: false },
    status: { type: String, enum: ["quarantined", "rerun", "discarded"], default: "quarantined" },
    deliveryCount: { type: Number, default: 0 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { collection: "reminder_job_quarantine", strict: "throw", timestamps: false }
);

module.exports =
  mongoose.models.ReminderJobQuarantine ||
  mongoose.model("ReminderJobQuarantine", ReminderJobQuarantineSchema);
