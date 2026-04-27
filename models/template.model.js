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
    columnLabels: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    /**
     * User’s default view for this list — only field that means “default view” for CRM users.
     */
    isDefault: {
      type: Boolean,
      default: false,
    },
    /** Legacy sort hint; unused in app UI. */
    pinned: {
      type: Boolean,
      default: false,
    },
    /**
     * Seeded system template document — not a duplicate of isDefault.
     */
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

module.exports = mongoose.model("Template", TemplateSchema, "templates");
