const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const ReminderBatch = require("../models/reminderBatch.model");
const ReminderBatchMember = require("../models/reminderBatchMember.model");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const {
  REMINDER_BATCH_KIND,
  REMINDER_BATCH_STATUS,
  REMINDER_BATCH_TIER,
  REMINDER_BATCH_RULE_VERSION_DEFAULT,
  REMINDER_BATCH_EXCLUSION_REASON,
  CANCELLATION_SOURCE,
  MEMBERSHIP_STATUS,
} = require("../constants/enums");
const {
  REMINDER_BATCH_EXCLUDED_MEMBERSHIP_CATEGORIES,
  REMINDER_BATCH_ELIGIBILITY_CHUNK,
  REMINDER_BATCH_BUILD_EXECUTE_CHUNK_SIZE,
} = require("../constants/reminderBatch.constants");
const {
  fetchProfilesByIds,
  fetchReminderEligibilityBulk,
  createInternalWorkerReq,
} = require("../helpers/serviceClient");
const {
  classifyMaxReminderTier,
  classifyCancellationTier,
} = require("../helpers/reminderBatchTier");
const { AppError } = require("../errors/AppError");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const { publishSubscriptionCurrentUpdated } = require("../rabbitMQ/publishers/subscription.current.updated.publisher.js");
const {
  publishReminderCommsRequested,
} = require("../rabbitMQ/publishers/reminder.comms.requested.publisher.js");

const MEMBERSHIP_CANCEL_GRACE_DAYS = 28;
const CHUNK = REMINDER_BATCH_BUILD_EXECUTE_CHUNK_SIZE;

function workerReq(req, tenantId) {
  if (req && req.headers) return req;
  return createInternalWorkerReq(tenantId);
}

function ensureRemindersSubdoc(sub) {
  if (!sub.reminders || typeof sub.reminders !== "object" || Array.isArray(sub.reminders)) {
    sub.reminders = {};
  }
}

function normalizeCategory(c) {
  return String(c || "")
    .trim()
    .toLowerCase();
}

function isFreeOrExcludedCategory(category) {
  const n = normalizeCategory(category);
  if (!n) return false;
  return REMINDER_BATCH_EXCLUDED_MEMBERSHIP_CATEGORIES.some(
    (x) => n === x || n.includes(x)
  );
}

function endOfCancellationGracePeriod(dateCancelled) {
  const d = new Date(dateCancelled);
  if (Number.isNaN(d.getTime())) return null;
  const end = new Date(d.getTime());
  end.setUTCDate(end.getUTCDate() + MEMBERSHIP_CANCEL_GRACE_DAYS);
  return end;
}

async function resolveCrmUserObjectId(req) {
  if (!req.userId || !req.tenantId) return null;
  const crmUser = await User.findOne({
    userId: req.userId,
    tenantId: req.tenantId,
  }).lean();
  return crmUser?._id || null;
}

async function findPreviousCompletedBatch(tenantId, kind) {
  return ReminderBatch.findOne({
    tenantId,
    kind,
    status: REMINDER_BATCH_STATUS.COMPLETED,
    executeCompletedAt: { $ne: null },
  })
    .sort({ executeCompletedAt: -1 })
    .lean();
}

async function createReminderBatch(req, body) {
  const { name, kind, batchDate, referencePeriod, previousReminderBatchId } = body;
  if (!name || !String(name).trim()) throw AppError.badRequest("name is required");
  if (!kind || !Object.values(REMINDER_BATCH_KIND).includes(kind)) {
    throw AppError.badRequest("kind must be REMINDER or CANCELLATION");
  }
  const bd = batchDate ? new Date(batchDate) : null;
  if (!bd || Number.isNaN(bd.getTime())) throw AppError.badRequest("batchDate is required");

  const createdBy = await resolveCrmUserObjectId(req);
  const doc = await ReminderBatch.create({
    tenantId: req.tenantId,
    kind,
    name: String(name).trim(),
    referencePeriod: referencePeriod || null,
    batchDate: bd,
    status: REMINDER_BATCH_STATUS.DRAFT,
    ruleVersion: REMINDER_BATCH_RULE_VERSION_DEFAULT,
    balanceAsOf: null,
    previousReminderBatchId: previousReminderBatchId || null,
    previousCancellationBatchId: null,
    countsByTier: { r1: 0, r2: 0, r3: 0, cancel: 0 },
    createdBy,
    updatedBy: createdBy,
  });

  return doc.toObject();
}

async function listReminderBatches(req, query) {
  const { kind, status, page = 1, limit = 20 } = query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const q = { tenantId: req.tenantId };
  if (kind && Object.values(REMINDER_BATCH_KIND).includes(kind)) q.kind = kind;
  if (status && Object.values(REMINDER_BATCH_STATUS).includes(status)) q.status = status;

  const [items, total] = await Promise.all([
    ReminderBatch.find(q)
      .sort({ batchDate: -1, createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    ReminderBatch.countDocuments(q),
  ]);

  const creatorIds = [
    ...new Set(
      items.map((b) => b.createdBy).filter((id) => id != null)
    ),
  ];
  const byId = new Map();
  if (creatorIds.length) {
    const users = await User.find({ _id: { $in: creatorIds } })
      .select("userEmail userFullName")
      .lean();
    for (const u of users) {
      byId.set(String(u._id), u);
    }
  }
  for (const item of items) {
    const c = item.createdBy && byId.get(String(item.createdBy));
    item.userEmail = c?.userEmail ?? null;
    item.userFullName = c?.userFullName ?? null;
  }

  return { items, total, page: p, limit: l };
}

async function getReminderBatchById(req, batchId) {
  if (!mongoose.Types.ObjectId.isValid(batchId)) {
    throw AppError.badRequest("Invalid batchId");
  }
  const doc = await ReminderBatch.findOne({
    _id: batchId,
    tenantId: req.tenantId,
  }).lean();
  if (!doc) throw AppError.notFound("Reminder batch not found");
  return doc;
}

async function listReminderBatchMembers(req, batchId, query) {
  await getReminderBatchById(req, batchId);
  const { tier, included, page = 1, limit = 50 } = query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const q = { tenantId: req.tenantId, batchId };
  if (tier && Object.values(REMINDER_BATCH_TIER).includes(tier)) q.tier = tier;
  if (included === "true") q.included = true;
  if (included === "false") q.included = false;

  const [items, total] = await Promise.all([
    ReminderBatchMember.find(q)
      .sort({ tier: 1, profileId: 1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    ReminderBatchMember.countDocuments(q),
  ]);
  return { items, total, page: p, limit: l };
}

/**
 * Start build: status, timestamps, clear prior members, init progress.
 * @returns {{ batch: import('mongoose').Document, asOf: Date, prevExecuteAt: Date | null, req: object }}
 */
async function beginBuildReminderBatch(batchId, tenantId, req) {
  if (!mongoose.Types.ObjectId.isValid(batchId)) {
    throw AppError.badRequest("Invalid batchId");
  }
  const batch = await ReminderBatch.findOne({
    _id: batchId,
    tenantId,
  });
  if (!batch) throw AppError.notFound("Reminder batch not found");

  const allowed = new Set([
    REMINDER_BATCH_STATUS.DRAFT,
    REMINDER_BATCH_STATUS.FAILED,
    REMINDER_BATCH_STATUS.PENDING_BUILD,
  ]);
  if (!allowed.has(batch.status)) {
    throw AppError.badRequest("Batch cannot be rebuilt in its current status");
  }

  batch.status = REMINDER_BATCH_STATUS.PENDING_BUILD;
  batch.buildStartedAt = new Date();
  batch.error = null;
  batch.updatedBy = await resolveCrmUserObjectId(req);
  const totalEst = await Subscription.countDocuments({
    tenantId,
    isCurrent: true,
    deleted: { $ne: true },
    subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
  });
  const chunksTotal =
    totalEst === 0 ? 0 : Math.ceil(totalEst / CHUNK);
  const balanceAsOf = new Date();
  batch.balanceAsOf = balanceAsOf;
  const asOf = balanceAsOf;

  batch.buildProgress = {
    totalMembersEstimated: totalEst,
    chunksTotal,
    chunksCompleted: 0,
    lastError: null,
  };
  batch.executeProgress = batch.executeProgress || {};

  let prevExecuteAt = null;
  if (batch.kind === REMINDER_BATCH_KIND.REMINDER) {
    const prev = batch.previousReminderBatchId
      ? await ReminderBatch.findById(batch.previousReminderBatchId).lean()
      : await findPreviousCompletedBatch(tenantId, REMINDER_BATCH_KIND.REMINDER);
    if (prev?.executeCompletedAt) prevExecuteAt = new Date(prev.executeCompletedAt);
  } else {
    const prev = await findPreviousCompletedBatch(
      tenantId,
      REMINDER_BATCH_KIND.CANCELLATION
    );
    if (prev?.executeCompletedAt) prevExecuteAt = new Date(prev.executeCompletedAt);
  }

  batch.buildContextPrevExecuteAt = prevExecuteAt || null;

  await ReminderBatchMember.deleteMany({ batchId: batch._id });
  await batch.save();

  return { batch, asOf, prevExecuteAt, req: workerReq(req, tenantId) };
}

/**
 * Build member rows for a page of subscriptions (lean docs).
 */
async function processBuildSubscriptionChunk({
  batch,
  asOf,
  prevExecuteAt,
  subs,
  tenantId,
  req,
}) {
  const r = workerReq(req, tenantId);
  let batchDoc =
    batch && typeof batch.kind === "string" ? batch : null;
  if (!batchDoc && batch) {
    batchDoc = await ReminderBatch.findById(batch).lean();
  }
  if (!batchDoc) return;
  if (!subs.length) {
    await ReminderBatch.updateOne(
      { _id: batchDoc._id },
      { $inc: { "buildProgress.chunksCompleted": 1 } }
    );
    return;
  }

  const profileIds = [...new Set(subs.map((s) => String(s.profileId)))];
  const profiles = await fetchProfilesByIds(
    profileIds.map((id) => new mongoose.Types.ObjectId(id)),
    tenantId,
    r
  );
  const profileById = new Map((profiles || []).map((p) => [String(p._id), p]));

  const memberRows = [];
  const uniqueMemberIds = new Set();
  for (const sub of subs) {
    const profile = profileById.get(String(sub.profileId));
    const memberId = profile?.membershipNumber
      ? String(profile.membershipNumber).trim()
      : "";
    if (!memberId) continue;
    if (isFreeOrExcludedCategory(sub.membershipCategory)) continue;
    uniqueMemberIds.add(memberId);
    memberRows.push({ sub, profile, memberId });
  }

  const memberIdList = [...uniqueMemberIds];
  const snapByMember = new Map();
  for (let i = 0; i < memberIdList.length; i += REMINDER_BATCH_ELIGIBILITY_CHUNK) {
    const chunk = memberIdList.slice(i, i + REMINDER_BATCH_ELIGIBILITY_CHUNK);
    const items = await fetchReminderEligibilityBulk(chunk, tenantId, asOf);
    for (const row of items) {
      if (row?.memberId) snapByMember.set(String(row.memberId), row);
    }
  }

  const bulkDocs = [];
  for (const { sub, profile, memberId } of memberRows) {
    const snap = snapByMember.get(memberId) || {};
    const eligibilitySnapshot = {
      ...snap,
      ruleVersion: REMINDER_BATCH_RULE_VERSION_DEFAULT,
      feeExpectedCents: null,
    };

    let tier = null;
    if (batchDoc.kind === REMINDER_BATCH_KIND.REMINDER) {
      tier = classifyMaxReminderTier(sub, snap, asOf, prevExecuteAt);
    } else {
      tier = classifyCancellationTier(sub, snap, asOf, prevExecuteAt);
    }

    if (!tier) {
      bulkDocs.push({
        tenantId,
        batchId: batchDoc._id,
        tier: REMINDER_BATCH_TIER.R1,
        profileId: sub.profileId,
        subscriptionId: sub._id,
        memberId,
        membershipNumber: memberId,
        included: false,
        exclusionReason: REMINDER_BATCH_EXCLUSION_REASON.NOT_DELINQUENT,
        eligibilitySnapshot,
      });
    } else {
      bulkDocs.push({
        tenantId,
        batchId: batchDoc._id,
        tier,
        profileId: sub.profileId,
        subscriptionId: sub._id,
        memberId,
        membershipNumber: memberId,
        included: true,
        exclusionReason: null,
        eligibilitySnapshot,
      });
    }
  }

  if (bulkDocs.length) {
    await ReminderBatchMember.insertMany(bulkDocs, { ordered: false });
  }

  await ReminderBatch.updateOne(
    { _id: batchDoc._id },
    { $inc: { "buildProgress.chunksCompleted": 1 } }
  );
}

async function finalizeBuildReminderBatch(batchId, tenantId) {
  const batch = await ReminderBatch.findOne({ _id: batchId, tenantId });
  if (!batch) return;

  const agg = await ReminderBatchMember.aggregate([
    {
      $match: {
        batchId: batch._id,
        included: true,
      },
    },
    { $group: { _id: "$tier", n: { $sum: 1 } } },
  ]);
  const counts = { r1: 0, r2: 0, r3: 0, cancel: 0 };
  for (const row of agg) {
    const t = row._id;
    const n = row.n || 0;
    if (t === REMINDER_BATCH_TIER.R1) counts.r1 = n;
    else if (t === REMINDER_BATCH_TIER.R2) counts.r2 = n;
    else if (t === REMINDER_BATCH_TIER.R3) counts.r3 = n;
    else if (t === REMINDER_BATCH_TIER.CANCEL) counts.cancel = n;
  }

  batch.countsByTier = counts;
  batch.ruleVersion = REMINDER_BATCH_RULE_VERSION_DEFAULT;
  batch.status = REMINDER_BATCH_STATUS.READY;
  batch.buildCompletedAt = new Date();
  batch.error = null;
  await batch.save();
  return batch.toObject();
}

async function buildReminderBatch(req, batchId) {
  const { batch, asOf, prevExecuteAt, req: wreq } = await beginBuildReminderBatch(
    batchId,
    req.tenantId,
    req
  );

  const filter = {
    tenantId: req.tenantId,
    isCurrent: true,
    deleted: { $ne: true },
    subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
  };

  let lastId = null;
  for (;;) {
    const q = lastId ? { ...filter, _id: { $gt: lastId } } : { ...filter };
    const subs = await Subscription.find(q)
      .sort({ _id: 1 })
      .limit(CHUNK)
      .lean();
    if (!subs.length) break;
    lastId = subs[subs.length - 1]._id;
    await processBuildSubscriptionChunk({
      batch: batch.toObject ? batch.toObject() : batch,
      asOf,
      prevExecuteAt,
      subs,
      tenantId: req.tenantId,
      req: wreq,
    });
  }

  return finalizeBuildReminderBatch(batch._id, req.tenantId);
}

async function beginExecuteReminderBatch(batchId, tenantId, req) {
  if (!mongoose.Types.ObjectId.isValid(batchId)) {
    throw AppError.badRequest("Invalid batchId");
  }
  const batch = await ReminderBatch.findOne({
    _id: batchId,
    tenantId,
  });
  if (!batch) throw AppError.notFound("Reminder batch not found");
  if (batch.status === REMINDER_BATCH_STATUS.COMPLETED) {
    return { batch, alreadyDone: true, executedAt: null, req: workerReq(req, tenantId) };
  }
  if (batch.status !== REMINDER_BATCH_STATUS.READY) {
    throw AppError.badRequest("Batch must be in ready status to execute");
  }

  const totalMembers = await ReminderBatchMember.countDocuments({
    batchId: batch._id,
    included: true,
  });
  const chunksTotal =
    totalMembers === 0 ? 0 : Math.ceil(totalMembers / CHUNK);

  const executedAt = new Date();
  batch.status = REMINDER_BATCH_STATUS.EXECUTING;
  batch.executeStartedAt = executedAt;
  batch.executeAnchorAt = executedAt;
  batch.executionCorrelationId = randomUUID();
  batch.error = null;
  batch.updatedBy = await resolveCrmUserObjectId(req);
  batch.executeProgress = {
    totalMembersEstimated: totalMembers,
    chunksTotal,
    chunksCompleted: 0,
    lastError: null,
  };
  await batch.save();

  return { batch, alreadyDone: false, executedAt, req: workerReq(req, tenantId) };
}

async function processExecuteMemberChunk({
  members,
  batch,
  executedAt,
  tenantId,
  req,
  queueJobId,
}) {
  const r = req;
  for (const m of members) {
    const sub = await Subscription.findById(m.subscriptionId);
    if (!sub) continue;

    if (batch.kind === REMINDER_BATCH_KIND.REMINDER) {
      ensureRemindersSubdoc(sub);
      if (m.tier === REMINDER_BATCH_TIER.R1 && !sub.reminders.reminder1At) {
        sub.reminders.reminder1At = executedAt;
      } else if (m.tier === REMINDER_BATCH_TIER.R2 && !sub.reminders.reminder2At) {
        sub.reminders.reminder2At = executedAt;
      } else if (m.tier === REMINDER_BATCH_TIER.R3 && !sub.reminders.reminder3At) {
        sub.reminders.reminder3At = executedAt;
      }
      sub.reminders.lastReminderBatchId = batch._id;
      await sub.save();
      const flagSet = { lastExecuteQueueJobId: queueJobId || null };
      if (m.tier === REMINDER_BATCH_TIER.R1) flagSet["flagsAppliedAt.r1At"] = executedAt;
      if (m.tier === REMINDER_BATCH_TIER.R2) flagSet["flagsAppliedAt.r2At"] = executedAt;
      if (m.tier === REMINDER_BATCH_TIER.R3) flagSet["flagsAppliedAt.r3At"] = executedAt;
      await ReminderBatchMember.updateOne(
        { _id: m._id },
        { $set: flagSet, $inc: { executeAttempt: 1 } }
      );
      await publishReminderCommsRequested(m, batch).catch(() => {});
      await publishSubscriptionCurrentUpdated(sub, {
        tenantId: sub.tenantId || tenantId,
        memberId: m.memberId,
      });
    } else if (batch.kind === REMINDER_BATCH_KIND.CANCELLATION) {
      if (m.tier !== REMINDER_BATCH_TIER.CANCEL) continue;
      const graceEnd = endOfCancellationGracePeriod(executedAt);
      if (!graceEnd) continue;
      sub.cancellation = {
        source: CANCELLATION_SOURCE.ARREARS,
        dateCancelled: executedAt,
        reason: "Reminder cancellation batch",
        gracePeriodEnd: graceEnd,
        reinstated: false,
        portalRoleDemotionPublishedAt: null,
      };
      ensureRemindersSubdoc(sub);
      sub.reminders.cancellationBatchNotifiedAt = executedAt;
      sub.reminders.scheduledEnforcementDate = graceEnd;
      sub.reminders.reminderCancellationBatchId = batch._id;
      sub.subscriptionStatus = MEMBERSHIP_STATUS.CANCELLED;
      sub.isCurrent = false;
      await sub.save();

      await ReminderBatchMember.updateOne(
        { _id: m._id },
        {
          $set: {
            "flagsAppliedAt.cancellationNotifiedAt": executedAt,
            lastExecuteQueueJobId: queueJobId || "rabbitmq",
          },
          $inc: { executeAttempt: 1 },
        }
      );
      await publishReminderCommsRequested(m, batch).catch(() => {});

      await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLED,
        {
          subscriptionId: sub._id.toString(),
          profileId: sub.profileId.toString(),
          tenantId: sub.tenantId || tenantId,
          applicationId: sub.applicationId || null,
          actorUserId: r?.userId || null,
          actorEmail: r?.user?.email || null,
        },
        {
          tenantId: sub.tenantId || tenantId,
          exchange: "membership.events",
          routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLED,
          metadata: { service: "subscription-service", version: "1.0" },
        }
      );

      await publishSubscriptionCurrentUpdated(sub, {
        tenantId: sub.tenantId || tenantId,
        memberId: m.memberId,
      });
    }
  }

  await ReminderBatch.updateOne(
    { _id: batch._id },
    { $inc: { "executeProgress.chunksCompleted": 1 } }
  );
}

async function finalizeExecuteReminderBatchSuccess(batchId, tenantId, executedAt) {
  let anchor = executedAt;
  if (!anchor) {
    const b = await ReminderBatch.findOne({ _id: batchId, tenantId })
      .select("executeAnchorAt executeStartedAt")
      .lean();
    anchor = b?.executeAnchorAt || b?.executeStartedAt || new Date();
  }
  await ReminderBatch.updateOne(
    { _id: batchId, tenantId },
    {
      $set: {
        status: REMINDER_BATCH_STATUS.COMPLETED,
        executeCompletedAt: anchor,
        error: null,
      },
    }
  );
  const batch = await ReminderBatch.findOne({ _id: batchId, tenantId }).lean();
  return batch;
}

async function markExecuteReminderBatchFailed(batchId, tenantId, err) {
  await ReminderBatch.updateOne(
    { _id: batchId, tenantId },
    {
      $set: {
        status: REMINDER_BATCH_STATUS.FAILED,
        error: err.message || String(err),
        "executeProgress.lastError": err.message || String(err),
      },
    }
  );
}

async function markBuildReminderBatchFailed(batchId, tenantId, err) {
  await ReminderBatch.updateOne(
    { _id: batchId, tenantId },
    {
      $set: {
        status: REMINDER_BATCH_STATUS.FAILED,
        error: err.message || String(err),
        "buildProgress.lastError": err.message || String(err),
      },
    }
  );
}

/**
 * Synchronous monthly ordering: cancellation execute then reminder build (no Redis).
 */
async function runMonthlyOrchestration(req, { cancellationBatchId, reminderBatchId }) {
  if (!cancellationBatchId || !mongoose.Types.ObjectId.isValid(cancellationBatchId)) {
    throw AppError.badRequest("cancellationBatchId is required");
  }
  if (!reminderBatchId || !mongoose.Types.ObjectId.isValid(reminderBatchId)) {
    throw AppError.badRequest("reminderBatchId is required");
  }
  await executeReminderBatch(req, cancellationBatchId);
  return buildReminderBatch(req, reminderBatchId);
}

async function executeReminderBatch(req, batchId) {
  const started = await beginExecuteReminderBatch(batchId, req.tenantId, req);
  if (started.alreadyDone) {
    return started.batch.toObject();
  }
  const { batch, executedAt, req: wreq } = started;

  try {
    const filter = { batchId: batch._id, included: true };
    let lastId = null;
    for (;;) {
      const q = lastId ? { ...filter, _id: { $gt: lastId } } : { ...filter };
      const members = await ReminderBatchMember.find(q)
        .sort({ _id: 1 })
        .limit(CHUNK)
        .lean();
      if (!members.length) break;
      lastId = members[members.length - 1]._id;
      await processExecuteMemberChunk({
        members,
        batch,
        executedAt,
        tenantId: req.tenantId,
        req: wreq,
        queueJobId: null,
      });
    }

    await finalizeExecuteReminderBatchSuccess(batch._id, req.tenantId, executedAt);
    const done = await ReminderBatch.findById(batch._id).lean();
    return done;
  } catch (e) {
    await markExecuteReminderBatchFailed(batch._id, req.tenantId, e);
    throw e;
  }
}

module.exports = {
  createReminderBatch,
  listReminderBatches,
  getReminderBatchById,
  listReminderBatchMembers,
  buildReminderBatch,
  executeReminderBatch,
  beginBuildReminderBatch,
  processBuildSubscriptionChunk,
  finalizeBuildReminderBatch,
  beginExecuteReminderBatch,
  processExecuteMemberChunk,
  finalizeExecuteReminderBatchSuccess,
  markExecuteReminderBatchFailed,
  markBuildReminderBatchFailed,
  runMonthlyOrchestration,
  CHUNK,
};
