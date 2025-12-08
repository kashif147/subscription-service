const express = require("express");
const router = express.Router();
const { getCurrentByProfile } = require("../controllers/subscription.controller");

// Public/simple endpoint to fetch current subscription start date by profileId
router.get("/profile/:profileId/current", getCurrentByProfile);

module.exports = router;
