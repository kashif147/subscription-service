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
  ensureAuthenticated,
  ensureAuthenticatedOrInternal,
} = require("../middlewares/auth.mw");

// Auth or internal (x-internal-request): current subscription only
const getCurrentOnly = (req, res) => {
  req.query = { ...req.query, isCurrent: "true" };
  return getSubscriptionsByProfile(req, res);
};

router.get("/profile/:profileId/current", ensureAuthenticatedOrInternal, getCurrentOnly);
router.get("/profile/:profileId", ensureAuthenticatedOrInternal, getSubscriptionsByProfile);

// CRM: batch resolve subscriptionStatus by profileId (e.g. account-service batch details)
router.post(
  "/batch-subscription-status",
  ensureAuthenticated,
  getBatchSubscriptionStatus,
);

router.use("/templates", ensureAuthenticated, subscriptionFilterTemplateRoutes);
router.put("/filter", ensureAuthenticated, getSubscriptionsWithTemplate);

// CRM: cached distinct subscription years (must be before "/:subscriptionId")
router.get(
  "/meta/subscription-years",
  ensureAuthenticated,
  getSubscriptionYearsMeta,
);

// CRM-only: resign / undo-resign by subscription Mongo _id (must be before generic PUT /:subscriptionId)
router.put(
  "/:subscriptionId/resign",
  ensureAuthenticated,
  resignMembershipBySubscriptionId,
);
router.put(
  "/:subscriptionId/undo-resign",
  ensureAuthenticated,
  undoResignMembershipBySubscriptionId,
);

// CRM-only: partial update by Mongo _id (category change → RabbitMQ for account-service GL)
router.put("/:subscriptionId", ensureAuthenticated, updateSubscriptionById);

// CRM-only: enriched single subscription by Mongo _id (same shape as list `data` array items)
router.get("/:subscriptionId", ensureAuthenticated, getSubscriptionById);

// CRM-only endpoint: Get all subscriptions or filter by query (profileId, applicationId, isCurrent)
router.get("/", ensureAuthenticated, getSubscriptions);

// CRM-only endpoint: Resign membership for a profile (immediate portal demotion)
router.put("/resign/:profileId", ensureAuthenticated, resignMembership);

// CRM-only: cancel (no grace period); portal Member→Non-Member via separate job
router.put("/cancel/:profileId", ensureAuthenticated, cancelMembership);

// CRM-only endpoint: Undo resignation for a profile
router.put("/undo-resign/:profileId", ensureAuthenticated, undoResignMembership);
router.put("/undo-cancel/:profileId", ensureAuthenticated, undoCancelMembership);

module.exports = router;
