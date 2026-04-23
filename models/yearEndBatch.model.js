const mongoose = require("mongoose");
const { RENEWAL_BATCH_STATUS } = require("../constants/enums");

const RenewalMetricsSchema = new mongoose.Schema(
  {
    toArchive: { type: Number, default: 0 },
    toSuspend: { type: Number, default: 0 },
    toRenew: { type: Number, default: 0 },
  },
  { _id: false }
);

const YearEndBatchSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    fiscalYear: { type: Number, required: true, index: true },
    status: {
      type: String,
      enum: Object.values(RENEWAL_BATCH_STATUS),
      default: RENEWAL_BATCH_STATUS.DRAFT,
      index: true,
    },
    metrics: { type: RenewalMetricsSchema, default: () => ({}) },
    runBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    previewCompletedAt: { type: Date, default: null },
    executeStartedAt: { type: Date, default: null },
    executeCompletedAt: { type: Date, default: null },
    lastEventAt: { type: Date, default: null },
    correlationId: { type: String, default: null, trim: true },
    error: { type: String, default: null, trim: true },
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
  { timestamps: true, collection: "yearend_batches" }
);

YearEndBatchSchema.index({ tenantId: 1, fiscalYear: -1 });
YearEndBatchSchema.index({ tenantId: 1, status: 1 });

module.exports = mongoose.model("YearEndBatch", YearEndBatchSchema);
