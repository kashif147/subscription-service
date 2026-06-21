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
const axios = require("axios");
const mongoose = require("mongoose");
const { mongooseConnection } = require("../config/db");
const Subscription = require("../models/subscription.model");
const {
  init,
  publisher,
  shutdown,
} = require("@projectShell/rabbitmq-middleware");

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/profile-service";
const SNAPSHOT_EVENT = "members.subscription.reporting.snapshot.v1";

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

function toIdString(value) {
  if (value == null) return "";
  if (value.toString && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
}

function profileMembershipNumber(profile) {
  return profile && profile.membershipNumber != null
    ? String(profile.membershipNumber).trim()
    : "";
}

function randomCorrelationId() {
  if (crypto.randomUUID && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 10),
    Math.random().toString(36).slice(2, 10),
  ].join("-");
}

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fullNameFromProfile(profile) {
  if (!profile) return null;
  const pi = profile.personalInfo || profile;
  if (pi.fullName) return String(pi.fullName).trim() || null;
  const parts = [pi.forename, pi.surname].filter(Boolean);
  return parts.length ? parts.join(" ").trim() : null;
}

function buildReportingSnapshotPayload(subscriptionDoc, profileLean, ctx) {
  const sub = subscriptionDoc.toObject
    ? subscriptionDoc.toObject({ flattenMaps: true })
    : subscriptionDoc;
  const prof =
    profileLean && profileLean.professionalDetails
      ? profileLean.professionalDetails
      : profileLean || {};
  const cancellation = sub.cancellation || {};
  const resignation = sub.resignation || {};
  const yearend = sub.yearend || {};
  const membershipNumber =
    ctx.memberId || profileMembershipNumber(profileLean) || null;

  return {
    tenantId: sub.tenantId || ctx.tenantId,
    subscriptionId: String(sub._id),
    profileId: toIdString(sub.profileId && sub.profileId._id ? sub.profileId._id : sub.profileId),
    membershipNumber:
      membershipNumber != null ? String(membershipNumber).trim() : null,
    fullName: fullNameFromProfile(profileLean),
    membershipStatus: sub.subscriptionStatus,
    membershipMovement: sub.membershipMovement || null,
    startDate: toIsoDate(sub.startDate),
    expiryDate: toIsoDate(sub.endDate),
    cancelledAt: toIsoDate(cancellation.dateCancelled),
    resignedAt: toIsoDate(resignation.dateResigned),
    processedAt: toIsoDate(yearend.processedAt || ctx.processingDate),
    membershipCategory: sub.membershipCategory || null,
    grade: prof.grade || null,
    workLocation: prof.workLocation || null,
    branch: prof.branch || null,
    region: prof.region || null,
    section: prof.primarySection || null,
    paymentType: sub.paymentType || null,
    paymentFrequency: sub.paymentFrequency || null,
    subscriptionYear:
      sub.subscriptionYear === undefined ? null : sub.subscriptionYear,
    isCurrent: sub.isCurrent === true,
  };
}

async function initRabbit() {
  const rabbitUrl = process.env.RABBIT_URL;
  if (!rabbitUrl || !String(rabbitUrl).trim()) {
    throw new Error("RABBIT_URL environment variable is not set or is empty");
  }
  let url = String(rabbitUrl).trim();
  if (!url.startsWith("amqp://") && !url.startsWith("amqps://")) {
    url = `amqp://${url}`;
  }
  await init({
    url,
    logger: console,
    prefetch: 10,
    connectionName: "subscription-service-reporting-replay",
    serviceName: "subscription-service",
  });
}

async function publishReportingSnapshotForSubscription(subscriptionDoc, profileLean, ctx) {
  if (!subscriptionDoc || !subscriptionDoc.profileId) {
    return { success: false, error: "missing_profile_id" };
  }
  const payload = buildReportingSnapshotPayload(subscriptionDoc, profileLean, ctx);
  if (!payload.tenantId || !payload.subscriptionId) {
    return { success: false, error: "missing_ids" };
  }

  return publisher.publish(SNAPSHOT_EVENT, payload, {
    tenantId: payload.tenantId,
    correlationId: ctx.correlationId,
    exchange: "membership.events",
    routingKey: SNAPSHOT_EVENT,
    metadata: {
      service: "subscription-service",
      version: "1.0",
      purpose: "reporting",
    },
  });
}

async function fetchProfilesByIds(profileIds, tenantId) {
  if (!profileIds.length) return [];
  const batchUrl = `${PROFILE_SERVICE_URL}/api/profile/batch`;
  const response = await axios.get(batchUrl, {
    params: { profileIds: profileIds.join(",") },
    headers: {
      "x-tenant-id": tenantId,
      "x-internal-request": "true",
    },
    timeout: 30000,
  });
  return response.data && response.data.data ? response.data.data : [];
}

async function fetchProfilesForSubscriptions(subscriptions, tenantId) {
  const ids = [
    ...new Set(
      subscriptions
        .map((sub) => toIdString(sub.profileId))
        .filter(Boolean)
    ),
  ];

  const profiles = [];
  for (const idsChunk of chunk(ids, 100)) {
    profiles.push(...(await fetchProfilesByIds(idsChunk, tenantId)));
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
      const profileId = toIdString(sub.profileId);
      const profile = profileById.get(profileId);
      return profileMembershipNumber(profile) === wanted;
    });
  }

  console.log(
    `${args.dryRun ? "Would publish" : "Publishing"} ${subscriptions.length} reporting snapshot(s)`
  );

  if (!args.dryRun) {
    await initRabbit();
  }

  let published = 0;
  for (const sub of subscriptions) {
    const profileId = toIdString(sub.profileId);
    const profileLean = profileById.get(profileId) || null;
    const memberId = profileMembershipNumber(profileLean) || null;

    console.log(
      `${args.dryRun ? "[dry-run]" : "[publish]"} subscription=${sub._id} profile=${profileId} member=${memberId || "n/a"}`
    );

    if (!args.dryRun) {
      const result = await publishReportingSnapshotForSubscription(sub, {
        tenantId: args.tenantId,
        correlationId: `reporting-snapshot-replay-${randomCorrelationId()}`,
        memberId,
        profileLean,
      });
      if (!result || !result.success) {
        console.warn("Snapshot publish did not report success", {
          subscriptionId: toIdString(sub._id),
          error: result && result.error,
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
      await shutdown();
    } catch (err) {
      if (err && err.message) console.warn("RabbitMQ shutdown warning:", err.message);
    }
    await mongoose.disconnect();
  });
