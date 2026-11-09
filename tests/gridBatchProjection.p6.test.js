// P6 / account-service #47: the CRM subscription grid (real getSubscriptions controller, real serviceClient helpers)
// gives the same rows when account-service POST /api/payments/batch returns only its 7 projected fields
// (_id, memberId, purpose, amount, currency, status, createdAt) as when it returned full payment documents.
// Subscription / User models and outbound HTTP (axios.post) are faked; no DB, no network.
// Run: node --test tests/gridBatchProjection.p6.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const axios = require("axios");

const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const { getSubscriptions } = require("../controllers/subscription.controller");
const { USER_TYPE } = require("../constants/enums");

const T = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PROFILES = [
  { _id: "65a000000000000000000001", membershipNumber: "M-1001", personalInfo: { forename: "A", surname: "One" } },
  { _id: "65a000000000000000000002", membershipNumber: "M 1002", personalInfo: { forename: "B", surname: "Two" } },
  { _id: "65a000000000000000000003", membershipNumber: "m-1003", personalInfo: { forename: "C", surname: "Three" } },
  { _id: "65a000000000000000000004", membershipNumber: "M-1004", personalInfo: { forename: "D", surname: "Four" } }, // no payments
];
const CATS = ["Full time", "PART_TIME", "Student", "General all grade"];
const SUBS = PROFILES.map((p, i) => ({
  _id: new mongoose.Types.ObjectId(`66b00000000000000000000${i + 1}`), tenantId: T, profileId: new mongoose.Types.ObjectId(p._id),
  subscriptionYear: 2026, isCurrent: true, subscriptionStatus: "Active", membershipCategory: CATS[i], createdAt: new Date(`2026-0${i + 1}-01`),
}));
const MEMBER_IDS = ["M-1001", "m-1001", "M1002", " M 1002 ", "M-1003", "X-9"];
const PURPOSES = ["subscriptionFee", "applicationFee", "eventFee"];
const FULL = Array.from({ length: 24 }, (_, i) => ({
  _id: `pay${i}`, tenantId: T, memberId: MEMBER_IDS[i % MEMBER_IDS.length], purpose: PURPOSES[i % 3], amount: [4500, 2700, 12345, 0][i % 4],
  currency: "eur", status: "succeeded", createdAt: new Date(Date.UTC(2026, i % 12, 1 + (i % 27))).toISOString(),
  stripe: { paymentIntentId: `pi_${i}`, customerId: "cus_x", clientSecret: "secret_x" }, payer: { userId: "u", email: "x@example.test" },
  metadata: { k: i }, audit: { createdBy: "u" }, applicationId: `app${i}`, mode: "stripe", attemptNumber: 1,
}));
const FIELDS = ["_id", "memberId", "purpose", "amount", "currency", "status", "createdAt"];
const PROJECTED = FULL.map((d) => Object.fromEntries(FIELDS.map((k) => [k, d[k]])));

function crmReq() {
  return {
    headers: { authorization: "Bearer crm-token", "x-tenant-id": T },
    query: {}, params: {}, tenantId: T,
    user: { id: "crm-1", userType: USER_TYPE.CRM, tenantId: T, roles: [{ code: "ASU" }], permissions: ["*"] },
  };
}
function makeRes() {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (p) => ((res.payload = p), res);
  res.success = (d) => ((res.payload = { status: "success", data: d }), res);
  res.fail = (m) => ((res.statusCode = 400), (res.payload = { status: "fail", data: m }), res);
  res.serverError = (e) => ((res.statusCode = 500), (res.payload = { error: String(e) }), res);
  return res;
}

async function runGrid(t, batchRows) {
  const calls = [];
  t.mock.method(Subscription, "find", () => ({ sort: () => ({ lean: async () => SUBS.map((s) => ({ ...s })) }) }));
  t.mock.method(User, "findOne", () => ({ lean: async () => null }));
  t.mock.method(User, "findById", () => ({ lean: async () => null }));
  t.mock.method(axios, "post", async (url, body, opts) => {
    calls.push({ url, body, headers: opts && opts.headers });
    if (url.endsWith("/api/profile/batch")) return { status: 200, data: { data: PROFILES.map((p) => ({ ...p })) } };
    if (url.endsWith("/api/reports/members/summary-batch")) return { status: 200, data: { data: [] } }; // forces the payment fallback
    if (url.endsWith("/api/payments/batch")) return { status: 200, data: { data: batchRows.map((r) => ({ ...r })) } };
    return { status: 200, data: { data: [] } };
  });
  const origLog = console.log; console.log = () => {};
  const res = makeRes();
  try { await getSubscriptions(crmReq(), res); } finally { console.log = origLog; }
  return { res, calls };
}

const financial = (res) => res.payload.data.data.map((r) => [String(r.profileId), r.membershipNumber, r.financialDetails || r.subscriptionDetails || null]);

test("real grid controller: 7-field batch response gives the same rows as full payment documents", async (t) => {
  const full = await runGrid(t, FULL);
  t.mock.restoreAll();
  const projected = await runGrid(t, PROJECTED);
  assert.equal(full.res.statusCode, 200);
  assert.equal(projected.res.statusCode, 200);
  assert.equal(projected.res.payload.data.count, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(projected.res.payload)), JSON.parse(JSON.stringify(full.res.payload)), "whole grid response identical");

  // The fallback really ran and produced payment-derived figures.
  const batch = projected.calls.filter((c) => c.url.endsWith("/api/payments/batch"));
  assert.equal(batch.length, 1, "payments batch called once");
  assert.equal(batch[0].headers.Authorization || batch[0].headers.authorization, "Bearer crm-token", "CRM identity forwarded");
  const rows = projected.res.payload.data.data;
  const withPayment = rows.filter((r) => JSON.stringify(r).includes("lastPaymentAmount") && /"lastPaymentAmount":\d/.test(JSON.stringify(r)));
  assert.ok(withPayment.length >= 3, `payment figures present for paying members (got ${withPayment.length})`);
  const noPay = rows.find((r) => r.membershipNumber === "M-1004");
  assert.ok(!/"lastPaymentAmount":\d/.test(JSON.stringify(noPay)), "member without payments has no last payment");
});
