// P5 reminder jobs: explicit-ack adapter against a REAL RabbitMQ broker (disposable; never a shared
// environment). Skipped unless REMINDER_IT_RABBIT_URL is set, e.g. a local throwaway container:
//   docker run -d --name p5-it-rabbit -p 127.0.0.1:56721:5672 rabbitmq:3.13-management
// Proves, with the real middleware createQueue/DLX setup and the real registerReminderBatchConsumers:
//   R1 process killed (SIGKILL) before quarantine persistence -> the job is still in the queue and is
//      redelivered (redelivered=true) to the next consumer, which quarantines it once; queue then empty;
//   R2 quarantine write keeps failing -> one broker redelivery, then dead-lettered to <queue>.dlq; the
//      main queue is empty and nothing loops;
//   R3 prefetch bound: with handlers blocked, at most REMINDER_JOBS_PREFETCH deliveries are outstanding.
// Synthetic payloads only (sentinel credential values that must never reach the record).
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");

const URL = process.env.REMINDER_IT_RABBIT_URL;
const skip = !URL && "REMINDER_IT_RABBIT_URL not set (disposable broker only)";

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const BATCH = "6650aaaaaaaaaaaaaaaaaaaa";

let amqplib, mw, listener, ReminderJobQuarantine, ReminderBatch, MEMBERSHIP_EVENTS;
let store = new Map();
let mode = "ok"; // ok | fail | block
const blocked = [];

function stubModels() {
  ReminderJobQuarantine.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      if (mode === "fail") throw new Error("simulated quarantine write failure");
      if (mode === "block") return new Promise((r) => blocked.push(r));
      let doc = store.get(filter.dedupeKey);
      if (!doc) store.set(filter.dedupeKey, (doc = { ...update.$setOnInsert, deliveryCount: 0 }));
      doc.deliveryCount += 1;
      return { ...doc };
    },
  });
  ReminderJobQuarantine.updateOne = async () => ({ modifiedCount: 0 });
  ReminderBatch.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
}

function legacyJob(eventId) {
  return {
    eventId,
    eventType: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    tenantId: A,
    data: { tenantId: A, batchId: BATCH, actorUserId: "actor-1", headers: { authorization: "Bearer sent-it-token", "x-user-id": "sent-it-user" } },
  };
}

async function admin() {
  const conn = await amqplib.connect(URL);
  const ch = await conn.createChannel();
  return { conn, ch };
}

async function publish(ch, job) {
  ch.publish("membership.events", MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED, Buffer.from(JSON.stringify(job)), { persistent: true });
  await new Promise((r) => setTimeout(r, 100));
}

const counts = async (ch) => ({
  main: (await ch.checkQueue(listener.REMINDER_JOBS_QUEUE)).messageCount,
  dlq: (await ch.checkQueue(`${listener.REMINDER_JOBS_QUEUE}.dlq`)).messageCount,
});

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test.describe("reminder jobs explicit ack on a real broker", { skip }, () => {
  test.before(async () => {
    amqplib = require("amqplib");
    mw = require("@projectShell/rabbitmq-middleware");
    listener = require("../rabbitMQ/listeners/reminderBatch.listener");
    ReminderJobQuarantine = require("../models/reminderJobQuarantine.model");
    ReminderBatch = require("../models/reminderBatch.model");
    ({ MEMBERSHIP_EVENTS } = require("../rabbitMQ/events"));
    stubModels();
    // Clean slate on the disposable broker (setup only; never a shared environment).
    const { conn, ch } = await admin();
    await ch.deleteQueue(listener.REMINDER_JOBS_QUEUE).catch(() => {});
    await ch.deleteQueue(`${listener.REMINDER_JOBS_QUEUE}.dlq`).catch(() => {});
    await conn.close();
  });

  test.after(async () => {
    await listener.stopReminderBatchConsumers().catch(() => {});
    await mw.shutdown().catch(() => {});
  });

  test("R1 SIGKILL before quarantine persistence -> job retained by the broker and redelivered; quarantined once", async () => {
    // Queue + DLX are created by the child's real registration.
    const child = spawn(process.execPath, [path.join(__dirname, "helpers/explicitAckCrashChild.js")], {
      env: { ...process.env, REMINDER_IT_RABBIT_URL: URL },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    assert.ok(await waitFor(() => out.includes("READY")), "child consumer ready");

    const { conn, ch } = await admin();
    await publish(ch, legacyJob("it-r1"));
    assert.ok(await waitFor(() => out.includes("IN_HANDLER")), "delivery reached the quarantine step");
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGKILL");
    await exited;

    assert.ok(await waitFor(async () => (await counts(ch)).main === 1), "job back in the queue after the crash");
    assert.deepStrictEqual(await counts(ch), { main: 1, dlq: 0 });
    assert.strictEqual(store.size, 0, "nothing persisted before the crash");

    // Next consumer (this process, real registration, working quarantine).
    store = new Map();
    mode = "ok";
    await mw.init({ url: URL, logger: { info() {}, warn() {}, error() {} }, maxReconnectAttempts: 0 });
    await listener.registerReminderBatchConsumers();
    assert.ok(await waitFor(async () => store.size === 1 && (await counts(ch)).main === 0), "redelivered and quarantined");
    const rec = [...store.values()][0];
    assert.strictEqual(rec.deliveryCount, 1);
    assert.ok(!JSON.stringify(rec).includes("sent-it-"), "record credential-free");
    assert.deepStrictEqual(await counts(ch), { main: 0, dlq: 0 });
    await conn.close();
  });

  test("R2 quarantine keeps failing -> one broker redelivery, then dead-lettered; no loop, main queue empty", async () => {
    mode = "fail";
    const { conn, ch } = await admin();
    await publish(ch, legacyJob("it-r2"));
    assert.ok(await waitFor(async () => (await counts(ch)).dlq === 1), "dead-lettered to the DLQ");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual(await counts(ch), { main: 0, dlq: 1 }, "no requeue loop");
    const m = await ch.get(`${listener.REMINDER_JOBS_QUEUE}.dlq`, { noAck: false });
    const death = (m.properties.headers["x-death"] || [])[0];
    assert.strictEqual(death.reason, "rejected");
    assert.strictEqual(death.queue, listener.REMINDER_JOBS_QUEUE);
    ch.nack(m, false, true); // leave it in the disposable DLQ
    await conn.close();
  });

  test("R3 prefetch bound: at most REMINDER_JOBS_PREFETCH unacked deliveries while handlers are blocked", async () => {
    mode = "block";
    const { conn, ch } = await admin();
    for (let i = 0; i < 5; i += 1) await publish(ch, legacyJob(`it-r3-${i}`));
    try {
      await new Promise((r) => setTimeout(r, 1000));
      assert.strictEqual(blocked.length, listener.REMINDER_JOBS_PREFETCH, "only prefetch-many deliveries in flight");
      const q = await ch.checkQueue(listener.REMINDER_JOBS_QUEUE);
      assert.strictEqual(q.messageCount, 5 - listener.REMINDER_JOBS_PREFETCH, "the rest still ready in the broker");
    } finally {
      mode = "ok";
      while (blocked.length) blocked.shift()({ deliveryCount: 1 });
    }
    assert.ok(await waitFor(async () => (await counts(ch)).main === 0), "drained once unblocked");
    await conn.close();
  });
});
