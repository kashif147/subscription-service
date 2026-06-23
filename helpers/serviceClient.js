const axios = require('axios');

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/profile-service';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/account-service';
const MEMBER_SUMMARY_CACHE_TTL_MS = 60 * 1000;
const MEMBER_SUMMARY_MAX_RETRIES = 2;
const MEMBER_SUMMARY_BATCH_CHUNK_SIZE = 1000;
const memberSummaryCache = new Map();
const WRITE_OFF_BUCKETS = new Set(["arrears", "current"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  const correlationId =
    req.correlationId ||
    req.headers['x-correlation-id'];
  if (correlationId) {
    headers['x-correlation-id'] = String(correlationId);
  }

  return headers;
}

/**
 * Headers for account-service /api/* (e.g. POST /api/payments/batch).
 * Same base as {@link buildServiceHeaders} (profile batch / cross-service) — forward
 * `authorization`, `x-jwt-verified` + `x-auth-source: gateway`, `x-tenant-id`, `x-user-*`
 * so account-service `ensureAuthenticated` can validate like other gateway-sourced calls.
 */
function buildAccountServiceRequestHeaders(req, tenantId) {
  return buildServiceHeaders(req, tenantId);
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
    const batchUrl = `${PROFILE_SERVICE_URL}/api/profile/batch`;

    console.log(`[Gateway Aggregation] === Profile batch request ===`);
    console.log(`[Gateway Aggregation] PROFILE_SERVICE_URL: ${PROFILE_SERVICE_URL}`);
    console.log(`[Gateway Aggregation] Request URL: ${batchUrl}`);
    console.log(`[Gateway Aggregation] profileIds count: ${ids.length}, tenantId: ${tenantId || req?.headers?.['x-tenant-id'] || 'none'}, relaxTenant: ${relaxTenant}`);
    console.log(`[Gateway Aggregation] profileIds (first 3): ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '...' : ''}`);

    const headers = buildServiceHeaders(req, tenantId);
    const response = await axios.post(
      batchUrl,
      { profileIds: ids },
      {
        headers,
        timeout: 5000,
        params: relaxTenant ? { relaxTenant: "true" } : undefined,
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
  const variantMap = new Map();
  uniqueMemberIds.forEach((memberId) => {
    variantMap.set(memberId, getMemberIdLookupKeys(memberId));
  });
  const uniqueLookupIds = [
    ...new Set(
      uniqueMemberIds.flatMap((memberId) => variantMap.get(memberId) || [])
    ),
  ];
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

  // Fetch batch in one request to avoid per-member API bursts and 429s.
  if (pendingIds.length > 0) {
    const chunks = [];
    const pendingLookupIds = [
      ...new Set(
        pendingIds.flatMap((memberId) => variantMap.get(memberId) || [memberId])
      ),
    ];
    for (let i = 0; i < pendingLookupIds.length; i += MEMBER_SUMMARY_BATCH_CHUNK_SIZE) {
      chunks.push(pendingLookupIds.slice(i, i + MEMBER_SUMMARY_BATCH_CHUNK_SIZE));
    }

    const batchMap = new Map();
    for (const memberIdChunk of chunks) {
      let attempt = 0;
      let batchItems = null;
      while (attempt <= MEMBER_SUMMARY_MAX_RETRIES) {
        try {
          const url = `${ACCOUNT_SERVICE_URL}/api/reports/members/summary-batch`;
          const response = await axios.post(
            url,
            { memberIds: memberIdChunk, scope: "all" },
            { headers, timeout: 20000 }
          );
          batchItems = response.data?.data?.items || [];
          break;
        } catch (error) {
          const status = error?.response?.status;
          if (status === 429 && attempt < MEMBER_SUMMARY_MAX_RETRIES) {
            const retryAfterHeader = Number(error?.response?.headers?.["retry-after"]);
            const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
              ? retryAfterHeader * 1000
              : 400 * Math.pow(2, attempt);
            await sleep(waitMs);
            attempt += 1;
            continue;
          }
          batchItems = [];
          break;
        }
      }

      (batchItems || []).forEach((row) => {
        const memberId = String(row?.memberId || "").trim();
        if (!memberId) return;
        batchMap.set(memberId, row);
      });
    }

    pendingIds.forEach((memberId) => {
      const variants = variantMap.get(memberId) || [memberId];
      const summary = variants.map((v) => batchMap.get(v)).find(Boolean) || null;
      memberSummaryCache.set(memberId, { at: Date.now(), data: summary });
      out.push({ memberId, summary });
    });
  }

  return out;
}

function safeDocNoPart(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "UNKNOWN";
}

function positiveCents(value) {
  const cents = Math.round(Number(value) || 0);
  return cents > 0 ? cents : 0;
}

function getPositive1400WriteOffBuckets(summary) {
  const bucketTotals = new Map();
  for (const row of summary?.buckets || []) {
    const accountCode = String(row?.accountCode || "").trim();
    const bucket = String(row?.bucket || "").trim();
    if (accountCode !== "1400" || !WRITE_OFF_BUCKETS.has(bucket)) continue;
    const amount = positiveCents(row?.amount);
    if (amount <= 0) continue;
    bucketTotals.set(bucket, (bucketTotals.get(bucket) || 0) + amount);
  }

  const buckets = [...bucketTotals.entries()].map(([bucket, amount]) => ({
    bucket,
    amount,
  }));
  if (buckets.length) return buckets;

  const arAccount = (summary?.accounts || []).find(
    (row) => String(row?.accountCode || "").trim() === "1400"
  );
  const arAmount = positiveCents(arAccount?.amount);
  if (arAmount > 0) {
    return [{ bucket: "arrears", amount: arAmount }];
  }

  const outstanding = positiveCents(summary?.outstandingBalance);
  return outstanding > 0 ? [{ bucket: "arrears", amount: outstanding }] : [];
}

async function postMemberOutstandingWriteOff({
  memberId,
  tenantId,
  req,
  date,
  docNoBase,
  memo,
  summary = null,
  requireSummary = false,
}) {
  const resolvedMemberId = String(memberId || "").trim();
  if (!resolvedMemberId) {
    return { memberId: resolvedMemberId, posted: [], skipped: true, reason: "memberId missing" };
  }

  let resolvedSummary = summary;
  if (!resolvedSummary) {
    const rows = await fetchMemberSummariesByMemberIds(
      [resolvedMemberId],
      tenantId,
      req || createInternalWorkerReq(tenantId)
    );
    resolvedSummary = rows?.[0]?.summary || null;
  }

  if (requireSummary && !resolvedSummary) {
    throw new Error(
      `Account summary unavailable for member ${resolvedMemberId}; cannot determine write-off amount`
    );
  }

  const writeOffBuckets = getPositive1400WriteOffBuckets(resolvedSummary);
  if (!writeOffBuckets.length) {
    return { memberId: resolvedMemberId, posted: [], skipped: true, reason: "no outstanding 1400 balance" };
  }

  const base = ACCOUNT_SERVICE_URL.replace(/\/$/, "");
  const url = `${base}/api/internal/members/writeoff`;
  const headers = buildAccountServiceRequestHeaders(
    req || createInternalWorkerReq(tenantId),
    tenantId
  );
  const resolvedDate =
    date instanceof Date ? date.toISOString().slice(0, 10) : String(date || "").slice(0, 10);
  const cleanDocNoBase = safeDocNoPart(docNoBase);
  const posted = [];

  for (const item of writeOffBuckets) {
    const docNo = `${cleanDocNoBase}-${item.bucket.toUpperCase()}`;
    const response = await axios.post(
      url,
      {
        date: resolvedDate,
        docNo,
        memberId: resolvedMemberId,
        amount: item.amount,
        periodBucket: item.bucket,
        memo,
      },
      {
        headers,
        timeout: 30000,
        validateStatus: (status) => status < 500,
      }
    );

    if (response.status >= 400) {
      const message =
        response.data?.error?.message ||
        response.data?.message ||
        `Account write-off failed (${response.status})`;
      throw new Error(message);
    }

    posted.push({
      docNo,
      bucket: item.bucket,
      amount: item.amount,
      journalId: response.data?.data?._id || null,
    });
  }

  return {
    memberId: resolvedMemberId,
    posted,
    totalAmount: posted.reduce((sum, item) => sum + item.amount, 0),
    skipped: false,
  };
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
async function fetchReminderEligibilityBulk(memberIds, tenantId, asOf, req) {
  if (!memberIds || memberIds.length === 0) return [];
  const headers = buildServiceHeaders(req || createInternalWorkerReq(tenantId), tenantId);
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

async function fetchProfilesByMembershipNumbers(membershipNumbers, tenantId, req) {
  const ids = [...new Set((membershipNumbers || []).map((n) => String(n).trim()).filter(Boolean))];
  if (!ids.length) return [];

  try {
    const url = `${PROFILE_SERVICE_URL}/api/profile/lookup-by-membership`;
    const response = await axios.post(
      url,
      { membershipNumbers: ids },
      {
        headers: buildServiceHeaders(req, tenantId),
        timeout: 15000,
      }
    );
    const list = response.data?.data;
    return Array.isArray(list) ? list : [];
  } catch (error) {
    console.error(
      "[serviceClient] lookup-by-membership failed:",
      error.response?.status || error.message
    );
    return [];
  }
}

module.exports = {
  createInternalWorkerReq,
  fetchProfilesByIds,
  fetchProfilesByMembershipNumbers,
  fetchPaymentsByMemberIds,
  fetchMemberSummariesByMemberIds,
  postMemberOutstandingWriteOff,
  getPositive1400WriteOffBuckets,
  fetchReminderEligibilityBulk,
  calculateFinancialDetails,
  getMembershipFeeByCategory,
  buildProfileMap,
  buildPaymentMap,
  getMemberIdLookupKeys,
  normalizeMembershipCategoryKey,
  getExpectedAnnualFeeCents,
};
