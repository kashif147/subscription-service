/**
 * P6 class C: who may change a subscription (resign / undo-resign / cancel / undo-cancel / partial update, by
 * subscription id or by profile id). Only the CRM calls these routes.
 *
 * Chain (after ensureAuthenticatedWithTenantContext):
 *   1. PDP subscriptions:write (catalogue SUBSCRIPTIONS_WRITE, audience CRM): ASU by its own-tenant rule,
 *      holders of the code otherwise; PORTAL callers are refused by audience.
 *   2. requireSubscriptionWriter (local, from the verified identity only):
 *        - not a CRM caller                                  -> 403 CRM_ONLY
 *        - tenant administrator ("*" claim or the ASU role)  -> allowed
 *        - MO role AND the literal subscriptions:write claim -> allowed
 *        - anything else                                     -> 403 SUBSCRIPTION_WRITER_REQUIRED
 *
 * Why step 2: existing REO roles still carry subscriptions:write (role manifests never update existing roles),
 * but the role target makes REO read-only and gives the write code to MO only. Step 2 keeps REO read-only without
 * a live role edit. ASU is checked first because every MULTIAUTH ASU user also holds REO. Once existing REO roles
 * no longer carry the code, step 1 alone gives the same answer and step 2 can be dropped.
 */
const { USER_TYPE } = require("../constants/enums");

const SUBSCRIPTION_WRITER_ROLES = new Set(["mo", "membership officer"]);
const TENANT_ADMIN_ROLES = new Set(["asu", "assistant super user", "assistantsuperuser"]);

function normalizeRoleValue(role) {
  if (!role) return "";
  const raw =
    typeof role === "string" ? role : role.code || role.name || role.roleCode || role.roleName || "";
  return String(raw).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

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

function deny(res, code, message) {
  return res.status(403).json({ code, message });
}

function canWriteSubscriptions(req) {
  const roles = requestRoles(req).map(normalizeRoleValue);
  const permissions = requestPermissions(req);
  if (permissions.includes("*") || roles.some((r) => TENANT_ADMIN_ROLES.has(r))) return true;
  return roles.some((r) => SUBSCRIPTION_WRITER_ROLES.has(r)) && permissions.includes("subscriptions:write");
}

function requireSubscriptionWriter(req, res, next) {
  if (!req.user || req.user.userType !== USER_TYPE.CRM) {
    return deny(res, "CRM_ONLY", "Access denied. CRM users only.");
  }
  if (canWriteSubscriptions(req)) return next();
  return deny(
    res,
    "SUBSCRIPTION_WRITER_REQUIRED",
    "Access denied. Changing a subscription requires the tenant administrator (ASU) or a Membership Officer with subscriptions:write.",
  );
}

function createSubscriptionWriteAuthz({ requirePermission } = {}) {
  const pdp =
    requirePermission ||
    ((resource, action) =>
      require("./policy.middleware").defaultPolicyMiddleware.requirePermission(resource, action));
  return { requireSubscriptionWrite: [pdp("subscriptions", "write"), requireSubscriptionWriter] };
}

module.exports = {
  createSubscriptionWriteAuthz,
  requireSubscriptionWriter,
  canWriteSubscriptions,
  ...createSubscriptionWriteAuthz(),
};
