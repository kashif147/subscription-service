const { randomUUID } = require("crypto");
const Subscription = require("../models/subscription.model");
const { MEMBERSHIP_STATUS } = require("../constants/enums");
const { publisher } = require("@projectShell/rabbitmq-middleware");
const { MEMBERSHIP_EVENTS } = require("../rabbitMQ/events");
const { fetchProfilesByIds } = require("../helpers/serviceClient");
const {
  serializeSubscriptionForAudit,
  publishSubscriptionChangedAudit,
} = require("../rabbitMQ/publishers/subscription.changed.audit.publisher.js");
const {
  publishSubscriptionCurrentUpdated,
} = require("../rabbitMQ/publishers/subscription.current.updated.publisher.js");

/** UTC start of calendar day for `d` */
function utcDayStartMs(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return Date.UTC(
    x.getUTCFullYear(),
    x.getUTCMonth(),
    x.getUTCDate(),
    0,
    0,
    0,
    0
  );
}

/** Join/start date + 1 calendar year (clamp day; noon UTC for consistency with upsert). */
function addOneCalendarYearUtcNoon(startDate) {
  const d = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear() + 1;
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const useDay = Math.min(day, lastDay);
  return new Date(Date.UTC(y, m, useDay, 12, 0, 0, 0));
}

function normalizeCategoryLabel(c) {
  if (c == null || c === "") return "";
  return String(c).trim().toLowerCase().replace(/\s+/g, " ");
}

function isPostgraduateCategory(raw, fromLabel) {
  const norm = normalizeCategoryLabel(raw);
  const fromNorm = normalizeCategoryLabel(fromLabel);
  return norm === fromNorm || norm === "postgraduate student";
}

/**
 * Nightly: move members from Postgraduate Student to General after join + 1 year.
 */
async function runPostgraduateStudentCategoryRenewalOnce() {
  const fromCategory =
    process.env.POSTGRAD_RENEWAL_FROM_CATEGORY || "Postgraduate Student";
  const toCategory =
    process.env.POSTGRAD_RENEWAL_TO_CATEGORY || "General (all grades)";

  const now = new Date();
  const todayStart = utcDayStartMs(now);
  if (todayStart == null) return { processed: 0 };

  const query = {
    isCurrent: true,
    deleted: { $ne: true },
    subscriptionStatus: MEMBERSHIP_STATUS.ACTIVE,
    startDate: { $exists: true, $ne: null },
  };

  const cursor = Subscription.find(query)
    .select(
      "_id tenantId profileId userId applicationId membershipCategory startDate endDate"
    )
    .cursor();

  let processed = 0;

  for await (const lean of cursor) {
    if (!isPostgraduateCategory(lean.membershipCategory, fromCategory)) {
      continue;
    }

    const renewalAt = addOneCalendarYearUtcNoon(lean.startDate);
    if (!renewalAt) {
      continue;
    }
    const renewalDayStart = utcDayStartMs(renewalAt);
    if (renewalDayStart == null || renewalDayStart > todayStart) {
      continue;
    }

    const doc = await Subscription.findOne({ _id: lean._id });
    if (!doc) continue;
    if (!isPostgraduateCategory(doc.membershipCategory, fromCategory)) continue;

    const renewalCheck = addOneCalendarYearUtcNoon(doc.startDate);
    const renewalCheckStart = renewalCheck ? utcDayStartMs(renewalCheck) : null;
    if (
      renewalCheckStart == null ||
      renewalCheckStart > todayStart
    ) {
      continue;
    }

    const beforePlain = serializeSubscriptionForAudit(doc);
    const prevCategory = doc.membershipCategory;
    const prevStartDate = doc.startDate;

    doc.membershipCategory = toCategory;
    await doc.save();

    const adjustmentKey = randomUUID();
    let memberId = null;
    let memberIdResolved = false;
    try {
      const profiles = await fetchProfilesByIds(
        [doc.profileId],
        doc.tenantId || undefined,
        { headers: {} },
        { relaxTenant: !doc.tenantId }
      );
      memberId = profiles[0]?.membershipNumber ?? null;
      memberIdResolved = !!(memberId && String(memberId).trim());
    } catch (e) {
      console.warn(
        "[POSTGRAD_CATEGORY_RENEWAL] profile fetch failed:",
        e.message
      );
    }

    try {
      const publishResult = await publisher.publish(
        MEMBERSHIP_EVENTS.SUBSCRIPTION_CATEGORY_CHANGED,
        {
          subscriptionId: doc._id.toString(),
          profileId: doc.profileId.toString(),
          tenantId: doc.tenantId || undefined,
          applicationId: doc.applicationId || null,
          memberId: memberIdResolved ? String(memberId).trim() : null,
          adjustmentKey,
          previousMembershipCategory: prevCategory ?? null,
          membershipCategory: doc.membershipCategory ?? null,
          previousStartDate: prevStartDate,
          subscriptionStartDate: doc.startDate,
          effectiveDate: renewalCheck.toISOString(),
          userId: doc.userId || null,
          actorUserId: null,
          actorEmail: null,
          source: "postgraduate_student_year_one_renewal",
        },
        {
          tenantId: doc.tenantId,
          exchange: "membership.events",
          routingKey: MEMBERSHIP_EVENTS.SUBSCRIPTION_CATEGORY_CHANGED,
          metadata: {
            service: "subscription-service",
            version: "1.0",
            job: "postgraduateStudentCategoryRenewal",
          },
        }
      );
      if (!publishResult.success) {
        console.error("[POSTGRAD_CATEGORY_RENEWAL] category.changed failed:", {
          error: publishResult.error,
          subscriptionId: doc._id.toString(),
        });
      }
    } catch (e) {
      console.error(
        "[POSTGRAD_CATEGORY_RENEWAL] category.changed publish error:",
        e.message
      );
    }

    try {
      await publishSubscriptionCurrentUpdated(doc, {
        applicationId: doc.applicationId,
        memberId: memberIdResolved ? String(memberId).trim() : null,
        membershipCategory: doc.membershipCategory,
        startDate: doc.startDate,
        userId: doc.userId || null,
        tenantId: doc.tenantId,
        correlationId: `postgrad-renewal-${adjustmentKey}`,
        skipMembershipApprovedNotification: true,
      });
    } catch (e) {
      console.error(
        "[POSTGRAD_CATEGORY_RENEWAL] current.updated publish error:",
        e.message
      );
    }

    try {
      await publishSubscriptionChangedAudit({
        tenantId: doc.tenantId,
        subscriptionId: doc._id.toString(),
        profileId: doc.profileId.toString(),
        applicationId: doc.applicationId || null,
        actorUserId: null,
        actorEmail: "system@postgraduate-category-renewal",
        changedFields: ["membershipCategory"],
        before: beforePlain,
        after: serializeSubscriptionForAudit(doc),
        correlationId: adjustmentKey,
      });
    } catch (e) {
      console.error(
        "[POSTGRAD_CATEGORY_RENEWAL] audit publish error:",
        e.message
      );
    }

    processed += 1;
    console.log("[POSTGRAD_CATEGORY_RENEWAL] updated subscription", {
      subscriptionId: doc._id.toString(),
      profileId: doc.profileId?.toString(),
    });
  }

  if (processed > 0) {
    console.log(
      `[POSTGRAD_CATEGORY_RENEWAL] completed: ${processed} subscription(s) updated`
    );
  }
  return { processed };
}

let renewalTimer = null;
let renewalTimeout = null;

function msUntilNextUtcRun(hourUtc, minuteUtc) {
  const now = Date.now();
  const t = new Date();
  let next = Date.UTC(
    t.getUTCFullYear(),
    t.getUTCMonth(),
    t.getUTCDate(),
    hourUtc,
    minuteUtc,
    0,
    0
  );
  if (next <= now) {
    next += 24 * 60 * 60 * 1000;
  }
  return next - now;
}

function startPostgraduateStudentCategoryRenewalJob() {
  if (renewalTimer || renewalTimeout) return;

  if (process.env.POSTGRAD_CATEGORY_RENEWAL_ENABLED === "false") {
    console.warn(
      "⚠️ [POSTGRAD_CATEGORY_RENEWAL] disabled via POSTGRAD_CATEGORY_RENEWAL_ENABLED=false"
    );
    return;
  }

  if (!process.env.RABBIT_URL || !process.env.RABBIT_URL.trim()) {
    console.warn(
      "⚠️ [POSTGRAD_CATEGORY_RENEWAL] RABBIT_URL not set; job not started"
    );
    return;
  }

  const hourUtc = Math.min(
    23,
    Math.max(
      0,
      parseInt(process.env.POSTGRAD_CATEGORY_RENEWAL_HOUR_UTC || "0", 10) || 0
    )
  );
  const minuteUtc =
    Math.min(
      59,
      Math.max(
        0,
        parseInt(process.env.POSTGRAD_CATEGORY_RENEWAL_MINUTE_UTC || "0", 10) ||
          0
      )
    ) || 0;

  const intervalMs = parseInt(
    process.env.POSTGRAD_CATEGORY_RENEWAL_INTERVAL_MS || "",
    10
  );

  if (intervalMs >= 60_000) {
    console.log(
      `🕐 [POSTGRAD_CATEGORY_RENEWAL] interval mode every ${intervalMs}ms`
    );
    renewalTimer = setInterval(() => {
      runPostgraduateStudentCategoryRenewalOnce().catch((err) =>
        console.error("[POSTGRAD_CATEGORY_RENEWAL] interval error:", err.message)
      );
    }, intervalMs);
    setTimeout(() => {
      runPostgraduateStudentCategoryRenewalOnce().catch((err) =>
        console.error("[POSTGRAD_CATEGORY_RENEWAL] initial run error:", err.message)
      );
    }, 15_000);
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextUtcRun(hourUtc, minuteUtc);
    console.log(
      `🕐 [POSTGRAD_CATEGORY_RENEWAL] next run in ${Math.round(delay / 1000 / 60)} min (UTC ${hourUtc}:${String(minuteUtc).padStart(2, "0")} daily)`
    );
    renewalTimeout = setTimeout(async () => {
      renewalTimeout = null;
      try {
        await runPostgraduateStudentCategoryRenewalOnce();
      } catch (err) {
        console.error("[POSTGRAD_CATEGORY_RENEWAL] run error:", err.message);
      }
      renewalTimer = setInterval(() => {
        runPostgraduateStudentCategoryRenewalOnce().catch((e) =>
          console.error("[POSTGRAD_CATEGORY_RENEWAL] interval error:", e.message)
        );
      }, 24 * 60 * 60 * 1000);
    }, delay);
  };

  scheduleNext();
}

function stopPostgraduateStudentCategoryRenewalJob() {
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
  if (renewalTimeout) {
    clearTimeout(renewalTimeout);
    renewalTimeout = null;
  }
}

module.exports = {
  startPostgraduateStudentCategoryRenewalJob,
  stopPostgraduateStudentCategoryRenewalJob,
  runPostgraduateStudentCategoryRenewalOnce,
};
