# Lifecycle jobs — self-scheduling, single-instance only

`app.js` starts four self-scheduling jobs — `cancellationGraceSweep`,
`postgraduateStudentCategoryRenewalJob`, `undergraduateGraduationCancellationJob`, and
`lifecycleBatchScheduler` — **inside the `if (process.env.RABBIT_URL)` block**, chained
after `setupConsumers()` resolves. None of these are themselves fundamentally RabbitMQ
operations (they're time-based sweeps: grace-period expiry → portal role demotion,
postgraduate/undergraduate category auto-renewal/cancellation, monthly reminder/
cancellation batch auto-build) — but they silently don't run at all in an environment
without `RABBIT_URL` configured.

There's no separate enable/disable flag for them (unlike reporting-service's
`ENABLE_REPORTING_CRON`). Replacement for running one standalone (e.g. local testing
without RabbitMQ): invoke its exported `run*Once()` function directly rather than relying
on `app.js`'s wiring.

**Single-instance assumption**: these are plain in-process schedulers with no leader
election. Running multiple instances of this service means every instance runs every
sweep redundantly — there is no coordination to prevent duplicate execution. This is the
concrete instance the platform-wide `single-instance-assumptions.md` rule points at for
this service.
