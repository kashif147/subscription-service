const axios = require('axios');

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/profile-service';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/account-service';

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
    const payload = {
      memberIds: membershipNumbers,
      status: 'succeeded',
      purpose: 'subscriptionFee',
    };
    const postUrl = `${ACCOUNT_SERVICE_URL}/api/payments/batch`;

    console.log(`[Gateway Aggregation] === Account (payments) batch request ===`);
    console.log(`[Gateway Aggregation] ACCOUNT_SERVICE_URL: ${ACCOUNT_SERVICE_URL}`);
    console.log(`[Gateway Aggregation] Request: POST ${postUrl}`);
    console.log(`[Gateway Aggregation] memberIds count: ${membershipNumbers.length}, tenantId: ${tenantId || req?.headers?.['x-tenant-id'] || 'none'}`);
    console.log(`[Gateway Aggregation] memberIds (first 3): ${membershipNumbers.slice(0, 3).join(', ')}${membershipNumbers.length > 3 ? '...' : ''}`);

    const headers = buildServiceHeaders(req, tenantId);
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

function calculateFinancialDetails(payments, membershipCategory) {
  // Sort payments by date (most recent first)
  const sortedPayments = (payments || []).sort((a, b) => 
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  const lastPayment = sortedPayments[0];
  const totalPaid = sortedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Get membership fee based on category
  const membershipFee = getMembershipFeeByCategory(membershipCategory);

  // Calculate outstanding balance
  const outstandingBalance = Math.max(0, membershipFee - totalPaid);

  return {
    lastPaymentAmount: lastPayment?.amount || null,
    lastPaymentDate: lastPayment?.createdAt || null,
    membershipFee,
    outstandingBalance,
  };
}

function getMembershipFeeByCategory(category) {
  // Fee table (should ideally come from a config or database)
  const FEE_TABLE = {
    'FULL_TIME': 540.00,      // €45/month × 12
    'PART_TIME': 360.00,      // €30/month × 12
    'STUDENT': 120.00,        // €10/month × 12
    'RETIRED': 60.00,         // €5/month × 12
    'ASSOCIATE': 240.00,      // €20/month × 12
  };

  return FEE_TABLE[category] || 0;
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
    if (payment.memberId) {
      if (!map.has(payment.memberId)) {
        map.set(payment.memberId, []);
      }
      map.get(payment.memberId).push(payment);
    }
  });
  return map;
}

module.exports = {
  fetchProfilesByIds,
  fetchPaymentsByMemberIds,
  calculateFinancialDetails,
  getMembershipFeeByCategory,
  buildProfileMap,
  buildPaymentMap,
};
