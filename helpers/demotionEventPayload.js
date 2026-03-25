const { fetchProfilesByIds } = require("./serviceClient");

function primaryEmailFromProfile(p) {
  if (!p) return null;
  const c = p.contactInfo || {};
  const norm = p.normalizedEmail ? String(p.normalizedEmail).trim() : "";
  return (
    c.personalEmail ||
    c.workEmail ||
    (norm ? norm : null) ||
    (typeof c.preferredEmail === "string" && c.preferredEmail.includes("@")
      ? c.preferredEmail
      : null) ||
    null
  );
}

/**
 * Resolve portal userId + email for user-service role demotion (from subscription + profile-service).
 */
async function buildDemotionEventPayload({
  profileId,
  subscriptionUserId,
  tenantId,
  req,
}) {
  const pid = profileId?.toString?.() || String(profileId);
  const tid = tenantId != null ? String(tenantId) : null;
  let userId = subscriptionUserId ? String(subscriptionUserId).trim() : null;
  let userEmail = null;
  let effectiveTenantId = tid;

  try {
    let profiles = await fetchProfilesByIds([pid], tid, req || null);
    let profile = Array.isArray(profiles) ? profiles[0] : null;
    if (!profile && tid) {
      profiles = await fetchProfilesByIds([pid], tid, req || null, {
        relaxTenant: true,
      });
      profile = Array.isArray(profiles) ? profiles[0] : null;
    }
    if (profile) {
      userEmail = primaryEmailFromProfile(profile);
      if (!userId && profile.userId) {
        userId = String(profile.userId);
      }
      if (profile.tenantId != null && String(profile.tenantId).trim()) {
        effectiveTenantId = String(profile.tenantId);
      }
    }
  } catch (e) {
    console.warn("[demotionEventPayload] Profile lookup failed:", e.message);
  }

  return {
    profileId: pid,
    tenantId: effectiveTenantId,
    userId: userId || null,
    userEmail: userEmail || null,
  };
}

module.exports = { buildDemotionEventPayload, primaryEmailFromProfile };
