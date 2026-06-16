// Application Status Enums
exports.APPLICATION_STATUS = {
  IN_PROGRESS: "in-progress",
  SUBMITTED: "submitted",
  PROCESSED: "processed",
  REJECTED: "rejected",
};

// Preferred Address Enums
exports.PREFERRED_ADDRESS = {
  HOME: "home",
  WORK: "work",
};

// User Type Enums
exports.USER_TYPE = {
  CRM: "CRM",
  PORTAL: "PORTAL",
};

// Preferred Email Enums
exports.PREFERRED_EMAIL = {
  PERSONAL: "personal",
  WORK: "work",
};

// Payment Type Enums
exports.PAYMENT_TYPE = {
  PAYROLL_DEDUCTION: "Salary Deduction",
  DIRECT_DEBIT: "Direct Debit",
  CARD_PAYMENT: "Credit Card",
  SBO_PAYMENT: "Standing Order",
  CHEQUE: "Cheque",
  CASH: "Cash",
};

// Payment Frequency Enums
exports.PAYMENT_FREQUENCY = {
  WEEKLY: "Weekly",
  FORTNIGHTLY: "Fortnightly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUALLY: "Annually",
};

exports.MEMBERSHIP_STATUS = {
  ACTIVE: "Active",
  RESIGNED: "Resigned",
  CANCELLED: "Cancelled",
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
  RENEWED: "Renewed",
  LAPSED: "Lapsed",
};

// Reminder Type Enums
exports.REMINDER_TYPE = {
  R1: "R1",
  R2: "R2",
  R3: "R3",
};

// Year-end Processing Result Enums
exports.YEAREND_RESULT = {
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
  RENEWED: "Renewed",
};

// Membership Movement Enums
exports.MEMBERSHIP_MOVEMENT = {
  NEW_JOIN: "NewJoin",
  REJOIN: "Rejoin",
  REINSTATE: "Reinstate",
  RENEWED: "Renewed",
};

/** Reminder batch header kind (includes dedicated cancellation batch runs) */
exports.REMINDER_BATCH_KIND = {
  REMINDER: "REMINDER",
  CANCELLATION: "CANCELLATION",
};

/** Year-end renewal batch lifecycle (separate from reminder batch status) */
exports.RENEWAL_BATCH_STATUS = {
  DRAFT: "DRAFT",
  READY: "READY",
  QUEUED: "QUEUED",
  INPROGRESS: "INPROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

/** Snapshot row: which pipeline step applies to this member */
exports.RENEWAL_BATCH_MEMBER_ACTION = {
  ARCHIVE: "ARCHIVE",
  SUSPEND: "SUSPEND",
  RENEW: "RENEW",
};

/** Reminder batch lifecycle */
exports.REMINDER_BATCH_STATUS = {
  DRAFT: "draft",
  PENDING_BUILD: "pending_build",
  READY: "ready",
  EXECUTING: "executing",
  COMPLETED: "completed",
  FAILED: "failed",
  SUPERSEDED: "superseded",
};

/** Tier within a reminder batch tab, or cancellation list */
exports.REMINDER_BATCH_TIER = {
  R1: "R1",
  R2: "R2",
  R3: "R3",
  CANCEL: "CANCEL",
};

/** Why a member was excluded from the send list (audit / non-errors) */
exports.REMINDER_BATCH_EXCLUSION_REASON = {
  FREE_CATEGORY: "FREE_CATEGORY",
  STATUS_EXCLUDED: "STATUS_EXCLUDED",
  PAYMENT_IN_WINDOW: "PAYMENT_IN_WINDOW",
  NOT_DELINQUENT: "NOT_DELINQUENT",
  TIER_GATE: "TIER_GATE",
  CANCELLATION_SCHEDULED: "CANCELLATION_SCHEDULED",
  OTHER: "OTHER",
};

/** What initiated cancellation grace / enforcement */
exports.CANCELLATION_SOURCE = {
  ARREARS: "ARREARS",
  MANUAL: "MANUAL",
  SYSTEM: "SYSTEM",
};

/**
 * Default eligibility rule id for reminder batch snapshots (unchanged string for historical rows).
 * Calendar days between lastReceiptGlDate and balanceAsOf; see subscription-service README.
 */
exports.REMINDER_BATCH_RULE_VERSION_DEFAULT =
  "arrears_balance_plus_receipt_age_v1";
