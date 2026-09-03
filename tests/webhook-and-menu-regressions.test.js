const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldProcessWhatsAppMessage } = require("../lib/utils");
const createDatabase = require("../lib/database");

test("shouldProcessWhatsAppMessage ignores duplicate webhook delivery IDs", () => {
  const seen = new Map();

  assert.equal(shouldProcessWhatsAppMessage({ id: "wamid_1" }, seen), true);
  assert.equal(shouldProcessWhatsAppMessage({ id: "wamid_1" }, seen), false);
  assert.equal(shouldProcessWhatsAppMessage({ id: "wamid_2" }, seen), true);
});

test("getRegisteredVendors includes vendors whose menu is stored in menu_items only", async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        data: [
          {
            name: "Dukes",
            menu: null,
            menu_items: [{ title: "Jollof Rice", price: 2500 }],
            is_active: true,
            is_open: true,
          },
        ],
        error: null,
      }),
    }),
  };

  const db = createDatabase(supabase, new Map(), new Map());
  const vendors = await db.getRegisteredVendors();

  assert.equal(vendors.length, 1);
  assert.equal(vendors[0].name, "Dukes");
});

test("getRegisteredVendors does not drop menu_items-only vendors during the DB query", async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        data: [
          {
            name: "Bistro 77",
            menu: null,
            menu_items: [{ title: "Pasta", price: 3000 }],
            is_active: true,
            is_open: true,
          },
        ],
        error: null,
      }),
    }),
  };

  const db = createDatabase(supabase, new Map(), new Map());
  const vendors = await db.getRegisteredVendors();

  assert.equal(vendors.length, 1);
  assert.equal(vendors[0].name, "Bistro 77");
});
