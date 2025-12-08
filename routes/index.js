const express = require("express");
const router = express.Router();

router.use("/testing", require("./auth.routes"));
router.use("/subscriptions", require("./subscription.routes"));

module.exports = router;
