const { fetchProfilesByIds, createInternalWorkerReq } = require("./serviceClient");
const {
  publishSubscriptionReportingSnapshot,
} = require("../rabbitMQ/publishers/subscription.reporting.snapshot.publisher.js");

/**
 * Publish reporting warehouse snapshot for a subscription row.
 * @param {object} subscriptionDoc
 * @param {object} [options] - { tenantId, correlationId, memberId, req, processingDate }
 */
async function publishReportingSnapshotForSubscription(
  subscriptionDoc,
  options = {}
) {
  if (!subscriptionDoc?.profileId) return { success: false };

  const tenantId = options.tenantId || subscriptionDoc.tenantId;
  const req =
    options.req || createInternalWorkerReq(tenantId);

  let profileLean = options.profileLean || null;
  if (!profileLean) {
    try {
      const profiles = await fetchProfilesByIds(
        [subscriptionDoc.profileId],
        tenantId,
        req
      );
      profileLean = profiles[0] || null;
    } catch (err) {
      console.warn(
        "[reportingSnapshot] profile fetch failed:",
        err.message
      );
    }
  }

  return publishSubscriptionReportingSnapshot(subscriptionDoc, profileLean, {
    tenantId,
    correlationId: options.correlationId,
    memberId: options.memberId,
    processingDate: options.processingDate,
    renewalBatchId: options.renewalBatchId,
    yearEndFiscalYear: options.yearEndFiscalYear,
    yearEndAction: options.yearEndAction,
    previousMembershipStatus: options.previousMembershipStatus,
    newMembershipStatus: options.newMembershipStatus,
    snapshotAsOfDate: options.snapshotAsOfDate,
  });
}

module.exports = { publishReportingSnapshotForSubscription };
