/**
 * Create system default subscription filter template for a tenant (one row per tenant).
 *
 * Usage:
 *   TENANT_ID=your-tenant node scripts/seed-subscription-system-default-template.js
 *   node scripts/seed-subscription-system-default-template.js --tenant=your-tenant
 *
 * Requires MONGODB_URI (or connection string in .env).
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Template = require("../models/template.model");
const { MEMBERSHIP_STATUS } = require("../constants/enums");
const {
  SUBSCRIPTION_RESPONSE_COLUMNS,
} = require("../constants/subscriptionTemplate");

function parseTenantId() {
  const arg = process.argv.find((a) => a.startsWith("--tenant="));
  if (arg) {
    return arg.split("=")[1]?.trim();
  }
  return process.env.TENANT_ID || process.env.DEFAULT_TENANT_ID || "";
}

const tenantId = parseTenantId();
const MONGODB_URI =
  process.env.MONGODB_URI || process.env.DATABASE_URL || "";

async function main() {
  if (!tenantId) {
    console.error("Set TENANT_ID or pass --tenant=<id>");
    process.exit(1);
  }
  if (!MONGODB_URI) {
    console.error("Set MONGODB_URI");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  const existing = await Template.findOne({
    tenantId,
    systemDefault: true,
    templateType: "members",
    "meta.deleted": false,
  });

  if (existing) {
    console.log("System default subscription template already exists:", existing._id);
    await mongoose.disconnect();
    process.exit(0);
  }

  const doc = new Template({
    name: "System default",
    templateType: "members",
    tenantId,
    userId: undefined,
    filters: {
      subscriptionStatus: {
        operator: "equal_to",
        values: [MEMBERSHIP_STATUS.ACTIVE],
      },
    },
    columns: [...SUBSCRIPTION_RESPONSE_COLUMNS],
    isDefault: false,
    pinned: false,
    systemDefault: true,
    meta: { deleted: false, deletedAt: null },
  });

  const saved = await doc.save();
  console.log("Created system default subscription template:", saved._id);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
