const express = require("express");
const router = express.Router();
const { ensureAuthenticated } = require("../middlewares/auth.mw");
const reminderBatch = require("../controllers/reminderBatch.controller");

router.post("/", ensureAuthenticated, reminderBatch.postCreate);
router.post(
  "/monthly-orchestrate",
  ensureAuthenticated,
  reminderBatch.postMonthlyOrchestrate
);
router.get("/", ensureAuthenticated, reminderBatch.getList);
router.get("/:batchId/members", ensureAuthenticated, reminderBatch.getMembers);
router.post("/:batchId/build", ensureAuthenticated, reminderBatch.postBuild);
router.post("/:batchId/execute", ensureAuthenticated, reminderBatch.postExecute);
router.delete("/:batchId", ensureAuthenticated, reminderBatch.deleteDraft);
router.get("/:batchId", ensureAuthenticated, reminderBatch.getOne);

module.exports = router;
