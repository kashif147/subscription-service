const express = require("express");
const router = express.Router();
const testController = require("../controllers/test.controller");
const { ensureAuthenticated } = require("../middlewares/auth.mw");

router.get("/", ensureAuthenticated, testController.testing);

module.exports = router;
