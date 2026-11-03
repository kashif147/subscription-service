// P5 reminder jobs: explicit-ack consumer RESUBSCRIBES after a broker-side connection/channel drop.
// REAL disposable broker only. Skipped unless REMINDER_IT_RABBIT_URL and REMINDER_IT_RABBIT_CONTAINER
// (the local throwaway container name, used for `rabbitmqctl close_all_connections`) are set, e.g.:
//   docker run -d --name p5-it-rabbit --user 999:999 -e HOME=/tmp/rmq ... rabbitmq:3.13-management
// Proves, with the real middleware connection manager and the real registerReminderBatchConsumers:
//   D1 broker force-closes every connection -> the consumer comes back on its own; jobs published
//      while it was down are processed; exactly ONE consumer on the queue afterwards;
//   D2 a delivery in flight (handler blocked, unacked) when the connection dies is NOT lost: the broker
//      redelivers it (redelivered=true) to the resubscribed consumer and it is recorded once;
//   D3 the dedicated channel alone closing (not via stop) -> resubscribed, still one consumer;
//   D4 repeated drops never accumulate consumers;
//   D5 stop() -> no resubscribe; zero consumers.
// Synthetic legacy jobs only (quarantine path with stubbed models; sentinel credential values).
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");

const URL = process.env.REMINDER_IT_RABBIT_URL;
const CONTAINER = process.env.REMINDER_IT_RABBIT_CONTAINER;
const skip = (!URL || !CONTAINER) && "REMINDER_IT_RABBIT_URL / REMINDER_IT_RABBIT_CONTAINER not set (disposable broker only)";

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
let amqplib, mw, listener, ReminderJobQuarantine, ReminderBatch, MEMBERSHIP_EVENTS;
const store = new Map(); // dedupeKey -> record (the "durable" quarantine)
const seen = []; // every handler invocation: { eventId, redelivered }
let block = null; // when set, the handler waits on this promise
let dieAfterBlock = false; // the blocked (in-flight) handler then fails WITHOUT persisting (simulated death)

function stubModels() {
  ReminderJobQuarantine.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      if (block) {
        await block;
        if (dieAfterBlock) {
          dieAfterBlock = false;
          throw new Error("simulated: worker died before persisting");
        }
      }
      let doc = store.get(filter.dedupeKey);
      if (!doc) store.set(filter.dedupeKey, (doc = { ...update.$setOnInsert, deliveryCount: 0 }));
      doc.deliveryCount += 1;
      return { ...doc };
    },
  });
  ReminderJobQuarantine.updateOne = async () => ({ modifiedCount: 0 });
  ReminderBatch.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
}

const job = (eventId) => ({
  eventId,
  eventType: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
  tenantId: A,
  data: { tenantId: A, batchId: "6650aaaaaaaaaaaaaaaaaaaa", headers: { authorization: "Bearer sent-it-token" } },
});

async function admin() {
  const conn = await amqplib.connect(URL);
  const ch = await conn.createChannel();
  return { conn, ch };
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* broker momentarily unavailable */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const killAllConnections = () =>
  execFileSync("docker", ["exec", CONTAINER, "rabbitmqctl", "-q", "close_all_connections", "p5-it-drop"], { stdio: "ignore" });

async function consumersOnQueue() {
  const { conn, ch } = await admin();
  try {
    return (await ch.checkQueue(listener.REMINDER_JOBS_QUEUE)).consumerCount;
  } finally {
    await conn.close().catch(() => {});
  }
}

async function publish(ids) {
  const { conn, ch } = await admin();
  for (const id of ids) {
    ch.publish("membership.events", MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED, Buffer.from(JSON.stringify(job(id))), { persistent: true });
  }
  await new Promise((r) => setTimeout(r, 150));
  await conn.close();
}

const recorded = (id) => [...store.values()].some((d) => d.eventId === id);

test.describe("reminder jobs explicit-ack consumer resubscribes after broker drops", { skip }, () => {
  test.before(async () => {
    process.env.RABBIT_URL = URL; // the middleware's own reconnect path reads RABBIT_URL (no config)
    amqplib = require("amqplib");
    mw = require("@projectShell/rabbitmq-middleware");
    listener = require("../rabbitMQ/listeners/reminderBatch.listener");
    ReminderJobQuarantine = require("../models/reminderJobQuarantine.model");
    ReminderBatch = require("../models/reminderBatch.model");
    ({ MEMBERSHIP_EVENTS } = require("../rabbitMQ/events"));
    stubModels();
    const { conn, ch } = await admin();
    await ch.deleteQueue(listener.REMINDER_JOBS_QUEUE).catch(() => {});
    await ch.deleteQueue(`${listener.REMINDER_JOBS_QUEUE}.dlq`).catch(() => {});
    await conn.close();
    const quiet = { info() {}, warn() {}, error() {} };
    await mw.init({ url: URL, logger: quiet, reconnectDelay: 300, maxReconnectAttempts: 50 });
    await listener.registerReminderBatchConsumers();
    assert.strictEqual(await consumersOnQueue(), 1);
  });

  test.after(async () => {
    await listener.stopReminderBatchConsumers().catch(() => {});
    await mw.shutdown().catch(() => {});
  });

  test("D1 broker closes all connections -> resubscribed; jobs published while down are processed; one consumer", async () => {
    await publish(["d1-before"]);
    assert.ok(await waitFor(async () => recorded("d1-before")), "processed before the drop");
    killAllConnections();
    await publish(["d1-during-1", "d1-during-2"]); // queued while the consumer is gone
    assert.ok(await waitFor(async () => recorded("d1-during-1") && recorded("d1-during-2")), "jobs queued during the outage are processed after resubscribe");
    assert.ok(await waitFor(async () => (await consumersOnQueue()) === 1), "exactly one consumer after reconnect");
    const { conn, ch } = await admin();
    assert.strictEqual((await ch.checkQueue(listener.REMINDER_JOBS_QUEUE)).messageCount, 0, "queue drained");
    assert.strictEqual((await ch.checkQueue(`${listener.REMINDER_JOBS_QUEUE}.dlq`)).messageCount, 0, "nothing dead-lettered");
    await conn.close();
  });

  test("D2 delivery in flight when the connection dies is redelivered by the broker and recorded once (not lost)", async () => {
    let release;
    block = new Promise((r) => (release = r));
    dieAfterBlock = true;
    await publish(["d2-inflight"]);
    const probe = await admin();
    // delivered to the consumer but unacked (handler blocked): not "ready" in the queue
    assert.ok(await waitFor(async () => (await probe.ch.checkQueue(listener.REMINDER_JOBS_QUEUE)).messageCount === 0));
    await probe.conn.close();
    assert.strictEqual(recorded("d2-inflight"), false, "nothing persisted while in flight");
    killAllConnections();
    block = null;
    release(); // the in-flight handler now dies without persisting; its channel is already gone
    assert.ok(await waitFor(async () => recorded("d2-inflight")), "recorded only via the broker's redelivery");
    const recs = [...store.values()].filter((d) => d.eventId === "d2-inflight");
    assert.strictEqual(recs.length, 1, "one record");
    assert.strictEqual(recs[0].deliveryCount, 1, "persisted exactly once (by the redelivered delivery)");
    assert.ok(await waitFor(async () => (await consumersOnQueue()) === 1));
    const { conn, ch } = await admin();
    assert.ok(await waitFor(async () => (await ch.checkQueue(listener.REMINDER_JOBS_QUEUE)).messageCount === 0), "nothing left behind");
    assert.strictEqual((await ch.checkQueue(`${listener.REMINDER_JOBS_QUEUE}.dlq`)).messageCount, 0, "not dead-lettered");
    await conn.close();
  });

  test("D3 the dedicated channel alone closing -> resubscribed, one consumer", async () => {
    const handle = require("../rabbitMQ/listeners/reminderBatch.listener").__handleForTests();
    const before = handle.restarts();
    await handle.channel.close();
    assert.ok(await waitFor(async () => handle.restarts() === before + 1 && handle.isActive()), "resubscribed after channel close");
    assert.ok(await waitFor(async () => (await consumersOnQueue()) === 1));
    await publish(["d3-after"]);
    assert.ok(await waitFor(async () => recorded("d3-after")));
  });

  test("D4 repeated drops never accumulate consumers", async () => {
    for (let i = 0; i < 3; i++) {
      killAllConnections();
      assert.ok(await waitFor(async () => (await consumersOnQueue()) === 1), `one consumer after drop ${i + 1}`);
    }
    await publish(["d4-after"]);
    assert.ok(await waitFor(async () => recorded("d4-after")));
    assert.strictEqual(await consumersOnQueue(), 1);
  });

  test("D5 stop() -> no resubscribe, zero consumers", async () => {
    await listener.stopReminderBatchConsumers();
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(await consumersOnQueue(), 0);
  });
});
