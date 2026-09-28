const express = require("express");
const router = express.Router();
const { ensureAuthenticatedWithTenantContext } = require("../middlewares/auth.mw");
const renewalBatch = require("../controllers/renewalBatch.controller");

router.post("/", ...ensureAuthenticatedWithTenantContext, renewalBatch.postCreate);
router.get("/year-options", ...ensureAuthenticatedWithTenantContext, renewalBatch.getYearOptions);
router.get("/by-year/:fiscalYear", ...ensureAuthenticatedWithTenantContext, renewalBatch.getByYear);
router.get("/:batchId/events", ...ensureAuthenticatedWithTenantContext, renewalBatch.getEvents);
router.get("/:batchId", ...ensureAuthenticatedWithTenantContext, renewalBatch.getOne);
router.post("/:batchId/execute", ...ensureAuthenticatedWithTenantContext, renewalBatch.postExecute);

module.exports = router;
