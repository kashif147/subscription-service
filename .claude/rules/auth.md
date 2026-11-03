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
(legacy payloads that contain `data.headers` are refused, not processed, after a credential-free
`reminder_job_quarantine` record is written; a failed write throws so the job is never acked as handled).
The reminder jobs queue is consumed by `rabbitMQ/explicitAckConsumer.js` (explicit ack, dedicated channel),
NOT the shared middleware consumer: don't register the reminder event types with `consumer.registerHandler`
and don't add an ack-then-republish retry — a crash during such a delay loses the job. Failure: first
delivery -> requeue once (broker), redelivered -> dead-letter to `.dlq`. A dead-lettered legacy job still
carries its stored headers: never replay it; inspect/handle only with owner approval. Don't reintroduce
header capture into `jobs/reminderBatch.rabbit.js`, and never copy a header name/value into the quarantine
record or a log — `tests/reminderServiceAuthority.p5.test.js`, `tests/reminderLegacyQuarantine.p5.test.js`
and `tests/reminderExplicitAck.rabbit.it.test.js` pin this.
