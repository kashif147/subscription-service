const axios = require("axios");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  process.env.POLICY_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/user-service";

function buildInternalHeaders(tenantId) {
  return {
    "Content-Type": "application/json",
    "x-internal-request": "true",
    "x-tenant-id": tenantId || "default",
  };
}

async function fetchTenantLifecycleConfigs() {
  const res = await axios.get(
    `${USER_SERVICE_URL}/api/internal/tenant-lifecycle-configs`,
    {
      headers: buildInternalHeaders("system"),
      timeout: 15000,
    }
  );
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

async function fetchTenantLifecycleConfig(tenantId) {
  const res = await axios.get(
    `${USER_SERVICE_URL}/api/internal/tenants/${tenantId}/lifecycle-config`,
    {
      headers: buildInternalHeaders(tenantId),
      timeout: 10000,
    }
  );
  return res.data?.data || null;
}

async function fetchNotificationRecipients(tenantId, roleCodes = []) {
  const codes = (Array.isArray(roleCodes) && roleCodes.length
    ? roleCodes
    : ["MEMBERSHIP_OFFICER"]
  )
    .map((code) => String(code || "").trim().toUpperCase())
    .filter(Boolean);
  const res = await axios.get(
    `${USER_SERVICE_URL}/api/internal/tenants/${tenantId}/notification-recipients`,
    {
      params: { roleCodes: codes.join(",") },
      headers: buildInternalHeaders(tenantId),
      timeout: 10000,
    }
  );
  return Array.isArray(res.data?.data?.users) ? res.data.data.users : [];
}

module.exports = {
  fetchTenantLifecycleConfigs,
  fetchTenantLifecycleConfig,
  fetchNotificationRecipients,
};
