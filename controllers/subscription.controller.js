const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");

// Get current subscription start date for a profile
// GET /api/v1/subscriptions/profile/:profileId/current
async function getCurrentByProfile(req, res) {
  const { profileId } = req.params;

  if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
    return res.status(400).json({
      error: "Invalid profileId",
    });
  }

  try {
    const sub = await Subscription.findOne({
      profileId,
      isCurrent: true,
      deleted: { $ne: true },
    })
      .select({ profileId: 1, startDate: 1, isCurrent: 1 })
      .lean();

    return res.success({
      data: sub ? { startDate: sub.startDate } : null,
    });
  } catch (error) {
    console.error("Error fetching current subscription:", error.message);
    return res.status(500).json({
      error: "Failed to fetch current subscription",
      message: error.message,
    });
  }
}

module.exports = {
  getCurrentByProfile,
};
