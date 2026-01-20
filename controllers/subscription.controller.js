const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const { USER_TYPE, MEMBERSHIP_STATUS } = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");

// Get current subscription start date for a profile
// GET /api/v1/subscriptions/profile/:profileId/current
async function getCurrentByProfile(req, res) {
  const { profileId } = req.params;

  if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
    return res.fail("Invalid profileId");
  }

  try {
    const sub = await Subscription.findOne({
      profileId: new mongoose.Types.ObjectId(profileId),
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
    return res.serverError(error);
  }
}

async function getSubscriptions(req, res) {
  try {
    // Check if user is CRM
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { profileId, isCurrent } = req.query;

    const query = { deleted: { $ne: true } };

    if (profileId) {
      if (!mongoose.Types.ObjectId.isValid(profileId)) {
        return res.fail("Invalid profileId");
      }
      query.profileId = new mongoose.Types.ObjectId(profileId);
    }

    if (isCurrent === "true") {
      query.isCurrent = true;
    } else if (isCurrent === "false") {
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
            const crmUser = await User.findById(
              subscription.meta.updatedBy
            ).lean();
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
        result.lastModifiedAt =
          subscription.updatedAt || subscription.createdAt || null;

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
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { profileId } = req.params;
    const { dateResigned, reason } = req.body;

    // Validate profileId
    if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
      return res.fail("Invalid profileId");
    }

    // Validate required fields
    if (!dateResigned) {
      return res.fail("dateResigned is required");
    }

    if (!reason || !reason.trim()) {
      return res.fail("reason is required");
    }

    // Find the current subscription for this profile
    const currentSubscription = await Subscription.findOne({
      profileId: new mongoose.Types.ObjectId(profileId),
      isCurrent: true,
      deleted: { $ne: true },
    });

    if (!currentSubscription) {
      return res.status(404).json({
        status: "fail",
        data: "No active subscription found for this profile",
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
      return res.fail("Invalid dateResigned format");
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

    // Publish event for user-service to update user role to NON-MEMBER
    try {
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_RESIGNED,
        {
          subscriptionId: currentSubscription._id.toString(),
          profileId: currentSubscription.profileId.toString(),
          userId: currentSubscription.userId,
        },
        {
          tenantId: currentSubscription.tenantId || req.tenantId,
          exchange: "membership.events",
          routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_RESIGNED,
          metadata: { service: "subscription-service", version: "1.0" },
        }
      );

      if (publishResult.success) {
        console.log(
          "✅ Subscription resigned event published successfully:",
          {
            eventId: publishResult.eventId,
            subscriptionId: currentSubscription._id.toString(),
            profileId: currentSubscription.profileId.toString(),
          }
        );
      } else {
        console.error(
          "❌ Failed to publish subscription resigned event:",
          {
            error: publishResult.error,
            subscriptionId: currentSubscription._id.toString(),
          }
        );
      }
    } catch (error) {
      console.error(
        "❌ Error publishing subscription resigned event:",
        error.message
      );
      // Don't fail the request if event publishing fails
    }

    return res.success({
      message: "Membership resigned successfully",
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

/**
 * Undo resignation for a profile
 * PUT /api/v1/subscriptions/undo-resign/:profileId
 * CRM users only
 */
async function undoResignMembership(req, res) {
  try {
    // Check if user is CRM
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { profileId } = req.params;

    // Validate profileId
    if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
      return res.fail("Invalid profileId");
    }

    // Find the resigned subscription for this profile
    const resignedSubscription = await Subscription.findOne({
      profileId: new mongoose.Types.ObjectId(profileId),
      subscriptionStatus: MEMBERSHIP_STATUS.RESIGNED,
      deleted: { $ne: true },
      resignation: { $exists: true, $ne: null },
    }).sort({ updatedAt: -1 }); // Get the most recently resigned subscription

    if (!resignedSubscription) {
      return res.status(404).json({
        status: "fail",
        data: "No resigned subscription found for this profile",
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

    // Set any existing current subscriptions to false (to ensure only one is current)
    await Subscription.updateMany(
      {
        profileId: new mongoose.Types.ObjectId(profileId),
        isCurrent: true,
        deleted: { $ne: true },
        _id: { $ne: resignedSubscription._id },
      },
      {
        $set: { isCurrent: false },
      }
    );

    // Clear resignation data and reactivate the subscription
    resignedSubscription.resignation = undefined;
    resignedSubscription.isCurrent = true;
    resignedSubscription.subscriptionStatus = MEMBERSHIP_STATUS.ACTIVE;

    // Update meta.updatedBy if we have the CRM user ObjectId
    if (updatedByObjectId) {
      if (!resignedSubscription.meta) {
        resignedSubscription.meta = {};
      }
      resignedSubscription.meta.updatedBy = updatedByObjectId;
    }

    await resignedSubscription.save();

    // Publish event for user-service to update user role back to MEMBER
    try {
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_RESIGNATION_UNDONE,
        {
          subscriptionId: resignedSubscription._id.toString(),
          profileId: resignedSubscription.profileId.toString(),
          userId: resignedSubscription.userId,
        },
        {
          tenantId: resignedSubscription.tenantId || req.tenantId,
          exchange: "membership.events",
          routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_RESIGNATION_UNDONE,
          metadata: { service: "subscription-service", version: "1.0" },
        }
      );

      if (publishResult.success) {
        console.log(
          "✅ Subscription resignation undone event published successfully:",
          {
            eventId: publishResult.eventId,
            subscriptionId: resignedSubscription._id.toString(),
            profileId: resignedSubscription.profileId.toString(),
          }
        );
      } else {
        console.error(
          "❌ Failed to publish subscription resignation undone event:",
          {
            error: publishResult.error,
            subscriptionId: resignedSubscription._id.toString(),
          }
        );
      }
    } catch (error) {
      console.error(
        "❌ Error publishing subscription resignation undone event:",
        error.message
      );
      // Don't fail the request if event publishing fails
    }

    return res.success({
      message: "Resignation undone successfully",
      data: {
        subscriptionId: resignedSubscription._id,
        profileId: resignedSubscription.profileId,
        subscriptionStatus: resignedSubscription.subscriptionStatus,
        isCurrent: resignedSubscription.isCurrent,
      },
    });
  } catch (error) {
    console.error("Error undoing resignation:", error.message);
    return res.serverError(error);
  }
}

module.exports = {
  getCurrentByProfile,
  getSubscriptions,
  resignMembership,
  undoResignMembership,
};
