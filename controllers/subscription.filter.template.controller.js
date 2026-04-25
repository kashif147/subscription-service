const subscriptionFilterTemplateService = require("../services/subscription.filter.template.service");
const {
  filter_template_create,
  filter_template_update,
} = require("../validation/subscriptionTemplate.validation");
const { USER_TYPE } = require("../constants/enums");
const { AppError } = require("../errors/AppError");

function requireCrmTenant(req, res) {
  if (!req.user || req.user.userType !== USER_TYPE.CRM) {
    res.status(403).json({
      status: "fail",
      data: "Access denied. CRM users only.",
    });
    return null;
  }
  if (!req.tenantId) {
    res.status(400).json({
      status: "fail",
      data: "Missing tenant context",
    });
    return null;
  }
  const userId = req.user.sub || req.user.id;
  if (!userId) {
    res.status(401).json({
      status: "fail",
      data: "Missing user id",
    });
    return null;
  }
  return { tenantId: req.tenantId, userId: String(userId) };
}

exports.createTemplate = async (req, res) => {
  const ctx = requireCrmTenant(req, res);
  if (!ctx) return;

  try {
    const validated = await filter_template_create.validateAsync(req.body);
    const template = await subscriptionFilterTemplateService.createTemplate(
      ctx.tenantId,
      ctx.userId,
      validated
    );
    return res.success(template);
  } catch (error) {
    if (error.isJoi) {
      return res.status(400).json({
        status: "fail",
        data: error.details.map((d) => d.message).join(", "),
      });
    }
    console.error("createTemplate:", error);
    return res.serverError(error);
  }
};

exports.getUserTemplates = async (req, res) => {
  const ctx = requireCrmTenant(req, res);
  if (!ctx) return;

  try {
    const type = req.query.type || "members";
    const list =
      await subscriptionFilterTemplateService.getUserTemplatesWithSystemDefault(
        ctx.tenantId,
        ctx.userId,
        type
      );

    const userTemplates = list.filter((t) => !t.systemDefault);
    const userHasDefault = userTemplates.some((t) => t.isDefault);
    const systemDefault = list.find((t) => t.systemDefault) || null;
    if (systemDefault && !userHasDefault) {
      systemDefault.isDefault = true;
    }

    return res.success({
      total: list.length,
      templates: {
        systemDefault,
        userTemplates,
        userHasDefault,
      },
    });
  } catch (error) {
    console.error("getUserTemplates:", error);
    return res.serverError(error);
  }
};

exports.getTemplateById = async (req, res) => {
  const ctx = requireCrmTenant(req, res);
  if (!ctx) return;

  try {
    const template = await subscriptionFilterTemplateService.getTemplateById(
      req.params.templateId,
      ctx.tenantId,
      ctx.userId
    );
    return res.success(template);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return res.status(404).json({ status: "fail", data: error.message });
    }
    console.error("getTemplateById:", error);
    return res.serverError(error);
  }
};

exports.updateTemplate = async (req, res) => {
  const ctx = requireCrmTenant(req, res);
  if (!ctx) return;

  try {
    const validated = await filter_template_update.validateAsync(req.body);
    const template = await subscriptionFilterTemplateService.updateTemplate(
      req.params.templateId,
      ctx.tenantId,
      ctx.userId,
      validated
    );
    return res.success(template);
  } catch (error) {
    if (error.isJoi) {
      return res.status(400).json({
        status: "fail",
        data: error.details.map((d) => d.message).join(", "),
      });
    }
    if (error instanceof AppError && error.status === 404) {
      return res.status(404).json({ status: "fail", data: error.message });
    }
    console.error("updateTemplate:", error);
    return res.serverError(error);
  }
};

exports.deleteTemplate = async (req, res) => {
  const ctx = requireCrmTenant(req, res);
  if (!ctx) return;

  try {
    await subscriptionFilterTemplateService.deleteTemplate(
      req.params.templateId,
      ctx.tenantId,
      ctx.userId
    );
    return res.success(null);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return res.status(404).json({ status: "fail", data: error.message });
    }
    console.error("deleteTemplate:", error);
    return res.serverError(error);
  }
};

exports.getDefaultTemplate = async (req, res) => {
  const ctx = requireCrmTenant(req, res);
  if (!ctx) return;

  try {
    const template = await subscriptionFilterTemplateService.getDefaultTemplate(
      ctx.tenantId,
      ctx.userId
    );
    return res.success(template);
  } catch (error) {
    console.error("getDefaultTemplate:", error);
    return res.serverError(error);
  }
};
