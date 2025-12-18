const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const { USER_TYPE } = require("../constants/enums");

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


async function getSubscriptions(req, res) {
  try {
    // Check if user is CRM
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: 'fail',
        data: 'Access denied. CRM users only.',
      });
    }

    const { applicationId, isCurrent } = req.query;
    
    const query = { deleted: { $ne: true } };

    if (applicationId) {
      query.applicationId = applicationId;
    }

    if (isCurrent === "true") {
      query.isCurrent = true;
    }

    const subscriptions = await Subscription.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return res.success({
      count: subscriptions.length,
      data: subscriptions,
      
    });
  } catch (error) {
    console.error("Error fetching subscriptions:", error.message);
    return res.serverError(error);
  }
}

module.exports = {
  getCurrentByProfile,
  getSubscriptions,
};
