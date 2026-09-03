// Utility functions for text parsing, validation, and formatting
const { ORDER_FILLER_PREFIXES } = require("./constants");

function parseEmail(text) {
  const match = (text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function normalizePhone(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";

  if (/^0\d{10}$/.test(digits)) {
    return `234${digits.slice(1)}`;
  }

  if (/^234\d{10}$/.test(digits)) {
    return digits;
  }

  if (/^\d{10}$/.test(digits)) {
    return `234${digits}`;
  }

  return digits;
}

function buildVendorWelcomeMessage(restaurantName, menuItems = []) {
  const safeName = String(restaurantName || "Vendor").trim() || "Vendor";
  const items = Array.isArray(menuItems) ? menuItems : [];
  const menuNote =
    items.length > 0
      ? `\n\n✅ *${items.length} menu item${items.length === 1 ? "" : "s"} added.*`
      : "\n\n📋 No menu added yet — send 'menu' to add one.";

  return {
    type: "text",
    body:
      `👋 Welcome to Foodie, ${safeName}!\n\n` +
      `Your restaurant is now registered.${menuNote}\n\n` +
      `Reply with:\n` +
      `• *menu* — to manage your menu\n` +
      `• *hours* — to set opening hours\n` +
      `• *open* — to go online\n` +
      `• *close* — to go offline`,
  };
}

function isValidWhatsAppPayload(body) {
  if (!body || typeof body !== "object") return false;
  if (body.object !== "whatsapp_business_account") return true;
  return (
    Array.isArray(body.entry) &&
    body.entry.every((entry) => Array.isArray(entry.changes))
  );
}

function normalizeMenuItems(menuItems) {
  if (Array.isArray(menuItems)) return menuItems;
  if (typeof menuItems !== "string") return [];

  const trimmed = menuItems.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasMenuContent(vendor = {}) {
  if (!vendor || typeof vendor !== "object") return false;

  const menuText = typeof vendor.menu === "string" ? vendor.menu.trim() : "";
  if (menuText) return true;

  const menuItems = normalizeMenuItems(vendor.menu_items);
  return menuItems.some(
    (item) =>
      item &&
      (String(item.title || item.name || "").trim() ||
        (item.price !== null && item.price !== undefined)),
  );
}

function shouldProcessIncomingWebhookMessage(
  message,
  seenMessageIds = new Map(),
) {
  if (!message || typeof message !== "object") return true;

  const messageId = message.id || message?.metadata?.id || null;
  if (!messageId) return true;

  if (seenMessageIds.has(messageId)) return false;

  seenMessageIds.set(messageId, Date.now());
  if (seenMessageIds.size > 10000) {
    const oldestKey = seenMessageIds.keys().next().value;
    if (oldestKey) seenMessageIds.delete(oldestKey);
  }

  return true;
}

const shouldProcessWhatsAppMessage = shouldProcessIncomingWebhookMessage;

function titleCase(str) {
  return (str || "").replace(
    /\w\S*/g,
    (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  );
}

function stripOrderFiller(text) {
  let result = (text || "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ORDER_FILLER_PREFIXES) {
      const re = new RegExp("^" + prefix.replace(/'/g, `['']`) + "\\s*", "i");
      if (re.test(result)) {
        result = result.replace(re, "").trim();
        changed = true;
      }
    }
  }
  return result;
}

function parseOrderRequest(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { foodItem: null, vendorName: null };

  const fromMatch = trimmed.match(/\bfrom\s+([a-z0-9&'.\- ]{2,40})$/i);
  let vendorName = null;
  let beforeFrom = trimmed;

  if (fromMatch) {
    vendorName = fromMatch[1].trim().replace(/[.?!]+$/, "") || null;
    beforeFrom = trimmed.slice(0, fromMatch.index).trim();
  }

  const foodItem = stripOrderFiller(beforeFrom);
  return { foodItem: foodItem || null, vendorName };
}

function isLikelyValidAddress(text) {
  const trimmed = (text || "").trim();
  if (trimmed.length < 10) return false;

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;

  const rejectPhrases = [
    "ok",
    "okay",
    "yes",
    "no",
    "sure",
    "done",
    "here",
    "i don't know",
    "idk",
    "na",
    "nil",
  ];
  if (rejectPhrases.includes(trimmed.toLowerCase())) return false;

  return true;
}

function looksLikeOrderRequest(text) {
  const normalized = (text || "").toLowerCase();
  if (/\bfrom\s+[a-z0-9]/i.test(normalized)) return true;
  if (/\border\b/.test(normalized)) return true;
  if (
    /\b(want|need|crave|feed me|serve me)\b/.test(normalized) &&
    /\b(rice|beans?|jollof|food|meal|meals?)\b/.test(normalized)
  )
    return true;
  return false;
}

module.exports = {
  parseEmail,
  normalizePhone,
  normalizeMenuItems,
  buildVendorWelcomeMessage,
  isValidWhatsAppPayload,
  hasMenuContent,
  shouldProcessIncomingWebhookMessage,
  shouldProcessWhatsAppMessage,
  titleCase,
  stripOrderFiller,
  parseOrderRequest,
  isLikelyValidAddress,
  looksLikeOrderRequest,
};
