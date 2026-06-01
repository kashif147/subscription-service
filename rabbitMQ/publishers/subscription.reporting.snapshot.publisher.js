const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fullNameFromProfile(profile) {
  if (!profile) return null;
  const pi = profile.personalInfo || profile;
  if (pi.fullName) return String(pi.fullName).trim() || null;
  const parts = [pi.forename, pi.surname].filter(Boolean);
  return parts.length ? parts.join(" ").trim() : null;
}

/**
 * Denormalized snapshot for reporting-service warehouse (members.subscription.reporting.snapshot.v1).
 * @param {object} subscriptionDoc - mongoose doc or lean subscription
 * @param {object|null} profileLean - profile lean with personalInfo + professionalDetails
 * @param {object} [ctx]
 */
function buildReportingSnapshotPayload(subscriptionDoc, profileLean, ctx = {}) {
  const sub = subscriptionDoc.toObject
    ? subscriptionDoc.toObject({ flattenMaps: true })
    : subscriptionDoc;
  const prof = profileLean?.professionalDetails || profileLean || {};

  const membershipNumber =
    ctx.memberId ||
    profileLean?.membershipNumber ||
    null;

  return {
    tenantId: sub.tenantId || ctx.tenantId,
    subscriptionId: String(sub._id),
    profileId: String(sub.profileId?._id || sub.profileId),
    membershipNumber:
      membershipNumber != null ? String(membershipNumber).trim() : null,
    fullName: fullNameFromProfile(profileLean),
    membershipStatus: sub.subscriptionStatus,
    membershipMovement: sub.membershipMovement || null,
    startDate: toIsoDate(sub.startDate),
    expiryDate: toIsoDate(sub.endDate),
    cancelledAt: toIsoDate(sub.cancellation?.dateCancelled),
    resignedAt: toIsoDate(sub.resignation?.dateResigned),
    processedAt: toIsoDate(sub.yearend?.processedAt || ctx.processingDate),
    membershipCategory: sub.membershipCategory || null,
    grade: prof.grade || null,
    workLocation: prof.workLocation || null,
    branch: prof.branch || null,
    region: prof.region || null,
    section: prof.primarySection || null,
    paymentType: sub.paymentType || null,
    paymentFrequency: sub.paymentFrequency || null,
    subscriptionYear: sub.subscriptionYear ?? null,
    isCurrent: sub.isCurrent === true,
  };
}

async function publishSubscriptionReportingSnapshot(
  subscriptionDoc,
  profileLean,
  ctx = {}
) {
  const payload = buildReportingSnapshotPayload(
    subscriptionDoc,
    profileLean,
    ctx
  );
  if (!payload.tenantId || !payload.subscriptionId) {
    return { success: false, error: "missing_ids" };
  }

  return publisher.publish(
    MEMBERSHIP_EVENTS.SUBSCRIPTION_REPORTING_SNAPSHOT,
    payload,
    {
      tenantId: payload.tenantId,
      correlationId: ctx.correlationId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_REPORTING_SNAPSHOT,
      metadata: {
        service: "subscription-service",
        version: "1.0",
        purpose: "reporting",
      },
    }
  );
}

module.exports = {
  buildReportingSnapshotPayload,
  publishSubscriptionReportingSnapshot,
};
