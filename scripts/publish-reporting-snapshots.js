#!/usr/bin/env node
/**
 * Re-emit reporting snapshots for existing subscriptions.
 *
 * Usage:
 *   node scripts/publish-reporting-snapshots.js --tenant-id=<tenant> --current-only
 *   node scripts/publish-reporting-snapshots.js --tenant-id=<tenant> --member-id=12345
 *   node scripts/publish-reporting-snapshots.js --tenant-id=<tenant> --profile-id=<id> --dry-run
 */
require("dotenv").config();

const crypto = require("crypto");
const mongoose = require("mongoose");
const { mongooseConnection } = require("../config/db");
const Subscription = require("../models/subscription.model");
const {
  publishReportingSnapshotForSubscription,
} = require("../helpers/reportingSnapshotPublish");
const {
  initEventSystem,
  shutdownEventSystem,
} = require("../rabbitMQ");
const {
  fetchProfilesByIds,
  createInternalWorkerReq,
} = require("../helpers/serviceClient");

function parseArgs(argv) {
  const args = {
    tenantId: process.env.TENANT_ID || null,
    currentOnly: false,
    dryRun: false,
    profileId: null,
    memberId: null,
    limit: 0,
  };

  for (const arg of argv) {
    if (arg.startsWith("--tenant-id=")) args.tenantId = arg.split("=")[1];
    if (arg === "--current-only") args.currentOnly = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg.startsWith("--profile-id=")) args.profileId = arg.split("=")[1];
    if (arg.startsWith("--member-id=")) args.memberId = arg.split("=")[1];
    if (arg.startsWith("--limit=")) args.limit = Number(arg.split("=")[1]) || 0;
  }

  return args;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchProfilesForSubscriptions(subscriptions, tenantId) {
  const ids = [
    ...new Set(
      subscriptions
        .map((sub) => sub.profileId?.toString?.() || String(sub.profileId || ""))
        .filter(Boolean)
    ),
  ];

  const profiles = [];
  const req = createInternalWorkerReq(tenantId);
  for (const idsChunk of chunk(ids, 100)) {
    profiles.push(...(await fetchProfilesByIds(idsChunk, tenantId, req)));
  }
  return new Map(profiles.map((profile) => [String(profile._id), profile]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenantId) {
    throw new Error("Provide --tenant-id=<tenant> or TENANT_ID in env");
  }

  await mongooseConnection();

  const query = {
    tenantId: args.tenantId,
    deleted: { $ne: true },
  };
  if (args.currentOnly) query.isCurrent = true;
  if (args.profileId) {
    if (!mongoose.Types.ObjectId.isValid(args.profileId)) {
      throw new Error(`Invalid --profile-id: ${args.profileId}`);
    }
    query.profileId = new mongoose.Types.ObjectId(args.profileId);
  }

  let cursor = Subscription.find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  if (args.limit > 0) cursor = cursor.limit(args.limit);

  let subscriptions = await cursor;
  const profileById = await fetchProfilesForSubscriptions(
    subscriptions,
    args.tenantId
  );

  if (args.memberId) {
    const wanted = String(args.memberId).trim();
    subscriptions = subscriptions.filter((sub) => {
      const profileId = sub.profileId?.toString?.() || String(sub.profileId || "");
      const profile = profileById.get(profileId);
      return String(profile?.membershipNumber || "").trim() === wanted;
    });
  }

  console.log(
    `${args.dryRun ? "Would publish" : "Publishing"} ${subscriptions.length} reporting snapshot(s)`
  );

  if (!args.dryRun) {
    await initEventSystem();
  }

  let published = 0;
  for (const sub of subscriptions) {
    const profileId = sub.profileId?.toString?.() || String(sub.profileId || "");
    const profileLean = profileById.get(profileId) || null;
    const memberId = profileLean?.membershipNumber || null;

    console.log(
      `${args.dryRun ? "[dry-run]" : "[publish]"} subscription=${sub._id} profile=${profileId} member=${memberId || "n/a"}`
    );

    if (!args.dryRun) {
      const result = await publishReportingSnapshotForSubscription(sub, {
        tenantId: args.tenantId,
        correlationId: `reporting-snapshot-replay-${crypto.randomUUID()}`,
        memberId,
        profileLean,
      });
      if (!result?.success) {
        console.warn("Snapshot publish did not report success", {
          subscriptionId: sub._id?.toString?.(),
          error: result?.error,
        });
      }
    }
    published += 1;
  }

  console.log(`${args.dryRun ? "Matched" : "Published"} ${published} snapshot(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await shutdownEventSystem();
    } catch (err) {
      if (err?.message) console.warn("RabbitMQ shutdown warning:", err.message);
    }
    await mongoose.disconnect();
  });
