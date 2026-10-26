// Phase A / A2 — subscription-service event consumers are bound to the event tenant.
//  - reminder comms: batch member + subscription are loaded with { _id, tenantId }; a record of another
//    tenant is "not found" (no publish, no update); missing/mismatched tenant is quarantined.
//  - subscription upsert: every Subscription read/write in the listener carries the event tenant
//    (no findById, no profileId-only updateMany).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const MEMBER = "6a2222222222222222222222";
const SUB = "6a3333333333333333333333";

const ReminderBatchMember = require("../models/reminderBatchMember.model");
const Subscription = require("../models/subscription.model");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { handleReminderCommsRequested } = require("../rabbitMQ/listeners/reminderBatch.listener");
const { EventTenantMismatchError, EventTenantMissingError } = require("../helpers/eventTenant");

// In-memory owner-aware store: a record is returned only when the filter's tenant matches its owner.
const memberRow = { _id: MEMBER, tenantId: A, subscriptionId: SUB, memberId: "M1" };
const subRow = { _id: SUB, tenantId: A, userId: "U1" };
const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
const calls = { memberFind: [], subFind: [], update: [], publish: [] };
ReminderBatchMember.findOne = (f) => (calls.memberFind.push(f), lean(String(f._id) === MEMBER && f.tenantId === A ? memberRow : null));
ReminderBatchMember.findById = () => { throw new Error("findById must not be used (tenant binding)"); };
ReminderBatchMember.updateOne = async (f) => { calls.update.push(f); return { matchedCount: f.tenantId === A ? 1 : 0 }; };
Subscription.findOne = (f) => (calls.subFind.push(f), lean(String(f._id) === SUB && f.tenantId === A ? subRow : null));
Subscription.findById = () => { throw new Error("findById must not be used (tenant binding)"); };
publisher.publish = async (...args) => { calls.publish.push(args); return { success: true }; };
const reset = () => Object.keys(calls).forEach((k) => (calls[k] = []));
const evt = (tenantId, data = {}) => ({ eventId: "e1", tenantId, data: { batchMemberId: MEMBER, tier: "R1", tenantId, ...data } });

test("valid tenant: member + subscription of that tenant -> notification published, row marked", async () => {
  reset();
  await handleReminderCommsRequested(evt(A));
  assert.deepStrictEqual(calls.memberFind[0], { _id: MEMBER, tenantId: A });
  assert.deepStrictEqual(calls.subFind[0], { _id: SUB, tenantId: A });
  assert.strictEqual(calls.publish.length, 1);
  assert.strictEqual(calls.publish[0][2].tenantId, A);
  assert.deepStrictEqual(calls.update[0], { _id: MEMBER, tenantId: A });
});

test("same batch-member id under another tenant's event: no publish, no update", async () => {
  reset();
  await handleReminderCommsRequested(evt(B));
  assert.deepStrictEqual(calls.memberFind[0], { _id: MEMBER, tenantId: B });
  assert.strictEqual(calls.publish.length, 0);
  assert.strictEqual(calls.update.length, 0);
});

test("missing tenant: quarantined (throws -> DLQ), nothing read or written", async () => {
  reset();
  await assert.rejects(() => handleReminderCommsRequested({ eventId: "e", data: { batchMemberId: MEMBER } }), EventTenantMissingError);
  assert.strictEqual(calls.memberFind.length + calls.publish.length + calls.update.length, 0);
});

test("mismatched tenant (envelope A, data B): quarantined, nothing read or written", async () => {
  reset();
  await assert.rejects(() => handleReminderCommsRequested(evt(A, { tenantId: B })), EventTenantMismatchError);
  assert.strictEqual(calls.memberFind.length + calls.publish.length + calls.update.length, 0);
});

test("malformed batchMemberId: skipped without a throw", async () => {
  reset();
  await handleReminderCommsRequested(evt(A, { batchMemberId: "not-an-id" }));
  assert.strictEqual(calls.memberFind.length + calls.publish.length, 0);
});

test("upsert listener: every Subscription query/update carries the event tenant", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "rabbitMQ", "listeners", "subscription.upsert.listener.js"), "utf8");
  assert.ok(!/Subscription\.findById\(/.test(src), "no findById in the upsert listener");
  const re = /Subscription\.(find|findOne|updateOne|updateMany|findOneAndUpdate)\(\s*(\{[\s\S]*?\})/g;
  let m, n = 0;
  while ((m = re.exec(src))) {
    n++;
    const firstArg = m[2];
    assert.ok(/tenantId/.test(firstArg) || /\.\.\.baseQuery, tenantId/.test(firstArg), `unscoped Subscription.${m[1]}: ${firstArg.slice(0, 80)}`);
  }
  assert.ok(n >= 9, `expected >= 9 scoped Subscription calls, saw ${n}`);
  assert.ok(!/ignore tenantId/.test(src));
});
