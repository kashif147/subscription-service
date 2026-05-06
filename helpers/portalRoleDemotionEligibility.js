/**
 * Used by cancellationGraceSweep for legacy rows that still have cancellation.gracePeriodEnd set.
 * New cancellations store gracePeriodEnd: null; portal Member→Non-Member uses a separate job.
 *
 * @param {import("mongoose").Document | object} subscription
 * @param {Date} [now]
 * @returns {boolean}
 */
function isCancelledSubscriptionEligibleForPortalDemotion(subscription, now = new Date()) {
  if (!subscription?.cancellation) return false;
  if (subscription.cancellation.reinstated === true) return false;
  const end = subscription.cancellation.gracePeriodEnd;
  if (!end || !(end instanceof Date) || Number.isNaN(end.getTime())) return false;
  if (end > now) return false;
  return true;
}

module.exports = { isCancelledSubscriptionEligibleForPortalDemotion };
