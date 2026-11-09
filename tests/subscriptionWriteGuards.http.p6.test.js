// P6: subscription mutations over HTTP through the REAL router and REAL gateway-header authentication, with callers in
// the real token format: x-user-roles = the token's role objects {id, code, name} (the gateway forwards payload.roles
// as-is) and x-user-permissions = lower-cased claims (user-service generateToken). The PDP is a fake header-path
// service modelled on user-service (CRM audience; ASU own-tenant rule; else the exact claim, case-insensitive). Like
// user-service's header path, a PERMIT returns the user rebuilt from the same headers; policy-middleware then sets
// req.user / req.roles / req.permissions from it, which is what the local writer step reads.
// Controllers are sentinels. Run: node --test tests/subscriptionWriteGuards.http.p6.test.js
const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "sub-p6-http-"));
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const pdpCalls = [];
const pdp = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const perm = `${body.resource}:${body.action}`.toLowerCase();
    const rawRoles = JSON.parse(req.headers["x-user-roles"] || "[]");
    const rawPerms = JSON.parse(req.headers["x-user-permissions"] || "[]");
    const roles = rawRoles.map((r) => (typeof r === "string" ? r : r && r.code));
    const perms = rawPerms.map((p) => String(p).toLowerCase());
    pdpCalls.push(perm);
    const permit = req.headers["x-user-type"] === "CRM" && (roles.includes("ASU") || perms.includes(perm));
    res.writeHead(permit ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(permit ? { success: true, decision: "PERMIT", user: { id: req.headers["x-user-id"], tenantId: req.headers["x-tenant-id"], userType: req.headers["x-user-type"], roles: rawRoles, permissions: rawPerms } } : { success: false, decision: "DENY", reason: "TEST_PDP_DENY" }));
  });
});
const PDP_PORT = 20000 + Math.floor(Math.random() * 30000);
pdp.listen(PDP_PORT, "127.0.0.1");
pdp.unref();
process.env.POLICY_SERVICE_URL = `http://127.0.0.1:${PDP_PORT}`;

const sentinel = new Proxy({}, { get: (_t, key) => (key === "__esModule" ? false : (req, res) => res.status(200).json({ reached: String(key) })) });
for (const rel of ["../controllers/subscription.controller", "../controllers/profileMerge.controller"]) {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports: sentinel };
}
const routes = require("../routes/subscription.routes");

const T = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SUB = "66b000000000000000000001";
const PROF = "65a000000000000000000001";
const role = (code) => ({ id: `r-${code}`, code, name: code });
const caller = (id, userType, codes, perms) => ({
  "x-jwt-verified": "true", "x-auth-source": "gateway", "x-tenant-id": T, "x-user-id": id, "x-user-type": userType,
  "x-user-roles": JSON.stringify(codes.map(role)), "x-user-permissions": JSON.stringify(perms),
});
// Live-like claim sets (lower-cased as issued).
const REO_PERMS = ["subscriptions:read", "subscriptions:write", "transferrequests:read", "transferrequests:write", "payments:read"];
const CALLERS = [
  ["MO only, with subscriptions:write", caller("mo", "CRM", ["MO"], ["subscriptions:read", "subscriptions:write"]), true],
  ["MO + REO, with subscriptions:write", caller("mo-reo", "CRM", ["MO", "REO"], REO_PERMS), true],
  ["MO + REO, without subscriptions:write", caller("mo-reo-nw", "CRM", ["MO", "REO"], ["subscriptions:read", "payments:read"]), false],
  ["REO only (live REO carries subscriptions:write)", caller("reo", "CRM", ["REO"], REO_PERMS), false],
  ["ASU + REO (token *)", caller("asu-reo", "CRM", ["ASU", "REO"], ["*"]), true],
  ["PSG-CRM (no claims)", caller("psg", "CRM", ["PSG-CRM"], []), false],
  ["PORTAL MEMBER with subscriptions:write", caller("portal", "PORTAL", ["MEMBER"], ["subscriptions:write"]), false],
];
const MUTATIONS = [
  `/${SUB}/resign`, `/${SUB}/undo-resign`, `/${SUB}`, `/resign/${PROF}`, `/cancel/${PROF}`, `/undo-resign/${PROF}`, `/undo-cancel/${PROF}`,
];

let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/subscriptions", routes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api/v1/subscriptions`;
});
test.after(() => server && server.close());

async function put(url, headers) {
  const origLog = console.log, origWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const r = await fetch(base + url, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  } finally { console.log = origLog; console.warn = origWarn; }
}

for (const [label, headers, allowed] of CALLERS) {
  test(`${allowed ? "allowed" : "refused"}: ${label} on all 7 mutations`, async () => {
    for (const url of MUTATIONS) {
      const r = await put(url, headers);
      if (allowed) {
        assert.equal(r.status, 200, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(r.body && r.body.reached, url);
      } else {
        assert.equal(r.status, 403, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(!(r.body && r.body.reached), url);
      }
    }
  });
}

test("REO-only is refused by the local step after a PDP PERMIT (SUBSCRIPTION_WRITER_REQUIRED)", async () => {
  const before = pdpCalls.length;
  // fresh caller id: the policy client caches decisions for 5 minutes per identity
  const r = await put(`/${SUB}`, caller("reo-fresh", "CRM", ["REO"], REO_PERMS));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "SUBSCRIPTION_WRITER_REQUIRED");
  assert.deepEqual(pdpCalls.slice(before), ["subscriptions:write"]);
});

test("reads are unchanged: REO-only can still GET a subscription and list", async () => {
  const origLog = console.log; console.log = () => {};
  try {
    for (const url of [`/${SUB}`, "/"]) {
      const r = await fetch(base + url, { headers: CALLERS[3][1] });
      assert.equal(r.status, 200, url);
    }
  } finally { console.log = origLog; }
});
