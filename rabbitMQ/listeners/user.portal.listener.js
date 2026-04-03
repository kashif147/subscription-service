const User = require("../../models/user.model");
const { setOnInsertSyncedUserId } = require("../../helpers/syncedUserDocumentId");

function deriveFullName(userFullName, userFirstName, userLastName) {
  if (userFullName != null && String(userFullName).trim() !== "") {
    return String(userFullName).trim();
  }
  const parts = [userFirstName, userLastName].filter(Boolean).map((s) => String(s).trim());
  return parts.length ? parts.join(" ") : null;
}

/**
 * Sync portal user into subscription-service User collection (same events as profile-service).
 */
async function handlePortalUserCreated(payload) {
  const { data } = payload;
  const {
    userId,
    userEmail,
    userFullName,
    userFirstName,
    userLastName,
    tenantId,
  } = data || {};

  if (!userId || !tenantId) {
    console.warn(
      "Invalid Portal user created event: missing userId or tenantId",
      payload
    );
    return;
  }

  try {
    const fullName = deriveFullName(
      userFullName,
      userFirstName,
      userLastName
    );
    const setOnInsert = setOnInsertSyncedUserId(userId);
    await User.findOneAndUpdate(
      { tenantId, userId },
      {
        $set: {
          userId,
          userEmail: userEmail || null,
          userFullName: fullName,
          tenantId,
        },
        ...(setOnInsert ? { $setOnInsert: setOnInsert } : {}),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    console.log(
      `✅ Portal user created/updated in subscription-service: ${userId} (${userEmail})`
    );
  } catch (error) {
    console.error(
      "❌ Error handling Portal user created event:",
      error.message,
      { userId, tenantId }
    );
    throw error;
  }
}

async function handlePortalUserUpdated(payload) {
  const { data } = payload;
  const {
    userId,
    userEmail,
    userFullName,
    userFirstName,
    userLastName,
    tenantId,
  } = data || {};

  if (!userId || !tenantId) {
    console.warn(
      "Invalid Portal user updated event: missing userId or tenantId",
      payload
    );
    return;
  }

  try {
    const fullName = deriveFullName(
      userFullName,
      userFirstName,
      userLastName
    );
    const setOnInsert = setOnInsertSyncedUserId(userId);
    await User.findOneAndUpdate(
      { tenantId, userId },
      {
        $set: {
          userId,
          tenantId,
          userEmail: userEmail || null,
          userFullName: fullName,
          updatedAt: new Date(),
        },
        ...(setOnInsert ? { $setOnInsert: setOnInsert } : {}),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    console.log(
      `✅ Portal user updated in subscription-service: ${userId} (${userEmail})`
    );
  } catch (error) {
    console.error(
      "❌ Error handling Portal user updated event:",
      error.message,
      { userId, tenantId }
    );
    throw error;
  }
}

module.exports = {
  handlePortalUserCreated,
  handlePortalUserUpdated,
};
