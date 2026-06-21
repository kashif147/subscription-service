const { MEMBERSHIP_EVENTS } = require("../events");
const { consumer } = require("@projectShell/rabbitmq-middleware");
const {
  publishSubscriptionCurrentUpdated,
} = require("../publishers/subscription.current.updated.publisher.js");
const {
  publishReportingSnapshotForSubscription,
} = require("../../helpers/reportingSnapshotPublish.js");
const {
  fetchProfilesByIds,
  createInternalWorkerReq,
} = require("../../helpers/serviceClient");
const Subscription = require("../../models/subscription.model");
const mongoose = require("mongoose");
const {
  MEMBERSHIP_STATUS,
  MEMBERSHIP_MOVEMENT,
  PAYMENT_TYPE,
  PAYMENT_FREQUENCY,
} = require("../../constants/enums");
const {
  resolveNoFeePaymentFields,
} = require("../../helpers/noFeeMembershipPayment.helper.js");

/**
 * Membership lines that are not active — merge/approval onto an existing profile
 * (resigned, cancelled, suspended, archived, lapsed, etc.) must create a new subscription.
 */
const NON_LIVE_SUBSCRIPTION_STATUSES = new Set([
  MEMBERSHIP_STATUS.RESIGNED,
  MEMBERSHIP_STATUS.CANCELLED,
  MEMBERSHIP_STATUS.SUSPENDED,
  MEMBERSHIP_STATUS.ARCHIVED,
  MEMBERSHIP_STATUS.LAPSED,
]);

function isLiveCurrentSubscription(sub) {
  if (!sub || sub.deleted === true) return false;
  if (sub.isCurrent !== true) return false;
  if (NON_LIVE_SUBSCRIPTION_STATUSES.has(sub.subscriptionStatus)) return false;
  return (
    sub.subscriptionStatus === MEMBERSHIP_STATUS.ACTIVE ||
    sub.subscriptionStatus === MEMBERSHIP_STATUS.RENEWED
  );
}

function endOfYear(date) {
  const y = date.getUTCFullYear();
  return new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
}

function startOfNextYear(date) {
  const y = date.getUTCFullYear();
  return new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0));
}

function utcStartOfDayMs(d) {
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

/** Subscription row covers today if its endDate is still on or after today's UTC calendar date. */
function subscriptionPeriodStillOpen(endDate) {
  if (!endDate) return true;
  const endMs = new Date(endDate).getTime();
  if (Number.isNaN(endMs)) return true;
  const todayStart = utcStartOfDayMs(new Date());
  return todayStart != null && endMs >= todayStart;
}

function parseDateOnlyAsUtcNoon(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        12,
        0,
        0,
        0
      )
    );
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const dmyMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0));
  }
  const datePart = raw.split("T")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const [year, month, day] = datePart.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(
    Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate(),
      12,
      0,
      0,
      0
    )
  );
}

async function resolveMemberIdForPublish(profileIdObjectId, memberId, tenantId) {
  if (memberId != null && String(memberId).trim() !== "") {
    return String(memberId).trim();
  }
  const profiles = await fetchProfilesByIds(
    [profileIdObjectId],
    tenantId,
    createInternalWorkerReq(tenantId)
  );
  const num = profiles[0]?.membershipNumber;
  return num != null && String(num).trim() !== "" ? String(num).trim() : null;
}

async function publishSubscriptionCurrentUpdatedEvent({
  newSub,
  profileIdObjectId,
  applicationId,
  memberId,
  membershipCategory,
  startDate,
  userId,
  userEmail,
  tenantId,
  payload,
  processingDate,
  submissionDate,
  applicationDate,
}) {
  const resolvedMemberId = await resolveMemberIdForPublish(
    profileIdObjectId,
    memberId,
    tenantId
  );
  if (!resolvedMemberId) {
    console.warn(
      "[SUBSCRIPTION_UPSERT_LISTENER] subscription.current.updated skipped — no membershipNumber on profile",
      { profileId: profileIdObjectId?.toString?.() }
    );
    return { success: false, error: "missing_membership_number" };
  }
  return publishSubscriptionCurrentUpdated(newSub, {
    applicationId,
    memberId: resolvedMemberId,
    membershipCategory,
    startDate,
    userId,
    userEmail,
    tenantId,
    correlationId: payload?.correlationId,
    processingDate,
    submissionDate,
    applicationDate,
  });
}

async function fetchProfileWithRetry(profileIds, tenantId, req, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const profiles = await fetchProfilesByIds(profileIds, tenantId, req);
    if (profiles[0]) return profiles[0];
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return null;
}

/** Profile's current membership row (by currentSubscriptionId, else isCurrent). */
async function resolveProfileCurrentSubscriptionDoc(
  profileIdObjectId,
  tenantId
) {
  const profileLean = await fetchProfileWithRetry(
    [profileIdObjectId],
    tenantId,
    createInternalWorkerReq(tenantId)
  );
  if (!profileLean) return null;

  const currentSubId = profileLean.currentSubscriptionId;
  if (currentSubId != null && String(currentSubId).trim() !== "") {
    const byId = await Subscription.findOne({
      _id: currentSubId,
      profileId: profileIdObjectId,
      deleted: { $ne: true },
    }).lean();
    if (byId) return byId;
  }

  return Subscription.findOne({
    profileId: profileIdObjectId,
    isCurrent: true,
    deleted: { $ne: true },
  })
    .sort({ startDate: -1, createdAt: -1 })
    .lean();
}

async function findLiveSubscriptionForApplication(
  profileIdObjectId,
  applicationId,
  tenantId
) {
  const baseQuery = {
    profileId: profileIdObjectId,
    applicationId,
    deleted: { $ne: true },
    isCurrent: true,
    subscriptionStatus: {
      $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.RENEWED],
    },
  };

  if (tenantId) {
    const withTenant = await Subscription.findOne({
      ...baseQuery,
      tenantId,
    }).lean();
    if (withTenant) return withTenant;
  }

  return Subscription.findOne(baseQuery).lean();
}

async function handleSubscriptionUpsertRequested(payload, context) {
  console.log(
    "🚀 [SUBSCRIPTION_UPSERT_LISTENER] ===== EVENT RECEIVED ====="
  );
  const exchange = context?.exchange || context?.message?.fields?.exchange || "unknown";
  const routingKey = context?.routingKey || context?.message?.fields?.routingKey || "unknown";
  console.log("📥 [SUBSCRIPTION_UPSERT_LISTENER] Received subscription upsert requested event:");
  console.log("   Exchange:", exchange);
  console.log("   Routing Key:", routingKey);
  console.log("   Full payload:", JSON.stringify(payload, null, 2));
  console.log("   Context:", context ? JSON.stringify(context, null, 2) : "null");
  
  try {
    console.log(
      "📥 [SUBSCRIPTION_UPSERT_LISTENER] Processing event:",
      {
        eventId: payload?.eventId,
        correlationId: payload?.correlationId,
        tenantId: payload?.tenantId,
        hasData: !!payload?.data,
        dataKeys: payload?.data ? Object.keys(payload.data) : [],
      }
    );

    const { data = {}, tenantId } = payload || {};
    const {
      profileId,
      applicationId = null,
      memberId = null,
      membershipCategory = null,
      dateJoined,
      processingDate = null,
      submissionDate = null,
      applicationDate = null,
      paymentType = null,
      payrollNo = null,
      paymentFrequency = null,
      userId = null,
      userEmail = null,
      isCurrent: payloadIsCurrent = undefined,
      deactivatePreviousSubscriptionStatus = null,
    } = data || {};

    const resolvedPayment = resolveNoFeePaymentFields({
      membershipCategory,
      paymentType,
      paymentFrequency,
    });
    const effectivePaymentType = resolvedPayment.paymentType;
    const effectivePaymentFrequency = resolvedPayment.paymentFrequency;

    const resolvedUserId =
      userId != null && String(userId).trim() !== ""
        ? String(userId).trim()
        : null;

    // Validate required fields
    if (!profileId) {
      console.error("❌ [SUBSCRIPTION_UPSERT_LISTENER] profileId is required but missing");
      throw new Error("profileId is required");
    }
    
    // Handle dateJoined as a date-only value to avoid timezone day-shift.
    let startDate = parseDateOnlyAsUtcNoon(dateJoined);
    if (!startDate) {
      console.warn(
        "⚠️ [SUBSCRIPTION_UPSERT_LISTENER] dateJoined is missing, using current date"
      );
      const now = new Date();
      startDate = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          12,
          0,
          0,
          0
        )
      );
    }
    
    if (!tenantId) {
      console.warn(
        "⚠️ [SUBSCRIPTION_UPSERT_LISTENER] tenantId is missing in payload"
      );
    }

    // Convert profileId to ObjectId if it's a string
    const profileIdObjectId = mongoose.Types.ObjectId.isValid(profileId)
      ? typeof profileId === "string"
        ? new mongoose.Types.ObjectId(profileId)
        : profileId
      : null;

    if (!profileIdObjectId) {
      console.error(`❌ [SUBSCRIPTION_UPSERT_LISTENER] Invalid profileId format: ${profileId}`);
      throw new Error(`Invalid profileId format: ${profileId}`);
    }

    const subscriptionYear = startDate.getUTCFullYear();
    const endDate = endOfYear(startDate);
    const rolloverDate = startOfNextYear(startDate);

    console.log("📋 [SUBSCRIPTION_UPSERT_LISTENER] Processing subscription:", {
      profileId: profileIdObjectId.toString(),
      subscriptionYear,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      tenantId,
    });

    // All subscription rows for this profile (ignore tenantId) — avoids misclassified movement when legacy docs lack tenantId.
    const existingSubs = await Subscription.find({
      profileId: profileIdObjectId,
    })
      .sort({
        startDate: -1,
      })
      .lean();
    let membershipMovement = MEMBERSHIP_MOVEMENT.NEW_JOIN;
    if (existingSubs.length > 0) {
      const hasCurrentYear = existingSubs.some(
        (s) =>
          s.startDate &&
          new Date(s.startDate).getUTCFullYear() === subscriptionYear
      );
      if (hasCurrentYear) {
        membershipMovement = MEMBERSHIP_MOVEMENT.REJOIN;
      } else {
        membershipMovement = MEMBERSHIP_MOVEMENT.REINSTATE;
      }
    }

    // Demote every current row for this profile (do not filter by tenantId).
    // Legacy rows may have tenantId null/mismatched; scoping tenant here left multiple isCurrent=true.

    // Idempotent payment-only path: same profile + same applicationId as an existing **live** row
    // (isCurrent + Active or Renewed). Resigned/cancelled/suspended/archived/lapsed rows stay as history;
    // approval creates a new subscription for returning members.
    const normalizedAppId =
      applicationId != null && String(applicationId).trim() !== ""
        ? String(applicationId).trim()
        : null;

    const profileCurrentSub = await resolveProfileCurrentSubscriptionDoc(
      profileIdObjectId,
      tenantId
    );
    const profileHasLiveMembership =
      isLiveCurrentSubscription(profileCurrentSub);

    if (normalizedAppId) {
      const existingForApp = await findLiveSubscriptionForApplication(
        profileIdObjectId,
        normalizedAppId,
        tenantId
      );

      // Payment-only retry: profile already has live membership AND this application
      // already has a live current row. Returning members (resigned/cancelled/suspended/
      // archived/lapsed) always get a new subscription even if a stale Active row exists.
      if (existingForApp && profileHasLiveMembership) {
        console.log(
          "ℹ️ [SUBSCRIPTION_UPSERT_LISTENER] Live current subscription already exists for this applicationId — payment fields only:",
          {
            subscriptionId: existingForApp._id,
            applicationId: normalizedAppId,
            subscriptionYear,
            subscriptionStatus: existingForApp.subscriptionStatus,
          }
        );
        const update = {};
        if (
          effectivePaymentType != null &&
          Object.values(PAYMENT_TYPE).includes(effectivePaymentType)
        ) {
          update.paymentType = effectivePaymentType;
        }
        if (
          effectivePaymentFrequency != null &&
          Object.values(PAYMENT_FREQUENCY).includes(effectivePaymentFrequency)
        ) {
          update.paymentFrequency = effectivePaymentFrequency;
        }
        if (payrollNo != null) {
          update.payrollNo = payrollNo;
        }
        if (resolvedUserId) {
          update.userId = resolvedUserId;
        }
        if (Object.keys(update).length > 0) {
          await Subscription.updateOne(
            { _id: existingForApp._id },
            { $set: update }
          );
          console.log(
            "✅ [SUBSCRIPTION_UPSERT_LISTENER] Subscription payment fields updated successfully"
          );
        }
        // Re-fetch so publish uses latest userId if we just set it
        const existingForPublish = await Subscription.findById(
          existingForApp._id
        ).lean();
        const subForEvent = existingForPublish || existingForApp;
        // Re-publish current.updated only when this row is still current (avoid syncing resigned history).
        if (subForEvent.isCurrent) {
          // Downstream (profile currentSubscriptionId, account invoicing) when event was missed or retried.
          await publishSubscriptionCurrentUpdatedEvent({
            newSub: subForEvent,
            profileIdObjectId: subForEvent.profileId,
            applicationId: normalizedAppId || subForEvent.applicationId,
            memberId,
            membershipCategory:
              membershipCategory ?? subForEvent.membershipCategory,
            startDate: subForEvent.startDate,
            userId: resolvedUserId || subForEvent.userId || null,
            userEmail,
            tenantId,
            payload,
            processingDate,
            submissionDate,
            applicationDate,
          });
        }

        try {
          const profileLean = await fetchProfileWithRetry(
            [profileIdObjectId],
            tenantId,
            createInternalWorkerReq(tenantId)
          );
          await publishReportingSnapshotForSubscription(subForEvent, {
            tenantId,
            correlationId: payload?.correlationId,
            memberId,
            profileLean,
          });
        } catch (snapErr) {
          console.warn(
            "[SUBSCRIPTION_UPSERT_LISTENER] reporting snapshot retry failed:",
            snapErr.message
          );
        }
        return;
      }

      if (!profileHasLiveMembership) {
        console.log(
          "ℹ️ [SUBSCRIPTION_UPSERT_LISTENER] Profile has no live current membership — creating new active subscription:",
          {
            applicationId: normalizedAppId,
            profileCurrentSubscriptionId: profileCurrentSub?._id?.toString?.() ?? null,
            profileCurrentStatus: profileCurrentSub?.subscriptionStatus ?? null,
            staleLiveRowForApp: existingForApp?._id?.toString?.() ?? null,
          }
        );
      }
    }

    let shouldBeCurrent = true;
    if (payloadIsCurrent === false || payloadIsCurrent === "false") {
      shouldBeCurrent = false;
    } else if (payloadIsCurrent === true || payloadIsCurrent === "true") {
      shouldBeCurrent = true;
    } else if (membershipMovement === MEMBERSHIP_MOVEMENT.NEW_JOIN) {
      // Retrospective / backfilled join whose subscription year already ended → no longer “current”.
      shouldBeCurrent = subscriptionPeriodStillOpen(endDate);
    }

    if (shouldBeCurrent) {
      const demotedStatus =
        deactivatePreviousSubscriptionStatus &&
        Object.values(MEMBERSHIP_STATUS).includes(
          deactivatePreviousSubscriptionStatus,
        )
          ? deactivatePreviousSubscriptionStatus
          : MEMBERSHIP_STATUS.CANCELLED;

      await Subscription.updateMany(
        {
          profileId: profileIdObjectId,
          isCurrent: true,
          deleted: { $ne: true },
        },
        {
          $set: {
            isCurrent: false,
            subscriptionStatus: demotedStatus,
          },
        }
      );
    }

    // Create new subscription
    const subscriptionData = {
      profileId: profileIdObjectId,
      subscriptionYear,
      isCurrent: shouldBeCurrent,
      subscriptionStatus: shouldBeCurrent
        ? MEMBERSHIP_STATUS.ACTIVE
        : MEMBERSHIP_STATUS.LAPSED,
      startDate,
      endDate,
      rolloverDate,
      membershipMovement,
    };

    // Only include optional fields if they have valid values
    if (applicationId != null) {
      subscriptionData.applicationId = applicationId;
    }
    if (membershipCategory != null && membershipCategory !== "") {
      subscriptionData.membershipCategory = membershipCategory;
    }
    if (
      effectivePaymentType != null &&
      Object.values(PAYMENT_TYPE).includes(effectivePaymentType)
    ) {
      subscriptionData.paymentType = effectivePaymentType;
    }
    if (payrollNo != null && payrollNo !== "") {
      subscriptionData.payrollNo = payrollNo;
    }
    if (
      effectivePaymentFrequency != null &&
      Object.values(PAYMENT_FREQUENCY).includes(effectivePaymentFrequency)
    ) {
      subscriptionData.paymentFrequency = effectivePaymentFrequency;
    }

    // Add tenantId if provided (for multi-tenant support)
    if (tenantId) {
      subscriptionData.tenantId = tenantId;
    }

    if (resolvedUserId) {
      subscriptionData.userId = resolvedUserId;
    }

    // Set meta fields (createdBy will be null if user doesn't exist, subscription will still be created)
    subscriptionData.meta = {
      createdBy: null,
      updatedBy: null,
    };

    console.log(
      "🔍 [SUBSCRIPTION_UPSERT_LISTENER] Validated subscription data:",
      {
        fieldsCount: Object.keys(subscriptionData).length,
        hasPaymentType: !!subscriptionData.paymentType,
        hasPaymentFrequency: !!subscriptionData.paymentFrequency,
        hasMembershipCategory: !!subscriptionData.membershipCategory,
        hasUserId: !!subscriptionData.userId,
        profileId: profileIdObjectId.toString(),
        subscriptionYear,
      }
    );

    // Helper function to safely serialize data for logging
    const safeSerialize = (obj) => {
      return JSON.stringify(
        obj,
        (key, value) => {
          if (
            value &&
            typeof value === "object" &&
            value.constructor &&
            value.constructor.name === "ObjectId"
          ) {
            return value.toString();
          }
          if (value instanceof Date) {
            return value.toISOString();
          }
          return value;
        },
        2
      );
    };

    console.log(
      "📝 [SUBSCRIPTION_UPSERT_LISTENER] Creating new subscription:",
      {
        profileId: profileIdObjectId.toString(),
        subscriptionYear,
        membershipMovement,
        hasTenantId: !!tenantId,
      }
    );
    console.log(
      "📋 [SUBSCRIPTION_UPSERT_LISTENER] Subscription data:",
      safeSerialize(subscriptionData)
    );

    let newSub;
    try {
      newSub = await Subscription.create(subscriptionData);
      console.log(
        "✅ [SUBSCRIPTION_UPSERT_LISTENER] Subscription.create() succeeded"
      );
    } catch (createError) {
      console.error(
        "❌ [SUBSCRIPTION_UPSERT_LISTENER] Subscription.create() failed:",
        {
          error: createError.message,
          stack: createError.stack,
          name: createError.name,
          code: createError.code,
          subscriptionData: JSON.stringify(subscriptionData, null, 2),
          validationErrors: createError.errors,
        }
      );
      throw createError;
    }

    console.log(
      "✅ [SUBSCRIPTION_UPSERT_LISTENER] Subscription created successfully:",
      {
        subscriptionId: newSub._id.toString(),
        profileId: profileIdObjectId.toString(),
        subscriptionYear,
      }
    );

    // Publish event so profile-service can update Profile.currentSubscriptionId
    console.log(
      "📤 [SUBSCRIPTION_UPSERT_LISTENER] Publishing subscription current updated event:",
      {
        eventType: MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
        subscriptionId: newSub._id.toString(),
        profileId: profileIdObjectId.toString(),
        tenantId,
        correlationId: payload.correlationId,
        exchange: "membership.events",
      }
    );

    if (shouldBeCurrent) {
      let resolvedUserEmail =
        userEmail != null && String(userEmail).trim() !== ""
          ? String(userEmail).trim()
          : null;
      if (!resolvedUserEmail) {
        const profileLean = await fetchProfileWithRetry(
          [profileIdObjectId],
          tenantId,
          createInternalWorkerReq(tenantId)
        );
        if (profileLean) {
          const c = profileLean.contactInfo || {};
          resolvedUserEmail =
            c.personalEmail ||
            c.workEmail ||
            (profileLean.normalizedEmail
              ? String(profileLean.normalizedEmail).trim()
              : null) ||
            null;
        }
      }

      await publishSubscriptionCurrentUpdatedEvent({
        newSub,
        profileIdObjectId,
        applicationId,
        memberId,
        membershipCategory,
        startDate,
        userId: resolvedUserId || newSub.userId || null,
        userEmail: resolvedUserEmail,
        tenantId,
        payload,
        processingDate,
        submissionDate,
        applicationDate,
      });
    }

    try {
      const profileLean = await fetchProfileWithRetry(
        [profileIdObjectId],
        tenantId,
        createInternalWorkerReq(tenantId)
      );
      await publishReportingSnapshotForSubscription(newSub, {
        tenantId,
        correlationId: payload?.correlationId,
        memberId,
        profileLean,
      });
    } catch (snapErr) {
      console.warn(
        "[SUBSCRIPTION_UPSERT_LISTENER] reporting snapshot failed:",
        snapErr.message
      );
    }
  } catch (error) {
    // Enhanced error logging with multiple console methods to ensure visibility
    const errorDetails = {
      error: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      payload: {
        eventId: payload?.eventId,
        correlationId: payload?.correlationId,
        tenantId: payload?.tenantId,
        profileId: payload?.data?.profileId,
        dateJoined: payload?.data?.dateJoined,
      },
    };

    // Use multiple logging methods to ensure visibility
    console.error(
      "❌ [SUBSCRIPTION_UPSERT_LISTENER] Error handling subscription upsert:"
    );
    console.error(JSON.stringify(errorDetails, null, 2));
    console.error("Error details:", errorDetails);

    // Also log to stderr explicitly
    process.stderr.write(
      `[SUBSCRIPTION_UPSERT_LISTENER ERROR] ${error.message}\n${error.stack}\n`
    );

    throw error; // Re-throw to let RabbitMQ middleware handle retry/nack
  }
}

async function registerSubscriptionUpsertConsumer() {
  try {
    console.log("🔧 [SETUP] Registering subscription upsert consumer...");
    console.log("   Event:", MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED);
    console.log(
      "   Handler function:",
      typeof handleSubscriptionUpsertRequested
    );

    // Register the handler (same handler for both exchanges)
    consumer.registerHandler(
      MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED,
      handleSubscriptionUpsertRequested
    );
    console.log(
      "✅ Handler registered for event:",
      MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED
    );

    // Queue for membership.events exchange (primary route)
    const membershipQueueName = "subscription-service.membership.events";
    console.log("   Queue (membership.events):", membershipQueueName);

    await consumer.createQueue(membershipQueueName, { durable: true });
    console.log("✅ Queue created:", membershipQueueName);

    await consumer.bindQueue(membershipQueueName, "membership.events", [
      MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED,
    ]);
    console.log(
      "✅ Queue bound to exchange 'membership.events' with routing key:",
      MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED
    );

    await consumer.consume(membershipQueueName, { prefetch: 10 });
    console.log("✅ Consumer started for queue:", membershipQueueName);

    // Also listen on application.events exchange (fallback route from profile service)
    // This ensures we receive the event even if profile service publishes to application.events
    const applicationQueueName = "subscription-service.application.events";
    console.log("   Queue (application.events):", applicationQueueName);
    console.log("   Exchange: application.events (additional route)");

    await consumer.createQueue(applicationQueueName, { durable: true });
    console.log("✅ Queue created:", applicationQueueName);

    await consumer.bindQueue(applicationQueueName, "application.events", [
      MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED,
    ]);
    console.log(
      "✅ Queue bound to exchange 'application.events' with routing key:",
      MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED
    );

    await consumer.consume(applicationQueueName, { prefetch: 10 });
    console.log("✅ Consumer started for queue:", applicationQueueName);

    console.log(
      "📡 [SETUP] Subscription upsert consumer fully initialized and listening on both exchanges"
    );
  } catch (error) {
    console.error(
      "❌ [SETUP] Failed to register subscription upsert consumer:"
    );
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    console.error(
      "Full error:",
      JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    );
    process.stderr.write(
      `[SETUP ERROR] Failed to register subscription upsert consumer: ${error.message}\n${error.stack}\n`
    );
    throw error;
  }
}

module.exports = {
  registerSubscriptionUpsertConsumer,
};
