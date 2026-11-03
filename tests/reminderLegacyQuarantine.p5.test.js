// P5 reminder-batch legacy credential-bearing jobs: durable quarantine BEFORE acknowledgement.
//  - a legacy job (data.headers present) is recorded credential-free in reminder_job_quarantine, upserted
//    on a dedupe key, and only then is the message acknowledged;
//  - redelivery of the same job yields ONE record;
//  - the record and the log output never carry a header name or value, a token, a gateway identity or
//    an email (synthetic sentinel values below);
//  - if the record (or the build's batch-status update) cannot be written the handler throws, and the
//    real rabbitmq-middleware consumer (db70fb8) never takes the success ack: it republishes the
//    identical message with an incremented x-retry-count (bounded by maxRetries) and on the last attempt
//    nack(requeue=false) -> DLQ. requeue=true is never used.
// No network, no DB: the models and the batch service are stubbed in memory.
const test = require("node:test");
const assert = require("node:assert");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const BATCH = "6650aaaaaaaaaaaaaaaaaaaa";
const BATCH2 = "6650bbbbbbbbbbbbbbbbbbbb";

const SENTINELS = ["sent-token-q", "sent-hdr-user-q", "sent-hdr@example.invalid", "sent-actor@example.invalid", "sent-sig-q", "sent-cookie-q", "sent-perm-q"];
const FORBIDDEN_NAMES = ["authorization", "cookie", "x-user", "x-jwt", "x-auth", "x-gateway", "x-tenant-id", "x-internal-request", "bearer", "actoremail", "headers"];

const { consumer } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const reminderBatchService = require("../services/reminderBatch.service");
const ReminderBatch = require("../models/reminderBatch.model");
const ReminderJobQuarantine = require("../models/reminderJobQuarantine.model");
const listener = require("../rabbitMQ/listeners/reminderBatch.listener");

// ---- in-memory stubs ----------------------------------------------------------------------------

let store = new Map(); // dedupeKey -> record
let failQuarantine = false;
let failBatch = false;
const work = { build: 0, execute: 0, orchestrate: 0, batchUpdates: [] };

function applyUpsert(filter, update) {
  if (failQuarantine) throw new Error("simulated quarantine write failure");
  const key = filter.dedupeKey;
  let doc = store.get(key);
  if (!doc) {
    doc = { dedupeKey: key, ...update.$setOnInsert, deliveryCount: 0 };
    store.set(key, doc);
  }
  Object.assign(doc, update.$set || {});
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
  return { ...doc };
}
ReminderJobQuarantine.findOneAndUpdate = (filter, update, opts) => {
  assert.strictEqual(opts.upsert, true);
  return { lean: async () => applyUpsert(filter, update) };
};
ReminderJobQuarantine.updateOne = async (filter, update) => {
  const doc = store.get(filter.dedupeKey);
  if (doc) Object.assign(doc, update.$set);
  return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
};
ReminderBatch.updateOne = async (filter, update) => {
  if (failBatch) throw new Error("simulated batch update failure");
  work.batchUpdates.push({ filter, update });
  return { matchedCount: 1, modifiedCount: 1 };
};
reminderBatchService.buildReminderBatch = async () => void (work.build += 1);
reminderBatchService.executeReminderBatch = async () => void (work.execute += 1);
reminderBatchService.runMonthlyOrchestration = async () => void (work.orchestrate += 1);

function reset() {
  store = new Map();
  failQuarantine = false;
  failBatch = false;
  work.build = work.execute = work.orchestrate = 0;
  work.batchUpdates = [];
}

function legacyHeaders() {
  return {
    authorization: "Bearer sent-token-q",
    cookie: "sid=sent-cookie-q",
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": "sent-hdr-user-q",
    "x-user-email": "sent-hdr@example.invalid",
    "x-user-type": "CRM",
    "x-user-permissions": '["sent-perm-q"]',
    "x-gateway-signature": "sent-sig-q",
    "x-tenant-id": A,
    "x-internal-request": "true",
  };
}

function legacy(data, { tenantId = A, eventId = "evt-legacy-1" } = {}) {
  const env = { tenantId, data: { tenantId, actorUserId: "actor-1", actorEmail: "sent-actor@example.invalid", headers: legacyHeaders(), ...data } };
  if (eventId) env.eventId = eventId;
  return env;
}

function captureLogs() {
  const lines = [];
  const orig = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a);
  return { lines, restore: () => Object.assign(console, orig) };
}

function assertCredentialFree(value, label) {
  const text = JSON.stringify(value).toLowerCase();
  for (const s of SENTINELS) assert.ok(!text.includes(s), `${label}: sentinel value present`);
  for (const n of FORBIDDEN_NAMES) assert.ok(!text.includes(n), `${label}: credential key name "${n}" present`);
}

// ---- handler level ------------------------------------------------------------------------------

test("Q1 legacy build job: one credential-free quarantine record with exactly the business fields + flags", async () => {
  reset();
  const logs = captureLogs();
  try {
    await listener.handleReminderBuildRequested(legacy({ batchId: BATCH, correlationId: "corr-q1" }));
  } finally {
    logs.restore();
  }
  assert.strictEqual(store.size, 1);
  const [rec] = [...store.values()];
  const { firstSeenAt, lastSeenAt, ...rest } = rec;
  assert.ok(firstSeenAt instanceof Date && lastSeenAt instanceof Date);
  assert.deepStrictEqual(rest, {
    dedupeKey: "evt:build:evt-legacy-1",
    reason: "LEGACY_CREDENTIAL_PAYLOAD",
    kind: "build",
    eventType: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED,
    eventId: "evt-legacy-1",
    correlationId: "corr-q1",
    tenantId: A,
    tenantStatus: "resolved",
    batchId: BATCH,
    cancellationBatchId: null,
    reminderBatchId: null,
    actorUserId: "actor-1",
    invalidIdFields: [],
    carried: {
      storedRequestContext: true,
      credential: true,
      gatewayIdentity: true,
      tenantHeader: true,
      internalFlag: true,
      actorPii: true,
      otherFieldCount: 0,
    },
    status: "quarantined",
    deliveryCount: 1,
    batchMarkedFailed: true,
  });
  assertCredentialFree(rec, "record");
  assertCredentialFree(logs.lines, "logs");
  assert.strictEqual(work.build, 0, "never processed");
  assert.strictEqual(work.batchUpdates.length, 1);
  assert.deepStrictEqual(work.batchUpdates[0].filter, { _id: BATCH, tenantId: A, status: "pending_build" });
});

test("Q2 duplicate delivery of the same job (same eventId) -> one record, deliveryCount 2", async () => {
  reset();
  const logs = captureLogs();
  try {
    await listener.handleReminderBuildRequested(legacy({ batchId: BATCH }));
    await listener.handleReminderBuildRequested(legacy({ batchId: BATCH }));
  } finally {
    logs.restore();
  }
  assert.strictEqual(store.size, 1);
  assert.strictEqual([...store.values()][0].deliveryCount, 2);
});

test("Q3 no eventId: dedupe on a hash of the non-credential fields (same job -> one, other batch -> two)", async () => {
  reset();
  const logs = captureLogs();
  try {
    const job = legacy({ batchId: BATCH }, { eventId: null });
    await listener.handleReminderExecuteRequested(job);
    // a redelivery whose stored credential differs is still the same business job
    const again = legacy({ batchId: BATCH }, { eventId: null });
    again.data.headers.authorization = "Bearer sent-token-q-rotated";
    await listener.handleReminderExecuteRequested(again);
    assert.strictEqual(store.size, 1);
    await listener.handleReminderExecuteRequested(legacy({ batchId: BATCH2 }, { eventId: null }));
    assert.strictEqual(store.size, 2);
  } finally {
    logs.restore();
  }
  for (const k of store.keys()) assert.match(k, /^sha:[a-f0-9]{64}$/);
  assert.strictEqual(work.execute, 0);
});

test("Q4 orchestrate legacy job: both batch ids kept, no batch status change", async () => {
  reset();
  const logs = captureLogs();
  try {
    await listener.handleReminderMonthlyOrchestrateRequested(legacy({ cancellationBatchId: BATCH2, reminderBatchId: BATCH }, { eventId: "evt-o" }));
  } finally {
    logs.restore();
  }
  const [rec] = [...store.values()];
  assert.strictEqual(rec.kind, "orchestrate");
  assert.strictEqual(rec.cancellationBatchId, BATCH2);
  assert.strictEqual(rec.reminderBatchId, BATCH);
  assert.strictEqual(work.batchUpdates.length + work.orchestrate, 0);
  assertCredentialFree(rec, "record");
});

test("Q5 tenant missing / mismatch: recorded with tenantId null, no batch mutation", async () => {
  reset();
  const logs = captureLogs();
  try {
    await listener.handleReminderBuildRequested({ eventId: "evt-m", tenantId: A, data: { tenantId: B, batchId: BATCH, headers: legacyHeaders() } });
    await listener.handleReminderBuildRequested({ eventId: "evt-n", data: { batchId: BATCH, headers: legacyHeaders() } });
  } finally {
    logs.restore();
  }
  assert.deepStrictEqual(
    [...store.values()].map((r) => [r.eventId, r.tenantId, r.tenantStatus]).sort(),
    [["evt-m", null, "mismatch"], ["evt-n", null, "missing"]]
  );
  assert.strictEqual(work.batchUpdates.length + work.build, 0);
});

test("Q6 non-ObjectId / operator batch ids are never stored or queried", async () => {
  reset();
  const logs = captureLogs();
  try {
    await listener.handleReminderBuildRequested(legacy({ batchId: { $ne: null } }, { eventId: "evt-i" }));
  } finally {
    logs.restore();
  }
  const [rec] = [...store.values()];
  assert.strictEqual(rec.batchId, null);
  assert.deepStrictEqual(rec.invalidIdFields, ["batchId"]);
  assert.strictEqual(work.batchUpdates.length, 0);
});

test("Q7 quarantine write fails -> handler rejects, nothing processed, no batch mutation", async () => {
  reset();
  failQuarantine = true;
  const logs = captureLogs();
  try {
    await assert.rejects(listener.handleReminderBuildRequested(legacy({ batchId: BATCH })), /quarantine write failure/);
  } finally {
    logs.restore();
  }
  assert.strictEqual(store.size + work.build + work.batchUpdates.length, 0);
  assertCredentialFree(logs.lines, "logs");
});

test("Q8 batch status update fails after the record -> handler rejects; redelivery keeps one record", async () => {
  reset();
  failBatch = true;
  const logs = captureLogs();
  try {
    await assert.rejects(listener.handleReminderBuildRequested(legacy({ batchId: BATCH })));
    failBatch = false;
    await listener.handleReminderBuildRequested(legacy({ batchId: BATCH }));
  } finally {
    logs.restore();
  }
  assert.strictEqual(store.size, 1);
  const [rec] = [...store.values()];
  assert.strictEqual(rec.deliveryCount, 2);
  assert.strictEqual(rec.batchMarkedFailed, true);
});

test("Q9 a new (credential-free) payload is processed and never quarantined", async () => {
  reset();
  await listener.handleReminderBuildRequested({ eventId: "evt-new", tenantId: A, data: { tenantId: A, batchId: BATCH, actorUserId: "actor-1" } });
  assert.strictEqual(work.build, 1);
  assert.strictEqual(store.size, 0);
});

// ---- real rabbitmq-middleware consumer: ack / nack semantics ------------------------------------

function fakeChannel() {
  const ch = { acks: 0, nacks: [], published: [] };
  ch.ack = () => void (ch.acks += 1);
  ch.nack = (_m, allUpTo, requeue) => ch.nacks.push({ allUpTo, requeue });
  ch.publish = (exchange, routingKey, content, props) => ch.published.push({ exchange, routingKey, content, props });
  return ch;
}

function amqpMessage(payload, retryCount) {
  return {
    content: Buffer.from(JSON.stringify({ eventType: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED, ...payload })),
    fields: { routingKey: MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED, exchange: "membership.events", redelivered: false },
    properties: { headers: retryCount == null ? {} : { "x-retry-count": retryCount } },
  };
}

async function viaConsumer(payload, retryCount) {
  const ch = fakeChannel();
  const logged = [];
  const sink = (...a) => logged.push(a);
  const prev = { logger: consumer.logger, delay: consumer.retryDelay };
  consumer.setLogger({ info: sink, warn: sink, error: sink, debug: sink });
  consumer.retryDelay = 0;
  consumer.registerHandler(MEMBERSHIP_EVENTS.REMINDER_BATCH_BUILD_REQUESTED, listener.handleReminderBuildRequested);
  const logs = captureLogs();
  try {
    await consumer.handleMessage(amqpMessage(payload, retryCount), ch, "subscription-service.reminder-batch.jobs");
    await new Promise((r) => setTimeout(r, 5)); // let the middleware's delayed republish fire
  } finally {
    logs.restore();
    consumer.setLogger(prev.logger);
    consumer.retryDelay = prev.delay;
  }
  return { ch, logged: [...logged, ...logs.lines] };
}

test("M1 record written -> middleware acks once, no nack, no republish", async () => {
  reset();
  const { ch, logged } = await viaConsumer(legacy({ batchId: BATCH }));
  assert.strictEqual(store.size, 1);
  assert.strictEqual(ch.acks, 1);
  assert.deepStrictEqual(ch.nacks, []);
  assert.strictEqual(ch.published.length, 0);
  assertCredentialFree(logged, "middleware + service logs");
});

test("M2 record write fails on the final attempt -> ack NEVER called, nack(requeue=false) once (DLQ)", async () => {
  reset();
  failQuarantine = true;
  const { ch } = await viaConsumer(legacy({ batchId: BATCH }), consumer.maxRetries);
  assert.strictEqual(ch.acks, 0, "original job never acknowledged");
  assert.deepStrictEqual(ch.nacks, [{ allUpTo: false, requeue: false }]);
  assert.strictEqual(ch.published.length, 0);
  assert.strictEqual(store.size + work.build, 0);
});

test("M3 record write fails before the last attempt -> bounded retry: identical message republished with x-retry-count+1, never requeue=true", async () => {
  reset();
  failQuarantine = true;
  const original = legacy({ batchId: BATCH });
  const { ch } = await viaConsumer(original, 1);
  assert.strictEqual(ch.nacks.filter((n) => n.requeue === true).length, 0);
  assert.strictEqual(ch.published.length, 1, "job carried forward, not dropped");
  assert.strictEqual(ch.published[0].props.headers["x-retry-count"], 2);
  assert.deepStrictEqual(JSON.parse(ch.published[0].content.toString()).data, original.data);
  assert.ok(consumer.maxRetries >= 1 && Number.isFinite(consumer.maxRetries), "bounded");
});

test("Q10 the real schema accepts exactly the built record and rejects any extra (e.g. header) field", () => {
  const rec = listener.buildQuarantineRecord("build", legacy({ batchId: BATCH }));
  const now = new Date();
  const doc = new ReminderJobQuarantine({ ...rec, firstSeenAt: now, lastSeenAt: now });
  assert.strictEqual(doc.validateSync(), undefined);
  assertCredentialFree(doc.toObject(), "schema document");
  assert.throws(() => new ReminderJobQuarantine({ ...rec, firstSeenAt: now, lastSeenAt: now, headers: legacyHeaders() }), /not in schema|strict/i);
});
