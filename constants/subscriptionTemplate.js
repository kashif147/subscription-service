/** Filter operators (same shape as profile-service application templates) */
exports.FILTER_OPERATOR = {
  EQUAL_TO: "equal_to",
  NOT_EQUAL_TO: "not_equal_to",
};

/**
 * Map filter keys (camelCase) to Subscription collection paths.
 * v1: subscription document fields only (no profile-only fields).
 */
exports.SUBSCRIPTION_FILTER_FIELD_MAP = {
  subscriptionStatus: { path: "subscriptionStatus" },
  isCurrent: { path: "isCurrent", type: "boolean" },
  membershipCategory: { path: "membershipCategory" },
  paymentType: { path: "paymentType" },
  paymentFrequency: { path: "paymentFrequency" },
  applicationId: { path: "applicationId" },
  profileId: { path: "profileId", type: "objectId" },
  subscriptionYear: { path: "subscriptionYear", type: "number" },
  userId: { path: "userId" },
  membershipMovement: { path: "membershipMovement" },
};

exports.ALLOWED_SUBSCRIPTION_FILTER_KEYS = Object.keys(
  exports.SUBSCRIPTION_FILTER_FIELD_MAP
);

/** Dot-path allowlist for column projection on enriched subscription list items */
exports.SUBSCRIPTION_RESPONSE_COLUMNS = [
  "_id",
  "profileId",
  "applicationId",
  "tenantId",
  "subscriptionYear",
  "isCurrent",
  "subscriptionStatus",
  "startDate",
  "endDate",
  "membershipCategory",
  "paymentType",
  "payrollNo",
  "paymentFrequency",
  "membershipMovement",
  "rolloverDate",
  "cancellation",
  "resignation",
  "reminders",
  "yearend",
  "createdAt",
  "updatedAt",
  "deleted",
  "user.userEmail",
  "user.userFullName",
  "lastModifiedBy",
  "lastModifiedAt",
  "personalDetails.fullName",
  "personalDetails.membershipNo",
  "personalDetails.mobileNo",
  "personalDetails.dateOfBirth",
  "personalDetails.gender",
  "personalDetails.fullAddress",
  "personalDetails.notAtThisAddress",
  "professionalDetails.workLocation",
  "professionalDetails.branch",
  "professionalDetails.region",
  "professionalDetails.grade",
  "professionalDetails.primarySection",
  "professionalDetails.secondarySection",
  "professionalDetails.nmbiNumber",
  "professionalDetails.retiredDate",
  "professionalDetails.pensionNumber",
  "professionalDetails.speciality",
  "preferences.consent",
  "preferences.incomeProtection",
  "preferences.inmoRewards",
  "preferences.partnerConsent",
  "additionalInfo.anotherUnionMember",
  "additionalInfo.otherUnionName",
  "additionalInfo.submissionDate",
  "financialDetails.lastPaymentAmount",
  "financialDetails.lastPaymentDate",
  "financialDetails.membershipFee",
  "financialDetails.outstandingBalance",
];
