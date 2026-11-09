// P6 class C: subscription mutations (7 PUT routes) need PDP subscriptions:write, then ASU or MO + the claim.
// PDP stubbed (no network, no DB). Run: node --test tests/subscriptionWriteGuards.p6.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { createSubscriptionWriteAuthz } = require("../middlewares/subscriptionWriteAuthz.mw");

function makeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const req = ({ userType = "CRM", roles = [], permissions = [] }) => ({
  headers: {}, params: {}, query: {}, tenantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  user: userType ? { id: "u", tenantId: "aaaaaaaaaaaaaaaaaaaaaaaa", userType, roles, permissions } : { id: "u" },
  roles, permissions,
});

// Real-PDP-like stub: CRM audience; ASU own-tenant rule; otherwise the exact claim.
const realisticPdp = (calls) => (resource, action) => (r, res, next) => {
  calls.push(`${resource}:${action}`);
  const ok = r.user?.userType === "CRM" && ((r.roles || []).some((x) => (x?.code || x) === "ASU") || (r.permissions || []).includes(`${resource}:${action}`) || (r.permissions || []).includes("*"));
  return ok ? next() : res.status(403).json({ code: "PERMISSION_DENIED" });
};
// Simulates any PDP PERMIT (e.g. a role that still carries the code): the local guard must still hold.
const permitAllPdp = (calls) => (resource, action) => (r, res, next) => { calls.push(`${resource}:${action}`); next(); };

async function runChain(chain, r) {
  const res = makeRes();
  let reached = false;
  const step = async (i) => {
    if (i === chain.length) { reached = true; return; }
    await chain[i](r, res, () => step(i + 1));
  };
  await step(0);
  return { reached, status: reached ? 200 : res.statusCode, code: res.body?.code };
}

const CALLERS = {
  "ASU + REO (no claims)": [{ roles: ["ASU", "REO"] }, true],
  "ASU + BO/IRO/REO/RO with *": [{ roles: ["ASU", "BO", "IRO", "REO", "RO"], permissions: ["*"] }, true],
  "MO + IRO with subscriptions:write": [{ roles: ["IRO", "MO"], permissions: ["subscriptions:write", "subscriptions:read"] }, true],
  "MO as a role object { code } (token shape)": [{ roles: [{ id: "r1", code: "MO", name: "Membership Officer" }], permissions: ["subscriptions:write"] }, true],
  "REO as a role object with the claim": [{ roles: [{ id: "r2", code: "REO", name: "Regional Executive Officer" }], permissions: ["subscriptions:write"] }, false],
  "REO with subscriptions:write": [{ roles: ["REO"], permissions: ["subscriptions:read", "subscriptions:write", "transferRequests:write"] }, false],
  "MO without the claim": [{ roles: ["MO"], permissions: ["subscriptions:read"] }, false],
  "AM with subscriptions:write": [{ roles: ["AM"], permissions: ["subscriptions:write"] }, false],
  "PSG-CRM (no claims)": [{ roles: ["PSG-CRM"] }, false],
  "IRO": [{ roles: ["IRO"], permissions: ["accounts.reports:read"] }, false],
  "PORTAL MEMBER with subscriptions:write": [{ userType: "PORTAL", roles: ["MEMBER"], permissions: ["subscriptions:write"] }, false],
  "missing userType with *": [{ userType: null, roles: ["ASU"], permissions: ["*"] }, false],
};

test("realistic PDP: ASU (incl. ASU+REO) and MO + subscriptions:write pass; REO, MO without claim, AM, PSG-CRM, IRO, PORTAL, missing userType refused", async () => {
  const calls = [];
  const { requireSubscriptionWrite } = createSubscriptionWriteAuthz({ requirePermission: realisticPdp(calls) });
  for (const [label, [opts, allowed]] of Object.entries(CALLERS)) {
    const r = await runChain(requireSubscriptionWrite, req(opts));
    assert.strictEqual(r.reached, allowed, `${label}: reached=${r.reached} ${r.status} ${r.code}`);
    if (!allowed) assert.strictEqual(r.status, 403, label);
  }
  assert.ok(calls.every((c) => c === "subscriptions:write"));
});

test("PDP PERMITs everyone: the local guard alone keeps REO read-only and refuses non-CRM", async () => {
  const { requireSubscriptionWrite } = createSubscriptionWriteAuthz({ requirePermission: permitAllPdp([]) });
  for (const [label, [opts, allowed]] of Object.entries(CALLERS)) {
    const r = await runChain(requireSubscriptionWrite, req(opts));
    assert.strictEqual(r.reached, allowed, `${label}: reached=${r.reached} ${r.status} ${r.code}`);
  }
  const reo = await runChain(requireSubscriptionWrite, req(CALLERS["REO with subscriptions:write"][0]));
  assert.strictEqual(reo.code, "SUBSCRIPTION_WRITER_REQUIRED");
  const portal = await runChain(requireSubscriptionWrite, req(CALLERS["PORTAL MEMBER with subscriptions:write"][0]));
  assert.strictEqual(portal.code, "CRM_ONLY");
});

test("routes: all 7 PUT mutations (incl. the legacy by-profile ones) carry requireSubscriptionWrite before the controller; reads, filter, templates and the internal merge do not", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "subscription.routes.js"), "utf8");
  const guarded = [
    ['"/:subscriptionId/resign"', "resignMembershipBySubscriptionId"],
    ['"/:subscriptionId/undo-resign"', "undoResignMembershipBySubscriptionId"],
    ['"/:subscriptionId"', "updateSubscriptionById"],
    ['"/resign/:profileId"', "resignMembership"],
    ['"/cancel/:profileId"', "cancelMembership"],
    ['"/undo-resign/:profileId"', "undoResignMembership"],
    ['"/undo-cancel/:profileId"', "undoCancelMembership"],
  ];
  for (const [route, handler] of guarded) {
    const re = new RegExp(`router\\.put\\(\\s*${route.replace(/[/.]/g, "\\$&")},\\s*\\.\\.\\.ensureAuthenticatedWithTenantContext,\\s*\\.\\.\\.requireSubscriptionWrite,\\s*${handler}\\b`);
    assert.match(src, re, `${route} -> ${handler}`);
  }
  assert.strictEqual((src.match(/router\.put\(/g) || []).length, 8, "7 mutations + PUT /filter");
  assert.match(src, /router\.put\("\/filter", \.\.\.ensureAuthenticatedWithTenantContext, getSubscriptionsWithTemplate\)/);
  for (const line of src.split("\n").filter((l) => /router\.(get|post|use)\(/.test(l))) assert.ok(!line.includes("requireSubscriptionWrite"), line);
  // The GET / POST blocks spanning several lines: no guard between their first line and handler.
  assert.ok(!/"\/internal\/profile-merge",[^)]*requireSubscriptionWrite/.test(src));
  assert.ok(!/"\/profile\/:profileId(\/current)?",[^)]*requireSubscriptionWrite/.test(src));
});
