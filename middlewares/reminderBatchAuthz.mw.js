/**
 * P5 reminder-batch service authority: authorization of the CRM trigger.
 *
 * Reminder-batch build / execute / monthly-orchestrate run with subscription-service's own
 * service authority (internal worker requests), so the business decision "may this user start a
 * reminder batch" is made ONCE, here, from the verified identity, before anything is created or
 * queued. Nothing about the user is stored in the queued job.
 *
 * The admitted claim set is EXACTLY the user claim set that account-service accepts today on
 * POST /api/internal/members/reminder-eligibility-bulk (the finance read the build needs), so the
 * population allowed to build/execute is unchanged by moving the check:
 *   account-service 4357493 src/routes/internal.routes.js  -> requireInternalOrFinanceRead
 *   src/middlewares/financePermission.middleware.js:8-15   -> canFinanceRead =
 *       hasFinancePermission(perms, "payments", "read") ||
 *       hasFinancePermission(perms, "accounts.admin", "read") ||
 *       hasFinancePermission(perms, "accounts.reports", "read")
 *   src/helpers/financePermissions.js:7-37 (wildcards + alias table) expands that to the 8 literal
 *   strings below; src/helpers/financePermissions.js:44-53 collects them from req.user.permissions,
 *   req.ctx.permissions and req.permissions (the verified identity only).
 * Account denies PORTAL (requireFinanceReadStrict); here the caller must additionally be CRM, which
 * the reminder-batch controller already required (ensureCrm) - so unknown/missing userType was
 * already refused and nothing is granted or removed by that part.
 *
 * Literal match only: no case folding, trimming or new aliases. Grants nothing new.
 */
const { USER_TYPE } = require("../constants/enums");

const REMINDER_BATCH_TRIGGER_CLAIMS = Object.freeze([
  "*",
  "admin",
  "payments:*",
  "payments:read",
  "accounts.admin:*",
  "accounts.admin:read",
  "accounts.reports:*",
  "accounts.reports:read",
]);

/** Permissions from the authenticated identity only (never body/query). */
function collectRequestPermissions(req) {
  const merged = [];
  for (const src of [req?.user?.permissions, req?.ctx?.permissions, req?.permissions]) {
    if (Array.isArray(src)) merged.push(...src);
  }
  return [...new Set(merged)];
}

function hasReminderBatchTriggerClaim(req) {
  const perms = collectRequestPermissions(req);
  return REMINDER_BATCH_TRIGGER_CLAIMS.some((claim) => perms.includes(claim));
}

/**
 * Route guard for the reminder-batch triggers. Mount after ensureAuthenticatedWithTenantContext.
 * 403 CRM_ONLY for a non-CRM caller (same body as the controller's ensureCrm), 403
 * FINANCE_READ_REQUIRED for a CRM caller without a claim of the set.
 */
function requireReminderBatchTrigger(req, res, next) {
  if (!req.user || req.user.userType !== USER_TYPE.CRM) {
    return res.status(403).json({
      status: "fail",
      code: "CRM_ONLY",
      data: "Access denied. CRM users only.",
    });
  }
  if (!hasReminderBatchTriggerClaim(req)) {
    return res.status(403).json({
      status: "fail",
      code: "FINANCE_READ_REQUIRED",
      data: "Finance read permission required (payments:read, accounts.admin:read or accounts.reports:read)",
    });
  }
  return next();
}

module.exports = {
  REMINDER_BATCH_TRIGGER_CLAIMS,
  hasReminderBatchTriggerClaim,
  requireReminderBatchTrigger,
};
