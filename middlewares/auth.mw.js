const jwt = require("jsonwebtoken");
const { USER_TYPE } = require("../constants/enums");

/**
 * Authentication middleware similar to portal/profile services.
 * - Verifies Bearer token
 * - Sets `req.user`, `req.userId`, `req.tenantId`
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      status: "fail",
      data: "Authorization header required",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify JWT token using JWT_SECRET (same as profile-service)
    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET environment variable is not set!");
      throw new Error("JWT_SECRET environment variable is required");
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Extract tenantId in a similar way to other services
    const tenantId =
      decoded.tenantId || decoded.tid || decoded.extension_tenantId || decoded.tenant;

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = tenantId || decoded.tenantId;

    next();
  } catch (err) {
    return res.status(401).json({
      status: "fail",
      data: "Invalid token",
    });
  }
};

/**
 * CRM-only guard, similar to CRM APIs in other services.
 * Assumes `authenticate` has already run and set `req.user`.
 */
const requireCRM = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      status: "fail",
      data: "Authentication required",
    });
  }

  if (req.user.userType !== USER_TYPE.CRM) {
    return res.status(403).json({
      status: "fail",
      data: "Access denied. CRM users only.",
    });
  }

  next();
};

module.exports = { authenticate, requireCRM };
