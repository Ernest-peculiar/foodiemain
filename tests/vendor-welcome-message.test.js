const assert = require("assert");
const { buildVendorWelcomeMessage } = require("../lib/utils");

const message = buildVendorWelcomeMessage("Mama Kitchen", [
  { name: "Rice & Beans", price: 1500 },
  { name: "Plantain", price: 900 },
]);

assert.strictEqual(message.type, "text");
assert.match(message.body, /Welcome to Foodie/i);
assert.match(message.body, /Mama Kitchen/i);
assert.match(message.body, /menu/i);
assert.match(message.body, /open/i);
assert.match(message.body, /close/i);

console.log("vendor welcome message test passed");
