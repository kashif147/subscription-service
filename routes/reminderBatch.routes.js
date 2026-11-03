const express = require("express");
const router = express.Router();
const { ensureAuthenticatedWithTenantContext } = require("../middlewares/auth.mw");
const { requireReminderBatchTrigger } = require("../middlewares/reminderBatchAuthz.mw");
const reminderBatch = require("../controllers/reminderBatch.controller");

// P5 service authority: every route that starts (or queues) build / execute / monthly-orchestrate
// is authorized by requireReminderBatchTrigger, from the verified CRM identity, before anything is
// created or queued. The work itself then runs with subscription-service's internal service authority.
router.post("/", ...ensureAuthenticatedWithTenantContext, requireReminderBatchTrigger, reminderBatch.postCreate);
router.post(
  "/monthly-orchestrate",
  ...ensureAuthenticatedWithTenantContext,
  requireReminderBatchTrigger,
  reminderBatch.postMonthlyOrchestrate
);
router.get("/", ...ensureAuthenticatedWithTenantContext, reminderBatch.getList);
router.get("/:batchId/members", ...ensureAuthenticatedWithTenantContext, reminderBatch.getMembers);
router.post(
  "/:batchId/build",
  ...ensureAuthenticatedWithTenantContext,
  requireReminderBatchTrigger,
  reminderBatch.postBuild
);
router.post(
  "/:batchId/execute",
  ...ensureAuthenticatedWithTenantContext,
  requireReminderBatchTrigger,
  reminderBatch.postExecute
);
router.delete("/:batchId", ...ensureAuthenticatedWithTenantContext, reminderBatch.deleteDraft);
router.get("/:batchId", ...ensureAuthenticatedWithTenantContext, reminderBatch.getOne);

module.exports = router;
