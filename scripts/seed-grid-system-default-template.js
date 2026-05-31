/**
 * Seed system-default subscription grid template from grid-column-defaults.json.
 *
 * Usage:
 *   TENANT_ID=xxx node scripts/seed-grid-system-default-template.js --type=members --env=staging --force
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const {
  loadManifest,
  upsertSystemDefaultTemplate,
} = require("../../../scripts/seed-grid-system-default-lib.cjs");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const hit = args.find((a) => a.startsWith(`${prefix}=`));
    return hit ? hit.slice(prefix.length + 1).trim() : "";
  };
  return {
    type: get("--type"),
    tenantId: get("--tenant") || process.env.TENANT_ID || "",
    envName: get("--env") || "staging",
    force: args.includes("--force"),
  };
}

async function main() {
  const { type, tenantId, envName, force } = parseArgs();
  if (!type) {
    console.error("Pass --type=<pageKey>");
    process.exit(1);
  }
  if (!tenantId) {
    console.error("Pass --tenant=TENANT_ID or set TENANT_ID");
    process.exit(1);
  }

  const envFile = path.join(__dirname, "..", `.env.${envName}`);
  if (!fs.existsSync(envFile)) {
    console.error(`Env file not found: ${envFile}`);
    process.exit(1);
  }
  require("dotenv").config({ path: envFile, override: true });

  const mongoUri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    "";
  if (!mongoUri) {
    console.error("Set MONGO_URI in env file");
    process.exit(1);
  }

  const manifest = loadManifest();
  const page = manifest.pages?.[type];
  if (!page) {
    console.error(`Unknown --type=${type}`);
    process.exit(1);
  }
  if (page.service !== "subscription-service") {
    console.error(`Page ${type} is not subscription-service owned`);
    process.exit(1);
  }

  const Template = require("../models/template.model");
  await mongoose.connect(mongoUri);

  const result = await upsertSystemDefaultTemplate({
    Template,
    page,
    tenantId,
    force,
  });
  console.log(`${result.action} ${result.templateType}: ${result.id}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
