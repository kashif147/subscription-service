const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const { AppError } = require("../errors/AppError");

function toObjectId(value) {
  const str = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  return new mongoose.Types.ObjectId(str);
}

function resolveProfileMergeSubscriptionPlan({ absorbedSubs, masterCurrent }) {
  const absorbedCurrentIds = (Array.isArray(absorbedSubs) ? absorbedSubs : [])
    .filter((sub) => sub?.isCurrent === true && sub?._id)
    .map((sub) => sub._id);

  return {
    absorbedCurrentIds,
    currentSubscriptionId: masterCurrent?._id || null,
  };
}

async function mergeProfilesInternal(req, res, next) {
  try {
    const tenantId = req.tenantId || req.headers["x-tenant-id"] || null;
    const {
      masterProfileId,
      absorbedProfileId,
      masterMembershipNumber = null,
      absorbedMembershipNumber = null,
    } = req.body || {};

    const masterObjectId = toObjectId(masterProfileId);
    const absorbedObjectId = toObjectId(absorbedProfileId);

    if (!masterObjectId || !absorbedObjectId) {
      return next(AppError.badRequest("masterProfileId and absorbedProfileId are required"));
    }
    if (String(masterObjectId) === String(absorbedObjectId)) {
      return next(AppError.badRequest("Cannot merge a profile with itself"));
    }

    const tenantFilter = tenantId ? { tenantId } : {};

    const absorbedSubs = await Subscription.find({
      ...tenantFilter,
      profileId: absorbedObjectId,
    }).lean();

    if (!absorbedSubs.length) {
      return res.success({
        subscriptionsReassigned: 0,
        currentSubscriptionId: null,
        masterMembershipNumber,
        absorbedMembershipNumber,
      });
    }

    const masterCurrent = await Subscription.findOne({
      ...tenantFilter,
      profileId: masterObjectId,
      isCurrent: true,
    }).lean();

    const plan = resolveProfileMergeSubscriptionPlan({
      absorbedSubs,
      masterCurrent,
    });

    let deactivatedCurrent = { modifiedCount: 0, matchedCount: 0 };
    if (plan.absorbedCurrentIds.length > 0) {
      deactivatedCurrent = await Subscription.updateMany(
        { ...tenantFilter, _id: { $in: plan.absorbedCurrentIds } },
        { $set: { isCurrent: false } },
      );
    }

    if (masterCurrent) {
      await Subscription.updateOne(
        { ...tenantFilter, _id: masterCurrent._id },
        { $set: { isCurrent: true } },
      );
    }

    return res.success({
      subscriptionsReassigned: 0,
      subscriptionsMatched: absorbedSubs.length,
      subscriptionsMadeNonCurrent: deactivatedCurrent.modifiedCount || 0,
      currentSubscriptionId: plan.currentSubscriptionId
        ? String(plan.currentSubscriptionId)
        : null,
      masterMembershipNumber,
      absorbedMembershipNumber,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  mergeProfilesInternal,
  resolveProfileMergeSubscriptionPlan,
};
