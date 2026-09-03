const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldProcessWhatsAppMessage,
  hasMenuContent,
} = require("../lib/utils");
const createDatabase = require("../lib/database");
const createStageHandlers = require("../lib/handlers-stages");

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

test("restaurant order flow accepts menu_items-only vendors", async () => {
  const vendorRecord = {
    id: "ven_123",
    name: "Dukes",
    phone: "2348012345678",
    menu: null,
    menu_items: [{ title: "Jollof Rice", price: 2500, available: true }],
  };

  const stageHandlers = createStageHandlers({
    STAGES: {
      ORDER_ASK_WHAT: "order_ask_what",
      ORDER_SELECT_RESTAURANT: "order_select_restaurant",
      ORDER_SELECT_COMBO: "order_select_combo",
    },
    STAGE_LABELS: {},
    MOOD_KEYWORDS: {},
    MOOD_CATALOG: {},
    getRegisteredVendors: async () => [],
    findVendorByName: async () => vendorRecord,
    titleCase: (value) => value,
    parseOrderRequest: () => ({ foodItem: "rice", vendorName: "Dukes" }),
    isLikelyValidAddress: () => true,
    mapMoodToCategory: () => "light",
    buildMoodReply: async () => [],
    getMoodButtonsReply: () => ({ type: "text", body: "mood" }),
    hasMenuContent,
    getRegisteredVendorListReply: () => ({ type: "text", body: "list" }),
    getVendorMenuListReply: (items, title) => ({
      type: "text",
      body: `${title} (${items.length})`,
    }),
    getHungryButtonsReply: () => ({ type: "text", body: "hungry" }),
    getNewUserButtonsReply: () => ({ type: "text", body: "new" }),
    getGreetingButtonsReply: () => ({ type: "text", body: "greeting" }),
    getReorderButtonsReply: () => ({ type: "text", body: "reorder" }),
    buildVendorMenuReply: (record, intro) => ({
      replies: [{ type: "text", body: intro }],
      nextStage: "order_select_combo",
      sessionData: { selectedVendor: record, menuItems: record.menu_items },
    }),
    handleBrowseRestaurants: async () => ({
      replies: { type: "text", body: "browse" },
      nextStage: null,
      sessionData: {},
    }),
    saveProfile: async () => {},
    askGrok: async () => "",
    parseVendorMenu: () => [],
    makeItemId: (idx) => `menu_${idx}`,
    createPaystackTransaction: async () => ({}),
    DELIVERY_FEE: 500,
  });

  const result = await stageHandlers.handleOrderAskWhat(
    "rice from Dukes",
    "Jane",
    {},
  );

  assert.equal(result.nextStage, "order_select_combo");
  assert.equal(result.sessionData.selectedVendor.name, "Dukes");
  assert.equal(result.sessionData.menuItems.length, 1);
});
