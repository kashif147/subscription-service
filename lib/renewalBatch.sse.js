const { EventEmitter } = require("events");

/** @type {Map<string, EventEmitter>} */
const emitters = new Map();

function emitterKey(batchId) {
  return String(batchId);
}

function getEmitter(batchId) {
  const key = emitterKey(batchId);
  if (!emitters.has(key)) emitters.set(key, new EventEmitter());
  return emitters.get(key);
}

/**
 * @param {import('mongoose').Types.ObjectId|string} batchId
 * @param {object} payload
 */
function emitRenewalBatchEvent(batchId, payload) {
  getEmitter(batchId).emit("update", {
    ...payload,
    at: new Date().toISOString(),
  });
}

/**
 * @param {import('mongoose').Types.ObjectId|string} batchId
 * @param {import('express').Response} res
 */
function attachRenewalBatchSse(batchId, res) {
  const emitter = getEmitter(batchId);
  const listener = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      /* client gone */
    }
  };
  emitter.on("update", listener);
  res.on("close", () => {
    emitter.off("update", listener);
  });
}

module.exports = {
  emitRenewalBatchEvent,
  attachRenewalBatchSse,
};
