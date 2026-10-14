const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const setupAdminRoutes = require("../lib/routes-admin");

function createAdminHarness() {
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

async function callRoute(handlers, username, password) {
  const req = {
    headers: {
      authorization:
        "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
    },
    body: {},
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
