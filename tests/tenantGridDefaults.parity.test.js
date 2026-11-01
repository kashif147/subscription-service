// The canonical members default (provisioning source) must be exactly the curated configuration in use
// today - the MULTIAUTH system default - with no extra/removed columns, label, filter, order or flag
// changes. Only tenant ownership / system metadata may differ.
// Fixture: stored configuration of the MULTIAUTH members default. Run: node --test tests/<this file>
const test = require("node:test");
const assert = require("node:assert");
const g = require("../services/tenantGridDefaults");
const Template = require("../models/template.model");
const live = require("./fixtures/membersDefault.dev-20261101.json");

const OWNERSHIP_AND_SYSTEM_KEYS = ["_id", "tenantId", "userId", "createdAt", "updatedAt", "__v", "meta", "systemDefault"];
const TENANT = "68ebf0806080b4621d461ae0";
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !OWNERSHIP_AND_SYSTEM_KEYS.includes(k)));
const built = () => g.buildTenantDefault(g.loadCanonical(), TENANT, "members", new Date(0), undefined);

test("manifest covers only 'members' and documents why it is canonical", () => {
  const c = g.loadCanonical();
  assert.deepStrictEqual(Object.keys(c.templates), ["members"]);
  assert.match(c.source.note, /only persisted members default/);
});

test("members: provisioned default is identical to the curated configuration in use", () => {
  const stored = live.rows.members.stored;
  const doc = built();
  assert.deepStrictEqual(doc.columns, stored.columns);
  assert.deepStrictEqual(doc.columnLabels, stored.columnLabels || {});
  assert.deepStrictEqual(doc.filters, stored.filters || {});
  assert.deepStrictEqual(doc.visibleFilters, stored.visibleFilters || []);
  assert.strictEqual(doc.name, stored.name);
  assert.strictEqual(doc.isDefault, stored.isDefault === true);
  assert.strictEqual(doc.pinned, stored.pinned === true);
});

test("members: through the real Template model it hydrates exactly like the curated row (only ownership/system metadata differs)", () => {
  const asServed = (raw) => strip(Template.hydrate({ _id: "600000000000000000000001", tenantId: TENANT, ...raw }).toObject());
  assert.deepStrictEqual(asServed(strip(built())), asServed(live.rows.members.stored));
});
