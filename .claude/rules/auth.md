# Auth

Reminder-batch and most CRM routes additionally require `x-user-type: CRM` (or
`userType: "CRM"` in the JWT payload) on top of the platform-standard gateway-header/
Bearer-JWT auth. A plain authenticated portal user gets 403'd from those endpoints
regardless of policy permissions — a passing `requirePermission()` check alone is not
sufficient to reach those routes.

The three `ensureAuthenticatedOrInternal` routes are guarded by
`middlewares/profileSubscriptionAuthz.mw.js` (P5): `POST /internal/profile-merge` is
internal-only (`x-internal-request` branch, no `req.user`; user tokens 403 `INTERNAL_ONLY`);
`GET /profile/:profileId[/current]` allows internal callers unchanged, CRM via PDP
`subscriptions:read`, and PORTAL only for the caller's own profile as resolved by
profile-service `GET /api/profile/my-profile` (forwarded identity) — mismatch 403 `NOT_OWNER`.
Internal precedence is unchanged: in-network callers that also forward user headers stay internal.
