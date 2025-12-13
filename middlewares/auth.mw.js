const { gatewaySecurity } = require("@membership/policy-middleware/security");
const { validateGatewayRequest } = gatewaySecurity;

const ensureAuthenticated = (req, res, next) => {
  // Check for gateway-verified JWT (trust gateway headers with validation)
  const jwtVerified = req.headers["x-jwt-verified"];
  const authSource = req.headers["x-auth-source"];

  if (jwtVerified === "true" && authSource === "gateway") {
    // Validate gateway request (signature, IP, format)
    const validation = validateGatewayRequest(req);
    if (!validation.valid) {
      console.warn("Gateway header validation failed:", validation.reason);
      return res.status(401).json({
        message: "Invalid gateway request",
        code: "GATEWAY_VALIDATION_FAILED",
        reason: validation.reason,
      });
    }

    // Gateway has verified JWT and forwarded claims as headers
    const userId = req.headers["x-user-id"];
    const tenantId = req.headers["x-tenant-id"];
    const userEmail = req.headers["x-user-email"];
    const userType = req.headers["x-user-type"];
    const userRolesStr = req.headers["x-user-roles"] || "[]";
    const userPermissionsStr = req.headers["x-user-permissions"] || "[]";

    if (!userId || !tenantId) {
      return res.status(401).json({
        message: "Missing required authentication headers",
        code: "MISSING_HEADERS",
      });
    }

    let roles = [];
    let permissions = [];

    try {
      roles = JSON.parse(userRolesStr);
      if (!Array.isArray(roles)) roles = [];
    } catch (e) {
      console.warn("Failed to parse x-user-roles header:", e.message);
    }

    try {
      permissions = JSON.parse(userPermissionsStr);
      if (!Array.isArray(permissions)) permissions = [];
    } catch (e) {
      console.warn("Failed to parse x-user-permissions header:", e.message);
    }

    // Set user object for backward compatibility
    req.user = {
      sub: userId,
      id: userId,
      tenantId,
      email: userEmail,
      userType,
      roles,
      permissions,
    };

    req.userId = userId;
    req.tenantId = tenantId;
    req.roles = roles;
    req.permissions = permissions;

    return next();
  }

  // Fallback: Legacy Bearer token flow (for direct service calls)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  // For legacy support, still allow JWT verification if no gateway headers
  const jwt = require("jsonwebtoken");
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = decoded.tenantId || decoded.tid;
    req.roles = decoded.roles || [];
    req.permissions = decoded.permissions || [];
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

module.exports = { ensureAuthenticated };
