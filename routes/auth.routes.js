const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { ensureAuthenticated } = require("../middlewares/auth.mw");

/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       201:
 *         description: User successfully registered
 *       400:
 *         description: Invalid input
 */
router.post("/microsoft", authController.handleMicrosoftCallback);

module.exports = router;
