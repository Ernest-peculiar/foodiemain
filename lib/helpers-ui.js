// WhatsApp interactive message builders (buttons, lists, etc.)
// These helpers format user-facing UI for conversation flow

const fs = require("fs");
const path = require("path");

module.exports = function createUIHelpers(dependencies) {
  const { MOOD_CATALOG, PUBLIC_URL } = dependencies;

  // ============================================
  // BUTTON REPLY BUILDERS
  // ============================================

  function getNewUserButtonsReply(bodyText = "Get started with Foodie:") {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            { type: "reply", reply: { id: "order_now", title: "Order now" } },
          ],
        },
      },
    };
  }

  function getGreetingButtonsReply(bodyText = "Or tap an option below 👇") {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            { type: "reply", reply: { id: "hungry", title: "Order now" } },
            { type: "reply", reply: { id: "help", title: "What can you do?" } },
          ],
        },
      },
    };
  }

  function getReorderButtonsReply(lastOrder, name = "there") {
    const total = lastOrder.total ?? (lastOrder.qty || 1) * 0;
    const bodyText = `🍔 *Welcome back, ${name}!*\nYour last order was\n*${lastOrder.vendorName}*\n${lastOrder.comboTitle} ×${lastOrder.qty}\n₦${total.toLocaleString("en-US")}\nWould you like it again?`;

    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: "reorder_last", title: "🟢 Reorder".slice(0, 20) },
            },
            {
              type: "reply",
              reply: {
                id: "browse_restaurants",
                title: "🍽 Browse Restaurants".slice(0, 20),
              },
            },
            {
              type: "reply",
              reply: {
                id: "something_different",
                title: "❌ Something Different".slice(0, 20),
              },
            },
          ],
        },
      },
    };
  }

  function getHungryButtonsReply(
    bodyText = "Want me to help you order now, or find some recommendations first?",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: "start_order", title: "🛒 Order now" },
            },
            {
              type: "reply",
              reply: { id: "recommend_meals", title: "✨ Recommend meals" },
            },
          ],
        },
      },
    };
  }

  function getMoodButtonsReply(
    bodyText = "Got it! Tap a category button or type a mood 😊",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: "Choose",
          sections: [
            {
              rows: [
                { id: "light", title: "Light" },
                { id: "heavy", title: "Heavy" },
                { id: "healthy", title: "Healthy" },
                { id: "spicy", title: "Spicy" },
                { id: "affordable", title: "Affordable" },
                { id: "surprise", title: "Surprise" },
              ],
            },
          ],
        },
      },
    };
  }

  function getPostVendorButtonsReply(
    bodyText = "What would you like to do next?",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "try_different_meals",
                title: "Try different meals",
              },
            },
            {
              type: "reply",
              reply: { id: "get_meal_plan", title: "Get a meal plan" },
            },
            { type: "reply", reply: { id: "start_over", title: "Start over" } },
          ],
        },
      },
    };
  }

  function getVendorPrepTimeButtonsReply(
    orderId,
    bodyText = "New paid order! Choose how long it will take to prepare.",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: `vendor_accept_${orderId}_10`, title: "10 min" },
            },
            {
              type: "reply",
              reply: { id: `vendor_accept_${orderId}_20`, title: "20 min" },
            },
            {
              type: "reply",
              reply: { id: `vendor_accept_${orderId}_30`, title: "30 min" },
            },
          ],
        },
      },
    };
  }

  function getDriverDeliveryButtonsReply(orderId) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Mark the order progress." },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: `driver_deliver_${orderId}`, title: "Delivered" },
            },
          ],
        },
      },
    };
  }

  function getDriverAcceptButtonsReply(orderId) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Do you want this delivery?" },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: `driver_reject_${orderId}`, title: "❌ Decline" },
            },
            {
              type: "reply",
              reply: { id: `driver_accept_${orderId}`, title: "✅ Accept" },
            },
          ],
        },
      },
    };
  }

  function getDriverPickedUpButtonsReply(
    orderId,
    bodyText = "Let us know when you have the order in hand.",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: `driver_picked_up_${orderId}`, title: "Picked up" },
            },
          ],
        },
      },
    };
  }

  function getCustomerConfirmDeliveryButtonsReply(
    orderId,
    bodyText = "Has your order arrived?",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `customer_complaint_${orderId}`,
                title: "❌ Problem",
              },
            },
            {
              type: "reply",
              reply: {
                id: `customer_confirmed_${orderId}`,
                title: "✅ Arrived",
              },
            },
          ],
        },
      },
    };
  }

  function getVendorMenuManagementListReply(items, bodyText) {
    return {
      type: "interactive",
      interactive: {
        type: "list",
        body: {
          text: bodyText || "Tap an item to toggle it available / sold out.",
        },
        action: {
          button: "Manage",
          sections: [
            {
              rows: items.map((item) => ({
                id: `toggle_item_${item.id}`,
                title:
                  `${item.available !== false ? "✅" : "🚫"} ${item.title || item.name}`.slice(
                    0,
                    24,
                  ),
                description: (item.price
                  ? `₦${item.price}`
                  : "No price set"
                ).slice(0, 72),
              })),
            },
          ],
        },
      },
    };
  }

  // ============================================
  // VENDOR/RESTAURANT LIST BUILDERS
  // ============================================

  function getRegisteredVendorListReply(
    vendors,
    bodyText = "Our registered restaurants",
  ) {
    return {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: "Choose",
          sections: [
            {
              rows: vendors.map((v, idx) => ({
                id: `regvendor_${idx}`,
                title: v.name.slice(0, 24),
                description: (v.vicinity || "Tap to see menu").slice(0, 72),
              })),
            },
          ],
        },
      },
    };
  }

  // ============================================
  // MENU BUILDERS
  // ============================================

  function makeItemId() {
    const crypto = require("crypto");
    return crypto.randomBytes(3).toString("hex");
  }

  function parseVendorMenu(menuText, existingItems = []) {
    if (!menuText) return [];

    const lines = menuText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const items = [];

    if (lines.length === 1 && lines[0].includes(",")) {
      lines[0].split(",").forEach((part) => {
        if (part.trim()) items.push(part.trim());
      });
    } else {
      for (const l of lines) items.push(l);
    }

    const existingByTitle = new Map(
      (existingItems || []).map((it) => [
        (it.title || it.name || "").trim().toLowerCase(),
        it,
      ]),
    );

    return items
      .map((line) => {
        const trimmedLine = (line || "").trim();
        if (!trimmedLine) return null;

        const match = trimmedLine.match(
          /^(.*?)(?:\s*[-–—:]\s*|\s+)(\d[\d,]*(?:\.\d+)?)\s*(?:and\s+\d[\d,]*(?:\.\d+)?)?(?:\s*(?:with|and|plus)\b.*)?$/i,
        );

        if (!match) {
          const headerLike = /^[A-Za-z\s&()]+:?$/i.test(trimmedLine);
          if (headerLike) return null;
          return {
            id: makeItemId(),
            title: trimmedLine,
            name: trimmedLine,
            description: "",
            price: null,
            available: true,
          };
        }

        const title = match[1].trim();
        const parsedPrice = Number(String(match[2]).replace(/,/g, ""));
        const price = Number.isFinite(parsedPrice)
          ? Math.round(parsedPrice)
          : null;

        if (!title || !price) return null;

        const existing = existingByTitle.get(title.toLowerCase());
        return {
          id: existing?.id || makeItemId(),
          title,
          name: title,
          description: "",
          price,
          available: existing ? existing.available !== false : true,
        };
      })
      .filter(Boolean);
  }

  function getVendorMenuListReply(items, bodyText = "Menu") {
    const sections = {};
    items.forEach((item, idx) => {
      const sectionTitle = "Menu";
      if (!sections[sectionTitle]) sections[sectionTitle] = [];
      sections[sectionTitle].push({
        id: `item_${idx}`,
        title: (item.title || item.name).slice(0, 24),
        description: (
          (item.description || "") + (item.price ? ` — ₦${item.price}` : "")
        ).slice(0, 72),
      });
    });

    return {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: "Choose",
          sections: Object.entries(sections).map(([title, rows]) => ({
            title,
            rows,
          })),
        },
      },
    };
  }

  // ============================================
  // IMAGE URL HELPERS
  // ============================================

  const localImageExistsCache = new Map();

  function localImageExists(filename) {
    if (localImageExistsCache.has(filename))
      return localImageExistsCache.get(filename);
    const exists = fs.existsSync(
      path.join(__dirname, "../public/images", filename),
    );
    localImageExistsCache.set(filename, exists);
    if (!exists)
      console.warn(
        `Local image missing: public/images/${filename} — sending text instead for this item.`,
      );
    return exists;
  }

  function getLocalImageUrl(filename) {
    return `${PUBLIC_URL}/images/${encodeURIComponent(filename)}`;
  }

  async function resolveImageUrl(item) {
    if (item.localImage && localImageExists(item.localImage)) {
      return getLocalImageUrl(item.localImage);
    }
    return null;
  }

  return {
    getNewUserButtonsReply,
    getGreetingButtonsReply,
    getReorderButtonsReply,
    getHungryButtonsReply,
    getMoodButtonsReply,
    getPostVendorButtonsReply,
    getVendorPrepTimeButtonsReply,
    getDriverDeliveryButtonsReply,
    getDriverAcceptButtonsReply,
    getDriverPickedUpButtonsReply,
    getCustomerConfirmDeliveryButtonsReply,
    getVendorMenuManagementListReply,
    getRegisteredVendorListReply,
    makeItemId,
    parseVendorMenu,
    getVendorMenuListReply,
    localImageExists,
    getLocalImageUrl,
    resolveImageUrl,
  };
};
