const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  RENEWAL_BATCH_STATUS,
  RENEWAL_BATCH_MEMBER_ACTION,
} = require("../constants/enums");
const { AppError } = require("../errors/AppError");
const {
  getPositive1400WriteOffBuckets,
} = require("../helpers/serviceClient");

describe("RENEWAL_BATCH_STATUS", () => {
  it("exports distinct lifecycle values", () => {
    assert.equal(RENEWAL_BATCH_STATUS.DRAFT, "DRAFT");
    assert.equal(RENEWAL_BATCH_STATUS.READY, "READY");
    assert.equal(RENEWAL_BATCH_STATUS.QUEUED, "QUEUED");
    assert.equal(RENEWAL_BATCH_STATUS.INPROGRESS, "INPROGRESS");
    assert.equal(RENEWAL_BATCH_STATUS.COMPLETED, "COMPLETED");
    assert.equal(RENEWAL_BATCH_STATUS.FAILED, "FAILED");
  });
});

describe("RENEWAL_BATCH_MEMBER_ACTION", () => {
  it("exports pipeline actions", () => {
    assert.equal(RENEWAL_BATCH_MEMBER_ACTION.ARCHIVE, "ARCHIVE");
    assert.equal(RENEWAL_BATCH_MEMBER_ACTION.SUSPEND, "SUSPEND");
    assert.equal(RENEWAL_BATCH_MEMBER_ACTION.RENEW, "RENEW");
  });
});

describe("AppError", () => {
  it("conflict uses 409", () => {
    const e = AppError.conflict("busy");
    assert.equal(e.status, 409);
    assert.equal(e.code, "CONFLICT");
  });

  it("serviceUnavailable uses 503", () => {
    const e = AppError.serviceUnavailable("down");
    assert.equal(e.status, 503);
    assert.equal(e.code, "SERVICE_UNAVAILABLE");
  });
});

describe("getPositive1400WriteOffBuckets", () => {
  it("uses positive 1400 arrears and current bucket balances", () => {
    const buckets = getPositive1400WriteOffBuckets({
      buckets: [
        { accountCode: "1400", bucket: "arrears", amount: 12000 },
        { accountCode: "1400", bucket: "current", amount: 3000 },
        { accountCode: "2020", bucket: "advance", amount: -5000 },
        { accountCode: "1400", bucket: "advance", amount: 9000 },
      ],
    });

    assert.deepEqual(buckets, [
      { bucket: "arrears", amount: 12000 },
      { bucket: "current", amount: 3000 },
    ]);
  });

  it("falls back to positive 1400 account net when bucket rows are unavailable", () => {
    const buckets = getPositive1400WriteOffBuckets({
      accounts: [{ accountCode: "1400", amount: 2500 }],
      outstandingBalance: 1000,
    });

    assert.deepEqual(buckets, [{ bucket: "arrears", amount: 2500 }]);
  });
});
