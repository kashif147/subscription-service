/**
 * P5: explicit-acknowledgement consumer for ONE queue (subscription-service.reminder-batch.jobs).
 *
 * Why not the shared rabbitmq-middleware consumer: on a handler error it acks the delivery and
 * republishes a copy from an in-process setTimeout (x-retry-count). A crash inside that delay loses the
 * job, so "the work was durably recorded or is still in the broker" does not hold. This adapter keeps
 * every delivery owned by the broker until the handler has finished:
 *
 *   handler resolves                   -> ack                (work done, or durable quarantine written)
 *   handler throws, first delivery     -> nack(requeue=true)  ONE broker-side redelivery (no timer, no copy)
 *   handler throws, redelivered        -> nack(requeue=false) dead-lettered by the broker to <queue>.dlq
 *   unparseable / unknown event type   -> nack(requeue=false) dead-lettered (never acked away)
 *   process/connection/channel dies    -> nothing settled; the broker redelivers (redelivered=true)
 *
 * Bounded: the broker's own `redelivered` flag limits immediate requeue to one; there is no loop and no
 * in-memory retry. A delivery is settled exactly once. Uses a DEDICATED channel on the middleware's
 * connection, so its prefetch is independent of the shared channel and it never touches the shared
 * consumer's global handler map. No new exchange, queue or routing key: the queue and its DLX binding
 * are still created by consumer.createQueue (dlx / <queue>.dlq).
 *
 * Logs carry the event type, event id, outcome and redelivered flag only - never the payload.
 */

const DEFAULT_PREFETCH = 2;

function settleOnce(channel, msg) {
  let done = false;
  return (op, ...args) => {
    if (done) return false;
    done = true;
    channel[op](msg, ...args);
    return true;
  };
}

function safeLogId(v) {
  const s = v == null ? "" : String(v);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(s) ? s : null;
}

/**
 * Decide and apply the settlement for one delivery. Exported for tests (fake channel).
 * @returns {Promise<"ack"|"requeue"|"dead-letter">}
 */
async function handleDelivery(msg, channel, handlers, logger = console) {
  const settle = settleOnce(channel, msg);
  const redelivered = Boolean(msg?.fields?.redelivered);
  let payload;
  try {
    payload = JSON.parse(msg.content.toString());
  } catch {
    settle("nack", false, false);
    logger.error?.("[explicit-ack] unparseable message dead-lettered", { redelivered });
    return "dead-letter";
  }
  const eventType = typeof payload?.eventType === "string" ? payload.eventType : null;
  const eventId = safeLogId(payload?.eventId);
  const handler = eventType ? handlers[eventType] : null;
  if (typeof handler !== "function") {
    settle("nack", false, false);
    logger.error?.("[explicit-ack] no handler; dead-lettered", { eventType: safeLogId(eventType), eventId });
    return "dead-letter";
  }
  try {
    await handler(payload, { redelivered, routingKey: msg.fields?.routingKey });
  } catch (err) {
    if (!redelivered) {
      settle("nack", false, true);
      logger.warn?.("[explicit-ack] handler failed; one broker redelivery", { eventType, eventId, error: err?.name || "Error" });
      return "requeue";
    }
    settle("nack", false, false);
    logger.error?.("[explicit-ack] handler failed on redelivery; dead-lettered", { eventType, eventId, error: err?.name || "Error" });
    return "dead-letter";
  }
  settle("ack");
  return "ack";
}

/**
 * Start consuming `queueName` on a dedicated channel.
 * @param {{ connectionManager: any, queueName: string, handlers: Record<string, Function>, prefetch?: number, logger?: any }} opts
 * @returns {Promise<{ channel: any, consumerTag: string, stop: () => Promise<void> }>}
 */
async function startExplicitAckConsumer({ connectionManager, queueName, handlers, prefetch = DEFAULT_PREFETCH, logger = console }) {
  if (!Number.isInteger(prefetch) || prefetch < 1 || prefetch > 50) throw new Error("prefetch must be an integer 1..50");
  const { connection } = await connectionManager.connect();
  if (!connection) throw new Error("RabbitMQ connection not available");
  const channel = await connection.createChannel();
  await channel.prefetch(prefetch);
  channel.on("error", (e) => logger.warn?.("[explicit-ack] channel error", { queueName, error: e?.message }));
  channel.on("close", () => logger.warn?.("[explicit-ack] channel closed; unacked deliveries return to the broker", { queueName }));
  const { consumerTag } = await channel.consume(
    queueName,
    (msg) => {
      if (!msg) return; // consumer cancelled by the broker
      handleDelivery(msg, channel, handlers, logger).catch((e) =>
        logger.error?.("[explicit-ack] settlement failed; delivery left to the broker", { queueName, error: e?.message })
      );
    },
    { noAck: false }
  );
  logger.info?.("[explicit-ack] consumer started", { queueName, prefetch });
  return {
    channel,
    consumerTag,
    stop: async () => {
      try {
        await channel.cancel(consumerTag);
        await channel.close();
      } catch {
        /* already closed: unacked deliveries are with the broker */
      }
    },
  };
}

module.exports = { startExplicitAckConsumer, handleDelivery, DEFAULT_PREFETCH };
