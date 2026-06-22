const reminderBatchRabbit = require("../jobs/reminderBatch.rabbit.js");
const reminderBatchService = require("../services/reminderBatch.service");

/**
 * Queue or run reminder-batch build (same behaviour as POST /:batchId/build).
 * @returns {Promise<{ queued: boolean, transport: string, batch?: object }>}
 */
async function runOrQueueReminderBatchBuild(req, batchId) {
  if (reminderBatchRabbit.isRabbitConfigured()) {
    await reminderBatchRabbit.publishReminderBuildRequested(req, batchId);
    return { queued: true, transport: "rabbitmq" };
  }
  const batch = await reminderBatchService.buildReminderBatch(req, batchId);
  return { queued: false, transport: "sync", batch };
}

module.exports = {
  runOrQueueReminderBatchBuild,
};
