const MEMBERSHIP_EVENTS = {
	MEMBER_CREATED_REQUESTED: "members.member.created.requested.v1",
	SUBSCRIPTION_UPSERT_REQUESTED: "members.subscription.upsert.requested.v1",
	SUBSCRIPTION_CURRENT_UPDATED: "members.subscription.current.updated.v1",
	/** CRM category change → account-service prorated fee adjustment (GL) */
	SUBSCRIPTION_CATEGORY_CHANGED: "members.subscription.category.changed.v1",
	/** CRM partial update → audit-service (before/after snapshot) */
	SUBSCRIPTION_CHANGED: "members.subscription.changed.v1",
	SUBSCRIPTION_RESIGNED: "members.subscription.resigned.v1",
	SUBSCRIPTION_RESIGNATION_UNDONE: "members.subscription.resignation.undone.v1",
	SUBSCRIPTION_CANCELLATION_UNDONE: "members.subscription.cancellation.undone.v1",
	/** CRM cancellation: subscription status set to Cancelled → profile-service deactivates personal details by applicationId */
	SUBSCRIPTION_CANCELLED: "members.subscription.cancelled.v1",
	/** Published when cancellation grace period ends → user-service demotes portal user to NON-MEMBER */
	SUBSCRIPTION_CANCEL_GRACE_ENDED: "members.subscription.cancel.grace.ended.v1",
	REMINDER_BATCH_BUILD_REQUESTED: "members.reminder.batch.build.requested.v1",
	REMINDER_BATCH_EXECUTE_REQUESTED: "members.reminder.batch.execute.requested.v1",
	REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED:
		"members.reminder.batch.monthly.orchestrate.requested.v1",
	REMINDER_BATCH_COMMS_REQUESTED: "members.reminder.batch.comms.requested.v1",
	RENEWAL_BATCH_EXECUTE_REQUESTED: "members.renewal.batch.execute.requested.v1",
};

module.exports = {
	MEMBERSHIP_EVENTS,
};



