const Joi = require("joi");
const {
  FILTER_OPERATOR,
  ALLOWED_SUBSCRIPTION_FILTER_KEYS,
  SUBSCRIPTION_RESPONSE_COLUMNS,
} = require("../constants/subscriptionTemplate");
const MEMBERS_TEMPLATE_TYPES = ["member", "members"];

const filterEntrySchema = Joi.object({
  operator: Joi.string()
    .valid(FILTER_OPERATOR.EQUAL_TO, FILTER_OPERATOR.NOT_EQUAL_TO)
    .required(),
  values: Joi.array().items(Joi.string()).min(1).required(),
});

const filter_template_create = Joi.object({
  name: Joi.string().trim().allow("", null).optional().default(null),
  templateType: Joi.string().trim().optional().default("members"),
  filters: Joi.when("templateType", {
    is: Joi.valid(...MEMBERS_TEMPLATE_TYPES),
    then: Joi.object().pattern(Joi.string().trim(), filterEntrySchema).optional().default({}),
    otherwise: Joi.object()
      .pattern(Joi.string().valid(...ALLOWED_SUBSCRIPTION_FILTER_KEYS), filterEntrySchema)
      .optional()
      .default({}),
  }),
  columns: Joi.when("templateType", {
    is: Joi.valid(...MEMBERS_TEMPLATE_TYPES),
    then: Joi.array().items(Joi.string().trim()).optional().default([]),
    otherwise: Joi.array()
      .items(Joi.string().valid(...SUBSCRIPTION_RESPONSE_COLUMNS))
      .optional()
      .default([]),
  }),
  columnLabels: Joi.object().pattern(Joi.string().trim(), Joi.string().trim()).optional().default({}),
  visibleFilters: Joi.array().items(Joi.string().trim()).optional().default([]),
  isDefault: Joi.boolean().optional().default(false),
  pinned: Joi.boolean().optional().default(false),
});

const filter_template_update = Joi.object({
  name: Joi.string().trim().allow("", null).optional(),
  templateType: Joi.string().trim().optional(),
  filters: Joi.object().pattern(Joi.string().trim(), filterEntrySchema).optional(),
  columns: Joi.array().items(Joi.string().trim()).optional(),
  columnLabels: Joi.object().pattern(Joi.string().trim(), Joi.string().trim()).optional(),
  visibleFilters: Joi.array().items(Joi.string().trim()).optional(),
  isDefault: Joi.boolean().optional(),
  pinned: Joi.boolean().optional(),
}).min(0);

module.exports = {
  filter_template_create,
  filter_template_update,
};
