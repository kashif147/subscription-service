# Two batch subsystems — similar shape, different naming, different progress UX

## Reminder batches

`ReminderBatch`/`ReminderBatchMember`, `/api/v1/reminder-batches` — fully documented in
`README.md`, read that before touching anything under `reminderBatch.*`/`ReminderBatch`.

Delinquency rule is `arrears_balance_plus_receipt_age_v1`: a **1400 arrears balance vs. a
pro-rata minimum** (~90 days of annual fee) from account-service — not a simple "days since
last payment" gate. Build calls account-service's internal bulk-eligibility endpoint;
execute applies reminder timestamps or runs cancellation batch side-effects. Progress is
**poll-based** (`GET /:batchId`, `buildProgress`/`executeProgress` fields).

## Renewal / year-end batches

The **route/controller are named "renewal batch"** (`routes/renewalBatch.routes.js`,
`controllers/renewalBatch.controller.js`, `services/renewalBatch.service.js`) but **the
underlying Mongo model is `YearEndBatch`** (`models/yearEndBatch.model.js` /
`yearEndBatchMember.model.js`, collection `yearend_batches`). Don't go looking for a
`RenewalBatch` model — it doesn't exist under that name.

This is the year-end sweep that archives/suspends/renews the whole membership base for a
`fiscalYear`. `assertProcessableFiscalYear()` only allows processing fiscal years up to
*last* calendar year — you cannot year-end the currently-open year.

Progress is pushed via **Server-Sent Events** (`lib/renewalBatch.sse.js`,
`emitRenewalBatchEvent`) rather than polling — a different UX pattern from reminder
batches, so don't reuse a reminder-batch progress-bar component here without adapting it
to SSE.

Note: `profile-service`'s `Profile.renewalBatchId` field also references a `"YearEndBatch"`
model by name — that's this model, but Mongoose refs don't resolve cross-service/
cross-database, so that field is documentation-only over there, not a working
`.populate()` target.

## `jobs/` naming trap

`jobs/reminderBatch.rabbit.js` and `jobs/renewalBatch.rabbit.js` are **not scheduled jobs**
despite living in `jobs/` — they're just RabbitMQ publish helpers for the build/execute/
orchestrate HTTP endpoints (queuing work when `RABBIT_URL` is set, vs. running
synchronously in-process when it isn't). The actually-scheduled, self-triggering jobs are
listed in `lifecycle-jobs.md`.
