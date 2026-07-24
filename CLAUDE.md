# CLAUDE.md

`subscription-service` owns the membership subscription lifecycle: yearly subscription
records, membership-movement classification (new join / rejoin / reinstate / renewed),
reminder batches (arrears delinquency escalation → R1/R2/R3 → cancellation), and year-end
renewal batches (archive/suspend/renew the whole membership base for a fiscal year). It
does not create the first subscription itself — that's driven by profile-service's
post-approval RabbitMQ events (see `subscription-creation-and-rabbitmq.md`).

**`README.md` is detailed, accurate, and current for the reminder-batch subsystem
specifically** (API contract, auth requirements, enums, RabbitMQ async flow, environment
variables) — read it before touching anything under `reminderBatch.*`/`ReminderBatch`. It
does not cover the rest of the service (core subscription CRUD, renewal/year-end batches,
the lifecycle jobs), which is what the topic files below cover instead.

## Commands

```bash
npm start                              # node ./bin/subscription-service
npm run dev                             # nodemon
npm test                                 # node --test tests/*.test.js — NOT jest, uses Node's built-in test runner
node --test tests/renewalBatch.test.js   # run a single test file
npm run seed:subscription-template       # scripts/seed-subscription-system-default-template.js
npm run seed:reminder-batch-test         # scripts/seed-reminder-batch-test-data.js — see docs/reminder-batch-test-data-and-process.md
npm run sync:reporting-snapshots         # scripts/publish-reporting-snapshots.js — backfill reporting-service
npm run audit:subs-without-invoice       # scripts/audit-active-subs-without-invoice.js
```

### Subscription model
@.claude/rules/subscription-model.md

### Subscription creation and RabbitMQ
@.claude/rules/subscription-creation-and-rabbitmq.md

### Batch subsystems (reminder batches vs. renewal/year-end batches)
@.claude/rules/batch-subsystems.md

### Lifecycle jobs (self-scheduling, single-instance)
@.claude/rules/lifecycle-jobs.md

### Auth
@.claude/rules/auth.md
