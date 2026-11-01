// GET /api/v1/subscriptions/templates/default is read-only: it resolves the user's default view, else
// the system default (tenant-owned first, then the transitional tenantless row), else null (= the
// client's built-in default). It used to persist a blank user view (columns: []) whenever the user had
// no default. Part 1: REAL service + controller, Template write paths stubbed to throw. Part 2: REAL
// service against a throwaway mongod (MONGOD_BIN or `mongod` on PATH; skipped otherwise).
// Run: node --test tests/<this file>
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const Template = require("../models/template.model");
const service = require("../services/subscription.filter.template.service");
const controller = require("../controllers/subscription.filter.template.controller");

const TENANT = "68cbf7806080b4621d469d34";
const OTHER_TENANT = "68ebf0806080b4621d461ae0";
const USER = "700000000000000000000001";

const WRITE_METHODS = ["create", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate", "replaceOne", "bulkWrite", "deleteOne", "deleteMany"];
function stubWrites(t) {
  const calls = [];
  for (const name of WRITE_METHODS) t.mock.method(Template, name, () => { calls.push(name); throw new Error(`write ${name}`); });
  t.mock.method(Template.prototype, "save", () => { calls.push("save"); throw new Error("write save"); });
  return calls;
}
const fakeDoc = (fields) => ({ ...fields, toObject() { return { ...fields }; } });
function stubReads(t, { own = null, tenantDefault = null, sharedDefault = null } = {}) {
  const queries = [];
  t.mock.method(Template, "findOne", async (q) => {
    queries.push(q);
    if (q.userId) return own;
    if (q.systemDefault && q.tenantId) return tenantDefault;
    if (q.systemDefault && q.$or) return sharedDefault;
    return null;
  });
  return queries;
}

test("no user default + no system default: zero writes, null (client built-in default)", async (t) => {
  const writes = stubWrites(t);
  stubReads(t);
  assert.strictEqual(await service.getDefaultTemplate(TENANT, USER), null);
  assert.deepStrictEqual(writes, []);
});

test("no user default: returns the tenant-owned system default, zero writes", async (t) => {
  const writes = stubWrites(t);
  const queries = stubReads(t, {
    tenantDefault: fakeDoc({ _id: "t1", tenantId: TENANT, systemDefault: true, templateType: "members", columns: ["a"], meta: {} }),
    sharedDefault: fakeDoc({ _id: "s1", tenantId: null, systemDefault: true, templateType: "members", columns: ["x"] }),
  });
  const r = await service.getDefaultTemplate(TENANT, USER, "member");
  assert.strictEqual(r._id, "t1");
  assert.strictEqual(r.isDefault, true);
  assert.strictEqual(r.meta, undefined);
  assert.deepStrictEqual(queries[0].templateType, { $in: ["members", "member", "subscription"] });
  assert.strictEqual(queries[0].tenantId, TENANT);
  assert.deepStrictEqual(writes, []);
});

test("falls back to the transitional tenantless system default", async (t) => {
  const writes = stubWrites(t);
  stubReads(t, { sharedDefault: fakeDoc({ _id: "s1", tenantId: null, systemDefault: true, templateType: "members", columns: ["x"] }) });
  const r = await service.getDefaultTemplate(TENANT, USER);
  assert.strictEqual(r._id, "s1");
  assert.deepStrictEqual(writes, []);
});

test("the user's own default view wins", async (t) => {
  const writes = stubWrites(t);
  stubReads(t, { own: fakeDoc({ _id: "u1", tenantId: TENANT, userId: USER, isDefault: true, templateType: "members", columns: ["c"] }) });
  const r = await service.getDefaultTemplate(TENANT, USER);
  assert.strictEqual(r._id, "u1");
  assert.deepStrictEqual(writes, []);
});

test("controller: success(null); type from ?type or ?templateType", async (t) => {
  const writes = stubWrites(t);
  const queries = stubReads(t);
  let sent;
  const res = { success: (d) => { sent = { d }; }, status() { return this; }, json() {}, serverError(e) { throw e; } };
  const req = { user: { userType: "CRM", id: USER }, tenantId: TENANT, query: { templateType: "members" } };
  await controller.getDefaultTemplate(req, res);
  assert.deepStrictEqual(sent, { d: null });
  assert.deepStrictEqual(queries[0].templateType, { $in: ["members", "member", "subscription"] });
  assert.deepStrictEqual(writes, []);
});

const mongodBin =
  process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();

test("real mongod: repeated GET is idempotent, no row and no columns:[] record; never another tenant's default", { skip: !mongodBin && "no mongod binary (set MONGOD_BIN)" }, async () => {
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
    srv.on("error", reject);
  });
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-getdefault-"));
  const mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/tpl-getdefault-test`, { serverSelectionTimeoutMS: 500 });
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.strictEqual(mongoose.connection.readyState, 1, "throwaway mongod did not start");
    const coll = mongoose.connection.db.collection("templates");
    await coll.insertMany([
      { templateType: "members", tenantId: OTHER_TENANT, systemDefault: true, isDefault: false, columns: ["other"], meta: { deleted: false } },
    ]);
    const state = async () => JSON.stringify(await coll.find({}).sort({ _id: 1 }).toArray());
    const before = await state();
    assert.strictEqual(await service.getDefaultTemplate(TENANT, USER), null);
    assert.strictEqual(await service.getDefaultTemplate(TENANT, USER), null);
    assert.strictEqual(await state(), before);
    assert.strictEqual(await coll.countDocuments({ columns: { $size: 0 } }), 0);
  } finally {
    await mongoose.disconnect();
    mongod.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true });
  }
});
