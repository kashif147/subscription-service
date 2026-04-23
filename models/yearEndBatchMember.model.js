const mongoose = require("mongoose");
const { RENEWAL_BATCH_MEMBER_ACTION } = require("../constants/enums");

const YearEndBatchMemberSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YearEndBatch",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: Object.values(RENEWAL_BATCH_MEMBER_ACTION),
      required: true,
      index: true,
    },
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "profiles",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "subscription",
      required: true,
    },
    memberId: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true, collection: "yearend_batch_members" }
);

YearEndBatchMemberSchema.index({ batchId: 1, action: 1 });
YearEndBatchMemberSchema.index(
  { batchId: 1, profileId: 1 },
  { unique: true }
);

module.exports = mongoose.model("YearEndBatchMember", YearEndBatchMemberSchema);
