const mongoose = require("mongoose");
const {
  REMINDER_BATCH_KIND,
  REMINDER_BATCH_STATUS,
} = require("../constants/enums");

const CountsByTierSchema = new mongoose.Schema(
  {
    r1: { type: Number, default: 0 },
    r2: { type: Number, default: 0 },
    r3: { type: Number, default: 0 },
    cancel: { type: Number, default: 0 },
  },
  { _id: false }
);

const BatchProgressSchema = new mongoose.Schema(
  {
    totalMembersEstimated: { type: Number, default: 0 },
    chunksTotal: { type: Number, default: 0 },
    chunksCompleted: { type: Number, default: 0 },
    lastError: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const ReminderBatchSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: Object.values(REMINDER_BATCH_KIND),
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    referencePeriod: { type: String, trim: true, default: null },
    batchDate: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: Object.values(REMINDER_BATCH_STATUS),
      default: REMINDER_BATCH_STATUS.DRAFT,
      index: true,
    },
    ruleVersion: { type: String, default: null, trim: true },
    balanceAsOf: { type: Date, default: null },
    /** Snapshot for chunked build workers (set during begin build). */
    buildContextPrevExecuteAt: { type: Date, default: null },
    previousReminderBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReminderBatch",
      default: null,
    },
    previousCancellationBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReminderBatch",
      default: null,
    },
    countsByTier: { type: CountsByTierSchema, default: () => ({}) },
    buildStartedAt: { type: Date, default: null },
    buildCompletedAt: { type: Date, default: null },
    executeStartedAt: { type: Date, default: null },
    /** Same clock used for reminder/cancel timestamps and executeCompletedAt (set when execute begins). */
    executeAnchorAt: { type: Date, default: null },
    executeCompletedAt: { type: Date, default: null },
    executionCorrelationId: { type: String, default: null, trim: true },
    letterArtifactId: { type: String, default: null, trim: true },
    error: { type: String, default: null, trim: true },
    buildProgress: { type: BatchProgressSchema, default: () => ({}) },
    executeProgress: { type: BatchProgressSchema, default: () => ({}) },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, collection: "reminderbatches" }
);

ReminderBatchSchema.index({ tenantId: 1, kind: 1, batchDate: -1 });
ReminderBatchSchema.index({ tenantId: 1, status: 1 });
ReminderBatchSchema.index({
  tenantId: 1,
  referencePeriod: 1,
  kind: 1,
});

module.exports = mongoose.model("ReminderBatch", ReminderBatchSchema);
