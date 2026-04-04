const Template = require("../models/template.model");
const { AppError } = require("../errors/AppError");
const { MEMBERSHIP_STATUS } = require("../constants/enums");

function toTemplateResponse(doc) {
  const obj =
    doc && typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete obj.meta;
  delete obj.__v;
  return obj;
}

class SubscriptionFilterTemplateService {
  async createTemplate(tenantId, userId, templateData) {
    const { name, templateType, filters, columns, isDefault, pinned } =
      templateData;
    const type = templateType || "subscription";

    if (isDefault) {
      await Template.updateMany(
        {
          tenantId,
          userId,
          templateType: type,
          isDefault: true,
          "meta.deleted": false,
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

  async getUserTemplatesWithSystemDefault(tenantId, userId, type = "subscription") {
    const typeFilter = { templateType: type };

    const systemDefault = await Template.findOne({
      tenantId,
      systemDefault: true,
      "meta.deleted": false,
      ...typeFilter,
    });

    const userTemplates = await Template.find({
      tenantId,
      userId,
      "meta.deleted": false,
      ...typeFilter,
    }).sort({ pinned: -1, isDefault: -1, createdAt: -1 });

    const allTemplates = [];
    if (systemDefault) allTemplates.push(systemDefault);
    allTemplates.push(...userTemplates);
    return allTemplates;
  }

  async getTemplateById(templateId, tenantId, userId) {
    const systemDefault = await Template.findOne({
      _id: templateId,
      tenantId,
      systemDefault: true,
      "meta.deleted": false,
    });
    if (systemDefault) {
      const type = systemDefault.templateType || "subscription";
      const userHasDefault = await Template.exists({
        tenantId,
        userId,
        templateType: type,
        isDefault: true,
        "meta.deleted": false,
      });
      const out = toTemplateResponse(systemDefault);
      if (!userHasDefault) out.isDefault = true;
      return out;
    }

    const template = await Template.findOne({
      _id: templateId,
      tenantId,
      userId,
      "meta.deleted": false,
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
      tenantId,
      systemDefault: true,
      "meta.deleted": false,
    });

    if (!template) {
      template = await Template.findOne({
        _id: templateId,
        tenantId,
        userId,
        "meta.deleted": false,
      });
    }

    if (!template) {
      throw AppError.notFound("Filter template not found");
    }

    const type =
      templateType !== undefined ? templateType : template.templateType;

    if (template.systemDefault) {
      if (isDefault === true) {
        await Template.updateMany(
          {
            tenantId,
            userId,
            templateType: type,
            "meta.deleted": false,
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
          tenantId,
          userId,
          templateType: type,
          _id: { $ne: templateId },
          "meta.deleted": false,
        },
        { $set: { isDefault: false } }
      );
    }

    if (name !== undefined) {
      template.name = name !== "" ? name : null;
    }
    if (templateType !== undefined) {
      template.templateType = templateType;
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
      tenantId,
      userId,
      "meta.deleted": false,
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
        templateType: "subscription",
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

  async getDefaultTemplateForType(tenantId, userId, type = "subscription") {
    return Template.findOne({
      tenantId,
      userId,
      templateType: type,
      isDefault: true,
      "meta.deleted": false,
    });
  }

  async getSystemDefaultTemplate(tenantId, type = "subscription") {
    const query = {
      tenantId,
      systemDefault: true,
      "meta.deleted": false,
    };
    if (type) {
      query.templateType = type;
    }
    const template = await Template.findOne(query);

    if (!template) {
      throw AppError.notFound(
        "System default subscription template not found. Seed one with systemDefault: true for this tenant."
      );
    }

    return template;
  }
}

module.exports = new SubscriptionFilterTemplateService();
