const { MEMBERSHIP_EVENTS } = require("../events");
const { consumer } = require("@projectShell/rabbitmq-middleware");
const {
  publishSubscriptionCurrentUpdated,
} = require("../publishers/subscription.current.updated.publisher.js");
const Subscription = require("../../models/subscription.model");
const mongoose = require("mongoose");
const {
  MEMBERSHIP_STATUS,
  MEMBERSHIP_MOVEMENT,
  PAYMENT_TYPE,
  PAYMENT_FREQUENCY,
} = require("../../constants/enums");

function endOfYear(date) {
  const y = date.getUTCFullYear();
  return new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
}

function startOfNextYear(date) {
  const y = date.getUTCFullYear();
  return new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0));
}

async function publishSubscriptionCurrentUpdatedEvent({
  newSub,
  profileIdObjectId: _profileIdObjectId,
  applicationId,
  memberId,
  membershipCategory,
  startDate,
  userId,
  tenantId,
  payload,
  processingDate,
}) {
  return publishSubscriptionCurrentUpdated(newSub, {
    applicationId,
    memberId,
    membershipCategory,
    startDate,
    userId,
    tenantId,
    correlationId: payload?.correlationId,
    processingDate,
  });
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
      paymentType = null,
      payrollNo = null,
      paymentFrequency = null,
      userId = null,
      userEmail = null,
    } = data || {};

    const resolvedUserId =
      userId != null && String(userId).trim() !== ""
        ? String(userId).trim()
        : null;

    // Validate required fields
    if (!profileId) {
      console.error("❌ [SUBSCRIPTION_UPSERT_LISTENER] profileId is required but missing");
      throw new Error("profileId is required");
    }
    
    // Handle dateJoined - it might be a Date object, ISO string, or missing
    let startDate;
    if (!dateJoined) {
      console.warn(
        "⚠️ [SUBSCRIPTION_UPSERT_LISTENER] dateJoined is missing, using current date"
      );
      startDate = new Date();
    } else {
      startDate = new Date(dateJoined);
      if (isNaN(startDate.getTime())) {
        console.warn(
          `⚠️ [SUBSCRIPTION_UPSERT_LISTENER] Invalid dateJoined format: ${dateJoined}, using current date`
        );
        startDate = new Date();
      }
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

    // Determine movement based on existing subscriptions
    const query = { profileId: profileIdObjectId };
    if (tenantId) {
      query.tenantId = tenantId;
    }

    const existingSubs = await Subscription.find(query).sort({
      startDate: -1,
    });
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

    const updateCurrentQuery = {
      profileId: profileIdObjectId,
      isCurrent: true,
    };
    if (tenantId) {
      updateCurrentQuery.tenantId = tenantId;
    }

    // Idempotent payment-only path: same profile + same applicationId as an existing row.
    // A new applicationId always creates a new subscription document; prior rows (e.g. resigned) stay as history.
    const normalizedAppId =
      applicationId != null && String(applicationId).trim() !== ""
        ? String(applicationId).trim()
        : null;

    if (normalizedAppId) {
      const existingForAppQuery = {
        profileId: profileIdObjectId,
        applicationId: normalizedAppId,
      };
      if (tenantId) {
        existingForAppQuery.tenantId = tenantId;
      }

      const existingForApp = await Subscription.findOne(existingForAppQuery);

      if (existingForApp) {
        console.log(
          "ℹ️ [SUBSCRIPTION_UPSERT_LISTENER] Subscription already exists for this applicationId — payment fields only:",
          {
            subscriptionId: existingForApp._id,
            applicationId: normalizedAppId,
            subscriptionYear,
          }
        );
        const update = {};
        if (
          paymentType != null &&
          Object.values(PAYMENT_TYPE).includes(paymentType)
        ) {
          update.paymentType = paymentType;
        }
        if (
          paymentFrequency != null &&
          Object.values(PAYMENT_FREQUENCY).includes(paymentFrequency)
        ) {
          update.paymentFrequency = paymentFrequency;
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
            tenantId,
            payload,
            processingDate,
          });
        }
        return;
      }
    }

    await Subscription.updateMany(updateCurrentQuery, {
      $set: { isCurrent: false },
    });

    // Create new subscription
    const subscriptionData = {
      profileId: profileIdObjectId,
      subscriptionYear,
      isCurrent: true,
      subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
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
      paymentType != null &&
      Object.values(PAYMENT_TYPE).includes(paymentType)
    ) {
      subscriptionData.paymentType = paymentType;
    }
    if (payrollNo != null && payrollNo !== "") {
      subscriptionData.payrollNo = payrollNo;
    }
    if (
      paymentFrequency != null &&
      Object.values(PAYMENT_FREQUENCY).includes(paymentFrequency)
    ) {
      subscriptionData.paymentFrequency = paymentFrequency;
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

    await publishSubscriptionCurrentUpdatedEvent({
      newSub,
      profileIdObjectId,
      applicationId,
      memberId,
      membershipCategory,
      startDate,
      userId: resolvedUserId || newSub.userId || null,
      tenantId,
      payload,
      processingDate,
    });
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
