const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashTrackingToken,
  createDeliveryTrackingTokens,
} = require("../lib/tracking");
const setupTrackingRoutes = require("../lib/routes-tracking");
const createDispatchHandlers = require("../lib/handlers-dispatch");

test("delivery tracking creates unique links and stores only token hashes", async () => {
  let savedRow;
  const supabase = {
    from(table) {
      assert.equal(table, "delivery_tracking");
      return {
        async upsert(row, options) {
          savedRow = row;
          assert.deepEqual(options, { onConflict: "order_id" });
          return { error: null };
        },
      };
    },
  };

  const tokens = await createDeliveryTrackingTokens(supabase, "order-1");
  assert.match(tokens.customerToken, /^[a-f0-9]{64}$/);
  assert.match(tokens.riderToken, /^[a-f0-9]{64}$/);
  assert.notEqual(tokens.customerToken, tokens.riderToken);
  assert.equal(savedRow.customer_token_hash, hashTrackingToken(tokens.customerToken));
  assert.equal(savedRow.rider_token_hash, hashTrackingToken(tokens.riderToken));
  assert.equal(JSON.stringify(savedRow).includes(tokens.customerToken), false);
  assert.equal(JSON.stringify(savedRow).includes(tokens.riderToken), false);
});

test("delivery tracking token creation reports database failures", async () => {
  const supabase = {
    from() {
      return {
        async upsert() {
          return { error: new Error("table missing") };
        },
      };
    },
  };

  await assert.rejects(
    createDeliveryTrackingTokens(supabase, "order-1"),
    /table missing/,
  );
});

test("tracking API rejects requests without bearer tokens", async () => {
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  };
  setupTrackingRoutes(app, { supabase: null, GEOAPIFY_API_KEY: null });

  const headers = {};
  const result = { statusCode: null, body: null };
  const res = {
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };

  await routes.get("GET /api/tracking")({ get: () => null }, res);

  assert.equal(result.statusCode, 401);
  assert.equal(headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(result.body.error, "A valid tracking token is required.");
});

test("driver assignment sends separate rider and customer tracking links", async () => {
  const sentMessages = [];
  const handlers = createDispatchHandlers({
    dispatch: {
      assignDriverToOrder: async () => ({ ok: true }),
    },
    getDriverRecordByPhone: async () => ({
      id: "driver-1",
      name: "Rider",
      phone: "2348012345678",
    }),
    createDeliveryTrackingTokens: async () => ({
      customerToken: "a".repeat(64),
      riderToken: "b".repeat(64),
    }),
    getDriverPickedUpButtonsReply: (orderId) => ({ type: "interactive", orderId }),
    sendWhatsAppMessage: async (...message) => sentMessages.push(message),
    PUBLIC_URL: "https://foodie.example/",
  });
  const supabase = {
    from(table) {
      assert.equal(table, "orders");
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: {
              id: "550e8400-e29b-41d4-a716-446655440000",
              customer_phone: "2348098765432",
              restaurant_name: "Foodie Kitchen",
              vendor_id: null,
            },
            error: null,
          };
        },
      };
    },
  };

  await handlers.handleDispatchPayload(
    "driver_accept_550e8400-e29b-41d4-a716-446655440000",
    "2348012345678",
    {},
    supabase,
  );

  const customerLink = sentMessages.find(
    ([phone, message]) =>
      phone === "2348098765432" && message.body?.includes("/tracking.html#token="),
  );
  const riderLink = sentMessages.find(
    ([phone, message]) =>
      phone === "2348012345678" && message.body?.includes("/rider.html#token="),
  );
  assert.ok(customerLink);
  assert.ok(riderLink);
  assert.notEqual(
    customerLink[1].body.match(/[a-f0-9]{64}/)[0],
    riderLink[1].body.match(/[a-f0-9]{64}/)[0],
  );
});
