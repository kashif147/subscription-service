const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");

/**
 * JSON-safe plain object for audit (dates ISO, ObjectIds string).
 * @param {import("mongoose").Document | object} doc
 */
function serializeSubscriptionForAudit(doc) {
  if (!doc) return null;
  const plain = doc.toObject
    ? doc.toObject({ flattenMaps: true })
    : { ...doc };
  try {
    return JSON.parse(JSON.stringify(plain));
  } catch {
    return plain;
  }
}

/**
 * Publish subscription field-level change for audit-service (members.subscription.changed.v1).
 */
async function publishSubscriptionChangedAudit({
  tenantId,
  subscriptionId,
  profileId,
  applicationId,
  actorUserId,
  actorEmail,
  changedFields,
  before,
  after,
  correlationId,
}) {
  if (!subscriptionId) {
    return { success: false, error: "missing_subscriptionId" };
  }

  return publisher.publish(
    MEMBERSHIP_EVENTS.SUBSCRIPTION_CHANGED,
    {
      tenantId: tenantId || undefined,
      subscriptionId,
      profileId: profileId || null,
      applicationId: applicationId || null,
      actorUserId: actorUserId || null,
      actorEmail: actorEmail || null,
      changedFields: Array.isArray(changedFields) ? changedFields : [],
      before: before || null,
      after: after || null,
    },
    {
      tenantId,
      correlationId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CHANGED,
      metadata: {
        service: "subscription-service",
        version: "1.0",
        purpose: "audit",
      },
    }
  );
}

module.exports = {
  serializeSubscriptionForAudit,
  publishSubscriptionChangedAudit,
};
