const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const setupWebhookRoutes = require("../lib/routes-webhooks");

const secret = "sk_test_webhook";

function createWebhook(handler) {
  let webhookHandler;
  setupWebhookRoutes(
    {
      get() {},
      post(path, callback) {
        if (path === "/webhook/paystack") webhookHandler = callback;
      },
    },
    {
      crypto,
      PAYSTACK_SECRET_KEY: secret,
      handlePaystackChargeSuccess: handler,
      supabase: { test: "supabase" },
      ORDER_NOTIFY_NUMBER: "2348000000000",
      getVendorPrepTimeButtonsReply: () => ({ type: "interactive" }),
    },
  );

  return async (event) => {
    const rawBody = Buffer.from(JSON.stringify(event));
    const signature = crypto
      .createHmac("sha512", secret)
      .update(rawBody)
      .digest("hex");
    const response = {
      statusCode: null,
      sendStatus(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
    };

    await webhookHandler(
      {
        body: event,
        rawBody,
        headers: { "x-paystack-signature": signature },
      },
      response,
    );

    return response.statusCode;
  };
}

test("verified Paystack charge.success webhook processes payment before acknowledging", async () => {
  const calls = [];
  const webhook = createWebhook(async (...args) => calls.push(args));
  const event = {
    event: "charge.success",
    data: { reference: "order-1", status: "success" },
  };

  assert.equal(await webhook(event), 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], event.data);
  assert.deepEqual(calls[0][1], { test: "supabase" });
  assert.equal(calls[0][2], "2348000000000");
  assert.equal(typeof calls[0][3], "function");
});

test("verified non-success Paystack events are acknowledged without processing", async () => {
  let processed = false;
  const webhook = createWebhook(async () => {
    processed = true;
  });

  assert.equal(
    await webhook({
      event: "charge.success",
      data: { reference: "order-1", status: "failed" },
    }),
    200,
  );
  assert.equal(processed, false);
});

test("Paystack webhook processing errors return 500 so Paystack can retry", async () => {
  const originalError = console.error;
  console.error = () => {};
  const webhook = createWebhook(async () => {
    throw new Error("database unavailable");
  });

  try {
    assert.equal(
      await webhook({
        event: "charge.success",
        data: { reference: "order-1", status: "success" },
      }),
      500,
    );
  } finally {
    console.error = originalError;
  }
});
