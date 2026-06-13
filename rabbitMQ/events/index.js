const MEMBERSHIP_EVENTS = {
	MEMBER_CREATED_REQUESTED: "members.member.created.requested.v1",
	SUBSCRIPTION_UPSERT_REQUESTED: "members.subscription.upsert.requested.v1",
	SUBSCRIPTION_CURRENT_UPDATED: "members.subscription.current.updated.v1",
	/** Denormalized subscription + profile dimensions for reporting-service */
	SUBSCRIPTION_REPORTING_SNAPSHOT: "members.subscription.reporting.snapshot.v1",
	/** CRM category change → account-service prorated fee adjustment (GL) */
	SUBSCRIPTION_CATEGORY_CHANGED: "members.subscription.category.changed.v1",
	/** CRM partial update → audit-service (before/after snapshot) */
	SUBSCRIPTION_CHANGED: "members.subscription.changed.v1",
	SUBSCRIPTION_RESIGNED: "members.subscription.resigned.v1",
	SUBSCRIPTION_RESIGNATION_UNDONE: "members.subscription.resignation.undone.v1",
	SUBSCRIPTION_CANCELLATION_UNDONE: "members.subscription.cancellation.undone.v1",
	/** CRM cancellation: subscription status set to Cancelled → profile-service deactivates personal details by applicationId */
	SUBSCRIPTION_CANCELLED: "members.subscription.cancelled.v1",
	/** In-app / push notification (notification-service) */
	MEMBER_NOTIFICATION_REQUESTED: "members.member.notification.requested.v1",
	PAYMENT_RECEIPT_POSTED: "members.payment.receipt.posted.v1",
	DIRECT_DEBIT_COLLECTION_UNPAID: "directdebit.collection.unpaid.v1",
	/** Legacy: published when cancellation.gracePeriodEnd has passed (sweep). New cancels use null grace; separate job demotes portal users. */
	SUBSCRIPTION_CANCEL_GRACE_ENDED: "members.subscription.cancel.grace.ended.v1",
	REMINDER_BATCH_BUILD_REQUESTED: "members.reminder.batch.build.requested.v1",
	REMINDER_BATCH_EXECUTE_REQUESTED: "members.reminder.batch.execute.requested.v1",
	REMINDER_BATCH_MONTHLY_ORCHESTRATE_REQUESTED:
		"members.reminder.batch.monthly.orchestrate.requested.v1",
	REMINDER_BATCH_COMMS_REQUESTED: "members.reminder.batch.comms.requested.v1",
	RENEWAL_BATCH_EXECUTE_REQUESTED: "members.renewal.batch.execute.requested.v1",
	/** Undergraduate graduation → communication-service (letter + email + in-app) */
	UNDERGRADUATE_GRADUATION_COMMS_REQUESTED:
		"members.undergraduate.graduation.comms.requested.v1",
};

module.exports = {
	MEMBERSHIP_EVENTS,
};



