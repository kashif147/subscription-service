// POST /api/v1/subscriptions/batch-subscription-status must only ever read the caller's trusted
// tenant (req.tenantId): a profile with no subscription in that tenant returns null, never another
// tenant's status (no cross-tenant fallback query).
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Subscription = require("../models/subscription.model");
const { getBatchSubscriptionStatus } = require("../controllers/subscription.controller");
const { USER_TYPE } = require("../constants/enums");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const P_A_ACTIVE = "a00000000000000000000001";
const P_A_NONE = "a00000000000000000000002";
const P_B_ACTIVE = "b00000000000000000000001";
const P_MISSING = "c00000000000000000000001";

const ROWS = [
  { tenantId: A, profileId: new mongoose.Types.ObjectId(P_A_ACTIVE), subscriptionStatus: "Active", createdAt: new Date("2026-01-01") },
  { tenantId: B, profileId: new mongoose.Types.ObjectId(P_B_ACTIVE), subscriptionStatus: "Resigned", createdAt: new Date("2026-01-01") },
];

// In-memory Subscription.find honouring the tenantId and profileId filters of the query it gets.
function mockFind(t) {
  const queries = [];
  t.mock.method(Subscription, "find", (query) => {
    queries.push(query);
    const ids = (query.profileId?.$in || []).map(String);
    const rows = ROWS.filter(
      (r) => ids.includes(String(r.profileId)) && (query.tenantId === undefined || r.tenantId === query.tenantId),
    );
    const chain = { select: () => chain, lean: async () => rows.map((r) => ({ ...r })) };
    return chain;
  });
  return queries;
}

function crmReq(tenantId, profileIds, extra = {}) {
  return {
    tenantId,
    user: { userType: USER_TYPE.CRM, tenantId },
    headers: extra.headers || {},
    query: extra.query || {},
    body: { profileIds, ...(extra.body || {}) },
  };
}

function fakeRes() {
  const res = { statusCode: 200, payload: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (p) => ((res.payload = p), res);
  res.success = (d) => ((res.payload = { status: "success", data: d }), res);
  res.fail = (m) => ((res.statusCode = 400), (res.payload = { status: "fail", data: m }), res);
  res.serverError = (e) => ((res.statusCode = 500), (res.payload = { error: String(e) }), res);
  return res;
}

const statuses = (res) => Object.fromEntries(res.payload.data.data.map((r) => [r.profileId, r.subscriptionStatus]));

test("A: same-tenant profile with a subscription returns its status", async (t) => {
  mockFind(t);
  const res = fakeRes();
  await getBatchSubscriptionStatus(crmReq(A, [P_A_ACTIVE]), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(statuses(res), { [P_A_ACTIVE]: "Active" });
});

test("B: same-tenant profile without a subscription returns null", async (t) => {
  mockFind(t);
  const res = fakeRes();
  await getBatchSubscriptionStatus(crmReq(A, [P_A_NONE]), res);
  assert.deepEqual(statuses(res), { [P_A_NONE]: null });
});

test("C: a foreign tenant's profile with a real subscription returns null (no cross-tenant fallback)", async (t) => {
  const queries = mockFind(t);
  const res = fakeRes();
  await getBatchSubscriptionStatus(crmReq(A, [P_B_ACTIVE]), res);
  assert.deepEqual(statuses(res), { [P_B_ACTIVE]: null }, "tenant A must never see tenant B's status");
  assert.ok(queries.length >= 1);
  for (const q of queries) assert.equal(q.tenantId, A, "every lookup is scoped to the trusted tenant");
});

test("D: mixed batch - own status, foreign null, nonexistent null", async (t) => {
  const queries = mockFind(t);
  const res = fakeRes();
  await getBatchSubscriptionStatus(crmReq(A, [P_A_ACTIVE, P_B_ACTIVE, P_MISSING]), res);
  assert.deepEqual(statuses(res), { [P_A_ACTIVE]: "Active", [P_B_ACTIVE]: null, [P_MISSING]: null });
  for (const q of queries) assert.equal(q.tenantId, A);
});

test("E: spoofed query/body/header tenant values cannot change the trusted tenant scope", async (t) => {
  const queries = mockFind(t);
  const res = fakeRes();
  const req = crmReq(A, [P_B_ACTIVE], { headers: { "x-tenant-id": B }, query: { tenantId: B }, body: { tenantId: B } });
  await getBatchSubscriptionStatus(req, res);
  assert.deepEqual(statuses(res), { [P_B_ACTIVE]: null });
  for (const q of queries) assert.equal(q.tenantId, A, "only req.tenantId (trusted) scopes the lookup");
});

test("no trusted tenant fails closed without any lookup", async (t) => {
  const queries = mockFind(t);
  const res = fakeRes();
  await getBatchSubscriptionStatus(crmReq(undefined, [P_B_ACTIVE]), res);
  assert.equal(res.statusCode, 403);
  assert.equal(queries.length, 0);
});
