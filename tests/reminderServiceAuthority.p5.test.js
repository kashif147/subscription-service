// P5 reminder-batch service authority.
//  1. CRM trigger (create/build/execute/monthly-orchestrate) needs EXACTLY the claim set that
//     account-service's reminder-eligibility-bulk guard admits for a user today
//     (requireInternalOrFinanceRead -> requireFinanceReadStrict -> canFinanceRead), plus CRM.
//  2. Queued REMINDER_BATCH_* payloads carry no user credential (no Authorization, no gateway headers).
//  3. The worker runs with service authority only (createInternalWorkerReq) and never replays
//     headers stored in a legacy payload; legacy credential-bearing payloads are refused after a
//     durable credential-free quarantine record is written (see reminderLegacyQuarantine.p5.test.js).
//  4. fetchReminderEligibilityBulk always sends internal-only headers, whatever req it is given.
// No network, no DB: the publisher, the batch service and axios are stubbed.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");

process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "p5-reminder-test-secret";
const SECRET = process.env.ACCESS_TOKEN_SECRET;

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const BATCH = "6650aaaaaaaaaaaaaaaaaaaa";
const BATCH2 = "6650bbbbbbbbbbbbbbbbbbbb";
const TOKEN_MARKER = "p5-credential-marker";

const { publisher } = require("@projectShell/rabbitmq-middleware");
const reminderBatchService = require("../services/reminderBatch.service");
const ReminderBatch = require("../models/reminderBatch.model");
const serviceClient = require("../helpers/serviceClient");
const reminderBatchRabbit = require("../jobs/reminderBatch.rabbit.js");
const listener = require("../rabbitMQ/listeners/reminderBatch.listener");

// The exact user claim set account-service admits on POST /internal/members/reminder-eligibility-bulk
// today (account 4357493 financePermission.middleware.js canFinanceRead + financePermissions.js
// hasFinancePermission wildcard/alias expansion).
const ACCOUNT_BULK_CLAIMS = [
  "*",
  "admin",
  "payments:*",
  "payments:read",
  "accounts.admin:*",
  "accounts.admin:read",
  "accounts.reports:*",
  "accounts.reports:read",
];

const CREDENTIAL_KEYS = [
  "authorization",
  "x-jwt-verified",
  "x-auth-source",
  "x-user-id",
  "x-user-email",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
];

// ---- stubs -------------------------------------------------------------------------------------

const calls = { publish: [], create: [], queued: [], build: [], execute: [], orchestrate: [], updateOne: [], quarantine: [] };
const reset = () => Object.keys(calls).forEach((k) => (calls[k] = []));

publisher.publish = async (...args) => {
  calls.publish.push(args);
  return { success: true };
};
reminderBatchService.createReminderBatch = async (req) => {
  calls.create.push(req);
  return { _id: BATCH, status: "draft" };
};
reminderBatchService.markReminderBatchBuildQueued = async (batchId, tenantId) => {
  calls.queued.push({ batchId, tenantId });
  return { _id: batchId, status: "pending_build" };
};
reminderBatchService.markBuildReminderBatchFailed = async () => {};
reminderBatchService.getReminderBatchById = async (_req, batchId) => ({ _id: batchId });
reminderBatchService.buildReminderBatch = async (req, batchId) => {
  calls.build.push({ req, batchId });
  return { _id: batchId, status: "ready" };
};
reminderBatchService.executeReminderBatch = async (req, batchId) => {
  calls.execute.push({ req, batchId });
  return { _id: batchId, status: "completed" };
};
reminderBatchService.runMonthlyOrchestration = async (req, body) => {
  calls.orchestrate.push({ req, body });
  return { _id: body.reminderBatchId, status: "ready" };
};
ReminderBatch.updateOne = async (filter, update) => {
  calls.updateOne.push({ filter, update });
  return { matchedCount: 1, modifiedCount: 1 };
};
// Durable quarantine record (full behaviour in reminderLegacyQuarantine.p5.test.js).
const ReminderJobQuarantine = require("../models/reminderJobQuarantine.model");
ReminderJobQuarantine.findOneAndUpdate = (filter, update) => ({
  lean: async () => {
    calls.quarantine.push({ filter, update });
    return { deliveryCount: 1 };
  },
});
ReminderJobQuarantine.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });

// ---- HTTP harness (real router + real auth middleware) ------------------------------------------

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/reminder-batches", require("../routes/reminderBatch.routes"));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function bearer(opts = {}) {
  const { permissions = [], tenantId = A, sub = "crm-user-1" } = opts;
  // "userType" passed explicitly as undefined means: token without a userType claim.
  const userType = Object.prototype.hasOwnProperty.call(opts, "userType") ? opts.userType : "CRM";
  const claims = { sub, tenantId, permissions, roles: [] };
  if (userType !== undefined) claims.userType = userType;
  return `Bearer ${jwt.sign(claims, SECRET, { expiresIn: "5m" })}`;
}

async function call(method, path, { authorization, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    json = null;
  }
  return { status: res.status, body: json };
}

const TRIGGERS = [
  { name: "POST / (create + build)", method: "POST", path: "/reminder-batches", body: { name: "n", kind: "REMINDER", batchDate: "2026-11-01" } },
  { name: "POST /:batchId/build", method: "POST", path: `/reminder-batches/${BATCH}/build` },
  { name: "POST /:batchId/execute", method: "POST", path: `/reminder-batches/${BATCH}/execute` },
  {
    name: "POST /monthly-orchestrate",
    method: "POST",
    path: "/reminder-batches/monthly-orchestrate",
    body: { cancellationBatchId: BATCH2, reminderBatchId: BATCH },
  },
];

function nothingStarted() {
  return (
    calls.publish.length +
    calls.create.length +
    calls.queued.length +
    calls.build.length +
    calls.execute.length +
    calls.orchestrate.length
  );
}

// ---- 1. trigger authorization -------------------------------------------------------------------

test("T1 every trigger is allowed for each claim in the account bulk set (CRM, RabbitMQ transport)", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    for (const claim of ACCOUNT_BULK_CLAIMS) {
      for (const t of TRIGGERS) {
        reset();
        const res = await call(t.method, t.path, { authorization: bearer({ permissions: [claim] }), body: t.body });
        assert.ok(res.status === 200 || res.status === 201, `${t.name} with ${claim}: got ${res.status}`);
        assert.strictEqual(calls.publish.length, 1, `${t.name} with ${claim}: one job queued`);
      }
    }
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("T2 every trigger is allowed for each claim in the set on the synchronous transport too", async () => {
  delete process.env.RABBIT_URL;
  for (const claim of ACCOUNT_BULK_CLAIMS) {
    for (const t of TRIGGERS) {
      reset();
      const res = await call(t.method, t.path, { authorization: bearer({ permissions: [claim] }), body: t.body });
      assert.ok(res.status === 200 || res.status === 201, `${t.name} with ${claim}: got ${res.status}`);
      assert.strictEqual(calls.publish.length, 0);
    }
  }
});

test("T3 CRM caller without any claim of the set is denied before anything is created or queued", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    const notInSet = [
      [],
      ["subscriptions:read"],
      ["subscriptions:write"],
      ["payments:write"],
      ["payments:create"],
      ["accounts.journals:read"],
      ["accounts.admin:write"],
      ["PAYMENTS_READ"], // un-normalised code is not a claim
      ["payments:read "], // no trimming / fuzzy matching
    ];
    for (const permissions of notInSet) {
      for (const t of TRIGGERS) {
        reset();
        const res = await call(t.method, t.path, { authorization: bearer({ permissions }), body: t.body });
        assert.strictEqual(res.status, 403, `${t.name} with ${JSON.stringify(permissions)}`);
        assert.strictEqual(res.body?.code, "FINANCE_READ_REQUIRED");
        assert.strictEqual(nothingStarted(), 0, `${t.name} with ${JSON.stringify(permissions)}: nothing started`);
      }
    }
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("T4 PORTAL and unknown/missing userType are denied even when holding a claim of the set", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    for (const userType of ["PORTAL", "SERVICE", "", undefined]) {
      for (const t of TRIGGERS) {
        reset();
        const res = await call(t.method, t.path, {
          authorization: bearer({ userType, permissions: ["*", "payments:read", "accounts.reports:read"] }),
          body: t.body,
        });
        assert.strictEqual(res.status, 403, `${t.name} as ${String(userType)}`);
        assert.strictEqual(nothingStarted(), 0);
      }
    }
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("T5 a client cannot grant itself the claim: body/query permissions are ignored", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    reset();
    const res = await call("POST", `/reminder-batches/${BATCH}/build?permissions=*`, {
      authorization: bearer({ permissions: [] }),
      body: { permissions: ["*"] },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(nothingStarted(), 0);
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("T6 an internal header does not open a trigger route (user routes are user-only)", async () => {
  reset();
  const res = await call("POST", `/reminder-batches/${BATCH}/build`, {
    headers: { "x-internal-request": "true", "x-tenant-id": A },
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(nothingStarted(), 0);
});

// ---- 2. queued payloads carry no credentials -----------------------------------------------------

function crmHttpReq() {
  const token = `Bearer ${TOKEN_MARKER}`;
  return {
    tenantId: A,
    userId: "crm-user-1",
    correlationId: "corr-1",
    user: { email: "staff@example.test", userType: "CRM", permissions: ["payments:read"] },
    headers: {
      authorization: token,
      "x-jwt-verified": "true",
      "x-auth-source": "gateway",
      "x-user-id": "crm-user-1",
      "x-user-email": "staff@example.test",
      "x-user-type": "CRM",
      "x-user-roles": '["MO"]',
      "x-user-permissions": '["payments:read"]',
      "x-tenant-id": B, // raw inbound header: never the authority
      "x-correlation-id": "corr-1",
    },
  };
}

function assertCredentialFree(data, label) {
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes(TOKEN_MARKER), `${label}: bearer value not persisted`);
  assert.ok(!serialized.includes("staff@example.test"), `${label}: no actor email/PII in the payload`);
  for (const key of ["headers", ...CREDENTIAL_KEYS, "actorEmail"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(data, key), `${label}: no ${key}`);
  }
}

test("Q1 build payload: exactly batchId, tenantId, actorUserId, correlationId", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    reset();
    await reminderBatchRabbit.publishReminderBuildRequested(crmHttpReq(), BATCH);
    const [eventType, data, options] = calls.publish[0];
    assert.strictEqual(eventType, "members.reminder.batch.build.requested.v1");
    assert.deepStrictEqual(Object.keys(data).sort(), ["actorUserId", "batchId", "correlationId", "tenantId"]);
    assert.deepStrictEqual(data, { batchId: BATCH, tenantId: A, actorUserId: "crm-user-1", correlationId: "corr-1" });
    assertCredentialFree(data, "build");
    assert.strictEqual(options.tenantId, A);
    assert.strictEqual(options.correlationId, "corr-1");
    assert.strictEqual(options.headers, undefined, "no AMQP message headers carry identity");
    assert.ok(!JSON.stringify(options).includes(TOKEN_MARKER));
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("Q2 execute payload: exactly batchId, tenantId, actorUserId, correlationId", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    reset();
    await reminderBatchRabbit.publishReminderExecuteRequested(crmHttpReq(), BATCH);
    const [eventType, data] = calls.publish[0];
    assert.strictEqual(eventType, "members.reminder.batch.execute.requested.v1");
    assert.deepStrictEqual(Object.keys(data).sort(), ["actorUserId", "batchId", "correlationId", "tenantId"]);
    assertCredentialFree(data, "execute");
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("Q3 monthly-orchestrate payload: exactly the two batch ids, tenantId, actorUserId, correlationId", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    reset();
    await reminderBatchRabbit.publishReminderMonthlyOrchestrateRequested(crmHttpReq(), {
      cancellationBatchId: BATCH2,
      reminderBatchId: BATCH,
      authorization: "Bearer smuggled", // body extras are never copied
    });
    const [eventType, data] = calls.publish[0];
    assert.strictEqual(eventType, "members.reminder.batch.monthly.orchestrate.requested.v1");
    assert.deepStrictEqual(Object.keys(data).sort(), [
      "actorUserId",
      "cancellationBatchId",
      "correlationId",
      "reminderBatchId",
      "tenantId",
    ]);
    assertCredentialFree(data, "orchestrate");
    assert.ok(!JSON.stringify(data).includes("smuggled"));
  } finally {
    delete process.env.RABBIT_URL;
  }
});

test("Q4 payload via the real route: queued job for a CRM gateway-header caller is credential-free", async () => {
  process.env.RABBIT_URL = "amqp://stub";
  try {
    reset();
    const res = await call("POST", `/reminder-batches/${BATCH}/execute`, {
      authorization: bearer({ permissions: ["payments:read"] }),
      headers: { "x-correlation-id": "corr-route" },
    });
    assert.strictEqual(res.status, 200);
    const data = calls.publish[0][1];
    assert.deepStrictEqual(Object.keys(data).sort(), ["actorUserId", "batchId", "correlationId", "tenantId"]);
    assert.strictEqual(data.tenantId, A);
    assert.strictEqual(data.actorUserId, "crm-user-1");
    assert.ok(!JSON.stringify(calls.publish[0]).includes("Bearer"));
  } finally {
    delete process.env.RABBIT_URL;
  }
});

// ---- 3. worker: service authority only, legacy payloads refused ----------------------------------

const INTERNAL_KEYS = ["x-internal-request", "x-tenant-id"];

function envelope(data, tenantId = A) {
  return { eventId: "evt-1", correlationId: "corr-env", tenantId, data: { tenantId, ...data } };
}

function legacyHeaders() {
  return {
    authorization: `Bearer ${TOKEN_MARKER}`,
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": "crm-user-1",
    "x-user-type": "CRM",
    "x-user-permissions": '["payments:read"]',
    "x-tenant-id": A,
    "x-internal-request": "true",
  };
}

test("W1 worker req for a new payload: internal headers only (+ correlation id), actor kept for audit", () => {
  const req = listener.buildWorkerReq(envelope({ batchId: BATCH, actorUserId: "crm-user-1", correlationId: "corr-1" }));
  assert.deepStrictEqual(Object.keys(req.headers).sort(), ["x-correlation-id", ...INTERNAL_KEYS].sort());
  assert.strictEqual(req.headers["x-internal-request"], "true");
  assert.strictEqual(req.headers["x-tenant-id"], A);
  assert.strictEqual(req.tenantId, A);
  assert.strictEqual(req.userId, "crm-user-1");
});

test("W2 worker req never replays stored headers, even if a payload carries them", () => {
  const req = listener.buildWorkerReq(envelope({ batchId: BATCH, headers: legacyHeaders() }));
  for (const key of CREDENTIAL_KEYS) assert.strictEqual(req.headers[key], undefined, key);
  assert.ok(!JSON.stringify(req).includes(TOKEN_MARKER));
  assert.strictEqual(req.headers["x-tenant-id"], A);
});

test("W3 new build payload: build runs with the internal worker req", async () => {
  reset();
  await listener.handleReminderBuildRequested(envelope({ batchId: BATCH, actorUserId: "crm-user-1", correlationId: "c" }));
  assert.strictEqual(calls.build.length, 1);
  const { req, batchId } = calls.build[0];
  assert.strictEqual(batchId, BATCH);
  for (const key of CREDENTIAL_KEYS) assert.strictEqual(req.headers[key], undefined, key);
  assert.strictEqual(req.headers["x-internal-request"], "true");
});

test("W4 legacy credential-bearing build payload: quarantined, refused (no build, no throw), queued batch marked failed", async () => {
  reset();
  const before = listener.getLegacyCredentialPayloadRefusals().build;
  const logged = [];
  const origWarn = console.warn;
  console.warn = (...args) => logged.push(args);
  try {
    await listener.handleReminderBuildRequested(envelope({ batchId: BATCH, actorUserId: "crm-user-1", headers: legacyHeaders() }));
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(calls.build.length, 0, "never processed with the stored identity");
  assert.strictEqual(listener.getLegacyCredentialPayloadRefusals().build, before + 1);
  assert.strictEqual(calls.quarantine.length, 1, "durable record written");
  assert.strictEqual(calls.updateOne.length, 1);
  assert.deepStrictEqual(calls.updateOne[0].filter, { _id: BATCH, tenantId: A, status: "pending_build" });
  assert.strictEqual(calls.updateOne[0].update.$set.status, "failed");
  assert.ok(!JSON.stringify(logged).includes(TOKEN_MARKER), "header values never logged");
  assert.ok(!JSON.stringify(logged).includes("crm-user-1"), "stored identity never logged");
});

test("W5 legacy execute / monthly-orchestrate payloads: quarantined, refused (not processed, no throw, no status change)", async () => {
  reset();
  const before = listener.getLegacyCredentialPayloadRefusals();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await listener.handleReminderExecuteRequested(envelope({ batchId: BATCH, headers: legacyHeaders() }));
    await listener.handleReminderMonthlyOrchestrateRequested(
      envelope({ cancellationBatchId: BATCH2, reminderBatchId: BATCH, headers: legacyHeaders() })
    );
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(calls.execute.length, 0);
  assert.strictEqual(calls.orchestrate.length, 0);
  assert.strictEqual(calls.updateOne.length, 0);
  assert.strictEqual(calls.quarantine.length, 2);
  const after = listener.getLegacyCredentialPayloadRefusals();
  assert.strictEqual(after.execute, before.execute + 1);
  assert.strictEqual(after.orchestrate, before.orchestrate + 1);
});

test("W6 legacy payload with a tenant mismatch: quarantined (tenant unresolved), no batch mutation, no throw", async () => {
  reset();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await listener.handleReminderBuildRequested({
      eventId: "evt-x",
      tenantId: A,
      data: { tenantId: B, batchId: BATCH, headers: legacyHeaders() },
    });
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(calls.build.length + calls.updateOne.length, 0);
  assert.strictEqual(calls.quarantine.length, 1, "recorded, not silently dropped");
  const ins = calls.quarantine[0].update.$setOnInsert;
  assert.strictEqual(ins.tenantId, null);
  assert.strictEqual(ins.tenantStatus, "mismatch");
});

test("W7 new payload with a tenant mismatch is still quarantined (throws -> retry/DLQ), nothing processed", async () => {
  reset();
  await assert.rejects(
    listener.handleReminderBuildRequested({ eventId: "e", tenantId: A, data: { tenantId: B, batchId: BATCH } })
  );
  assert.strictEqual(calls.build.length, 0);
});

test("W8 new execute / orchestrate payloads run with the internal worker req", async () => {
  reset();
  await listener.handleReminderExecuteRequested(envelope({ batchId: BATCH, actorUserId: "u" }));
  await listener.handleReminderMonthlyOrchestrateRequested(envelope({ cancellationBatchId: BATCH2, reminderBatchId: BATCH }));
  assert.strictEqual(calls.execute.length, 1);
  assert.strictEqual(calls.orchestrate.length, 1);
  for (const r of [calls.execute[0].req, calls.orchestrate[0].req]) {
    for (const key of CREDENTIAL_KEYS) assert.strictEqual(r.headers[key], undefined, key);
  }
});

test("W9 synchronous build/execute also run with service authority (live HTTP req is not forwarded)", () => {
  const w = reminderBatchService._serviceAuthorityReq(crmHttpReq(), A);
  assert.deepStrictEqual(Object.keys(w.headers).sort(), ["x-correlation-id", ...INTERNAL_KEYS].sort());
  assert.strictEqual(w.headers["x-tenant-id"], A, "trusted tenant, not the raw inbound header");
  assert.strictEqual(w.userId, "crm-user-1", "actor kept for audit");
  assert.ok(!JSON.stringify(w).includes(TOKEN_MARKER));
  assert.throws(() => reminderBatchService._serviceAuthorityReq(crmHttpReq(), "default"), /requires a tenant/);
});

// ---- 4. eligibility call: internal-only headers whatever req is passed ---------------------------

test("E1 fetchReminderEligibilityBulk sends exactly the internal header set for every caller path", async (t) => {
  const seen = [];
  t.mock.method(axios, "post", async (url, body, opts) => {
    seen.push({ url, headers: opts.headers });
    return { data: { data: { items: body.memberIds.map((m) => ({ memberId: m })) } } };
  });
  const replayed = serviceClient.createInternalWorkerReq(A);
  replayed.headers = { ...replayed.headers, ...legacyHeaders() }; // what the old consumer produced
  const paths = [
    crmHttpReq(), // S1 live CRM HTTP request
    replayed, // S2 old Rabbit replay shape
    serviceClient.createInternalWorkerReq(A), // S3 scheduler / receipt listener
    undefined, // no req
  ];
  for (const req of paths) {
    await serviceClient.fetchReminderEligibilityBulk(["M1"], A, new Date("2026-11-01"), req);
  }
  assert.strictEqual(seen.length, paths.length);
  for (const { url, headers } of seen) {
    assert.match(url, /\/api\/internal\/members\/reminder-eligibility-bulk$/);
    const keys = Object.keys(headers).filter((k) => k !== "x-correlation-id").sort();
    assert.deepStrictEqual(keys, ["Content-Type", "x-internal-request", "x-tenant-id"]);
    assert.strictEqual(headers["x-internal-request"], "true");
    assert.strictEqual(headers["x-tenant-id"], A);
    for (const key of CREDENTIAL_KEYS) assert.strictEqual(headers[key], undefined, key);
  }
  assert.strictEqual(seen[0].headers["x-correlation-id"], "corr-1");
});

test("E2 fetchReminderEligibilityBulk: raw inbound x-tenant-id cannot override; no trusted tenant -> no request", async (t) => {
  let calls2 = 0;
  const seen = [];
  t.mock.method(axios, "post", async (_u, body, opts) => {
    calls2 += 1;
    seen.push(opts.headers["x-tenant-id"]);
    return { data: { data: { items: [] } } };
  });
  await serviceClient.fetchReminderEligibilityBulk(["M1"], A, undefined, { headers: { "x-tenant-id": B } });
  assert.deepStrictEqual(seen, [A]);
  for (const bad of [undefined, "", "default", "unknown", "system"]) {
    await assert.rejects(serviceClient.fetchReminderEligibilityBulk(["M1"], bad, undefined, { headers: { "x-tenant-id": B } }));
  }
  assert.strictEqual(calls2, 1);
});

test("E3 buildInternalServiceHeaders: exact key set, validated tenant", () => {
  const h = serviceClient.buildInternalServiceHeaders(A, { correlationId: "c-1" });
  assert.deepStrictEqual(h, {
    "Content-Type": "application/json",
    "x-tenant-id": A,
    "x-internal-request": "true",
    "x-correlation-id": "c-1",
  });
  assert.deepStrictEqual(Object.keys(serviceClient.buildInternalServiceHeaders(A)).sort(), [
    "Content-Type",
    "x-internal-request",
    "x-tenant-id",
  ]);
  assert.throws(() => serviceClient.buildInternalServiceHeaders("null"), /requires a tenant/);
});

test("S1 source guard: no reminder job publisher copies request headers into a payload", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../jobs/reminderBatch.rabbit.js"), "utf8");
  assert.doesNotMatch(src, /captureForwardHeaders/);
  assert.doesNotMatch(src, /authorization|x-jwt-verified|x-auth-source|x-user-|actorEmail/i);
  const lsrc = fs.readFileSync(require.resolve("../rabbitMQ/listeners/reminderBatch.listener.js"), "utf8");
  assert.doesNotMatch(lsrc, /\.\.\.data\.headers/);
});

test("S2 source guard: each trigger route mounts requireReminderBatchTrigger before its controller", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../routes/reminderBatch.routes.js"), "utf8").replace(/\s+/g, " ");
  for (const handler of ["postCreate", "postMonthlyOrchestrate", "postBuild", "postExecute"]) {
    assert.match(src, new RegExp(`\\.\\.\\.ensureAuthenticatedWithTenantContext, requireReminderBatchTrigger, reminderBatch\\.${handler},? ?\\)`), handler);
  }
});
