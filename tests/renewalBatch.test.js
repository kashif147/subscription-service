const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  RENEWAL_BATCH_STATUS,
  RENEWAL_BATCH_MEMBER_ACTION,
} = require("../constants/enums");
const { AppError } = require("../errors/AppError");

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
