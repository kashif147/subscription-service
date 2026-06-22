const { USER_TYPE } = require("../constants/enums");
const { AppError } = require("../errors/AppError");
const reminderBatchService = require("../services/reminderBatch.service");
const reminderBatchRabbit = require("../jobs/reminderBatch.rabbit.js");
const { runOrQueueReminderBatchBuild } = require("../helpers/reminderBatchBuildTrigger.js");
const bizLogger = require("../config/bizLogger.js");

function ensureCrm(req, res) {
  if (!req.user || req.user.userType !== USER_TYPE.CRM) {
    res.status(403).json({
      status: "fail",
      data: "Access denied. CRM users only.",
    });
    return false;
  }
  return true;
}

function handleError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ status: "fail", data: err.message });
  }
  console.error("[reminderBatch]", err);
  return res.serverError(err);
}

async function postCreate(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const created = await reminderBatchService.createReminderBatch(req, req.body || {});
    const batchId = String(created._id);
    const buildOutcome = await runOrQueueReminderBatchBuild(req, batchId);
    const data = buildOutcome.batch
      ? buildOutcome.batch
      : await reminderBatchService.getReminderBatchById(req, batchId);
    if (buildOutcome.queued) {
      data.buildQueued = true;
    }
    return res.status(201).json({ status: "success", data });
  } catch (e) {
    return handleError(res, e);
  }
}

async function getList(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const data = await reminderBatchService.listReminderBatches(req, req.query || {});
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function getOne(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const data = await reminderBatchService.getReminderBatchById(req, req.params.batchId);
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function deleteDraft(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const data = await reminderBatchService.deleteDraftReminderBatch(
      req,
      req.params.batchId
    );
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function getMembers(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const data = await reminderBatchService.listReminderBatchMembers(
      req,
      req.params.batchId,
      req.query || {}
    );
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function postBuild(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const buildOutcome = await runOrQueueReminderBatchBuild(req, req.params.batchId);
    if (buildOutcome.batch) {
      return res.success(buildOutcome.batch);
    }
    const batch = await reminderBatchService.getReminderBatchById(req, req.params.batchId);
    return res.success({
      ...batch,
      buildQueued: true,
      transport: buildOutcome.transport,
    });
  } catch (e) {
    return handleError(res, e);
  }
}

async function postExecute(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const data = reminderBatchRabbit.isRabbitConfigured()
      ? await reminderBatchRabbit.publishReminderExecuteRequested(req, req.params.batchId)
      : await reminderBatchService.executeReminderBatch(req, req.params.batchId);
    bizLogger.business("Reminder batch execution issued", {
      eventType: "ReminderIssued",
      tenantId: req.tenantId || null,
    }, req);
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function postMonthlyOrchestrate(req, res) {
  if (!ensureCrm(req, res)) return;
  try {
    const body = req.body || {};
    if (!body.cancellationBatchId || !body.reminderBatchId) {
      return res.status(400).json({
        status: "fail",
        data: "cancellationBatchId and reminderBatchId are required",
      });
    }
    const data = reminderBatchRabbit.isRabbitConfigured()
      ? await reminderBatchRabbit.publishReminderMonthlyOrchestrateRequested(req, body)
      : await reminderBatchService.runMonthlyOrchestration(req, body);
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

module.exports = {
  postCreate,
  getList,
  getOne,
  deleteDraft,
  getMembers,
  postBuild,
  postExecute,
  postMonthlyOrchestrate,
};
