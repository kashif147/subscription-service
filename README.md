# subscription-service

## Reminder eligibility rule v1

Default rule id: **`arrears_balance_plus_receipt_age_v1`** (`constants/enums.js` → `REMINDER_BATCH_RULE_VERSION_DEFAULT`). The string is unchanged so existing batch snapshots stay comparable; rule behaviour is **1400 balance vs pro‑rata minimum** (~90 days of annual fee). **Receipt age alone no longer clears delinquency** while balance remains above the threshold. **Payment after last batch execute** still excludes a member for that build.

- **Calendar days:** `REMINDER_BATCH_DELINQUENCY_DAYS` (90) is used only in the **pro‑rata minimum balance** formula, not as a standalone receipt-age gate.
- **Debt:** use **1400 `arrears`** materialized balance from account-service; combine with subscription/fee rules in the batch builder.
- **Allocation (posting):** member receipts apply **arrears → current → advance**; refunds reverse **advance → 1400** (see account-service).

---

## Reminder batches (CRM API)

Base path: **`/api/v1/reminder-batches`**.

**Staging test data & tier rules:** see [`docs/reminder-batch-test-data-and-process.md`](docs/reminder-batch-test-data-and-process.md) and run `npm run seed:reminder-batch-test` (uses `.env.staging` → `MONGO_URI`).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Create batch header and **automatically start build** (queue or sync, same as `POST /:batchId/build`) |
| `GET` | `/` | List batches (paginated) |
| `GET` | `/:batchId` | Get one batch header |
| `GET` | `/:batchId/members` | List batch members (paginated) |
| `POST` | `/:batchId/build` | Compute members + tiers; calls account internal bulk eligibility |
| `POST` | `/:batchId/execute` | Apply reminder timestamps or cancellation batch side-effects |

### Authentication

All reminder-batch routes use `ensureAuthenticated` (see `middlewares/auth.mw.js`):

1. **Gateway (production):** `x-jwt-verified: true`, `x-auth-source: gateway`, plus `x-user-id`, `x-tenant-id`, `x-user-type`, `x-user-email`, `x-user-roles`, `x-user-permissions` (and gateway validation as configured). **`x-user-type` must be `CRM`** or the controller returns 403.
2. **Direct service / local:** `Authorization: Bearer <JWT>` where the JWT payload includes **`userType: "CRM"`** (and `tenantId` / `tid` so `req.tenantId` is set). Optionally pass **`x-tenant-id`** if not embedded in the token.

### Request bodies

**`POST /`** (create)

| Field | Required | Notes |
|--------|----------|--------|
| `name` | Yes | Display name |
| `kind` | Yes | `REMINDER` or `CANCELLATION` (`REMINDER_BATCH_KIND`) |
| `batchDate` | Yes | ISO date/time |
| `referencePeriod` | No | e.g. accounting month label |
| `previousReminderBatchId` | No | Mongo ObjectId string; when omitted for `REMINDER`, last completed reminder batch of the tenant may be inferred for “payment between batches” logic |

After the batch document is created (`draft`), the service **immediately** runs or queues build. With **no** `RABBIT_URL`, the HTTP response is **`201`** with status **`ready`** and populated `countsByTier`. With RabbitMQ, the response is **`201`** with status **`pending_build`** and `buildQueued: true`; poll `GET /:batchId` until **`ready`** or **`failed`**.

**`POST /:batchId/build`** remains available to **rebuild** a batch (`draft`, `failed`, or `pending_build`).

**`GET /`** query: `kind`, `status`, `page`, `limit` (max 100).

**`GET /:batchId/members`** query: `tier` (`R1` \| `R2` \| `R3` \| `CANCEL`), `included` (`true` \| `false`), `page`, `limit` (max 200).

**`POST /:batchId/build`** — no body. Allowed statuses: `draft`, `failed`, `pending_build`. Sets `balanceAsOf`, writes **`reminderbatchmembers`**, then sets batch to **`ready`**.

**`POST /:batchId/execute`** — no body. Batch must be **`ready`**. Idempotent when status is already **`completed`**.

**`POST /monthly-orchestrate`** — JSON body: **`cancellationBatchId`**, **`reminderBatchId`**. Runs **cancellation execute** to **`completed`**, then **reminder build** to **`ready`** (same tenant as JWT). With **`RABBIT_URL`**, work is queued via RabbitMQ events and the HTTP response is queued metadata; poll the two batch documents for status. Without RabbitMQ, the same steps run synchronously in-process and the response is the final reminder batch header.

### RabbitMQ async processing

`POST /:batchId/build`, `POST /:batchId/execute`, and `POST /monthly-orchestrate` publish membership events when `RABBIT_URL` is configured. `subscription-service` consumers process those events asynchronously and update batch progress/status in Mongo.

RabbitMQ remains the channel for **`SUBSCRIPTION_CANCELLED`**, **`SUBSCRIPTION_CANCEL_GRACE_ENDED`**, and **`publishSubscriptionCurrentUpdated`** after Mongo writes.

Batch documents expose **`buildProgress`** / **`executeProgress`** (`totalMembersEstimated`, `chunksTotal`, `chunksCompleted`, `lastError`).

**React progress bar:** `GET /reminder-batches/:batchId` on an interval (e.g. 2–5s) while status is **`pending_build`** or **`executing`**, and bind a bar to `buildProgress.chunksCompleted / buildProgress.chunksTotal` (or the execute fields). Stop polling when status is terminal (`ready`, **`completed`**, **`failed`**).

### Enums (headers / stored values)

- **`kind`:** `REMINDER`, `CANCELLATION`
- **`status`:** `draft`, `pending_build`, `ready`, `executing`, `completed`, `failed`, `superseded`
- **Member `tier`:** `R1`, `R2`, `R3`, `CANCEL`

### Subscription document updates (execute)

- **Reminder batch:** sets `reminders.reminder1At` / `reminder2At` / `reminder3At` as applicable; **`reminders.lastReminderBatchId`** → batch id.
- **Cancellation batch:** cancels subscription, sets **`reminders.reminderCancellationBatchId`**, `cancellation`, publishes `SUBSCRIPTION_CANCELLED` where applicable.

**Subscription document shape:** **`reminderHistory`** — optional `{ type, reminderDate }[]` (older-style reminder log). **`reminders`** — batch pipeline object: `reminder1At`, `reminder2At`, `reminder3At`, `lastReminderBatchId`, cancellation-related fields, `clearedAt`, `clearedReason`.

### Environment (subscription-service → account-service)

| Variable | Purpose |
|----------|---------|
| `ACCOUNT_SERVICE_URL` | Account API base (no trailing slash) |
| `ACCOUNTS_API_KEY` | Sent as `x-api-key` on internal calls; must match account-service |

Build uses **`POST {ACCOUNT_SERVICE_URL}/api/internal/members/reminder-eligibility-bulk`**.

### MongoDB collections

| Collection | Model |
|------------|--------|
| `reminderbatches` | `ReminderBatch` |
| `reminderbatchmembers` | `ReminderBatchMember` |

### Cron / enforcement

Cancellation batch execute sets `cancellation` + 28-day `gracePeriodEnd` (same shape as manual CRM cancel). **`cancellationGraceSweep`** publishes **`SUBSCRIPTION_CANCEL_GRACE_ENDED`** when grace has ended, **`portalRoleDemotionPublishedAt`** is still unset, and **`isCancelledSubscriptionEligibleForPortalDemotion`** passes (`helpers/portalRoleDemotionEligibility.js` — extend later for product “unpaid” rules).

### Not implemented yet

Full communication-service email/SMS/letter delivery workers (in-app notifications are sent via `MEMBER_NOTIFICATION_REQUESTED` from reminder batch comms and DD unpaid handlers). Dedicated audit events. CRM detail pages still use mock member data for batch drill-down (list API is wired).

### Frontend (CRA)

Use `getSubscriptionServiceBaseUrl()` from `ProjectShell-1/src/config/serviceUrls.js` (**`REACT_APP_SUBSCRIPTION_SERVICE_URL`**, fallback **`REACT_APP_SUBSCRIPTION`**). Reminder batch API path suffix: **`/reminder-batches`**. Account CRM URL: **`REACT_APP_ACCOUNT_SERVICE_URL`**.

---

## Postman

| File | Contents |
|------|----------|
| **`postman-collection.json`** | Full subscription-service API, including folder **Reminder batches (CRM)** |
| **`reminder-batches.postman_collection.json`** | **Standalone import:** reminder-batch CRM calls + account-service **internal** reminder eligibility (set both `subscriptionBaseUrl` and `accountBaseUrl`) |

Account-service-only internal samples are also under **`../account-service/postman-collection.json`** → folder **Internal — reminder eligibility**.
