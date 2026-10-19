const test = require("node:test");
const assert = require("node:assert/strict");
const createPaymentHandlers = require("../lib/payment");
const { hashDeliveryCode } = require("../lib/tracking");

function createHandlers(secretKey = "sk_live_fake") {
  return createPaymentHandlers({
    DELIVERY_FEE: 500,
    PAYSTACK_SECRET_KEY: secretKey,
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

test("Paystack test mode creates a payment link without live subaccount splits", async () => {
  const handlers = createHandlers("sk_test_fake");
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
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
    const payment = await handlers.createPaystackTransaction(
      "buyer@example.com",
      2640,
      "order-1",
      { subaccount: "ACCT_live_restaurant", platformShare: 640 },
    );

    assert.equal(payment.authorization_url, "https://pay");
    assert.equal(handlers.isPaystackTestMode, true);
    assert.equal("subaccount" in requestBody, false);
    assert.equal("transaction_charge" in requestBody, false);
    assert.equal("bearer" in requestBody, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("text and image receipts include every order item and the correct subtotal", () => {
  const handlers = createHandlers();
  const receiptData = {
    orderId: "order-1",
    vendorName: "Foodie Kitchen",
    items: [
      { title: "Jollof Rice", qty: 2, price: 2500 },
      { title: "Fried Plantain", qty: 1, price: 800 },
    ],
    subtotal: 5800,
    total: 6440,
    processingFee: 140,
    address: "1 Foodie Street",
    reference: "pay-1",
    paidAt: "2026-10-19T12:00:00.000Z",
  };

  const textReceipt = handlers.buildReceiptText(receiptData);
  const imageReceipt = handlers.buildReceiptSVG(receiptData);

  assert.match(textReceipt, /2 x Jollof Rice/);
  assert.match(textReceipt, /1 x Fried Plantain/);
  assert.match(textReceipt, /Items subtotal: ₦5,800/);
  assert.match(imageReceipt, /ITEM 1: JOLLOF RICE/);
  assert.match(imageReceipt, /ITEM 2: FRIED PLANTAIN/);
  assert.match(imageReceipt, /Items subtotal/i);
  assert.match(imageReceipt, /₦5,800/);
});

test("payment success sends a delivery code and stores only its hash", async () => {
  const sentMessages = [];
  const order = {
    id: "order-1",
    customer_phone: "2348098765432",
    customer_name: "Customer",
    restaurant_name: "Foodie Kitchen",
    items: [
      { title: "Jollof Rice", qty: 1, price: 2500 },
      { title: "Fried Plantain", qty: 1, price: 800 },
    ],
    subtotal: 3300,
    total: 3940,
    payment_processing_fee: 140,
    delivery_address: "1 Foodie Street",
    payment_status: "unpaid",
    vendor_id: null,
  };
  let paymentUpdate;
  const supabase = {
    from(table) {
      assert.equal(table, "orders");
      let mode = "select";
      return {
        select() {
          mode = "select";
          return this;
        },
        update(values) {
          mode = "update";
          paymentUpdate = values;
          return this;
        },
        eq() {
          return mode === "update"
            ? Promise.resolve({ error: null })
            : this;
        },
        async maybeSingle() {
          return { data: order, error: null };
        },
      };
    },
  };
  const handlers = createPaymentHandlers({
    DELIVERY_FEE: 500,
    PAYSTACK_SECRET_KEY: "sk_live_fake",
    PUBLIC_URL: "https://example.com",
    sendWhatsAppMessage: async (...args) => sentMessages.push(args),
    saveProfile: async () => {},
  });
  const originalLog = console.log;
  console.log = () => {};

  try {
    await handlers.handlePaystackChargeSuccess(
      { reference: "order-1" },
      supabase,
      null,
      () => ({ type: "interactive" }),
    );
  } finally {
    console.log = originalLog;
  }

  const codeMessage = sentMessages.find(
    ([phone, message]) =>
      phone === order.customer_phone &&
      message.body?.includes("delivery confirmation code"),
  );
  const code = codeMessage?.[1].body.match(/\*(\d{6})\*/)?.[1];
  assert.ok(codeMessage);
  assert.match(code, /^\d{6}$/);
  assert.equal(paymentUpdate.delivery_code_hash, hashDeliveryCode(code));
  assert.equal(paymentUpdate.delivery_code_attempts, 0);
  assert.equal(paymentUpdate.delivery_code_hash.includes(code), false);
  const customerReceipt = sentMessages.find(
    ([phone, message]) =>
      phone === order.customer_phone &&
      message.type === "text" &&
      message.body?.includes("*Receipt*"),
  );
  assert.match(customerReceipt[1].body, /Jollof Rice/);
  assert.match(customerReceipt[1].body, /Fried Plantain/);
  assert.match(customerReceipt[1].body, /Items subtotal: ₦3,300/);
});