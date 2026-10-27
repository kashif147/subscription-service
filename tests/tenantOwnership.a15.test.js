// Phase A / A15 - tenant ownership immutability (models/plugins/tenantOwnership.plugin.js) on the
// adopted Subscription and ReminderBatchMember models. Native node:test; no database (a rejected write
// fails in middleware before a connection is needed; `hydrate` gives an existing document).
// Run: node --test tests/tenantOwnership.a15.test.js
const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const {
  checkUpdate,
  checkBulkOps,
  PLATFORM_ACTORS,
  TENANT_IMMUTABLE,
} = require("../models/plugins/tenantOwnership.plugin");

mongoose.set("bufferCommands", false);
console.warn = () => {};

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB
const isImmutableError = (e) => e && e.code === TENANT_IMMUTABLE && e.status === 409;
const throwsImmutable = (fn) => assert.throws(fn, isImmutableError);

test("update rule: change / unset / rename / placeholder / pipeline / replacement are rejected", () => {
  const q = (update, op = "updateOne", filter = { _id: 1, tenantId: A }) => () => checkUpdate({ model: "M", op, filter, update });
  throwsImmutable(q({ $set: { tenantId: B } }));
  throwsImmutable(q({ tenantId: B }, "findOneAndUpdate"));
  throwsImmutable(q({ $set: { tenantId: B } }, "updateMany"));
  throwsImmutable(q({ $unset: { tenantId: 1 } }));
  throwsImmutable(q({ $rename: { tenantId: "t" } }));
  throwsImmutable(q([{ $set: { tenantId: B } }]));
  for (const v of [null, "", "default", "unknown", "DEFAULT"]) throwsImmutable(q({ $set: { tenantId: v } }));
  throwsImmutable(q({ status: "x" }, "replaceOne"));
  throwsImmutable(q({ tenantId: B }, "findOneAndReplace"));
  assert.deepStrictEqual(q({ $set: { tenantId: A, status: "x" } })(), { $set: { status: "x" } });
  assert.deepStrictEqual(q({ $set: { status: "x" } })(), { $set: { status: "x" } });
});

test("bulkWrite rule: no op can move ownership; ordinary renewal bulk updates pass", () => {
  throwsImmutable(() => checkBulkOps("M", [{ updateOne: { filter: { _id: 1 }, update: { $set: { tenantId: B } } } }]));
  throwsImmutable(() => checkBulkOps("M", [{ updateMany: { filter: { tenantId: A }, update: { $unset: { tenantId: 1 } } } }]));
  assert.doesNotThrow(() =>
    checkBulkOps("M", [{ updateOne: { filter: { _id: 1 }, update: { $set: { subscriptionStatus: "ARCHIVED", isCurrent: false } } } }])
  );
});

test("no runtime migration / provisioning bypass", () => {
  assert.deepStrictEqual(PLATFORM_ACTORS, { MIGRATION: "platform:migration", PROVISIONING: "platform:provisioning" });
  assert.ok(Object.isFrozen(PLATFORM_ACTORS));
  throwsImmutable(() =>
    checkUpdate({ model: "M", op: "updateOne", filter: { tenantId: A }, update: { $set: { tenantId: B } }, actor: PLATFORM_ACTORS.MIGRATION })
  );
  const src = require("fs").readFileSync(require.resolve("../models/plugins/tenantOwnership.plugin"), "utf8");
  assert.doesNotMatch(src, /process\.env/);
  assert.doesNotMatch(src, /x-actor|headers|req\.(body|ctx|user)/);
});

for (const modelPath of ["../models/subscription.model", "../models/reminderBatchMember.model"]) {
  const Model = require(modelPath);

  test(`${Model.modelName}: immutable tenantId; save keeps the original; forced change cannot be saved`, async () => {
    assert.strictEqual(Model.schema.path("tenantId").$immutable, true);
    const doc = Model.hydrate({ _id: new mongoose.Types.ObjectId(), tenantId: A });
    doc.tenantId = B;
    assert.strictEqual(doc.tenantId, A);
    assert.strictEqual(doc.isModified("tenantId"), false);
    doc.set("tenantId", B, { overwriteImmutable: true });
    await assert.rejects(doc.save({ validateBeforeSave: false }), isImmutableError);
  });

  test(`${Model.modelName}: query and bulk writes cannot move / unset the tenant`, async () => {
    const id = new mongoose.Types.ObjectId();
    for (const run of [
      () => Model.updateOne({ _id: id, tenantId: A }, { $set: { tenantId: B } }),
      () => Model.updateMany({ tenantId: A }, { $set: { tenantId: B } }),
      () => Model.findOneAndUpdate({ _id: id, tenantId: A }, { tenantId: "unknown" }),
      () => Model.findByIdAndUpdate(id, { $unset: { tenantId: 1 } }),
      () => Model.replaceOne({ _id: id, tenantId: A }, { tenantId: B }),
      () => Model.bulkWrite([{ updateOne: { filter: { _id: id, tenantId: A }, update: { $set: { tenantId: B } } } }]),
    ]) {
      await assert.rejects(run(), isImmutableError);
    }
  });
}
