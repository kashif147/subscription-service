const { USER_TYPE } = require("../constants/enums");
const { AppError } = require("../errors/AppError");
const renewalBatchService = require("../services/renewalBatch.service");
const YearEndBatch = require("../models/yearEndBatch.model");
const { attachRenewalBatchSse } = require("../lib/renewalBatch.sse.js");

function normalizeRoleValue(role) {
  if (!role) return "";
  const raw =
    typeof role === "string"
      ? role
      : role.code || role.name || role.roleCode || role.roleName || "";
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function hasSuperUserRole(req) {
  const roles = Array.isArray(req.roles)
    ? req.roles
    : Array.isArray(req.user?.roles)
      ? req.user.roles
      : [];
  return roles.map(normalizeRoleValue).some((role) =>
    ["su", "super user", "superuser"].includes(role)
  );
}

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

function ensureYearEndAccess(req, res) {
  if (!ensureCrm(req, res)) return false;
  const permissions = Array.isArray(req.permissions)
    ? req.permissions
    : Array.isArray(req.user?.permissions)
      ? req.user.permissions
      : [];
  const hasWritePermission =
    permissions.includes("*") ||
    permissions.includes("subscriptions:write") ||
    permissions.includes("payments:write");

  if (hasWritePermission || hasSuperUserRole(req)) return true;

  res.status(403).json({
    status: "fail",
    data: "Access denied. Year-end renewal requires Accounts, Membership Officer, or Super User access.",
  });
  return false;
}

function handleError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ status: "fail", data: err.message });
  }
  console.error("[renewalBatch]", err);
  return res.serverError(err);
}

async function postCreate(req, res) {
  if (!ensureYearEndAccess(req, res)) return;
  try {
    const data = await renewalBatchService.createRenewalBatch(req, req.body || {});
    return res.status(201).json({ status: "success", data });
  } catch (e) {
    return handleError(res, e);
  }
}

async function getOne(req, res) {
  if (!ensureYearEndAccess(req, res)) return;
  try {
    const data = await renewalBatchService.getRenewalBatchById(
      req,
      req.params.batchId
    );
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function getYearOptions(req, res) {
  if (!ensureYearEndAccess(req, res)) return;
  try {
    const data = await renewalBatchService.listRenewalYearOptions(req);
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function getByYear(req, res) {
  if (!ensureYearEndAccess(req, res)) return;
  try {
    const data = await renewalBatchService.getLatestRenewalBatchByYear(
      req,
      req.params.fiscalYear
    );
    return res.success(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function postExecute(req, res) {
  if (!ensureYearEndAccess(req, res)) return;
  try {
    const data = await renewalBatchService.requestExecuteRenewalBatch(
      req,
      req.params.batchId
    );
    return res.status(202).json({ status: "success", data });
  } catch (e) {
    return handleError(res, e);
  }
}

async function getEvents(req, res) {
  if (!ensureYearEndAccess(req, res)) return;
  try {
    const { batchId } = req.params;
    const batch = await YearEndBatch.findOne({
      _id: batchId,
      tenantId: req.tenantId,
    }).lean();
    if (!batch) {
      return res.status(404).json({ status: "fail", data: "Renewal batch not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (obj) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    send({
      type: "snapshot",
      batchId: String(batch._id),
      status: batch.status,
      metrics: batch.metrics,
      error: batch.error,
    });

    attachRenewalBatchSse(batchId, res);

    const heartbeat = setInterval(() => {
      send({ type: "heartbeat", t: Date.now() });
    }, 15000);

    res.on("close", () => {
      clearInterval(heartbeat);
    });
  } catch (e) {
    return handleError(res, e);
  }
}

module.exports = {
  postCreate,
  getYearOptions,
  getByYear,
  getOne,
  postExecute,
  getEvents,
};
