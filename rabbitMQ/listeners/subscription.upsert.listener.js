const { MEMBERSHIP_EVENTS } = require("../events");
const { consumer, publisher } = require("@projectShell/rabbitmq-middleware");
const Subscription = require("../../models/subscription.model");
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

	if (!profileId || !dateJoined) {
		throw new Error("profileId and dateJoined are required");
	}

	const startDate = new Date(dateJoined);
	const subscriptionYear = startDate.getUTCFullYear();
	const endDate = endOfYear(startDate);
	const rolloverDate = startOfNextYear(startDate);

	// Determine movement based on existing subscriptions
	const existingSubs = await Subscription.find({ profileId }).sort({
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
	const existingForYear = await Subscription.findOne({
		profileId,
		subscriptionYear,
	});

	if (existingForYear) {
		// Only allow updates of paymentType, paymentFrequency, payrollNo
		const update = {};
		if (paymentType != null) update.paymentType = paymentType;
		if (paymentFrequency != null) update.paymentFrequency = paymentFrequency;
		if (payrollNo != null) update.payrollNo = payrollNo;
		if (Object.keys(update).length > 0) {
			update["meta.updatedBy"] = null;
			await Subscription.updateOne(
				{ _id: existingForYear._id },
				{ $set: update }
			);
		}
		return;
	}

	// Make previous currents not current
	await Subscription.updateMany(
		{ profileId, isCurrent: true },
		{ $set: { isCurrent: false } }
	);

	// Create new subscription
	const newSub = await Subscription.create({
		profileId,
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
	});

	// Publish event so profile-service can update Profile.currentSubscriptionId
	await publisher.publish(
		MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
		{
			subscriptionId: newSub._id.toString(),
			profileId,
		},
		{
			tenantId,
			correlationId: payload.correlationId,
			exchange: "membership.events",
			routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CURRENT_UPDATED,
			metadata: { service: "subscription-service", version: "1.0" },
		}
	);
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


