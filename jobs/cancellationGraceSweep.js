const Subscription = require("../models/subscription.model");
const { MEMBERSHIP_STATUS } = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const { buildDemotionEventPayload } = require("../helpers/demotionEventPayload");

const INTERVAL_MS = parseInt(
  process.env.CANCELLATION_GRACE_SWEEP_MS || String(60 * 60 * 1000),
  10
);

let sweepTimer = null;

async function publishCancelGraceEnded(doc) {
  const identity = await buildDemotionEventPayload({
    profileId: doc.profileId,
    subscriptionUserId: doc.userId,
    tenantId: doc.tenantId,
    req: null,
  });

  return publisher.publish(
    MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCEL_GRACE_ENDED,
    {
      subscriptionId: doc._id.toString(),
      profileId: identity.profileId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      userEmail: identity.userEmail,
      reason: "cancel_grace_ended",
      gracePeriodEnd:
        doc.cancellation?.gracePeriodEnd instanceof Date
          ? doc.cancellation.gracePeriodEnd.toISOString()
          : doc.cancellation?.gracePeriodEnd,
    },
    {
      tenantId: doc.tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCEL_GRACE_ENDED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );
}

async function runCancellationGraceSweepOnce() {
  const now = new Date();
  const query = {
    subscriptionStatus: MEMBERSHIP_STATUS.CANCELLED,
    deleted: { $ne: true },
    "cancellation.gracePeriodEnd": { $lte: now },
    $or: [
      { "cancellation.portalRoleDemotionPublishedAt": null },
      { "cancellation.portalRoleDemotionPublishedAt": { $exists: false } },
    ],
  };

  const candidates = await Subscription.find(query).limit(100);
  let published = 0;

  for (const doc of candidates) {
    if (
      !doc.cancellation?.gracePeriodEnd ||
      doc.cancellation.gracePeriodEnd > new Date()
    ) {
      continue;
    }
    if (doc.cancellation.portalRoleDemotionPublishedAt) {
      continue;
    }

    try {
      const result = await publishCancelGraceEnded(doc);
      if (result.success) {
        doc.cancellation.portalRoleDemotionPublishedAt = new Date();
        await doc.save();
        published++;
        console.log(
          "✅ [CANCELLATION_GRACE_SWEEP] Published cancel grace ended:",
          doc._id.toString()
        );
      } else {
        console.error(
          "❌ [CANCELLATION_GRACE_SWEEP] Publish failed:",
          result.error,
          doc._id.toString()
        );
      }
    } catch (e) {
      console.error(
        "❌ [CANCELLATION_GRACE_SWEEP] Error:",
        e.message,
        doc._id?.toString?.()
      );
    }
  }

  if (published > 0) {
    console.log(
      `[CANCELLATION_GRACE_SWEEP] Processed batch: ${published} event(s) published`
    );
  }
}

function startCancellationGraceSweep() {
  if (sweepTimer) {
    return;
  }
  if (!process.env.RABBIT_URL || !process.env.RABBIT_URL.trim()) {
    console.warn(
      "⚠️ [CANCELLATION_GRACE_SWEEP] RABBIT_URL not set; sweep not started"
    );
    return;
  }

  console.log(
    `🕐 [CANCELLATION_GRACE_SWEEP] Starting interval every ${INTERVAL_MS}ms`
  );
  sweepTimer = setInterval(() => {
    runCancellationGraceSweepOnce().catch((err) =>
      console.error("[CANCELLATION_GRACE_SWEEP] Interval error:", err.message)
    );
  }, INTERVAL_MS);

  setTimeout(() => {
    runCancellationGraceSweepOnce().catch((err) =>
      console.error("[CANCELLATION_GRACE_SWEEP] Initial run error:", err.message)
    );
  }, 15000);
}

function stopCancellationGraceSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  startCancellationGraceSweep,
  stopCancellationGraceSweep,
  runCancellationGraceSweepOnce,
};
