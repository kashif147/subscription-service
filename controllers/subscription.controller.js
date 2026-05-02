const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const Subscription = require("../models/subscription.model");
const User = require("../models/user.model");
const { USER_TYPE, MEMBERSHIP_STATUS, PAYMENT_TYPE } = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const {
  fetchProfilesByIds,
  fetchPaymentsByMemberIds,
  fetchMemberSummariesByMemberIds,
  calculateFinancialDetails,
  buildProfileMap,
  buildPaymentMap,
  getMemberIdLookupKeys,
} = require("../helpers/serviceClient");
const { buildDemotionEventPayload } = require("../helpers/demotionEventPayload");
const {
  publishSubscriptionCurrentUpdated,
} = require("../rabbitMQ/publishers/subscription.current.updated.publisher.js");
const {
  serializeSubscriptionForAudit,
  publishSubscriptionChangedAudit,
} = require("../rabbitMQ/publishers/subscription.changed.audit.publisher.js");
const subscriptionFilterTemplateService = require("../services/subscription.filter.template.service");
const { AppError } = require("../errors/AppError");
const {
  buildSubscriptionMongoQueryFromTemplateFilters,
  filterByColumns,
} = require("../helpers/subscriptionListTemplate");

const MEMBERSHIP_CANCEL_GRACE_DAYS = 28;

function requestHasUsableFilters(bodyFilters) {
  if (
    !bodyFilters ||
    typeof bodyFilters !== "object" ||
    Array.isArray(bodyFilters)
  ) {
    return false;
  }
  return Object.values(bodyFilters).some(
    (fe) => fe && Array.isArray(fe.values) && fe.values.length > 0,
  );
}

function normalizeCategoryValue(c) {
  if (c == null || c === "") return "";
  return String(c).trim();
}

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
      // Return full document (same fields as list endpoint items), not only startDate —
      // callers need membershipCategory, paymentType, etc.
      return res.success({
        data: sub,
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

/**
 * Same enriched shape as GET /api/v1/subscriptions (profile + portal user + payments).
 */
async function enhanceSubscriptionsWithAggregation(subscriptions, req) {
  if (!subscriptions || subscriptions.length === 0) {
    return [];
  }

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
    
    console.log(`🔍 Step 5: Fetching summaries for ${membershipNumbers.length} members (from ${profiles.length} profiles)...`);
    const summaries = await fetchMemberSummariesByMemberIds(
      membershipNumbers,
      req.tenantId,
      req
    );
    const summaryMap = new Map(
      (summaries || []).map((x) => [String(x?.memberId || "").trim(), x?.summary || null])
    );
    const missingSummaryMemberIds = membershipNumbers.filter((memberId) => {
      const key = String(memberId || "").trim();
      return key && !summaryMap.get(key);
    });
    let paymentMap = new Map();
    let payments = [];
    if (missingSummaryMemberIds.length > 0) {
      console.log(
        `[Gateway Aggregation] Summary missing for ${missingSummaryMemberIds.length} members, fetching payment fallback...`
      );
      payments = await fetchPaymentsByMemberIds(
        missingSummaryMemberIds,
        req.tenantId,
        req
      );
      paymentMap = buildPaymentMap(payments);
    }
    console.log(
      `[Gateway Aggregation] Summary count: ${summaries.length}, Payment fallback members: ${paymentMap.size}, payment records: ${payments.length}`
    );

    // Step 6: Merge all data into enhanced subscriptions
    console.log("🔍 Step 6: Merging all data...");
    const enhancedSubscriptions = await Promise.all(
      subscriptions.map(async (subscription) => {
        const profile = profileMap.get(subscription.profileId.toString());
        const portalUser = portalUserMap.get(subscription._id.toString());
        const memberPayments = profile?.membershipNumber
          ? getMemberIdLookupKeys(profile.membershipNumber).reduce((acc, key) => {
              const rows = paymentMap.get(key) || [];
              if (!rows.length) return acc;
              if (!acc.length) return [...rows];
              const seen = new Set(acc.map((item) => String(item?._id || "")));
              rows.forEach((row) => {
                const rowId = String(row?._id || "");
                if (!seen.has(rowId)) {
                  seen.add(rowId);
                  acc.push(row);
                }
              });
              return acc;
            }, [])
          : [];

        // Calculate financial details
        const fallbackFinancialDetails = calculateFinancialDetails(
          memberPayments,
          subscription.membershipCategory
        );
        const memberId = profile?.membershipNumber ? String(profile.membershipNumber).trim() : "";
        const summary = memberId ? summaryMap.get(memberId) : null;
        const netCents = Number(summary?.net);
        const latestInvoiceAmountCents = Number(summary?.latestInvoice?.amount);
        const summaryLastPaymentAmountCents = Number(summary?.lastPayment?.amount);
        const financialDetails = {
          // Outstanding in grid should match account summary net (AR outstanding) when available.
          outstandingBalance:
            Number.isFinite(netCents) ? netCents / 100 : fallbackFinancialDetails.outstandingBalance,
          // Membership fee should match latest invoice amount when available.
          membershipFee:
            Number.isFinite(latestInvoiceAmountCents)
              ? latestInvoiceAmountCents / 100
              : fallbackFinancialDetails.membershipFee,
          lastPaymentAmount:
            Number.isFinite(summaryLastPaymentAmountCents)
              ? summaryLastPaymentAmountCents / 100
              : fallbackFinancialDetails.lastPaymentAmount,
          lastPaymentDate:
            summary?.lastPayment?.date || fallbackFinancialDetails.lastPaymentDate || null,
        };

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
          membershipNumber: profile?.membershipNumber ?? null,
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
          reminderHistory: subscription.reminderHistory ?? null,
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
            fullName:
              profile?.personalInfo?.fullName?.trim() ||
              [profile?.personalInfo?.forename, profile?.personalInfo?.surname]
                .filter(Boolean)
                .join(" ")
                .trim() ||
              null,
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

          // Financial aliases at top-level for template column compatibility.
          // Some templates reference these keys directly (without financialDetails.* path).
          lastPaymentAmount: financialDetails.lastPaymentAmount ?? null,
          lastPaymentDate: financialDetails.lastPaymentDate ?? null,
          membershipFee: financialDetails.membershipFee ?? null,
          outstandingBalance: financialDetails.outstandingBalance ?? null,

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

  return enhancedSubscriptions;
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

    const enhancedSubscriptions = await enhanceSubscriptionsWithAggregation(subscriptions, req);

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
 * When a member has multiple subscription rows, pick the **most recent** one for status display.
 * Does **not** prefer `isCurrent` or Active — the latest period / row wins.
 * Order: latest `startDate`, then `updatedAt`, then `createdAt`.
 */
function pickSubscriptionForStatus(rows) {
  if (!rows?.length) return null;
  const sorted = [...rows].sort((a, b) => {
    const sa = new Date(a.startDate || 0).getTime();
    const sb = new Date(b.startDate || 0).getTime();
    if (sb !== sa) return sb - sa;
    const ua = new Date(a.updatedAt || 0).getTime();
    const ub = new Date(b.updatedAt || 0).getTime();
    if (ub !== ua) return ub - ua;
    const ca = new Date(a.createdAt || 0).getTime();
    const cb = new Date(b.createdAt || 0).getTime();
    return cb - ca;
  });
  return sorted[0] || null;
}

/**
 * CRM-only. POST /api/v1/subscriptions/batch-subscription-status
 * Body: { profileIds: string[] } (max 2000)
 * Returns { data: { data: [ { profileId, subscriptionStatus } ] } } via res.success — subscriptionStatus from subscription model.
 */
async function getBatchSubscriptionStatus(req, res) {
  try {
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const raw = req.body?.profileIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.fail("profileIds must be a non-empty array");
    }

    const unique = [
      ...new Set(
        raw
          .map((id) => (id == null ? "" : String(id).trim()))
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id)),
      ),
    ];
    if (unique.length > 2000) {
      return res.fail("Too many profileIds (max 2000)");
    }

    const oids = unique.map((id) => new mongoose.Types.ObjectId(id));
    const baseQuery = {
      profileId: { $in: oids },
      deleted: { $ne: true },
    };

    let query = { ...baseQuery };
    if (req.tenantId) {
      query.tenantId = req.tenantId;
    }
    let subs = await Subscription.find(query)
      .select(
        "profileId subscriptionStatus startDate createdAt updatedAt",
      )
      .lean();

    if (subs.length === 0 && req.tenantId) {
      subs = await Subscription.find(baseQuery)
        .select(
          "profileId subscriptionStatus startDate createdAt updatedAt",
        )
        .lean();
    }

    const byProfile = new Map();
    for (const s of subs) {
      const k = s.profileId?.toString();
      if (!k) continue;
      if (!byProfile.has(k)) byProfile.set(k, []);
      byProfile.get(k).push(s);
    }

    const data = unique.map((pid) => {
      const rows = byProfile.get(pid) || [];
      const sub = pickSubscriptionForStatus(rows);
      return {
        profileId: pid,
        subscriptionStatus: sub?.subscriptionStatus ?? null,
      };
    });

    return res.success({ data });
  } catch (error) {
    console.error("getBatchSubscriptionStatus:", error.message);
    return res.serverError(error);
  }
}

/**
 * CRM-only: one subscription by Mongo _id, same enriched shape as GET / (data is an array of one).
 * GET /api/v1/subscriptions/:subscriptionId
 */
async function getSubscriptionById(req, res) {
  try {
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { subscriptionId } = req.params;
    if (!subscriptionId || !mongoose.Types.ObjectId.isValid(subscriptionId)) {
      return res.fail("Invalid subscriptionId");
    }

    const query = {
      _id: new mongoose.Types.ObjectId(subscriptionId),
      deleted: { $ne: true },
    };
    if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const subscription = await Subscription.findOne(query).lean();
    if (!subscription) {
      return res.status(404).json({
        status: "fail",
        data: "Subscription not found",
      });
    }

    const enhancedSubscriptions = await enhanceSubscriptionsWithAggregation([subscription], req);

    return res.success({
      count: enhancedSubscriptions.length,
      data: enhancedSubscriptions,
      _aggregated: true,
    });
  } catch (error) {
    console.error("❌ Error fetching subscription by id:", error.message);
    return res.serverError(error);
  }
}

/**
 * CRM-only: update membership category, start date, payment type, payroll number.
 * PUT /api/v1/subscriptions/:subscriptionId
 * When membership category changes, publishes members.subscription.category.changed.v1 for account-service (GL fee adjustment).
 */
async function updateSubscriptionById(req, res) {
  try {
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { subscriptionId } = req.params;
    if (!subscriptionId || !mongoose.Types.ObjectId.isValid(subscriptionId)) {
      return res.fail("Invalid subscriptionId");
    }

    const body = req.body || {};
    const touched =
      Object.prototype.hasOwnProperty.call(body, "membershipCategory") ||
      Object.prototype.hasOwnProperty.call(body, "subscriptionStartDate") ||
      Object.prototype.hasOwnProperty.call(body, "startDate") ||
      Object.prototype.hasOwnProperty.call(body, "paymentType") ||
      Object.prototype.hasOwnProperty.call(body, "payrollNo");

    if (!touched) {
      return res.fail(
        "Provide at least one of: membershipCategory, subscriptionStartDate, paymentType, payrollNo"
      );
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "adjustmentKey") &&
      body.adjustmentKey != null &&
      body.adjustmentKey !== ""
    ) {
      if (typeof body.adjustmentKey !== "string" || !body.adjustmentKey.trim()) {
        return res.fail("adjustmentKey must be a non-empty string when provided");
      }
    }

    const query = {
      _id: new mongoose.Types.ObjectId(subscriptionId),
      deleted: { $ne: true },
    };
    if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const doc = await Subscription.findOne(query);
    if (!doc) {
      return res.status(404).json({
        status: "fail",
        data: "Subscription not found",
      });
    }

    const beforePlain = serializeSubscriptionForAudit(doc);

    const prevCategory = doc.membershipCategory;
    // Authoritative “old tier” period start for GL proration — subscription row before this update (no body override).
    const prevStartDate = doc.startDate;

    if (Object.prototype.hasOwnProperty.call(body, "paymentType")) {
      const pt = body.paymentType;
      if (pt == null || pt === "") {
        return res.fail(
          `paymentType is required when sent; use one of: ${Object.values(PAYMENT_TYPE).join(", ")}`
        );
      }
      if (!Object.values(PAYMENT_TYPE).includes(pt)) {
        return res.fail(
          `Invalid paymentType. Allowed: ${Object.values(PAYMENT_TYPE).join(", ")}`
        );
      }
      doc.paymentType = pt;
    }

    if (Object.prototype.hasOwnProperty.call(body, "payrollNo")) {
      doc.payrollNo =
        body.payrollNo === null || body.payrollNo === undefined
          ? null
          : String(body.payrollNo);
    }

    if (Object.prototype.hasOwnProperty.call(body, "membershipCategory")) {
      doc.membershipCategory =
        body.membershipCategory === null || body.membershipCategory === undefined
          ? null
          : String(body.membershipCategory).trim() || null;
    }

    const startInput =
      body.subscriptionStartDate !== undefined
        ? body.subscriptionStartDate
        : body.startDate !== undefined
          ? body.startDate
          : undefined;

    if (startInput !== undefined) {
      const sd = new Date(startInput);
      if (Number.isNaN(sd.getTime())) {
        return res.fail("Invalid subscriptionStartDate");
      }
      if (doc.endDate && sd > doc.endDate) {
        return res.fail("subscriptionStartDate must be on or before endDate");
      }
      doc.startDate = sd;
    }

    let updatedByObjectId = null;
    if (req.userId && req.tenantId) {
      try {
        const crmUser = await User.findOne({
          userId: req.userId,
          tenantId: req.tenantId,
        }).lean();
        if (crmUser?._id) updatedByObjectId = crmUser._id;
      } catch (_) {
        /* ignore */
      }
    }
    if (updatedByObjectId) {
      if (!doc.meta) doc.meta = {};
      doc.meta.updatedBy = updatedByObjectId;
    }

    const categoryChanged =
      normalizeCategoryValue(prevCategory) !==
      normalizeCategoryValue(doc.membershipCategory);

    const changedFields = [];
    if (Object.prototype.hasOwnProperty.call(body, "membershipCategory")) {
      changedFields.push("membershipCategory");
    }
    if (startInput !== undefined) {
      changedFields.push("startDate");
    }
    if (Object.prototype.hasOwnProperty.call(body, "paymentType")) {
      changedFields.push("paymentType");
    }
    if (Object.prototype.hasOwnProperty.call(body, "payrollNo")) {
      changedFields.push("payrollNo");
    }

    await doc.save();

    let categoryChangeEventPublished = false;
    let adjustmentKey = null;
    let memberIdResolved = false;

    if (categoryChanged) {
      adjustmentKey =
        typeof body.adjustmentKey === "string" && body.adjustmentKey.trim()
          ? body.adjustmentKey.trim()
          : randomUUID();

      let memberId = null;
      try {
        const profiles = await fetchProfilesByIds(
          [doc.profileId],
          doc.tenantId || req.tenantId,
          req
        );
        memberId = profiles[0]?.membershipNumber ?? null;
        memberIdResolved = !!(memberId && String(memberId).trim());
      } catch (e) {
        console.warn("updateSubscriptionById: profile fetch failed:", e.message);
      }

      try {
        const publishResult = await publisher.publish(
          MEMBERSHIP_EVENTS.SUBSCRIPTION_CATEGORY_CHANGED,
          {
            subscriptionId: doc._id.toString(),
            profileId: doc.profileId.toString(),
            tenantId: doc.tenantId || req.tenantId || undefined,
            applicationId: doc.applicationId || null,
            memberId: memberIdResolved ? String(memberId).trim() : null,
            adjustmentKey,
            previousMembershipCategory: prevCategory ?? null,
            membershipCategory: doc.membershipCategory ?? null,
            previousStartDate: prevStartDate,
            subscriptionStartDate: doc.startDate,
            actorUserId: req.userId || null,
            actorEmail: req.user?.email || null,
          },
          {
            tenantId: doc.tenantId || req.tenantId,
            exchange: "membership.events",
            routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CATEGORY_CHANGED,
            metadata: { service: "subscription-service", version: "1.0" },
          }
        );
        categoryChangeEventPublished = !!publishResult.success;
        if (!publishResult.success) {
          console.error("SUBSCRIPTION_CATEGORY_CHANGED publish failed:", {
            error: publishResult.error,
            subscriptionId: doc._id.toString(),
          });
        }
      } catch (e) {
        console.error("SUBSCRIPTION_CATEGORY_CHANGED publish error:", e.message);
      }
    }

    try {
      const auditResult = await publishSubscriptionChangedAudit({
        tenantId: doc.tenantId || req.tenantId,
        subscriptionId: doc._id.toString(),
        profileId: doc.profileId.toString(),
        applicationId: doc.applicationId || null,
        actorUserId: req.userId || null,
        actorEmail: req.user?.email || null,
        changedFields,
        before: beforePlain,
        after: serializeSubscriptionForAudit(doc),
      });
      if (!auditResult.success) {
        console.error("SUBSCRIPTION_CHANGED audit publish failed:", {
          error: auditResult.error,
          subscriptionId: doc._id.toString(),
        });
      }
    } catch (e) {
      console.error("SUBSCRIPTION_CHANGED audit publish error:", e.message);
    }

    return res.success({
      message: "Subscription updated",
      data: {
        subscription: doc.toObject(),
        categoryChanged,
        categoryChangeEventPublished,
        adjustmentKey: categoryChanged ? adjustmentKey : undefined,
        memberIdResolved: categoryChanged ? memberIdResolved : undefined,
      },
    });
  } catch (error) {
    console.error("updateSubscriptionById:", error.message);
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
          actorUserId: req.userId || null,
          actorEmail: req.user?.email || null,
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
          actorUserId: req.userId || null,
          actorEmail: req.user?.email || null,
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

    try {
      const cur = await publishSubscriptionCurrentUpdated(resignedSubscription, {
        tenantId: resignedSubscription.tenantId || req.tenantId,
        userId: resignedSubscription.userId ?? null,
      });
      if (!cur.success) {
        console.error(
          "❌ Failed to publish subscription current updated (undo resign):",
          cur.error
        );
      }
    } catch (curErr) {
      console.error(
        "❌ Error publishing subscription current updated (undo resign):",
        curErr.message
      );
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
          actorUserId: req.userId || null,
          actorEmail: req.user?.email || null,
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

/**
 * Undo cancellation for a profile
 * PUT /api/v1/subscriptions/undo-cancel/:profileId
 * CRM users only
 */
async function undoCancelMembership(req, res) {
  try {
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }

    const { profileId } = req.params;
    if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
      return res.fail("Invalid profileId");
    }

    const cancelledSubscription = await Subscription.findOne({
      profileId: new mongoose.Types.ObjectId(profileId),
      subscriptionStatus: MEMBERSHIP_STATUS.CANCELLED,
      deleted: { $ne: true },
      cancellation: { $exists: true, $ne: null },
    }).sort({ updatedAt: -1 });

    if (!cancelledSubscription) {
      return res.status(404).json({
        status: "fail",
        data: "No cancelled subscription found for this profile",
      });
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

    await Subscription.updateMany(
      {
        profileId: new mongoose.Types.ObjectId(profileId),
        isCurrent: true,
        deleted: { $ne: true },
        _id: { $ne: cancelledSubscription._id },
      },
      { $set: { isCurrent: false } }
    );

    if (!cancelledSubscription.cancellation) {
      cancelledSubscription.cancellation = {};
    }
    cancelledSubscription.cancellation.reinstated = true;
    cancelledSubscription.isCurrent = true;
    cancelledSubscription.subscriptionStatus = MEMBERSHIP_STATUS.ACTIVE;

    if (updatedByObjectId) {
      if (!cancelledSubscription.meta) cancelledSubscription.meta = {};
      cancelledSubscription.meta.updatedBy = updatedByObjectId;
    }

    await cancelledSubscription.save();

    try {
      const identity = await buildDemotionEventPayload({
        profileId: cancelledSubscription.profileId,
        subscriptionUserId: cancelledSubscription.userId,
        tenantId: cancelledSubscription.tenantId || req.tenantId,
        req,
      });
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLATION_UNDONE,
        {
          subscriptionId: cancelledSubscription._id.toString(),
          profileId: identity.profileId,
          userId: identity.userId,
          userEmail: identity.userEmail,
          tenantId: identity.tenantId,
          actorUserId: req.userId || null,
          actorEmail: req.user?.email || null,
          applicationId: cancelledSubscription.applicationId || null,
        },
        {
          tenantId: cancelledSubscription.tenantId || req.tenantId,
          exchange: "membership.events",
          routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CANCELLATION_UNDONE,
          metadata: { service: "subscription-service", version: "1.0" },
        }
      );
      if (!publishResult.success) {
        console.error("❌ Failed to publish subscription cancellation undone event:", {
          error: publishResult.error,
          subscriptionId: cancelledSubscription._id.toString(),
        });
      }
    } catch (e) {
      console.error("❌ Error publishing subscription cancellation undone event:", e.message);
    }

    try {
      const cur = await publishSubscriptionCurrentUpdated(cancelledSubscription, {
        tenantId: cancelledSubscription.tenantId || req.tenantId,
        userId: cancelledSubscription.userId ?? null,
      });
      if (!cur.success) {
        console.error(
          "❌ Failed to publish subscription current updated (undo cancel):",
          cur.error
        );
      }
    } catch (curErr) {
      console.error(
        "❌ Error publishing subscription current updated (undo cancel):",
        curErr.message
      );
    }

    return res.success({
      message: "Cancellation undone successfully",
      data: {
        subscriptionId: cancelledSubscription._id,
        profileId: cancelledSubscription.profileId,
        subscriptionStatus: cancelledSubscription.subscriptionStatus,
        isCurrent: cancelledSubscription.isCurrent,
        cancellation: cancelledSubscription.cancellation,
      },
    });
  } catch (error) {
    console.error("Error undoing cancellation:", error.message);
    return res.serverError(error);
  }
}

/**
 * CRM: paginated subscription list using saved filter/column template.
 * PUT /api/v1/subscriptions/filter  body: { page?, limit?, templateId? }
 */
async function getSubscriptionsWithTemplate(req, res) {
    const normalizeTemplateType = (type) => {
      const normalized = String(type || "").trim().toLowerCase();
      if (!normalized) return "members";
      if (normalized === "member") return "members";
      return normalized;
    };
  try {
    if (!req.user || req.user.userType !== USER_TYPE.CRM) {
      return res.status(403).json({
        status: "fail",
        data: "Access denied. CRM users only.",
      });
    }
    if (!req.tenantId) {
      return res.status(400).json({
        status: "fail",
        data: "Missing tenant context",
      });
    }

    const page = req.body.page ? parseInt(req.body.page, 10) : 1;
    const limit = req.body.limit ? parseInt(req.body.limit, 10) : 500;
    const templateId = req.body.templateId;
    const crmUserId = String(req.user.sub || req.user.id);

    let template;
    try {
      if (templateId) {
        template = await subscriptionFilterTemplateService.getTemplateById(
          templateId,
          req.tenantId,
          crmUserId
        );
        if (
          template.templateType &&
          normalizeTemplateType(template.templateType) !== "members"
        ) {
          return res.status(400).json({
            status: "fail",
            data: "Template is not a members template.",
          });
        }
      } else {
        template =
          await subscriptionFilterTemplateService.getDefaultTemplateForType(
            req.tenantId,
            crmUserId,
            "members"
          );
        if (!template) {
          template =
            await subscriptionFilterTemplateService.getSystemDefaultTemplate(
              req.tenantId,
              "members"
            );
        }
      }
    } catch (err) {
      if (err instanceof AppError && err.status === 404) {
        return res.status(404).json({ status: "fail", data: err.message });
      }
      throw err;
    }

    const bodyFilters =
      req.body &&
      req.body.filters &&
      typeof req.body.filters === "object" &&
      !Array.isArray(req.body.filters)
        ? req.body.filters
        : null;
    const filters = requestHasUsableFilters(bodyFilters)
      ? bodyFilters
      : (template.filters || {});
    const columns =
      Array.isArray(req.body?.columns) && req.body.columns.length > 0
        ? req.body.columns
        : template.columns || [];

    const query = buildSubscriptionMongoQueryFromTemplateFilters(
      filters,
      req.tenantId
    );
    const skip = (page - 1) * limit;
    const totalCount = await Subscription.countDocuments(query);
    const subscriptions = await Subscription.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const enhancedSubscriptions = await enhanceSubscriptionsWithAggregation(
      subscriptions,
      req
    );

    const data = enhancedSubscriptions.map((row) => {
      const filtered = filterByColumns(row, columns);
      if (row) {
        // Always include identity keys even when not explicitly selected in template columns.
        // Frontend details navigation depends on profileId/subscription _id to load profile + current subscription.
        const resolvedMembershipFee =
          row.membershipFee ?? row.financialDetails?.membershipFee ?? null;
        const resolvedOutstandingBalance =
          row.outstandingBalance ?? row.financialDetails?.outstandingBalance ?? null;
        const resolvedLastPaymentAmount =
          row.lastPaymentAmount ?? row.financialDetails?.lastPaymentAmount ?? null;
        const resolvedLastPaymentDate =
          row.lastPaymentDate ?? row.financialDetails?.lastPaymentDate ?? null;
        return {
          _id: row._id ?? null,
          profileId: row.profileId ?? null,
          applicationId: row.applicationId ?? null,
          ...filtered,
          membershipNumber: row.membershipNumber ?? null,
          membershipFee: resolvedMembershipFee,
          outstandingBalance: resolvedOutstandingBalance,
          lastPaymentAmount: resolvedLastPaymentAmount,
          lastPaymentDate: resolvedLastPaymentDate,
          financialDetails: {
            ...(row.financialDetails || {}),
            membershipFee: resolvedMembershipFee,
            outstandingBalance: resolvedOutstandingBalance,
            lastPaymentAmount: resolvedLastPaymentAmount,
            lastPaymentDate: resolvedLastPaymentDate,
          },
        };
      }
      return filtered || {};
    });

    return res.success({
      filter: filters,
      columns,
      templateId: template._id,
      isDefault: !!template.isDefault,
      systemDefault: !!template.systemDefault,
      _aggregated: true,
      count: data.length,
      data,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit) || 0,
        hasNextPage: page < Math.ceil(totalCount / limit),
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("getSubscriptionsWithTemplate:", error);
    return res.serverError(error);
  }
}

module.exports = {
  getSubscriptionsByProfile,
  getSubscriptions,
  getBatchSubscriptionStatus,
  getSubscriptionsWithTemplate,
  getSubscriptionById,
  updateSubscriptionById,
  resignMembership,
  undoResignMembership,
  cancelMembership,
  undoCancelMembership,
};
