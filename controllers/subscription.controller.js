const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const { USER_TYPE, MEMBERSHIP_STATUS } = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const {
  fetchProfilesByIds,
  fetchPaymentsByMemberIds,
  calculateFinancialDetails,
  buildProfileMap,
  buildPaymentMap,
} = require("../helpers/serviceClient");

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

    const { profileId, applicationId, isCurrent } = req.query;

    const query = { deleted: { $ne: true } };

    // Restrict to CRM user's tenant so profile-service and account-service return data for same tenant
    if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    if (profileId) {
      if (!mongoose.Types.ObjectId.isValid(profileId)) {
        return res.fail("Invalid profileId");
      }
      query.profileId = new mongoose.Types.ObjectId(profileId);
    }

    if (applicationId && applicationId.trim()) {
      query.applicationId = applicationId.trim();
    }

    if (isCurrent === "true") {
      query.isCurrent = true;
    } else if (isCurrent === "false") {
      query.isCurrent = false;
    }

    console.log("🔍 Step 1: Fetching subscriptions from DB...");
    const subscriptions = await Subscription.find(query)
      .sort({ createdAt: -1 })
      .lean();

    console.log(`✅ Found ${subscriptions.length} subscriptions`);

    // ============================================================
    // GATEWAY AGGREGATION: Use profileId (and applicationId), NOT userId.
    // userId can be null; profileId is required on subscription, so we always have it.
    // ============================================================

    // Step 2: Extract unique profileIds for batch fetching (never use userId for this)
    const profileIds = [
      ...new Set(
        subscriptions
          .map((s) => (s.profileId ? s.profileId.toString() : null))
          .filter(Boolean)
      ),
    ].map((id) => (mongoose.Types.ObjectId.isValid(id) ? id : null)).filter(Boolean);
    console.log(`🔍 Step 2: Need to fetch ${profileIds.length} unique profiles (by profileId)`);

    // Step 3: Fetch profiles by profileIds and portal users in PARALLEL
    console.log("🔍 Step 3: Fetching profiles and payments in parallel...");

    const [profiles, portalUsers] = await Promise.all([
      // Fetch profiles from profile-service by profileIds (token/tenant forwarded)
      fetchProfilesByIds(profileIds, req.tenantId, req),

      // Portal user info (optional: only when userId is set; can be null)
      Promise.all(
        subscriptions.map(async (sub) => {
          if (sub.userId && sub.tenantId) {
            try {
              const user = await User.findOne({
                tenantId: sub.tenantId,
                userId: sub.userId,
              }).lean();
              return user
                ? {
                    subscriptionId: sub._id.toString(),
                    userId: user.userId,
                    userEmail: user.userEmail,
                    userFullName: user.userFullName || null,
                  }
                : null;
            } catch (error) {
              return null;
            }
          }
          return null;
        })
      ),
    ]);

    // Step 4: Build lookup maps for fast access
    console.log("🔍 Step 4: Building lookup maps...");
    const profileMap = buildProfileMap(profiles);
    const portalUserMap = new Map();
    portalUsers.forEach(user => {
      if (user) {
        portalUserMap.set(user.subscriptionId, user);
      }
    });

    // Step 5: Fetch payments (need membership numbers from profiles)
    const membershipNumbers = profiles
      .map(p => p.membershipNumber)
      .filter(Boolean);
    
    console.log(`🔍 Step 5: Fetching payments for ${membershipNumbers.length} members...`);
    const payments = await fetchPaymentsByMemberIds(membershipNumbers, req.tenantId, req);
    const paymentMap = buildPaymentMap(payments);

    // Step 6: Merge all data into enhanced subscriptions
    console.log("🔍 Step 6: Merging all data...");
    const enhancedSubscriptions = await Promise.all(
      subscriptions.map(async (subscription) => {
        const profile = profileMap.get(subscription.profileId.toString());
        const portalUser = portalUserMap.get(subscription._id.toString());
        const memberPayments = profile?.membershipNumber 
          ? paymentMap.get(profile.membershipNumber) || []
          : [];

        // Calculate financial details
        const financialDetails = calculateFinancialDetails(
          memberPayments,
          subscription.membershipCategory
        );

        // Fetch CRM user (last modified by)
        let lastModifiedBy = null;
        if (subscription.meta?.updatedBy) {
          try {
            const crmUser = await User.findById(subscription.meta.updatedBy).lean();
            lastModifiedBy = crmUser?.userFullName || null;
          } catch (error) {
            // Silent fail
          }
        }

        return {
          // ========== SUBSCRIPTION FIELDS – every field always sent ==========
          _id: subscription._id,
          profileId: subscription.profileId ?? null,
          userId: subscription.userId ?? null,
          applicationId: subscription.applicationId ?? null,
          tenantId: subscription.tenantId ?? null,
          subscriptionYear: subscription.subscriptionYear ?? null,
          isCurrent: subscription.isCurrent ?? false,
          subscriptionStatus: subscription.subscriptionStatus ?? null,
          startDate: subscription.startDate ?? null,
          endDate: subscription.endDate ?? null,
          membershipCategory: subscription.membershipCategory ?? null,
          paymentType: subscription.paymentType ?? null,
          payrollNo: subscription.payrollNo ?? null,
          paymentFrequency: subscription.paymentFrequency ?? null,
          membershipMovement: subscription.membershipMovement ?? null,
          rolloverDate: subscription.rolloverDate ?? null,
          cancellation: subscription.cancellation ?? null,
          resignation: subscription.resignation ?? null,
          reminders: subscription.reminders ?? null,
          yearend: subscription.yearend ?? null,
          createdAt: subscription.createdAt ?? null,
          updatedAt: subscription.updatedAt ?? null,
          deleted: subscription.deleted ?? false,

          // User info – every field always sent (userId can be null on subscription)
          user: {
            userId: portalUser?.userId ?? null,
            userEmail: portalUser?.userEmail ?? null,
            userFullName: portalUser?.userFullName ?? null,
          },
          lastModifiedBy: lastModifiedBy ?? null,
          lastModifiedAt: subscription.updatedAt || subscription.createdAt || null,

          // ========== PERSONAL DETAILS (FROM PROFILE-SERVICE) – every field always sent ==========
          personalDetails: {
            membershipNo: profile?.membershipNumber ?? null,
            mobileNo: profile?.contactInfo?.mobileNumber ?? null,
            dateOfBirth: profile?.personalInfo?.dateOfBirth ?? null,
            gender: profile?.personalInfo?.gender ?? null,
            fullAddress: profile?.contactInfo?.fullAddress ?? null,
            notAtThisAddress: profile?.contactInfo?.nATA ?? false,
          },

          // ========== PROFESSIONAL DETAILS (FROM PROFILE-SERVICE) – every field always sent ==========
          professionalDetails: {
            workLocation: profile?.professionalDetails?.workLocation ?? null,
            branch: profile?.professionalDetails?.branch ?? null,
            region: profile?.professionalDetails?.region ?? null,
            grade: profile?.professionalDetails?.grade ?? null,
            primarySection: profile?.professionalDetails?.primarySection ?? null,
            secondarySection: profile?.professionalDetails?.secondarySection ?? null,
            nmbiNumber: profile?.professionalDetails?.nmbiNumber ?? null,
            retiredDate: profile?.professionalDetails?.retiredDate ?? null,
            pensionNumber: profile?.professionalDetails?.pensionNo ?? null,
            speciality: profile?.professionalDetails?.speciality ?? null,
          },

          // ========== PREFERENCES & CONSENTS (FROM PROFILE-SERVICE) – every field always sent ==========
          preferences: {
            consent: profile?.preferences?.consent ?? false,
            incomeProtection: profile?.cornMarket?.incomeProtectionScheme ?? false,
            inmoRewards: profile?.cornMarket?.inmoRewards ?? false,
            partnerConsent: profile?.cornMarket?.partnerConsent ?? false,
          },

          // ========== ADDITIONAL INFO (FROM PROFILE-SERVICE) – every field always sent ==========
          additionalInfo: {
            anotherUnionMember: profile?.additionalInformation?.otherIrishTradeUnion ?? false,
            otherUnionName: profile?.additionalInformation?.otherIrishTradeUnionName ?? null,
            submissionDate: profile?.submissionDate ?? null,
          },

          // ========== FINANCIAL DETAILS (FROM ACCOUNT-SERVICE) – every field always sent ==========
          financialDetails: {
            lastPaymentAmount: financialDetails.lastPaymentAmount ?? null,
            lastPaymentDate: financialDetails.lastPaymentDate ?? null,
            membershipFee: financialDetails.membershipFee ?? null,
            outstandingBalance: financialDetails.outstandingBalance ?? null,
          },
        };
      })
    );

    console.log(`✅ Successfully enhanced ${enhancedSubscriptions.length} subscriptions`);

    return res.success({
      count: enhancedSubscriptions.length,
      data: enhancedSubscriptions,
    });
  } catch (error) {
    console.error("❌ Error fetching subscriptions:", error.message);
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
