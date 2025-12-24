const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
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

    const { profileId, isCurrent } = req.query;
    
    const query = { deleted: { $ne: true } };

    if (profileId) {
      if (!mongoose.Types.ObjectId.isValid(profileId)) {
        return res.status(400).json({
          status: 'fail',
          data: 'Invalid profileId',
        });
      }
      query.profileId = new mongoose.Types.ObjectId(profileId);
    }

    if (isCurrent === "true") {
      query.isCurrent = true;
    }else if (isCurrent === "false") {
      query.isCurrent = false;
    }

    const subscriptions = await Subscription.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Populate user fullname and meta.createdBy/updatedBy for each subscription
    const subscriptionsWithUser = await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = { ...subscription };
        
        // Populate subscription owner user (userId field)
        if (subscription.userId && subscription.tenantId) {
          try {
            const user = await User.findOne({
              tenantId: subscription.tenantId,
              userId: subscription.userId,
            }).lean();
            
            result.user = user
              ? {
                  userId: user.userId,
                  userEmail: user.userEmail,
                  userFullName: user.userFullName,
                }
              : null;
          } catch (error) {
            console.error(
              `Error fetching user for subscription ${subscription._id}:`,
              error.message
            );
            result.user = null;
          }
        } else {
          result.user = null;
        }
        
        // Populate lastModifiedBy (user name only) and lastModifiedAt
        if (subscription.meta?.updatedBy) {
          try {
            const updatedByUser = await User.findById(subscription.meta.updatedBy).lean();
            result.lastModifiedBy = updatedByUser?.userFullName || null;
          } catch (error) {
            console.error(
              `Error fetching updatedBy user for subscription ${subscription._id}:`,
              error.message
            );
            result.lastModifiedBy = null;
          }
        } else {
          result.lastModifiedBy = null;
        }
        
        // Set lastModifiedAt from updatedAt timestamp
        result.lastModifiedAt = subscription.updatedAt || subscription.createdAt || null;
        
        return result;
      })
    );

    return res.success({
      count: subscriptionsWithUser.length,
      data: subscriptionsWithUser,
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
