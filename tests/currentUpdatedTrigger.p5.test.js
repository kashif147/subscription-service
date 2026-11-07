// P5 identity: members.subscription.current.updated.v1 carries trusted trigger context so
// user-service can apply the application-approval MEMBER rule (pending -> no grant; verified
// applicant -> explicit id only) on this second grant path, and tell application-driven
// promotion apart from renewals / reinstatements without relying on a stored applicationId.
//  - origin: set by every publisher call site (the code path that published);
//  - applicantIdentity: passed through from the subscription upsert (profile-service approval).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { publisher } = require("@projectShell/rabbitmq-middleware");
const {
  publishSubscriptionCurrentUpdated,
  normalizeApplicantIdentity,
} = require("../rabbitMQ/publishers/subscription.current.updated.publisher.js");

const A = "68cbf7806080b4621d469d34";
const published = [];
publisher.publish = async (...args) => { published.push(args); return { success: true, eventId: "e1" }; };
const doc = { _id: "6a3333333333333333333333", profileId: "6a4444444444444444444444", startDate: new Date("2026-11-07T12:00:00Z"), tenantId: A, applicationId: "stored-app", userId: null };
const lastPayload = () => published[published.length - 1][1];

test("publisher: origin + applicantIdentity from ctx are emitted", async () => {
  published.length = 0;
  await publishSubscriptionCurrentUpdated(doc, {
    origin: "application_upsert",
    applicantIdentity: { source: "portal_submitter", verified: true, pending: "IDENTITY_LINK_PENDING", extra: "dropped" },
  });
  assert.strictEqual(lastPayload().origin, "application_upsert");
  assert.deepStrictEqual(lastPayload().applicantIdentity, { source: "portal_submitter", verified: true, pending: "IDENTITY_LINK_PENDING" });
});

test("publisher: absent ctx -> no origin / applicantIdentity fields (older shape unchanged)", async () => {
  published.length = 0;
  await publishSubscriptionCurrentUpdated(doc, {});
  assert.ok(!("origin" in lastPayload()));
  assert.ok(!("applicantIdentity" in lastPayload()));
  // the stored applicationId still flows as before; it is NOT a trigger marker
  assert.strictEqual(lastPayload().applicationId, "stored-app");
});

test("normalizeApplicantIdentity: non-objects -> null; pending kept; junk fields dropped", () => {
  for (const v of [null, undefined, "x", 1, true, []]) assert.strictEqual(normalizeApplicantIdentity(v), null);
  assert.deepStrictEqual(normalizeApplicantIdentity({ pending: "IDENTITY_LINK_PENDING" }), { source: null, verified: false, pending: "IDENTITY_LINK_PENDING" });
  assert.deepStrictEqual(normalizeApplicantIdentity({ source: "crm_created", verified: "yes", pending: "" }), { source: "crm_created", verified: false, pending: null });
});

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const CALLERS = {
  "controllers/subscription.controller.js": ["undo_resignation", "undo_cancellation"],
  "jobs/postgraduateStudentCategoryRenewal.job.js": ["postgrad_category_renewal"],
  "services/undergraduateGraduationCancellation.service.js": ["ug_graduation_cancellation"],
  "services/reminderBatch.service.js": ["reminder_batch", "reminder_batch"],
  "services/renewalBatch.service.js": ["renewal_batch"],
};

test("every non-upsert publisher call site passes its own non-application origin", () => {
  for (const [rel, origins] of Object.entries(CALLERS)) {
    const src = read(rel);
    const calls = src.split("publishSubscriptionCurrentUpdated(").slice(1).map((c) => c.slice(0, c.indexOf("});")));
    assert.strictEqual(calls.length, origins.length, `${rel}: publish call count`);
    calls.forEach((c, i) => assert.ok(c.includes(`origin: "${origins[i]}"`), `${rel} call ${i + 1} must pass origin ${origins[i]}`));
  }
});

test("no other module publishes current.updated", () => {
  const roots = ["controllers", "jobs", "services", "rabbitMQ", "helpers", "scripts", "routes"];
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js") && fs.readFileSync(p, "utf8").includes("publishSubscriptionCurrentUpdated(")) found.push(path.relative(path.join(__dirname, ".."), p));
    }
  };
  roots.forEach((r) => walk(path.join(__dirname, "..", r)));
  const expected = [...Object.keys(CALLERS), "rabbitMQ/listeners/subscription.upsert.listener.js", "rabbitMQ/publishers/subscription.current.updated.publisher.js"].sort();
  assert.deepStrictEqual(found.sort(), expected);
});

test("upsert listener: origin comes from the upsert event's applicationId; identity passed on both publishes", () => {
  const src = read("rabbitMQ/listeners/subscription.upsert.listener.js");
  assert.match(src, /applicantIdentity = null,/);
  assert.match(src, /const promotionOrigin =\s*applicationId != null && String\(applicationId\)\.trim\(\) !== ""\s*\? "application_upsert"\s*: "profile_upsert";/);
  const calls = src.split("await publishSubscriptionCurrentUpdatedEvent({").slice(1).map((c) => c.slice(0, c.indexOf("});")));
  assert.strictEqual(calls.length, 2);
  for (const c of calls) {
    assert.match(c, /origin: promotionOrigin,/);
    assert.match(c, /applicantIdentity,/);
  }
  const helper = src.slice(src.indexOf("async function publishSubscriptionCurrentUpdatedEvent"), src.indexOf("async function fetchProfileWithRetry"));
  assert.match(helper, /origin,\s*applicantIdentity,\s*\}\);/);
});
