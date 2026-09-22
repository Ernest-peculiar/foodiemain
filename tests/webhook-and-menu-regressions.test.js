const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldProcessWhatsAppMessage,
  hasMenuContent,
} = require("../lib/utils");
const createDatabase = require("../lib/database");
const createStageHandlers = require("../lib/handlers-stages");
const createUIHelpers = require("../lib/helpers-ui");

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

test("hasMenuContent accepts stringified menu_items JSON", () => {
  assert.equal(
    hasMenuContent({
      menu: null,
      menu_items: JSON.stringify([{ title: "Jollof Rice", price: 2500 }]),
    }),
    true,
  );
});

test("parseVendorMenu handles pasted menu lines with extra text and section headers", () => {
  const ui = createUIHelpers({
    MOOD_CATALOG: {},
    PUBLIC_URL: "https://example.com",
  });
  const menu = `BASMATI RICE - 2200 with takeaway
BEANS with takeaway - 1200
VANILLA CAKE - 10000 and 8000
Drinks:
FANTA - 500`;

  const items = ui.parseVendorMenu(menu);

  assert.equal(items.length, 4);
  assert.equal(items[0].title, "BASMATI RICE");
  assert.equal(items[0].price, 2200);
  assert.equal(items[2].title, "VANILLA CAKE");
  assert.equal(items[2].price, 10000);
  assert.equal(items[3].title, "FANTA");
  assert.equal(items[3].price, 500);
});

test("menu list paginates long item sets into separate WhatsApp messages", () => {
  const ui = createUIHelpers({
    MOOD_CATALOG: {},
    PUBLIC_URL: "https://example.com",
  });
  const items = Array.from({ length: 25 }, (_, idx) => ({
    title: `Item ${idx + 1}`,
    name: `Item ${idx + 1}`,
    price: 1000 + idx,
    available: true,
  }));

  const replies = ui.getVendorMenuListReply(items, "Menu");

  assert.equal(replies.length, 3);
  assert.deepEqual(
    replies.map((reply) => reply.interactive.action.sections[0].rows.length),
    [10, 10, 5],
  );
  assert.equal(replies[0].interactive.body.text, "Menu (Menu 1/3)");
  assert.equal(replies[2].interactive.action.sections[0].rows[0].id, "item_20");
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

test("order cart keeps items selected from different menu pages", async () => {
  const menuItems = Array.from({ length: 21 }, (_, idx) => ({
    title: `Item ${idx + 1}`,
    name: `Item ${idx + 1}`,
    price: 1000 + idx,
    available: true,
  }));
  const vendor = { name: "Dukes", id: "ven_123", phone: "2348012345678" };
  const stageHandlers = createStageHandlers({
    STAGES: {
      ORDER_SELECT_COMBO: "order_select_combo",
      ORDER_ENTER_QTY: "order_enter_qty",
      ORDER_AWAIT_ADDRESS: "order_await_address",
    },
    STAGE_LABELS: {},
    MOOD_KEYWORDS: {},
    MOOD_CATALOG: {},
    getVendorMenuListReply: (items) => ({
      type: "menu",
      itemCount: items.length,
    }),
    getPreviousLocationsListReply: () => null,
    getProfile: async () => ({}),
  });
  const session = { selectedVendor: vendor, menuItems, cart: [] };

  const firstSelection = await stageHandlers.handleOrderSelectCombo(
    "item_0",
    "Jane",
    session,
  );
  const afterFirst = await stageHandlers.handleOrderEnterQty(
    "2",
    "Jane",
    { ...session, ...firstSelection.sessionData },
    "Jane",
    "2348000000000",
  );
  const secondSelection = await stageHandlers.handleOrderSelectCombo(
    "item_20",
    "Jane",
    { ...session, ...afterFirst.sessionData },
  );
  const afterSecond = await stageHandlers.handleOrderEnterQty(
    "3",
    "Jane",
    { ...session, ...afterFirst.sessionData, ...secondSelection.sessionData },
    "Jane",
    "2348000000000",
  );

  assert.equal(afterSecond.nextStage, "order_select_combo");
  assert.deepEqual(afterSecond.sessionData.cart, [
    { itemIdx: 0, title: "Item 1", price: 1000, qty: 2 },
    { itemIdx: 20, title: "Item 21", price: 1020, qty: 3 },
  ]);
  assert.equal(
    afterSecond.replies.at(-1).interactive.action.buttons[0].reply.id,
    "done_selecting",
  );
});
