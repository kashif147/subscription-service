const express = require("express");
const router = express.Router();
const subscriptionFilterTemplateController = require("../controllers/subscription.filter.template.controller");

router.post("/", subscriptionFilterTemplateController.createTemplate);
router.get("/", subscriptionFilterTemplateController.getUserTemplates);
router.get("/default", subscriptionFilterTemplateController.getDefaultTemplate);
router.get("/:templateId", subscriptionFilterTemplateController.getTemplateById);
router.put("/:templateId", subscriptionFilterTemplateController.updateTemplate);
router.delete(
  "/:templateId",
  subscriptionFilterTemplateController.deleteTemplate
);

module.exports = router;
