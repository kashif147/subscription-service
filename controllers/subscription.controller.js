const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const { USER_TYPE, MEMBERSHIP_STATUS } = require("../constants/enums");

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

    // Populate portal user (subscription owner) and CRM user (who approved/updated) for each subscription
    const subscriptionsWithUser = await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = { ...subscription };

        // Populate portal user - the user to whom the subscription belongs (portal user)
        if (subscription.userId && subscription.tenantId) {
          try {
            const portalUser = await User.findOne({
              tenantId: subscription.tenantId,
              userId: subscription.userId,
            }).lean();
            
            // Return portal user details with userFullName, or null if user not found
            result.user = portalUser
              ? {
                  userId: portalUser.userId,
                  userEmail: portalUser.userEmail,
                  userFullName: portalUser.userFullName || null,
                }
              : null;
          } catch (error) {
            console.error(
              `Error fetching portal user for subscription ${subscription._id}:`,
              error.message
            );
            result.user = null;
          }
        } else {
          result.user = null;
        }
        
        // Populate CRM user - who approved/updated the subscription (from meta.updatedBy)
        // Use LAST MODIFIED BY and LAST MODIFIED AT fields
        if (subscription.meta?.updatedBy) {
          try {
            const crmUser = await User.findById(subscription.meta.updatedBy).lean();
            // Return userFullName of CRM user, or null if user not found
            result.lastModifiedBy = crmUser?.userFullName || null;
          } catch (error) {
            console.error(
              `Error fetching CRM user (updatedBy) for subscription ${subscription._id}:`,
              error.message
            );
            result.lastModifiedBy = null;
          }
        } else {
          result.lastModifiedBy = null;
        }
        
        // Set LAST MODIFIED AT from updatedAt timestamp (or createdAt as fallback)
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

/**
 * Cancel/Resign membership for a profile
 * PUT /api/v1/subscriptions/resign/:profileId
 * CRM users only
 */
async function resignMembership(req, res) {
  try {
    // Check if user is CRM
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: 'fail',
        data: 'Access denied. CRM users only.',
      });
    }

    const { profileId } = req.params;
    const { dateResigned, reason } = req.body;

    // Validate profileId
    if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({
        status: 'fail',
        data: 'Invalid profileId',
      });
    }

    // Validate required fields
    if (!dateResigned) {
      return res.status(400).json({
        status: 'fail',
        data: 'dateResigned is required',
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        status: 'fail',
        data: 'reason is required',
      });
    }

    // Find the current subscription for this profile
    const currentSubscription = await Subscription.findOne({
      profileId: new mongoose.Types.ObjectId(profileId),
      isCurrent: true,
      deleted: { $ne: true },
    });

    if (!currentSubscription) {
      return res.status(404).json({
        status: 'fail',
        data: 'No active subscription found for this profile',
      });
    }

    // Get CRM user ObjectId for meta.updatedBy
    let updatedByObjectId = null;
    if (req.userId && req.tenantId) {
      try {
        const crmUser = await User.findOne({
          userId: req.userId,
          tenantId: req.tenantId,
        }).lean();

        if (crmUser && crmUser._id) {
          updatedByObjectId = crmUser._id;
        }
      } catch (error) {
        console.warn(
          `Warning: Could not find CRM user for userId ${req.userId}, continuing without updatedBy`
        );
      }
    }

    // Convert dateResigned to Date object if it's a string
    const resignationDate = new Date(dateResigned);
    if (isNaN(resignationDate.getTime())) {
      return res.status(400).json({
        status: 'fail',
        data: 'Invalid dateResigned format',
      });
    }

    // Update subscription with resignation details
    currentSubscription.resignation = {
      dateResigned: resignationDate,
      reason: reason.trim(),
    };
    currentSubscription.isCurrent = false;
    currentSubscription.subscriptionStatus = MEMBERSHIP_STATUS.RESIGNED;

    // Update meta.updatedBy if we have the CRM user ObjectId
    if (updatedByObjectId) {
      if (!currentSubscription.meta) {
        currentSubscription.meta = {};
      }
      currentSubscription.meta.updatedBy = updatedByObjectId;
    }

    await currentSubscription.save();

    return res.success({
      message: 'Membership resigned successfully',
      data: {
        subscriptionId: currentSubscription._id,
        profileId: currentSubscription.profileId,
        subscriptionStatus: currentSubscription.subscriptionStatus,
        isCurrent: currentSubscription.isCurrent,
        resignation: currentSubscription.resignation,
      },
    });
  } catch (error) {
    console.error("Error resigning membership:", error.message);
    return res.serverError(error);
  }
}

module.exports = {
  getCurrentByProfile,
  getSubscriptions,
  resignMembership,
};
