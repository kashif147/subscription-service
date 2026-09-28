"use strict";
// Phase 1A adoption — subscription-service tenant-context guard (WARN MODE).
// Native node:test.  Run: node --test tests/tenantContext.adoption.test.js
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "sub-tenantctx-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const test = require("node:test");
const assert = require("node:assert");
const policyMw = require("@membership/policy-middleware");
const { tenantContextMiddleware } = policyMw;

const TRUSTED = "68cbf7806080b4621d469d34";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantContextWarn = tenantContextMiddleware({ mode: "warn" });

function gatewayReq(o = {}) {
  return {
    method: "GET", url: "/api/v1/subscriptions", originalUrl: "/api/v1/subscriptions",
    headers: { "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": "U1", "x-tenant-id": TRUSTED, ...(o.headers || {}) },
    ctx: o.ctx !== undefined ? o.ctx : { tenantId: TRUSTED, userId: "U1" },
    tenantId: o.tenantId, body: o.body, query: o.query, params: o.params,
  };
}
function mkRes() { const r = { statusCode: null, _s: [] }; r.status = (c) => (r.statusCode = c, r._s.push(c), r); r.json = () => r; return r; }
function run(req) {
  const res = mkRes(); const orig = process.stdout.write.bind(process.stdout); const chunks = [];
  process.stdout.write = (s) => (chunks.push(typeof s === "string" ? s : s.toString()), true);
  let n = 0; try { tenantContextWarn(req, res, () => (n += 1)); } finally { process.stdout.write = orig; }
  const rows = chunks.join("").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { req, res, nextCount: n, rows };
}
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("1 tenantContextWarn is mode=warn; no enforce", () => {
  const a = read(path.join("middlewares", "auth.mw.js"));
  assert.match(a, /tenantContextMiddleware\(\{\s*mode:\s*"warn"\s*\}\)/);
  assert.ok(!/mode:\s*"enforce"/.test(a));
});
test("2 ensureAuthenticatedWithTenantContext = [ensureAuthenticated, tenantContextWarn]", () => {
  const a = read(path.join("middlewares", "auth.mw.js"));
  assert.match(a, /ensureAuthenticatedWithTenantContext\s*=\s*\[\s*ensureAuthenticated\s*,\s*tenantContextWarn\s*\]/);
});
test("3 trusted tenant remains authoritative; next() called", () => { const { req, nextCount, res } = run(gatewayReq()); assert.equal(req.tenantId, TRUSTED); assert.equal(nextCount, 1); assert.equal(res.statusCode, null); });
test("4 query mismatch cannot override trusted tenant", () => { const { req, nextCount } = run(gatewayReq({ query: { tenantId: OTHER } })); assert.equal(req.tenantId, TRUSTED); assert.equal(nextCount, 1); });
test("5 body mismatch cannot override trusted tenant", () => { const { req, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } })); assert.equal(req.tenantId, TRUSTED); assert.equal(nextCount, 1); });
test("6 mismatch emits TenantContextMismatch (mode=warn, outcome=ignored, trusted, suppliedSources); no 403", () => {
  const { rows, res } = run(gatewayReq({ query: { tenantId: OTHER } }));
  const row = rows.find((r) => r.eventType === "TenantContextMismatch");
  assert.ok(row); assert.equal(row.mode, "warn"); assert.equal(row.outcome, "ignored");
  assert.equal(row.trustedTenantId, TRUSTED); assert.ok(row.suppliedSources.includes("query"));
  assert.ok(!res._s.includes(403));
});
test("7 matching tenant emits no mismatch", () => { const { rows } = run(gatewayReq({ body: { tenantId: TRUSTED } })); assert.equal(rows.find((r) => r.eventType === "TenantContextMismatch"), undefined); });
test("8 subscription router: exactly 13 adopted normal-auth points; templates guarded at parent mount", () => {
  const s = read(path.join("routes", "subscription.routes.js"));
  assert.equal((s.match(/\.\.\.ensureAuthenticatedWithTenantContext,/g) || []).length, 13);
  assert.match(s, /router\.use\(\s*"\/templates"\s*,\s*\.\.\.ensureAuthenticatedWithTenantContext\s*,\s*subscriptionFilterTemplateRoutes\s*\)/);
  assert.ok(!/\bensureAuthenticated,/.test(s), "no bare ensureAuthenticated left");
});
test("9 the 3 ensureAuthenticatedOrInternal S2S routes remain excluded", () => {
  const s = read(path.join("routes", "subscription.routes.js"));
  for (const p of ['"/profile/:profileId/current"', '"/profile/:profileId"', '"/internal/profile-merge"']) {
    const i = s.indexOf(p); assert.ok(i > -1, `${p} present`);
    assert.match(s.slice(i, i + 160), /ensureAuthenticatedOrInternal/);
  }
  assert.equal((s.match(/ensureAuthenticatedOrInternal,/g) || []).length, 4); // 1 import + 3 routes
});
test("10 subscription.filter.template.routes.js unchanged (no guard/auth inside)", () => {
  const t = read(path.join("routes", "subscription.filter.template.routes.js"));
  assert.ok(!t.includes("tenantContextWarn") && !t.includes("ensureAuthenticatedWithTenantContext") && !t.includes("ensureAuthenticated"));
});
test("11 reminderBatch: exactly 8 adopted", () => { assert.equal((read(path.join("routes", "reminderBatch.routes.js")).match(/\.\.\.ensureAuthenticatedWithTenantContext,/g) || []).length, 8); });
test("12 renewalBatch: exactly 6 adopted", () => { assert.equal((read(path.join("routes", "renewalBatch.routes.js")).match(/\.\.\.ensureAuthenticatedWithTenantContext,/g) || []).length, 6); });
test("13 auth.routes.js /testing remains unadopted", () => {
  const a = read(path.join("routes", "auth.routes.js"));
  assert.ok(!a.includes("tenantContextWarn") && !a.includes("ensureAuthenticatedWithTenantContext"));
  assert.match(a, /ensureAuthenticated,/);
});
test("14 installed package exposes tenantContextMiddleware + resolveTenantContext", () => {
  assert.equal(typeof policyMw.tenantContextMiddleware, "function");
  assert.equal(typeof policyMw.resolveTenantContext, "function");
});
