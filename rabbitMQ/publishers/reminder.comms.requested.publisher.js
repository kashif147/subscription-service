const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../events");

async function publishReminderCommsRequested(member, batch) {
  return publisher.publish(
    MEMBERSHIP_EVENTS.REMINDER_BATCH_COMMS_REQUESTED,
    {
      tenantId: member.tenantId,
      batchId: String(batch._id),
      batchMemberId: String(member._id),
      subscriptionId: String(member.subscriptionId),
      profileId: member.profileId ? String(member.profileId) : null,
      memberId: member.memberId,
      tier: member.tier,
      kind: batch.kind,
      idempotencyKey: `rb-comms:${batch._id}:${member._id}`,
    },
    {
      tenantId: member.tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.REMINDER_BATCH_COMMS_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );
}

module.exports = { publishReminderCommsRequested };
