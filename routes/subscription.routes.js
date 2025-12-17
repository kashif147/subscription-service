const express = require("express");
const router = express.Router();
const { 
  getCurrentByProfile, 
  getSubscriptions
} = require("../controllers/subscription.controller");
const { authenticate, requireCRM } = require("../middlewares/auth.mw");

// Public/simple endpoint to fetch current subscription start date by profileId
router.get("/profile/:profileId/current", getCurrentByProfile);


router.get("/", authenticate, requireCRM, getSubscriptions);

module.exports = router;
