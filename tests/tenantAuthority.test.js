// Phase 2C Track C: subscription-service tenant authority.
//  - no "default" tenant anywhere (internal workers, downstream calls, lifecycle client);
//  - the raw inbound x-tenant-id header never overrides the trusted tenant;
//  - event consumers: envelope tenant canonical, envelope/data mismatch or no tenant -> throw
//    (retry -> DLQ quarantine);
//  - tenant-owned lookups never fall back to all tenants.
const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

const { resolveEventTenant, EventTenantMismatchError, EventTenantMissingError } = require("../helpers/eventTenant");
const serviceClient = require("../helpers/serviceClient");

test("1 event tenant: envelope is canonical, data is only a fallback", () => {
  assert.strictEqual(resolveEventTenant({ tenantId: A, data: { tenantId: A } }), A);
  assert.strictEqual(resolveEventTenant({ tenantId: A, data: {} }), A);
  assert.strictEqual(resolveEventTenant({ data: { tenantId: B } }), B);
});

test("2 event tenant: envelope/data mismatch is quarantined (throws)", () => {
  assert.throws(() => resolveEventTenant({ tenantId: A, data: { tenantId: B } }), EventTenantMismatchError);
});

test("3 event tenant: no tenant at all is quarantined (throws), never 'default'", () => {
  assert.throws(() => resolveEventTenant({ data: {} }), EventTenantMissingError);
  assert.throws(() => resolveEventTenant({ tenantId: "  ", data: { tenantId: "" } }), EventTenantMissingError);
});

test("4 internal worker requests need an explicit tenant (no 'default')", () => {
  assert.throws(() => serviceClient.createInternalWorkerReq(undefined), /requires a tenant/);
  assert.throws(() => serviceClient.createInternalWorkerReq(""), /requires a tenant/);
  const req = serviceClient.createInternalWorkerReq(A);
  assert.strictEqual(req.tenantId, A);
  assert.strictEqual(req.headers["x-tenant-id"], A);
});

test("5 downstream calls carry the trusted tenant; a raw inbound x-tenant-id cannot override it", async (t) => {
  const seen = [];
  t.mock.method(axios, "post", async (_url, body, opts) => {
    seen.push(opts.headers["x-tenant-id"]);
    return { data: { data: { items: body.memberIds.map((m) => ({ memberId: m })) } } };
  });
  // Authenticated request for tenant A that ALSO carries a raw x-tenant-id naming B.
  const req = { tenantId: A, headers: { "x-tenant-id": B, "x-jwt-verified": "true", "x-auth-source": "gateway" } };
  await serviceClient.fetchMemberSummariesByMemberIds(["M-T5"], A, req);
  // No explicit tenant argument: the trusted req.tenantId is used, not the raw header.
  await serviceClient.fetchMemberSummariesByMemberIds(["M-T5b"], undefined, req);
  assert.deepStrictEqual(seen, [A, A]);
});

test("6 a downstream call with no trusted tenant at all fails closed (no request sent)", async (t) => {
  let calls = 0;
  t.mock.method(axios, "post", async () => { calls += 1; return { data: { data: { items: [] } } }; });
  await assert.rejects(serviceClient.fetchMemberSummariesByMemberIds(["M-T6"], undefined, { headers: { "x-tenant-id": B } }));
  assert.strictEqual(calls, 0, "a raw header alone is not a trusted tenant");
});

test("7 lifecycle client refuses to call without a tenant", async (t) => {
  t.mock.method(axios, "get", async () => ({ data: { data: null } }));
  const { fetchTenantLifecycleConfig } = require("../helpers/tenantLifecycleClient");
  await assert.rejects(fetchTenantLifecycleConfig(undefined), /requires a tenant/);
});

test("8 renewal execution is tenant-scoped: no tenant -> refused before any DB access", async () => {
  const { processRenewalBatchExecute } = require("../services/renewalBatch.service");
  await assert.rejects(processRenewalBatchExecute("6650aaaaaaaaaaaaaaaaaaaa", undefined), /requires a tenant/);
});

test("9 renewal consumer quarantines an event whose envelope and data tenants differ", async () => {
  const listenerPath = require.resolve("../rabbitMQ/listeners/renewalBatch.listener");
  const src = require("fs").readFileSync(listenerPath, "utf8");
  assert.match(src, /resolveEventTenant\(payload\)/);
  assert.throws(() => resolveEventTenant({ tenantId: A, data: { tenantId: B, batchId: "x" } }), EventTenantMismatchError);
});
