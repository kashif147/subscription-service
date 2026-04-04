const mongoose = require("mongoose");
const {
  FILTER_OPERATOR,
  SUBSCRIPTION_FILTER_FIELD_MAP,
} = require("../constants/subscriptionTemplate");
const {
  MEMBERSHIP_STATUS,
  PAYMENT_TYPE,
  PAYMENT_FREQUENCY,
  MEMBERSHIP_MOVEMENT,
} = require("../constants/enums");

function resolveFilterKey(key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  return Object.keys(SUBSCRIPTION_FILTER_FIELD_MAP).find(
    (x) => x.toLowerCase() === k
  );
}

function matchEnumValue(input, enumObj) {
  const normalized = String(input).trim().toLowerCase();
  for (const v of Object.values(enumObj)) {
    if (String(v).toLowerCase() === normalized) {
      return v;
    }
  }
  return String(input).trim();
}

function coerceBooleanValues(values) {
  return values.map((v) => {
    const s = String(v).trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    return Boolean(v);
  });
}

/**
 * Build Mongo query on Subscription collection from template filters.
 * @param {Record<string, { operator: string, values: string[] }>} filters
 * @param {string} tenantId
 */
function buildSubscriptionMongoQueryFromTemplateFilters(filters, tenantId) {
  const query = {
    deleted: { $ne: true },
    tenantId,
  };

  for (const [filterKey, filterEntry] of Object.entries(filters || {})) {
    if (
      !filterEntry ||
      !filterEntry.values ||
      filterEntry.values.length === 0
    ) {
      continue;
    }

    const resolvedKey = resolveFilterKey(filterKey);
    if (!resolvedKey) continue;

    const config = SUBSCRIPTION_FILTER_FIELD_MAP[resolvedKey];
    const path = config.path;
    const op =
      filterEntry.operator === FILTER_OPERATOR.EQUAL_TO ? "$in" : "$nin";

    let values = filterEntry.values.map((v) =>
      typeof v === "string" ? v.trim() : v
    );

    if (config.type === "boolean") {
      const bools = coerceBooleanValues(values);
      query[path] = { [op]: bools };
      continue;
    }

    if (config.type === "objectId") {
      const ids = values
        .filter((v) => mongoose.Types.ObjectId.isValid(String(v)))
        .map((v) => new mongoose.Types.ObjectId(String(v)));
      if (ids.length === 0) continue;
      query[path] = { [op]: ids };
      continue;
    }

    if (config.type === "number") {
      const nums = values
        .map((v) => parseInt(String(v), 10))
        .filter((n) => !Number.isNaN(n));
      if (nums.length === 0) continue;
      query[path] = { [op]: nums };
      continue;
    }

    if (resolvedKey === "subscriptionStatus") {
      const mapped = values.map((v) => matchEnumValue(v, MEMBERSHIP_STATUS));
      query[path] = { [op]: mapped };
      continue;
    }
    if (resolvedKey === "paymentType") {
      const mapped = values.map((v) => matchEnumValue(v, PAYMENT_TYPE));
      query[path] = { [op]: mapped };
      continue;
    }
    if (resolvedKey === "paymentFrequency") {
      const mapped = values.map((v) => matchEnumValue(v, PAYMENT_FREQUENCY));
      query[path] = { [op]: mapped };
      continue;
    }
    if (resolvedKey === "membershipMovement") {
      const mapped = values.map((v) => matchEnumValue(v, MEMBERSHIP_MOVEMENT));
      query[path] = { [op]: mapped };
      continue;
    }

    query[path] = { [op]: values.map((v) => String(v)) };
  }

  return query;
}

/**
 * Project enriched subscription object by ordered dot-path columns.
 * Empty columns returns full object.
 */
function filterByColumns(obj, columns) {
  if (!columns || columns.length === 0) {
    return obj;
  }

  const result = {};

  columns.forEach((column) => {
    const parts = column.split(".");
    let current = obj;
    let resultCurrent = result;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (i === parts.length - 1) {
        if (current && current[part] !== undefined) {
          resultCurrent[part] = current[part];
        }
      } else {
        if (current && current[part] !== undefined) {
          if (!resultCurrent[part]) {
            resultCurrent[part] = {};
          }
          current = current[part];
          resultCurrent = resultCurrent[part];
        } else {
          break;
        }
      }
    }
  });

  const orderedTopKeys = [];
  for (const column of columns) {
    const topKey = column.split(".")[0];
    if (topKey && !orderedTopKeys.includes(topKey)) {
      orderedTopKeys.push(topKey);
    }
  }
  const orderedResult = {};
  for (const key of orderedTopKeys) {
    if (result[key] !== undefined) {
      orderedResult[key] = result[key];
    }
  }
  return orderedResult;
}

module.exports = {
  buildSubscriptionMongoQueryFromTemplateFilters,
  filterByColumns,
};
