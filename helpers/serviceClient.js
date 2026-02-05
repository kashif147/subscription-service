const axios = require('axios');

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/profile-service';
const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://projectshell-vm.northeurope.cloudapp.azure.com/accounts-service';

function buildServiceHeaders(req, tenantId) {
  const headers = {
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId || 'default',
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
async function fetchProfilesByIds(profileIds, tenantId, req) {
  if (!profileIds || profileIds.length === 0) {
    return [];
  }

  try {
    console.log(`[Gateway Aggregation] Calling profile-service for ${profileIds.length} profiles (by profileId)...`);
    
    const headers = buildServiceHeaders(req, tenantId);
    
    const response = await axios.post(
      `${PROFILE_SERVICE_URL}/api/profile/batch`,
      {
        profileIds: profileIds.map(id => id.toString()),
      },
      {
        headers,
        timeout: 5000, 
      }
    );

    console.log(`[Gateway Aggregation] Profile-service returned ${response.data?.data?.length || 0} profiles`);
    return response.data.data || [];
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    console.error(
      '[Gateway Aggregation] Error fetching profiles from profile-service:',
      status ? `HTTP ${status} - ${message}` : message
    );
    if (error.response?.data) {
      console.error('[Gateway Aggregation] Profile-service response:', JSON.stringify(error.response.data));
    }
    // Return empty array on error (graceful degradation)
    return [];
  }
}


async function fetchPaymentsByMemberIds(membershipNumbers, tenantId, req) {
  if (!membershipNumbers || membershipNumbers.length === 0) {
    return [];
  }

  try {
    console.log(`[Gateway Aggregation] Calling account-service for ${membershipNumbers.length} members...`);
    
    // Build headers with user's authentication token (gateway aggregation)
    const headers = buildServiceHeaders(req, tenantId);
    
    const response = await axios.post(
      `${ACCOUNT_SERVICE_URL}/api/payments/batch`,
      {
        memberIds: membershipNumbers,
        status: 'succeeded',
        purpose: 'subscriptionFee',
      },
      {
        headers,
        timeout: 5000,
      }
    );

    console.log(`[Gateway Aggregation] Account-service returned ${response.data?.data?.length || 0} payments`);
    return response.data.data || [];
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    console.error(
      '[Gateway Aggregation] Error fetching payments from account-service:',
      status ? `HTTP ${status} - ${message}` : message
    );
    if (error.response?.data) {
      console.error('[Gateway Aggregation] Account-service response:', JSON.stringify(error.response.data));
    }
    // Return empty array on error (graceful degradation)
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
