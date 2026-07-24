# How a Subscription gets created, and the RabbitMQ surface around it

This service does not create the first subscription itself — that's driven by
profile-service's post-approval RabbitMQ events.

## Creation path

`rabbitMQ/listeners/subscription.upsert.listener.js` (bound to `membership.events`) is the
primary creation path, driven by `members.member.created.requested.v1` /
`members.subscription.upsert.requested.v1` — the events profile-service's
`publishPostApprovalEvents` publishes once a membership application is approved (see
profile-service's `CLAUDE.md`). It resolves whether the incoming line should be a genuinely
new subscription vs. an update to the existing `isCurrent` one
(`isLiveCurrentSubscription()` — a non-live status like resigned/cancelled/suspended/
archived/lapsed always forces a *new* subscription row rather than overwriting the dead
one), then calls `helpers/membershipMovementResolver.js` (see `subscription-model.md`).

Every current-subscription write that matters to other services must also trigger:
- `publishSubscriptionCurrentUpdated()` → `members.subscription.current.updated.v1`
- `publishReportingSnapshotForSubscription()` → `members.subscription.reporting.snapshot.v1`,
  consumed by reporting-service's membership warehouse (see that service's `CLAUDE.md`)

Any new code path that mutates a current subscription needs to call both publishers, not
just save the document — saving without publishing leaves reporting-service and other
consumers out of sync.

## RabbitMQ inbound/outbound inventory

Inbound:
- `user.events` — CRM/portal user created/updated, mirrored into the local `User` cache model
- `membership.events` — subscription upsert-requested (the creation path above), plus
  reminder-batch and renewal-batch async build/execute/orchestrate requests
- member-finance events (`rabbitMQ/listeners/memberFinance.listener.js`) — feed
  arrears-aware reminder eligibility

Outbound (`rabbitMQ/publishers/*.js`):
- subscription-current-updated
- a reporting-snapshot publisher for reporting-service
- a subscription-changed audit publisher
- `reminder.comms.requested.publisher.js` — in-app notification requests via
  `members.member.notification.requested.v1`. Actual email/SMS/letter delivery through
  communication-service is explicitly **not implemented yet** (see `README.md`'s "Not
  implemented yet" section) — don't assume a reminder batch execute sends an email, only
  that it can trigger an in-app notification.
