const express = require("express");
const router = express.Router();

router.use("/testing", require("./auth.routes"));

module.exports = router;
