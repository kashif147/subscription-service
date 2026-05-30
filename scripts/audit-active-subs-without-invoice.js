/**
 * Reports active current subscriptions with no current-year Invoice on the ledger.
 *
 * Usage:
 *   node backend/subscription-service/scripts/audit-active-subs-without-invoice.js
 *   SEED_TENANT_ID=my-tenant node ...
 *
 * Reads MONGO_URI from backend/subscription-service/.env.staging (or MONGO_URI env).
 */

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const SUB_ENV = path.join(__dirname, "../.env.staging");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

function mongoUriForDatabase(uri, databaseName) {
  const u = new URL(uri);
  u.pathname = `/${databaseName}`;
  return u.toString();
}

async function main() {
  loadEnvFile(SUB_ENV);
  const subUri = process.env.MONGO_URI;
  if (!subUri) throw new Error("MONGO_URI not set");

  const accUri = mongoUriForDatabase(subUri, "account-service");
  const profUri = mongoUriForDatabase(subUri, "Profile-Service");
  const tenantId = process.env.SEED_TENANT_ID || process.env.AUDIT_TENANT_ID || null;
  const year = Number(process.env.AUDIT_YEAR) || new Date().getUTCFullYear();

  const subConn = mongoose.createConnection(subUri);
  const accConn = mongoose.createConnection(accUri);
  const profConn = mongoose.createConnection(profUri);
  await Promise.all([
    subConn.asPromise(),
    accConn.asPromise(),
    profConn.asPromise(),
  ]);

  const Sub = subConn.model(
    "AuditSub",
    new mongoose.Schema({}, { strict: false, collection: "subscription" })
  );
  const Profile = profConn.model(
    "AuditProfile",
    new mongoose.Schema({}, { strict: false, collection: "profiles" })
  );
  const GL = accConn.model(
    "AuditGL",
    new mongoose.Schema({}, { strict: false, collection: "gltransactions" })
  );

  const subFilter = {
    isCurrent: true,
    deleted: { $ne: true },
    subscriptionStatus: "Active",
    ...(tenantId ? { tenantId } : {}),
  };

  const subs = await Sub.find(subFilter)
    .select("_id profileId tenantId membershipCategory subscriptionYear startDate")
    .lean();

  const profileIds = [...new Set(subs.map((s) => String(s.profileId)))];
  const profiles = await Profile.find({ _id: { $in: profileIds } })
    .select("_id membershipNumber tenantId")
    .lean();
  const profileById = new Map(profiles.map((p) => [String(p._id), p]));

  const missing = [];
  for (const sub of subs) {
    const profile = profileById.get(String(sub.profileId));
    const memberId = profile?.membershipNumber
      ? String(profile.membershipNumber).trim()
      : "";
    if (!memberId) {
      missing.push({
        subscriptionId: String(sub._id),
        profileId: String(sub.profileId),
        reason: "NO_MEMBERSHIP_NUMBER",
      });
      continue;
    }

    const invoice = await GL.findOne({
      docType: "Invoice",
      date: {
        $gte: new Date(Date.UTC(year, 0, 1)),
        $lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
      entries: {
        $elemMatch: {
          memberId,
          accountCode: "1400",
          dc: "D",
        },
      },
    })
      .select("docNo date")
      .lean();

    if (!invoice) {
      missing.push({
        subscriptionId: String(sub._id),
        profileId: String(sub.profileId),
        memberId,
        membershipCategory: sub.membershipCategory,
        subscriptionYear: sub.subscriptionYear,
        reason: "NO_CURRENT_YEAR_INVOICE",
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        tenantId: tenantId || "(all tenants)",
        auditYear: year,
        activeCurrentSubscriptions: subs.length,
        issues: missing.length,
        rows: missing.slice(0, 200),
      },
      null,
      2
    )
  );

  await Promise.all([subConn.close(), accConn.close(), profConn.close()]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
