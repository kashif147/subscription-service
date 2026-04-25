const mongoose = require("mongoose");

const TemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: null,
    },
    templateType: {
      type: String,
      default: "members",
      trim: true,
      index: true,
    },
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: false,
      index: true,
    },
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    columns: {
      type: [String],
      default: [],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    systemDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    meta: {
      deleted: {
        type: Boolean,
        default: false,
      },
      deletedAt: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true }
);

TemplateSchema.index({ tenantId: 1, userId: 1, "meta.deleted": 1 });
TemplateSchema.index({ tenantId: 1, userId: 1, isDefault: 1 });
TemplateSchema.index({ tenantId: 1, systemDefault: 1, "meta.deleted": 1 });
TemplateSchema.index({ tenantId: 1, templateType: 1, systemDefault: 1 });

module.exports = mongoose.model("SubscriptionFilterTemplate", TemplateSchema);
