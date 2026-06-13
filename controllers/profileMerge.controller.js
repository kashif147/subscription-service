const mongoose = require("mongoose");
const Subscription = require("../models/subscription.model");
const { AppError } = require("../errors/AppError");

function toObjectId(value) {
  const str = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(str)) return null;
  return new mongoose.Types.ObjectId(str);
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

    const absorbedSubs = await Subscription.find({
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
      profileId: masterObjectId,
      isCurrent: true,
    }).lean();

    const absorbedCurrent = absorbedSubs.find((sub) => sub.isCurrent === true) || null;

    const reassigned = await Subscription.updateMany(
      { profileId: absorbedObjectId },
      {
        $set: {
          profileId: masterObjectId,
        },
      },
    );

    if (masterCurrent && absorbedCurrent) {
      await Subscription.updateOne(
        { _id: absorbedCurrent._id },
        { $set: { isCurrent: false } },
      );
    }

    let currentSubscriptionId = masterCurrent?._id || absorbedCurrent?._id || null;
    if (!masterCurrent && absorbedCurrent) {
      currentSubscriptionId = absorbedCurrent._id;
    }

    return res.success({
      subscriptionsReassigned: reassigned.modifiedCount || 0,
      subscriptionsMatched: reassigned.matchedCount || 0,
      currentSubscriptionId: currentSubscriptionId
        ? String(currentSubscriptionId)
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
};
