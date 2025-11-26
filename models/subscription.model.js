const mongoose = require("mongoose");
const {
  PAYMENT_TYPE,
  PAYMENT_FREQUENCY,
  USER_TYPE,
  MEMBERSHIP_STATUS,
  REMINDER_TYPE,
  YEAREND_RESULT,
  MEMBERSHIP_MOVEMENT,
} = require("../constants/enums");

const SubscriptionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: false,
      index: true,
    },
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "profiles",
      required: true,
      index: true,
    },
    applicationId: { type: String, default: null }, // need to decide if i want to keep it null for yearend renewal?

    subscriptionYear: { type: Number, required: true, index: true }, // NEW: yearly version of a subscription
    isCurrent: { type: Boolean, default: true, index: true }, // NEW: only one subscription can be current
    subscriptionStatus: {
      type: String,
      enum: Object.values(MEMBERSHIP_STATUS),
      default: MEMBERSHIP_STATUS.ACTIVE,
      index: true,
    },
    // Lifecycle timestamps
    startDate: { type: Date, required: true }, // Start Date of a subscription
    endDate: { type: Date, required: true }, // End Date of membership year
    rolloverDate: { type: Date, default: null }, // Date of rollover to the next year

    // Cancellation workflow
    cancellation: {
      dateCancelled: Date, // Date of cancellation
      reason: String, // Reason for cancellation
      gracePeriodEnd: Date, // Date of the end of the grace period dateCancelled + 28 days
      reinstated: { type: Boolean, default: false }, // True if the subscription is reinstated
    },
    // Resignation workflow
    resignation: {
      dateResigned: Date, // Date of resignation
      reason: String, // Reason for resignation
    },
    // Reminder workflow
    reminders: [
      {
        type: { type: String, enum: Object.values(REMINDER_TYPE) },
        reminderDate: Date, // Date of the reminder
      },
    ],
    // Year-end processing
    yearend: {
      processed: { type: Boolean, default: false }, // True if the year-end processing is done
      processedAt: Date, // Date of the year-end processing
      result: { type: String, enum: Object.values(YEAREND_RESULT) }, // Result of the year-end processing
    },
    // Rejoin / Reinstate classification
    membershipMovement: {
      type: String,
      enum: Object.values(MEMBERSHIP_MOVEMENT),
      default: MEMBERSHIP_MOVEMENT.NEW_JOIN,
    },
    // Member application/Subscription details
    membershipCategory: { type: String, allowNull: true },
    paymentType: {
      type: String,
      enum: Object.values(PAYMENT_TYPE),
      default: PAYMENT_TYPE.PAYROLL_DEDUCTION,
    },
    payrollNo: { type: String, allowNull: true },
    paymentFrequency: {
      type: String,
      enum: Object.values(PAYMENT_FREQUENCY),
      default: PAYMENT_FREQUENCY.MONTHLY,
    },

    meta: {
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "users" },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "users" },
    },
    deleted: { type: Boolean, default: false },
    // isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
// Very important for performance:
SubscriptionSchema.index(
  { tenantId: 1, profileId: 1, isCurrent: 1 },
  { unique: false }
);
module.exports = mongoose.model("subscriptionDetails", SubscriptionSchema);
