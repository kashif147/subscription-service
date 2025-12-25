const express = require("express");
const router = express.Router();
const { 
  getCurrentByProfile, 
  getSubscriptions,
  resignMembership
} = require("../controllers/subscription.controller");
const { authenticate } = require("../middlewares/auth.mw");

// Public/simple endpoint to fetch current subscription start date by profileId
router.get("/profile/:profileId/current", getCurrentByProfile);

// CRM-only endpoint: Get all subscriptions or single subscription by applicationId
router.get("/", authenticate, getSubscriptions);

// CRM-only endpoint: Resign/Cancel membership for a profile
router.put("/resign/:profileId", authenticate, resignMembership);

module.exports = router;
