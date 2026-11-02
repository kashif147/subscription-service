// P5 portal object authorization: GET /profile/:profileId[/current] and POST /internal/profile-merge.
// Contract matrix (PDP and the profile-service own-profile lookup are stubbed; no network, no DB).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { createProfileSubscriptionAuthz } = require("../middlewares/profileSubscriptionAuthz.mw");
const { ensureAuthenticatedOrInternal } = require("../middlewares/auth.mw");
const serviceClient = require("../helpers/serviceClient");

const TENANT_1 = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_2 = "cccccccccccccccccccccccc";
const PROFILE_A = "65a000000000000000000001"; // member A, tenant 1
const PROFILE_B = "65a000000000000000000002"; // member B, tenant 1
const PROFILE_C = "65a000000000000000000003"; // member C, tenant 2

// Portal identities -> own profile, as profile-service my-profile would resolve them (tenant-scoped).
const OWN = { [`${TENANT_1}:user-a`]: PROFILE_A, [`${TENANT_1}:user-b`]: PROFILE_B, [`${TENANT_2}:user-c`]: PROFILE_C };

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function portalReq({ userId, tenantId, profileId, permissions = [] }) {
  return {
    headers: {},
    params: { profileId },
    query: {},
    tenantId,
    user: { id: userId, sub: userId, tenantId, userType: "PORTAL", permissions },
    permissions,
  };
}

function crmReq({ profileId, tenantId = TENANT_1, permissions = [] }) {
  return {
    headers: {},
    params: { profileId },
    query: {},
    tenantId,
    user: { id: "crm-1", tenantId, userType: "CRM", permissions },
    permissions,
  };
}

function internalReq({ profileId, tenantId = TENANT_1, extraHeaders = {} } = {}) {
  return {
    headers: { "x-internal-request": "true", "x-tenant-id": tenantId, ...extraHeaders },
    params: profileId ? { profileId } : {},
    query: {},
    body: {},
  };
}

// PDP stub: grants when the caller holds RESOURCE_ACTION (as the real PDP's permission check would).
function stubPdp(calls) {
  return (resource, action) => (req, res, next) => {
    calls.push(`${resource}:${action}`);
    const code = `${resource}_${action}`.toUpperCase();
    if ((req.permissions || []).includes(code)) return next();
    return res.status(403).json({ code: "PERMISSION_DENIED", message: "Insufficient permissions" });
  };
}

function setup() {
  const pdpCalls = [];
  const lookups = [];
  const authz = createProfileSubscriptionAuthz({
    requirePermission: stubPdp(pdpCalls),
    resolveOwnProfileId: async (req) => {
      lookups.push(req.user && req.user.id);
      return OWN[`${req.tenantId}:${req.user && req.user.id}`] || null;
    },
  });
  return { authz, pdpCalls, lookups };
}

async function run(mw, req) {
  const res = makeRes();
  let nextCalls = 0;
  await mw(req, res, () => { nextCalls += 1; });
  return { res, nextCalls };
}

// ---- GET /profile/:profileId[/current] ----

test("P5-1 portal A on own profile is allowed", async () => {
  const { authz } = setup();
  const { res, nextCalls } = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_A }));
  assert.equal(nextCalls, 1);
  assert.equal(res.statusCode, 200);
});

test("P5-2 portal A on B (same tenant) is denied 403 NOT_OWNER", async () => {
  const { authz } = setup();
  const { res, nextCalls } = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_B }));
  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "NOT_OWNER");
});

test("P5-3 portal A on C (other tenant) is denied with the same response (no existence leak)", async () => {
  const { authz } = setup();
  const sameTenant = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_B }));
  const otherTenant = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_C }));
  const nonexistent = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: "65a0000000000000000000ff" }));
  assert.equal(otherTenant.nextCalls, 0);
  assert.equal(otherTenant.res.statusCode, 403);
  assert.deepStrictEqual(otherTenant.res.body, sameTenant.res.body);
  assert.deepStrictEqual(nonexistent.res.body, sameTenant.res.body);
});

test("P5-4 portal holding SUBSCRIPTIONS_READ but not the owner is denied; PDP never consulted for portal", async () => {
  const { authz, pdpCalls } = setup();
  const { res, nextCalls } = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_B, permissions: ["SUBSCRIPTIONS_READ", "*"] }));
  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "NOT_OWNER");
  assert.deepStrictEqual(pdpCalls, []);
});

test("P5-5 portal with no resolvable own profile (unbound / lookup failure) is denied", async () => {
  const authz = createProfileSubscriptionAuthz({
    requirePermission: stubPdp([]),
    resolveOwnProfileId: async () => null,
  });
  const r1 = await run(authz.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-x", tenantId: TENANT_1, profileId: PROFILE_A }));
  assert.equal(r1.nextCalls, 0);
  assert.equal(r1.res.statusCode, 403);

  const throwing = createProfileSubscriptionAuthz({
    requirePermission: stubPdp([]),
    resolveOwnProfileId: async () => { throw new Error("profile-service down"); },
  });
  const r2 = await run(throwing.authorizeProfileSubscriptionRead,
    portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_A }));
  assert.equal(r2.nextCalls, 0);
  assert.equal(r2.res.statusCode, 403);
});

test("P5-6 CRM with subscriptions:read is allowed (PDP consulted with existing code)", async () => {
  const { authz, pdpCalls, lookups } = setup();
  const { nextCalls } = await run(authz.authorizeProfileSubscriptionRead,
    crmReq({ profileId: PROFILE_B, permissions: ["SUBSCRIPTIONS_READ"] }));
  assert.equal(nextCalls, 1);
  assert.deepStrictEqual(pdpCalls, ["subscriptions:read"]);
  assert.deepStrictEqual(lookups, [], "CRM path does not use the portal ownership lookup");
});

test("P5-7 CRM without the permission is denied by the PDP", async () => {
  const { authz } = setup();
  const { res, nextCalls } = await run(authz.authorizeProfileSubscriptionRead,
    crmReq({ profileId: PROFILE_B, permissions: [] }));
  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
});

test("P5-8 unknown / missing userType is denied (fail closed)", async () => {
  const { authz } = setup();
  for (const userType of [undefined, "", "SYSTEM", "crm"]) {
    const req = crmReq({ profileId: PROFILE_A, permissions: ["SUBSCRIPTIONS_READ"] });
    req.user.userType = userType;
    const { res, nextCalls } = await run(authz.authorizeProfileSubscriptionRead, req);
    assert.equal(nextCalls, 0, `userType=${userType}`);
    assert.equal(res.statusCode, 403);
  }
});

test("P5-9 internal callers keep working (incl. those that also forward user headers)", async () => {
  const { authz, pdpCalls, lookups } = setup();
  const variants = [
    {}, // user-service membershipCheck: x-internal-request + x-tenant-id only
    { authorization: "Bearer x" }, // profile-service batch/corn-market/subscription client
    { authorization: "Bearer x", "x-jwt-verified": "true", "x-auth-source": "gateway" }, // events-service
  ];
  for (const extraHeaders of variants) {
    const req = internalReq({ profileId: PROFILE_B, extraHeaders });
    // through the real auth middleware: the internal branch is taken and sets no req.user
    let authed = 0;
    ensureAuthenticatedOrInternal(req, makeRes(), () => { authed += 1; });
    assert.equal(authed, 1);
    assert.equal(req.user, undefined);
    assert.equal(req.tenantId, TENANT_1);
    const { nextCalls } = await run(authz.authorizeProfileSubscriptionRead, req);
    assert.equal(nextCalls, 1);
  }
  assert.deepStrictEqual(pdpCalls, []);
  assert.deepStrictEqual(lookups, []);
});

// ---- POST /internal/profile-merge ----

test("P5-10 profile-merge: internal call (profile-service duplicate merge) is allowed", async () => {
  const { authz } = setup();
  const req = internalReq({ extraHeaders: { authorization: "Bearer x", "x-user-id": "crm-1" } });
  ensureAuthenticatedOrInternal(req, makeRes(), () => {});
  const { nextCalls } = await run(authz.requireInternalOnly, req);
  assert.equal(nextCalls, 1);
});

test("P5-11 profile-merge: portal users never reach it (own or other profile, any permissions)", async () => {
  const { authz, pdpCalls } = setup();
  const req = portalReq({ userId: "user-a", tenantId: TENANT_1, profileId: PROFILE_A, permissions: ["SUBSCRIPTIONS_WRITE", "*"] });
  req.body = { masterProfileId: PROFILE_A, absorbedProfileId: PROFILE_B };
  const { res, nextCalls } = await run(authz.requireInternalOnly, req);
  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "INTERNAL_ONLY");
  assert.deepStrictEqual(pdpCalls, []);
});

test("P5-12 profile-merge: user tokens (CRM, unknown type) are denied; merge is internal-only", async () => {
  const { authz } = setup();
  for (const userType of ["CRM", undefined]) {
    const req = crmReq({ profileId: PROFILE_A, permissions: ["SUBSCRIPTIONS_WRITE"] });
    req.user.userType = userType;
    const { res, nextCalls } = await run(authz.requireInternalOnly, req);
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
  }
});

// ---- own-profile resolver (profile-service my-profile) ----

test("P5-13 own-profile resolver forwards the caller's identity, never x-internal-request, and fails closed", async (t) => {
  const seen = [];
  let reply = { status: 200, data: { status: "success", data: { profileId: PROFILE_A } } };
  t.mock.method(axios, "get", async (url, opts) => { seen.push({ url, headers: opts.headers }); return reply; });
  const req = {
    tenantId: TENANT_1,
    headers: { authorization: "Bearer t", "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": "user-a", "x-user-type": "PORTAL", "x-tenant-id": TENANT_2 },
  };
  assert.equal(await serviceClient.fetchOwnPortalProfileId(req), PROFILE_A);
  assert.match(seen[0].url, /\/api\/profile\/my-profile$/);
  assert.equal(seen[0].headers["x-internal-request"], undefined);
  assert.equal(seen[0].headers.authorization, "Bearer t");
  assert.equal(seen[0].headers["x-tenant-id"], TENANT_1, "trusted tenant, not the raw inbound header");

  reply = { status: 200, data: { data: null, message: "Profile not found" } };
  assert.equal(await serviceClient.fetchOwnPortalProfileId(req), null);
  reply = { status: 403, data: {} };
  assert.equal(await serviceClient.fetchOwnPortalProfileId(req), null);
  t.mock.method(axios, "get", async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(await serviceClient.fetchOwnPortalProfileId(req), null);
  assert.equal(await serviceClient.fetchOwnPortalProfileId({ headers: {} }), null, "no trusted tenant -> null");
});

// ---- wiring ----

test("P5-14 routes: guards wired on exactly the three ensureAuthenticatedOrInternal routes", () => {
  const s = fs.readFileSync(path.join(__dirname, "..", "routes", "subscription.routes.js"), "utf8");
  const block = (p) => { const i = s.indexOf(p); assert.ok(i > -1, p); return s.slice(i, s.indexOf(");", i)); };
  for (const p of ['"/profile/:profileId/current"', '"/profile/:profileId",']) {
    assert.match(block(p), /ensureAuthenticatedOrInternal,\s*authorizeProfileSubscriptionRead,/);
  }
  assert.match(block('"/internal/profile-merge"'), /ensureAuthenticatedOrInternal,\s*requireInternalOnly,\s*mergeProfilesInternal/);
  assert.equal((s.match(/authorizeProfileSubscriptionRead,/g) || []).length, 3); // import + 2 routes
  assert.equal((s.match(/requireInternalOnly,/g) || []).length, 2); // import + 1 route
});
