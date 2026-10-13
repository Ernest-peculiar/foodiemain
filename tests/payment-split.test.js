const test = require("node:test");
const assert = require("node:assert/strict");
const createPaymentHandlers = require("../lib/payment");

function createHandlers() {
  return createPaymentHandlers({
    DELIVERY_FEE: 500,
    PAYSTACK_SECRET_KEY: "test-secret",
    PUBLIC_URL: "https://example.com",
  });
}

test("customer payment gross-up covers the standard local Paystack fee", () => {
  const handlers = createHandlers();

  assert.deepEqual(handlers.calculateCustomerPayment(2500), {
    processingFee: 140,
    total: 2640,
  });
});

test("customer payment gross-up respects Paystack's local fee cap", () => {
  const handlers = createHandlers();

  assert.deepEqual(handlers.calculateCustomerPayment(200000), {
    processingFee: 2000,
    total: 202000,
  });
});

test("Paystack transaction allocates food to the restaurant and fees to the platform", async () => {
  const handlers = createHandlers();
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: true,
        data: { authorization_url: "https://pay" },
      }),
    };
  };

  try {
    await handlers.createPaystackTransaction(
      "buyer@example.com",
      2640,
      "order-1",
      { subaccount: "ACCT_restaurant", platformShare: 640 },
    );
    assert.equal(requestBody.amount, 264000);
    assert.equal(requestBody.subaccount, "ACCT_restaurant");
    assert.equal(requestBody.transaction_charge, 64000);
    assert.equal(requestBody.bearer, "account");
  } finally {
    global.fetch = originalFetch;
  }
});