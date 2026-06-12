const axios = require("axios");
const mongoose = require("mongoose");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  process.env.POLICY_SERVICE_URL ||
  "http://localhost:3000";

const WORK_LOC_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedWorkLocTypeId = null;
let workLocTypeCacheExpiry = 0;

const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

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
    "x-auth-source",
    "x-user-id",
    "x-user-email",
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

async function getWorkLocTypeId(headers) {
  if (cachedWorkLocTypeId && Date.now() < workLocTypeCacheExpiry) {
    return cachedWorkLocTypeId;
  }

  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(`${base}/api/lookuptype`, {
    headers,
    timeout: 8000,
    validateStatus: (status) => status < 500,
  });

  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  const types = Array.isArray(response.data) ? response.data : [];
  const workLocType = types.find((type) => type?.code === "WORKLOC");
  if (!workLocType?._id) {
    return null;
  }

  cachedWorkLocTypeId = String(workLocType._id);
  workLocTypeCacheExpiry = Date.now() + WORK_LOC_TYPE_CACHE_TTL_MS;
  return cachedWorkLocTypeId;
}

async function findWorkLocationLookupByName(workLocationKey, headers) {
  const workLocTypeId = await getWorkLocTypeId(headers);
  if (!workLocTypeId) return null;

  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(
    `${base}/api/lookup/by-type/${workLocTypeId}/hierarchy`,
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
  const headers = buildHeaders(req, tenantId);
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
};
