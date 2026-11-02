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

Reminder-batch **triggers** (`POST /`, `/:batchId/build`, `/:batchId/execute`, `/monthly-orchestrate`)
also require one of the exact finance-read claims account-service's reminder-eligibility-bulk guard
admits (`middlewares/reminderBatchAuthz.mw.js`, source lines cited there). The jobs then run with
subscription-service's internal service authority; queued RabbitMQ payloads never carry the user's
Authorization or gateway identity headers, and the worker never replays headers from a payload
(legacy payloads that contain `data.headers` are refused, not processed). Don't reintroduce header
capture into `jobs/reminderBatch.rabbit.js` — `tests/reminderServiceAuthority.p5.test.js` pins this.

`ensureAuthenticatedOrInternal` (the `/profile/:profileId[/current]` and `/internal/profile-merge`
routes): a request is internal only with `x-internal-request` AND no user identity (no
`Authorization`, `x-jwt-verified`, `x-auth-source`, `x-user-*`; empty values count as absent). Any user
identity -> the user path (`ensureAuthenticated`), as in account-service's `internalAuth`. Callers that
send `x-internal-request` together with a forwarded user identity (profile-service
`subscription.service.client.js` / `batch.controller.js` / `corn.market.controller.js`, events-service
`subscriptionLookup.client.js`) must send internal-only headers before this precedence is deployed.
