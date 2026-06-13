const { PAYMENT_TYPE, PAYMENT_FREQUENCY } = require("../constants/enums");

function normalizeCategoryKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isNoFeeMembershipCategory(membershipCategory) {
  const key = normalizeCategoryKey(membershipCategory);
  if (!key) return false;
  if (key === "honorary" || /\bhonorary\b/.test(key)) return true;
  return (
    key.includes("undergraduate") &&
    key.includes("student") &&
    !key.includes("postgraduate")
  );
}

function resolveNoFeePaymentFields({ membershipCategory, paymentType, paymentFrequency }) {
  if (!isNoFeeMembershipCategory(membershipCategory)) {
    return { paymentType, paymentFrequency };
  }

  return {
    paymentType: PAYMENT_TYPE.CASH,
    paymentFrequency: PAYMENT_FREQUENCY.ANNUALLY,
  };
}

module.exports = {
  isNoFeeMembershipCategory,
  resolveNoFeePaymentFields,
};
