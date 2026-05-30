const { consumer, publisher } = require("@projectShell/rabbitmq-middleware");
const {
  tryClearRemindersAfterMemberReceipt,
} = require("../../services/reminderClear.service");
const {
  findCurrentSubscriptionByMemberId,
} = require("../../services/reminderClear.service");
const { createInternalWorkerReq } = require("../../helpers/serviceClient");

async function handlePaymentReceiptPosted(payload) {
  const data = payload?.data || payload;
  const tenantId = data?.tenantId ?? payload?.tenantId;
  const memberId = data?.memberId;
  const asOf = data?.asOf;
  if (!tenantId || !memberId) return;

  const cleared = await tryClearRemindersAfterMemberReceipt(
    { tenantId, memberId, asOf },
    createInternalWorkerReq(tenantId)
  );
  if (cleared === "cleared_all" || cleared === "stepped_back") {
    console.log("[memberFinance] Reminder pipeline updated after receipt", {
      memberId,
      docNo: data?.docNo,
      action: cleared,
    });
  }
}

async function handleDirectDebitCollectionUnpaid(payload) {
  const data = payload?.data || payload;
  const tenantId = data?.tenantId ?? payload?.tenantId;
  const memberId = data?.memberId;
  const reasonCode = data?.reasonCode || "UNKNOWN";
  const amountEur = data?.amountEur;
  if (!tenantId || !memberId) return;

  const sub = await findCurrentSubscriptionByMemberId(
    memberId,
    tenantId,
    createInternalWorkerReq(tenantId)
  );
  const userId = sub?.userId;
  if (!userId) {
    console.warn("[memberFinance] DD unpaid: no userId for notification", {
      memberId,
    });
    return;
  }

  const amountText =
    amountEur != null && Number.isFinite(Number(amountEur))
      ? `€${Number(amountEur).toFixed(2)}`
      : "your membership fee";

  await publisher.publish(
    MEMBERSHIP_EVENTS.MEMBER_NOTIFICATION_REQUESTED,
    {
      tenantId,
      userId: String(userId),
      title: "Direct debit unsuccessful",
      body: `Your direct debit collection of ${amountText} was rejected (${reasonCode}). Please update your payment details or contact membership support.`,
      metadata: {
        type: "DIRECT_DEBIT_UNPAID",
        memberId,
        reasonCode,
        runId: data?.runId || null,
        endToEndId: data?.endToEndId || null,
      },
    },
    {
      tenantId,
      exchange: "membership.events",
      routingKey: MEMBERSHIP_EVENTS.MEMBER_NOTIFICATION_REQUESTED,
      metadata: { service: "subscription-service", version: "1.0" },
    }
  );
}

async function registerMemberFinanceConsumers() {
  const queueName = "subscription-service.member-finance.events";
  await consumer.createQueue(queueName, { durable: true });
  await consumer.bindQueue(queueName, "membership.events", [
    MEMBERSHIP_EVENTS.PAYMENT_RECEIPT_POSTED,
  ]);
  await consumer.bindQueue(queueName, "application.events", [
    MEMBERSHIP_EVENTS.DIRECT_DEBIT_COLLECTION_UNPAID,
  ]);

  consumer.registerHandler(
    MEMBERSHIP_EVENTS.PAYMENT_RECEIPT_POSTED,
    handlePaymentReceiptPosted
  );
  consumer.registerHandler(
    MEMBERSHIP_EVENTS.DIRECT_DEBIT_COLLECTION_UNPAID,
    handleDirectDebitCollectionUnpaid
  );

  await consumer.consume(queueName, { prefetch: 4 });
}

module.exports = {
  registerMemberFinanceConsumers,
  handlePaymentReceiptPosted,
  handleDirectDebitCollectionUnpaid,
};
