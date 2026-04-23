/**
 * Side-effect requires so all Mongoose models register before first query.
 * Import this once after DB connect (see app.js).
 */
require("./user.model");
require("./template.model");
require("./subscription.model");
require("./reminderBatch.model");
require("./reminderBatchMember.model");
require("./yearEndBatch.model");
require("./yearEndBatchMember.model");
