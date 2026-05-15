# Reminder & cancellation batches — how it works and how the seed data maps to R1 / R2 / R3 / CANCEL

This document explains **why** a member appears on each tab (R1, R2, R3, or cancellation), which systems hold the data, and how to use the **seed script** that loads **staging** MongoDB using `subscription-service/.env.staging` → `MONGO_URI`.

---

## 1. Systems involved

| System | Role |
|--------|------|
| **subscription-service** | CRM APIs: create batch, **build** (classify + write `reminderbatchmembers`), **execute** (update `subscription.reminders` / cancel + Rabbit events). |
| **profile-service** | `Profile.membershipNumber` is the **ledger member id** used when calling account-service for eligibility. |
| **account-service** | **Source of truth for money**: `MaterializedBalance` (1400 arrears/current) and `GLTransaction` (last Receipt with member credit on 1400/2020) feed `getReminderEligibilitySnapshot`. |

Build is **not** subscription-only: it always calls **profile** (batch by `profileId`) and **account** (bulk eligibility by `membershipNumber`). If ledger rows are missing, members are treated as **not delinquent** and appear **excluded** (`included: false`).

---

## 2. Financial delinquency (who is even eligible)

Implemented in `helpers/reminderBatchTier.js` → `isFinanciallyDelinquent`.

Roughly:

1. **1400 debt**: `net1400ArrearsCents + net1400CurrentCents` must be at least a **minimum** amount. The minimum is **pro‑rated** from the member’s **annual fee** for the **current UTC calendar year** (see `getReminderMinBalanceCentsForCalendarYear`); if the category has no fee row, a **floor** applies (`REMINDER_BATCH_MIN_BALANCE_CENTS`, typically 1 cent).
2. **Receipt age**: If there is a **last receipt** GL date on 1400/2020, calendar days from that date to the batch **`balanceAsOf`** must be **≥ `REMINDER_BATCH_DELINQUENCY_DAYS`** (90). If there is **no** qualifying receipt, delinquency can still pass on **balance alone** (see code path).

Members in excluded categories (e.g. strings matching configured free categories) are skipped at build.

---

## 3. Calendar-year anchor (critical for R2 / R3 / CANCEL)

When a **new** batch is built, `beginBuildReminderBatch` resolves **`prevExecuteAt`** from the **latest completed batch of the same kind** whose `executeCompletedAt` falls in the **same UTC calendar year as `balanceAsOf`** (`services/reminderBatch.service.js` — `findPreviousCompletedBatchInCalendarYear` / `isExecuteCompletedInUtcCalendarYear`).

Implications:

- A completed run from **last year** does **not** anchor April this year — the first run of the year can produce a **clean R1** list again.
- The seed script therefore creates **completed** “prior” batches with `executeCompletedAt` **inside the current UTC year** so R2/R3/CANCEL examples stay valid when you run build **today**.

The snapshot stored on each member row includes `reminderTierAnchorAt` (ISO of that anchor) for audit.

---

## 4. “Payment after last batch” exclusion

If the member’s **last receipt** GL date is **after** `prevExecuteAt`, they are treated as having paid since the last run → **not placed** in R1/R2/R3/CANCEL for that build (`paymentAfterPreviousBatch`).

The seed data avoids inserting receipts so this path stays **off** unless you add GL rows yourself.

---

## 5. Reminder batch (kind `REMINDER`) — R1, R2, R3

Once financially delinquent and not excluded by receipt timing, `classifyMaxReminderTier` picks the **highest** applicable step:

| Tier | Meaning (pipeline view) | Typical subscription state |
|------|-------------------------|------------------------------|
| **R1** | First notice step | `reminders.reminder1At` is **null** (no R1 sent yet). |
| **R2** | Second notice step | `reminder1At` is set, **`reminder1At` < anchor**, `reminder2At` is **null**. |
| **R3** | Third notice step | `reminder2At` is set, **`reminder2At` < anchor**, `reminder3At` is **null**. |

Anyone who **already** has `reminder3At` set is **not** placed on the reminder batch — they move to the **cancellation** batch logic instead.

Anchor = `prevExecuteAt` from §3 (latest completed **REMINDER** execute in the same UTC year, or the batch linked via `previousReminderBatchId` when valid for that year).

---

## 6. Cancellation batch (kind `CANCELLATION`) — CANCEL tier

`classifyCancellationTier` is only for members who already completed the R3 step:

- Must have **`reminder3At`** set (R3 already “sent” in the past).
- **`reminder3At` < anchor**, where anchor is `prevExecuteAt` for **prior completed CANCELLATION** batches in the **same UTC year** (or `null` anchor on the first cancellation run of the year — then eligible CANCEL members still match via the `anchor == null` branch).

Execute of a cancellation batch then **cancels** the subscription immediately (status, `cancellation`, Rabbit `SUBSCRIPTION_CANCELLED`, etc.) — that is separate from the **nightly** portal demotion job.

---

## 7. Seed script — what it creates

Script: `scripts/seed-reminder-batch-test-data.js`

- Reads **`MONGO_URI`** from `backend/subscription-service/.env.staging`.
- Opens the **same cluster** DBs: `Subscription-Service`, `Profile-Service`, `account-service` (database segment swapped in the URI).
- **Tenant**: `SEED_TENANT_ID` or default `seed-reminder-batch-test-tenant`.
- **Cleans** prior seed rows for that tenant (batches, members, subscriptions, profiles, materialized balances for those profiles’ `membershipNumber`s).

It inserts:

1. **Four profiles** with distinct `membershipNumber`s (`SEEDRB…R1`, `…R2`, `…R3`, `…CX`) and emails under `*.test.local`.
2. **Large 1400 arrears** `MaterializedBalance` rows (no receipts) so all four are **financially delinquent** for build.
3. **Completed REMINDER** batch in **January** of the current UTC year (`executeCompletedAt` = anchor for R2/R3).
4. **Completed CANCELLATION** batch in **February** of the current UTC year (anchor for CANCEL tier).
5. **Four active subscriptions** (`membershipCategory` = `Staff Nurse`, not in free/excluded categories) with `reminders` shaped as:
   - **R1 row**: no reminder timestamps.
   - **R2 row**: `reminder1At` before January anchor, no R2/R3.
   - **R3 row**: `reminder1At` / `reminder2At` before anchor, no R3.
   - **CANCEL row**: R1/R2/R3 all set, `reminder3At` before February cancellation anchor.
6. **Draft REMINDER** batch with `previousReminderBatchId` pointing at the completed January reminder batch.
7. **Draft CANCELLATION** batch with `previousCancellationBatchId` pointing at the completed February cancellation batch.

After seeding, use CRM (or Postman) against **subscription-service**:

1. `POST /api/v1/reminder-batches/:draftReminderBatchId/build` — expect **three included** members at tiers **R1, R2, R3**, and the fourth member **excluded** (`included: false`) because they already have **R3** on the subscription (they belong on the **cancellation** batch next). The exclusion reason stored today is often `NOT_DELINQUENT` whenever `classifyMaxReminderTier` returns no tier — treat that as “no tier for this batch”, not literally “not in debt”.
2. `POST /api/v1/reminder-batches/:draftCancellationBatchId/build` — expect the fourth member as **CANCEL** (and others excluded or not delinquent depending on state after any prior execute).

> **Note:** If `RABBIT_URL` is set, build/execute may be **queued on RabbitMQ**; poll `GET …/:batchId` until `status` is `ready` / `completed` and inspect `buildProgress` / `executeProgress`.

---

## 8. Commands

From repository root:

```bash
export SEED_TENANT_ID=seed-reminder-batch-test-tenant   # optional
node backend/subscription-service/scripts/seed-reminder-batch-test-data.js
```

Cleanup only:

```bash
SEED_TENANT_ID=seed-reminder-batch-test-tenant \
node backend/subscription-service/scripts/seed-reminder-batch-test-data.js --cleanup
```

npm shortcut (if added to `package.json`):

```bash
npm run seed:reminder-batch-test --prefix backend/subscription-service
```

---

## 9. Security

- The seed script loads **real** credentials from `.env.staging`. **Never commit** secrets; rotate if this file is shared.
- Staging writes affect **shared** databases — use a dedicated `SEED_TENANT_ID` if multiple people seed.

---

## 10. Quick reference — files

| Topic | Location |
|--------|-----------|
| Tier rules | `helpers/reminderBatchTier.js` |
| Build / execute | `services/reminderBatch.service.js` |
| Eligibility snapshot | `account-service/src/services/reminderEligibilityRead.service.js` |
| Constants (90 days, chunk sizes) | `constants/reminderBatch.constants.js` |
| Seed script | `scripts/seed-reminder-batch-test-data.js` |
