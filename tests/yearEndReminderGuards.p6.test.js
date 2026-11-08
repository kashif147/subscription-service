// P6 (2026-11-08): year-end renewal mutations need a finance action authority; the reminder-batch trigger no
// longer accepts accounts.reports:*; the year-end worker path is unchanged and never passes through a user guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const renewalBatchService = require("../services/renewalBatch.service");
const controller = require("../controllers/renewalBatch.controller");
const {
  REMINDER_BATCH_TRIGGER_CLAIMS,
  requireReminderBatchTrigger,
} = require("../middlewares/reminderBatchAuthz.mw");
const { createInternalWorkerReq } = require("../helpers/serviceClient");

const TENANT = "68cbf7806080b4621d469d34";
const caller = (userType, roles, permissions) => ({
  tenantId: TENANT,
  user: userType === undefined ? { roles, permissions } : { userType, roles, permissions },
  roles,
  permissions,
  params: { batchId: "6a1111111111111111111111" },
  body: { fiscalYear: 2025, tenantId: "6acd6119b28a863c61361ae0" },
});
const resMock = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.success = (b) => { r.code = 200; r.body = b; return r; };
  r.serverError = (e) => { r.code = 500; r.body = e; return r; };
  return r;
};

const CALLERS = {
  "ASU (* claim)": [caller("CRM", ["ASU"], ["*"]), true],
  "ASU role, no *": [caller("CRM", [{ code: "ASU" }], ["subscriptions:read"]), true],
  "AM + subscriptions:write": [caller("CRM", ["AM"], ["subscriptions:write"]), true],
  "DAM + payments:write": [caller("CRM", [{ code: "DAM" }], ["payments:write"]), true],
  "AM without a write claim": [caller("CRM", ["AM"], ["payments:read", "subscriptions:read"]), false],
  "MO + subscriptions:write + payments:write": [caller("CRM", ["MO"], ["subscriptions:write", "payments:write"]), false],
  "REO + subscriptions:write": [caller("CRM", ["REO"], ["subscriptions:write", "payments:read"]), false],
  "IRO": [caller("CRM", ["IRO"], ["accounts.reports:read", "issues-ir:write"]), false],
  "PORTAL with AM-like claims": [caller("PORTAL", ["AM"], ["*", "subscriptions:write"]), false],
  "missing userType": [caller(undefined, ["ASU"], ["*"]), false],
};

for (const [route, handler, svc] of [["create", "postCreate", "createRenewalBatch"], ["execute", "postExecute", "requestExecuteRenewalBatch"]]) {
  for (const [label, [req, allowed]] of Object.entries(CALLERS)) {
    test(`year-end ${route}: ${label} -> ${allowed ? "allowed" : "403"}`, async (t) => {
      const calls = [];
      t.mock.method(renewalBatchService, svc, async (r) => { calls.push(r.tenantId); return { ok: true }; });
      const res = resMock();
      await controller[handler](req, res);
      if (allowed) {
        assert.equal(calls.length, 1, "service reached");
        assert.ok([201, 202].includes(res.code));
        assert.deepEqual(calls, [TENANT]); // tenant from the trusted context only, never the body
      } else {
        assert.equal(calls.length, 0, "service never reached");
        assert.equal(res.code, 403);
      }
    });
  }
}

test("year-end READ routes are unchanged in this PR: MO / REO holding subscriptions:write still read", async (t) => {
  t.mock.method(renewalBatchService, "listRenewalYearOptions", async () => []);
  t.mock.method(renewalBatchService, "getRenewalBatchById", async () => ({}));
  for (const req of [caller("CRM", ["MO"], ["subscriptions:write"]), caller("CRM", ["REO"], ["subscriptions:write"])]) {
    for (const h of ["getYearOptions", "getOne"]) {
      const res = resMock();
      await controller[h](req, res);
      assert.equal(res.code, 200, `${h} for ${req.roles[0]}`);
    }
  }
  const res = resMock();
  await controller.getYearOptions(caller("CRM", ["IRO"], ["accounts.reports:read"]), res);
  assert.equal(res.code, 403); // unchanged: no write claim, not ASU
});

// ---- reminder-batch trigger ----
const ACCOUNT_FINANCE_DATA_READ_CLAIMS = ["*", "admin", "payments:*", "payments:read", "accounts.admin:*", "accounts.admin:read"];

test("reminder trigger claim list == account-service FINANCE_DATA_READ_CLAIMS (account develop 63b59ab), no accounts.reports", () => {
  assert.deepEqual([...REMINDER_BATCH_TRIGGER_CLAIMS].sort(), [...ACCOUNT_FINANCE_DATA_READ_CLAIMS].sort());
  assert.ok(!REMINDER_BATCH_TRIGGER_CLAIMS.some((c) => c.startsWith("accounts.reports")));
});

for (const [label, user, ok, code] of [
  ["CRM payments:read", { userType: "CRM", permissions: ["payments:read"] }, true],
  ["CRM accounts.admin:read", { userType: "CRM", permissions: ["accounts.admin:read"] }, true],
  ["CRM ASU *", { userType: "CRM", permissions: ["*"] }, true],
  ["CRM accounts.reports:read only (IRO)", { userType: "CRM", permissions: ["accounts.reports:read"] }, false, "FINANCE_READ_REQUIRED"],
  ["CRM accounts.reports:* only", { userType: "CRM", permissions: ["accounts.reports:*"] }, false, "FINANCE_READ_REQUIRED"],
  ["PORTAL payments:read", { userType: "PORTAL", permissions: ["payments:read", "*"] }, false, "CRM_ONLY"],
  ["missing userType", { permissions: ["payments:read"] }, false, "CRM_ONLY"],
]) {
  test(`reminder trigger: ${label} -> ${ok ? "next" : `403 ${code}`}`, () => {
    let nexted = false;
    const res = resMock();
    requireReminderBatchTrigger({ user, permissions: user.permissions }, res, () => { nexted = true; });
    assert.equal(nexted, ok);
    if (!ok) { assert.equal(res.code, 403); assert.equal(res.body.code, code); }
  });
}

// ---- year-end worker path (separate from the user guard) ----
test("worker path: execute is queued and processed with the service's own authority, never through a user guard", () => {
  const svc = fs.readFileSync(path.join(__dirname, "../services/renewalBatch.service.js"), "utf8");
  const listener = fs.readFileSync(path.join(__dirname, "../rabbitMQ/listeners/renewalBatch.listener.js"), "utf8");
  // the consumer calls the processor with (batchId, tenantId) only - no request / user identity
  assert.match(listener, /await processRenewalBatchExecute\(batchId, tenantId\);/);
  assert.match(svc, /async function processRenewalBatchExecute\(batchId, tenantId\)/);
  // account calls inside the batch (balance snapshots, write-offs) use the internal worker request
  const proc = svc.slice(svc.indexOf("async function writeOffArchivedMemberBalances"), svc.indexOf("function afterStatusForAction"));
  assert.match(proc, /createInternalWorkerReq\(tenantId\)/);
  // the user guards live only in the controller
  assert.doesNotMatch(svc, /ensureYearEnd(Mutation)?Access|renewalBatch\.controller/);
  assert.doesNotMatch(listener, /ensureYearEnd|renewalBatch\.controller/);
});

test("worker request: internal headers + trusted tenant, no user permissions or roles", () => {
  const req = createInternalWorkerReq(TENANT);
  assert.deepEqual(req.headers, { "x-tenant-id": TENANT, "x-internal-request": "true" });
  assert.equal(req.tenantId, TENANT);
  assert.equal(req.permissions, undefined);
  assert.equal(req.user, undefined);
  assert.throws(() => createInternalWorkerReq("default"));
});
