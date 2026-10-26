"use strict";
// Phase A / A11 - WORKLOC resolution by stable code, no process-global type-id cache.
// axios is stubbed (no network). Run: node --test tests/lookupClient.a11.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const axios = require("axios");
const calls = [];
let respond = () => ({ status: 200, data: {} });
axios.get = async (url, config) => {
  calls.push({ url, headers: (config && config.headers) || {} });
  return respond(url);
};

const client = require("../services/lookup.service.client.js");

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const D = "6ad4e0c941376f7df605fd57";
const WL_BEAUMONT = "65a000000000000000000022";

const byCodeBody = {
  lookuptype: { code: "WORKLOC" },
  totalCount: 2,
  results: [
    { lookup: { _id: WL_BEAUMONT, code: "WL_BEAU", lookupname: "Beaumont Hospital", DisplayName: "Beaumont Hospital", processSalaryDeduction: true }, hierarchy: [] },
    { lookup: { _id: "65a000000000000000000023", code: "WL_MATER", lookupname: "Mater Hospital", DisplayName: "Mater Hospital", processSalaryDeduction: false }, hierarchy: [] },
  ],
};
const reqFor = (tenantId, extra = {}) => ({
  ctx: { tenantId },
  headers: { "x-jwt-verified": "true", "x-user-type": "CRM", "x-correlation-id": "cid-1", ...extra },
});
const reset = (fn) => {
  calls.length = 0;
  respond = fn || ((url) => (url.includes("/by-type-code/WORKLOC/") ? { status: 200, data: byCodeBody } : { status: 404, data: {} }));
};
const check = (key, tenantId, req = reqFor(tenantId)) =>
  client.isSalaryDeductionEnabledForWorkLocation(key, { req, tenantId });

test("resolves WORKLOC by stable code - never /api/lookuptype or a by-type/<id> url", async () => {
  reset();
  assert.equal(await check("Beaumont Hospital", A), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/lookup\/by-type-code\/WORKLOC\/hierarchy$/);
  assert.ok(!calls.some((c) => /\/api\/lookuptype|\/by-type\//.test(c.url)));
});

test("trusted tenant and identity headers are forwarded (x-user-type, x-correlation-id)", async () => {
  reset();
  await check("Beaumont Hospital", A);
  assert.equal(calls[0].headers["x-tenant-id"], A);
  assert.equal(calls[0].headers["x-user-type"], "CRM");
  assert.equal(calls[0].headers["x-correlation-id"], "cid-1");
});

test("same code for MULTIAUTH, DEVTENANTB, DEVDIRB: one call each under its own tenant; no client cache", async () => {
  reset();
  for (const t of [A, B, D, A]) await check("Mater Hospital", t);
  assert.deepEqual(calls.map((c) => c.headers["x-tenant-id"]), [A, B, D, A]);
});

test("name matching is case-insensitive; disabled location -> false", async () => {
  reset();
  assert.equal(await check("  beaumont hospital ", A), true);
  assert.equal(await check("Mater Hospital", A), false);
  assert.equal(await check("Nowhere", A), false);
});

test('"Other" / empty short-circuit without any call', async () => {
  reset();
  assert.equal(await check("Other", A), false);
  assert.equal(await check("", A), false);
  assert.equal(calls.length, 0);
});

test("404 (unknown code) -> no match, no throw", async () => {
  reset(() => ({ status: 404, data: { error: { code: "LOOKUP_TYPE_NOT_FOUND" } } }));
  assert.equal(await check("Beaumont Hospital", A), false);
});

test("an ObjectId work location resolves via /api/lookup/:id first", async () => {
  reset((url) => (url.endsWith(`/api/lookup/${WL_BEAUMONT}`) ? { status: 200, data: byCodeBody.results[0].lookup } : { status: 404, data: {} }));
  assert.equal(await check(WL_BEAUMONT, A), true);
  assert.match(calls[0].url, new RegExp(`/api/lookup/${WL_BEAUMONT}$`));
});

test("missing / placeholder tenant fails closed: false and no call", async () => {
  reset();
  for (const t of [undefined, "", "  ", "default", "unknown"]) {
    assert.equal(await client.isSalaryDeductionEnabledForWorkLocation("Beaumont Hospital", { req: null, tenantId: t }), false);
  }
  assert.equal(calls.length, 0);
});

test("a tenant disagreeing with the request's trusted tenant fails closed: false and no call", async () => {
  reset();
  assert.equal(await check("Beaumont Hospital", B, reqFor(A)), false);
  assert.equal(calls.length, 0);
  assert.equal(client.resolveLookupTenant(reqFor(A), A), A);
  assert.equal(client.resolveLookupTenant(null, D), D);
});

test("no process-global lookup-type id cache remains in the source", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "lookup.service.client.js"), "utf8");
  assert.ok(!/cachedWorkLocTypeId|workLocTypeCacheExpiry|getWorkLocTypeId/.test(src));
  assert.ok(!src.includes("/api/lookuptype"));
});
