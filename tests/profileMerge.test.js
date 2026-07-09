const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveProfileMergeSubscriptionPlan,
} = require("../controllers/profileMerge.controller");

describe("resolveProfileMergeSubscriptionPlan", () => {
  it("keeps the master current subscription and closes only absorbed current rows", () => {
    const plan = resolveProfileMergeSubscriptionPlan({
      masterCurrent: { _id: "master-current" },
      absorbedSubs: [
        { _id: "absorbed-current", isCurrent: true },
        { _id: "absorbed-history", isCurrent: false },
      ],
    });

    assert.deepEqual(plan.absorbedCurrentIds, ["absorbed-current"]);
    assert.equal(plan.currentSubscriptionId, "master-current");
  });

  it("does not promote an absorbed current subscription when master has no current row", () => {
    const plan = resolveProfileMergeSubscriptionPlan({
      masterCurrent: null,
      absorbedSubs: [{ _id: "absorbed-current", isCurrent: true }],
    });

    assert.deepEqual(plan.absorbedCurrentIds, ["absorbed-current"]);
    assert.equal(plan.currentSubscriptionId, null);
  });
});
