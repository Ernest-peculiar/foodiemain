const assert = require("assert");
const {
  hasMenuContent,
  shouldProcessIncomingWebhookMessage,
} = require("../lib/utils");

assert.strictEqual(hasMenuContent({ menu: "Rice & Beans - 1500" }), true);
assert.strictEqual(hasMenuContent({ menu_items: [{ name: "Plantain" }] }), true);
assert.strictEqual(hasMenuContent({ menu: "" }), false);
assert.strictEqual(hasMenuContent({ menu_items: [] }), false);

const seen = new Map();
assert.strictEqual(
  shouldProcessIncomingWebhookMessage({ id: "wa-msg-1" }, seen),
  true,
);
assert.strictEqual(
  shouldProcessIncomingWebhookMessage({ id: "wa-msg-1" }, seen),
  false,
);
assert.strictEqual(
  shouldProcessIncomingWebhookMessage({ id: "wa-msg-2" }, seen),
  true,
);

console.log("menu and webhook dedupe checks passed");
