const mongoose = require("mongoose");
const YearEndBatch = require("../models/yearEndBatch.model");
const YearEndBatchMember = require("../models/yearEndBatchMember.model");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const {
  RENEWAL_BATCH_STATUS,
  RENEWAL_BATCH_MEMBER_ACTION,
  MEMBERSHIP_STATUS,
  MEMBERSHIP_MOVEMENT,
  YEAREND_RESULT,
} = require("../constants/enums");
const { AppError } = require("../errors/AppError");
const {
  createInternalWorkerReq,
  fetchMemberSummariesByMemberIds,
  fetchProfilesByIds,
  postMemberOutstandingWriteOff,
} = require("../helpers/serviceClient");
const {
  publishReportingSnapshotForSubscription,
} = require("../helpers/reportingSnapshotPublish");
const { publishSubscriptionCurrentUpdated } = require("../rabbitMQ/publishers/subscription.current.updated.publisher.js");
const bizLogger = require("../config/bizLogger.js");
const { emitRenewalBatchEvent } = require("../lib/renewalBatch.sse.js");
const renewalBatchRabbit = require("../jobs/renewalBatch.rabbit.js");

const BULK_CHUNK = 500;
const PROFILE_CHUNK = 200;

function subscriptionBaseFilter(tenantId, fiscalYear) {
  return {
    tenantId,
    isCurrent: true,
    subscriptionYear: fiscalYear,
    deleted: false,
  };
}

function currentClosedFiscalYear() {
  return new Date().getFullYear() - 1;
}

function assertProcessableFiscalYear(fiscalYear) {
  const maxFiscalYear = currentClosedFiscalYear();
  if (fiscalYear > maxFiscalYear) {
    throw AppError.badRequest(
      `Year-end renewal can only be run up to fiscal year ${maxFiscalYear}`
    );
  }
}

function startOfYearUtcNoon(year) {
  return new Date(Date.UTC(year, 0, 1, 12, 0, 0, 0));
}

function endOfYearUtc(year) {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}

function dayAfterEndUtc(year) {
  return new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));
}

async function resolveCrmUserObjectId(req) {
  if (!req.userId || !req.tenantId) return null;
  const crmUser = await User.findOne({
    userId: req.userId,
    tenantId: req.tenantId,
  }).lean();
  return crmUser?._id || null;
}

async function assertNoConcurrentRenewalBatch(tenantId) {
  const other = await YearEndBatch.findOne({
    tenantId,
    status: {
      $in: [RENEWAL_BATCH_STATUS.QUEUED, RENEWAL_BATCH_STATUS.INPROGRESS],
    },
  })
    .select("_id")
    .lean();
  if (other) {
    throw AppError.conflict(
      "Another renewal batch is already queued or in progress for this tenant"
    );
  }
}

async function assertYearHasNotCompleted(tenantId, fiscalYear, excludeBatchId = null) {
  const query = {
    tenantId,
    fiscalYear,
    status: RENEWAL_BATCH_STATUS.COMPLETED,
  };
  if (excludeBatchId) query._id = { $ne: excludeBatchId };

  const completed = await YearEndBatch.findOne(query).select("_id").lean();
  if (completed) {
    throw AppError.conflict(
      `Year-end renewal has already been completed for fiscal year ${fiscalYear}`
    );
  }
}

function emitBatch(batchId, extra = {}) {
  emitRenewalBatchEvent(batchId, extra);
}

async function buildMembershipMap(profileIds, tenantId, req) {
  const map = new Map();
  const ids = [...new Set(profileIds.map((id) => String(id)))];
  for (let i = 0; i < ids.length; i += PROFILE_CHUNK) {
    const slice = ids.slice(i, i + PROFILE_CHUNK).map((s) => new mongoose.Types.ObjectId(s));
    const profiles = await fetchProfilesByIds(slice, tenantId, req || {});
    for (const p of profiles || []) {
      const pid = p._id?.toString?.() ?? String(p._id);
      const num = p.membershipNumber != null ? String(p.membershipNumber).trim() : "";
      map.set(pid, num || pid);
    }
  }
  return map;
}

async function buildBalanceSnapshotMap(memberIds, tenantId) {
  const map = new Map();
  const uniqueIds = [...new Set((memberIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) return map;

  try {
    const req = createInternalWorkerReq(tenantId);
    const summaries = await fetchMemberSummariesByMemberIds(uniqueIds, tenantId, req);
    for (const row of summaries || []) {
      if (!row?.memberId) continue;
      map.set(String(row.memberId), {
        capturedAt: new Date(),
        source: "account-service.summary-batch",
        summary: row.summary || null,
      });
    }
  } catch (err) {
    console.warn("[renewalBatch] balance snapshot fetch failed", err.message);
  }

  return map;
}

async function persistYearEndBalanceSnapshots(rows, snapshotMap, fallbackDate) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;

  const ops = list.map((row) => ({
    updateOne: {
      filter: { _id: row._id },
      update: {
        $set: {
          balanceSnapshot:
            snapshotMap.get(String(row.memberId)) || {
              capturedAt: fallbackDate,
              source: "account-service.summary-batch",
              summary: null,
            },
        },
      },
    },
  }));

  await YearEndBatchMember.bulkWrite(ops, { ordered: false });
}

async function writeOffArchivedMemberBalances({
  rows,
  snapshotMap,
  tenantId,
  fiscalYear,
  batchId,
  date,
}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;

  const req = createInternalWorkerReq(tenantId);
  for (const row of list) {
    const snapshot = snapshotMap.get(String(row.memberId)) || null;
    const summary = snapshot?.summary || null;
    const writeOff = await postMemberOutstandingWriteOff({
      memberId: row.memberId,
      tenantId,
      req,
      date,
      docNoBase: `WO-YE-${fiscalYear}-ARCHIVE-${row.memberId}`,
      memo: `Year-end ${fiscalYear} suspended-to-archived write-off; renewalBatchId ${batchId}`,
      summary,
      requireSummary: true,
    });

    await YearEndBatchMember.updateOne(
      { _id: row._id },
      {
        $set: {
          writeOff: {
            ...writeOff,
            postedAt: new Date(),
            source: "year-end-archive",
          },
        },
      }
    );
  }
}

function afterStatusForAction(action, beforeStatus) {
  if (action === RENEWAL_BATCH_MEMBER_ACTION.ARCHIVE) {
    return MEMBERSHIP_STATUS.ARCHIVED;
  }
  if (action === RENEWAL_BATCH_MEMBER_ACTION.SUSPEND) {
    return MEMBERSHIP_STATUS.SUSPENDED;
  }
  if (action === RENEWAL_BATCH_MEMBER_ACTION.RENEW) {
    return MEMBERSHIP_STATUS.RENEWED;
  }
  return beforeStatus || null;
}

async function publishYearEndReportingSnapshot(subscriptionDoc, row, ctx) {
  if (!subscriptionDoc) return;
  await publishReportingSnapshotForSubscription(subscriptionDoc, {
    tenantId: subscriptionDoc.tenantId || ctx.tenantId,
    memberId: row?.memberId,
    processingDate: ctx.processingDate,
    renewalBatchId: ctx.renewalBatchId,
    yearEndFiscalYear: ctx.yearEndFiscalYear,
    yearEndAction: ctx.yearEndAction,
    previousMembershipStatus:
      row?.beforeStatus || subscriptionDoc.previousMembershipStatus,
    newMembershipStatus: ctx.newMembershipStatus,
    snapshotAsOfDate: ctx.snapshotAsOfDate,
  });
}

/**
 * @param {string} batchId
 */
async function runPreviewJob(batchId) {
  const batch = await YearEndBatch.findById(batchId);
  if (!batch || batch.status !== RENEWAL_BATCH_STATUS.DRAFT) return;

  try {
    const { tenantId, fiscalYear } = batch;
    const base = subscriptionBaseFilter(tenantId, fiscalYear);

    const [
      beforeArchived,
      beforeSuspended,
      beforeCancelled,
      beforeResigned,
      beforeActive,
      toArchive,
      toSuspend,
      toRenew,
    ] = await Promise.all([
      Subscription.countDocuments({
        tenantId,
        subscriptionYear: fiscalYear,
        deleted: false,
        subscriptionStatus: MEMBERSHIP_STATUS.ARCHIVED,
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.SUSPENDED,
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.CANCELLED,
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.RESIGNED,
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.SUSPENDED,
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: {
          $in: [MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.RESIGNED],
        },
      }),
      Subscription.countDocuments({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
      }),
    ]);

    const [archiveSubs, suspendSubs, renewSubs] = await Promise.all([
      Subscription.find({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.SUSPENDED,
      })
        .select("_id profileId subscriptionStatus")
        .lean(),
      Subscription.find({
        ...base,
        subscriptionStatus: {
          $in: [MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.RESIGNED],
        },
      })
        .select("_id profileId subscriptionStatus")
        .lean(),
      Subscription.find({
        ...base,
        subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
      })
        .select("_id profileId subscriptionStatus")
        .lean(),
    ]);

    const allProfileIds = [
      ...archiveSubs.map((s) => s.profileId),
      ...suspendSubs.map((s) => s.profileId),
      ...renewSubs.map((s) => s.profileId),
    ];
    const membershipMap = await buildMembershipMap(allProfileIds, tenantId, null);

    const memberDocs = [];
    function pushRows(subs, action) {
      for (const s of subs) {
        const pid = s.profileId.toString();
        const beforeStatus = s.subscriptionStatus || null;
        memberDocs.push({
          tenantId,
          batchId: batch._id,
          action,
          profileId: s.profileId,
          subscriptionId: s._id,
          memberId: membershipMap.get(pid) || pid,
          beforeStatus,
          afterStatus: afterStatusForAction(action, beforeStatus),
        });
      }
    }
    pushRows(archiveSubs, RENEWAL_BATCH_MEMBER_ACTION.ARCHIVE);
    pushRows(suspendSubs, RENEWAL_BATCH_MEMBER_ACTION.SUSPEND);
    pushRows(renewSubs, RENEWAL_BATCH_MEMBER_ACTION.RENEW);

    await YearEndBatchMember.deleteMany({ batchId: batch._id });
    if (memberDocs.length) {
      await YearEndBatchMember.insertMany(memberDocs, { ordered: false });
    }

    batch.metrics = {
      beforeArchived,
      beforeSuspended,
      beforeCancelled,
      beforeResigned,
      beforeActive,
      toArchive,
      toSuspend,
      toRenew,
      archivedAfter: beforeArchived + toArchive,
      suspendedAfter: toSuspend,
      renewedAfter: toRenew,
      newActiveAfter: toRenew,
    };
    batch.status = RENEWAL_BATCH_STATUS.READY;
    batch.previewCompletedAt = new Date();
    batch.error = null;
    await batch.save();

    emitBatch(batch._id, {
      status: batch.status,
      step: "preview",
      metrics: batch.metrics,
    });
  } catch (err) {
    console.error("[renewalBatch] preview error", err);
    await YearEndBatch.updateOne(
      { _id: batchId },
      {
        $set: {
          status: RENEWAL_BATCH_STATUS.FAILED,
          error: err.message || String(err),
          previewCompletedAt: new Date(),
        },
      }
    );
    emitBatch(batchId, {
      status: RENEWAL_BATCH_STATUS.FAILED,
      step: "preview",
      error: err.message || String(err),
    });
  }
}

async function createRenewalBatch(req, body) {
  const { name, fiscalYear } = body || {};
  if (!name || !String(name).trim()) throw AppError.badRequest("name is required");
  const fy = parseInt(fiscalYear, 10);
  if (!Number.isFinite(fy) || fy < 1900 || fy > 3000) {
    throw AppError.badRequest("fiscalYear must be a valid year");
  }
  assertProcessableFiscalYear(fy);
  await assertYearHasNotCompleted(req.tenantId, fy);

  const openBatch = await YearEndBatch.findOne({
    tenantId: req.tenantId,
    fiscalYear: fy,
    status: {
      $in: [
        RENEWAL_BATCH_STATUS.DRAFT,
        RENEWAL_BATCH_STATUS.READY,
        RENEWAL_BATCH_STATUS.QUEUED,
        RENEWAL_BATCH_STATUS.INPROGRESS,
      ],
    },
  })
    .select("_id status fiscalYear")
    .lean();
  if (openBatch) {
    throw AppError.conflict(
      `A ${openBatch.status} year-end renewal batch already exists for fiscal year ${fy}`
    );
  }

  const createdBy = await resolveCrmUserObjectId(req);
  const doc = await YearEndBatch.create({
    tenantId: req.tenantId,
    name: String(name).trim(),
    fiscalYear: fy,
    status: RENEWAL_BATCH_STATUS.DRAFT,
    metrics: {
      beforeArchived: 0,
      beforeSuspended: 0,
      beforeCancelled: 0,
      beforeResigned: 0,
      beforeActive: 0,
      toArchive: 0,
      toSuspend: 0,
      toRenew: 0,
      archivedAfter: 0,
      suspendedAfter: 0,
      renewedAfter: 0,
      newActiveAfter: 0,
    },
    runBy: createdBy,
    createdBy,
    updatedBy: createdBy,
  });

  setImmediate(() => {
    runPreviewJob(String(doc._id)).catch((e) =>
      console.error("[renewalBatch] preview setImmediate", e)
    );
  });

  return doc.toObject();
}

async function getBatchWithMembers(req, batch) {
  if (!batch) return null;
  const batchId = batch._id;
  const members = await YearEndBatchMember.find({
    batchId,
    tenantId: req.tenantId,
  })
    .select("action memberId profileId subscriptionId")
    .lean();

  const byAction = {
    [RENEWAL_BATCH_MEMBER_ACTION.ARCHIVE]: [],
    [RENEWAL_BATCH_MEMBER_ACTION.SUSPEND]: [],
    [RENEWAL_BATCH_MEMBER_ACTION.RENEW]: [],
  };
  for (const m of members) {
    if (byAction[m.action]) byAction[m.action].push(m.memberId);
  }

  return {
    ...batch,
    memberIdsByAction: byAction,
    memberCount: members.length,
  };
}

async function getRenewalBatchById(req, batchId) {
  if (!mongoose.Types.ObjectId.isValid(batchId)) {
    throw AppError.badRequest("Invalid batch id");
  }
  const batch = await YearEndBatch.findOne({
    _id: batchId,
    tenantId: req.tenantId,
  }).lean();
  if (!batch) throw AppError.notFound("Renewal batch not found");

  return getBatchWithMembers(req, batch);
}

async function getLatestRenewalBatchByYear(req, fiscalYear) {
  const fy = parseInt(fiscalYear, 10);
  if (!Number.isFinite(fy)) throw AppError.badRequest("fiscalYear must be a valid year");
  const batch = await YearEndBatch.findOne({
    tenantId: req.tenantId,
    fiscalYear: fy,
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  return getBatchWithMembers(req, batch);
}

async function listRenewalYearOptions(req) {
  const maxFiscalYear = currentClosedFiscalYear();
  const [subscriptionYearsRaw, batchYearsRaw] = await Promise.all([
    Subscription.distinct("subscriptionYear", {
      tenantId: req.tenantId,
      deleted: false,
      subscriptionYear: { $lte: maxFiscalYear },
    }),
    YearEndBatch.distinct("fiscalYear", {
      tenantId: req.tenantId,
      fiscalYear: { $lte: maxFiscalYear },
    }),
  ]);

  const years = new Set([maxFiscalYear]);
  for (const raw of [...subscriptionYearsRaw, ...batchYearsRaw]) {
    const year = parseInt(raw, 10);
    if (Number.isFinite(year) && year <= maxFiscalYear) years.add(year);
  }

  const sortedYears = [...years].sort((a, b) => b - a);
  const batches = await YearEndBatch.find({
    tenantId: req.tenantId,
    fiscalYear: { $in: sortedYears },
  })
    .sort({ fiscalYear: -1, createdAt: -1, _id: -1 })
    .lean();

  const latestByYear = new Map();
  const completedYears = new Set();
  for (const batch of batches) {
    if (!latestByYear.has(batch.fiscalYear)) {
      latestByYear.set(batch.fiscalYear, batch);
    }
    if (batch.status === RENEWAL_BATCH_STATUS.COMPLETED) {
      completedYears.add(batch.fiscalYear);
    }
  }

  return {
    defaultFiscalYear: maxFiscalYear,
    maxFiscalYear,
    years: sortedYears.map((fiscalYear) => {
      const latestBatch = latestByYear.get(fiscalYear) || null;
      const hasCompleted = completedYears.has(fiscalYear);
      return {
        fiscalYear,
        status: latestBatch?.status || "NOT_STARTED",
        batchId: latestBatch?._id || null,
        hasCompleted,
        isReadOnly: hasCompleted,
        canCreatePreview:
          !hasCompleted &&
          ![
            RENEWAL_BATCH_STATUS.DRAFT,
            RENEWAL_BATCH_STATUS.READY,
            RENEWAL_BATCH_STATUS.QUEUED,
            RENEWAL_BATCH_STATUS.INPROGRESS,
          ].includes(latestBatch?.status),
        canExecute: !hasCompleted && latestBatch?.status === RENEWAL_BATCH_STATUS.READY,
      };
    }),
  };
}

async function requestExecuteRenewalBatch(req, batchId) {
  if (!mongoose.Types.ObjectId.isValid(batchId)) {
    throw AppError.badRequest("Invalid batch id");
  }

  await assertNoConcurrentRenewalBatch(req.tenantId);

  const existing = await YearEndBatch.findOne({
    _id: batchId,
    tenantId: req.tenantId,
  }).lean();
  if (!existing) throw AppError.notFound("Renewal batch not found");
  assertProcessableFiscalYear(existing.fiscalYear);
  await assertYearHasNotCompleted(req.tenantId, existing.fiscalYear, existing._id);

  const updatedBy = await resolveCrmUserObjectId(req);
  const updated = await YearEndBatch.findOneAndUpdate(
    {
      _id: batchId,
      tenantId: req.tenantId,
      status: RENEWAL_BATCH_STATUS.READY,
    },
    {
      $set: {
        status: RENEWAL_BATCH_STATUS.QUEUED,
        updatedBy,
        lastEventAt: new Date(),
      },
    },
    { new: true }
  );

  if (!updated) {
    throw AppError.badRequest(
      "Batch must be in READY state to execute, or batch not found"
    );
  }

  emitBatch(batchId, { status: RENEWAL_BATCH_STATUS.QUEUED, step: "queued" });

  if (renewalBatchRabbit.isRabbitConfigured()) {
    try {
      await renewalBatchRabbit.publishRenewalExecuteRequested(req, String(batchId));
      bizLogger.business("Membership renewal batch queued for processing", {
        eventType: "MembershipRenewalQueued",
        tenantId: req.tenantId || null,
        profileId: null,
        applicationId: null,
        membershipId: null,
      }, req);
    } catch (e) {
      console.error("[renewalBatch] rabbit publish failed", e);
      await YearEndBatch.updateOne(
        { _id: batchId, tenantId: req.tenantId },
        {
          $set: {
            status: RENEWAL_BATCH_STATUS.READY,
            error: `Queue error: ${e.message || e}`,
          },
        }
      );
      throw AppError.serviceUnavailable(
        "Could not queue renewal batch job. Check RABBIT_URL and RabbitMQ availability."
      );
    }
  } else {
    setImmediate(() => {
      processRenewalBatchExecute(String(batchId)).catch((err) => {
        console.error("[renewalBatch] inline execute failed", err);
      });
    });
  }

  return updated.toObject();
}

async function bulkUpdateSubscriptionChunk(ids, $set) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const chunk = ids.slice(i, i + BULK_CHUNK);
    const ops = chunk.map((_id) => ({
      updateOne: {
        filter: { _id },
        update: { $set },
      },
    }));
    await Subscription.bulkWrite(ops, { ordered: false });
  }
}

/**
 * @param {string} batchId
 */
async function processRenewalBatchExecute(batchId) {
  const claimed = await YearEndBatch.findOneAndUpdate(
    {
      _id: batchId,
      status: RENEWAL_BATCH_STATUS.QUEUED,
    },
    {
      $set: {
        status: RENEWAL_BATCH_STATUS.INPROGRESS,
        executeStartedAt: new Date(),
        lastEventAt: new Date(),
        error: null,
      },
    },
    { new: true }
  );

  if (!claimed) {
    const existing = await YearEndBatch.findById(batchId).lean();
    if (existing?.status === RENEWAL_BATCH_STATUS.COMPLETED) return;
    console.warn(
      "[renewalBatch] execute skipped (not QUEUED)",
      batchId,
      existing?.status
    );
    return;
  }

  const batch = claimed;
  const executedAt = new Date();
  const processingDateISO = executedAt.toISOString().split("T")[0];
  const snapshotAsOfDate = dayAfterEndUtc(batch.fiscalYear);

  emitBatch(batchId, { status: RENEWAL_BATCH_STATUS.INPROGRESS, step: "started" });

  try {
    const archiveRows = await YearEndBatchMember.find({
      batchId,
      action: RENEWAL_BATCH_MEMBER_ACTION.ARCHIVE,
    })
      .select("_id subscriptionId memberId beforeStatus afterStatus")
      .lean();
    const archiveBalanceSnapshotMap = await buildBalanceSnapshotMap(
      archiveRows.map((row) => row.memberId),
      batch.tenantId
    );
    await persistYearEndBalanceSnapshots(
      archiveRows,
      archiveBalanceSnapshotMap,
      executedAt
    );
    await writeOffArchivedMemberBalances({
      rows: archiveRows,
      snapshotMap: archiveBalanceSnapshotMap,
      tenantId: batch.tenantId,
      fiscalYear: batch.fiscalYear,
      batchId: batch._id,
      date: processingDateISO,
    });
    const archiveIds = archiveRows.map((r) => r.subscriptionId);
    await bulkUpdateSubscriptionChunk(archiveIds, {
      subscriptionStatus: MEMBERSHIP_STATUS.ARCHIVED,
      isCurrent: false,
      renewalBatchId: batch._id,
      yearend: {
        processed: true,
        processedAt: executedAt,
        result: YEAREND_RESULT.ARCHIVED,
      },
    });
    const archivedSubs = await Subscription.find({ _id: { $in: archiveIds } }).lean();
    const archivedMap = new Map(archivedSubs.map((s) => [String(s._id), s]));
    for (const row of archiveRows) {
      await publishYearEndReportingSnapshot(
        archivedMap.get(String(row.subscriptionId)),
        row,
        {
          tenantId: batch.tenantId,
          processingDate: processingDateISO,
          renewalBatchId: batch._id,
          yearEndFiscalYear: batch.fiscalYear,
          yearEndAction: row.action,
          newMembershipStatus: MEMBERSHIP_STATUS.ARCHIVED,
          snapshotAsOfDate,
        }
      );
    }
    emitBatch(batchId, { status: RENEWAL_BATCH_STATUS.INPROGRESS, step: "archive_done" });

    const suspendRows = await YearEndBatchMember.find({
      batchId,
      action: RENEWAL_BATCH_MEMBER_ACTION.SUSPEND,
    })
      .select("subscriptionId memberId beforeStatus afterStatus")
      .lean();
    const suspendIds = suspendRows.map((r) => r.subscriptionId);
    await bulkUpdateSubscriptionChunk(suspendIds, {
      subscriptionStatus: MEMBERSHIP_STATUS.SUSPENDED,
      isCurrent: false,
      renewalBatchId: batch._id,
      yearend: {
        processed: true,
        processedAt: executedAt,
        result: YEAREND_RESULT.SUSPENDED,
      },
    });
    const suspendedSubs = await Subscription.find({ _id: { $in: suspendIds } }).lean();
    const suspendedMap = new Map(suspendedSubs.map((s) => [String(s._id), s]));
    for (const row of suspendRows) {
      await publishYearEndReportingSnapshot(
        suspendedMap.get(String(row.subscriptionId)),
        row,
        {
          tenantId: batch.tenantId,
          processingDate: processingDateISO,
          renewalBatchId: batch._id,
          yearEndFiscalYear: batch.fiscalYear,
          yearEndAction: row.action,
          newMembershipStatus: MEMBERSHIP_STATUS.SUSPENDED,
          snapshotAsOfDate,
        }
      );
    }
    emitBatch(batchId, { status: RENEWAL_BATCH_STATUS.INPROGRESS, step: "suspend_done" });

    const renewRows = await YearEndBatchMember.find({
      batchId,
      action: RENEWAL_BATCH_MEMBER_ACTION.RENEW,
    }).lean();

    const newYear = batch.fiscalYear + 1;
    const startDate = startOfYearUtcNoon(newYear);
    const endDate = endOfYearUtc(newYear);
    const rolloverDate = dayAfterEndUtc(newYear);

    const profileIds = renewRows.map((r) => r.profileId);
    const membershipMap = await buildMembershipMap(profileIds, batch.tenantId, null);

    for (const row of renewRows) {
      const oldSub = await Subscription.findById(row.subscriptionId);
      if (!oldSub) continue;
      if (oldSub.subscriptionStatus !== MEMBERSHIP_STATUS.ACTIVE) continue;

      const profileIdStr = oldSub.profileId.toString();
      const memberId =
        membershipMap.get(profileIdStr) || row.memberId || profileIdStr;

      await Subscription.updateOne(
        { _id: oldSub._id },
        {
          $set: {
            isCurrent: false,
            subscriptionStatus: MEMBERSHIP_STATUS.RENEWED,
            renewalBatchId: batch._id,
            yearend: {
              processed: true,
              processedAt: executedAt,
              result: YEAREND_RESULT.RENEWED,
            },
          },
        }
      );
      const renewedOldSub = await Subscription.findById(oldSub._id).lean();
      await publishYearEndReportingSnapshot(renewedOldSub, row, {
        tenantId: batch.tenantId,
        processingDate: processingDateISO,
        renewalBatchId: batch._id,
        yearEndFiscalYear: batch.fiscalYear,
        yearEndAction: RENEWAL_BATCH_MEMBER_ACTION.RENEW,
        newMembershipStatus: MEMBERSHIP_STATUS.RENEWED,
        snapshotAsOfDate,
      });

      const newSub = await Subscription.create({
        tenantId: oldSub.tenantId,
        profileId: oldSub.profileId,
        userId: oldSub.userId,
        applicationId: oldSub.applicationId,
        subscriptionYear: newYear,
        isCurrent: true,
        subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
        startDate,
        endDate,
        rolloverDate,
        reminderHistory: [],
        reminders: {
          reminder1At: null,
          reminder2At: null,
          reminder3At: null,
          lastReminderBatchId: null,
          cancellationBatchNotifiedAt: null,
          scheduledEnforcementDate: null,
          reminderCancellationBatchId: null,
          clearedAt: null,
          clearedReason: null,
        },
        membershipMovement: MEMBERSHIP_MOVEMENT.RENEWED,
        previousSubscriptionId: oldSub._id,
        previousMembershipStatus: oldSub.subscriptionStatus,
        movementResolvedAt: executedAt,
        renewalBatchId: batch._id,
        membershipCategory: oldSub.membershipCategory,
        paymentType: oldSub.paymentType,
        payrollNo: oldSub.payrollNo,
        paymentFrequency: oldSub.paymentFrequency,
        deleted: false,
      });

      await publishSubscriptionCurrentUpdated(newSub, {
        tenantId: oldSub.tenantId || batch.tenantId,
        memberId,
        membershipCategory: newSub.membershipCategory,
        startDate: newSub.startDate,
        userId: newSub.userId,
        processingDate: processingDateISO,
        renewalBatchId: batch._id,
      });
      await publishYearEndReportingSnapshot(newSub, row, {
        tenantId: batch.tenantId,
        processingDate: processingDateISO,
        renewalBatchId: batch._id,
        yearEndFiscalYear: batch.fiscalYear,
        yearEndAction: RENEWAL_BATCH_MEMBER_ACTION.RENEW,
        newMembershipStatus: MEMBERSHIP_STATUS.ACTIVE,
        snapshotAsOfDate,
      });
    }

    const processedRows = await YearEndBatchMember.find({
      batchId,
      balanceSnapshot: null,
    })
      .select("_id memberId")
      .lean();
    const balanceSnapshotMap = await buildBalanceSnapshotMap(
      processedRows.map((row) => row.memberId),
      batch.tenantId
    );
    if (processedRows.length) {
      const ops = processedRows.map((row) => ({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              processedAt: executedAt,
              balanceSnapshot:
                balanceSnapshotMap.get(String(row.memberId)) || {
                  capturedAt: executedAt,
                  source: "account-service.summary-batch",
                  summary: null,
                },
            },
          },
        },
      }));
      await YearEndBatchMember.bulkWrite(ops, { ordered: false });
    }

    emitBatch(batchId, { status: RENEWAL_BATCH_STATUS.INPROGRESS, step: "renew_done" });

    await YearEndBatch.updateOne(
      { _id: batchId },
      {
        $set: {
          status: RENEWAL_BATCH_STATUS.COMPLETED,
          executeCompletedAt: new Date(),
          lastEventAt: new Date(),
          error: null,
        },
      }
    );

    emitBatch(batchId, {
      status: RENEWAL_BATCH_STATUS.COMPLETED,
      step: "completed",
    });
  } catch (err) {
    console.error("[renewalBatch] execute error", err);
    await YearEndBatch.updateOne(
      { _id: batchId },
      {
        $set: {
          status: RENEWAL_BATCH_STATUS.FAILED,
          error: err.message || String(err),
          lastEventAt: new Date(),
        },
      }
    );
    emitBatch(batchId, {
      status: RENEWAL_BATCH_STATUS.FAILED,
      step: "failed",
      error: err.message || String(err),
    });
  }
}

module.exports = {
  createRenewalBatch,
  getRenewalBatchById,
  getLatestRenewalBatchByYear,
  listRenewalYearOptions,
  requestExecuteRenewalBatch,
  processRenewalBatchExecute,
  runPreviewJob,
};
