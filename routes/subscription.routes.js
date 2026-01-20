const express = require("express");
const router = express.Router();
const {
  getCurrentByProfile,
  getSubscriptions,
  resignMembership,
  undoResignMembership,
} = require("../controllers/subscription.controller");
const { ensureAuthenticated } = require("../middlewares/auth.mw");

// Public/simple endpoint to fetch current subscription start date by profileId
router.get("/profile/:profileId/current", getCurrentByProfile);

// CRM-only endpoint: Get all subscriptions or single subscription by applicationId
router.get("/", ensureAuthenticated, getSubscriptions);

// CRM-only endpoint: Resign/Cancel membership for a profile
router.put("/resign/:profileId", ensureAuthenticated, resignMembership);

// CRM-only endpoint: Undo resignation for a profile
router.put("/undo-resign/:profileId", ensureAuthenticated, undoResignMembership);

module.exports = router;
