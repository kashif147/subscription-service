const express = require("express");
const router = express.Router();
const { ensureAuthenticated } = require("../middlewares/auth.mw");
const renewalBatch = require("../controllers/renewalBatch.controller");

router.post("/", ensureAuthenticated, renewalBatch.postCreate);
router.get("/year-options", ensureAuthenticated, renewalBatch.getYearOptions);
router.get("/by-year/:fiscalYear", ensureAuthenticated, renewalBatch.getByYear);
router.get("/:batchId/events", ensureAuthenticated, renewalBatch.getEvents);
router.get("/:batchId", ensureAuthenticated, renewalBatch.getOne);
router.post("/:batchId/execute", ensureAuthenticated, renewalBatch.postExecute);

module.exports = router;
