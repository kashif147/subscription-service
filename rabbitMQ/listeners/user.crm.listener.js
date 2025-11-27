const User = require("../../models/user.model");

/**
 * Handle CRM user created event
 */
async function handleCrmUserCreated(payload) {
  const { data } = payload;
  const { userId, userEmail, userFullName, tenantId } = data;

  if (!userId || !tenantId) {
    console.warn(
      "Invalid CRM user created event: missing userId or tenantId",
      payload
    );
    return;
  }

  try {
    await User.findOneAndUpdate(
      { tenantId, userId },
      {
        userId,
        userEmail: userEmail || null,
        userFullName: userFullName || null,
        tenantId,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    console.log(
      `✅ CRM user created/updated in subscription-service: ${userId} (${userEmail})`
    );
  } catch (error) {
    console.error(
      "❌ Error handling CRM user created event:",
      error.message,
      { userId, tenantId }
    );
    throw error;
  }
}

/**
 * Handle CRM user updated event
 */
async function handleCrmUserUpdated(payload) {
  const { data } = payload;
  const { userId, userEmail, userFullName, tenantId } = data;

  if (!userId || !tenantId) {
    console.warn(
      "Invalid CRM user updated event: missing userId or tenantId",
      payload
    );
    return;
  }

  try {
    await User.findOneAndUpdate(
      { tenantId, userId },
      {
        userEmail: userEmail || null,
        userFullName: userFullName || null,
        updatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    console.log(
      `✅ CRM user updated in subscription-service: ${userId} (${userEmail})`
    );
  } catch (error) {
    console.error(
      "❌ Error handling CRM user updated event:",
      error.message,
      { userId, tenantId }
    );
    throw error;
  }
}

module.exports = {
  handleCrmUserCreated,
  handleCrmUserUpdated,
};



