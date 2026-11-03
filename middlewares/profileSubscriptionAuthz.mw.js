/**
 * P5 portal object authorization for the subscription routes mounted on
 * `ensureAuthenticatedOrInternal` (which are not CRM-gated inside their controllers).
 *
 * Caller class comes from the VERIFIED identity only:
 *   - internal: the internal branch of ensureAuthenticatedOrInternal was taken
 *     (x-internal-request, which the gateway strips, with NO user identity; that branch never sets
 *     req.user). A caller that also forwards a user's Authorization / gateway headers is that user.
 *   - CRM:    req.user.userType === "CRM"
 *   - PORTAL: req.user.userType === "PORTAL"
 *   - anything else: denied (fail closed).
 *
 * Rules:
 *   POST /internal/profile-merge                      -> internal only (portal and CRM users denied)
 *   GET  /profile/:profileId[/current]                -> internal: allowed (tenant from x-tenant-id, as before)
 *                                                       CRM: PDP subscriptions:read (existing code), tenant-scoped query
 *                                                       PORTAL: target must be the caller's own profile, resolved by
 *                                                       profile-service /api/profile/my-profile from the verified
 *                                                       identity; the client-supplied profileId is only compared.
 */
const { USER_TYPE } = require("../constants/enums");
const { isInternalRequest } = require("../helpers/requestTenant");

function isInternalCall(req) {
  return isInternalRequest(req) && !req.user;
}

function deny(res, code, message) {
  return res.status(403).json({ code, message });
}

function defaultRequirePermission(resource, action) {
  // Lazy: loading the policy client has side effects (env checks / logging).
  const policy = require("./policy.middleware");
  return policy.requirePermission(resource, action);
}

function defaultResolveOwnProfileId(req) {
  return require("../helpers/serviceClient").fetchOwnPortalProfileId(req);
}

function createProfileSubscriptionAuthz(deps = {}) {
  const requirePermission = deps.requirePermission || defaultRequirePermission;
  const resolveOwnProfileId = deps.resolveOwnProfileId || defaultResolveOwnProfileId;

  const requireInternalOnly = (req, res, next) => {
    if (isInternalCall(req)) return next();
    return deny(res, "INTERNAL_ONLY", "This endpoint is only available to internal service calls");
  };

  const authorizeProfileSubscriptionRead = async (req, res, next) => {
    try {
      if (isInternalCall(req)) return next();

      const userType = req.user && req.user.userType;

      if (userType === USER_TYPE.CRM) {
        return requirePermission("subscriptions", "read")(req, res, next);
      }

      if (userType === USER_TYPE.PORTAL) {
        // Never consult req.permissions here: holding a permission string does not grant
        // access to another member's object.
        const target = String((req.params && req.params.profileId) || "").trim();
        const own = await resolveOwnProfileId(req);
        if (!own || !target || String(own).trim() !== target) {
          return deny(res, "NOT_OWNER", "Access denied");
        }
        return next();
      }

      return deny(res, "FORBIDDEN_USER_TYPE", "Access denied");
    } catch (error) {
      console.warn("[subscription-service] profile subscription authz failed closed:", error.message);
      return deny(res, "NOT_OWNER", "Access denied");
    }
  };

  return { requireInternalOnly, authorizeProfileSubscriptionRead };
}

module.exports = {
  createProfileSubscriptionAuthz,
  ...createProfileSubscriptionAuthz(),
};
