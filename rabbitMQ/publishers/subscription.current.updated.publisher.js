const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");

/**
 * Publishes members.subscription.current.updated.v1 (profile-service syncs Profile.currentSubscriptionId).
 * @param {object} subscriptionDoc - Mongoose doc or lean object with _id, profileId, startDate
 * @param {object} [ctx] - optional overrides from the triggering event / request
 */
async function publishSubscriptionCurrentUpdated(subscriptionDoc, ctx = {}) {
  const profileIdObjectId = subscriptionDoc.profileId;
  if (!profileIdObjectId || !subscriptionDoc._id) {
    console.warn(
      "[publishSubscriptionCurrentUpdated] missing profileId or _id; skip publish"
    );
    return { success: false, error: "missing_ids" };
  }

  const subscriptionAppId =
    ctx.applicationId ?? subscriptionDoc.applicationId ?? null;
  const subscriptionMemberId = ctx.memberId ?? null;
  const membershipCategory =
    ctx.membershipCategory ?? subscriptionDoc.membershipCategory ?? null;
  const startSource = ctx.startDate ?? subscriptionDoc.startDate;
  const startDate =
    startSource instanceof Date ? startSource : new Date(startSource);
  if (Number.isNaN(startDate.getTime())) {
    console.warn(
      "[publishSubscriptionCurrentUpdated] invalid startDate; skip publish"
    );
    return { success: false, error: "invalid_start_date" };
  }
  const startDateISO = startDate.toISOString().split("T")[0];
  const userId =
    ctx.userId !== undefined ? ctx.userId : subscriptionDoc.userId ?? null;
  const tenantId = ctx.tenantId ?? subscriptionDoc.tenantId;

  let processingDateISO;
  if (ctx.processingDate != null && ctx.processingDate !== "") {
    const pd =
      ctx.processingDate instanceof Date
        ? ctx.processingDate
        : new Date(ctx.processingDate);
    if (!Number.isNaN(pd.getTime())) {
      processingDateISO = pd.toISOString().split("T")[0];
    }
  }

  const subscriptionAttributes = { startDate: startDateISO };
  if (processingDateISO) {
    subscriptionAttributes.processingDate = processingDateISO;
  }

  const eventPayload = {
    subscriptionId: subscriptionDoc._id.toString(),
    profileId: profileIdObjectId.toString(),
    applicationId: subscriptionAppId,
    memberId: subscriptionMemberId,
    userId: userId || null,
    tenantId: tenantId || undefined,
    effective: {
      subscriptionDetails: {
        membershipCategory: membershipCategory || null,
        dateJoined: startDateISO,
      },
      professionalDetails: {
        membershipCategory: membershipCategory || null,
      },
    },
    subscriptionAttributes,
  };
  if (ctx.renewalBatchId != null && ctx.renewalBatchId !== "") {
    eventPayload.renewalBatchId =
      typeof ctx.renewalBatchId.toString === "function"
        ? ctx.renewalBatchId.toString()
        : String(ctx.renewalBatchId);
  }

  const publishResult = await publisher.publish(
    MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
    eventPayload,
    {
      tenantId,
      correlationId: ctx.correlationId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );

  if (publishResult.success) {
    console.log("✅ Subscription current updated event published:", {
      eventId: publishResult.eventId,
      subscriptionId: subscriptionDoc._id.toString(),
      profileId: profileIdObjectId.toString(),
    });
  } else {
    console.error("❌ Failed to publish subscription current updated event:", {
      error: publishResult.error,
      subscriptionId: subscriptionDoc._id.toString(),
    });
  }
  return publishResult;
}

module.exports = { publishSubscriptionCurrentUpdated };
