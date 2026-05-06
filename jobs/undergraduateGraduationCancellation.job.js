const {
  runUndergraduateGraduationCancellationOnce,
} = require("../services/undergraduateGraduationCancellation.service.js");

let jobTimer = null;
let jobTimeout = null;

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

function parseCronScheduleEnv() {
  const raw =
    process.env.UGRAD_GRADUATION_CRON_SCHEDULE ||
    process.env.CRON_SCHEDULE ||
    "";
  const s = String(raw).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":");
    return {
      hourUtc: Math.min(23, Math.max(0, parseInt(h, 10) || 0)),
      minuteUtc: Math.min(59, Math.max(0, parseInt(m, 10) || 0)),
    };
  }
  return null;
}

function startUndergraduateGraduationCancellationJob() {
  if (jobTimer || jobTimeout) return;

  if (process.env.UGRAD_GRADUATION_JOB_ENABLED === "false") {
    console.warn(
      "⚠️ [UGRAD_GRADUATION] disabled via UGRAD_GRADUATION_JOB_ENABLED=false"
    );
    return;
  }

  if (!process.env.RABBIT_URL || !process.env.RABBIT_URL.trim()) {
    console.warn("⚠️ [UGRAD_GRADUATION] RABBIT_URL not set; job not started");
    return;
  }

  const fromSchedule = parseCronScheduleEnv();
  const hourUtc = fromSchedule
    ? fromSchedule.hourUtc
    : Math.min(
        23,
        Math.max(
          0,
          parseInt(
            process.env.UGRAD_GRADUATION_CRON_HOUR_UTC ||
              process.env.CRON_HOUR_UTC ||
              "2",
            10
          ) || 2
        )
      );
  const minuteUtc = fromSchedule
    ? fromSchedule.minuteUtc
    : Math.min(
        59,
        Math.max(
          0,
          parseInt(
            process.env.UGRAD_GRADUATION_CRON_MINUTE_UTC ||
              process.env.CRON_MINUTE_UTC ||
              "0",
            10
          ) || 0
        )
      );

  const intervalMs = parseInt(
    process.env.UGRAD_GRADUATION_INTERVAL_MS || "",
    10
  );

  if (intervalMs >= 60_000) {
    console.log(
      `🕐 [UGRAD_GRADUATION] interval mode every ${intervalMs}ms (testing)`
    );
    jobTimer = setInterval(() => {
      runUndergraduateGraduationCancellationOnce().catch((err) =>
        console.error("[UGRAD_GRADUATION] interval error:", err.message)
      );
    }, intervalMs);
    setTimeout(() => {
      runUndergraduateGraduationCancellationOnce().catch((err) =>
        console.error("[UGRAD_GRADUATION] initial run error:", err.message)
      );
    }, 15_000);
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextUtcRun(hourUtc, minuteUtc);
    console.log(
      `🕐 [UGRAD_GRADUATION] next run in ${Math.round(
        delay / 1000 / 60
      )} min (UTC ${hourUtc}:${String(minuteUtc).padStart(2, "0")} daily)`
    );
    jobTimeout = setTimeout(async () => {
      jobTimeout = null;
      try {
        await runUndergraduateGraduationCancellationOnce();
      } catch (err) {
        console.error("[UGRAD_GRADUATION] run error:", err.message);
      }
      jobTimer = setInterval(() => {
        runUndergraduateGraduationCancellationOnce().catch((e) =>
          console.error("[UGRAD_GRADUATION] interval error:", e.message)
        );
      }, 24 * 60 * 60 * 1000);
    }, delay);
  };

  scheduleNext();
}

function stopUndergraduateGraduationCancellationJob() {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
  if (jobTimeout) {
    clearTimeout(jobTimeout);
    jobTimeout = null;
  }
}

module.exports = {
  startUndergraduateGraduationCancellationJob,
  stopUndergraduateGraduationCancellationJob,
  runUndergraduateGraduationCancellationOnce,
};
