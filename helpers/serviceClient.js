const axios = require('axios');

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/profile-service';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/account-service';
const MEMBER_SUMMARY_CACHE_TTL_MS = 60 * 1000;
const MEMBER_SUMMARY_MAX_CONCURRENCY = 2;
const memberSummaryCache = new Map();

/** Minimal request shape for internal async workers (RabbitMQ/event consumers). */
function createInternalWorkerReq(tenantId, actor = {}) {
  const tid = tenantId || "default";
  const { userId = null, email = null } = actor || {};
  return {
    headers: { "x-tenant-id": tid, "x-internal-request": "true" },
    tenantId: tid,
    userId: userId || undefined,
    user: email ? { email } : undefined,
  };
}

function buildAccountInternalHeaders(tenantId) {
  const key = process.env.ACCOUNTS_API_KEY || '';
  if (!key) {
    throw new Error('ACCOUNTS_API_KEY is required for account-service internal calls');
  }
  return {
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId || 'default',
    'x-api-key': key,
  };
}

function buildServiceHeaders(req, tenantId) {
  const headers = {
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId || req?.headers?.['x-tenant-id'] || 'default',
    'x-internal-request': 'true', 
  };

  if (req.headers['x-jwt-verified']) {
    headers['x-jwt-verified'] = req.headers['x-jwt-verified'];
  }
  if (req.headers['x-auth-source']) {
    headers['x-auth-source'] = req.headers['x-auth-source'];
  }
  if (req.headers['x-user-id']) {
    headers['x-user-id'] = req.headers['x-user-id'];
  }
  if (req.headers['x-tenant-id']) {
    headers['x-tenant-id'] = req.headers['x-tenant-id'];
  }
  if (req.headers['x-user-email']) {
    headers['x-user-email'] = req.headers['x-user-email'];
  }
  if (req.headers['x-user-type']) {
    headers['x-user-type'] = req.headers['x-user-type'];
  }
  if (req.headers['x-user-roles']) {
    headers['x-user-roles'] = req.headers['x-user-roles'];
  }
  if (req.headers['x-user-permissions']) {
    headers['x-user-permissions'] = req.headers['x-user-permissions'];
  }

  if (req.headers['authorization']) {
    headers['authorization'] = req.headers['authorization'];
  }

  return headers;
}

/**
 * Headers for account-service /api/* (e.g. POST /api/payments/batch).
 * Same base as {@link buildServiceHeaders} (profile batch / cross-service) — forward
 * `authorization`, `x-jwt-verified` + `x-auth-source: gateway`, `x-tenant-id`, `x-user-*`
 * so account-service `ensureAuthenticated` can validate like other gateway-sourced calls.
 * Optional: if `ACCOUNTS_API_KEY` is set, add `x-api-key` (account routes accept key OR JWT;
 * use key for workers/RabbitMQ that have no user token).
 */
function buildAccountServiceRequestHeaders(req, tenantId) {
  const base = buildServiceHeaders(req, tenantId);
  const key = process.env.ACCOUNTS_API_KEY || "";
  if (key) {
    return { ...base, "x-api-key": key };
  }
  return base;
}

/**
 * Fetch profiles by profile IDs (not user IDs - userId can be null on subscription).
 * Used by gateway aggregation so CRM subscription API returns profile + payment data.
 */
async function fetchProfilesByIds(profileIds, tenantId, req, options = {}) {
  if (!profileIds || profileIds.length === 0) {
    return [];
  }

  const { relaxTenant = false } = options;

  try {
    const ids = profileIds.map((id) => id.toString());
    const profileIdsQuery = ids.join(",");
    const batchUrl = `${PROFILE_SERVICE_URL}/api/profile/batch`;
    const fullUrl = `${batchUrl}?profileIds=${encodeURIComponent(profileIdsQuery)}`;

    console.log(`[Gateway Aggregation] === Profile batch request ===`);
    console.log(`[Gateway Aggregation] PROFILE_SERVICE_URL: ${PROFILE_SERVICE_URL}`);
    console.log(`[Gateway Aggregation] Request URL: ${fullUrl}`);
    console.log(`[Gateway Aggregation] profileIds count: ${ids.length}, tenantId: ${tenantId || req?.headers?.['x-tenant-id'] || 'none'}, relaxTenant: ${relaxTenant}`);
    console.log(`[Gateway Aggregation] profileIds (first 3): ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '...' : ''}`);

    const headers = buildServiceHeaders(req, tenantId);
    const params = { profileIds: profileIdsQuery };
    if (relaxTenant) {
      params.relaxTenant = "true";
    }
    const response = await axios.get(batchUrl, {
        params,
        headers,
        timeout: 5000,
      }
    );

    const profileList = response.data?.data;
    const count = Array.isArray(profileList) ? profileList.length : 0;
    console.log(`[Gateway Aggregation] Profile-service response: status=${response.status}, data.count=${count}`);
    if (count > 0 && profileList[0]) {
      console.log(`[Gateway Aggregation] First profile _id: ${profileList[0]._id}, membershipNumber: ${profileList[0].membershipNumber || 'n/a'}`);
    }
    return profileList || [];
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    const code = error.code || '';
    console.error(`[Gateway Aggregation] Profile-service ERROR: ${code} ${status ? `HTTP ${status}` : ''} - ${message}`);
    if (error.response?.data) {
      console.error('[Gateway Aggregation] Profile-service response body:', JSON.stringify(error.response.data));
    }
    if (error.code) {
      console.error('[Gateway Aggregation] Error code:', error.code, error.message);
    }
    return [];
  }
}


async function fetchPaymentsByMemberIds(membershipNumbers, tenantId, req) {
  if (!membershipNumbers || membershipNumbers.length === 0) {
    return [];
  }

  try {
    const expandedMemberIds = [
      ...new Set(
        membershipNumbers
          .flatMap((id) => getMemberIdLookupKeys(id))
          .filter(Boolean)
      ),
    ];
    // Omit purpose: account-service then returns all succeeded member payments; we split by purpose in calculateFinancialDetails.
    const payload = {
      memberIds: expandedMemberIds,
      status: "succeeded",
    };
    const postUrl = `${ACCOUNT_SERVICE_URL}/api/payments/batch`;

    console.log(`[Gateway Aggregation] === Account (payments) batch request ===`);
    console.log(`[Gateway Aggregation] ACCOUNT_SERVICE_URL: ${ACCOUNT_SERVICE_URL}`);
    console.log(`[Gateway Aggregation] Request: POST ${postUrl}`);
    console.log(`[Gateway Aggregation] memberIds count: ${expandedMemberIds.length}, tenantId: ${tenantId || req?.headers?.['x-tenant-id'] || 'none'}`);
    console.log(`[Gateway Aggregation] memberIds (first 3): ${expandedMemberIds.slice(0, 3).join(', ')}${expandedMemberIds.length > 3 ? '...' : ''}`);

    const headers = buildAccountServiceRequestHeaders(req, tenantId);
    const response = await axios.post(postUrl, payload, {
      headers,
      timeout: 5000,
    });

    const paymentList = response.data?.data;
    const count = Array.isArray(paymentList) ? paymentList.length : (typeof response.data?.data === 'number' ? response.data.data : 0);
    console.log(`[Gateway Aggregation] Account-service response: status=${response.status}, payments count: ${Array.isArray(paymentList) ? paymentList.length : 'n/a'}`);
    return paymentList || [];
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    const code = error.code || '';
    console.error(`[Gateway Aggregation] Account-service ERROR: ${code} ${status ? `HTTP ${status}` : ''} - ${message}`);
    if (error.response?.data) {
      console.error('[Gateway Aggregation] Account-service response body:', JSON.stringify(error.response.data));
    }
    if (error.code) {
      console.error('[Gateway Aggregation] Error code:', error.code, error.message);
    }
    return [];
  }
}

async function fetchMemberSummariesByMemberIds(memberIds, tenantId, req) {
  if (!memberIds || memberIds.length === 0) return [];
  const uniqueMemberIds = [...new Set(memberIds.map((x) => String(x || "").trim()).filter(Boolean))];
  const headers = buildAccountServiceRequestHeaders(req, tenantId);
  const now = Date.now();

  const out = [];
  const pendingIds = [];

  uniqueMemberIds.forEach((memberId) => {
    const cached = memberSummaryCache.get(memberId);
    if (cached && now - cached.at < MEMBER_SUMMARY_CACHE_TTL_MS) {
      out.push({ memberId, summary: cached.data });
      return;
    }
    pendingIds.push(memberId);
  });

  // Fetch with low concurrency to avoid account-service 429 rate limits.
  for (let i = 0; i < pendingIds.length; i += MEMBER_SUMMARY_MAX_CONCURRENCY) {
    const chunk = pendingIds.slice(i, i + MEMBER_SUMMARY_MAX_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (memberId) => {
        try {
          const url = `${ACCOUNT_SERVICE_URL}/api/reports/member/${encodeURIComponent(memberId)}/summary`;
          const response = await axios.get(url, { headers, timeout: 8000 });
          const summary = response.data?.data || response.data || null;
          memberSummaryCache.set(memberId, { at: Date.now(), data: summary });
          return { memberId, summary };
        } catch (error) {
          // Graceful fallback: on 429 (or any error), skip summary and let caller use computed fallback.
          return { memberId, summary: null };
        }
      })
    );
    out.push(...chunkResults);
  }

  return out;
}

function calculateFinancialDetails(payments, membershipCategory) {
  // Sort payments by date (most recent first)
  const sortedPayments = (payments || []).sort((a, b) => 
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  const lastPayment = sortedPayments[0];
  const subPayments = sortedPayments.filter((p) => p.purpose === "subscriptionFee");
  // account-service stores Payment.amount in integer cents; outstanding uses subscription fee payments only
  const totalPaidCents = subPayments.reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );

  // Get membership fee based on category (euros, display)
  const membershipFee = getMembershipFeeByCategory(membershipCategory);

  const totalPaidEur = totalPaidCents / 100;
  const outstandingBalance = Math.max(0, membershipFee - totalPaidEur);
  const lastEur = lastPayment?.amount != null
    ? (Number(lastPayment.amount) || 0) / 100
    : null;

  return {
    lastPaymentAmount: lastEur,
    lastPaymentDate: lastPayment?.createdAt || null,
    membershipFee,
    outstandingBalance,
  };
}

const MEMBERSHIP_FEE_EUR_BY_KEY = {
  FULL_TIME: 540.0, // €45/month × 12
  PART_TIME: 360.0,
  STUDENT: 120.0,
  RETIRED: 60.0,
  ASSOCIATE: 240.0,
  /** e.g. subscription `membershipCategory` "General all grade" */
  GENERAL_ALL_GRADE: 326.0,
  /** e.g. "Private nursing" / private nursing */
  PRIVATE_NURSING: 243.0,
};

/** Maps normalized keys that might not match the canonical FEE key. */
const MEMBERSHIP_FEE_KEY_ALIASES = {
  FULLTIME: "FULL_TIME",
  PARTTIME: "PART_TIME",
  FT: "FULL_TIME",
  PT: "PART_TIME",
};

/**
 * "Full time", "full_time", "FULL-TIME" → "FULL_TIME"
 * @param {string|null|undefined} category
 * @returns {string}
 */
function normalizeMembershipCategoryKey(category) {
  if (category == null || category === "") return "";
  return String(category)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getMembershipFeeByCategory(category) {
  const norm = normalizeMembershipCategoryKey(category);
  if (!norm) return 0;
  const key = MEMBERSHIP_FEE_KEY_ALIASES[norm] || norm;
  if (Object.prototype.hasOwnProperty.call(MEMBERSHIP_FEE_EUR_BY_KEY, key)) {
    return MEMBERSHIP_FEE_EUR_BY_KEY[key];
  }
  if (Object.prototype.hasOwnProperty.call(MEMBERSHIP_FEE_EUR_BY_KEY, norm)) {
    return MEMBERSHIP_FEE_EUR_BY_KEY[norm];
  }
  return 0;
}

/**
 * @param {string|null|undefined} category
 * @returns {number} expected annual fee in **euro cents** (integer)
 */
function getExpectedAnnualFeeCents(category) {
  const eur = getMembershipFeeByCategory(category);
  if (!eur || eur <= 0) return 0;
  return Math.round(eur * 100);
}

function buildProfileMap(profiles) {
  const map = new Map();
  (profiles || []).forEach(profile => {
    if (profile._id) {
      map.set(profile._id.toString(), profile);
    }
  });
  return map;
}

function buildPaymentMap(payments) {
  const map = new Map();
  (payments || []).forEach(payment => {
    const keys = getMemberIdLookupKeys(payment?.memberId);
    keys.forEach((key) => {
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(payment);
    });
  });
  return map;
}

function getMemberIdLookupKeys(memberId) {
  const raw = memberId != null ? String(memberId).trim() : "";
  if (!raw) return [];
  const noSpaces = raw.replace(/\s+/g, "");
  const upper = noSpaces.toUpperCase();
  const alnumOnly = upper.replace(/[^A-Z0-9]/g, "");
  return [...new Set([raw, noSpaces, upper, alnumOnly].filter(Boolean))];
}

/**
 * Bulk reminder-batch eligibility (materialized 1400 arrears + last Receipt) for many memberIds.
 * @param {string[]} memberIds - ledger member ids (typically membership numbers)
 * @param {string} tenantId
 * @param {string|Date} [asOf]
 * @returns {Promise<object[]>} snapshot items (same shape as GET single)
 */
async function fetchReminderEligibilityBulk(memberIds, tenantId, asOf) {
  if (!memberIds || memberIds.length === 0) return [];
  const headers = buildAccountInternalHeaders(tenantId);
  const url = `${ACCOUNT_SERVICE_URL}/api/internal/members/reminder-eligibility-bulk`;
  const asOfIso =
    asOf instanceof Date
      ? asOf.toISOString()
      : asOf
        ? String(asOf)
        : undefined;
  const response = await axios.post(
    url,
    { memberIds, asOf: asOfIso },
    { headers, timeout: 120000 }
  );
  const payload = response.data?.data;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

module.exports = {
  createInternalWorkerReq,
  fetchProfilesByIds,
  fetchPaymentsByMemberIds,
  fetchMemberSummariesByMemberIds,
  fetchReminderEligibilityBulk,
  calculateFinancialDetails,
  getMembershipFeeByCategory,
  buildProfileMap,
  buildPaymentMap,
  getMemberIdLookupKeys,
  normalizeMembershipCategoryKey,
  getExpectedAnnualFeeCents,
};
