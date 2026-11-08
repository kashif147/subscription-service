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

// Phase B / Z9: the legacy tenant SU is retired; the tenant administrator (ASU) keeps the year-end access
// the former SU had. Own tenant only: the renewal batch is created in the trusted request tenant.
function hasTenantAdminRole(req) {
  const roles = Array.isArray(req.roles)
    ? req.roles
    : Array.isArray(req.user?.roles)
      ? req.user.roles
      : [];
  return roles.map(normalizeRoleValue).some((role) =>
    ["asu", "assistant super user", "assistantsuperuser"].includes(role)
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

  if (hasWritePermission || hasTenantAdminRole(req)) return true;

  res.status(403).json({
    status: "fail",
    data: "Access denied. Year-end renewal requires Accounts, Membership Officer, or tenant administrator (ASU) access.",
  });
  return false;
}

// P6 (2026-11-08): create / execute change subscriptions for the whole tenant and post member write-offs to
// account-service, so they need a finance action authority, not just a write claim: a verified CRM caller who is
// the tenant administrator (ASU: the "*" claim or the ASU role), or who holds an AM / DAM role AND the literal
// subscriptions:write or payments:write claim (the same shape as account-service requireFinanceWrite). MO, REO and
// other holders of subscriptions:write / payments:write are refused. The read routes keep ensureYearEndAccess.
const YEAR_END_FINANCE_ROLES = new Set([
  "am",
  "accounts manager",
  "account manager",
  "dam",
  "deputy accounts manager",
  "deputy account manager",
]);

function requestRoles(req) {
  return Array.isArray(req.roles) ? req.roles : Array.isArray(req.user?.roles) ? req.user.roles : [];
}

function requestPermissions(req) {
  return Array.isArray(req.permissions)
    ? req.permissions
    : Array.isArray(req.user?.permissions)
      ? req.user.permissions
      : [];
}

function canMutateYearEnd(req) {
  const permissions = requestPermissions(req);
  if (permissions.includes("*") || hasTenantAdminRole(req)) return true;
  const hasFinanceRole = requestRoles(req).map(normalizeRoleValue).some((r) => YEAR_END_FINANCE_ROLES.has(r));
  return hasFinanceRole && (permissions.includes("subscriptions:write") || permissions.includes("payments:write"));
}

function ensureYearEndMutationAccess(req, res) {
  if (!ensureCrm(req, res)) return false;
  if (canMutateYearEnd(req)) return true;
  res.status(403).json({
    status: "fail",
    code: "YEAR_END_FINANCE_AUTHORITY_REQUIRED",
    data: "Access denied. Creating or executing a year-end renewal requires the tenant administrator (ASU), or an Accounts Manager / Deputy Accounts Manager with subscriptions:write or payments:write.",
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
  if (!ensureYearEndMutationAccess(req, res)) return;
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
  if (!ensureYearEndMutationAccess(req, res)) return;
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
