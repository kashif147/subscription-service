// Phase A / A3 — request tenant enforcement for subscription routes.
//
// The tenant of a request comes only from the trusted context set by the auth middleware
// (gateway headers / verified JWT) or, for in-network internal calls, from the calling service's
// x-tenant-id. A request without a valid tenant must never read or write subscriptions unscoped.
//
// STAGE 1 (this build, "warn"): a missing tenant is logged (SubscriptionTenantMissing, with the caller's
// remote address so every legitimate internal caller can be identified) and the legacy behaviour is
// kept. STAGE 2 switches ENFORCEMENT to "enforce": missing tenant fails closed.
const ENFORCEMENT = "warn";

const PLACEHOLDERS = new Set(["unknown", "default", "system", "null", "undefined"]);
const TENANT_FORMAT = /^[A-Za-z0-9._:-]{1,128}$/;
const cleanTenant = (v) => (v == null ? "" : String(v).trim());
const isValidTenantId = (v) => {
  const t = cleanTenant(v);
  return Boolean(t) && TENANT_FORMAT.test(t) && !PLACEHOLDERS.has(t.toLowerCase());
};

const isInternalRequest = (req) => {
  const v = String(req?.headers?.["x-internal-request"] || "").toLowerCase();
  return v === "true" || v === "1";
};

function logTenantMissing(req, site) {
  console.warn("[subscription-service] SubscriptionTenantMissing", {
    site,
    stage: ENFORCEMENT,
    internal: isInternalRequest(req),
    method: req?.method,
    path: String(req?.originalUrl || req?.url || "").split("?")[0],
    remoteAddress: req?.socket?.remoteAddress || req?.ip || null,
  });
}

/**
 * Tenant to scope a subscription query with.
 * @returns {{ proceed: boolean, tenantId: string|null }}  proceed=false means a response was sent.
 */
function resolveRequestTenant(req, res, site) {
  const tenantId = cleanTenant(req?.tenantId || req?.ctx?.tenantId);
  if (isValidTenantId(tenantId)) return { proceed: true, tenantId };
  logTenantMissing(req, site);
  if (ENFORCEMENT === "warn") return { proceed: true, tenantId: null };
  res.status(403).json({ code: "TENANT_REQUIRED", message: "Trusted tenant context is required" });
  return { proceed: false, tenantId: null };
}

module.exports = {
  ENFORCEMENT,
  cleanTenant,
  isValidTenantId,
  isInternalRequest,
  logTenantMissing,
  resolveRequestTenant,
};
