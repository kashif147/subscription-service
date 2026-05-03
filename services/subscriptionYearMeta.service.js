const Subscription = require("../models/subscription.model");

async function fetchDistinctYearsFromDb(tenantId) {
  const query = { deleted: { $ne: true } };
  if (tenantId) query.tenantId = tenantId;

  const raw = await Subscription.distinct("subscriptionYear", query);
  const nums = raw
    .map((y) => parseInt(String(y), 10))
    .filter((n) => !Number.isNaN(n));

  return [...new Set(nums)].sort((a, b) => b - a);
}

/**
 * Distinct subscription years for the tenant (no caching — reads Mongo each call).
 */
async function getSubscriptionYearsForTenant(tenantId) {
  if (!tenantId) return [];
  return fetchDistinctYearsFromDb(tenantId);
}

module.exports = {
  getSubscriptionYearsForTenant,
  fetchDistinctYearsFromDb,
};
