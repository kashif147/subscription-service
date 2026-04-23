/**
 * Nightly portal / Member-role demotion after cancellation.
 * Product-defined rules (e.g. "still unpaid", exact calendar window) plug in here later.
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
