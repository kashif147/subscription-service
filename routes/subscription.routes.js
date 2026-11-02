const express = require("express");
const router = express.Router();
const {
  getSubscriptionsByProfile,
  getSubscriptions,
  getBatchSubscriptionStatus,
  getSubscriptionsWithTemplate,
  getSubscriptionById,
  updateSubscriptionById,
  resignMembership,
  resignMembershipBySubscriptionId,
  undoResignMembership,
  undoResignMembershipBySubscriptionId,
  cancelMembership,
  undoCancelMembership,
  getSubscriptionYearsMeta,
} = require("../controllers/subscription.controller");
const subscriptionFilterTemplateRoutes = require("./subscription.filter.template.routes");
const {
  ensureAuthenticatedOrInternal,
  ensureAuthenticatedWithTenantContext,
} = require("../middlewares/auth.mw");
const { mergeProfilesInternal } = require("../controllers/profileMerge.controller");
const {
  requireInternalOnly,
  authorizeProfileSubscriptionRead,
} = require("../middlewares/profileSubscriptionAuthz.mw");

// Auth or internal (x-internal-request): current subscription only
const getCurrentOnly = (req, res) => {
  req.query = { ...req.query, isCurrent: "true" };
  return getSubscriptionsByProfile(req, res);
};

// P5: internal callers unchanged; CRM needs subscriptions:read; PORTAL only its own profile.
router.get(
  "/profile/:profileId/current",
  ensureAuthenticatedOrInternal,
  authorizeProfileSubscriptionRead,
  getCurrentOnly,
);
router.get(
  "/profile/:profileId",
  ensureAuthenticatedOrInternal,
  authorizeProfileSubscriptionRead,
  getSubscriptionsByProfile,
);

// P5: internal service calls only (profile-service duplicate merge); user tokens denied.
router.post(
  "/internal/profile-merge",
  ensureAuthenticatedOrInternal,
  requireInternalOnly,
  mergeProfilesInternal,
);

// CRM: batch resolve subscriptionStatus by profileId (e.g. account-service batch details)
router.post(
  "/batch-subscription-status",
  ...ensureAuthenticatedWithTenantContext,
  getBatchSubscriptionStatus,
);

router.use("/templates", ...ensureAuthenticatedWithTenantContext, subscriptionFilterTemplateRoutes);
router.put("/filter", ...ensureAuthenticatedWithTenantContext, getSubscriptionsWithTemplate);

// CRM: cached distinct subscription years (must be before "/:subscriptionId")
router.get(
  "/meta/subscription-years",
  ...ensureAuthenticatedWithTenantContext,
  getSubscriptionYearsMeta,
);

// CRM-only: resign / undo-resign by subscription Mongo _id (must be before generic PUT /:subscriptionId)
router.put(
  "/:subscriptionId/resign",
  ...ensureAuthenticatedWithTenantContext,
  resignMembershipBySubscriptionId,
);
router.put(
  "/:subscriptionId/undo-resign",
  ...ensureAuthenticatedWithTenantContext,
  undoResignMembershipBySubscriptionId,
);

// CRM-only: partial update by Mongo _id (category change → RabbitMQ for account-service GL)
router.put("/:subscriptionId", ...ensureAuthenticatedWithTenantContext, updateSubscriptionById);

// CRM-only: enriched single subscription by Mongo _id (same shape as list `data` array items)
router.get("/:subscriptionId", ...ensureAuthenticatedWithTenantContext, getSubscriptionById);

// CRM-only endpoint: Get all subscriptions or filter by query (profileId, applicationId, isCurrent)
router.get("/", ...ensureAuthenticatedWithTenantContext, getSubscriptions);

// CRM-only endpoint: Resign membership for a profile (immediate portal demotion)
router.put("/resign/:profileId", ...ensureAuthenticatedWithTenantContext, resignMembership);

// CRM-only: cancel (no grace period); portal Member→Non-Member via separate job
router.put("/cancel/:profileId", ...ensureAuthenticatedWithTenantContext, cancelMembership);

// CRM-only endpoint: Undo resignation for a profile
router.put("/undo-resign/:profileId", ...ensureAuthenticatedWithTenantContext, undoResignMembership);
router.put("/undo-cancel/:profileId", ...ensureAuthenticatedWithTenantContext, undoCancelMembership);

module.exports = router;
