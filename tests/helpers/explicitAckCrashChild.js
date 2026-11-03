// Child process for reminderExplicitAck.rabbit.it.test.js: runs the REAL reminder consumer registration
// against a disposable broker, with the quarantine write stubbed to never complete. It prints
// IN_HANDLER once a delivery reaches the quarantine step; the parent then SIGKILLs this process, i.e. a
// crash BEFORE quarantine persistence.
const { init } = require("@projectShell/rabbitmq-middleware");
const ReminderJobQuarantine = require("../../models/reminderJobQuarantine.model");
const listener = require("../../rabbitMQ/listeners/reminderBatch.listener");

ReminderJobQuarantine.findOneAndUpdate = () => ({
  lean: () => {
    process.stdout.write("IN_HANDLER\n");
    return new Promise(() => {}); // persistence never completes
  },
});

(async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  await init({ url: process.env.REMINDER_IT_RABBIT_URL, logger: quiet, maxReconnectAttempts: 0 });
  await listener.registerReminderBatchConsumers();
  process.stdout.write("READY\n");
})().catch((e) => {
  process.stderr.write(`child failed: ${e.name}\n`);
  process.exit(2);
});
