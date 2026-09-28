const express = require("express");
const router = express.Router();
const { ensureAuthenticatedWithTenantContext } = require("../middlewares/auth.mw");
const reminderBatch = require("../controllers/reminderBatch.controller");

router.post("/", ...ensureAuthenticatedWithTenantContext, reminderBatch.postCreate);
router.post(
  "/monthly-orchestrate",
  ...ensureAuthenticatedWithTenantContext,
  reminderBatch.postMonthlyOrchestrate
);
router.get("/", ...ensureAuthenticatedWithTenantContext, reminderBatch.getList);
router.get("/:batchId/members", ...ensureAuthenticatedWithTenantContext, reminderBatch.getMembers);
router.post("/:batchId/build", ...ensureAuthenticatedWithTenantContext, reminderBatch.postBuild);
router.post("/:batchId/execute", ...ensureAuthenticatedWithTenantContext, reminderBatch.postExecute);
router.delete("/:batchId", ...ensureAuthenticatedWithTenantContext, reminderBatch.deleteDraft);
router.get("/:batchId", ...ensureAuthenticatedWithTenantContext, reminderBatch.getOne);

module.exports = router;
