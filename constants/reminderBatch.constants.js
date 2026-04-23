/**
 * Membership categories excluded from reminder / cancellation batches (free / non-paying).
 * Match profile/subscription `membershipCategory` strings case-insensitively where possible.
 */
exports.REMINDER_BATCH_EXCLUDED_MEMBERSHIP_CATEGORIES = [
  "undergraduate students",
  "honorary",
];

/** Minimum 1400 arrears bucket (cents) to treat as materially delinquent for Reminder 1. */
exports.REMINDER_BATCH_MIN_BALANCE_CENTS = 1;

/** Days since last Receipt before Reminder-1 style delinquency (calendar days). */
exports.REMINDER_BATCH_DELINQUENCY_DAYS = 90;

/** Max memberIds per account-service bulk eligibility call. */
exports.REMINDER_BATCH_ELIGIBILITY_CHUNK = 1000;

/** Subscriptions (and execute members) processed per async worker chunk / internal page. */
exports.REMINDER_BATCH_BUILD_EXECUTE_CHUNK_SIZE = 500;
