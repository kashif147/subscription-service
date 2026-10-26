// Phase A / A3 — subscription request tenant enforcement (Stage 1 warn -> Stage 2 enforce).
// The expectations follow helpers/requestTenant ENFORCEMENT, so this file covers both stages.
const test = require("node:test");
const assert = require("node:assert");

const A = "68cbf7806080b4621d469d34";
const { ENFORCEMENT, resolveRequestTenant } = require("../helpers/requestTenant");
const { ensureAuthenticatedOrInternal } = require("../middlewares/auth.mw");
const enforce = ENFORCEMENT === "enforce";

const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
let warns = [];
const origWarn = console.warn;
test.beforeEach(() => { warns = []; console.warn = (...a) => warns.push(a); });
test.afterEach(() => { console.warn = origWarn; });

test("internal call with a trusted tenant: tenant pinned from x-tenant-id, no warning", () => {
  const req = { headers: { "x-internal-request": "true", "x-tenant-id": A }, method: "GET", originalUrl: "/api/v1/subscriptions/profile/x" };
  let nexted = false;
  ensureAuthenticatedOrInternal(req, mkRes(), () => { nexted = true; });
  assert.ok(nexted);
  assert.strictEqual(req.tenantId, A);
  assert.strictEqual(req.ctx.tenantId, A);
  assert.strictEqual(warns.length, 0);
});

for (const t of [undefined, "", "  ", "default", "unknown"]) {
  test(`internal call with tenant ${JSON.stringify(t)}: logged; ${enforce ? "400 fail-closed" : "legacy pass-through (stage 1)"}`, () => {
    const req = { headers: { "x-internal-request": "true", ...(t === undefined ? {} : { "x-tenant-id": t }) }, method: "GET", originalUrl: "/api/v1/subscriptions/profile/x?y=1", socket: { remoteAddress: "172.18.0.9" } };
    const res = mkRes();
    let nexted = false;
    ensureAuthenticatedOrInternal(req, res, () => { nexted = true; });
    assert.strictEqual(String(warns[0]?.[0]).includes("SubscriptionTenantMissing"), true);
    assert.strictEqual(warns[0][1].path, "/api/v1/subscriptions/profile/x");
    assert.strictEqual(warns[0][1].remoteAddress, "172.18.0.9");
    if (enforce) {
      assert.strictEqual(nexted, false);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.code, "TENANT_REQUIRED");
    } else {
      assert.strictEqual(nexted, true);
    }
  });
}

test("controller scope: valid tenant -> scoped", () => {
  const r = resolveRequestTenant({ tenantId: A }, mkRes(), "site");
  assert.deepStrictEqual(r, { proceed: true, tenantId: A });
});

test(`controller scope: no tenant -> ${enforce ? "403, not proceeded" : "logged, legacy (stage 1)"}`, () => {
  const res = mkRes();
  const r = resolveRequestTenant({ headers: {}, method: "GET", originalUrl: "/x" }, res, "site");
  assert.ok(String(warns[0]?.[0]).includes("SubscriptionTenantMissing"));
  if (enforce) {
    assert.deepStrictEqual(r, { proceed: false, tenantId: null });
    assert.strictEqual(res.statusCode, 403);
  } else {
    assert.deepStrictEqual(r, { proceed: true, tenantId: null });
  }
});

test("controller source: no conditional tenant filter remains", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "controllers", "subscription.controller.js"), "utf8");
  assert.ok(!/if \(req\.tenantId\)/.test(src));
  assert.strictEqual((src.match(/resolveRequestTenant\(req, res, "/g) || []).length, 7);
});
