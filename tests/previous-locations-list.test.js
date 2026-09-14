const assert = require("assert");
const createUIHelpers = require("../lib/helpers-ui");

const ui = createUIHelpers({
  MOOD_CATALOG: {},
  PUBLIC_URL: "https://example.com",
});
const reply = ui.getPreviousLocationsListReply([
  "12 Ogoja Rd, Abakaliki",
  "8 Nkaliki Road, Abakaliki",
]);

assert.ok(reply && reply.type === "interactive");
assert.strictEqual(reply.interactive.type, "list");
assert.strictEqual(reply.interactive.body.text, "Choose a delivery location");
assert.strictEqual(
  reply.interactive.action.sections[0].rows[0].id,
  "prev_location_0",
);
assert.strictEqual(
  reply.interactive.action.sections[0].rows[0].title,
  "12 Ogoja Rd, Abakaliki",
);
assert.strictEqual(
  reply.interactive.action.sections[0].rows[0].description,
  "Use this address",
);
assert.strictEqual(
  reply.interactive.action.sections[0].rows[2].id,
  "new_address",
);

console.log("previous locations UI checks passed");
