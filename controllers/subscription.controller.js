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
const { buildDemotionEventPayload } = require("../helpers/demotionEventPayload");

const MEMBERSHIP_CANCEL_GRACE_DAYS = 28;

// Get subscription(s) for a profile. Auth required (CRM + Portal).
// GET /api/v1/subscriptions/profile/:profileId/current - current subscription only
// GET /api/v1/subscriptions/profile/:profileId - all subscriptions (or ?isCurrent=false)
// GET /api/v1/subscriptions/profile/:profileId?isCurrent=true - current only
async function getSubscriptionsByProfile(req, res) {
  const { profileId } = req.params;
  const isCurrentFilter = req.query.isCurrent;

  if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
    return res.fail("Invalid profileId");
  }

  try {
    const query = {
      profileId: new mongoose.Types.ObjectId(profileId),
      deleted: { $ne: true },
    };

    if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const onlyCurrent = isCurrentFilter === "true";
    if (onlyCurrent) {
      query.isCurrent = true;
      query.subscriptionStatus = MEMBERSHIP_STATUS.ACTIVE;
    }

    const subscriptions = await Subscription.find(query)
      .sort({ startDate: -1 })
      .lean();

    if (onlyCurrent) {
      const sub = subscriptions[0] || null;
      return res.success({
        data: sub ? { startDate: sub.startDate } : null,
      });
    }

    return res.success({
      data: subscriptions,
    });
  } catch (error) {
    console.error("Error fetching subscriptions by profile:", error.message);
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

    const matchedCount = subscriptions.filter(s => profileMap.has(s.profileId?.toString())).length;
    console.log(`[Gateway Aggregation] Profile map: ${profileMap.size} profiles, ${matchedCount}/${subscriptions.length} subscriptions have a matching profile`);
    if (matchedCount < subscriptions.length && profileMap.size > 0) {
      const missing = subscriptions.filter(s => !profileMap.has(s.profileId?.toString())).map(s => s.profileId?.toString());
      console.log(`[Gateway Aggregation] Subscriptions with no profile match (profileIds): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`);
    }

    // Step 5: Fetch payments (need membership numbers from profiles)
    const membershipNumbers = profiles
      .map(p => p.membershipNumber)
      .filter(Boolean);
    
    console.log(`🔍 Step 5: Fetching payments for ${membershipNumbers.length} members (from ${profiles.length} profiles)...`);
    const payments = await fetchPaymentsByMemberIds(membershipNumbers, req.tenantId, req);
    const paymentMap = buildPaymentMap(payments);
    console.log(`[Gateway Aggregation] Payment map: ${paymentMap.size} members have payments, total payment records: ${payments.length}`);

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

        // Resolve actual user email from profile (preferredEmail can be "personal"/"work" – use personalEmail/workEmail)
        const getActualEmailFromProfile = (contactInfo) => {
          if (!contactInfo) return null;
          const pref = (contactInfo.preferredEmail || '').toString().toLowerCase();
          if ((pref === 'personal' || pref === 'person') && contactInfo.personalEmail) return contactInfo.personalEmail;
          if (pref === 'work' && contactInfo.workEmail) return contactInfo.workEmail;
          if (contactInfo.preferredEmail && String(contactInfo.preferredEmail).includes('@')) return contactInfo.preferredEmail;
          return contactInfo.personalEmail || contactInfo.workEmail || null;
        };

        // User info: prefer portal user (when subscription has userId); else derive from profile (CRM-created)
        const userFromProfile = (function () {
          if (!profile) return null;
          const email = getActualEmailFromProfile(profile.contactInfo);
          const fullName = [profile.personalInfo?.forename, profile.personalInfo?.surname].filter(Boolean).join(' ').trim() || null;
          const uid = profile.userId != null ? (profile.userId.toString ? profile.userId.toString() : profile.userId) : null;
          if (uid || email || fullName) {
            return { userId: uid ?? null, userEmail: email ?? null, userFullName: fullName || null };
          }
          return null;
        })();
        const resolvedUser = portalUser || userFromProfile || { userId: null, userEmail: null, userFullName: null };

        // Top-level userId: use actual user id when we have it (profile or portal), so we don't send null unnecessarily
        const resolvedUserId = resolvedUser.userId ?? subscription.userId ?? null;

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
          // userId: resolvedUserId,
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

          // User info – actual email and full name only (no userId in user object)
          user: {
            userEmail: resolvedUser.userEmail ?? null,
            userFullName: resolvedUser.userFullName ?? null,
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

    const withProfile = enhancedSubscriptions.filter(s => s.personalDetails?.membershipNo != null || s.personalDetails?.mobileNo != null).length;
    console.log(`[Gateway Aggregation] Done: ${enhancedSubscriptions.length} subscriptions enhanced, ${withProfile} with profile data populated`);
    console.log(`✅ Successfully enhanced ${enhancedSubscriptions.length} subscriptions`);

    return res.success({
      count: enhancedSubscriptions.length,
      data: enhancedSubscriptions,
      _aggregated: true, // Indicates full gateway aggregation (profile + account data included)
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

    // Publish event for user-service to downgrade portal role to NON-MEMBER
    try {
      const identity = await buildDemotionEventPayload({
        profileId: currentSubscription.profileId,
        subscriptionUserId: currentSubscription.userId,
        tenantId: currentSubscription.tenantId || req.tenantId,
        req,
      });
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_RESIGNED,
        {
          subscriptionId: currentSubscription._id.toString(),
          profileId: identity.profileId,
          tenantId: identity.tenantId,
          userId: identity.userId,
          userEmail: identity.userEmail,
          reason: "resigned",
          applicationId: currentSubscription.applicationId || null,
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
      const identity = await buildDemotionEventPayload({
        profileId: resignedSubscription.profileId,
        subscriptionUserId: resignedSubscription.userId,
        tenantId: resignedSubscription.tenantId || req.tenantId,
        req,
      });
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_RESIGNATION_UNDONE,
        {
          subscriptionId: resignedSubscription._id.toString(),
          profileId: identity.profileId,
          userId: identity.userId,
          userEmail: identity.userEmail,
          tenantId: identity.tenantId,
          applicationId: resignedSubscription.applicationId || null,
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

function endOfCancellationGracePeriod(dateCancelled) {
  const d = new Date(dateCancelled);
  if (isNaN(d.getTime())) return null;
  const end = new Date(d.getTime());
  end.setUTCDate(end.getUTCDate() + MEMBERSHIP_CANCEL_GRACE_DAYS);
  return end;
}

/**
 * Cancel membership (CRM): status Cancelled, 28-day grace; portal role demoted after grace via sweep event.
 * PUT /api/v1/subscriptions/cancel/:profileId
 */
async function cancelMembership(req, res) {
  try {
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { profileId } = req.params;
    const { dateCancelled, reason } = req.body;

    if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
      return res.fail("Invalid profileId");
    }
    if (!dateCancelled) {
      return res.fail("dateCancelled is required");
    }
    if (!reason || !String(reason).trim()) {
      return res.fail("reason is required");
    }

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

    const cancelledAt = new Date(dateCancelled);
    if (isNaN(cancelledAt.getTime())) {
      return res.fail("Invalid dateCancelled format");
    }

    const gracePeriodEnd = endOfCancellationGracePeriod(cancelledAt);
    if (!gracePeriodEnd) {
      return res.fail("Could not compute grace period end");
    }

    let updatedByObjectId = null;
    if (req.userId && req.tenantId) {
      try {
        const crmUser = await User.findOne({
          userId: req.userId,
          tenantId: req.tenantId,
        }).lean();
        if (crmUser?._id) updatedByObjectId = crmUser._id;
      } catch (e) {
        console.warn(
          `Warning: Could not find CRM user for userId ${req.userId}`
        );
      }
    }

    currentSubscription.cancellation = {
      dateCancelled: cancelledAt,
      reason: String(reason).trim(),
      gracePeriodEnd,
      reinstated: false,
      portalRoleDemotionPublishedAt: null,
    };
    currentSubscription.isCurrent = false;
    currentSubscription.subscriptionStatus = MEMBERSHIP_STATUS.CANCELLED;

    if (updatedByObjectId) {
      if (!currentSubscription.meta) currentSubscription.meta = {};
      currentSubscription.meta.updatedBy = updatedByObjectId;
    }

    await currentSubscription.save();

    try {
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLED,
        {
          subscriptionId: currentSubscription._id.toString(),
          profileId: currentSubscription.profileId.toString(),
          tenantId: currentSubscription.tenantId || req.tenantId,
          applicationId: currentSubscription.applicationId || null,
        },
        {
          tenantId: currentSubscription.tenantId || req.tenantId,
          exchange: "membership.events",
          routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLED,
          metadata: { service: "subscription-service", version: "1.0" },
        }
      );
      if (!publishResult.success) {
        console.error("❌ Failed to publish subscription cancelled event:", {
          error: publishResult.error,
          subscriptionId: currentSubscription._id.toString(),
        });
      }
    } catch (e) {
      console.error("❌ Error publishing subscription cancelled event:", e.message);
    }

    return res.success({
      message: "Membership cancelled; portal role demotes after grace period",
      data: {
        subscriptionId: currentSubscription._id,
        profileId: currentSubscription.profileId,
        subscriptionStatus: currentSubscription.subscriptionStatus,
        isCurrent: currentSubscription.isCurrent,
        cancellation: currentSubscription.cancellation,
      },
    });
  } catch (error) {
    console.error("Error cancelling membership:", error.message);
    return res.serverError(error);
  }
}

module.exports = {
  getSubscriptionsByProfile,
  getSubscriptions,
  resignMembership,
  undoResignMembership,
  cancelMembership,
};
