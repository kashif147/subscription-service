const express = require("express");
const router = express.Router();

router.use("/testing", require("./auth.routes"));
router.use("/subscriptions", require("./subscription.routes"));
router.use("/reminder-batches", require("./reminderBatch.routes"));
router.use("/renewalBatches", require("./renewalBatch.routes"));

module.exports = router;
