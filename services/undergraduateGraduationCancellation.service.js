const { randomUUID } = require("crypto");
const Subscription = require("../models/subscription.model");
const { MEMBERSHIP_STATUS, CANCELLATION_SOURCE } = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const {
  fetchProfilesByIds,
  createInternalWorkerReq,
} = require("../helpers/serviceClient");
const { buildDemotionEventPayload } = require("../helpers/demotionEventPayload");
const {
  serializeSubscriptionForAudit,
  publishSubscriptionChangedAudit,
} = require("../rabbitMQ/publishers/subscription.changed.audit.publisher.js");
const {
  publishSubscriptionCurrentUpdated,
} = require("../rabbitMQ/publishers/subscription.current.updated.publisher.js");

const NOTIFICATION_TITLE =
  "Congratulations on Your Graduation";
const NOTIFICATION_BODY =
  "Congratulations on reaching your graduation date. Your Undergraduate Student membership has now ended. We invite you to join as a full member and continue enjoying the benefits of membership.";

const UGRAD_GRADUATION_COMMS_TITLE = NOTIFICATION_TITLE;
const UGRAD_GRADUATION_COMMS_BODY = NOTIFICATION_BODY;

/** UTC start of calendar day for `d` */
function utcDayStartMs(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return Date.UTC(
    x.getUTCFullYear(),
    x.getUTCMonth(),
    x.getUTCDate(),
    0,
    0,
    0,
    0
  );
}

function normalizeCategoryLabel(c) {
  if (c == null || c === "") return "";
  return String(c).trim().toLowerCase().replace(/\s+/g, " ");
}

function matchesUndergraduateCategory(raw, fromLabel) {
  const norm = normalizeCategoryLabel(raw);
  const fromNorm = normalizeCategoryLabel(fromLabel);
  return norm === fromNorm || norm === "undergraduate student";
}

function isSkippedTerminalStatus(status) {
  if (!status) return true;
  const s = String(status).trim();
  return (
    s === MEMBERSHIP_STATUS.CANCELLED ||
    s === MEMBERSHIP_STATUS.RESIGNED ||
    s === MEMBERSHIP_STATUS.SUSPENDED ||
    s === MEMBERSHIP_STATUS.ARCHIVED ||
    s === MEMBERSHIP_STATUS.LAPSED
  );
}

/**
 * @param {Date|string|null|undefined} graduationDate
 * @param {number} todayStartMs UTC midnight of "today"
 */
function graduationEligibleForRun(graduationDate, todayStartMs) {
  if (graduationDate == null) return false;
  const g = graduationDate instanceof Date ? graduationDate : new Date(graduationDate);
  if (Number.isNaN(g.getTime())) return false;
  const gStart = utcDayStartMs(g);
  if (gStart == null) return false;
  return gStart <= todayStartMs;
}

function utcTodayNoon(asOf) {
  const t = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(
    Date.UTC(
      t.getUTCFullYear(),
      t.getUTCMonth(),
      t.getUTCDate(),
      12,
      0,
      0,
      0
    )
  );
}

function readEnvConfig() {
  const fromCategory =
    process.env.UGRAD_GRADUATION_FROM_CATEGORY ||
    process.env.FROM_CATEGORY ||
    "Undergraduate Student";
  const cancellationReason =
    process.env.UGRAD_GRADUATION_CANCELLATION_REASON ||
    process.env.CANCELLATION_REASON ||
    "Graduated";
  const dryRun =
    String(
      process.env.UGRAD_GRADUATION_DRY_RUN ||
        process.env.DRY_RUN ||
        ""
    ).toLowerCase() === "true";
  return { fromCategory, cancellationReason, dryRun };
}

function logStructured(payload) {
  console.log(
    JSON.stringify({ job: "undergraduate_graduation_cancellation", ...payload })
  );
}

/**
 * @param {object} options
 * @param {Date} [options.asOf]
 * @param {boolean} [options.dryRun]
 * @param {string} [options.fromCategory]
 * @param {string} [options.cancellationReason]
 */
async function runUndergraduateGraduationCancellationOnce(options = {}) {
  const env = readEnvConfig();
  const fromCategory = options.fromCategory ?? env.fromCategory;
  const cancellationReason = options.cancellationReason ?? env.cancellationReason;
  const dryRun = options.dryRun ?? env.dryRun;
  const now = options.asOf instanceof Date ? options.asOf : new Date();
  const todayStart = utcDayStartMs(now);
  if (todayStart == null) {
    logStructured({ phase: "error", message: "invalid_asOf_date" });
    return { eligible: 0, cancelled: 0, skipped: 0, notified: 0, errors: 1 };
  }

  const cancelledAt = utcTodayNoon(now);
  if (!cancelledAt) {
    logStructured({ phase: "error", message: "could_not_compute_cancelled_at" });
    return { eligible: 0, cancelled: 0, skipped: 0, notified: 0, errors: 1 };
  }

  logStructured({
    phase: "started",
    asOf: now.toISOString(),
    dryRun,
    fromCategory,
  });

  const baseQuery = {
    isCurrent: true,
    deleted: { $ne: true },
    subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
  };

  const leanList = await Subscription.find(baseQuery)
    .select(
      "_id tenantId profileId userId applicationId membershipCategory subscriptionStatus isCurrent"
    )
    .lean();

  const candidates = leanList.filter((s) =>
    matchesUndergraduateCategory(s.membershipCategory, fromCategory)
  );

  logStructured({
    phase: "candidates_loaded",
    activeCurrentCount: leanList.length,
    undergraduateActiveCount: candidates.length,
  });

  let eligible = 0;
  let cancelled = 0;
  let skipped = 0;
  let notified = 0;
  let errors = 0;

  const CHUNK = 40;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const byTenant = new Map();
    for (const lean of chunk) {
      const tid =
        lean.tenantId != null && String(lean.tenantId).trim()
          ? String(lean.tenantId)
          : "default";
      if (!byTenant.has(tid)) byTenant.set(tid, []);
      byTenant.get(tid).push(lean);
    }

    const profileById = new Map();
    for (const [tenantId, subsInTenant] of byTenant) {
      const req = createInternalWorkerReq(tenantId, {
        email: "system@undergraduate-graduation-job",
      });
      const profileIds = [
        ...new Set(
          subsInTenant.map((c) => c.profileId?.toString()).filter(Boolean)
        ),
      ];
      let profiles = [];
      try {
        profiles = await fetchProfilesByIds(profileIds, tenantId, req, {
          relaxTenant: true,
        });
      } catch (e) {
        logStructured({
          phase: "error",
          message: "profile_batch_fetch_failed",
          error: e.message,
          tenantId,
        });
        errors += 1;
        continue;
      }
      for (const p of profiles || []) {
        profileById.set(String(p._id), p);
      }
    }

    for (const lean of chunk) {
      const tenantId =
        lean.tenantId != null && String(lean.tenantId).trim()
          ? String(lean.tenantId)
          : "default";
      const req = createInternalWorkerReq(tenantId, {
        email: "system@undergraduate-graduation-job",
      });

      const profileIdStr = lean.profileId?.toString();
      const profile = profileIdStr ? profileById.get(profileIdStr) : null;
      if (!profile) {
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "profile_not_found",
          subscriptionId: lean._id?.toString(),
          profileId: profileIdStr,
        });
        continue;
      }

      const graduationDate = profile.professionalDetails?.graduationDate;
      if (!graduationEligibleForRun(graduationDate, todayStart)) {
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "graduation_date_not_eligible",
          subscriptionId: lean._id?.toString(),
          profileId: profileIdStr,
          graduationDate:
            graduationDate != null ? new Date(graduationDate).toISOString() : null,
        });
        continue;
      }

      const doc = await Subscription.findById(lean._id);
      if (!doc) {
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "subscription_missing_on_refetch",
          subscriptionId: lean._id?.toString(),
        });
        continue;
      }

      if (!matchesUndergraduateCategory(doc.membershipCategory, fromCategory)) {
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "category_changed",
          subscriptionId: doc._id.toString(),
        });
        continue;
      }

      if (
        !doc.isCurrent ||
        doc.deleted === true ||
        isSkippedTerminalStatus(doc.subscriptionStatus)
      ) {
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "subscription_not_active_current",
          subscriptionId: doc._id.toString(),
          subscriptionStatus: doc.subscriptionStatus,
        });
        continue;
      }

      const gCheck = profile.professionalDetails?.graduationDate;
      if (!graduationEligibleForRun(gCheck, todayStart)) {
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "graduation_date_changed_ineligible",
          subscriptionId: doc._id.toString(),
        });
        continue;
      }

      eligible += 1;

      const beforePlain = serializeSubscriptionForAudit(doc);
      const correlationId = randomUUID();

      if (dryRun) {
        logStructured({
          phase: "dry_run_would_cancel",
          subscriptionId: doc._id.toString(),
          profileId: doc.profileId?.toString(),
        });
        continue;
      }

      const cancelFilter = {
        _id: doc._id,
        isCurrent: true,
        deleted: { $ne: true },
        subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
      };

      const cancelSet = {
        cancellation: {
          source: CANCELLATION_SOURCE.SYSTEM,
          dateCancelled: cancelledAt,
          reason: String(cancellationReason).trim(),
          gracePeriodEnd: null,
          reinstated: false,
          portalRoleDemotionPublishedAt: null,
        },
        isCurrent: false,
        subscriptionStatus: MEMBERSHIP_STATUS.CANCELLED,
      };

      const updated = await Subscription.findOneAndUpdate(cancelFilter, {
        $set: cancelSet,
      }, { new: true });

      if (!updated) {
        eligible -= 1;
        skipped += 1;
        logStructured({
          phase: "skipped",
          reason: "atomic_cancel_no_match",
          subscriptionId: doc._id.toString(),
        });
        continue;
      }

      cancelled += 1;
      logStructured({
        phase: "subscription_cancelled",
        subscriptionId: updated._id.toString(),
        profileId: updated.profileId?.toString(),
        reason: cancellationReason,
      });

      try {
        const publishResult = await publisher.publish(
          MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLED,
          {
            subscriptionId: updated._id.toString(),
            profileId: updated.profileId.toString(),
            tenantId: updated.tenantId || tenantId,
            applicationId: updated.applicationId || null,
            actorUserId: null,
            actorEmail: "system@undergraduate-graduation-job",
          },
          {
            tenantId: updated.tenantId || tenantId,
            exchange: "membership.events",
            routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLED,
            metadata: {
              service: "subscription-service",
              version: "1.0",
              job: "undergraduateGraduationCancellation",
            },
          }
        );
        if (!publishResult.success) {
          logStructured({
            phase: "error",
            message: "publish_subscription_cancelled_failed",
            subscriptionId: updated._id.toString(),
            error: publishResult.error,
          });
          errors += 1;
        }
      } catch (e) {
        logStructured({
          phase: "error",
          message: "publish_subscription_cancelled_exception",
          subscriptionId: updated._id.toString(),
          error: e.message,
        });
        errors += 1;
      }

      let memberId = null;
      try {
        memberId = profile.membershipNumber
          ? String(profile.membershipNumber).trim()
          : null;
      } catch {
        memberId = null;
      }

      try {
        await publishSubscriptionCurrentUpdated(updated, {
          tenantId: updated.tenantId || tenantId,
          memberId: memberId || null,
          membershipCategory: updated.membershipCategory,
          userId: updated.userId || null,
          correlationId: `ugrad-grad-${correlationId}`,
        });
      } catch (e) {
        logStructured({
          phase: "error",
          message: "publish_subscription_current_updated_failed",
          subscriptionId: updated._id.toString(),
          error: e.message,
        });
      }

      try {
        await publishSubscriptionChangedAudit({
          tenantId: updated.tenantId || tenantId,
          subscriptionId: updated._id.toString(),
          profileId: updated.profileId.toString(),
          applicationId: updated.applicationId || null,
          actorUserId: null,
          actorEmail: "system@undergraduate-graduation-job",
          changedFields: ["subscriptionStatus", "isCurrent", "cancellation"],
          before: beforePlain,
          after: serializeSubscriptionForAudit(updated),
          correlationId,
        });
      } catch (e) {
        logStructured({
          phase: "error",
          message: "publish_subscription_changed_audit_failed",
          subscriptionId: updated._id.toString(),
          error: e.message,
        });
      }

      try {
        const identity = await buildDemotionEventPayload({
          profileId: updated.profileId,
          subscriptionUserId: updated.userId,
          tenantId: updated.tenantId || tenantId,
          req,
        });

        if (identity.userId || identity.userEmail) {
          const demotionResult = await publisher.publish(
            MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCEL_GRACE_ENDED,
            {
              subscriptionId: updated._id.toString(),
              profileId: identity.profileId,
              tenantId: identity.tenantId,
              userId: identity.userId,
              userEmail: identity.userEmail,
              reason: "graduated",
              gracePeriodEnd: cancelledAt.toISOString(),
            },
            {
              tenantId: identity.tenantId || updated.tenantId || tenantId,
              correlationId: `ugrad-grad-demotion-${correlationId}`,
              exchange: "membership.events",
              routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCEL_GRACE_ENDED,
              metadata: {
                service: "subscription-service",
                version: "1.0",
                job: "undergraduateGraduationCancellation",
              },
            }
          );

          if (demotionResult.success) {
            await Subscription.updateOne(
              { _id: updated._id },
              { $set: { "cancellation.portalRoleDemotionPublishedAt": new Date() } }
            );
            logStructured({
              phase: "portal_demotion_enqueued",
              subscriptionId: updated._id.toString(),
              profileId: updated.profileId?.toString(),
              userId: identity.userId || null,
            });
          } else {
            logStructured({
              phase: "error",
              message: "publish_portal_demotion_failed",
              subscriptionId: updated._id.toString(),
              error: demotionResult.error,
            });
            errors += 1;
          }
        } else {
          logStructured({
            phase: "skipped",
            reason: "demotion_no_user_or_email",
            subscriptionId: updated._id.toString(),
            profileId: updated.profileId?.toString(),
          });
        }

        const dedupeKey = `ugrad-grad:${updated._id.toString()}`;
        const commsPayload = {
          tenantId: updated.tenantId || tenantId,
          userId: identity.userId || null,
          profileId: updated.profileId.toString(),
          subscriptionId: updated._id.toString(),
          memberId: memberId || null,
          membershipCategory: updated.membershipCategory || fromCategory,
          graduationDate:
            profile.professionalDetails?.graduationDate != null
              ? new Date(profile.professionalDetails.graduationDate).toISOString()
              : null,
          cancelledAt: cancelledAt.toISOString(),
          title: UGRAD_GRADUATION_COMMS_TITLE,
          body: UGRAD_GRADUATION_COMMS_BODY,
          dedupeKey,
        };

        const commsResult = await publisher.publish(
          MEMBERSHIP_EVENTS.UNDERGRADUATE_GRADUATION_COMMS_REQUESTED,
          commsPayload,
          {
            tenantId: updated.tenantId || tenantId,
            correlationId: `ugrad-grad-comms-${correlationId}`,
            exchange: "membership.events",
            routingKey: MEMBERSHIP_EVENTS.UNDERGRADUATE_GRADUATION_COMMS_REQUESTED,
            metadata: {
              service: "subscription-service",
              version: "1.0",
              job: "undergraduateGraduationCancellation",
            },
          }
        );

        if (commsResult.success) {
          notified += 1;
          logStructured({
            phase: "graduation_comms_enqueued",
            subscriptionId: updated._id.toString(),
            profileId: updated.profileId?.toString(),
            hasUserId: Boolean(identity.userId),
          });
        } else {
          logStructured({
            phase: "error",
            message: "publish_graduation_comms_failed",
            subscriptionId: updated._id.toString(),
            error: commsResult.error,
          });
          errors += 1;
        }
      } catch (e) {
        logStructured({
          phase: "error",
          message: "graduation_comms_publish_exception",
          subscriptionId: updated._id.toString(),
          error: e.message,
        });
        errors += 1;
      }
    }
  }

  logStructured({
    phase: "eligible_members_found",
    count: eligible,
    dryRun,
  });

  logStructured({
    phase: "completed",
    eligible,
    cancelled,
    skipped,
    notified,
    errors,
    dryRun,
  });

  return { eligible, cancelled, skipped, notified, errors, dryRun };
}

module.exports = {
  runUndergraduateGraduationCancellationOnce,
  utcDayStartMs,
  graduationEligibleForRun,
  matchesUndergraduateCategory,
  isSkippedTerminalStatus,
  readEnvConfig,
  NOTIFICATION_TITLE,
  NOTIFICATION_BODY,
};
