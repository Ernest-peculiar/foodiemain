require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const dispatch = require("./lib/order-dispatch");

// ============================================
// ENVIRONMENT & CONFIG
// ============================================

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

if (
  !/^https:\/\//i.test(PUBLIC_URL) ||
  /localhost|127\.0\.0\.1/i.test(PUBLIC_URL)
) {
  console.warn(
    `⚠️  PUBLIC_URL is "${PUBLIC_URL}" — this is the URL WhatsApp's servers use to fetch images you send, ` +
      `and they can't reach localhost or a plain http:// address. Local images will silently fail to display ` +
      `until PUBLIC_URL is set (in your .env) to a real public HTTPS URL — your deployed domain, or an https ` +
      `tunnel like ngrok during local dev. It is also the base for the Paystack webhook callback_url.`,
  );
}

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";
const GROK_API_KEY = process.env.GROK_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DEBUG = process.env.DEBUG === "true";
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE || 500);
const ORDER_NOTIFY_NUMBER = process.env.ORDER_NOTIFY_NUMBER;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn(
    "⚠️  ADMIN_USERNAME / ADMIN_PASSWORD are not set — the /admin dashboard will reject all requests until both are configured in .env.",
  );
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

if (!supabase) {
  console.warn(
    "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — falling back to in-memory sessions, and chat history will NOT be saved.",
  );
}

const sessions = new Map();
const profiles = new Map();

// ============================================
// IMPORT MODULES
// ============================================

const {
  STAGES,
  STAGE_LABELS,
  MOOD_KEYWORDS,
  MOOD_CATALOG,
} = require("./lib/constants");
const {
  normalizePhone,
  parseEmail,
  parseOrderRequest,
  isLikelyValidAddress,
  titleCase,
  stripOrderFiller,
  isValidWhatsAppPayload,
  looksLikeOrderRequest,
} = require("./lib/utils");

const createDatabase = require("./lib/database");
const db = createDatabase(supabase, sessions, profiles);
const {
  getSession,
  setSession,
  deleteSession,
  getProfile,
  saveProfile,
  resolveSenderRole,
  logMessage,
  getVendorRecordByPhone,
  getVendorRecordById,
  getDriverRecordByPhone,
  findVendorByName,
  getRegisteredVendors,
} = db;

const createUIHelpers = require("./lib/helpers-ui");
const uiHelpers = createUIHelpers({ MOOD_CATALOG, PUBLIC_URL });
const {
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
  getRegisteredVendorListReply,
  getVendorMenuListReply,
  parseVendorMenu,
  makeItemId,
} = uiHelpers;

const createPaymentHandlers = require("./lib/payment");
const paymentHandlers = createPaymentHandlers({
  DELIVERY_FEE,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_API_VERSION,
  PAYSTACK_SECRET_KEY,
  PUBLIC_URL,
  sendWhatsAppMessage,
  saveProfile,
  getVendorRecordById,
});
const {
  createPaystackTransaction,
  generateReceiptPNG,
  uploadWhatsAppMedia,
  buildPaymentSuccessPage,
  buildReceiptText,
  handlePaystackChargeSuccess,
} = paymentHandlers;

const createStageHandlers = require("./lib/handlers-stages");
const stageHandlers = createStageHandlers({
  STAGES,
  STAGE_LABELS,
  MOOD_KEYWORDS,
  MOOD_CATALOG,
  getRegisteredVendors,
  findVendorByName,
  titleCase,
  parseOrderRequest,
  isLikelyValidAddress,
  mapMoodToCategory,
  buildMoodReply,
  buildVendorMenuReply,
  handleBrowseRestaurants,
  saveProfile,
  askGrok,
  parseVendorMenu,
  makeItemId,
  createPaystackTransaction,
  DELIVERY_FEE,
  getMoodButtonsReply,
  getVendorMenuListReply,
  getHungryButtonsReply,
  getNewUserButtonsReply,
  getGreetingButtonsReply,
  getReorderButtonsReply,
  getRegisteredVendorListReply,
});
const {
  handleGreeting,
  handleResumePrompt,
  getStageResumeReply,
  handleCapabilities,
  handleHungry,
  handleRecommendMeals,
  handleOrderAskWhat,
  handleOrderNow,
  handleReorderLast,
  handleAskLastMeal,
  handleAskMood,
  handleAskHealthGoals,
  handleOrderSelectRestaurant,
  handleOrderSelectCombo,
  handleOrderEnterQty,
  handleMealPlanPlaceholder,
} = stageHandlers;

const createDispatchHandlers = require("./lib/handlers-dispatch");
const dispatchHandlers = createDispatchHandlers({
  STAGES,
  dispatch,
  normalizePhone,
  parseVendorMenu,
  sendWhatsAppMessage,
  getVendorRecordByPhone,
  getDriverRecordByPhone,
  getVendorMenuManagementListReply: uiHelpers.getVendorMenuManagementListReply,
  getDriverAcceptButtonsReply,
  getDriverPickedUpButtonsReply,
  getCustomerConfirmDeliveryButtonsReply,
  getVehicleTypeListReply: () => ({}), // placeholder
  WHATSAPP_TOKEN,
  WHATSAPP_API_VERSION,
  ORDER_NOTIFY_NUMBER,
});
const {
  handleAvailabilityCommands,
  handleVendorMenuCommands,
  handleRegistrationFlow,
  finalizeRegistration,
  handleDispatchPayload,
  handleDeliveryPhotoMessage,
} = dispatchHandlers;

// ============================================
// MIDDLEWARE
// ============================================

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// HELPER FUNCTIONS
// ============================================

// WhatsApp API message sender (not in any module since it's used across many)
async function sendWhatsAppMessage(toPhone, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.warn(
      "WhatsApp credentials not configured; message not sent:",
      message,
    );
    return null;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const normalizedPhone = normalizePhone(toPhone);
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizedPhone,
  };

  if (message.type === "text") {
    payload.type = "text";
    payload.text = { preview_url: false, body: message.body };
  } else if (message.type === "image") {
    payload.type = "image";
    payload.image = message.mediaId
      ? { id: message.mediaId }
      : { link: message.imageUrl };
    if (message.caption) payload.image.caption = message.caption;
  } else if (message.type === "interactive") {
    payload.type = "interactive";
    payload.interactive = message.interactive;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error(
        `WhatsApp API error (${response.status}):`,
        error.error?.message || JSON.stringify(error),
      );
      return null;
    }

    const result = await response.json();
    return result.messages?.[0]?.id || null;
  } catch (error) {
    console.error("WhatsApp send failed:", error.message);
    return null;
  }
}

// AI assistant for creative/factual replies
async function askGrok(
  userMessage,
  sessionData = {},
  { creative = false } = {},
) {
  if (!GROK_API_KEY) {
    console.warn("Grok API key is not configured.");
    return null;
  }

  try {
    const basePrompt = `You are Foodie, a friendly Nigerian food recommendation WhatsApp bot. You help users discover what to eat based on their mood and preferences. You're knowledgeable about Nigerian cuisine and friendly.`;
    const systemPrompt = creative
      ? `${basePrompt} When a user says something outside the normal "what are you hungry for" flow — jokes, small talk, random questions, compliments, complaints — respond with genuine personality: be witty, warm, occasionally use light Nigerian expressions, and when it fits naturally, steer the conversation back toward food. Never repeat the same joke or phrasing twice in a row. Keep it WhatsApp-friendly (under 250 characters).`
      : `${basePrompt} Keep responses concise for WhatsApp (under 160 characters when possible). ${sessionData.mood ? `The user is interested in ${sessionData.mood} food.` : ""}`;

    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.GROK_MODEL || "grok",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: creative ? 1.0 : 0.7,
        max_tokens: creative ? 220 : 150,
      }),
    });

    if (!response.ok) {
      console.error("Grok API error:", response.status);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("Grok API failed:", error);
    return null;
  }
}

// Build food recommendation text
async function buildMoodReply(category, shortName, lastMeal) {
  const basePrefix = lastMeal
    ? `Based on what you last ate (${lastMeal}), `
    : "";
  const getSurpriseItems = () => {
    const all = Object.values(MOOD_CATALOG).flat();
    return [all[Math.floor(Math.random() * all.length)]];
  };
  const items =
    category === "surprise" ? getSurpriseItems() : MOOD_CATALOG[category];

  if (!items || items.length === 0) {
    return {
      type: "text",
      body: `${basePrefix}I can suggest meals based on your mood, ${shortName}. Try: hungry, light, heavy, healthy, spicy, or affordable.`,
    };
  }

  const headerText =
    category === "surprise"
      ? `${basePrefix}Here's a surprise pick for you, ${shortName} 🎉`
      : `${basePrefix}Here are some ${category} options for you 👇`;

  const formatFoodCaption = (item) => {
    const tags = (item.tags || []).join(" • ");
    const cal = item.kcal ? ` (~${item.kcal} kcal)` : "";
    return `*${item.name}*\n${item.description}${cal}\n_${tags}_`;
  };

  const listBody = items.map(formatFoodCaption).join("\n\n");

  return [
    { type: "text", body: headerText },
    { type: "text", body: listBody },
  ];
}

// Browse registered restaurants
async function handleBrowseRestaurants(
  introText = `Here are our registered restaurants 👇 Tap one to see the menu.`,
) {
  const vendors = await getRegisteredVendors();

  if (vendors.length === 0) {
    return {
      replies: {
        type: "text",
        body: `No registered restaurants are available right now. Please check back later.`,
      },
      nextStage: null,
      sessionData: {},
    };
  }

  return {
    replies: [
      { type: "text", body: introText },
      getRegisteredVendorListReply(vendors),
    ],
    nextStage: STAGES.ORDER_SELECT_RESTAURANT,
    sessionData: { registeredVendors: vendors },
  };
}

// Build vendor menu from restaurant record
function buildVendorMenuReply(vendorRecord, introText) {
  const allItems =
    vendorRecord.menu_items || parseVendorMenu(vendorRecord.menu);
  const menuItems = allItems.filter((it) => it.available !== false);
  const vendor = {
    id: vendorRecord.id,
    name: vendorRecord.name,
    phone: vendorRecord.phone,
    vicinity: vendorRecord.vicinity || "Registered restaurant",
  };

  if (menuItems.length === 0) {
    return {
      replies: {
        type: "text",
        body: `Sorry, *${vendor.name}* has nothing available right now — please check back later.`,
      },
      nextStage: null,
      sessionData: {},
    };
  }

  return {
    replies: [
      { type: "text", body: introText },
      getVendorMenuListReply(menuItems, `Menu for ${vendor.name}`),
    ],
    nextStage: STAGES.ORDER_SELECT_COMBO,
    sessionData: { selectedVendor: vendor, menuItems },
  };
}

// Handle order awaiting delivery address confirmation
async function handleOrderAwaitAddress(text, name, session, shortName, phone) {
  const menuItems = Array.isArray(session.menuItems) ? session.menuItems : [];
  const combo = menuItems[session.selectedComboIdx];
  const vendor = session.selectedVendor;
  const qty = session.qty;

  if (!combo || !vendor || !qty) return handleOrderNow();

  if (!isLikelyValidAddress(text)) {
    return {
      replies: {
        type: "text",
        body: `That doesn't look like a full address yet 🙏 Please include the street name, house number or a nearby landmark, and the area — e.g. "12 Ogoja Rd, opposite GTBank, Abakaliki".`,
      },
      nextStage: STAGES.ORDER_AWAIT_ADDRESS,
      sessionData: {
        selectedVendor: vendor,
        selectedComboIdx: session.selectedComboIdx,
        qty,
        menuItems,
      },
    };
  }

  const address = text.trim();
  const email =
    parseEmail(text) ||
    `${name.replace(/\s+/g, ".").toLowerCase()}@example.com`;
  const unitPrice =
    combo && (combo.price || combo.price === 0) ? Number(combo.price) : 0;
  const subtotal = unitPrice * qty;
  const totalAmount = subtotal + DELIVERY_FEE;

  if (unitPrice <= 0) {
    return {
      replies: {
        type: "text",
        body: `This restaurant hasn't set a price for *${combo.title || combo.name}* yet, so I can't take payment right now. Please try again shortly, or pick a different item.`,
      },
      nextStage: null,
    };
  }

  let orderRecord;
  try {
    orderRecord = await dispatch.createOrderRecord(supabase, {
      customerName: name,
      customerPhone: phone,
      vendor: {
        id: vendor.id || null,
        name: vendor.name,
        phone: vendor.phone || null,
        isActive: true,
        isOpen: true,
      },
      restaurantName: vendor.name,
      items: [{ title: combo.title || combo.name, qty, price: unitPrice }],
      subtotal,
      deliveryFee: DELIVERY_FEE,
      total: totalAmount,
      deliveryAddress: address,
      status: "pending_payment",
    });
  } catch (error) {
    console.error("dispatch.createOrderRecord threw:", error.message || error);
    return {
      replies: {
        type: "text",
        body: `Something went wrong starting your order — please try again, or contact support if this keeps happening.`,
      },
      nextStage: null,
    };
  }

  if (!orderRecord?.id) {
    console.error(
      "createOrderRecord did not return an order id — order was not created.",
    );
    return {
      replies: {
        type: "text",
        body: `Something went wrong starting your order — please try again.`,
      },
      nextStage: null,
    };
  }

  let payment = null;
  try {
    payment = await createPaystackTransaction(
      email,
      totalAmount,
      orderRecord.id,
    );
  } catch (error) {
    console.error(
      "createPaystackTransaction threw unexpectedly:",
      error.message || error,
    );
  }

  let paymentMessage;
  if (payment) {
    try {
      await dispatch.updateOrderStatus(supabase, orderRecord.id, {
        paystack_reference: payment.reference || orderRecord.id,
      });
    } catch (error) {
      console.error(
        "dispatch.updateOrderStatus threw while saving paystack_reference:",
        error.message || error,
      );
    }
    paymentMessage = `Please complete payment here: ${payment.authorization_url}\n\nYou'll get a receipt here the moment payment is confirmed — that's also when the restaurant is notified of your order.`;
  } else {
    paymentMessage = `I couldn't create the payment link right now. Please try again later or contact support.`;
  }

  return {
    replies: {
      type: "text",
      body: `${qty} x *${combo.title || combo.name}* from *${vendor.name}*\nDeliver to: ${address}\nSubtotal: ₦${subtotal.toLocaleString("en-US")}\nDelivery fee: ₦${DELIVERY_FEE.toLocaleString("en-US")}\n*Total: ₦${totalAmount.toLocaleString("en-US")}*\n${paymentMessage}`,
    },
    nextStage: null,
  };
}

// Map user mood text to category
function mapMoodToCategory(userMoodText, fallback = "light") {
  const normalized = (userMoodText || "").toLowerCase();
  for (const [keyword, category] of Object.entries(MOOD_KEYWORDS)) {
    if (normalized.includes(keyword)) return category;
  }
  return fallback;
}

// Stage handler dispatch
const STAGE_HANDLERS = {
  [STAGES.ASK_LAST_MEAL]: handleAskLastMeal,
  [STAGES.ASK_MOOD]: handleAskMood,
  [STAGES.ASK_HEALTH_GOALS]: handleAskHealthGoals,
  [STAGES.ORDER_ASK_WHAT]: handleOrderAskWhat,
  [STAGES.ORDER_SELECT_RESTAURANT]: handleOrderSelectRestaurant,
  [STAGES.ORDER_SELECT_COMBO]: handleOrderSelectCombo,
  [STAGES.ORDER_ENTER_QTY]: handleOrderEnterQty,
  [STAGES.ORDER_AWAIT_ADDRESS]: handleOrderAwaitAddress,
};

// Build a reply to user message
async function buildReply(text, name = "friend", session = {}, phone) {
  const normalized = text.trim().toLowerCase();
  const shortName = name.split(" ")[0] || "friend";

  if (!normalized || ["hi", "hello", "hey", "start"].includes(normalized)) {
    if (session.stage) return handleResumePrompt(session, shortName);
    const profile = await getProfile(phone);
    return handleGreeting(text || "hello", shortName, profile, phone);
  }

  if (normalized === "start_over")
    return handleGreeting(
      "let's start over",
      shortName,
      await getProfile(phone),
      phone,
    );
  if (normalized === "resume_flow")
    return {
      replies: await getStageResumeReply(session),
      nextStage: session.stage,
      sessionData: session,
    };
  if (normalized === "try_different_meals") return handleHungry();
  if (normalized === "get_meal_plan") return handleMealPlanPlaceholder();
  if (normalized === "order_now") return handleHungry();
  if (normalized === "start_order") return handleOrderNow();
  if (normalized === "recommend_meals") return handleRecommendMeals();
  if (normalized === "reorder_last")
    return handleReorderLast(await getProfile(phone));
  if (normalized === "browse_restaurants") return handleBrowseRestaurants();
  if (normalized === "something_different") return handleHungry();

  if (
    normalized.includes("what can you do") ||
    normalized.includes("what do you do") ||
    normalized.includes("capabilities") ||
    normalized.includes("help")
  ) {
    return handleCapabilities();
  }

  if (!session.stage && looksLikeOrderRequest(normalized)) {
    return handleOrderAskWhat(text, name, session);
  }

  if (normalized.includes("hungry")) return handleHungry();

  const handler = STAGE_HANDLERS[session.stage];
  if (handler) return handler(text, name, session, shortName, phone);

  const grokResponse = await askGrok(text, session, { creative: true });
  if (grokResponse) {
    return { replies: { type: "text", body: grokResponse }, nextStage: null };
  }

  return {
    replies: {
      type: "text",
      body: `Just say you're hungry and I'll guide you through finding the perfect meal! 😊`,
    },
    nextStage: null,
  };
}

// Handle incoming WhatsApp message
async function handleIncomingMessage(message, value) {
  const from = message.from;
  const senderName = value.contacts?.[0]?.profile?.name || "Foodie friend";
  const session = await getSession(from);

  let result;

  const role = await resolveSenderRole(from);
  const text =
    message.text?.body ||
    message.button?.payload ||
    message.interactive?.button_reply?.id ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.id ||
    message.interactive?.list_reply?.title ||
    "";

  const registrationReply = await handleRegistrationFlow(text, from, session);
  const menuManagementReply = registrationReply
    ? null
    : await handleVendorMenuCommands(text, from, session, supabase);

  if (registrationReply) {
    await logMessage(from, "inbound", message.type || "text", text, message);
    result = registrationReply;
  } else if (menuManagementReply) {
    await logMessage(from, "inbound", message.type || "text", text, message);
    result = menuManagementReply;
  } else if (
    session.stage === "vendorAwaitName" ||
    session.stage === STAGES.VENDOR_AWAIT_MENU ||
    session.stage === "driverAwaitName"
  ) {
    result = await finalizeRegistration(text, from, session, supabase);
  } else if (session.stage === STAGES.DRIVER_AWAIT_PHOTO) {
    result = await handleDeliveryPhotoMessage(message, from, session, supabase);
  } else if (message.type === "location" && message.location) {
    await logMessage(
      from,
      "inbound",
      "location",
      `${message.location.latitude},${message.location.longitude}`,
      message.location,
    );
    result = {
      replies: {
        type: "text",
        body: `No need to share your location — just tell me what you'd like and which restaurant it's from, e.g. "rice from Munchy".`,
      },
      nextStage: null,
    };
  } else {
    if (DEBUG) console.log(`Message from ${from}: ${text}`);
    await logMessage(from, "inbound", message.type || "text", text, message);

    const availabilityReply = await handleAvailabilityCommands(
      text,
      from,
      session,
      supabase,
    );
    if (availabilityReply) {
      result = availabilityReply;
    } else if (role === "vendor") {
      const dispatchReply = await handleDispatchPayload(
        text,
        from,
        session,
        supabase,
      );
      result = dispatchReply || {
        replies: {
          type: "text",
          body: 'Reply open/close to change availability, or "menu" to manage your menu.',
        },
        nextStage: null,
        sessionData: session,
      };
    } else if (role === "driver") {
      const dispatchReply = await handleDispatchPayload(
        text,
        from,
        session,
        supabase,
      );
      result = dispatchReply || {
        replies: {
          type: "text",
          body: "Reply online/offline to toggle availability.",
        },
        nextStage: null,
        sessionData: session,
      };
    } else {
      const dispatchReply = await handleDispatchPayload(
        text,
        from,
        session,
        supabase,
      );
      result =
        dispatchReply || (await buildReply(text, senderName, session, from));
    }
  }

  const replies = result.replies;

  if (from) {
    if (result.nextStage) {
      await setSession(from, result.nextStage, result.sessionData || {});
    } else if (session.stage) {
      await deleteSession(from);
    }
  }

  if (from && replies) {
    for (const reply of Array.isArray(replies) ? replies : [replies]) {
      await sendWhatsAppMessage(from, reply);
    }
  }
}

// ============================================
// ROUTES
// ============================================

// Setup admin routes
const setupAdminRoutes = require("./lib/routes-admin");
setupAdminRoutes(app, {
  supabase,
  dispatch,
  normalizePhone,
  crypto,
  path,
  fs,
  express,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  PAYSTACK_SECRET_KEY,
  PUBLIC_URL,
  WHATSAPP_TOKEN,
  sendWhatsAppMessage,
});

// Setup webhook routes
const setupWebhookRoutes = require("./lib/routes-webhooks");
setupWebhookRoutes(app, {
  VERIFY_TOKEN,
  PAYSTACK_SECRET_KEY,
  crypto,
  isValidWhatsAppPayload,
  handleIncomingMessage,
  handlePaystackChargeSuccess,
  buildPaymentSuccessPage,
  supabase,
  ORDER_NOTIFY_NUMBER,
});

// PayStack browser callback (payment confirmation page user sees after paying)
app.get("/paystack/callback", async (req, res) => {
  const { reference } = req.query;

  if (!reference || !PAYSTACK_SECRET_KEY) {
    return res
      .status(400)
      .send(
        "<h2>Missing payment reference.</h2><p>Please return to WhatsApp.</p>",
      );
  }

  try {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
      },
    );
    const result = await response.json().catch(() => null);

    if (result?.status && result?.data?.status === "success") {
      try {
        const paymentDeps = {
          supabase,
          ORDER_NOTIFY_NUMBER,
          getVendorPrepTimeButtonsReply,
        };
        await handlePaystackChargeSuccess(
          result.data,
          supabase,
          ORDER_NOTIFY_NUMBER,
          getVendorPrepTimeButtonsReply,
        );
      } catch (error) {
        console.error(
          "handlePaystackChargeSuccess failed from /paystack/callback:",
          error,
        );
      }

      return res.send(buildPaymentSuccessPage());
    }

    return res.send(
      "<h2>⚠️ Payment not confirmed</h2><p>If you completed payment, please return to WhatsApp and wait a moment for your receipt. Contact support if it does not arrive.</p>",
    );
  } catch (error) {
    console.error(
      "Paystack callback verification failed:",
      error.message || error,
    );
    return res
      .status(500)
      .send(
        "<h2>Something went wrong.</h2><p>Please return to WhatsApp — if payment succeeded, your receipt will still arrive there.</p>",
      );
  }
});

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, () => {
  console.log(`
╭────────────────────────────────────╮
│                                    │
│    🧾 Foodie WhatsApp Bot          │
│    Listening on port ${PORT}                 │
│                                    │
╰────────────────────────────────────╯
`);
  if (!supabase)
    console.warn(
      "⚠️  Running without Supabase — chat history and persistence disabled.",
    );
  if (!GROK_API_KEY)
    console.warn("⚠️  Running without Grok API — AI-powered replies disabled.");
  if (!PAYSTACK_SECRET_KEY)
    console.warn("⚠️  Running without Paystack — payment processing disabled.");
});
