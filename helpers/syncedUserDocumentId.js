const mongoose = require("mongoose");

function syncedUserObjectId(userId) {
  const s = userId != null ? String(userId) : "";
  if (s && mongoose.Types.ObjectId.isValid(s)) {
    return new mongoose.Types.ObjectId(s);
  }
  return null;
}

function setOnInsertSyncedUserId(userId) {
  const oid = syncedUserObjectId(userId);
  return oid ? { _id: oid } : null;
}

module.exports = { syncedUserObjectId, setOnInsertSyncedUserId };
