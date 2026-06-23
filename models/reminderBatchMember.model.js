const mongoose = require("mongoose");
const { REMINDER_BATCH_TIER } = require("../constants/enums");

const ReminderBatchMemberSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReminderBatch",
      required: true,
      index: true,
    },
    tier: {
      type: String,
      enum: Object.values(REMINDER_BATCH_TIER),
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
    membershipNumber: { type: String, default: null, trim: true },
    included: { type: Boolean, default: true, index: true },
    exclusionReason: {
      type: String,
      default: null,
      trim: true,
    },
    inclusionSummary: {
      type: String,
      default: null,
      trim: true,
    },
    eligibilitySnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    channelsPlanned: [{ type: String, trim: true }],
    channelsSucceeded: [{ type: String, trim: true }],
    channelAttemptsAt: { type: Map, of: Date, default: undefined },
    providerIds: { type: Map, of: String, default: undefined },
    flagsAppliedAt: {
      r1At: { type: Date, default: null },
      r2At: { type: Date, default: null },
      r3At: { type: Date, default: null },
      cancellationNotifiedAt: { type: Date, default: null },
    },
    lastExecuteQueueJobId: { type: String, default: null, trim: true },
    executeAttempt: { type: Number, default: 0 },
    commsEnqueuedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "reminderbatchmembers" }
);

ReminderBatchMemberSchema.index({ batchId: 1, tier: 1 });
ReminderBatchMemberSchema.index({ tenantId: 1, profileId: 1, batchId: 1 });
ReminderBatchMemberSchema.index({ batchId: 1, included: 1 });
ReminderBatchMemberSchema.index(
  { batchId: 1, profileId: 1 },
  { unique: true }
);

module.exports = mongoose.model("ReminderBatchMember", ReminderBatchMemberSchema);
