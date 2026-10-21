const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashTrackingToken,
  hashDeliveryCode,
  createDeliveryTrackingTokens,
} = require("../lib/tracking");
const { STAGES } = require("../lib/constants");
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

function createDeliveryConfirmationHarness({
  role = "rider",
  code = "123456",
  codeAttempts = 0,
} = {}) {
  const riderToken = "b".repeat(64);
  const customerToken = "a".repeat(64);
  const order = {
    id: "order-1",
    status: "picked_up",
    driver_id: "driver-1",
    delivery_code_hash: hashDeliveryCode(code),
    delivery_code_attempts: codeAttempts,
    customer_phone: "2348098765432",
  };
  const routes = new Map();
  const sentMessages = [];
  let markedDelivered = false;
  const supabase = {
    from(table) {
      if (table === "delivery_tracking") {
        let tokenColumn;
        let tokenHash;
        return {
          select() {
            return this;
          },
          eq(column, value) {
            tokenColumn = column;
            tokenHash = value;
            return this;
          },
          async maybeSingle() {
            const matchingRole =
              tokenColumn === `${role}_token_hash` &&
              tokenHash === hashTrackingToken(
                role === "rider" ? riderToken : customerToken,
              );
            return {
              data: matchingRole
                ? { order_id: order.id, rider_token_hash: hashTrackingToken(riderToken) }
                : null,
              error: null,
            };
          },
        };
      }
      assert.equal(table, "orders");
      let filters = {};
      let updateValues;
      return {
        select() {
          return this;
        },
        update(values) {
          updateValues = values;
          return this;
        },
        eq(column, value) {
          filters[column] = value;
          return this;
        },
        async maybeSingle() {
          if (updateValues) {
            if (
              filters.id !== order.id ||
              filters.delivery_code_attempts !== order.delivery_code_attempts
            ) {
              return { data: null, error: null };
            }
            Object.assign(order, updateValues);
            return {
              data: { delivery_code_attempts: order.delivery_code_attempts },
              error: null,
            };
          }
          return { data: { ...order }, error: null };
        },
      };
    },
  };
  const app = {
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  };
  setupTrackingRoutes(app, {
    supabase,
    markOrderDelivered: async () => {
      markedDelivered = true;
      order.status = "delivered";
      return { ...order };
    },
    sendWhatsAppMessage: async (...args) => sentMessages.push(args),
    getCustomerConfirmDeliveryButtonsReply: (orderId) => ({ orderId }),
    ORDER_NOTIFY_NUMBER: "2348000000000",
  });
  return {
    order,
    routes,
    riderToken,
    customerToken,
    sentMessages,
    wasMarkedDelivered: () => markedDelivered,
  };
}

async function requestDeliveryConfirmation(harness, token, code) {
  const response = { statusCode: 200, body: null };
  const res = {
    set() {
      return this;
    },
    status(statusCode) {
      response.statusCode = statusCode;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  await harness.routes.get("POST /api/rider/confirm-delivery")(
    {
      get: () => `Bearer ${token}`,
      body: { code },
    },
    res,
  );
  return response;
}

test("delivery confirmation rejects customer tracking links", async () => {
  const harness = createDeliveryConfirmationHarness({ role: "customer" });

  const response = await requestDeliveryConfirmation(
    harness,
    harness.customerToken,
    "123456",
  );

  assert.equal(response.statusCode, 403);
  assert.equal(harness.wasMarkedDelivered(), false);
});

test("delivery confirmation rejects wrong codes and records an attempt", async () => {
  const harness = createDeliveryConfirmationHarness();

  const response = await requestDeliveryConfirmation(
    harness,
    harness.riderToken,
    "654321",
  );

  assert.equal(response.statusCode, 400);
  assert.equal(harness.order.delivery_code_attempts, 1);
  assert.equal(harness.wasMarkedDelivered(), false);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0][0], "2348000000000");
  assert.match(harness.sentMessages[0][1].body, /Incorrect delivery code/);
  assert.doesNotMatch(harness.sentMessages[0][1].body, /654321/);
});

test("delivery confirmation locks code checks after five incorrect entries", async () => {
  const harness = createDeliveryConfirmationHarness({ codeAttempts: 5 });

  const response = await requestDeliveryConfirmation(
    harness,
    harness.riderToken,
    "123456",
  );

  assert.equal(response.statusCode, 429);
  assert.equal(harness.wasMarkedDelivered(), false);
});

test("correct customer code completes delivery and notifies the customer", async () => {
  const harness = createDeliveryConfirmationHarness();

  const response = await requestDeliveryConfirmation(
    harness,
    harness.riderToken,
    "123456",
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(harness.wasMarkedDelivered(), true);
  assert.equal(harness.order.status, "delivered");
  assert.equal(harness.sentMessages.length, 3);
  assert.equal(harness.sentMessages[0][0], "2348000000000");
  assert.match(harness.sentMessages[0][1].body, /code accepted and delivery completed/);
  assert.equal(harness.sentMessages[1][0], "2348098765432");
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
    STAGES,
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

test("WhatsApp Delivered button prompts for and verifies the delivery code", async () => {
  const order = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    status: "picked_up",
    driver_id: "driver-1",
    delivery_code_hash: hashDeliveryCode("123456"),
    delivery_code_attempts: 0,
    customer_phone: "2348098765432",
  };
  const sentMessages = [];
  const handlers = createDispatchHandlers({
    STAGES,
    dispatch: {
      markOrderDelivered: async (_supabase, orderId, driverId) => {
        assert.equal(orderId, order.id);
        assert.equal(driverId, order.driver_id);
        order.status = "delivered";
        return { ...order };
      },
    },
    getDriverRecordByPhone: async () => ({ id: "driver-1" }),
    sendWhatsAppMessage: async (...message) => sentMessages.push(message),
    getCustomerConfirmDeliveryButtonsReply: (orderId) => ({ orderId }),
    ORDER_NOTIFY_NUMBER: "2348000000000",
  });
  const supabase = {
    from(table) {
      assert.equal(table, "orders");
      let updateValues;
      return {
        select() {
          return this;
        },
        update(values) {
          updateValues = values;
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          if (updateValues) {
            Object.assign(order, updateValues);
            return {
              data: { delivery_code_attempts: order.delivery_code_attempts },
              error: null,
            };
          }
          return { data: { ...order }, error: null };
        },
      };
    },
  };

  const prompt = await handlers.handleDispatchPayload(
    `driver_deliver_${order.id}`,
    "2348012345678",
    {},
    supabase,
  );
  assert.equal(prompt.nextStage, STAGES.DRIVER_AWAIT_DELIVERY_CODE);
  assert.deepEqual(prompt.sessionData, { pendingDeliveryOrderId: order.id });
  assert.match(prompt.replies.body, /enter the customer's 6-digit delivery code here/i);

  const result = await handlers.handleDispatchPayload(
    "123456",
    "2348012345678",
    { ...prompt.sessionData, stage: prompt.nextStage },
    supabase,
  );
  assert.equal(result.nextStage, null);
  assert.equal(order.status, "delivered");
  assert.match(result.replies.body, /code accepted/i);
  assert.equal(sentMessages[0][0], "2348000000000");
  assert.equal(sentMessages[1][0], "2348098765432");
  assert.deepEqual(sentMessages[2][1], { orderId: order.id });
});

test("WhatsApp delivery code entry stays active for invalid codes", async () => {
  const handlers = createDispatchHandlers({
    STAGES,
    getDriverRecordByPhone: async () => ({ id: "driver-1" }),
  });
  const result = await handlers.handleDispatchPayload(
    "123",
    "2348012345678",
    {
      stage: STAGES.DRIVER_AWAIT_DELIVERY_CODE,
      pendingDeliveryOrderId: "order-1",
    },
    {},
  );

  assert.equal(result.nextStage, STAGES.DRIVER_AWAIT_DELIVERY_CODE);
  assert.match(result.replies.body, /6-digit delivery code/i);
});
