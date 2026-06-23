const Subscription = require("../models/subscription.model");
const {
  MEMBERSHIP_STATUS,
} = require("../constants/enums");
const {
  isFinanciallyDelinquent,
  hasActiveReminderPipeline,
  reminderFieldToStepBack,
} = require("../helpers/reminderBatchTier");
const {
  fetchProfilesByMembershipNumbers,
  fetchReminderEligibilityBulk,
  createInternalWorkerReq,
} = require("../helpers/serviceClient");
const {
  serializeSubscriptionForAudit,
  publishSubscriptionChangedAudit,
} = require("../rabbitMQ/publishers/subscription.changed.audit.publisher.js");

const CLEARED_REASON_PAYMENT = "PAYMENT";
const CLEARED_REASON_BUILD = "BUILD_NOT_DELINQUENT";
const CLEARED_REASON_PARTIAL_PAYMENT = "PARTIAL_PAYMENT";

function ensureRemindersSubdoc(sub) {
  if (!sub.reminders || typeof sub.reminders !== "object" || Array.isArray(sub.reminders)) {
    sub.reminders = {};
  }
}

/**
 * Clear all reminder timestamps when the member is no longer financially delinquent.
 * @returns {Promise<"cleared_all"|false>}
 */
async function clearRemindersIfSettled(sub, snap, options = {}) {
  if (!sub?._id) return false;
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const proRataCalendarYear = asOf.getUTCFullYear();
  const clearedReason = options.clearedReason || CLEARED_REASON_PAYMENT;

  if (
    isFinanciallyDelinquent(
      snap,
      asOf,
      sub.membershipCategory,
      proRataCalendarYear,
      sub
    )
  ) {
    return false;
  }
  if (!hasActiveReminderPipeline(sub)) return false;

  const doc = await Subscription.findById(sub._id);
  if (!doc) return false;
  if (doc.subscriptionStatus !== MEMBERSHIP_STATUS.ACTIVE || !doc.isCurrent) {
    return false;
  }

  const beforePlain = serializeSubscriptionForAudit(doc);
  ensureRemindersSubdoc(doc);
  doc.reminders.reminder1At = null;
  doc.reminders.reminder2At = null;
  doc.reminders.reminder3At = null;
  doc.reminders.clearedAt = new Date();
  doc.reminders.clearedReason = clearedReason;
  await doc.save();

  await publishSubscriptionChangedAudit({
    tenantId: doc.tenantId,
    subscriptionId: doc._id.toString(),
    profileId: doc.profileId?.toString() || null,
    applicationId: doc.applicationId || null,
    actorUserId: null,
    actorEmail: "system@reminder-clear",
    changedFields: [
      "reminders.reminder1At",
      "reminders.reminder2At",
      "reminders.reminder3At",
      "reminders.clearedAt",
      "reminders.clearedReason",
    ],
    before: beforePlain,
    after: serializeSubscriptionForAudit(doc),
  }).catch(() => {});

  return "cleared_all";
}

/**
 * Partial payment while still delinquent: drop one reminder step (R3→R2, R2→R1, R1→none).
 * @returns {Promise<"stepped_back"|false>}
 */
async function stepBackRemindersIfPartialPayment(sub, snap, options = {}) {
  if (!sub?._id) return false;
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const proRataCalendarYear = asOf.getUTCFullYear();

  if (
    !isFinanciallyDelinquent(
      snap,
      asOf,
      sub.membershipCategory,
      proRataCalendarYear,
      sub
    )
  ) {
    return false;
  }

  const field = reminderFieldToStepBack(sub);
  if (!field) return false;

  const doc = await Subscription.findById(sub._id);
  if (!doc) return false;
  if (doc.subscriptionStatus !== MEMBERSHIP_STATUS.ACTIVE || !doc.isCurrent) {
    return false;
  }

  const beforePlain = serializeSubscriptionForAudit(doc);
  ensureRemindersSubdoc(doc);
  doc.reminders[field] = null;
  doc.reminders.clearedAt = new Date();
  doc.reminders.clearedReason = CLEARED_REASON_PARTIAL_PAYMENT;
  await doc.save();

  await publishSubscriptionChangedAudit({
    tenantId: doc.tenantId,
    subscriptionId: doc._id.toString(),
    profileId: doc.profileId?.toString() || null,
    applicationId: doc.applicationId || null,
    actorUserId: null,
    actorEmail: "system@reminder-clear",
    changedFields: [
      `reminders.${field}`,
      "reminders.clearedAt",
      "reminders.clearedReason",
    ],
    before: beforePlain,
    after: serializeSubscriptionForAudit(doc),
  }).catch(() => {});

  return "stepped_back";
}

async function findCurrentSubscriptionByMemberId(memberId, tenantId, req) {
  const mid = String(memberId || "").trim();
  if (!mid) return null;

  const wreq = req && req.headers ? req : createInternalWorkerReq(tenantId);
  const profiles = await fetchProfilesByMembershipNumbers([mid], tenantId, wreq);
  const profile = profiles[0];
  if (!profile?._id) return null;

  return Subscription.findOne({
    profileId: profile._id,
    isCurrent: true,
    deleted: { $ne: true },
    subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
    ...(tenantId ? { tenantId } : {}),
  }).lean();
}

/**
 * After a member receipt: full clear if settled, else step back one reminder level if still in pipeline.
 * @returns {Promise<"cleared_all"|"stepped_back"|"none">}
 */
async function tryClearRemindersAfterMemberReceipt({ tenantId, memberId, asOf }, req) {
  const mid = String(memberId || "").trim();
  if (!mid || !tenantId) return "none";

  const wreq = req && req.headers ? req : createInternalWorkerReq(tenantId);
  const sub = await findCurrentSubscriptionByMemberId(mid, tenantId, wreq);
  if (!sub) return "none";

  const asOfDate = asOf ? new Date(asOf) : new Date();
  const items = await fetchReminderEligibilityBulk([mid], tenantId, asOfDate, wreq);
  const snap = items[0] || {};

  const full = await clearRemindersIfSettled(sub, snap, {
    asOf: asOfDate,
    clearedReason: CLEARED_REASON_PAYMENT,
  });
  if (full) return full;

  const partial = await stepBackRemindersIfPartialPayment(sub, snap, {
    asOf: asOfDate,
  });
  if (partial) return partial;

  return "none";
}

module.exports = {
  clearRemindersIfSettled,
  stepBackRemindersIfPartialPayment,
  findCurrentSubscriptionByMemberId,
  tryClearRemindersAfterMemberReceipt,
  CLEARED_REASON_PAYMENT,
  CLEARED_REASON_BUILD,
  CLEARED_REASON_PARTIAL_PAYMENT,
};
