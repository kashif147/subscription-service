# Subscription model

## Year-versioned, not a single mutable row per member

`models/subscription.model.js`: each membership year gets its own `Subscription` document
(`subscriptionYear`, `isCurrent: true` on exactly one per `{tenantId, profileId}`), not one
row updated in place.

`membershipMovement` (`NEW_JOIN`/`REJOIN_CANCELLED`/`REJOIN_RESIGNED`/
`REINSTATE_SUSPENDED`/`REINSTATE_ARCHIVED`/`RENEWED`) plus `previousSubscriptionId`/
`previousMembershipStatus` classify how this year's row relates to the member's last one.
`helpers/membershipMovementResolver.js` is the single place that derives this from the
prior subscription's status — reporting-service's movement-analytics breakdowns are built
from this exact field, so don't add a new "how a subscription started" concept without
updating that resolver.

## `reminders` vs `reminderHistory` — not interchangeable

`reminders` (batch pipeline state — R1/R2/R3 timestamps, batch refs, `clearedAt`/
`clearedReason`) is distinct from the legacy `reminderHistory` array. The key was
deliberately renamed to free `reminders` for the newer object shape — check which field a
given document actually has before reading reminder state; don't assume old and new
documents use the same key.
