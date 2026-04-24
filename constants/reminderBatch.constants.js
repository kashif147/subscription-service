/**
 * Membership categories excluded from reminder / cancellation batches (free / non-paying).
 * Match profile/subscription `membershipCategory` strings case-insensitively where possible.
 */
exports.REMINDER_BATCH_EXCLUDED_MEMBERSHIP_CATEGORIES = [
  "undergraduate students",
  "honorary",
];

/**
 * Floor (cents) when category annual fee is unknown (no row in fee map).
 */
exports.REMINDER_BATCH_MIN_BALANCE_CENTS = 1;

/**
 * Days in the pro-rata formula: min balance ≈ (annualFee/this) × REMINDER_BATCH_DELINQUENCY_DAYS.
 * Also: calendar days since last receipt for delinquency when a receipt exists.
 */
exports.REMINDER_BATCH_DELINQUENCY_DAYS = 90;

/** Max memberIds per account-service bulk eligibility call. */
exports.REMINDER_BATCH_ELIGIBILITY_CHUNK = 1000;

/** Subscriptions (and execute members) processed per async worker chunk / internal page. */
exports.REMINDER_BATCH_BUILD_EXECUTE_CHUNK_SIZE = 500;
