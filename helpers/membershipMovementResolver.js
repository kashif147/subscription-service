const { MEMBERSHIP_STATUS, MEMBERSHIP_MOVEMENT } = require("../constants/enums");

function normalizeStatus(value) {
  return value == null || value === "" ? null : String(value).trim();
}

function resolveMembershipMovement(previousSubscription) {
  const status = normalizeStatus(previousSubscription?.subscriptionStatus);
  if (!previousSubscription || !status) {
    return {
      membershipMovement: MEMBERSHIP_MOVEMENT.NEW_JOIN,
      previousSubscriptionId: null,
      previousMembershipStatus: null,
    };
  }

  const previousSubscriptionId = previousSubscription._id || null;
  const base = {
    previousSubscriptionId,
    previousMembershipStatus: status,
  };

  if (status === MEMBERSHIP_STATUS.CANCELLED) {
    return {
      ...base,
      membershipMovement: MEMBERSHIP_MOVEMENT.REJOIN_CANCELLED,
    };
  }
  if (status === MEMBERSHIP_STATUS.RESIGNED) {
    return {
      ...base,
      membershipMovement: MEMBERSHIP_MOVEMENT.REJOIN_RESIGNED,
    };
  }
  if (status === MEMBERSHIP_STATUS.SUSPENDED) {
    return {
      ...base,
      membershipMovement: MEMBERSHIP_MOVEMENT.REINSTATE_SUSPENDED,
    };
  }
  if (status === MEMBERSHIP_STATUS.ARCHIVED) {
    return {
      ...base,
      membershipMovement: MEMBERSHIP_MOVEMENT.REINSTATE_ARCHIVED,
    };
  }

  return {
    ...base,
    membershipMovement: MEMBERSHIP_MOVEMENT.NEW_JOIN,
  };
}

function isValidMembershipMovement(value) {
  return Object.values(MEMBERSHIP_MOVEMENT).includes(value);
}

module.exports = {
  resolveMembershipMovement,
  isValidMembershipMovement,
};
