// Tenant-owned grid system defaults: insert-only migration + ensureTenantDefaults, against a REAL
// throwaway mongod (skipped when no mongod binary: set MONGOD_BIN). Suite: tests/helpers/tenantGridDefaultsSuite.js
// Run: node --test tests/tenantGridDefaults.test.js
const { describe, test, before, after, beforeEach } = require("node:test");
const g = require("../services/tenantGridDefaults");
const cli = require("../scripts/migrate-grid-defaults-to-tenants");
const { registerTenantGridDefaultsSuite, mongodBin } = require("./helpers/tenantGridDefaultsSuite");

describe("tenant-owned grid system defaults (real mongod)", { skip: !mongodBin() && "no mongod binary (set MONGOD_BIN)" }, () => {
  registerTenantGridDefaultsSuite({ test, beforeAll: before, afterAll: after, beforeEach }, { g, cli, types: ["members"] });
});
