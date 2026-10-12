// Event tenant authority for consumers (Phase 2C Track C).
//
// The envelope tenant (payload.tenantId, set by the publisher from its trusted context) is
// canonical; data.tenantId is only a fallback when the envelope has none. Both present and
// different -> EventTenantMismatchError; neither -> EventTenantMissingError. Both throw so the
// consumer retries and then dead-letters the event (quarantine) instead of writing tenant-owned
// data under the wrong (or no) tenant. There is no "default" tenant.
class EventTenantMismatchError extends Error {
  constructor(eventType) {
    super(`Event tenant mismatch (envelope vs data) for ${eventType || "event"}`);
    this.name = "EventTenantMismatchError";
    this.code = "EVENT_TENANT_MISMATCH";
  }
}
class EventTenantMissingError extends Error {
  constructor(eventType) {
    super(`Event has no tenant (envelope or data) for ${eventType || "event"}`);
    this.name = "EventTenantMissingError";
    this.code = "EVENT_TENANT_MISSING";
  }
}
const clean = (v) => (v == null ? "" : String(v).trim());

function resolveEventTenant(payload, { eventType } = {}) {
  const envelope = clean(payload?.tenantId);
  const data =
    payload?.data && typeof payload.data === "object" ? clean(payload.data.tenantId) : "";
  const type = eventType || payload?.eventType;
  if (envelope && data && envelope !== data) {
    console.warn("[eventTenant] quarantining event: envelope/data tenant mismatch", {
      eventType: type,
      eventId: payload?.eventId,
      correlationId: payload?.correlationId,
    });
    throw new EventTenantMismatchError(type);
  }
  const tenantId = envelope || data;
  if (!tenantId) {
    console.warn("[eventTenant] quarantining event: no tenant", {
      eventType: type,
      eventId: payload?.eventId,
      correlationId: payload?.correlationId,
    });
    throw new EventTenantMissingError(type);
  }
  return tenantId;
}

module.exports = { resolveEventTenant, EventTenantMismatchError, EventTenantMissingError };
