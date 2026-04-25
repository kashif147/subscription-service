const Template = require("../models/template.model");
const { AppError } = require("../errors/AppError");
const { MEMBERSHIP_STATUS } = require("../constants/enums");

function normalizeTemplateType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) return "members";
  if (normalized === "member") return "members";
  return normalized;
}

function toTemplateResponse(doc) {
  const obj =
    doc && typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete obj.meta;
  delete obj.__v;
  return obj;
}

function tenantOrLegacyMatch(tenantId) {
  if (!tenantId) return {};
  return {
    $or: [{ tenantId }, { tenantId: null }, { tenantId: { $exists: false } }],
  };
}

async function findSystemDefaultTemplateDoc(type, tenantId) {
  const base = {
    systemDefault: true,
    "meta.deleted": false,
    templateType: type,
  };
  if (tenantId) {
    const scoped = await Template.findOne({ ...base, tenantId });
    if (scoped) return scoped;
  }
  return Template.findOne({
    ...base,
    $or: [{ tenantId: null }, { tenantId: { $exists: false } }],
  });
}

class SubscriptionFilterTemplateService {
  async createTemplate(tenantId, userId, templateData) {
    const { name, templateType, filters, columns, isDefault, pinned } =
      templateData;
    const type = normalizeTemplateType(templateType);

    if (isDefault) {
      await Template.updateMany(
        {
          userId,
          templateType: type,
          isDefault: true,
          "meta.deleted": false,
          ...tenantOrLegacyMatch(tenantId),
        },
        { $set: { isDefault: false } }
      );
    }

    const template = new Template({
      tenantId,
      userId,
      name: name != null && name !== "" ? name : undefined,
      templateType: type,
      filters: filters || {},
      columns: columns || [],
      isDefault: isDefault || false,
      pinned: pinned || false,
    });

    const saved = await template.save();
    return toTemplateResponse(saved);
  }

  async getUserTemplatesWithSystemDefault(tenantId, userId, type = "members") {
    const normalizedType = normalizeTemplateType(type);
    const typeFilter = { templateType: normalizedType };
    const systemDefault = await findSystemDefaultTemplateDoc(
      normalizedType,
      tenantId
    );

    const userTemplates = await Template.find({
      userId,
      "meta.deleted": false,
      ...typeFilter,
      ...tenantOrLegacyMatch(tenantId),
    }).sort({ pinned: -1, isDefault: -1, createdAt: -1 });

    const allTemplates = [];
    if (systemDefault) allTemplates.push(systemDefault);
    allTemplates.push(...userTemplates);
    return allTemplates;
  }

  async getTemplateById(templateId, tenantId, userId) {
    const systemDefault = await Template.findOne({
      _id: templateId,
      systemDefault: true,
      "meta.deleted": false,
      ...tenantOrLegacyMatch(tenantId),
    });
    if (systemDefault) {
      const type = normalizeTemplateType(systemDefault.templateType);
      const userHasDefault = await Template.exists({
        userId,
        templateType: type,
        isDefault: true,
        "meta.deleted": false,
        ...tenantOrLegacyMatch(tenantId),
      });
      const out = toTemplateResponse(systemDefault);
      if (!userHasDefault) out.isDefault = true;
      return out;
    }

    const template = await Template.findOne({
      _id: templateId,
      userId,
      "meta.deleted": false,
      ...tenantOrLegacyMatch(tenantId),
    });

    if (!template) {
      throw AppError.notFound("Filter template not found");
    }

    return template;
  }

  async updateTemplate(templateId, tenantId, userId, updateData) {
    const { name, templateType, filters, columns, isDefault, pinned } =
      updateData;

    let template = await Template.findOne({
      _id: templateId,
      systemDefault: true,
      "meta.deleted": false,
      ...tenantOrLegacyMatch(tenantId),
    });

    if (!template) {
      template = await Template.findOne({
        _id: templateId,
        userId,
        "meta.deleted": false,
        ...tenantOrLegacyMatch(tenantId),
      });
    }

    if (!template) {
      throw AppError.notFound("Filter template not found");
    }

    const type =
      templateType !== undefined
        ? normalizeTemplateType(templateType)
        : normalizeTemplateType(template.templateType);

    if (template.systemDefault) {
      if (isDefault === true) {
        await Template.updateMany(
          {
            userId,
            templateType: type,
            "meta.deleted": false,
            ...tenantOrLegacyMatch(tenantId),
          },
          { $set: { isDefault: false } }
        );
      }
      if (pinned !== undefined) template.pinned = pinned;
      const saved = await template.save();
      const response = toTemplateResponse(saved);
      if (isDefault === true) response.isDefault = true;
      return response;
    }

    if (isDefault === true) {
      await Template.updateMany(
        {
          userId,
          templateType: type,
          _id: { $ne: templateId },
          "meta.deleted": false,
          ...tenantOrLegacyMatch(tenantId),
        },
        { $set: { isDefault: false } }
      );
    }

    if (name !== undefined) {
      template.name = name !== "" ? name : null;
    }
    if (templateType !== undefined) {
      template.templateType = normalizeTemplateType(templateType);
    }
    if (filters !== undefined) {
      template.filters = filters;
    }
    if (columns !== undefined) {
      template.columns = columns;
    }
    if (isDefault !== undefined) {
      template.isDefault = isDefault;
    }
    if (pinned !== undefined) {
      template.pinned = pinned;
    }

    const saved = await template.save();
    return toTemplateResponse(saved);
  }

  async deleteTemplate(templateId, tenantId, userId) {
    const template = await Template.findOne({
      _id: templateId,
      userId,
      "meta.deleted": false,
      ...tenantOrLegacyMatch(tenantId),
    });

    if (!template) {
      throw AppError.notFound("Filter template not found");
    }

    template.meta.deleted = true;
    template.meta.deletedAt = new Date();
    return template.save();
  }

  async getDefaultTemplate(tenantId, userId) {
    let template = await Template.findOne({
      tenantId,
      userId,
      isDefault: true,
      "meta.deleted": false,
    });

    if (!template) {
      template = new Template({
        tenantId,
        userId,
        templateType: "members",
        filters: {
          subscriptionStatus: {
            operator: "equal_to",
            values: [MEMBERSHIP_STATUS.ACTIVE],
          },
        },
        columns: [],
        isDefault: true,
        pinned: false,
      });
      template = await template.save();
    }

    return template;
  }

  async getDefaultTemplateForType(tenantId, userId, type = "members") {
    const normalizedType = normalizeTemplateType(type);
    return Template.findOne({
      userId,
      templateType: normalizedType,
      isDefault: true,
      "meta.deleted": false,
      ...tenantOrLegacyMatch(tenantId),
    });
  }

  async getSystemDefaultTemplate(tenantId, type = "members") {
    const normalizedType = normalizeTemplateType(type);
    const template = await findSystemDefaultTemplateDoc(normalizedType, tenantId);

    if (!template) {
      throw AppError.notFound(
        "System default subscription template not found. Seed one with systemDefault: true for this tenant."
      );
    }

    return template;
  }
}

module.exports = new SubscriptionFilterTemplateService();
