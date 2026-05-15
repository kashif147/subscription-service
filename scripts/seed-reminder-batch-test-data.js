/**
 * Seeds cross-database test data for reminder / cancellation batch flows.
 *
 * Loads MONGO_URI from backend/subscription-service/.env.staging (same cluster),
 * then connects to Subscription-Service, Profile-Service, and account-service DBs.
 *
 * Usage (from repo root or subscription-service):
 *   node backend/subscription-service/scripts/seed-reminder-batch-test-data.js
 *   SEED_TENANT_ID=my-tenant node ...
 *   node ... --cleanup   # only delete data for SEED_TENANT_ID
 *
 * Requires write access to staging MongoDB. Do not commit real credentials.
 */

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const SUB_ENV = path.join(__dirname, "../.env.staging");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing env file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function mongoUriForDatabase(uri, databaseName) {
  const u = new URL(uri);
  u.pathname = `/${databaseName}`;
  return u.toString();
}

function maskMongoUri(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return "(unparseable MONGO_URI)";
  }
}

const REMINDER = "REMINDER";
const CANCELLATION = "CANCELLATION";
const COMPLETED = "completed";
const DRAFT = "draft";
const ACTIVE = "Active";

async function main() {
  const cleanupOnly = process.argv.includes("--cleanup");
  loadEnvFile(SUB_ENV);

  const subUri = process.env.MONGO_URI;
  if (!subUri) throw new Error("MONGO_URI not set after loading .env.staging");

  const profUri = mongoUriForDatabase(subUri, "Profile-Service");
  const accUri = mongoUriForDatabase(subUri, "account-service");

  const tenantId =
    process.env.SEED_TENANT_ID || "seed-reminder-batch-test-tenant";
  const runTag = `${Date.now().toString(36)}`.slice(-6);
  const memberPrefix = `SEEDRB${runTag}`;

  console.log("Mongo URIs (masked):");
  console.log("  subscription:", maskMongoUri(subUri));
  console.log("  profile:      ", maskMongoUri(profUri));
  console.log("  account:      ", maskMongoUri(accUri));
  console.log("tenantId:", tenantId);
  console.log("member prefix:", memberPrefix);

  const subConn = mongoose.createConnection(subUri);
  const profConn = mongoose.createConnection(profUri);
  const accConn = mongoose.createConnection(accUri);
  await Promise.all([
    subConn.asPromise(),
    profConn.asPromise(),
    accConn.asPromise(),
  ]);

  const Sub = subConn.model(
    "SeedSub",
    new mongoose.Schema(
      {
        tenantId: String,
        profileId: mongoose.Schema.Types.ObjectId,
        subscriptionYear: Number,
        isCurrent: Boolean,
        subscriptionStatus: String,
        startDate: Date,
        endDate: Date,
        membershipCategory: String,
        reminders: mongoose.Schema.Types.Mixed,
        deleted: { type: Boolean, default: false },
      },
      { collection: "subscription", strict: false }
    )
  );

  const ReminderBatch = subConn.model(
    "SeedReminderBatch",
    new mongoose.Schema(
      {
        tenantId: String,
        kind: String,
        name: String,
        referencePeriod: String,
        batchDate: Date,
        status: String,
        ruleVersion: String,
        balanceAsOf: Date,
        buildContextPrevExecuteAt: Date,
        previousReminderBatchId: mongoose.Schema.Types.ObjectId,
        previousCancellationBatchId: mongoose.Schema.Types.ObjectId,
        countsByTier: mongoose.Schema.Types.Mixed,
        buildStartedAt: Date,
        buildCompletedAt: Date,
        executeStartedAt: Date,
        executeAnchorAt: Date,
        executeCompletedAt: Date,
        executionCorrelationId: String,
        error: String,
        buildProgress: mongoose.Schema.Types.Mixed,
        executeProgress: mongoose.Schema.Types.Mixed,
      },
      { collection: "reminderbatches", strict: false }
    )
  );

  const ReminderBatchMember = subConn.model(
    "SeedReminderBatchMember",
    new mongoose.Schema(
      {
        tenantId: String,
        batchId: mongoose.Schema.Types.ObjectId,
      },
      { collection: "reminderbatchmembers", strict: false }
    )
  );

  const Profile = profConn.model(
    "SeedProfile",
    new mongoose.Schema(
      {
        tenantId: String,
        isActive: { type: Boolean, default: true },
        normalizedEmail: { type: String, required: true },
        membershipNumber: { type: String, required: true },
        personalInfo: mongoose.Schema.Types.Mixed,
      },
      { collection: "profiles", strict: false }
    )
  );

  const MatBal = accConn.model(
    "SeedMatBal",
    new mongoose.Schema(
      {
        memberId: String,
        accountCode: String,
        bucket: String,
        year: Number,
        amount: Number,
      },
      { collection: "materializedbalances", strict: false }
    )
  );

  async function cleanup() {
    const profs = await Profile.find({ tenantId })
      .select("membershipNumber")
      .lean();
    const mids = profs
      .map((p) => String(p.membershipNumber || "").trim())
      .filter(Boolean);

    const batches = await ReminderBatch.find({ tenantId }).select("_id").lean();
    const ids = batches.map((b) => b._id);
    if (ids.length) {
      await ReminderBatchMember.deleteMany({ batchId: { $in: ids } });
    }
    await ReminderBatch.deleteMany({ tenantId });
    await Sub.deleteMany({ tenantId });
    if (mids.length) {
      await MatBal.deleteMany({ memberId: { $in: mids } });
    }
    await Profile.deleteMany({ tenantId });
    console.log("Cleanup done for tenant:", tenantId);
  }

  await cleanup();

  if (cleanupOnly) {
    await Promise.all([subConn.close(), profConn.close(), accConn.close()]);
    return;
  }

  const Y = new Date().getUTCFullYear();
  /** Completed REMINDER batch in the current UTC year — anchors R2/R3 tier dates. */
  const anchorReminderPrev = new Date(Date.UTC(Y, 0, 15, 12, 0, 0));
  /** Completed CANCELLATION batch in the current UTC year — anchors CANCEL tier. */
  const anchorCancelPrev = new Date(Date.UTC(Y, 1, 1, 12, 0, 0));

  const r1ForR2 = new Date(Date.UTC(Y, 0, 5, 12, 0, 0));
  const r1ForR3 = new Date(Date.UTC(Y - 1, 11, 1, 12, 0, 0));
  const r2ForR3 = new Date(Date.UTC(Y, 0, 10, 12, 0, 0));
  const r1r2r3ForCancel = {
    r1: new Date(Date.UTC(Y, 0, 2, 12, 0, 0)),
    r2: new Date(Date.UTC(Y, 0, 8, 12, 0, 0)),
    r3: new Date(Date.UTC(Y, 0, 20, 12, 0, 0)),
  };

  const profiles = [
    {
      tenantId,
      isActive: true,
      normalizedEmail: `${memberPrefix}-r1@test.local`,
      membershipNumber: `${memberPrefix}R1`,
      personalInfo: { forename: "Seed", surname: "R1", fullName: "Seed R1" },
    },
    {
      tenantId,
      isActive: true,
      normalizedEmail: `${memberPrefix}-r2@test.local`,
      membershipNumber: `${memberPrefix}R2`,
      personalInfo: { forename: "Seed", surname: "R2", fullName: "Seed R2" },
    },
    {
      tenantId,
      isActive: true,
      normalizedEmail: `${memberPrefix}-r3@test.local`,
      membershipNumber: `${memberPrefix}R3`,
      personalInfo: { forename: "Seed", surname: "R3", fullName: "Seed R3" },
    },
    {
      tenantId,
      isActive: true,
      normalizedEmail: `${memberPrefix}-cx@test.local`,
      membershipNumber: `${memberPrefix}CX`,
      personalInfo: { forename: "Seed", surname: "Cancel", fullName: "Seed Cancel" },
    },
  ];

  const insertedProfiles = await Profile.insertMany(profiles);
  const byKey = Object.fromEntries(
    ["R1", "R2", "R3", "CX"].map((k, i) => [k, insertedProfiles[i]])
  );

  const year = Y;
  const bigDebt = 5_000_000;
  const matRows = ["R1", "R2", "R3", "CX"].map((k) => ({
    memberId: byKey[k].membershipNumber,
    accountCode: "1400",
    bucket: "arrears",
    year,
    amount: bigDebt,
  }));
  await MatBal.insertMany(matRows);

  const reminderPrev = await ReminderBatch.create({
    tenantId,
    kind: REMINDER,
    name: `[SEED] Prior REMINDER run ${Y}-01`,
    referencePeriod: `${Y}-01`,
    batchDate: anchorReminderPrev,
    status: COMPLETED,
    ruleVersion: "arrears_balance_plus_receipt_age_v1",
    balanceAsOf: anchorReminderPrev,
    countsByTier: { r1: 0, r2: 0, r3: 0, cancel: 0 },
    executeCompletedAt: anchorReminderPrev,
    buildCompletedAt: anchorReminderPrev,
    error: null,
  });

  const cancelPrev = await ReminderBatch.create({
    tenantId,
    kind: CANCELLATION,
    name: `[SEED] Prior CANCELLATION run ${Y}-02`,
    referencePeriod: `${Y}-02`,
    batchDate: anchorCancelPrev,
    status: COMPLETED,
    ruleVersion: "arrears_balance_plus_receipt_age_v1",
    balanceAsOf: anchorCancelPrev,
    countsByTier: { r1: 0, r2: 0, r3: 0, cancel: 0 },
    executeCompletedAt: anchorCancelPrev,
    buildCompletedAt: anchorCancelPrev,
    error: null,
  });

  const startDate = new Date(Date.UTC(year, 0, 1, 12, 0, 0));
  const endDate = new Date(Date.UTC(year, 11, 31, 23, 0, 0, 0));

  const subsPayload = [
    {
      tenantId,
      profileId: byKey.R1._id,
      subscriptionYear: year,
      isCurrent: true,
      subscriptionStatus: ACTIVE,
      startDate,
      endDate,
      membershipCategory: "Staff Nurse",
      reminders: {
        reminder1At: null,
        reminder2At: null,
        reminder3At: null,
        lastReminderBatchId: null,
      },
    },
    {
      tenantId,
      profileId: byKey.R2._id,
      subscriptionYear: year,
      isCurrent: true,
      subscriptionStatus: ACTIVE,
      startDate,
      endDate,
      membershipCategory: "Staff Nurse",
      reminders: {
        reminder1At: r1ForR2,
        reminder2At: null,
        reminder3At: null,
        lastReminderBatchId: reminderPrev._id,
      },
    },
    {
      tenantId,
      profileId: byKey.R3._id,
      subscriptionYear: year,
      isCurrent: true,
      subscriptionStatus: ACTIVE,
      startDate,
      endDate,
      membershipCategory: "Staff Nurse",
      reminders: {
        reminder1At: r1ForR3,
        reminder2At: r2ForR3,
        reminder3At: null,
        lastReminderBatchId: reminderPrev._id,
      },
    },
    {
      tenantId,
      profileId: byKey.CX._id,
      subscriptionYear: year,
      isCurrent: true,
      subscriptionStatus: ACTIVE,
      startDate,
      endDate,
      membershipCategory: "Staff Nurse",
      reminders: {
        reminder1At: r1r2r3ForCancel.r1,
        reminder2At: r1r2r3ForCancel.r2,
        reminder3At: r1r2r3ForCancel.r3,
        lastReminderBatchId: reminderPrev._id,
      },
    },
  ];

  const insertedSubs = await Sub.insertMany(subsPayload);

  const draftReminder = await ReminderBatch.create({
    tenantId,
    kind: REMINDER,
    name: `[SEED] Draft REMINDER batch (${runTag})`,
    referencePeriod: `${Y}-SEED`,
    batchDate: new Date(),
    status: DRAFT,
    ruleVersion: "arrears_balance_plus_receipt_age_v1",
    previousReminderBatchId: reminderPrev._id,
    countsByTier: { r1: 0, r2: 0, r3: 0, cancel: 0 },
  });

  const draftCancel = await ReminderBatch.create({
    tenantId,
    kind: CANCELLATION,
    name: `[SEED] Draft CANCELLATION batch (${runTag})`,
    referencePeriod: `${Y}-SEED-CANCEL`,
    batchDate: new Date(),
    status: DRAFT,
    ruleVersion: "arrears_balance_plus_receipt_age_v1",
    previousCancellationBatchId: cancelPrev._id,
    countsByTier: { r1: 0, r2: 0, r3: 0, cancel: 0 },
  });

  await Promise.all([
    Profile.updateOne(
      { _id: byKey.R1._id },
      { $set: { currentSubscriptionId: insertedSubs[0]._id } }
    ),
    Profile.updateOne(
      { _id: byKey.R2._id },
      { $set: { currentSubscriptionId: insertedSubs[1]._id } }
    ),
    Profile.updateOne(
      { _id: byKey.R3._id },
      { $set: { currentSubscriptionId: insertedSubs[2]._id } }
    ),
    Profile.updateOne(
      { _id: byKey.CX._id },
      { $set: { currentSubscriptionId: insertedSubs[3]._id } }
    ),
  ]);

  console.log("\n✅ Seed complete.\n");
  console.log(JSON.stringify(
    {
      tenantId,
      memberPrefix,
      anchorReminderPrevExecuteAt: anchorReminderPrev.toISOString(),
      anchorCancelPrevExecuteAt: anchorCancelPrev.toISOString(),
      priorReminderBatchId: String(reminderPrev._id),
      priorCancellationBatchId: String(cancelPrev._id),
      draftReminderBatchId: String(draftReminder._id),
      draftCancellationBatchId: String(draftCancel._id),
      profiles: insertedProfiles.map((p) => ({
        id: String(p._id),
        membershipNumber: p.membershipNumber,
      })),
      subscriptions: insertedSubs.map((s) => ({
        id: String(s._id),
        profileId: String(s.profileId),
        reminderState: s.reminders,
      })),
    },
    null,
    2
  ));

  console.log(
    "\nNext: call CRM POST build on draftReminderBatchId, then POST execute when ready.\n" +
      "See docs/reminder-batch-test-data-and-process.md for tier rules.\n"
  );

  await Promise.all([subConn.close(), profConn.close(), accConn.close()]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
