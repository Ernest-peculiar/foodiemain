require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const dispatch = require('./lib/order-dispatch');
const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
if (!/^https:\/\//i.test(PUBLIC_URL) || /localhost|127\.0\.0\.1/i.test(PUBLIC_URL)) {
  console.warn(
    `⚠️  PUBLIC_URL is "${PUBLIC_URL}" — this is the URL WhatsApp's servers use to fetch images you send, `
    + `and they can't reach localhost or a plain http:// address. Local images will silently fail to display `
    + `until PUBLIC_URL is set (in your .env) to a real public HTTPS URL — your deployed domain, or an https `
    + `tunnel like ngrok during local dev.`
  );
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DEBUG = process.env.DEBUG === 'true';
// WhatsApp number (E.164, e.g. 2348012345678) that gets notified when an order
// comes in. NOTE: WhatsApp's Business API only allows free-form messages to a
// number that has messaged the bot within the last 24h, or via an approved
// template. In practice this should be a staff/admin line that has an open
// session with the bot (or a template message — see sendOrderNotification()).
const ORDER_NOTIFY_NUMBER = process.env.ORDER_NOTIFY_NUMBER;

// Supabase persistence: conversation stage/session state + a full inbound/
// outbound chat log. Use the SERVICE ROLE key here (never the anon key) since
// this runs server-side and needs to bypass RLS to write on behalf of any
// user. See supabase-schema.sql for the tables this expects.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

if (!supabase) {
  console.warn('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — falling back to in-memory sessions, and chat history will NOT be saved.');
}

// In-memory fallback only used when Supabase isn't configured (e.g. local dev
// without a project set up yet). When Supabase IS configured it is the single
// source of truth for session state — see getSession/setSession/deleteSession.
const sessions = new Map();
// In-memory fallback for long-term profiles (see getProfile/saveProfile).
const profiles = new Map();

// Centralizing stage names avoids typo bugs like 'askLastmeal' vs 'askLastMeal'
// scattered across the file.
const STAGES = {
  ASK_LAST_MEAL: 'askLastMeal',
  ASK_MOOD: 'askMood',
  ASK_HEALTH_GOALS: 'askHealthGoals',
  AWAIT_LOCATION: 'awaitLocation',
  // Ordering flow: location -> pick a restaurant -> pick a menu item -> qty -> address -> payment.
  ORDER_AWAIT_LOCATION: 'orderAwaitLocation',
  ORDER_SELECT_RESTAURANT: 'orderSelectRestaurant',
  ORDER_SELECT_COMBO: 'orderSelectCombo',
  ORDER_ENTER_QTY: 'orderEnterQty',
  // New: exact delivery address must be collected before we ever generate a
  // Paystack payment link, so a rider actually has somewhere to deliver to.
  ORDER_AWAIT_ADDRESS: 'orderAwaitAddress',
  VENDOR_AWAIT_MENU: 'vendorAwaitMenu',
  // Rider (driver) onboarding: name -> photo (must be taken live in WhatsApp,
  // not picked from gallery) -> vehicle type. Kept as three distinct stages
  // so a stray "hi" mid-registration can resume at the right step.
  DRIVER_REG_AWAIT_PHOTO: 'driverRegAwaitPhoto',
  DRIVER_AWAIT_VEHICLE_TYPE: 'driverAwaitVehicleType',
  // Delivery-proof-of-drop-off photo, requested at the END of a completed
  // delivery. Deliberately a different stage name from the registration
  // photo above — they must never share a name or a stray registration photo
  // could get attached to an in-flight delivery, or vice versa.
  DRIVER_AWAIT_PHOTO: 'driverAwaitPhoto'
};

// Human-readable labels for each stage, used when we ask a returning user
// whether they'd like to resume a flow they left mid-way ("You were in the
// middle of picking a meal combo — resume or start over?").
const STAGE_LABELS = {
  [STAGES.ASK_LAST_MEAL]: 'telling me what you last ate',
  [STAGES.ASK_MOOD]: 'picking a mood',
  [STAGES.ASK_HEALTH_GOALS]: 'sharing your health goals',
  [STAGES.AWAIT_LOCATION]: 'sharing your location for vendor recommendations',
  [STAGES.ORDER_AWAIT_LOCATION]: 'sharing your location to order',
  [STAGES.ORDER_SELECT_RESTAURANT]: 'picking a restaurant',
  [STAGES.ORDER_SELECT_COMBO]: 'picking a meal combo',
  [STAGES.ORDER_ENTER_QTY]: 'entering a quantity',
  [STAGES.ORDER_AWAIT_ADDRESS]: 'entering your delivery address',
  [STAGES.DRIVER_REG_AWAIT_PHOTO]: 'sending your rider photo',
  [STAGES.DRIVER_AWAIT_VEHICLE_TYPE]: 'picking your vehicle type'
};

// Single source of truth for mood text -> category, replacing the old duplicated
// getMoodCategory()/moodMapping split where one was dead code and they disagreed.
const MOOD_KEYWORDS = {
  light: 'light',
  heavy: 'heavy',
  filling: 'heavy',
  healthy: 'healthy',
  spicy: 'spicy',
  pepper: 'spicy',
  hot: 'spicy',
  affordable: 'affordable',
  budget: 'affordable',
  cheap: 'affordable',
  economy: 'affordable',
  surprise: 'surprise',
  anything: 'surprise',
  whatever: 'surprise',
  soup: 'healthy',
  salad: 'healthy',
  grilled: 'healthy',
  protein: 'healthy'
};

function mapMoodToCategory(userMoodText, fallback = 'light') {
  const normalized = (userMoodText || '').toLowerCase();
  for (const [keyword, category] of Object.entries(MOOD_KEYWORDS)) {
    if (normalized.includes(keyword)) return category;
  }
  return fallback;
}

// localImage is unused for now (mood recommendations are text-only, see
// buildMoodReply) but kept in case per-dish images get added back here too —
// same local-file-only convention as ORDER_COMBOS, no external URLs.
const MOOD_CATALOG = {
  light: [
    { name: 'Moi Moi & Pap', description: 'Steamed bean pudding with fermented corn porridge', tags: ['Healthy', 'Light', 'Affordable'], kcal: 280, localImage: 'moi-moi-pap.jpg' },
    { name: 'Akara & Fried Plantain', description: 'Crispy bean fritters with sweet fried plantain', tags: ['Light', 'Affordable'], kcal: 310, localImage: 'akara-plantain.jpg' },
    { name: 'Grilled Fish Salad', description: 'Grilled fish over a fresh salad with light Nigerian flavors', tags: ['Light', 'Healthy'], kcal: 340, localImage: 'grilled-fish-salad.jpg' },
    { name: 'Steamed Veg & Lean Protein', description: 'Steamed vegetables with a lean protein of choice', tags: ['Healthy', 'Light'], kcal: 320, localImage: 'steamed-veg-protein.jpg' },
    { name: 'Fruit & Nut Bowl', description: 'Fresh fruit and nut bowl with a ginger syrup drizzle', tags: ['Light', 'Healthy'], kcal: 250, localImage: 'fruit-nut-bowl.jpg' }
  ],
  heavy: [
    { name: 'Pounded Yam & Egusi', description: 'Rich, comforting egusi soup with pounded yam', tags: ['Heavy', 'Filling'], kcal: 750, localImage: 'pounded-yam-egusi.jpg' },
    { name: 'Oha Soup & Fufu', description: 'Wholesome oha soup with fufu and deep, savory flavor', tags: ['Heavy', 'Filling'], kcal: 700, localImage: 'oha-soup-fufu.jpg' },
    { name: 'Ogbono & Eba', description: 'Thick ogbono soup with eba — very satisfying', tags: ['Heavy'], kcal: 680, localImage: 'ogbono-eba.jpg' },
    { name: 'Fried Rice & Chicken Stew', description: 'Loaded fried rice served with chicken stew', tags: ['Heavy', 'Filling'], kcal: 620, localImage: 'fried-rice-chicken-stew.jpg' },
    { name: 'Suya Platter', description: 'Bold, hearty suya platter with spicy beef', tags: ['Heavy', 'Spicy'], kcal: 590, localImage: 'suya-platter.jpg' }
  ],
  healthy: [
    { name: 'Grilled Fish & Greens', description: 'Grilled fish with steamed greens — protein-rich', tags: ['Healthy'], kcal: 380, localImage: 'grilled-fish-greens.jpg' },
    { name: 'Okra Soup & Light Swallow', description: 'Okra soup with fish and a light swallow', tags: ['Healthy'], kcal: 420, localImage: 'okra-soup.jpg' },
    { name: 'Boiled Plantain & Lean Stew', description: 'Balanced, wholesome boiled plantain with lean stew', tags: ['Healthy'], kcal: 400, localImage: 'boiled-plantain-stew.jpg' },
    { name: 'Vegetable Soup & Lean Protein', description: 'Fresh vegetable soup with a lean protein', tags: ['Healthy'], kcal: 410, localImage: 'vegetable-soup.jpg' },
    { name: 'Fruit Bowl & Honey', description: 'Natural, energizing fruit bowl with nuts and honey', tags: ['Healthy', 'Light'], kcal: 260, localImage: 'fruit-bowl-honey.jpg' }
  ],
  spicy: [
    { name: 'Suya', description: 'Smoky suya with onions and chili — a spicy classic', tags: ['Spicy'], kcal: 480, localImage: 'suya.jpg' },
    { name: 'Pepper Soup', description: 'Hearty, warming pepper soup with meat', tags: ['Spicy', 'Heavy'], kcal: 440, localImage: 'pepper-soup.jpg' },
    { name: 'Spicy Jollof Rice', description: 'Bold, flavorful jollof rice with extra pepper', tags: ['Spicy'], kcal: 520, localImage: 'spicy-jollof-rice.jpg' },
    { name: 'Peppered Goat Meat', description: 'Intensely flavored peppered goat meat', tags: ['Spicy', 'Heavy'], kcal: 500, localImage: 'peppered-goat-meat.jpg' },
    { name: 'Scotch Bonnet Stew', description: 'Fiery hot stew with extra scotch bonnet pepper', tags: ['Spicy'], kcal: 460, localImage: 'scotch-bonnet-stew.jpg' }
  ],
  affordable: [
    { name: 'Beans & Plantain', description: 'Budget-friendly, filling beans with fried plantain', tags: ['Affordable', 'Filling'], kcal: 450, localImage: 'beans-plantain.jpg' },
    { name: 'Fried Rice & Chicken', description: 'Affordable, satisfying fried rice with chicken', tags: ['Affordable'], kcal: 560, localImage: 'fried-rice-chicken.jpg' },
    { name: 'Akara & Bread', description: 'Cheap and cheerful morning meal', tags: ['Affordable', 'Light'], kcal: 340, localImage: 'akara-bread.jpg' },
    { name: 'Yam Porridge', description: 'Economical, tasty yam porridge with savory sauce', tags: ['Affordable'], kcal: 500, localImage: 'yam-porridge.jpg' },
    { name: 'Rice & Stew', description: 'Classic, affordable rice and stew combo', tags: ['Affordable'], kcal: 530, localImage: 'rice-stew.jpg' }
  ]
};

function formatFoodCaption(item, basePrefix) {
  const tagLine = item.tags.join(' • ');
  return `${basePrefix}*${item.name}*\n${item.description}\n🏷 ${tagLine} — ~${item.kcal} kcal`;
}

// "Surprise" has no catalog entry of its own — it pulls a random handful from
// across every other category. (Previously this fell through to the generic
// "no items found" text with no image at all — that was the bug.)
function getSurpriseItems(count = 3) {
  const allItems = Object.values(MOOD_CATALOG).flat();
  const shuffled = [...allItems].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// Google Places gives us real restaurants but no real per-restaurant menus, so
// for ordering we offer this curated dish list against whichever restaurant the
// user picks. Deduped by name and given a stable index (object literal key
// order is preserved in JS) so 'item_<idx>' ids stay consistent between the
// menu list message and the reply that comes back.
const ORDER_MENU_ITEMS = (() => {
  const seen = new Set();
  const items = [];
  for (const [category, categoryItems] of Object.entries(MOOD_CATALOG)) {
    for (const item of categoryItems) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      items.push({ ...item, category });
    }
  }
  return items;
})();

function getOrderMenuItemByIndex(idx) {
  return ORDER_MENU_ITEMS[idx];
}

// localImage: drop a matching file into public/images/ — this is now the
// ONLY image source (see resolveImageUrl()). No external URL fallback: if
// the file isn't there, the combo is sent as text instead of a mismatched
// stock photo.
const ORDER_COMBOS = [
  { title: 'Plain Rice', description: 'Steamed rice with tomato stew and salad', category: 'Rice', price: 1500, localImage: 'combo-plain-rice.jpg' },
  { title: 'Rice & Beans', description: 'Rice served with beans and plantain', category: 'Rice & Beans', price: 1700, localImage: 'combo-rice-beans.jpg' },
  { title: 'Rice & Meat', description: 'Rice with chicken stew and a side of greens', category: 'Rice & Meat', price: 2200, localImage: 'combo-rice-meat.jpg' },
  { title: 'Rice, Meat & Fanta', description: 'Rice, meat stew, and Fanta to wash it down', category: 'Rice Combos', price: 2800, localImage: 'combo-rice-meat-fanta.jpg' }
];

// Loose mapping from our mood/category buckets (light, heavy, healthy, spicy,
// affordable, surprise) to Geoapify's place-category taxonomy
// (https://apidocs.geoapify.com/docs/places/#categories). Geoapify/OSM has no
// true "spicy" or "light" category, so this is a best-effort bias toward
// vendor *types* more likely to serve that kind of food (e.g. affordable ->
// fast food, healthy -> cafe/vegetarian) — not a menu-level guarantee.
const MOOD_PLACE_CATEGORIES = {
  light: 'catering.cafe,catering.fast_food,catering.restaurant',
  heavy: 'catering.restaurant,catering.fast_food',
  healthy: 'catering.restaurant.vegetarian,catering.cafe,catering.restaurant',
  spicy: 'catering.restaurant,catering.fast_food',
  affordable: 'catering.fast_food,catering.cafe',
  surprise: 'catering.restaurant,catering.fast_food,catering.cafe'
};
const DEFAULT_PLACE_CATEGORIES = 'catering.restaurant,catering.fast_food,catering.cafe';

function parseEmail(text) {
  const match = (text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function isValidWhatsAppPayload(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.object !== 'whatsapp_business_account') return true;
  return Array.isArray(body.entry) && body.entry.every((entry) => Array.isArray(entry.changes));
}

async function getVendorRecordByPhone(phone) {
  if (!supabase || !phone) return null;
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('phone', normalizePhone(phone))
    .maybeSingle();

  if (error) {
    console.error('Vendor lookup failed:', error.message);
    return null;
  }
  return data;
}

async function getDriverRecordByPhone(phone) {
  if (!supabase || !phone) return null;
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('phone', normalizePhone(phone))
    .maybeSingle();

  if (error) {
    console.error('Driver lookup failed:', error.message);
    return null;
  }
  return data;
}

// Looks up a registered vendor by name. Tries an exact (case-insensitive)
// match first; if that finds nothing, falls back to a partial/contains
// match so small differences in spacing, punctuation, or a missing word
// (e.g. customer types "Silvers Bites" but she registered as "Silver's
// Bites", or "Silver's Bites Restaurant") don't silently fail to reach her.
// If the partial match is ambiguous (more than one vendor matches), we
// deliberately do NOT guess — better to fall back to the generic flow than
// to notify the wrong vendor.
async function findVendorByName(candidateName) {
  if (!supabase || !candidateName) return null;
  const trimmed = candidateName.trim();
  if (!trimmed) return null;

  try {
    const { data: exactMatch, error: exactError } = await supabase
      .from('vendors')
      .select('*')
      .ilike('name', trimmed)
      .maybeSingle();
    if (!exactError && exactMatch) return exactMatch;

    const { data: partialMatches, error: partialError } = await supabase
      .from('vendors')
      .select('*')
      .ilike('name', `%${trimmed}%`)
      .limit(5);

    if (partialError) {
      console.error('Vendor partial lookup failed:', partialError.message);
      return null;
    }
    if (partialMatches && partialMatches.length === 1) {
      return partialMatches[0];
    }
    if (partialMatches && partialMatches.length > 1) {
      console.warn(`Vendor name "${trimmed}" matched multiple registered vendors (${partialMatches.map(v => v.name).join(', ')}) — skipping auto-select to avoid notifying the wrong one.`);
    }
  } catch (e) {
    console.error('Vendor lookup failed:', e?.message || e);
  }
  return null;
}

async function resolveSenderRole(phone) {
  if (!phone) return 'customer';
  const vendor = await getVendorRecordByPhone(phone);
  if (vendor) return 'vendor';
  const driver = await getDriverRecordByPhone(phone);
  if (driver) return 'driver';
  return 'customer';
}

async function handleAvailabilityCommands(text, phone, session) {
  const normalized = (text || '').trim().toLowerCase();

  if (normalized === 'online' || normalized === 'offline') {
    const isOnline = normalized === 'online';
    const driver = await dispatch.setDriverAvailability(supabase, normalizePhone(phone), isOnline);
    const body = driver
      ? (isOnline ? 'You are now online and will receive delivery requests.' : 'You are now offline and will not receive new delivery requests.')
      : 'I could not update your availability right now.';

    return {
      replies: { type: 'text', body },
      nextStage: null,
      sessionData: session
    };
  }

  if (normalized === 'open' || normalized === 'close') {
    const isOpen = normalized === 'open';
    const vendor = await dispatch.setVendorAvailability(supabase, normalizePhone(phone), isOpen);
    const body = vendor
      ? (isOpen ? 'Your restaurant is now open for new orders.' : 'Your restaurant is now closed for new orders.')
      : 'I could not update your availability right now.';

    return {
      replies: { type: 'text', body },
      nextStage: null,
      sessionData: session
    };
  }

  return null;
}

async function handleRegistrationFlow(text, phone, session) {
  let normalized = (text || '').trim().toLowerCase();
  if (normalized === 'register_vendor') normalized = 'register vendor';
  if (normalized === 'register_driver') normalized = 'register driver';

  if (normalized !== 'register vendor' && normalized !== 'register driver') {
    return null;
  }

  if (normalized === 'register vendor') {
    const vendorRecord = await getVendorRecordByPhone(phone);
    if (vendorRecord) {
      return {
        replies: { type: 'text', body: `You are already registered as a vendor. Reply with open/close for availability.` },
        nextStage: null,
        sessionData: session
      };
    }

    return {
      replies: [
        { type: 'text', body: 'Great — I can register your restaurant. What is your restaurant name?' }
      ],
      nextStage: 'vendorAwaitName',
      sessionData: { ...session, registrationRole: 'vendor' }
    };
  }

  const driverRecord = await getDriverRecordByPhone(phone);
  if (driverRecord) {
    return {
      replies: { type: 'text', body: `You are already registered as a driver. Reply with online/offline to manage availability.` },
      nextStage: null,
      sessionData: session
    };
  }

  return {
    replies: [
      { type: 'text', body: 'Great — I can register you as a driver. What is your full name?' }
    ],
    nextStage: 'driverAwaitName',
    sessionData: { ...session, registrationRole: 'driver' }
  };
}

// Handles the free-text steps of registration. For vendors that's just
// name -> menu (unchanged). For drivers, ONLY the name is collected here —
// the name step now hands off to a photo step and then a vehicle-type step
// (see handleDriverRegistrationPhoto / handleDriverVehicleType below) before
// a driver row is actually created.
async function finalizeRegistration(text, phone, session) {
  const role = session.registrationRole;
  const name = (text || '').trim();
  if (!role || !name) {
    return null;
  }

  if (role === 'vendor') {
    if (session.stage === 'vendorAwaitName') {
      if (!name) return null;
      return {
        replies: {
          type: 'text',
          body: 'Nice! Now send your restaurant menu as text. You can list one item per line with optional prices, use commas, or send a short menu description. Example:\nRice & Beans - 1500\nEgusi Soup - 1800\nChicken Sandwich - 1200'
        },
        nextStage: STAGES.VENDOR_AWAIT_MENU,
        sessionData: { ...session, registrationRole: 'vendor', vendorName: name }
      };
    }

    const menuText = name;
    const vendorName = session.vendorName;
    if (!vendorName || !menuText) {
      return {
        replies: {
          type: 'text',
          body: 'Please tell me your restaurant name first, then send your menu.'
        },
        nextStage: 'vendorAwaitName',
        sessionData: { ...session, registrationRole: 'vendor', vendorName: null }
      };
    }

    // Validate that the supplied menu includes prices for each item.
    const parsed = parseVendorMenu(menuText || '');
    const allHavePrices = parsed.length > 0 && parsed.every((it) => it.price !== null);
    if (!allHavePrices) {
      return {
        replies: {
          type: 'text',
          body: 'Please include prices for each menu item (e.g. "Rice & Beans - 1500"). Send your menu again with prices per line or comma-separated.'
        },
        nextStage: STAGES.VENDOR_AWAIT_MENU,
        sessionData: { ...session, registrationRole: 'vendor', vendorName }
      };
    }

    const vendor = await dispatch.upsertVendor(supabase, {
      phone: normalizePhone(phone),
      name: vendorName,
      menu: menuText,
      isActive: true,
      isOpen: true
    });
    return {
      replies: {
        type: 'text',
        body: `✅ Registered ${vendorName} as a vendor. Reply open/close to toggle availability.`
      },
      nextStage: null,
      sessionData: { ...session, registrationRole: null, vendorName: null }
    };
  }

  // Driver: name step only. We do NOT upsert a driver record yet — that only
  // happens once we also have a photo and a vehicle type.
  if (session.stage === 'driverAwaitName') {
    return {
      replies: {
        type: 'text',
        body: `Thanks, ${name}! 📸 Now *take a photo of yourself right now using WhatsApp's camera* — tap the camera icon in this chat and snap it live. Please don't send a photo from your gallery; this is how riders get identified.`
      },
      nextStage: STAGES.DRIVER_REG_AWAIT_PHOTO,
      sessionData: { ...session, registrationRole: 'driver', driverName: name }
    };
  }

  return null;
}

async function handleDispatchPayload(payload, phone, session) {
  const normalized = (payload || '').trim();

  const acceptMatch = normalized.match(/^vendor_accept_([0-9a-f-]+)_(\d+)$/i);
  if (acceptMatch) {
    const [, orderId, prepMinutes] = acceptMatch;
    const vendor = await getVendorRecordByPhone(phone);
    if (!vendor) {
      return {
        replies: { type: 'text', body: 'Only a registered vendor can accept this order.' },
        nextStage: null,
        sessionData: session
      };
    }

    const updatedOrder = await dispatch.vendorAcceptOrder(supabase, orderId, vendor.id, Number(prepMinutes));
    if (!updatedOrder) {
      return {
        replies: { type: 'text', body: 'That order is no longer available.' },
        nextStage: null,
        sessionData: session
      };
    }

    const customerPhone = updatedOrder.customer_phone;
    const customerMessage = customerPhone
      ? { type: 'text', body: `✅ ${updatedOrder.restaurant_name || 'Your restaurant'} accepted your order. Estimated prep time: ${prepMinutes} minutes.` }
      : null;

    if (customerPhone && customerMessage) {
      await sendWhatsAppMessage(customerPhone, customerMessage);
    }

    // Pickup details for the driver — pulled from the vendor's own record
    // (the same one used to authorize this accept action) rather than from
    // the order row, so we don't need a separate restaurant-address column
    // on `orders` just to notify a rider where to go.
    const pickupName = updatedOrder.restaurant_name || vendor.name || 'the restaurant';
    const pickupAddress = vendor.vicinity || vendor.address || null;
    const pickupPhone = vendor.phone ? normalizePhone(vendor.phone) : null;

    const availableDrivers = await dispatch.findAvailableDrivers(supabase);
    if (availableDrivers.length > 0) {
      for (const driver of availableDrivers) {
        const driverMessage = {
          type: 'text',
          body: `🚚 New delivery request (Order ${updatedOrder.id})\n`
              + `Pick up from: *${pickupName}*`
              + (pickupAddress ? `\n📍 ${pickupAddress}` : '\n📍 Pickup address not on file — confirm with the vendor')
              + (pickupPhone ? `\n📞 ${pickupPhone}` : '')
        };
        await sendWhatsAppMessage(driver.phone, driverMessage);
        await sendWhatsAppMessage(driver.phone, getDriverAcceptButtonsReply(updatedOrder.id));
      }
      await sendWhatsAppMessage(customerPhone || phone, { type: 'text', body: '✅ Your order was accepted. We have broadcast it to nearby drivers.' });
    } else {
      await sendWhatsAppMessage(customerPhone || phone, { type: 'text', body: '✅ Your order was accepted. We are waiting for a driver to become available.' });
    }

    return {
      replies: { type: 'text', body: `Order accepted. Estimated prep time: ${prepMinutes} minutes.` },
      nextStage: null,
      sessionData: session
    };
  }

  const rejectMatch = normalized.match(/^vendor_reject_([0-9a-f-]+)$/i);
  if (rejectMatch) {
    const [, orderId] = rejectMatch;
    const vendor = await getVendorRecordByPhone(phone);
    if (!vendor) {
      return {
        replies: { type: 'text', body: 'Only a registered vendor can reject this order.' },
        nextStage: null,
        sessionData: session
      };
    }

    const updatedOrder = await dispatch.vendorRejectOrder(supabase, orderId, vendor.id);
    if (!updatedOrder) {
      return {
        replies: { type: 'text', body: 'That order is no longer available.' },
        nextStage: null,
        sessionData: session
      };
    }

    if (updatedOrder.customer_phone) {
      await sendWhatsAppMessage(updatedOrder.customer_phone, { type: 'text', body: '❌ The restaurant is unable to fulfill your order right now.' });
    }

    return {
      replies: { type: 'text', body: 'Order rejected.' },
      nextStage: null,
      sessionData: session
    };
  }

  const acceptMatchDriver = normalized.match(/^driver_accept_([0-9a-f-]+)$/i);
  if (acceptMatchDriver) {
    const [, orderId] = acceptMatchDriver;
    const driver = await getDriverRecordByPhone(phone);
    if (!driver) {
      return {
        replies: { type: 'text', body: 'Only a registered driver can accept this order.' },
        nextStage: null,
        sessionData: session
      };
    }

    const result = await dispatch.assignDriverToOrder(supabase, orderId, driver.id);
    if (!result.ok) {
      return {
        replies: { type: 'text', body: 'That delivery is no longer available.' },
        nextStage: null,
        sessionData: session
      };
    }

    const { data: orderRow, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (!error && orderRow) {
      if (orderRow.customer_phone) {
        await sendWhatsAppMessage(orderRow.customer_phone, {
          type: 'text',
          body: `🚚 ${driver.name} has accepted your order and is on the way.`
        });
      }

      if (orderRow.vendor_id) {
        const { data: vendorRecord, error: vendorError } = await supabase
          .from('vendors')
          .select('*')
          .eq('id', orderRow.vendor_id)
          .maybeSingle();

        const caption = `✅ ${driver.name} has accepted the delivery and is on the way to pick up the order.`;
        const vendorTarget = (vendorRecord && vendorRecord.phone) ? vendorRecord.phone : ORDER_NOTIFY_NUMBER;

        if (vendorTarget) {
          // Build caption with additional driver info
          const infoCaption = `${caption}\n\nRider: ${driver.name || 'Unknown'}${driver.vehicle_type ? `\nVehicle: ${driver.vehicle_type}` : ''}${driver.phone ? `\nPhone: ${driver.phone}` : ''}`;
          if (driver.photo_url) {
            await sendWhatsAppMessage(vendorTarget, {
              type: 'image',
              imageUrl: driver.photo_url,
              caption: infoCaption
            });
          } else {
            await sendWhatsAppMessage(vendorTarget, { type: 'text', body: infoCaption });
          }
        } else {
          console.warn('No vendor phone or ORDER_NOTIFY_NUMBER configured; cannot notify vendor of driver assignment.');
        }
      }
    }

    return {
      replies: { type: 'text', body: '✅ You accepted the delivery. Please update status when you pick up the order.' },
      nextStage: null,
      sessionData: session
    };
  }

  const pickupMatch = normalized.match(/^driver_pickup_([0-9a-f-]+)$/i);
  if (pickupMatch) {
    const [, orderId] = pickupMatch;
    const driver = await getDriverRecordByPhone(phone);
    if (!driver) {
      return {
        replies: { type: 'text', body: 'Only a registered driver can update that order.' },
        nextStage: null,
        sessionData: session
      };
    }

    const updatedOrder = await dispatch.markOrderPickedUp(supabase, orderId, driver.id);
    if (!updatedOrder) {
      return {
        replies: { type: 'text', body: 'That order could not be updated.' },
        nextStage: null,
        sessionData: session
      };
    }

    const reply = [
      { type: 'text', body: '🚚 Order marked as picked up.' },
      getDriverDeliveryButtonsReply(orderId)
    ];

    if (updatedOrder.customer_phone) {
      await sendWhatsAppMessage(updatedOrder.customer_phone, { type: 'text', body: '🚚 Your order has been picked up and is on the way.' });
    }

    return {
      replies: reply,
      nextStage: null,
      sessionData: session
    };
  }

  const deliverMatch = normalized.match(/^driver_deliver_([0-9a-f-]+)$/i);
  if (deliverMatch) {
    const [, orderId] = deliverMatch;
    const driver = await getDriverRecordByPhone(phone);
    if (!driver) {
      return {
        replies: { type: 'text', body: 'Only a registered driver can complete that delivery.' },
        nextStage: null,
        sessionData: session
      };
    }

    const updatedOrder = await dispatch.markOrderDelivered(supabase, orderId, driver.id);
    if (!updatedOrder) {
      return {
        replies: { type: 'text', body: 'That order could not be marked delivered.' },
        nextStage: null,
        sessionData: session
      };
    }

    if (updatedOrder.customer_phone) {
      await sendWhatsAppMessage(updatedOrder.customer_phone, { type: 'text', body: '✅ Your order has been delivered. Thank you for ordering with us.' });
    }

    return {
      replies: [
        { type: 'text', body: '✅ Delivery completed. Send a photo for proof of delivery, or reply with skip.' }
      ],
      nextStage: STAGES.DRIVER_AWAIT_PHOTO,
      sessionData: { ...session, pendingPhotoOrderId: orderId }
    };
  }

  return null;
}

async function handleDeliveryPhotoMessage(message, phone, session) {
  const orderId = session.pendingPhotoOrderId;
  const driver = await getDriverRecordByPhone(phone);

  if (!orderId || !driver) {
    return {
      replies: { type: 'text', body: 'I could not attach a delivery photo to that order.' },
      nextStage: null,
      sessionData: session
    };
  }

  if (message.type === 'image' && message.image?.id) {
    try {
      const mediaUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${message.image.id}`;
      const mediaResponse = await fetch(mediaUrl, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });
      const buffer = Buffer.from(await mediaResponse.arrayBuffer());
      const photoUrl = await dispatch.uploadDeliveryPhoto(supabase, orderId, buffer, message.image.mime_type || 'image/jpeg', `delivery-${orderId}.jpg`);
      await dispatch.updateOrderStatus(supabase, orderId, { delivery_photo_url: photoUrl });
      return {
        replies: { type: 'text', body: '📷 Delivery photo saved for proof of delivery.' },
        nextStage: null,
        sessionData: { ...session, pendingPhotoOrderId: null }
      };
    } catch (error) {
      console.error('Failed to upload delivery photo:', error);
      return {
        replies: { type: 'text', body: 'I could not save that photo right now.' },
        nextStage: null,
        sessionData: { ...session, pendingPhotoOrderId: null }
      };
    }
  }

  if ((message.text?.body || '').trim().toLowerCase() === 'skip') {
    return {
      replies: { type: 'text', body: 'No delivery photo attached.' },
      nextStage: null,
      sessionData: { ...session, pendingPhotoOrderId: null }
    };
  }

  return {
    replies: { type: 'text', body: 'Send a photo for proof of delivery, or reply with skip.' },
    nextStage: STAGES.DRIVER_AWAIT_PHOTO,
    sessionData: session
  };
}

// --- Driver (rider) onboarding: photo + vehicle type ------------------------
// Registration flow is: name (handled in finalizeRegistration above) ->
// photo (this step) -> vehicle type (next step) -> driver row created.
//
// IMPORTANT — things this file cannot do on its own:
// 1. WhatsApp's webhook payload for an image message does NOT indicate
//    whether the photo was taken live with the in-chat camera or picked
//    from the device gallery — that distinction isn't exposed by the API.
//    So "must be taken on WhatsApp" is enforced by instruction only (the
//    prompt text below), not verified technically.
// 2. This calls dispatch.uploadDriverPhoto(...), which must exist in
//    lib/order-dispatch.js (mirroring the existing uploadDeliveryPhoto).
//    Example implementation, assuming a public `driver-photos` Storage
//    bucket:
//
//      async function uploadDriverPhoto(supabase, phone, buffer, mimeType, filename) {
//        const { data, error } = await supabase.storage
//          .from('driver-photos')
//          .upload(`${phone}/${filename}`, buffer, { contentType: mimeType, upsert: true });
//        if (error) throw error;
//        const { data: pub } = supabase.storage.from('driver-photos').getPublicUrl(data.path);
//        return pub.publicUrl;
//      }
//
// 3. dispatch.upsertDriver(...) needs to accept and persist `photoUrl` and
//    `vehicleType`. Add `photo_url text` and `vehicle_type text` columns
//    (nullable, for existing drivers) to the `drivers` table in
//    supabase-schema.sql, and pass them through in upsertDriver's payload.
async function handleDriverRegistrationPhoto(message, phone, session) {
  if (message.type !== 'image' || !message.image?.id) {
    return {
      replies: {
        type: 'text',
        body: `📸 Please send a photo taken just now with WhatsApp's camera (tap the camera icon in this chat — not a photo from your gallery) so we can verify you.`
      },
      nextStage: STAGES.DRIVER_REG_AWAIT_PHOTO,
      sessionData: session
    };
  }

  try {
    const mediaUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${message.image.id}`;
    const mediaResponse = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
    const photoUrl = await dispatch.uploadDriverPhoto(
      supabase,
      normalizePhone(phone),
      buffer,
      message.image.mime_type || 'image/jpeg',
      `driver-${normalizePhone(phone)}-${Date.now()}.jpg`
    );

    return {
      replies: [
        { type: 'text', body: `Got it! 🚴 Last step — what do you ride?` },
        getVehicleTypeListReply()
      ],
      nextStage: STAGES.DRIVER_AWAIT_VEHICLE_TYPE,
      sessionData: { ...session, driverPhotoUrl: photoUrl }
    };
  } catch (error) {
    console.error('Failed to upload driver registration photo:', error);
    return {
      replies: { type: 'text', body: `I couldn't save that photo — please try sending it again.` },
      nextStage: STAGES.DRIVER_REG_AWAIT_PHOTO,
      sessionData: session
    };
  }
}

// Vehicle category picker. "Legedezbenz" is used verbatim as requested for
// the fourth option — rename the label (and its VEHICLE_TYPE_LABELS entries
// below) if it should read something else, e.g. "Car".
function getVehicleTypeListReply(bodyText = 'What do you ride for deliveries?') {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Choose',
        sections: [
          {
            rows: [
              { id: 'vehicle_bike', title: 'Bike' },
              { id: 'vehicle_motorcycle', title: 'Motorcycle' },
              { id: 'vehicle_bicycle', title: 'Bicycle' },
              { id: 'vehicle_legedezbenz', title: 'Legedezbenz' }
            ]
          }
        ]
      }
    }
  };
}

// Accepts either the tapped list id ("vehicle_bike") or free-typed text
// ("bike") so a driver who types instead of tapping still gets through.
const VEHICLE_TYPE_LABELS = {
  vehicle_bike: 'Bike',
  vehicle_motorcycle: 'Motorcycle',
  vehicle_bicycle: 'Bicycle',
  vehicle_legedezbenz: 'Legedezbenz',
  bike: 'Bike',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  legedezbenz: 'Legedezbenz'
};

// Final registration step: name + photo already captured on the session, now
// a vehicle type — only at this point do we actually create the driver row.
async function handleDriverVehicleType(text, name, session, shortName, phone) {
  const trimmed = (text || '').trim().toLowerCase();
  const vehicleType = VEHICLE_TYPE_LABELS[trimmed] || null;

  if (!vehicleType) {
    return {
      replies: [
        { type: 'text', body: `Please tap one of the options above 👆 to pick your vehicle type.` },
        getVehicleTypeListReply()
      ],
      nextStage: STAGES.DRIVER_AWAIT_VEHICLE_TYPE,
      sessionData: session
    };
  }

  // Without this try/catch, a DB error here (e.g. missing photo_url /
  // vehicle_type columns) throws all the way up through buildReply ->
  // handleIncomingMessage -> the /webhook handler, which has no catch of
  // its own — the request just dies and the driver never gets a reply at
  // all. Catching it here turns that into a visible error message plus a
  // log line, instead of the bot silently going quiet after "Motorcycle".
  try {
    await dispatch.upsertDriver(supabase, {
      phone: normalizePhone(phone),
      name: session.driverName,
      photoUrl: session.driverPhotoUrl || null,
      vehicleType,
      isActive: true,
      isOnline: false
    });
  } catch (error) {
    console.error('Failed to finalize driver registration:', error.message || error);
    return {
      replies: { type: 'text', body: `Something went wrong saving your registration — please try tapping your vehicle type again, or contact support if this keeps happening.` },
      nextStage: STAGES.DRIVER_AWAIT_VEHICLE_TYPE,
      sessionData: session
    };
  }

  return {
    replies: {
      type: 'text',
      body: `✅ Registered ${session.driverName} as a driver on a *${vehicleType}*. Reply online/offline to control availability.`
    },
    nextStage: null,
    sessionData: { registrationRole: null, driverName: null, driverPhotoUrl: null }
  };
}

// Pulls an explicit restaurant name out of phrasing like "order rice from
// Glamour" or "rice from Mama Put". This is a plain heuristic (looks for
// "from <name>" at the end of the message) — it can't verify the place is
// real, it just captures what the user typed so we can use it as-is.
function detectVendorNameFromText(text) {
  const match = (text || '').match(/\bfrom\s+([a-z0-9&'.\- ]{2,40})$/i);
  if (!match) return null;
  const cleaned = match[1].trim().replace(/[.?!]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

// Turns whatever casing the user typed ("glamour", "GLAMOUR") into a
// consistent display form ("Glamour") for confirmations and staff notifications.
function titleCase(str) {
  return (str || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function detectOrderFoodRequest(text) {
  if (!text) return null;
  const normalized = text.toLowerCase();
  const riceMatch = /\brice\b/.test(normalized);
  const beansMatch = /\bbeans?\b|\bbeands?\b/.test(normalized);
  const jollofMatch = /\bjollof\b/.test(normalized);
  const wantMatch = /\b(order|eat|want|need|crave|give me|feed me|serve me|meal|meals?)\b/.test(normalized);
  const negativeMatch = /\b(no|not|don't|dont|never|nothing)\b/.test(normalized);

  const items = [];
  if (riceMatch) items.push('rice');
  if (beansMatch) items.push('beans');
  if (jollofMatch) items.push('jollof');

  if (items.length === 0) {
    const match = normalized.match(/order\s+(.*)/i);
    return match ? match[1].trim() : null;
  }

  if (negativeMatch && wantMatch) return null;
  if (wantMatch || items.length > 1 || normalized.length < 20) {
    return items.join(' and ');
  }

  return null;
}

// --- Persistence (Supabase) ------------------------------------------------
// Session state (`sessions` table) drives the conversation flow and now
// survives restarts/deploys. `messages` is a full inbound/outbound chat log
// for analytics, support, and debugging. `profiles` is long-term memory that
// survives even after a flow finishes (unlike `sessions`, which is cleared),
// so we can reference a user's history ("last time you ordered...") on their
// next visit. All three degrade gracefully to in-memory Maps if Supabase
// isn't configured, so local dev without a Supabase project still works.

async function getSession(phone) {
  if (!supabase) return sessions.get(phone) || {};

  const { data, error } = await supabase
    .from('sessions')
    .select('stage, session_data')
    .eq('phone', phone)
    .maybeSingle();

  if (error) {
    console.error('Supabase getSession failed:', error.message);
    return {};
  }
  if (!data) return {};

  // IMPORTANT: `stage` (the DB column) is the source of truth. Spread
  // `session_data` FIRST and apply `stage` LAST, so a stale `stage` key that
  // may be sitting inside the session_data JSON blob (e.g. from a caller
  // doing `{ ...session, someField }` when building sessionData) can never
  // silently override the real stage. Previously this was the other way
  // round, which caused stage transitions to randomly get reverted (e.g.
  // vendors stuck being asked for their restaurant name again after they'd
  // already sent their menu).
  return { ...(data.session_data || {}), stage: data.stage || undefined };
}

async function setSession(phone, stage, sessionData = {}) {
  if (!supabase) {
    // Same fix as getSession above: apply `stage` LAST so the explicit
    // stage argument always wins over any stale `stage` key hiding inside
    // sessionData.
    sessions.set(phone, { ...sessionData, stage });
    return;
  }

  const { error } = await supabase
    .from('sessions')
    .upsert({ phone, stage, session_data: sessionData, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

  if (error) console.error('Supabase setSession failed:', error.message);
}

async function deleteSession(phone) {
  if (!supabase) {
    sessions.delete(phone);
    return;
  }

  const { error } = await supabase.from('sessions').delete().eq('phone', phone);
  if (error) console.error('Supabase deleteSession failed:', error.message);
}

// Long-term, cross-conversation memory. Unlike sessions (wiped once a flow
// completes or resets), this persists indefinitely so a returning user can be
// greeted with something useful, e.g. their last order. Requires a `profiles`
// table:
//
//   create table profiles (
//     phone text primary key,
//     data jsonb not null default '{}'::jsonb,
//     updated_at timestamptz not null default now()
//   );
//
async function getProfile(phone) {
  if (!phone) return {};
  if (!supabase) return profiles.get(phone) || {};

  const { data, error } = await supabase
    .from('profiles')
    .select('data')
    .eq('phone', phone)
    .maybeSingle();

  if (error) {
    console.error('Supabase getProfile failed:', error.message);
    return {};
  }
  return data?.data || {};
}

// Shallow-merges `patch` into whatever profile data already exists, so callers
// only need to pass the fields they're updating (e.g. { lastOrder: {...} })
// without clobbering other stored fields.
async function saveProfile(phone, patch = {}) {
  if (!phone) return;

  if (!supabase) {
    const existing = profiles.get(phone) || {};
    profiles.set(phone, { ...existing, ...patch });
    return;
  }

  const existing = await getProfile(phone);
  const merged = { ...existing, ...patch };
  const { error } = await supabase
    .from('profiles')
    .upsert({ phone, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

  if (error) console.error('Supabase saveProfile failed:', error.message);
}

// Logs one line of chat history. `payload` keeps the raw WhatsApp
// message/reply object (jsonb) alongside a flattened `body` for quick
// reading/searching. Silently no-ops if Supabase isn't configured — chat
// history is a nice-to-have, it should never block the bot from replying.
async function logMessage(phone, direction, messageType, body, payload) {
  if (!supabase) return;

  const { error } = await supabase.from('messages').insert({
    phone,
    direction,
    message_type: messageType || 'text',
    body: body || null,
    payload: payload || null
  });

  if (error) console.error('Supabase logMessage failed:', error.message);
}

app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.get('/', (req, res) => {
  res.send('Foodie WhatsApp bot is running.');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  if (DEBUG) {
    console.log('📩 WEBHOOK RECEIVED!');
    console.log(JSON.stringify(req.body, null, 2));
  }

  const body = req.body;
  if (!isValidWhatsAppPayload(body)) {
    return res.status(400).send('invalid payload');
  }

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];

        for (const message of messages) {
          try {
            await handleIncomingMessage(message, value);
          } catch (error) {
            // Safety net: never let one bad message (a DB error, a bug in a
            // stage handler, anything) crash the whole webhook request. Log
            // it loudly so it's actually visible, but always keep going —
            // otherwise the user is left staring at their phone with no
            // reply and no indication anything went wrong.
            console.error('handleIncomingMessage failed:', error);
          }
        }
      }
    }
  }

  res.sendStatus(200);
});

async function handleIncomingMessage(message, value) {
  const from = message.from;
  const senderName = value.contacts?.[0]?.profile?.name || 'Foodie friend';
  const session = await getSession(from);

  let result;

  const role = await resolveSenderRole(from);
  const text = message.text?.body
    || message.button?.payload
    || message.interactive?.button_reply?.id
    || message.interactive?.button_reply?.title
    || message.interactive?.list_reply?.id
    || message.interactive?.list_reply?.title
    || '';

  // "Register vendor" / "Register driver" are explicit, deliberate actions —
  // a button tap or a typed command — and must always be honored as a fresh
  // registration request, even if the user happens to be mid-way through
  // some other flow (including a DIFFERENT in-progress registration).
  //
  // This check must run BEFORE the stage-based routing below. Previously,
  // if a user tapped "Register vendor" (stage -> vendorAwaitName) and then
  // tapped "Register driver" by mistake, that button's payload
  // ("register_driver") wasn't recognized as a command at all — it was
  // swallowed as free text and used AS the restaurant name, corrupting the
  // vendor record ("✅ Registered register_driver as a vendor.").
  const registrationReply = await handleRegistrationFlow(text, from, session);

  if (registrationReply) {
    await logMessage(from, 'inbound', message.type || 'text', text, message);
    result = registrationReply;
  } else if (session.stage === 'vendorAwaitName' || session.stage === STAGES.VENDOR_AWAIT_MENU || session.stage === 'driverAwaitName') {
    result = await finalizeRegistration(text, from, session);
  } else if (session.stage === STAGES.DRIVER_REG_AWAIT_PHOTO) {
    // Rider onboarding photo — needs the raw `message` object (to read
    // message.image), so it's handled here rather than through the
    // text-only buildReply() path, same pattern as the delivery-proof photo
    // stage below.
    result = await handleDriverRegistrationPhoto(message, from, session);
  } else if (session.stage === STAGES.DRIVER_AWAIT_PHOTO) {
    result = await handleDeliveryPhotoMessage(message, from, session);
  } else if (message.type === 'location' && message.location) {
    const { latitude, longitude } = message.location;
    await logMessage(from, 'inbound', 'location', `${latitude},${longitude}`, message.location);

    if (session.stage === STAGES.ORDER_AWAIT_LOCATION || session.stage === STAGES.AWAIT_LOCATION) {
      // Both the direct-order flow and the mood-recommendation flow now lead
      // into the same restaurant -> menu -> qty -> address -> pay pipeline,
      // so the user can actually order and pay instead of just being shown
      // cards and a pin and left to sort it out themselves.
      result = await handleOrderLocationReceived(latitude, longitude, session);
    } else {
      // No active flow (e.g. a location shared out of the blue) — just show
      // informational vendor cards, nothing to transact against yet.
      const replies = await buildVendorLocationReply(latitude, longitude, session.selectedMood);
      result = { replies, nextStage: null };
    }
  } else {
    if (DEBUG) console.log(`Message from ${from}: ${text}`);
    await logMessage(from, 'inbound', message.type || 'text', text, message);

    const availabilityReply = await handleAvailabilityCommands(text, from, session);
    if (availabilityReply) {
      result = availabilityReply;
    } else if (role === 'vendor') {
      const dispatchReply = await handleDispatchPayload(text, from, session);
      result = dispatchReply || { replies: { type: 'text', body: 'Reply open/close to change availability.' }, nextStage: null, sessionData: session };
    } else if (role === 'driver') {
      const dispatchReply = await handleDispatchPayload(text, from, session);
      result = dispatchReply || { replies: { type: 'text', body: 'Reply online/offline to toggle availability.' }, nextStage: null, sessionData: session };
    } else {
      const dispatchReply = await handleDispatchPayload(text, from, session);
      result = dispatchReply || await buildReply(text, senderName, session, from);
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

async function askGrok(userMessage, sessionData = {}, { creative = false } = {}) {
  if (!GROK_API_KEY) {
    console.warn('Grok API key is not configured.');
    return null;
  }

  try {
    const basePrompt = `You are Foodie, a friendly Nigerian food recommendation WhatsApp bot. You help users discover what to eat based on their mood and preferences. You're knowledgeable about Nigerian cuisine and friendly.`;

    // The vendor-lookup call needs a factual, concise list, so it stays on the
    // original tight prompt. Anything the user says outside the structured
    // flow (small talk, random questions, banter) gets a livelier, more
    // creative persona instead of a flat fallback line every time.
    const systemPrompt = creative
      ? `${basePrompt} When a user says something outside the normal "what are you hungry for" flow — jokes, small talk, random questions, compliments, complaints — respond with genuine personality: be witty, warm, occasionally use light Nigerian expressions, and when it fits naturally, steer the conversation back toward food. Never repeat the same joke or phrasing twice in a row. Keep it WhatsApp-friendly (under 250 characters).`
      : `${basePrompt} Keep responses concise for WhatsApp (under 160 characters when possible). ${sessionData.mood ? `The user is interested in ${sessionData.mood} food.` : ''}`;

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROK_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROK_MODEL || 'grok',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: creative ? 1.0 : 0.7,
        max_tokens: creative ? 220 : 150
      })
    });

    if (!response.ok) {
      console.error('Grok API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error('Grok API failed:', error);
    return null;
  }
}

// --- Stage handlers -------------------------------------------------------
// Each handler takes (text, name, session) and returns { replies, nextStage, sessionData? }.
// Keeping these separate (instead of one long if/else chain) makes each step
// independently testable and keeps stage-specific logic from leaking into others.

const STATIC_GREETING = `Hi! I'm *Foodie* — your personal Nigerian food guide. Tell me you're hungry and I'll handle the rest!`;

// Buttons shown to new users so they can register or order with a tap.
function getNewUserButtonsReply(bodyText = 'Get started with Foodie:') {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'register_vendor', title: 'Register vendor' } },
          { type: 'reply', reply: { id: 'register_driver', title: 'Register driver' } },
          { type: 'reply', reply: { id: 'order_now', title: 'Order now' } }
        ]
      }
    }
  };
}

// Two buttons covering the two things people actually do right after a
// greeting, so they can tap instead of typing free text.
function getGreetingButtonsReply(bodyText = 'Or tap an option below 👇') {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'hungry', title: "Order now" } },
          { type: 'reply', reply: { id: 'help', title: 'What can you do?' } }
        ]
      }
    }
  };
}

// If we have a remembered last order for this user, greet them with a
// one-tap "order that again" card instead of the generic buttons — this is
// the main way past information gets surfaced back to a returning user.
function getReorderButtonsReply(lastOrder, name = 'there') {
  const total = lastOrder.total ?? (lastOrder.qty || 1) * 0; // fallback if an older profile lacks `total`
  const bodyText = `🍔 *Welcome back, ${name}!*\nYour last order was\n*${lastOrder.vendorName}*\n${lastOrder.comboTitle} ×${lastOrder.qty}\n₦${total.toLocaleString('en-US')}\nWould you like it again?`;

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          // WhatsApp caps reply button titles at 20 characters — slice as a safety net.
          { type: 'reply', reply: { id: 'reorder_last', title: '🟢 Reorder'.slice(0, 20) } },
          { type: 'reply', reply: { id: 'browse_restaurants', title: '🍽 Browse Restaurants'.slice(0, 20) } },
          { type: 'reply', reply: { id: 'something_different', title: '❌ Something Different'.slice(0, 20) } }
        ]
      }
    }
  };
}

async function handleGreeting(seedText = 'hello', name = 'friend', profile = {}, phone) {
  // A non-empty profile means we've talked to this person before (they have
  // at least a firstSeenAt timestamp, possibly a lastOrder too) — no need to
  // re-explain who Foodie is every single time they say "hi".
  const isReturning = Object.keys(profile).length > 0;

  if (isReturning) {
    if (profile.lastOrder) {
      return { replies: [getReorderButtonsReply(profile.lastOrder, name)], nextStage: null };
    }
    return {
      replies: [
        { type: 'text', body: `Welcome back, ${name}! 👋 What are you hungry for today?` },
        getGreetingButtonsReply()
      ],
      nextStage: null
    };
  }

  // First-time user — give the exact Foodie introduction, and remember we've now
  // met them so future greetings skip straight to "welcome back".
  const grokReply = await askGrok(seedText, {}, { creative: true });
  const greetingText = `Hi ${name}, I'm *Foodie* — your personal Nigerian food guide. Tell me what you'd like to eat and I'll handle the rest!`;

  if (phone) await saveProfile(phone, { firstSeenAt: new Date().toISOString() });

  return {
    replies: [
      { type: 'text', body: greetingText },
      { type: 'text', body: grokReply || `I'm here to help you order food, find nearby restaurants, or get meal ideas.` },
      getNewUserButtonsReply()
    ],
    nextStage: null
  };
}

// Shown instead of a full reset when a returning user still has an
// interrupted flow in progress (session.stage is set). Lets them either pick
// up exactly where they stopped or explicitly wipe it and start fresh —
// previously any stray "hi" mid-flow silently deleted their progress.
function handleResumePrompt(session, shortName) {
  const label = STAGE_LABELS[session.stage] || 'something';
  return {
    replies: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `Welcome back, ${shortName}! You were in the middle of ${label}. Pick up where you left off, or start fresh?` },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'resume_flow', title: '▶️ Resume' } },
            { type: 'reply', reply: { id: 'start_over', title: '🔄 Start over' } }
          ]
        }
      }
    },
    // Crucially this reply doesn't advance or clear the session — it just
    // asks what to do, keeping everything gathered so far intact.
    nextStage: session.stage,
    sessionData: session
  };
}

// Re-sends whatever prompt/options belong to the user's current stage,
// without consuming their next message as input to that stage — used when
// they tap "Resume" from handleResumePrompt.
async function getStageResumeReply(session) {
  switch (session.stage) {
    case STAGES.ASK_LAST_MEAL:
      return { type: 'text', body: `Where were we — what did you last eat?` };
    case STAGES.ASK_MOOD:
      return [{ type: 'text', body: `What are you in the mood for?` }, getMoodButtonsReply()];
    case STAGES.ASK_HEALTH_GOALS:
      return { type: 'text', body: `Any health goals I should know about?` };
    case STAGES.AWAIT_LOCATION:
      return getLocationRequestReply();
    case STAGES.ORDER_AWAIT_LOCATION:
      return getLocationRequestReply('Share your location so I can find restaurants near you 📍');
    case STAGES.ORDER_SELECT_RESTAURANT:
      return session.nearbyVendors?.length
        ? [{ type: 'text', body: `Here's what was nearby 👇 Tap a restaurant to choose.` }, getRestaurantListReply(session.nearbyVendors)]
        : { type: 'text', body: `Which restaurant would you like to order from?` };
    case STAGES.ORDER_SELECT_COMBO:
      // Resend just the menu list — no image dump. Images are shown once a
      // specific combo is picked (see handleOrderSelectCombo).
      return [{ type: 'text', body: `Here's the menu again 👇` }, getComboListReply()];
    case STAGES.ORDER_ENTER_QTY:
      return { type: 'text', body: `How many would you like? (e.g. "2")` };
    case STAGES.ORDER_AWAIT_ADDRESS:
      return { type: 'text', body: `Please type your *exact delivery address* — street name, house number or a nearby landmark, and the area.` };
    case STAGES.DRIVER_REG_AWAIT_PHOTO:
      return { type: 'text', body: `📸 Please take a photo of yourself right now using WhatsApp's camera (not from your gallery) to continue registration.` };
    case STAGES.DRIVER_AWAIT_VEHICLE_TYPE:
      return [{ type: 'text', body: `What do you ride for deliveries?` }, getVehicleTypeListReply()];
    default:
      return { type: 'text', body: `Let's continue!` };
  }
}

function handleCapabilities() {
  return {
    replies: {
      type: 'text',
      body: `I help you: 🛒 Order food from restaurants near you 🍽️ Decide what to eat based on your mood & goals 🔄 Avoid meal repetition 🏪 Find nearby vendors selling your meal 📋 Plan weekly meals (Premium) Just say you're hungry to get started!`
    },
    nextStage: null
  };
}

// "I'm hungry" now branches two ways: order straight from a nearby restaurant,
// or go through the old mood-based recommendation flow first.
function getHungryButtonsReply(bodyText = "Want me to help you order now, or find some recommendations first?") {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'order_now', title: '🛒 Order now' } },
          { type: 'reply', reply: { id: 'recommend_meals', title: '✨ Recommend meals' } }
        ]
      }
    }
  };
}

function handleHungry() {
  return {
    replies: getHungryButtonsReply(),
    nextStage: null
  };
}

function handleRecommendMeals() {
  return {
    replies: {
      type: 'text',
      body: `Hey! 😄 What did you last eat?`
    },
    nextStage: STAGES.ASK_LAST_MEAL
  };
}

// Kicks off ordering: ask for the user's location first, then use it to pull
// real nearby restaurants via findNearbyVendors (see handleOrderLocationReceived).
function handleOrderNow() {
  return {
    replies: [
      { type: 'text', body: `Let's get you fed 🛒 First, share your location so I can show you restaurants near you.` },
      getLocationRequestReply('Share your location so I can find restaurants near you 📍')
    ],
    nextStage: STAGES.ORDER_AWAIT_LOCATION,
    sessionData: {}
  };
}

// One-tap reorder: reuse the vendor + combo from the user's remembered last
// order and skip straight to confirming a delivery address, instead of
// walking them through location -> restaurant -> combo -> qty again.
function handleReorderLast(profile) {
  const lastOrder = profile.lastOrder;
  if (!lastOrder) return handleOrderNow();

  const vendor = { name: lastOrder.vendorName, vicinity: lastOrder.vendorVicinity || 'Previously used restaurant' };

  return {
    replies: {
      type: 'text',
      body: `Great, ${lastOrder.qty} x *${lastOrder.comboTitle}* from *${vendor.name}* again 🙌\nPlease confirm the delivery address (last time: "${lastOrder.address}") — or type a new one.`
    },
    nextStage: STAGES.ORDER_AWAIT_ADDRESS,
    sessionData: {
      selectedVendor: vendor,
      selectedComboIdx: lastOrder.comboIdx,
      qty: lastOrder.qty
    }
  };
}

function handleAskLastMeal(text) {
  return {
    // Bug fix: the mood buttons were built (getMoodButtonsReply) but never sent.
    // Attaching them here means the user finally gets tappable options instead
    // of only free-text prompts.
    replies: [
      { type: 'text', body: `Got it! What are you in the mood for?` },
      getMoodButtonsReply()
    ],
    nextStage: STAGES.ASK_MOOD,
    sessionData: { lastMeal: text.trim() }
  };
}

function handleAskMood(text, name, session) {
  return {
    replies: {
      type: 'text',
      body: `Nice. Any health goals I should know about?`
    },
    nextStage: STAGES.ASK_HEALTH_GOALS,
    sessionData: { lastMeal: session.lastMeal, userMood: text.trim() }
  };
}

async function handleAskHealthGoals(text, name, session, shortName) {
  const selectedMood = mapMoodToCategory(session.userMood);
  const recommendations = await buildMoodReply(selectedMood, shortName, session.lastMeal || 'something');

  return {
    replies: [
      {
        type: 'text',
        body: `✨ Based on what you told me — here are my top picks for you:\n\n*${selectedMood.charAt(0).toUpperCase() + selectedMood.slice(1)} Nigerian Foods:*`
      },
      ...(Array.isArray(recommendations) ? recommendations : [recommendations]),
      getLocationRequestReply(`Share your location so I can find restaurants near you that serve *${selectedMood}* meals 📍`)
    ],
    // Hang on to the mood so once we get coordinates we can search for
    // vendors that actually match what was just recommended.
    nextStage: STAGES.AWAIT_LOCATION,
    sessionData: { selectedMood }
  };
}

// If the user types a place name instead of tapping "share location", try to
// geocode it rather than dead-ending the conversation. If it's not a place at
// all (random chatter), let Grok handle it in character, then re-prompt.
async function handleAwaitLocation(text, name, session) {
  const coords = await geocodeText(text);

  if (!coords) {
    const grokReply = await askGrok(text, session, { creative: true });
    const banter = grokReply ? `${grokReply}\n\n` : `I couldn't pin that location. `;
    return {
      replies: {
        type: 'text',
        body: `${banter}📍 Tap "Share location" above, or type an area name like "Lekki, Lagos".`
      },
      nextStage: STAGES.AWAIT_LOCATION,
      sessionData: { selectedMood: session.selectedMood }
    };
  }

  return buildVendorLocationReply(coords.latitude, coords.longitude, session.selectedMood, session.orderIntent);
}

// Step 1 of ordering: we have coordinates, so pull nearby restaurants (name/
// rating/vicinity only — no Place Details call yet, that's saved for the
// restaurant the user actually picks, to keep API usage down) and let them
// tap one from a list.
async function handleOrderLocationReceived(latitude, longitude, session) {
  const vendors = await findNearbyVendors(latitude, longitude, session.selectedMood, session.orderIntent);

  if (!vendors || vendors.length === 0) {
    return {
      replies: {
        type: 'text',
        body: `I couldn't find any restaurants near that location right now. Try sharing a different area, or type a place name like "Lekki, Lagos".`
      },
      nextStage: STAGES.ORDER_AWAIT_LOCATION,
      sessionData: { orderIntent: session.orderIntent }
    };
  }

  const replyText = session.orderIntent
    ? `Here's what's nearby that can serve ${session.orderIntent} 👇 Tap a restaurant to see the menu and pay.`
    : session.selectedMood
      ? `Here's where you can get *${session.selectedMood}* meals near you 👇 Tap a restaurant to see the menu and pay.`
      : `Here's what's nearby 👇 Tap a restaurant to see the menu and pay.`;

  return {
    replies: [
      { type: 'text', body: replyText },
      getRestaurantListReply(vendors)
    ],
    nextStage: STAGES.ORDER_SELECT_RESTAURANT,
    sessionData: { nearbyVendors: vendors, userLat: latitude, userLng: longitude, orderIntent: session.orderIntent }
  };
}

function getRestaurantListReply(vendors, bodyText = 'Nearby restaurants') {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Choose',
        sections: [
          {
            rows: vendors.map((v, idx) => ({
              id: `vendor_${idx}`,
              title: v.name.slice(0, 24),
              description: [v.rating ? `⭐ ${v.rating}` : null, v.vicinity].filter(Boolean).join(' · ').slice(0, 72)
            }))
          }
        ]
      }
    }
  };
}

// Step 2: restaurant picked — either tapped from the list, or typed by hand
// (e.g. the user names a place we didn't list, or didn't list one at all).
//
// FIX: this used to build the vendor object straight from the Geoapify/OSM
// result (or from raw typed text), which has nothing to do with your
// Supabase `vendors` table — so an onboarded vendor's real phone number and
// real menu were never used here, only the generic ORDER_COMBOS and
// whatever (usually empty) phone Geoapify happened to return. That's why
// vendors weren't receiving orders and their real menu wasn't showing up.
//
// Now we always check the `vendors` table for a name match first. If a
// registered vendor is found we use THEIR phone (so notifications actually
// reach them) and THEIR real menu (parsed from what they texted in at
// registration). Only if no match exists do we fall back to the
// Geoapify/typed vendor + the generic combo menu.
async function handleOrderSelectRestaurant(text, name, session) {
  const trimmed = (text || '').trim();
  const idx = parseInt(trimmed.replace('vendor_', ''), 10);
  const vendorFromList = Number.isInteger(idx) && trimmed.startsWith('vendor_') ? session.nearbyVendors?.[idx] : null;

  // Not a list tap, but they typed something meaningful — treat it as their
  // own restaurant choice rather than forcing them back to the tap-only list.
  const candidateName = vendorFromList?.name || (trimmed.length >= 2 ? titleCase(trimmed) : null);

  if (!candidateName) {
    return {
      replies: {
        type: 'text',
        body: `Please tap a restaurant from the list above 👆, or type the name of the restaurant you'd like to order from.`
      },
      nextStage: STAGES.ORDER_SELECT_RESTAURANT,
      sessionData: { nearbyVendors: session.nearbyVendors, userLat: session.userLat, userLng: session.userLng }
    };
  }

  // Always check for a matching registered vendor first, regardless of
  // whether the name came from the tapped list or free text.
  const vendorRecord = await findVendorByName(candidateName);

  if (vendorRecord && vendorRecord.menu) {
    const menuItems = parseVendorMenu(vendorRecord.menu);
    if (menuItems.length > 0) {
      const vendor = {
        name: vendorRecord.name,
        phone: vendorRecord.phone, // the real registered number — this is what was missing
        vicinity: vendorRecord.vicinity || vendorFromList?.vicinity || 'Registered restaurant'
      };

      return {
        replies: [
          { type: 'text', body: `Great pick! Here's the menu for *${vendor.name}* 👇` },
          getVendorMenuListReply(menuItems, `Menu for ${vendor.name}`)
        ],
        nextStage: STAGES.ORDER_SELECT_COMBO,
        sessionData: { selectedVendor: vendor, menuItems, userLat: session.userLat, userLng: session.userLng }
      };
    }
  }

  // No registered vendor found — fall back to the old behavior (generic
  // combo menu, whatever contact info we have from Geoapify or none at all).
  const vendor = vendorFromList || { name: candidateName, vicinity: 'Restaurant specified by customer' };

  return {
    replies: [
      { type: 'text', body: `Great pick! Here's the menu for *${vendor.name}* 👇` },
      getComboListReply()
    ],
    nextStage: STAGES.ORDER_SELECT_COMBO,
    sessionData: { selectedVendor: vendor, userLat: session.userLat, userLng: session.userLng }
  };
}

function getComboListReply(bodyText = 'Rice meal combos available') {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Choose',
        sections: [
          {
            title: 'Rice Combos',
            rows: ORDER_COMBOS.map((combo, idx) => ({
              id: `combo_${idx}`,
              title: combo.title.slice(0, 24),
              description: `${combo.description} — ₦${combo.price}`.slice(0, 72)
            }))
          }
        ]
      }
    }
  };
}

// Step 3 is two-phase, both handled by this same function (still one stage,
// ORDER_SELECT_COMBO, so a stray "hi" mid-way still resumes correctly):
//
//   3a. User taps a combo from the list (id "combo_<idx>") -> show that
//       combo's image with a body caption and a single "✅ Proceed" button
//       (id "proceed_qty_<idx>"). We stay on ORDER_SELECT_COMBO — nothing is
//       confirmed yet.
//   3b. User taps "Proceed" (id "proceed_qty_<idx>") -> now ask for quantity
//       as free text and advance to ORDER_ENTER_QTY.
//
// WhatsApp interactive "button" messages support an image header, so the
// photo and the Proceed button travel together as one message.
async function handleOrderSelectCombo(text, name, session) {
  const trimmed = (text || '').trim();

  if (trimmed.startsWith('proceed_qty_')) {
    if (trimmed.startsWith('proceed_qty_item_') && Array.isArray(session.menuItems)) {
      const idx = parseInt(trimmed.replace('proceed_qty_item_', ''), 10);
      const combo = session.menuItems[idx];
      if (!combo) {
        return {
          replies: { type: 'text', body: `Something went wrong — please pick a menu item again 👆` },
          nextStage: STAGES.ORDER_SELECT_COMBO,
          sessionData: { selectedVendor: session.selectedVendor, userLat: session.userLat, userLng: session.userLng }
        };
      }
      return {
        replies: { type: 'text', body: `*${combo.title || combo.name}* is a great choice! How many would you like? (e.g. "2")` },
        nextStage: STAGES.ORDER_ENTER_QTY,
        sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: idx, userLat: session.userLat, userLng: session.userLng }
      };
    }

    const idx = parseInt(trimmed.replace('proceed_qty_', ''), 10);
    const combo = Number.isInteger(idx) ? ORDER_COMBOS[idx] : null;

    if (!combo) {
      return {
        replies: { type: 'text', body: `Something went wrong — please pick a meal combo again 👆` },
        nextStage: STAGES.ORDER_SELECT_COMBO,
        sessionData: { selectedVendor: session.selectedVendor, userLat: session.userLat, userLng: session.userLng }
      };
    }

    return {
      replies: { type: 'text', body: `*${combo.title}* is a great choice! How many would you like? (e.g. "2")` },
      nextStage: STAGES.ORDER_ENTER_QTY,
      sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: idx, userLat: session.userLat, userLng: session.userLng }
    };
  }

  const idx = parseInt(trimmed.replace('combo_', ''), 10);
  // Support both built-in combos (`combo_<idx>`) and vendor menu items (`item_<idx>`)
  let combo = null;
  if (trimmed.startsWith('combo_')) {
    const cidx = parseInt(trimmed.replace('combo_', ''), 10);
    combo = Number.isInteger(cidx) ? ORDER_COMBOS[cidx] : null;
    if (combo) {
      // normalize selectedComboIdx to numeric index
      return {
        replies: {
          type: 'text',
          body: `*${combo.title}* is a great choice! How many would you like? (e.g. "2")`
        },
        nextStage: STAGES.ORDER_ENTER_QTY,
        sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: cidx, userLat: session.userLat, userLng: session.userLng }
      };
    }
  }

  const itemIdx = parseInt(trimmed.replace('item_', ''), 10);
  if (trimmed.startsWith('item_') && Array.isArray(session.menuItems)) {
    combo = session.menuItems[itemIdx] || null;
    if (!combo) {
      return {
        replies: { type: 'text', body: `Please tap a menu item from the list above 👆` },
        nextStage: STAGES.ORDER_SELECT_COMBO,
        sessionData: { selectedVendor: session.selectedVendor, userLat: session.userLat, userLng: session.userLng }
      };
    }

    const bodyText = `*${combo.title || combo.name}*\n${combo.description || ''}${combo.price ? `\n₦${combo.price}` : ''}`;
    const proceedButton = { type: 'reply', reply: { id: `proceed_qty_item_${itemIdx}`, title: '✅ Proceed' } };

    const reply = {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: [proceedButton] }
      }
    };

    return {
      replies: reply,
      nextStage: STAGES.ORDER_SELECT_COMBO,
      sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: itemIdx, userLat: session.userLat, userLng: session.userLng, menuItems: session.menuItems }
    };
  }
  return {
    replies: { type: 'text', body: `Please tap a meal combo from the list above 👆` },
    nextStage: STAGES.ORDER_SELECT_COMBO,
    sessionData: { selectedVendor: session.selectedVendor, userLat: session.userLat, userLng: session.userLng }
  };
}

function getOrderMenuListReply(bodyText = 'Menu') {
  const sections = {};
  ORDER_MENU_ITEMS.forEach((item, idx) => {
    const sectionTitle = item.category.charAt(0).toUpperCase() + item.category.slice(1);
    if (!sections[sectionTitle]) sections[sectionTitle] = [];
    sections[sectionTitle].push({
      id: `item_${idx}`,
      title: item.name.slice(0, 24),
      description: `${item.description} — ~${item.kcal} kcal`.slice(0, 72)
    });
  });

  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Choose',
        sections: Object.entries(sections).map(([title, rows]) => ({ title, rows }))
      }
    }
  };
}

function parseVendorMenu(menuText) {
  if (!menuText) return [];
  // Split into lines first; if single line with commas, split by commas.
  const lines = menuText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  if (lines.length === 1 && lines[0].includes(',')) {
    lines[0].split(',').forEach(part => { if (part.trim()) items.push(part.trim()); });
  } else {
    for (const l of lines) items.push(l);
  }

  // Parse each item for an optional price like "name - 1500" or "name:1500"
  return items.map((line) => {
    const match = line.match(/^(.*?)\s*[-–—:]\s*(\d+(?:\.\d+)?)$/);
    if (match) {
      return { title: match[1].trim(), description: '', price: Math.round(Number(match[2])), name: match[1].trim() };
    }
    return { title: line, description: '', price: null, name: line };
  });
}

function getVendorMenuListReply(items, bodyText = 'Menu') {
  const sections = {};
  items.forEach((item, idx) => {
    const sectionTitle = 'Menu';
    if (!sections[sectionTitle]) sections[sectionTitle] = [];
    sections[sectionTitle].push({
      id: `item_${idx}`,
      title: (item.title || item.name).slice(0, 24),
      description: ((item.description || '') + (item.price ? ` — ₦${item.price}` : '')).slice(0, 72)
    });
  });

  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Choose',
        sections: Object.entries(sections).map(([title, rows]) => ({ title, rows }))
      }
    }
  };
}

function getRoundedAmount(amount) {
  return Math.round(amount * 100);
}

async function createPaystackTransaction(email, amount) {
  if (!PAYSTACK_SECRET_KEY) return null;

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: getRoundedAmount(amount),
        currency: 'NGN',
        callback_url: `${PUBLIC_URL}/paystack/callback`
      })
    });

    if (!response.ok) return null;
    const data = await response.json();

    if (data.status && data.data) return data.data;
    return null;
  } catch (error) {
    console.error('Paystack initialize failed:', error);
    return null;
  }
}

// Step 4: quantity given. We do NOT create a Paystack link yet — we still need
// an exact delivery address, so stash the qty on the session and move to the
// address step instead of paying here.
function handleOrderEnterQty(text, name, session, shortName) {
  const combo = Array.isArray(session.menuItems) ? session.menuItems[session.selectedComboIdx] : ORDER_COMBOS[session.selectedComboIdx];
  const vendor = session.selectedVendor;
  const parsedQty = parseInt((text || '').replace(/[^0-9]/g, ''), 10);
  const qty = Number.isInteger(parsedQty) && parsedQty > 0 ? Math.min(parsedQty, 20) : 1;

  if (!combo || !vendor) {
    // Session data got lost somehow — restart the order flow cleanly.
    return handleOrderNow();
  }

  return {
    replies: {
      type: 'text',
      body: `Almost there, ${shortName}! 📍 Please type your *exact delivery address* — street name, house number or a nearby landmark, and the area (e.g. "12 Ogoja Rd, opposite GTBank, Abakaliki"). I won't generate the payment link until I have this.`
    },
    nextStage: STAGES.ORDER_AWAIT_ADDRESS,
    sessionData: {
      selectedVendor: vendor,
      selectedComboIdx: session.selectedComboIdx,
      qty,
      userLat: session.userLat,
      userLng: session.userLng,
      menuItems: session.menuItems
    }
  };
}

// Very light heuristic to nudge users toward a genuinely useful address rather
// than a one-word non-answer ("ok", "yes", "here") — this is not real address
// validation (no geocoding call), just a sanity floor before we bother
// generating a payment link and dispatching an order to staff.
function isLikelyValidAddress(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 10) return false;

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;

  const rejectPhrases = ['ok', 'okay', 'yes', 'no', 'sure', 'done', 'here', "i don't know", 'idk', 'na', 'nil'];
  if (rejectPhrases.includes(trimmed.toLowerCase())) return false;

  return true;
}

// Step 5: exact delivery address given. Only now do we talk to Paystack and
// notify staff — this is the payment gate the user asked for. We also save a
// `lastOrder` snapshot to the user's persistent profile so a future greeting
// can offer a one-tap reorder.
async function handleOrderAwaitAddress(text, name, session, shortName, phone) {
  const combo = Array.isArray(session.menuItems) ? session.menuItems[session.selectedComboIdx] : ORDER_COMBOS[session.selectedComboIdx];
  const vendor = session.selectedVendor;
  const qty = session.qty;

  if (!combo || !vendor || !qty) {
    // Session data got lost somehow — restart the order flow cleanly.
    return handleOrderNow();
  }

  if (!isLikelyValidAddress(text)) {
    return {
      replies: {
        type: 'text',
        body: `That doesn't look like a full address yet 🙏 Please include the street name, house number or a nearby landmark, and the area — e.g. "12 Ogoja Rd, opposite GTBank, Abakaliki".`
      },
      nextStage: STAGES.ORDER_AWAIT_ADDRESS,
      sessionData: {
        selectedVendor: vendor,
        selectedComboIdx: session.selectedComboIdx,
        qty,
        userLat: session.userLat,
        userLng: session.userLng,
        menuItems: session.menuItems
      }
    };
  }

  const address = text.trim();
  const email = parseEmail(text) || `${name.replace(/\s+/g, '.').toLowerCase()}@example.com`;
  const unitPrice = (combo && (combo.price || combo.price === 0)) ? Number(combo.price) : 0;
  let payment = null;
  const totalAmount = unitPrice * qty;

  let paymentMessage = '';
  if (unitPrice <= 0) {
    paymentMessage = `This restaurant has not set prices for that item. Please contact the restaurant to confirm the price before paying.`;

    // Notify vendor/admin that a customer attempted checkout but no price is set
    const vendorTarget = (vendor && vendor.phone) ? vendor.phone : ORDER_NOTIFY_NUMBER;
    const notifyBody = `⚠️ Customer ${name} attempted to order ${qty} x ${combo.title || combo.name} but no price is set for this item. Please update your menu to include prices so customers can pay.`;
    if (vendorTarget) await sendWhatsAppMessage(vendorTarget, { type: 'text', body: notifyBody });
  } else {
    payment = await createPaystackTransaction(email, unitPrice * qty);
    paymentMessage = payment
      ? `Please complete payment here: ${payment.authorization_url}`
      : `I couldn't create the payment link right now. Please try again later or contact support.`;
  }

  const orderRecord = await dispatch.createOrderRecord(supabase, {
    customerName: name,
    customerPhone: phone,
    vendor: {
      name: vendor.name,
      phone: vendor.phone || null,
      isActive: true,
      isOpen: true
    },
    restaurantName: vendor.name,
    items: [{ title: combo.title || combo.name, qty, price: unitPrice }],
    subtotal: totalAmount,
    deliveryFee: 0,
    total: totalAmount,
    deliveryAddress: address,
    status: 'pending_vendor'
  });

  await sendOrderNotification({
    customerName: name,
    item: combo,
    qty,
    vendor,
    address,
    paymentUrl: payment?.authorization_url,
    orderId: orderRecord?.id
  });

  // Remember this order (vendor, combo, qty, address, email) so a future
  // conversation can reference it — e.g. the "order that again" prompt in
  // handleGreeting, or reusing the address/email on the next checkout.
  await saveProfile(phone, {
    lastOrder: {
      vendorName: vendor.name,
      vendorVicinity: vendor.vicinity,
      comboIdx: session.selectedComboIdx,
      comboTitle: combo.title || combo.name,
      qty,
      total: (combo.price || 0) * qty,
      address,
      email,
      at: new Date().toISOString()
    }
  });

  return {
    replies: [
      {
        type: 'text',
        body: `✅ Almost done, ${shortName}!\n${qty} x *${combo.title || combo.name}* from *${vendor.name}*\nDeliver to: ${address}\nTotal: ₦${totalAmount}\n${paymentMessage}`
      },
      getPostVendorButtonsReply()
    ],
    nextStage: null
  };
}

// Sends a plain WhatsApp text to a staff/admin number so a human can relay the
// order to the vendor. See the ORDER_NOTIFY_NUMBER note near the top of this
// file — WhatsApp won't let us free-form message the restaurant itself unless
// it has an open session with this bot or we use an approved template.
async function sendOrderNotification({ customerName, item, qty, vendor, address, paymentUrl, orderId }) {
  const body = `🆕 New order from ${customerName}:\n${qty} x ${item.title || item.name}\nRestaurant: ${vendor.name} (${vendor.vicinity || 'location shared'})${address ? `\nDeliver to: ${address}` : ''}${paymentUrl ? `\nPayment: ${paymentUrl}` : ''}`;
  const recipients = [];

  if (vendor?.phone) {
    recipients.push(vendor.phone);
  }
  if (ORDER_NOTIFY_NUMBER) {
    recipients.push(ORDER_NOTIFY_NUMBER);
  }

  if (recipients.length === 0) {
    console.warn('No WhatsApp recipient is configured for the new order.');
    return;
  }

  const replies = orderId
    ? [
        { type: 'text', body },
        getVendorAcceptanceButtonsReply(orderId)
      ]
    : [{ type: 'text', body }];

  for (const recipient of recipients) {
    for (const reply of replies) {
      await sendWhatsAppMessage(recipient, reply);
    }
  }
}

// Same fallback pattern as handleAwaitLocation, but for the order flow: if the
// user types a place name instead of tapping "share location", geocode it and
// carry on to the restaurant list.
async function handleOrderAwaitLocationText(text, name, session) {
  const coords = await geocodeText(text);

  if (!coords) {
    const grokReply = await askGrok(text, session, { creative: true });
    const banter = grokReply ? `${grokReply}\n\n` : `I couldn't pin that location. `;
    return {
      replies: {
        type: 'text',
        body: `${banter}📍 Tap "Share location" above, or type an area name like "Lekki, Lagos".`
      },
      nextStage: STAGES.ORDER_AWAIT_LOCATION,
      sessionData: { orderIntent: session.orderIntent }
    };
  }

  return handleOrderLocationReceived(coords.latitude, coords.longitude, session);
}

function handleMealPlanPlaceholder() {
  return {
    replies: {
      type: 'text',
      body: `📋 Weekly meal planning is a Premium feature — coming soon! For now just tell me you're hungry and I'll help you decide, meal by meal. 😊`
    },
    nextStage: null
  };
}

const STAGE_HANDLERS = {
  [STAGES.ASK_LAST_MEAL]: handleAskLastMeal,
  [STAGES.ASK_MOOD]: handleAskMood,
  [STAGES.ASK_HEALTH_GOALS]: handleAskHealthGoals,
  [STAGES.AWAIT_LOCATION]: handleAwaitLocation,
  [STAGES.ORDER_AWAIT_LOCATION]: handleOrderAwaitLocationText,
  [STAGES.ORDER_SELECT_RESTAURANT]: handleOrderSelectRestaurant,
  [STAGES.ORDER_SELECT_COMBO]: handleOrderSelectCombo,
  [STAGES.ORDER_ENTER_QTY]: handleOrderEnterQty,
  [STAGES.ORDER_AWAIT_ADDRESS]: handleOrderAwaitAddress,
  [STAGES.DRIVER_AWAIT_VEHICLE_TYPE]: handleDriverVehicleType
};

async function buildReply(text, name = 'friend', session = {}, phone) {
  const normalized = text.trim().toLowerCase();
  const shortName = name.split(' ')[0] || 'friend';

  // Greeting words no longer blindly reset an in-progress flow. If the user
  // still has an active stage (e.g. they went quiet mid-order and just said
  // "hi"), offer Resume/Start over instead of silently wiping their progress.
  if (!normalized || ['hi', 'hello', 'hey', 'start'].includes(normalized)) {
    if (session.stage) return handleResumePrompt(session, shortName);
    const profile = await getProfile(phone);
    return handleGreeting(text || 'hello', shortName, profile, phone);
  }

  // Quick-reply buttons shown after vendor recommendations / the hungry prompt.
  if (normalized === 'start_over') return handleGreeting("let's start over", shortName, await getProfile(phone), phone);
  if (normalized === 'resume_flow') {
    // Re-send the current stage's prompt without consuming this tap as input
    // to that stage, and keep the session exactly as it was.
    return { replies: await getStageResumeReply(session), nextStage: session.stage, sessionData: session };
  }
  if (normalized === 'try_different_meals') return handleHungry();
  if (normalized === 'get_meal_plan') return handleMealPlanPlaceholder();
  // When a new user taps "Order now" from the initial card, show the
  // hungry prompt (order now / recommend meals) rather than immediately
  // asking for location — this matches the UX in the screenshot.
  if (normalized === 'order_now') return handleHungry();
  if (normalized === 'recommend_meals') return handleRecommendMeals();
  if (normalized === 'reorder_last') return handleReorderLast(await getProfile(phone));
  // From the "Welcome back" reorder card: skip straight into the normal
  // order flow (location -> restaurant list) instead of reusing last time's vendor.
  if (normalized === 'browse_restaurants') return handleOrderNow();
  // From the same card: open up the broader options (order now / recommend
  // meals) rather than assuming they want another order at all.
  if (normalized === 'something_different') return handleHungry();

  if (
    normalized.includes('what can you do')
    || normalized.includes('what do you do')
    || normalized.includes('capabilities')
    || normalized.includes('help')
  ) {
    return handleCapabilities();
  }

  if (normalized.includes('hungry')) return handleHungry();

  // Only treat free text like "rice" or "I want jollof" as an order-intent
  // shortcut when the user ISN'T already mid-flow. Otherwise this was
  // hijacking structured answers — e.g. typing "Rice" to answer "What did
  // you last eat?" would derail straight into the order flow instead of
  // reaching the mood-picker stage handler below.
  if (!session.stage) {
    const orderIntent = detectOrderFoodRequest(normalized);
    if (orderIntent) {
        const namedVendor = detectVendorNameFromText(text);
        if (namedVendor) {
          const lookupName = titleCase(namedVendor);
          // Try to find a registered vendor with this name and show their menu
          const vendorRecord = await findVendorByName(lookupName);

          if (vendorRecord && vendorRecord.menu) {
            const menuItems = parseVendorMenu(vendorRecord.menu);
            if (menuItems.length > 0) {
              return {
                replies: [
                  { type: 'text', body: `Got it — ordering ${orderIntent} from *${vendorRecord.name}*. Here's the menu 👇` },
                  getVendorMenuListReply(menuItems, `Menu for ${vendorRecord.name}`)
                ],
                nextStage: STAGES.ORDER_SELECT_COMBO,
                sessionData: { selectedVendor: { name: vendorRecord.name, phone: vendorRecord.phone, vicinity: vendorRecord.vicinity }, menuItems }
              };
            }
          }

          // Fallback to free-form vendor (no registered menu)
          const vendor = { name: lookupName, vicinity: 'Restaurant specified by customer' };
          return {
            replies: [
              { type: 'text', body: `Got it — ordering ${orderIntent} from *${vendor.name}*. Here's the menu 👇` },
              getComboListReply()
            ],
            nextStage: STAGES.ORDER_SELECT_COMBO,
            sessionData: { selectedVendor: vendor }
          };
        }

      return {
        replies: [
          { type: 'text', body: `Got it! I can search restaurants nearby that offer ${orderIntent}. Share your location or type your area — or just tell me the restaurant name if you already know where you're ordering from.` },
          getLocationRequestReply()
        ],
        nextStage: STAGES.ORDER_AWAIT_LOCATION,
        sessionData: { orderIntent }
      };
    }
  }

  const handler = STAGE_HANDLERS[session.stage];
  if (handler) return handler(text, name, session, shortName, phone);

  // Fall through to Grok for anything unrecognized — creative mode gives
  // real personality instead of a flat, repetitive fallback line.
  const grokResponse = await askGrok(text, session, { creative: true });
  if (grokResponse) {
    return { replies: { type: 'text', body: grokResponse }, nextStage: null };
  }

  return {
    replies: {
      type: 'text',
      body: `Just say you're hungry and I'll guide you through finding the perfect meal! 😊`
    },
    nextStage: null
  };
}

// --- Mood recommendations --------------------------------------------------

async function buildMoodReply(category, shortName, lastMeal) {
  const basePrefix = lastMeal ? `Based on what you last ate (${lastMeal}), ` : '';
  const items = category === 'surprise' ? getSurpriseItems() : MOOD_CATALOG[category];

  if (!items || items.length === 0) {
    return {
      type: 'text',
      body: `${basePrefix}I can suggest meals based on your mood, ${shortName}. Try: hungry, light, heavy, healthy, spicy, or affordable.`
    };
  }

  const headerText = category === 'surprise'
    ? `${basePrefix}Here's a surprise pick for you, ${shortName} 🎉`
    : `${basePrefix}Here are some ${category} options for you 👇`;

  // Text-only list — no images. Image search was returning mismatched/wrong
  // photos often enough that a clean text list is more trustworthy.
  const listBody = items.map((item) => formatFoodCaption(item, '')).join('\n\n');

  return [
    { type: 'text', body: headerText },
    { type: 'text', body: listBody }
  ];
}

function getMoodButtonsReply(bodyText = 'Got it! Tap a category button or type a mood 😊') {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Choose',
        sections: [
          {
            rows: [
              { id: 'light', title: 'Light' },
              { id: 'heavy', title: 'Heavy' },
              { id: 'healthy', title: 'Healthy' },
              { id: 'spicy', title: 'Spicy' },
              { id: 'affordable', title: 'Affordable' },
              { id: 'surprise', title: 'Surprise' }
            ]
          }
        ]
      }
    }
  };
}

// Native WhatsApp "request location" message — shows a button that opens the
// device's location picker and sends back a message.type === 'location' payload.
function getLocationRequestReply(bodyText = 'Share your location so I can show you vendors near you 📍') {
  return {
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: bodyText },
      action: { name: 'send_location' }
    }
  };
}

const localImageExistsCache = new Map();

function localImageExists(filename) {
  if (localImageExistsCache.has(filename)) return localImageExistsCache.get(filename);
  const exists = fs.existsSync(path.join(__dirname, 'public/images', filename));
  localImageExistsCache.set(filename, exists);
  // Always warn (not just under DEBUG) — a missing file is the #1 reason an
  // expected image silently doesn't show up.
  if (!exists) console.warn(`Local image missing: public/images/${filename} — sending text instead for this item.`);
  return exists;
}

function getLocalImageUrl(filename) {
  return `${PUBLIC_URL}/images/${encodeURIComponent(filename)}`;
}

// Local files only — no external URL fallback. If the file listed in
// localImage isn't in public/images/, we return null and the caller sends
// plain text for that item instead of an unrelated stock photo.
async function resolveImageUrl(item) {
  if (item.localImage && localImageExists(item.localImage)) {
    return getLocalImageUrl(item.localImage);
  }
  return null;
}

// Geoapify Places API (free tier: 3,000 requests/day, no billing account
// required — see https://www.geoapify.com/places-api/). Data comes from
// OpenStreetMap, so it won't have Google-style ratings/reviews, but it covers
// the "find restaurants near these coordinates" job for free. Note: Geoapify's
// filter/bias params take coordinates as lon,lat (GeoJSON order), the
// opposite of the lat,lng order used elsewhere in this file — easy to get
// backwards, so it's called out explicitly in the query string below.
async function findNearbyVendors(latitude, longitude, mood, orderIntent) {
  if (!GEOAPIFY_API_KEY) {
    console.warn('Geoapify API key is not configured; cannot look up nearby vendors.');
    return null;
  }

  const categories = MOOD_PLACE_CATEGORIES[mood] || DEFAULT_PLACE_CATEGORIES;
  const vendors = await fetchGeoapifyPlaces(latitude, longitude, categories);

  // If the mood-specific category search comes up empty, fall back to the
  // broader restaurant/fast-food/cafe search rather than dead-ending —
  // better to show *something* nearby than nothing at all.
  if ((!vendors || vendors.length === 0) && categories !== DEFAULT_PLACE_CATEGORIES) {
    return fetchGeoapifyPlaces(latitude, longitude, DEFAULT_PLACE_CATEGORIES);
  }

  return vendors;
}

// Note: Geoapify's filter/bias params take coordinates as lon,lat (GeoJSON
// order), the opposite of the lat,lng order used elsewhere in this file —
// easy to get backwards, so it's called out explicitly in the query string below.
async function fetchGeoapifyPlaces(latitude, longitude, categories) {
  try {
    const url = `https://api.geoapify.com/v2/places`
      + `?categories=${encodeURIComponent(categories)}`
      + `&filter=circle:${longitude},${latitude},5000` // lon,lat,radius(m) — lon first
      + `&bias=proximity:${longitude},${latitude}` // lon,lat — lon first
      + `&limit=10`
      + `&apiKey=${encodeURIComponent(GEOAPIFY_API_KEY)}`;

    const response = await fetch(url);
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      console.error(`Geoapify places search HTTP error ${response.status}:`, errorBody?.message || errorBody);
      return [];
    }

    const data = await response.json();
    const features = data.features || [];

    return features.slice(0, 10).map((f) => {
      const p = f.properties || {};
      return {
        name: p.name || p.address_line1 || 'Unnamed restaurant',
        vicinity: p.formatted || p.address_line2 || '',
        rating: null, // Geoapify/OSM doesn't provide star ratings
        lat: p.lat,
        lng: p.lon,
        phone: p.contact?.phone || p.datasource?.raw?.phone || null,
        place_id: p.place_id
      };
    });
  } catch (error) {
    console.error('Geoapify places search failed:', error);
    return null;
  }
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Geoapify already returns everything we need (name, address, coordinates)
// in the single /v2/places call inside findNearbyVendors, so — unlike the old
// Google integration — there's no separate "details" round trip needed here.
// OSM-sourced data doesn't reliably expose ratings, live open/closed status,
// or delivery/dine-in/takeout flags, so those simply come through as unknown.
async function enrichVendor(vendor, userLat, userLng) {
  return {
    name: vendor.name,
    vicinity: vendor.vicinity,
    rating: vendor.rating,
    openNow: null,
    closingTime: null,
    serviceText: vendor.phone ? `📞 ${vendor.phone}` : 'Contact info unavailable',
    distanceKm: (vendor.lat != null && vendor.lng != null) ? distanceKm(userLat, userLng, vendor.lat, vendor.lng) : null,
    lat: vendor.lat,
    lng: vendor.lng
  };
}

function formatVendorCard(v, mood) {
  const stars = v.rating ? '⭐'.repeat(Math.round(v.rating)) : '';
  const statusText = v.closingTime
    ? `Closes ${v.closingTime}`
    : (v.openNow === true ? 'Open now' : v.openNow === false ? 'Closed now' : 'Hours unknown');
  const distanceText = v.distanceKm != null ? `${v.distanceKm.toFixed(1)} km away` : '';
  const moodTag = mood ? `\n🍽 Good for: ${mood.charAt(0).toUpperCase() + mood.slice(1)} cravings` : '';

  return `*${v.name}*\n${statusText} · ${v.serviceText}${stars ? ` ${stars}` : ''}\n${distanceText}${moodTag}`.trim();
}

// Quick-reply buttons shown after vendor cards, so the user has an obvious
// next move instead of having to type something.
function getPostVendorButtonsReply(bodyText = 'What would you like to do next?') {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'try_different_meals', title: 'Try different meals' } },
          { type: 'reply', reply: { id: 'get_meal_plan', title: 'Get a meal plan' } },
          { type: 'reply', reply: { id: 'start_over', title: 'Start over' } }
        ]
      }
    }
  };
}

function getVendorAcceptanceButtonsReply(orderId, prepMinutes = 20) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Choose how long the order will take.' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `vendor_accept_${orderId}_10`, title: '10 min' } },
          { type: 'reply', reply: { id: `vendor_accept_${orderId}_20`, title: '20 min' } },
          { type: 'reply', reply: { id: `vendor_accept_${orderId}_30`, title: '30 min' } }
        ]
      }
    }
  };
}

function getDriverDeliveryButtonsReply(orderId) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Mark the order progress.' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `driver_deliver_${orderId}`, title: 'Delivered' } }
        ]
      }
    }
  };
}

function getDriverAcceptButtonsReply(orderId) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Accept this delivery?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `driver_accept_${orderId}`, title: 'Accept' } }
        ]
      }
    }
  };
}

// Fallback for when the user types a place name instead of tapping "share location".
async function geocodeText(query) {
  if (!GOOGLE_API_KEY) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { latitude: loc.lat, longitude: loc.lng } : null;
  } catch (error) {
    console.error('Geocoding failed:', error);
    return null;
  }
}

// Builds the reply once we have real coordinates: one card-style text message
// per vendor (status, service type, rating, distance — mirrors the mockup),
// then a location pin per vendor, then the follow-up action buttons.
async function buildVendorLocationReply(latitude, longitude, mood, orderIntent) {
  const vendors = await findNearbyVendors(latitude, longitude, mood, orderIntent);

  if (!vendors || vendors.length === 0) {
    return {
      replies: [
        {
          type: 'text',
          body: `I couldn't find vendors near you right now — try Jollof House, Healthy Eats NG, or a local food vendor nearby. 🏪`
        },
        getPostVendorButtonsReply()
      ],
      nextStage: null
    };
  }

  // Show a few enriched cards + pins as context (distance, contact, status),
  // then a tappable list so the user can actually pick one and order/pay
  // instead of just being pointed at a pin with nothing to do next.
  const topVendors = vendors.slice(0, 3);
  const enriched = await Promise.all(topVendors.map((v) => enrichVendor(v, latitude, longitude)));

  const introText = mood
    ? `Here's where you can get *${mood}* meals near you 👇`
    : `Here's what's nearby 👇`;

  const infoReplies = [
    { type: 'text', body: introText },
    ...enriched.map((v) => ({ type: 'text', body: formatVendorCard(v, mood) }))
  ];

  for (const v of enriched) {
    if (v.lat != null && v.lng != null) {
      infoReplies.push({
        type: 'location',
        location: { latitude: v.lat, longitude: v.lng, name: v.name, address: v.vicinity || '' }
      });
    }
  }

  const orderPromptText = mood
    ? `Tap a restaurant below to see the menu and pay 👇`
    : `Tap a restaurant below to order 👇`;

  return {
    replies: [
      ...infoReplies,
      { type: 'text', body: orderPromptText },
      getRestaurantListReply(vendors)
    ],
    nextStage: STAGES.ORDER_SELECT_RESTAURANT,
    sessionData: { nearbyVendors: vendors, userLat: latitude, userLng: longitude, selectedMood: mood, orderIntent }
  };
}

async function sendWhatsAppMessage(to, reply) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.warn('WhatsApp credentials are not configured.');
    return;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: reply.type
  };

  if (reply.type === 'image') {
    payload.image = { link: reply.imageUrl };
    const caption = reply.caption || reply.body;
    if (caption) payload.caption = caption;
  } else if (reply.type === 'interactive') {
    payload.interactive = reply.interactive;
  } else if (reply.type === 'location') {
    payload.location = reply.location;
  } else {
    payload.text = { body: reply.body };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('Failed to send WhatsApp message:', data);
  } else if (DEBUG) {
    console.log('✅ Message sent successfully!', data);
  }

  await logMessage(to, 'outbound', reply.type, reply.body || reply.caption || null, reply);
}

app.listen(PORT, () => {
  console.log(`Foodie WhatsApp bot running on port ${PORT}`);
});