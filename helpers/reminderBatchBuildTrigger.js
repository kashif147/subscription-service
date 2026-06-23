const reminderBatchRabbit = require("../jobs/reminderBatch.rabbit.js");
const reminderBatchService = require("../services/reminderBatch.service");

/**
 * Queue or run reminder-batch build (same behaviour as POST /:batchId/build).
 * @returns {Promise<{ queued: boolean, transport: string, batch?: object }>}
 */
async function runOrQueueReminderBatchBuild(req, batchId) {
  if (reminderBatchRabbit.isRabbitConfigured()) {
    const batch = await reminderBatchService.markReminderBatchBuildQueued(
      batchId,
      req.tenantId,
      req
    );
    try {
      await reminderBatchRabbit.publishReminderBuildRequested(req, batchId);
      return { queued: true, transport: "rabbitmq", batch };
    } catch (error) {
      await reminderBatchService.markBuildReminderBatchFailed(
        batchId,
        req.tenantId,
        error
      );
      throw error;
    }
  }
  const batch = await reminderBatchService.buildReminderBatch(req, batchId);
  return { queued: false, transport: "sync", batch };
}

module.exports = {
  runOrQueueReminderBatchBuild,
};
