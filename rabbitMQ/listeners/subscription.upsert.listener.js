const { MEMBERSHIP_EVENTS } = require("../events");
const { consumer, publisher } = require("@projectShell/rabbitmq-middleware");
const Subscription = require("../../models/subscription.model");
const mongoose = require("mongoose");
const {
	MEMBERSHIP_STATUS,
	MEMBERSHIP_MOVEMENT,
} = require("../../constants/enums");

function endOfYear(date) {
	const y = date.getUTCFullYear();
	return new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
}

function startOfNextYear(date) {
	const y = date.getUTCFullYear();
	return new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0));
}

async function handleSubscriptionUpsertRequested(payload, context) {
	try {
		console.log(
			"📥 [SUBSCRIPTION_UPSERT_LISTENER] Received subscription upsert requested event:",
			{
				eventId: payload.eventId,
				correlationId: payload.correlationId,
				tenantId: payload.tenantId,
				data: payload.data,
			}
		);

		const { data = {}, tenantId } = payload || {};
		const {
			profileId,
			applicationId = null,
			membershipCategory = null,
			dateJoined,
			paymentType = null,
			payrollNo = null,
			paymentFrequency = null,
		} = data || {};

		// Validate required fields
		if (!profileId) {
			throw new Error("profileId is required");
		}
		if (!dateJoined) {
			throw new Error("dateJoined is required");
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
			throw new Error(`Invalid profileId format: ${profileId}`);
		}

		const startDate = new Date(dateJoined);
		if (isNaN(startDate.getTime())) {
			throw new Error(`Invalid dateJoined format: ${dateJoined}`);
		}

		const subscriptionYear = startDate.getUTCFullYear();
		const endDate = endOfYear(startDate);
		const rolloverDate = startOfNextYear(startDate);

		console.log(
			"📋 [SUBSCRIPTION_UPSERT_LISTENER] Processing subscription:",
			{
				profileId: profileIdObjectId.toString(),
				subscriptionYear,
				startDate: startDate.toISOString(),
				endDate: endDate.toISOString(),
				tenantId,
			}
		);

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

		// Try to find existing subscription for this year
		const existingForYearQuery = {
			profileId: profileIdObjectId,
			subscriptionYear,
		};
		if (tenantId) {
			existingForYearQuery.tenantId = tenantId;
		}

		const existingForYear = await Subscription.findOne(existingForYearQuery);

		if (existingForYear) {
			console.log(
				"ℹ️ [SUBSCRIPTION_UPSERT_LISTENER] Existing subscription found for year, updating:",
				{
					subscriptionId: existingForYear._id,
					subscriptionYear,
				}
			);
			// Only allow updates of paymentType, paymentFrequency, payrollNo
			const update = {};
			if (paymentType != null) update.paymentType = paymentType;
			if (paymentFrequency != null)
				update.paymentFrequency = paymentFrequency;
			if (payrollNo != null) update.payrollNo = payrollNo;
			if (Object.keys(update).length > 0) {
				update["meta.updatedBy"] = null;
				await Subscription.updateOne(
					{ _id: existingForYear._id },
					{ $set: update }
				);
				console.log(
					"✅ [SUBSCRIPTION_UPSERT_LISTENER] Subscription updated successfully"
				);
			}
			return;
		}

		// Make previous currents not current
		const updateCurrentQuery = { profileId: profileIdObjectId, isCurrent: true };
		if (tenantId) {
			updateCurrentQuery.tenantId = tenantId;
		}
		await Subscription.updateMany(updateCurrentQuery, {
			$set: { isCurrent: false },
		});

		// Create new subscription
		const subscriptionData = {
			profileId: profileIdObjectId,
			applicationId,
			subscriptionYear,
			isCurrent: true,
			subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
			startDate,
			endDate,
			rolloverDate,
			membershipMovement,
			membershipCategory, // accepted only on create
			paymentType,
			payrollNo,
			paymentFrequency,
		};

		// Add tenantId if provided (for multi-tenant support)
		if (tenantId) {
			subscriptionData.tenantId = tenantId;
		}

		console.log(
			"📝 [SUBSCRIPTION_UPSERT_LISTENER] Creating new subscription:",
			{
				profileId: profileIdObjectId.toString(),
				subscriptionYear,
				membershipMovement,
				hasTenantId: !!tenantId,
			}
		);

		const newSub = await Subscription.create(subscriptionData);

		console.log(
			"✅ [SUBSCRIPTION_UPSERT_LISTENER] Subscription created successfully:",
			{
				subscriptionId: newSub._id.toString(),
				profileId: profileIdObjectId.toString(),
				subscriptionYear,
			}
		);

		// Publish event so profile-service can update Profile.currentSubscriptionId
		await publisher.publish(
			MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
			{
				subscriptionId: newSub._id.toString(),
				profileId: profileIdObjectId.toString(),
			},
			{
				tenantId,
				correlationId: payload.correlationId,
				exchange: "membership.events",
				routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
				metadata: { service: "subscription-service", version: "1.0" },
			}
		);

		console.log(
			"✅ [SUBSCRIPTION_UPSERT_LISTENER] Subscription current updated event published"
		);
	} catch (error) {
		console.error(
			"❌ [SUBSCRIPTION_UPSERT_LISTENER] Error handling subscription upsert:",
			{
				error: error.message,
				stack: error.stack,
				payload: {
					eventId: payload?.eventId,
					correlationId: payload?.correlationId,
					tenantId: payload?.tenantId,
					profileId: payload?.data?.profileId,
					dateJoined: payload?.data?.dateJoined,
				},
			}
		);
		throw error; // Re-throw to let RabbitMQ middleware handle retry/nack
	}
}

async function registerSubscriptionUpsertConsumer() {
	consumer.registerHandler(
		MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED,
		handleSubscriptionUpsertRequested
	);

	const queueName = "subscription-service.membership.events";
	await consumer.createQueue(queueName, { durable: true });
	await consumer.bindQueue(queueName, "membership.events", [
		MEMBERSHIP_EVENTS.SUBSCRIPTION_UPSERT_REQUESTED,
	]);
	await consumer.consume(queueName, { prefetch: 10 });
}

module.exports = {
	registerSubscriptionUpsertConsumer,
};


