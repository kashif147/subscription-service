// memberSummaryCache must be keyed by tenant + member (Tenant A/B).
const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");

const { fetchMemberSummariesByMemberIds } = require("../helpers/serviceClient");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

function crmReq(tenantId) {
  return { headers: { "x-tenant-id": tenantId, "x-jwt-verified": "true", "x-auth-source": "gateway" }, tenantId };
}

test("same memberId in tenants A and B never shares a cached summary", async (t) => {
  const seen = [];
  t.mock.method(axios, "post", async (_url, body, opts) => {
    const tenant = opts.headers["x-tenant-id"];
    seen.push(tenant);
    return { data: { data: { items: body.memberIds.map((m) => ({ memberId: m, owner: tenant })) } } };
  });

  const a1 = await fetchMemberSummariesByMemberIds(["M-1"], A, crmReq(A));
  const b1 = await fetchMemberSummariesByMemberIds(["M-1"], B, crmReq(B));
  const a2 = await fetchMemberSummariesByMemberIds(["M-1"], A, crmReq(A));

  assert.strictEqual(a1[0].summary.owner, A);
  assert.strictEqual(b1[0].summary.owner, B, "tenant B must not receive A's cached summary");
  assert.strictEqual(a2[0].summary.owner, A);
  assert.deepStrictEqual(seen, [A, B], "A's second call is served from A's own cache entry");
});

test("a caller with no real tenant is never served from or written to the cache", async (t) => {
  let calls = 0;
  t.mock.method(axios, "post", async (_url, body) => {
    calls += 1;
    return { data: { data: { items: body.memberIds.map((m) => ({ memberId: m, n: calls })) } } };
  });
  await fetchMemberSummariesByMemberIds(["M-2"], undefined, { headers: {} });
  await fetchMemberSummariesByMemberIds(["M-2"], undefined, { headers: {} });
  assert.strictEqual(calls, 2);
});
