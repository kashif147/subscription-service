const Joi = require('joi');

module.exports.local_signup_post = Joi.object({
  firstname: Joi.string().required(),
  lastname: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
});

module.exports.local_login_post = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
});

module.exports.change_password_post = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).required(),
});

module.exports.forgot_password_post = Joi.object({
  email: Joi.string().email().required(),
});

module.exports.reset_password_post = Joi.object({
  email: Joi.string().email().required(),
  forgotPasswordCode: Joi.string().required(),
  newPassword: Joi.string().min(6).required(),
});

module.exports.single_user_get = Joi.object({
  id: Joi.string().required(),
});

module.exports.single_user_delete = Joi.object({
  id: Joi.string().required(),
});
