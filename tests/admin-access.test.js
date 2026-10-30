const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const setupAdminRoutes = require("../lib/routes-admin");

function createAdminHarness(overrides = {}) {
  const routes = new Map();
  const app = {
    use() {},
    get(routePath, ...handlers) {
      routes.set(`GET ${routePath}`, handlers);
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers);
    },
  };

  setupAdminRoutes(app, {
    path,
    fs: require("node:fs"),
    crypto,
    express: { static: () => () => {} },
    supabase: null,
    dispatch: {},
    ADMIN_USERNAME: "owner",
    ADMIN_PASSWORD: "owner-secret",
    ADMIN_TEAM_USERNAME: "staff",
    ADMIN_TEAM_PASSWORD: "staff-secret",
    PAYSTACK_SECRET_KEY: "",
    normalizePhone: (value) => value,
    parseEmail: () => true,
    parseVendorMenu: () => [],
    sendWhatsAppMessage: async () => {},
    buildVendorWelcomeMessage: () => "",
    ...overrides,
  });

  return routes;
}

function createResponse() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function callRoute(handlers, username, password, body = {}) {
  const req = {
    headers: {
      authorization:
        "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
    },
    body,
    query: {},
  };
  const res = createResponse();

  for (const handler of handlers) {
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    const result = handler(req, res, next);
    if (result && typeof result.then === "function") await result;
    if (!nextCalled) break;
  }

  return { req, res };
}

test("advanced admin credentials identify the full dashboard role", async () => {
  const routes = createAdminHarness();
  const { res } = await callRoute(
    routes.get("GET /admin/api/access"),
    "owner",
    "owner-secret",
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { role: "admin" });
});

test("team credentials identify the registration-only role", async () => {
  const routes = createAdminHarness();
  const { res } = await callRoute(
    routes.get("GET /admin/api/access"),
    "staff",
    "staff-secret",
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { role: "team" });
});

test("team credentials cannot fetch advanced dashboard data", async () => {
  const routes = createAdminHarness();
  for (const route of [
    "GET /admin/api/stats",
    "GET /admin/api/operations",
    "GET /admin/api/vendors",
    "GET /admin/api/drivers",
  ]) {
    const { res } = await callRoute(
      routes.get(route),
      "staff",
      "staff-secret",
    );
    assert.equal(res.statusCode, 403, `${route} should be admin-only`);
    assert.equal(res.payload.error, "Advanced admin access required.");
  }
});

test("team credentials are accepted for vendor and driver registration", async () => {
  const routes = createAdminHarness();
  for (const route of [
    "POST /admin/api/vendors",
    "POST /admin/api/drivers",
  ]) {
    const { res } = await callRoute(
      routes.get(route),
      "staff",
      "staff-secret",
    );
    assert.equal(res.statusCode, 503, `${route} reached the database guard`);
    assert.match(res.payload.error, /Supabase is not configured/);
  }
});

test("invalid credentials do not receive a dashboard role", async () => {
  const routes = createAdminHarness();
  const { res } = await callRoute(
    routes.get("GET /admin/api/access"),
    "staff",
    "wrong-secret",
  );

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload, "Invalid credentials.");
});

test("vendor setup recreates a missing subaccount with the active Paystack key", async () => {
  const savedVendors = [];
  const supabase = {
    from(table) {
      assert.equal(table, "vendors");
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
              id: "vendor-1",
              paystack_subaccount_code: "ACCT_test_mode",
            },
            error: null,
          };
        },
      };
    },
  };
  const routes = createAdminHarness({
    supabase,
    PAYSTACK_SECRET_KEY: "sk_live_fake",
    dispatch: {
      upsertVendor: async (_supabase, vendor) => {
        savedVendors.push(vendor);
        return { id: "vendor-1" };
      },
    },
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (options.method === "PUT") {
      return {
        ok: false,
        status: 400,
        json: async () => ({ status: false, message: "Subaccount does not exist" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        data: { subaccount_code: "ACCT_live_mode" },
      }),
    };
  };

  try {
    const { res } = await callRoute(
      routes.get("POST /admin/api/vendors"),
      "owner",
      "owner-secret",
      {
        contactName: "Owner",
        restaurantName: "Foodie Kitchen",
        whatsappNumber: "2348012345678",
        address: "1 Foodie Street",
        openingHours: "9am to 9pm",
        bankCode: "001",
        bankName: "Test Bank",
        accountNumber: "0123456789",
        accountName: "Foodie Kitchen",
      },
    );

    assert.equal(res.statusCode, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.method, "PUT");
    assert.equal(requests[1].options.method, "POST");
    assert.equal(
      JSON.parse(requests[1].options.body).settlement_bank,
      "001",
    );
    assert.equal(savedVendors[0].paystackSubaccountCode, "ACCT_live_mode");
  } finally {
    global.fetch = originalFetch;
  }
});
