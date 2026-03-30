const express = require("express");
const router = express.Router();
const {
  getSubscriptionsByProfile,
  getSubscriptions,
  resignMembership,
  undoResignMembership,
  cancelMembership,
  undoCancelMembership,
} = require("../controllers/subscription.controller");
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

// CRM-only endpoint: Get all subscriptions or single subscription by applicationId
router.get("/", ensureAuthenticated, getSubscriptions);

// CRM-only endpoint: Resign membership for a profile (immediate portal demotion)
router.put("/resign/:profileId", ensureAuthenticated, resignMembership);

// CRM-only: cancel with 28-day grace; portal demotion after gracePeriodEnd (sweep)
router.put("/cancel/:profileId", ensureAuthenticated, cancelMembership);

// CRM-only endpoint: Undo resignation for a profile
router.put("/undo-resign/:profileId", ensureAuthenticated, undoResignMembership);
router.put("/undo-cancel/:profileId", ensureAuthenticated, undoCancelMembership);

module.exports = router;
