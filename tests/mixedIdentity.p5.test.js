// P5 mixed identity: ensureAuthenticatedOrInternal treats a request carrying ANY user identity
// (Authorization, x-jwt-verified, x-auth-source, x-user-*) as that user - never internal - even when it
// also sends x-internal-request (consistent with account-service internalAuth). Genuine internal callers
// (x-internal-request + trusted x-tenant-id, no user identity) are unaffected.
const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");

process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "p5-mixed-identity-secret";
const SECRET = process.env.ACCESS_TOKEN_SECRET;
const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

const { ensureAuthenticatedOrInternal, carriesUserIdentity } = require("../middlewares/auth.mw");
const { createInternalWorkerReq, buildInternalServiceHeaders } = require("../helpers/serviceClient");

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function runAuth(headers) {
  const req = { headers: { ...headers }, params: {}, query: {}, body: {}, method: "GET", originalUrl: "/x" };
  const res = makeRes();
  let nextCalls = 0;
  ensureAuthenticatedOrInternal(req, res, () => { nextCalls += 1; });
  return { req, res, nextCalls };
}

const internal = { "x-internal-request": "true", "x-tenant-id": A };

test("M1 x-internal-request + a VALID CRM bearer is authenticated as that CRM user, not internal", () => {
  const token = jwt.sign({ sub: "crm-1", tenantId: B, userType: "CRM", permissions: [] }, SECRET, { expiresIn: "5m" });
  const { req, nextCalls } = runAuth({ ...internal, authorization: `Bearer ${token}` });
  assert.equal(nextCalls, 1);
  assert.ok(req.user, "user path taken");
  assert.equal(req.user.userType, "CRM");
  assert.equal(req.tenantId, B, "tenant from the verified token, not the internal x-tenant-id header");
});

test("M2 x-internal-request + a VALID PORTAL bearer is that portal user", () => {
  const token = jwt.sign({ sub: "p-1", tenantId: A, userType: "PORTAL" }, SECRET, { expiresIn: "5m" });
  const { req, nextCalls } = runAuth({ ...internal, "x-internal-request": "1", authorization: `Bearer ${token}` });
  assert.equal(nextCalls, 1);
  assert.equal(req.user.userType, "PORTAL");
});

test("M3 x-internal-request + an expired or invalid bearer is rejected (401), never downgraded to internal", () => {
  const expired = jwt.sign({ sub: "crm-1", tenantId: A, userType: "CRM", exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
  for (const authorization of [`Bearer ${expired}`, "Bearer not-a-jwt", "Basic abc"]) {
    const { req, res, nextCalls } = runAuth({ ...internal, authorization });
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 401);
    assert.equal(req.user, undefined);
  }
});

test("M4 x-internal-request + gateway identity headers takes the user (gateway) path", () => {
  const variants = [
    { "x-jwt-verified": "true", "x-auth-source": "gateway" }, // no x-user-id: incomplete identity -> 401
    { "x-jwt-verified": "true" },
    { "x-auth-source": "gateway" },
    { "x-user-id": "crm-1" },
    { "x-user-type": "CRM" },
    { "x-user-permissions": '["*"]' },
    { "X-User-Roles": '["ASU"]' },
  ];
  for (const extra of variants) {
    const { res, nextCalls, req } = runAuth({ ...internal, ...extra });
    assert.ok(nextCalls === 0 || req.user, `${JSON.stringify(Object.keys(extra))}: never internal`);
    if (nextCalls === 0) assert.equal(res.statusCode, 401);
  }
});

test("M5 genuine internal callers are unaffected (internal branch, tenant from x-tenant-id, no req.user)", () => {
  const callers = [
    { name: "user-service membershipCheck", headers: { ...internal } },
    { name: "profile-service subscription client without a req", headers: { "Content-Type": "application/json", ...internal } },
    { name: "profile batch/corn-market with no user (empty Authorization)", headers: { ...internal, authorization: "" } },
    { name: "subscription internal worker req", headers: { ...createInternalWorkerReq(A).headers } },
    { name: "subscription buildInternalServiceHeaders", headers: buildInternalServiceHeaders(A, { correlationId: "c" }) },
  ];
  for (const c of callers) {
    const { req, nextCalls } = runAuth(c.headers);
    assert.equal(nextCalls, 1, c.name);
    assert.equal(req.user, undefined, c.name);
    assert.equal(req.tenantId, A, c.name);
  }
});

test("M6 internal without a trusted tenant still fails closed (400), with or without identity checks", () => {
  const { res, nextCalls } = runAuth({ "x-internal-request": "true" });
  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 400);
});

test("M7 carriesUserIdentity: presence-based, empty values are absent", () => {
  assert.equal(carriesUserIdentity({ headers: {} }), false);
  assert.equal(carriesUserIdentity({ headers: { authorization: "" } }), false);
  assert.equal(carriesUserIdentity({ headers: { "x-user-id": "  " } }), false);
  assert.equal(carriesUserIdentity({ headers: { authorization: "Bearer x" } }), true);
  assert.equal(carriesUserIdentity({ headers: { "x-jwt-verified": "true" } }), true);
  assert.equal(carriesUserIdentity({ headers: { "x-auth-source": "gateway" } }), true);
  assert.equal(carriesUserIdentity({ headers: { "x-user-email": "e" } }), true);
  assert.equal(carriesUserIdentity({ headers: { "x-tenant-id": A, "x-internal-request": "true", "x-correlation-id": "c" } }), false);
});
