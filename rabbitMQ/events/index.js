const MEMBERSHIP_EVENTS = {
	MEMBER_CREATED_REQUESTED: "members.member.created.requested.v1",
	SUBSCRIPTION_UPSERT_REQUESTED: "members.subscription.upsert.requested.v1",
	SUBSCRIPTION_CURRENT_UPDATED: "members.subscription.current.updated.v1",
	SUBSCRIPTION_RESIGNED: "members.subscription.resigned.v1",
	SUBSCRIPTION_RESIGNATION_UNDONE: "members.subscription.resignation.undone.v1",
	SUBSCRIPTION_CANCELLATION_UNDONE: "members.subscription.cancellation.undone.v1",
	/** CRM cancellation: subscription status set to Cancelled → profile-service deactivates personal details by applicationId */
	SUBSCRIPTION_CANCELLED: "members.subscription.cancelled.v1",
	/** Published when cancellation grace period ends → user-service demotes portal user to NON-MEMBER */
	SUBSCRIPTION_CANCEL_GRACE_ENDED: "members.subscription.cancel.grace.ended.v1",
};

module.exports = {
	MEMBERSHIP_EVENTS,
};



