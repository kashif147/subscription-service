const axios = require("axios");
const mongoose = require("mongoose");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  process.env.POLICY_SERVICE_URL ||
  "http://localhost:3000";

// Phase A / A11: the work-location lookup type is addressed by its stable code. There is no
// process-global type-id cache any more (it was shared by every tenant); user-service caches the
// by-code result per trusted tenant (lookuptype:v2:<tenantId>:code:WORKLOC).
const WORK_LOCATION_TYPE_CODE = "WORKLOC";
const PLACEHOLDER_TENANTS = ["default", "unknown", "system", "null", "undefined"];

const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const cleanTenant = (value) => {
  const t = value == null ? "" : String(value).trim();
  return t && !PLACEHOLDER_TENANTS.includes(t.toLowerCase()) ? t : "";
};

/**
 * The tenant for an outbound lookup call: the caller's tenant, which must agree with the request's
 * trusted tenant when there is a request. Missing/placeholder/disagreeing -> "" (no call is made).
 */
function resolveLookupTenant(req, tenantId) {
  const tenant = cleanTenant(tenantId);
  if (!tenant) return "";
  const trusted = cleanTenant(req?.ctx?.tenantId || req?.tenantId || req?.user?.tenantId);
  if (trusted && trusted !== tenant) return "";
  return tenant;
}

function buildHeaders(req, tenantId) {
  const headers = {
    "Content-Type": "application/json",
    "x-tenant-id": tenantId || "",
    "x-internal-request": "true",
  };
  if (req?.headers?.authorization) {
    headers.authorization = req.headers.authorization;
  }
  for (const key of [
    "x-jwt-verified",
    "x-correlation-id",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
  ]) {
    if (req?.headers?.[key]) {
      headers[key] = req.headers[key];
    }
  }
  return headers;
}

function matchesWorkLocationLookup(lookup, workLocationKey) {
  const key = normalizeKey(workLocationKey);
  if (!key || !lookup) return false;

  const candidates = [
    lookup._id,
    lookup.id,
    lookup.code,
    lookup.lookupname,
    lookup.DisplayName,
    lookup.displayName,
    lookup.name,
  ]
    .filter((value) => value != null && String(value).trim() !== "")
    .map(normalizeKey);

  return candidates.includes(key);
}

async function fetchLookupById(id, headers) {
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(`${base}/api/lookup/${id}`, {
    headers,
    timeout: 8000,
    validateStatus: (status) => status < 500,
  });

  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  const body = response.data;
  return body?.data ?? body;
}

async function findWorkLocationLookupByName(workLocationKey, headers) {
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  // 404 (unknown code) or any other non-2xx -> no match.
  const response = await axios.get(
    `${base}/api/lookup/by-type-code/${WORK_LOCATION_TYPE_CODE}/hierarchy`,
    {
      headers,
      timeout: 15000,
      validateStatus: (status) => status < 500,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  const results = Array.isArray(response.data?.results)
    ? response.data.results
    : [];
  const match = results.find(({ lookup }) =>
    matchesWorkLocationLookup(lookup, workLocationKey)
  );
  return match?.lookup || null;
}

async function findWorkLocationLookup(workLocationKey, headers) {
  const key = String(workLocationKey || "").trim();
  if (!key || normalizeKey(key) === "other") {
    return null;
  }

  if (mongoose.Types.ObjectId.isValid(key) && key.length === 24) {
    const byId = await fetchLookupById(key, headers);
    if (byId) return byId;
  }

  return findWorkLocationLookupByName(key, headers);
}

async function isSalaryDeductionEnabledForWorkLocation(
  workLocationKey,
  { req = null, tenantId = "" } = {}
) {
  const tenant = resolveLookupTenant(req, tenantId);
  if (!tenant) {
    // Fail closed: never resolve tenant metadata without a trusted tenant.
    console.warn(
      "[lookup.service.client] work location lookup skipped: no trusted tenant"
    );
    return false;
  }
  const headers = buildHeaders(req, tenant);
  try {
    const lookup = await findWorkLocationLookup(workLocationKey, headers);
    return !!lookup?.processSalaryDeduction;
  } catch (error) {
    console.warn(
      "[lookup.service.client] work location salary deduction lookup failed:",
      error.message
    );
    return false;
  }
}

module.exports = {
  isSalaryDeductionEnabledForWorkLocation,
  resolveLookupTenant,
  buildHeaders,
};
