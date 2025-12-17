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

// Get all subscriptions or single subscription by applicationId (CRM users only)
// GET /api/v1/subscriptions?applicationId=xxx
async function getSubscriptions(req, res) {
  try {
    // Check if user is CRM
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: 'fail',
        data: 'Access denied. CRM users only.',
      });
    }

    const { applicationId } = req.query;
    
    // Build base query - exclude deleted
    const query = { deleted: { $ne: true } };

    // If applicationId is provided, return single subscription
    if (applicationId) {
      query.applicationId = applicationId;
      
      const subscription = await Subscription.findOne(query)
        .populate('profileId', 'firstName lastName email')
        .lean();

      if (!subscription) {
        return res.status(404).json({
          status: 'fail',
          data: 'Subscription not found',
        });
      }

      return res.success({
        data: subscription,
      });
    }

    // Otherwise return all subscriptions
    const subscriptions = await Subscription.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return res.success({
      data: subscriptions,
      count: subscriptions.length,
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
