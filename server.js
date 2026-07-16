require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
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
    + `tunnel like ngrok during local dev. It is also the base for the Paystack webhook callback_url.`
  );
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';
const GROK_API_KEY = process.env.GROK_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DEBUG = process.env.DEBUG === 'true';
// WhatsApp number (E.164, e.g. 2348012345678) that gets notified when an order
// comes in. NOTE: WhatsApp's Business API only allows free-form messages to a
// number that has messaged the bot within the last 24h, or via an approved
// template. In practice this should be a staff/admin line that has an open
// session with the bot (or a template message — see handlePaystackChargeSuccess()).
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
//
// NOTE: there is no location stage anymore. Ordering now runs entirely off
// onboarded (Supabase) vendors — the user either names a restaurant directly
// ("rice from Munchy") or picks one from the full list of registered
// restaurants. No map, no geocoding, no "share your location" step.
const STAGES = {
  ASK_LAST_MEAL: 'askLastMeal',
  ASK_MOOD: 'askMood',
  ASK_HEALTH_GOALS: 'askHealthGoals',
  // Ordering flow: ask what they want -> pick a restaurant -> pick a menu item -> qty -> address -> payment.
  ORDER_ASK_WHAT: 'orderAskWhat',
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
  [STAGES.ORDER_ASK_WHAT]: 'telling me what you want to order',
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
// no external URLs, local files only.
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

async function getVendorRecordById(vendorId) {
  if (!supabase || !vendorId) return null;
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('id', vendorId)
    .maybeSingle();

  if (error) {
    console.error('Vendor lookup by id failed:', error.message);
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
// (e.g. customer types "Munchies" but it's registered as "Munchy", or
// "Munchy Restaurant") don't silently fail to reach them.
// If the partial match is ambiguous (more than one vendor matches), we
// deliberately do NOT guess — better to show the full restaurant list than
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

// All onboarded vendors that have a menu on file — this is now the ONLY
// source of restaurants in the ordering flow (no Geoapify, no Google Places,
// no location/geocoding of any kind).
async function getRegisteredVendors() {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .not('menu', 'is', null);

  if (error) {
    console.error('Failed to fetch registered vendors:', error.message);
    return [];
  }

  // Column naming for is_active/is_open may vary depending on how
  // upsertVendor persists them — check both snake_case and camelCase and
  // default to "available" if the field isn't present at all.
  return (data || []).filter((v) => {
    const isActive = v.is_active ?? v.isActive ?? true;
    const isOpen = v.is_open ?? v.isOpen ?? true;
    return isActive !== false && isOpen !== false && !!v.menu;
  });
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

// --- Vendor menu management (edit menu / toggle item availability) --------
// Two things a vendor can do post-registration:
//   1. Reply "menu"       -> see current menu with an available/sold-out tag
//                             on every item, tap one to flip it.
//   2. Reply "edit menu"  -> re-send the whole menu as text, same format as
//                             registration. Items that match an existing
//                             item by title keep their id + available flag;
//                             new lines are added as available by default.
// Requires a `menu_items jsonb` column on `vendors` (see parseVendorMenu /
// dispatch.updateVendorMenuItems / dispatch.upsertVendor below for what it
// stores: an array of { id, title, name, description, price, available }).
function makeItemId() {
  return crypto.randomBytes(3).toString('hex'); // short, stable per item, e.g. "a1b2c3"
}

function getVendorMenuManagementListReply(items, bodyText) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText || 'Tap an item to toggle it available / sold out.' },
      action: {
        button: 'Manage',
        sections: [
          {
            rows: items.map((item) => ({
              id: `toggle_item_${item.id}`,
              title: `${item.available !== false ? '✅' : '🚫'} ${item.title || item.name}`.slice(0, 24),
              description: (item.price ? `₦${item.price}` : 'No price set').slice(0, 72)
            }))
          }
        ]
      }
    }
  };
}

async function handleVendorMenuCommands(text, phone, session) {
  const normalized = (text || '').trim().toLowerCase();
  if (normalized !== 'menu' && normalized !== 'edit menu') return null;

  const vendor = await getVendorRecordByPhone(phone);
  if (!vendor) return null; // not a registered vendor — let normal routing handle it

  if (normalized === 'edit menu') {
    return {
      replies: {
        type: 'text',
        body: `Send your full updated menu as text — one item per line with prices. Example:\nRice & Beans - 1500\nEgusi Soup - 1800\nChicken Sandwich - 1200\n\nItems you keep (matched by name) will keep their current available/sold-out status; new lines are added as available; lines you drop are removed.`
      },
      nextStage: STAGES.VENDOR_AWAIT_MENU,
      sessionData: { ...session, registrationRole: 'vendor', vendorName: vendor.name, isMenuEdit: true }
    };
  }

  const items = vendor.menu_items || parseVendorMenu(vendor.menu);
  if (!items || items.length === 0) {
    return {
      replies: { type: 'text', body: `You don't have a menu on file yet. Reply "edit menu" to add one.` },
      nextStage: null,
      sessionData: session
    };
  }

  return {
    replies: [
      { type: 'text', body: `Here's your current menu, ${vendor.name}:` },
      getVendorMenuManagementListReply(items, 'Tap an item to mark it available or sold out. Reply "edit menu" to rewrite the whole list.')
    ],
    nextStage: null,
    sessionData: session
  };
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
        replies: { type: 'text', body: `You are already registered as a vendor. Reply with open/close for availability, or "menu" to manage your menu.` },
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

    // If this is an edit (triggered via "edit menu") rather than fresh
    // registration, merge against the vendor's existing structured menu so
    // items that are still present keep their id + available/sold-out
    // status instead of resetting to available on every re-send.
    let existingItems = [];
    if (session.isMenuEdit) {
      const existingVendor = await getVendorRecordByPhone(phone);
      existingItems = existingVendor?.menu_items || [];
    }
    const menuItems = parseVendorMenu(menuText, existingItems);

    const vendor = await dispatch.upsertVendor(supabase, {
      phone: normalizePhone(phone),
      name: vendorName,
      menu: menuText,
      menuItems,
      isActive: true,
      isOpen: true
    });
    return {
      replies: {
        type: 'text',
        body: `✅ ${session.isMenuEdit ? 'Updated menu for' : 'Registered'} ${vendorName}${session.isMenuEdit ? '' : ' as a vendor'}. Reply "menu" any time to mark items sold out, or "edit menu" to rewrite it.`
      },
      nextStage: null,
      sessionData: { ...session, registrationRole: null, vendorName: null, isMenuEdit: false }
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

  // --- Vendor: toggle a single menu item available / sold out ---------------
  // Tapped from the list shown by handleVendorMenuCommands ("menu" command).
  // Item ids are 6 hex chars, generated by makeItemId() and persisted on
  // vendors.menu_items — see the vendor menu management section above.
  const toggleItemMatch = normalized.match(/^toggle_item_([a-f0-9]{6})$/i);
  if (toggleItemMatch) {
    const [, itemId] = toggleItemMatch;
    const vendor = await getVendorRecordByPhone(phone);
    if (!vendor) {
      return {
        replies: { type: 'text', body: 'Only a registered vendor can update a menu.' },
        nextStage: null,
        sessionData: session
      };
    }

    const items = vendor.menu_items || parseVendorMenu(vendor.menu);
    const item = items.find((it) => it.id === itemId);
    if (!item) {
      return {
        replies: { type: 'text', body: 'Could not find that menu item — it may have been removed in a later edit.' },
        nextStage: null,
        sessionData: session
      };
    }

    item.available = item.available === false ? true : false;

    try {
      await dispatch.updateVendorMenuItems(supabase, vendor.id, items);
    } catch (error) {
      console.error('Failed to toggle menu item availability:', error.message || error);
      return {
        replies: { type: 'text', body: 'Something went wrong updating that item — please try again.' },
        nextStage: null,
        sessionData: session
      };
    }

    return {
      replies: [
        { type: 'text', body: `${item.available ? '✅ Marked available' : '🚫 Marked sold out'}: *${item.title || item.name}*` },
        getVendorMenuManagementListReply(items)
      ],
      nextStage: null,
      sessionData: session
    };
  }

  // --- Vendor: step 1 of accepting a new order ------------------------------
  // Tapping "✅ Accept" on the initial order card does NOT finalize the order
  // yet — it just brings up the prep-time picker (10/20/30 min), which is
  // what actually calls dispatch.vendorAcceptOrder further down.
  const acceptPromptMatch = normalized.match(/^vendor_accept_prompt_([0-9a-f-]+)$/i);
  if (acceptPromptMatch) {
    const [, orderId] = acceptPromptMatch;
    const vendor = await getVendorRecordByPhone(phone);
    if (!vendor) {
      return {
        replies: { type: 'text', body: 'Only a registered vendor can accept this order.' },
        nextStage: null,
        sessionData: session
      };
    }

    return {
      replies: getVendorPrepTimeButtonsReply(orderId),
      nextStage: null,
      sessionData: session
    };
  }

  // --- Vendor: "Unavailable" on a new order ---------------------------------
  // Distinct from a plain Decline: this rejects the order AND flips the
  // vendor closed (isOpen: false), so the restaurant stops receiving further
  // order notifications until they reply "open" again. Useful when a vendor
  // is overwhelmed or done for the day and would otherwise have to remember
  // to separately type "close".
  const unavailableMatch = normalized.match(/^vendor_unavailable_([0-9a-f-]+)$/i);
  if (unavailableMatch) {
    const [, orderId] = unavailableMatch;
    const vendor = await getVendorRecordByPhone(phone);
    if (!vendor) {
      return {
        replies: { type: 'text', body: 'Only a registered vendor can update this order.' },
        nextStage: null,
        sessionData: session
      };
    }

    const updatedOrder = await dispatch.vendorRejectOrder(supabase, orderId, vendor.id);
    await dispatch.setVendorAvailability(supabase, normalizePhone(phone), false);

    if (updatedOrder && updatedOrder.customer_phone) {
      await sendWhatsAppMessage(updatedOrder.customer_phone, { type: 'text', body: '❌ The restaurant is unable to fulfill your order right now.' });
    }

    return {
      replies: { type: 'text', body: 'Got it — order declined and your restaurant is now marked closed. Reply "open" whenever you are ready to take orders again.' },
      nextStage: null,
      sessionData: session
    };
  }

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
        // Send the rider's photo alongside their name so the customer can
        // actually recognize who's showing up, not just read a name.
        const riderCaption = `🚚 ${driver.name} has accepted your order and is on the way to pick it up.`
          + (driver.vehicle_type ? `\nVehicle: ${driver.vehicle_type}` : '');
        if (driver.photo_url) {
          await sendWhatsAppMessage(orderRow.customer_phone, {
            type: 'image',
            imageUrl: driver.photo_url,
            caption: riderCaption
          });
        } else {
          await sendWhatsAppMessage(orderRow.customer_phone, { type: 'text', body: riderCaption });
        }
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
            // Send driver's photo
            await sendWhatsAppMessage(vendorTarget, {
              type: 'image',
              imageUrl: driver.photo_url
            });

            // Send driver's details
            await sendWhatsAppMessage(vendorTarget, {
              type: 'text',
              body: `🚴 ${driver.name} accepted your delivery.\n\n📞 Driver: ${driver.name}\n🏍️ Vehicle: ${driver.vehicle_type || "Bike"}\n\nThe rider is on the way to pick up the order.`
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
      replies: [
        { type: 'text', body: '✅ You accepted the delivery.' },
        getDriverPickedUpButtonsReply(orderId)
      ],
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
      await sendWhatsAppMessage(updatedOrder.customer_phone, { type: 'text', body: '🚚 Your rider says your order has arrived!' });
      await sendWhatsAppMessage(updatedOrder.customer_phone, getCustomerConfirmDeliveryButtonsReply(orderId));
    }

    return {
      replies: [
        { type: 'text', body: '✅ Delivery completed. Send a photo for proof of delivery, or reply with skip.' }
      ],
      nextStage: STAGES.DRIVER_AWAIT_PHOTO,
      sessionData: { ...session, pendingPhotoOrderId: orderId }
    };
  }

  // Customer taps "✅ Confirm delivery" on the prompt sent above.
  const confirmDeliveryMatch = normalized.match(/^customer_confirm_delivery_([0-9a-f-]+)$/i);
  if (confirmDeliveryMatch) {
    const [, orderId] = confirmDeliveryMatch;
    const { data: orderRow, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();

    if (error || !orderRow || normalizePhone(orderRow.customer_phone) !== normalizePhone(phone)) {
      return {
        replies: { type: 'text', body: 'I could not find that order to confirm.' },
        nextStage: null,
        sessionData: session
      };
    }

    // Requires a nullable `customer_confirmed_at timestamptz` column on `orders`:
    //   alter table orders add column if not exists customer_confirmed_at timestamptz;
    await dispatch.updateOrderStatus(supabase, orderId, { customer_confirmed_at: new Date().toISOString() });

    if (orderRow.driver_id) {
      const { data: driverRow } = await supabase.from('drivers').select('*').eq('id', orderRow.driver_id).maybeSingle();
      if (driverRow?.phone) {
        await sendWhatsAppMessage(driverRow.phone, { type: 'text', body: `✅ The customer confirmed they received order ${orderId}. Thanks for the delivery!` });
      }
    }

    return {
      replies: { type: 'text', body: '🙏 Thanks for confirming! Enjoy your meal.' },
      nextStage: null,
      sessionData: session
    };
  }

  // Customer taps "⚠️ Report issue" instead — ping staff rather than
  // auto-confirming, so a human can follow up.
  const reportIssueMatch = normalized.match(/^customer_report_issue_([0-9a-f-]+)$/i);
  if (reportIssueMatch) {
    const [, orderId] = reportIssueMatch;
    if (ORDER_NOTIFY_NUMBER) {
      await sendWhatsAppMessage(ORDER_NOTIFY_NUMBER, { type: 'text', body: `⚠️ Customer reported an issue with order ${orderId}. Please follow up.` });
    }
    return {
      replies: { type: 'text', body: `I'm sorry to hear that. Our team has been notified and will follow up with you shortly.` },
      nextStage: null,
      sessionData: session
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
    // STEP 1: Get the media metadata
    const metadataResponse = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${message.image.id}`,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`
        }
      }
    );

    if (!metadataResponse.ok) {
      throw new Error(await metadataResponse.text());
    }

    const metadata = await metadataResponse.json();

    console.log("WhatsApp Media Metadata:", metadata);

    // STEP 2: Download the actual image
    const imageResponse = await fetch(metadata.url, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    });

    if (!imageResponse.ok) {
      throw new Error(await imageResponse.text());
    }

    const buffer = Buffer.from(await imageResponse.arrayBuffer());

    console.log("Image Size:", buffer.length);

    // STEP 3: Upload to Supabase
    const photoUrl = await dispatch.uploadDriverPhoto(
      supabase,
      normalizePhone(phone),
      buffer,
      metadata.mime_type || message.image.mime_type || "image/jpeg",
      `driver-${normalizePhone(phone)}-${Date.now()}.jpg`
    );

    console.log("Driver Photo URL:", photoUrl);

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

// Turns whatever casing the user typed ("munchy", "MUNCHY") into a
// consistent display form ("Munchy") for confirmations and staff notifications.
function titleCase(str) {
  return (str || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Filler phrases people wrap around an order — stripped so the remaining
// text is just the food item (or empty, if they only named a restaurant).
// Checked longest-first so "i want to order" isn't cut short by "i want to".
const ORDER_FILLER_PREFIXES = [
  'i would like to order',
  'i would like to',
  "i'd like to order",
  "i'd like to",
  'i want to order',
  'i want to',
  'can i order',
  'can i get',
  'please order',
  'let me order',
  'let me get',
  "i'll have",
  'ill have',
  'give me',
  'order'
];

function stripOrderFiller(text) {
  let result = (text || '').trim();
  let changed = true;
  // Loop because stripping one filler can reveal another (e.g. "i want to
  // order" strips down to "order", which then also needs stripping).
  while (changed) {
    changed = false;
    for (const prefix of ORDER_FILLER_PREFIXES) {
      const re = new RegExp('^' + prefix.replace(/'/g, `['’]`) + '\\s*', 'i');
      if (re.test(result)) {
        result = result.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return result;
}

// Parses free text like "order rice from Munchy", "i want to order from
// Munchy", "rice from Munchy", or "i want to order rice from Munchy" into
// { foodItem, vendorName }. Either half can be null — a bare vendor mention
// with no dish, or a dish with no restaurant named.
function parseOrderRequest(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { foodItem: null, vendorName: null };

  const fromMatch = trimmed.match(/\bfrom\s+([a-z0-9&'.\- ]{2,40})$/i);
  let vendorName = null;
  let beforeFrom = trimmed;

  if (fromMatch) {
    vendorName = fromMatch[1].trim().replace(/[.?!]+$/, '') || null;
    beforeFrom = trimmed.slice(0, fromMatch.index).trim();
  }

  const foodItem = stripOrderFiller(beforeFrom);

  return { foodItem: foodItem || null, vendorName };
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

// IMPORTANT: `verify` captures the raw request body BEFORE JSON parsing and
// stashes it on req.rawBody. This is required to validate Paystack's webhook
// signature (see /webhook/paystack below) — Paystack signs the exact raw
// bytes it sent, and re-serializing req.body would not reliably reproduce
// the same bytes (key order, whitespace, etc. can all differ).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
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

// --- Paystack webhook -------------------------------------------------------
// This is the ONLY server-to-server, signature-verified confirmation of a
// successful charge. handlePaystackChargeSuccess() below is idempotent (it
// no-ops if the order is already payment_status === 'paid'), which is what
// lets /paystack/callback (further down) safely reuse it too instead of
// re-implementing "mark paid -> receipt -> notify vendor" a second time.
//
// Set this URL in your Paystack dashboard (Settings -> API Keys & Webhooks):
//   https://<your-public-domain>/webhook/paystack
// (Note: this is different from `callback_url`, which only controls where
// the customer's browser redirects after paying.)
app.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  if (!PAYSTACK_SECRET_KEY || !signature || !req.rawBody) {
    return res.sendStatus(400);
  }

  const expectedHash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest('hex');

  if (expectedHash !== signature) {
    console.warn('Paystack webhook signature mismatch — ignoring request.');
    return res.sendStatus(401);
  }

  // Ack immediately — Paystack expects a fast 200 and will retry on timeout,
  // so we don't want slow downstream work (WhatsApp sends, DB writes) to
  // hold up the response.
  res.sendStatus(200);

  const event = req.body;
  if (event?.event === 'charge.success') {
    try {
      await handlePaystackChargeSuccess(event.data);
    } catch (error) {
      console.error('Failed to process Paystack charge.success webhook:', error);
    }
  }
});

// --- Branded Foodie receipt image -------------------------------------------
// The customer-facing receipt is now delivered as a PNG image straight into
// the WhatsApp chat (see handlePaystackChargeSuccess below), not as a public
// webpage. buildReceiptSVG() renders the same yellow/white branded layout the
// old /paystack/callback HTML page used, and generateReceiptPNG() rasterizes
// it with sharp. uploadWhatsAppMedia() then pushes the PNG straight to
// WhatsApp's Media endpoint and hands back a media id — no public URL is
// required for this image at all, unlike the driver/delivery photos which
// are stored in Supabase and sent by link.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildReceiptSVG({ orderId, vendorName, itemTitle, qty, unitPrice, total, address, reference, paidAt }) {
  const date = new Date(paidAt || Date.now()).toLocaleString('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  const rows = [
    ['Order', `#${orderId}`],
    ['Item', `${qty} x ${itemTitle}`],
    ['Unit price', `₦${(Number(unitPrice) || 0).toLocaleString('en-US')}`],
    ['Restaurant', vendorName || '—'],
    ['Deliver to', address || '—'],
    ['Paid', date],
    ['Reference', reference || '—']
  ];

  const rowHeight = 46;
  const rowsStartY = 230;
  const cardBodyHeight = rowsStartY + rows.length * rowHeight + 40;
  const cardHeight = cardBodyHeight - 40;
  const canvasHeight = cardHeight + 120;

  const rowSvg = rows.map(([label, value], i) => {
    const y = rowsStartY + i * rowHeight;
    return `
      <text x="60" y="${y}" font-family="Arial, sans-serif" font-size="13" letter-spacing="0.6" fill="#888888">${escapeHtml(label.toUpperCase())}</text>
      <text x="60" y="${y + 22}" font-family="Arial, sans-serif" font-size="17" font-weight="600" fill="#222222">${escapeHtml(String(value))}</text>`;
  }).join('');

  return `<svg width="640" height="${canvasHeight}" viewBox="0 0 640 ${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="${canvasHeight}" fill="#FFC72C" />
  <rect x="40" y="40" width="560" height="${cardHeight}" rx="20" fill="#FFFFFF" />
  <text x="320" y="95" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#222222" text-anchor="middle">🧾 Foodie Receipt</text>
  <text x="320" y="130" font-family="Arial, sans-serif" font-size="14" fill="#888888" text-anchor="middle">Payment confirmed</text>
  <line x1="60" y1="160" x2="580" y2="160" stroke="#eeeeee" stroke-width="1" />
  <text x="320" y="200" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#1a7f37" text-anchor="middle">₦${(Number(total) || 0).toLocaleString('en-US')}</text>
  ${rowSvg}
</svg>`;
}

// Rasterizes the branded receipt SVG to a PNG buffer with sharp.
async function generateReceiptPNG(receiptData) {
  const svg = buildReceiptSVG(receiptData);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Uploads a buffer directly to WhatsApp's Media endpoint (POST
// /{phone-number-id}/media) and returns the resulting media id. Sending an
// image by id instead of by link means anything generated on-the-fly (like
// the receipt above) never needs to be hosted at a public URL at all.
async function uploadWhatsAppMedia(buffer, mimeType, filename) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.warn('WhatsApp credentials are not configured — cannot upload media.');
    return null;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`;

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([buffer], { type: mimeType }), filename);

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      body: form
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.id) {
      console.error('Failed to upload media to WhatsApp:', data);
      return null;
    }

    return data.id;
  } catch (error) {
    console.error('WhatsApp media upload failed (network/exception):', error.message || error);
    return null;
  }
}

// --- HTML for the branded "payment successful" confirmation page -----------
// Shown to the customer's BROWSER right after they finish paying on
// Paystack's hosted page and get redirected back to /paystack/callback (see
// that route below). Intentionally minimal now: the real, order-specific
// receipt (name/amount/items) is delivered as an image straight into the
// customer's WhatsApp chat by handlePaystackChargeSuccess(), so this page no
// longer needs to (and should not) display any personal order details to
// whoever holds the callback URL/reference.
function buildPaymentSuccessPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Payment Successful — Foodie</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #FFC72C;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    text-align: center;
  }
  .card {
    max-width: 420px;
    width: 100%;
    background: #fff;
    border-radius: 16px;
    padding: 36px 28px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
  .check { font-size: 40px; margin-bottom: 8px; }
  h1 { font-size: 20px; color: #222; margin: 0 0 10px; }
  p { color: #555; font-size: 15px; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h1>Payment received</h1>
    <p>Your receipt and order confirmation have been sent to you on WhatsApp. You can safely close this page.</p>
  </div>
</body>
</html>`;
}

// --- Paystack browser redirect (callback_url) -------------------------------
// This is where the CUSTOMER'S BROWSER lands after they finish (or abandon)
// checkout on Paystack's hosted payment page — see `callback_url` in
// createPaystackTransaction() above. Without this route, the customer would
// hit a raw "Cannot GET /paystack/callback" error page after paying.
//
// This route now ALSO completes the order (mark paid -> receipt -> notify
// vendor) by delegating to handlePaystackChargeSuccess(), the exact same
// function the server-to-server webhook above calls. That function is
// idempotent — it checks `orderRow.payment_status === 'paid'` and returns
// immediately if the order was already completed — so having both this
// route and the webhook able to trigger it is safe: whichever fires first
// does the real work (update order, generate + send the receipt image,
// message the customer, notify the vendor), and the other becomes a no-op.
// This guards against a double receipt / double vendor notification race,
// while making this callback route a genuine second chance to complete the
// order if the webhook is ever delayed, unreachable, or misconfigured.
//
// The page rendered here is now a generic "check WhatsApp" confirmation —
// see buildPaymentSuccessPage() above — since the actual receipt goes
// straight to the customer's WhatsApp chat as an image, not to this page.
app.get('/paystack/callback', async (req, res) => {
  const { reference } = req.query;

  if (!reference || !PAYSTACK_SECRET_KEY) {
    return res.status(400).send('<h2>Missing payment reference.</h2><p>Please return to WhatsApp.</p>');
  }

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const result = await response.json().catch(() => null);

    if (result?.status && result?.data?.status === 'success') {
      // Reuse the same idempotent handler the webhook calls — do NOT
      // duplicate the order-lookup / status-update / receipt / vendor-notify
      // logic here. See the comment above this route for why.
      try {
        await handlePaystackChargeSuccess(result.data);
      } catch (error) {
        // Don't let a failure here break the confirmation page — if this
        // fails, the webhook (server-to-server, with its own retries from
        // Paystack) remains the backstop that completes the order and
        // delivers the WhatsApp receipt.
        console.error('handlePaystackChargeSuccess failed from /paystack/callback:', error);
      }

      return res.send(buildPaymentSuccessPage());
    }

    return res.send('<h2>⚠️ Payment not confirmed</h2><p>If you completed payment, please return to WhatsApp and wait a moment for your receipt. Contact support if it does not arrive.</p>');
  } catch (error) {
    console.error('Paystack callback verification failed:', error.message || error);
    return res.status(500).send('<h2>Something went wrong.</h2><p>Please return to WhatsApp — if payment succeeded, your receipt will still arrive there.</p>');
  }
});

// Builds the receipt text sent to the vendor once payment is confirmed, and
// used as a text fallback to the customer if the branded receipt image
// fails to generate or send for any reason (see handlePaystackChargeSuccess).
function buildReceiptText({ orderId, vendorName, itemTitle, qty, unitPrice, total, address, reference, paidAt }) {
  const date = new Date(paidAt || Date.now()).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
  return `🧾 *Receipt* — Order ${orderId}\n\n`
    + `${qty} x ${itemTitle} — ₦${unitPrice.toLocaleString('en-US')} each\n`
    + `*Total paid: ₦${total.toLocaleString('en-US')}*\n\n`
    + `Restaurant: ${vendorName}\n`
    + `Deliver to: ${address}\n`
    + `Paid: ${date}\n`
    + `Ref: ${reference}\n\n`
    + `Thanks for ordering with Foodie! 🙏`;
}

// Fires once Paystack confirms a successful charge for a given reference.
// This is the payment gate: the customer receives a branded receipt image
// plus a confirmation text here, and the vendor is notified (receipt text +
// Accept/Decline/Unavailable buttons) here. It is called from TWO places:
// the server-to-server /webhook/paystack handler above, and the
// browser-facing /paystack/callback route above — see the comment on that
// route for why calling it from both is safe.
//
// RETURN VALUE: returns the (updated) order row, or null if the reference
// couldn't be resolved to an order or the update failed.
//
// FIX (receipt not arriving): the order row is looked up by
// `paystack_reference`, but that column is only populated in a SEPARATE
// write inside handleOrderAwaitAddress AFTER the payment link is already
// created — see the `dispatch.updateOrderStatus(...)` call wrapped in its
// own try/catch there. If that particular write fails for any reason (a
// transient Supabase error, a dropped connection, a schema issue), the
// customer still gets a working payment link and can still pay
// successfully, but the order row is left with `paystack_reference` still
// null. When Paystack later calls this webhook, the lookup below finds
// nothing, logs one quiet console.warn, and returns — no receipt, no vendor
// notification, and nothing visible to the customer at all.
//
// Since the `reference` we send to Paystack when creating the transaction
// is always the order's own `id` (see createPaystackTransaction(email,
// totalAmount, orderRecord.id) in handleOrderAwaitAddress), we can safely
// fall back to matching on `id` whenever the `paystack_reference` lookup
// comes back empty. This makes a failed secondary write non-fatal instead
// of silently orphaning a paid order.
async function handlePaystackChargeSuccess(data) {
  const reference = data?.reference;
  if (!reference || !supabase) return null;

  let { data: orderRow, error } = await supabase
    .from('orders')
    .select('*')
    .eq('paystack_reference', reference)
    .maybeSingle();

  if (!error && !orderRow) {
    // Fallback lookup — see the note above the function for why this is
    // safe: `reference` is always the order's own id.
    const fallback = await supabase
      .from('orders')
      .select('*')
      .eq('id', reference)
      .maybeSingle();
    orderRow = fallback.data;
    error = fallback.error;
  }

  if (error) {
    console.error('Failed to look up order for Paystack reference', reference, error.message);
    return null;
  }
  if (!orderRow) {
    console.warn(`No order found for Paystack reference ${reference} — ignoring webhook.`);
    return null;
  }

  // Idempotency — Paystack retries webhook delivery on any non-2xx or
  // timeout, AND this same function can also be triggered by the
  // /paystack/callback browser route, so make sure a retry / duplicate
  // trigger never sends a second receipt/notification. Still return the
  // order row so a repeat visit to /paystack/callback (e.g. the customer
  // hits back/refresh after already paying) is a safe no-op.
  if (orderRow.payment_status === 'paid') return orderRow;

  const paidAt = new Date().toISOString();
  // Also (re)persist paystack_reference here in case the order was matched
  // via the id fallback above — this keeps the row consistent going forward
  // and makes any future lookup by paystack_reference work normally too.
  const { error: updateError } = await supabase
    .from('orders')
    .update({ payment_status: 'paid', paid_at: paidAt, status: 'pending_vendor', paystack_reference: reference })
    .eq('id', orderRow.id);

  if (updateError) {
    console.error('Failed to mark order paid:', updateError.message);
    return null;
  }

  // Reflect the update locally so callers (and the code below) see the
  // final paid state without a second round-trip to Supabase.
  orderRow = { ...orderRow, payment_status: 'paid', paid_at: paidAt, status: 'pending_vendor', paystack_reference: reference };

  const items = Array.isArray(orderRow.items) ? orderRow.items : [];
  const firstItem = items[0] || {};
  const itemTitle = firstItem.title || 'your order';
  const qty = firstItem.qty || 1;
  const unitPrice = firstItem.price || 0;
  const total = Number(orderRow.total) || (unitPrice * qty);

  const receiptData = {
    orderId: orderRow.id,
    vendorName: orderRow.restaurant_name,
    itemTitle,
    qty,
    unitPrice,
    total,
    address: orderRow.delivery_address,
    reference,
    paidAt
  };
  const receiptText = buildReceiptText(receiptData);

  // --- Customer: branded receipt image + confirmation text -----------------
  // This replaces the old "redirect to a webpage" flow entirely. The
  // customer never has to leave WhatsApp to see their receipt.
  if (orderRow.customer_phone) {
    let receiptImageSent = false;

    try {
      const pngBuffer = await generateReceiptPNG(receiptData);
      const mediaId = await uploadWhatsAppMedia(pngBuffer, 'image/png', `receipt-${orderRow.id}.png`);

      if (mediaId) {
        await sendWhatsAppMessage(orderRow.customer_phone, {
          type: 'image',
          mediaId,
          caption: `🧾 Receipt for order ${orderRow.id}`
        });
        receiptImageSent = true;
      }
    } catch (error) {
      console.error('Failed to generate/send receipt image:', error.message || error);
    }

    // Never leave the customer with nothing if PNG generation or the
    // WhatsApp media upload fails for any reason — fall back to the plain
    // text receipt that used to be the only thing sent here.
    if (!receiptImageSent) {
      await sendWhatsAppMessage(orderRow.customer_phone, { type: 'text', body: receiptText });
    }

    await sendWhatsAppMessage(orderRow.customer_phone, {
      type: 'text',
      body: '✅ Payment Successful! Your order has been confirmed and is now being prepared.'
    });

    await saveProfile(orderRow.customer_phone, {
      lastOrder: {
        vendorName: orderRow.restaurant_name,
        comboTitle: itemTitle,
        qty,
        total,
        address: orderRow.delivery_address,
        at: paidAt
      }
    });
  }

  // Receipt + Accept/Decline/Unavailable card to the vendor — this is the
  // FIRST time the vendor hears about this order at all. Vendor phone is
  // resolved from vendor_id (the FK on orders) rather than trusting a flat
  // column that may not exist on your `orders` table.
  let vendorPhone = null;
  if (orderRow.vendor_id) {
    const vendorRecord = await getVendorRecordById(orderRow.vendor_id);
    vendorPhone = vendorRecord?.phone || null;
  }
  const vendorTarget = vendorPhone || ORDER_NOTIFY_NUMBER;

  if (vendorTarget) {
    await sendWhatsAppMessage(vendorTarget, { type: 'text', body: receiptText });
    await sendWhatsAppMessage(vendorTarget, getVendorOrderActionButtonsReply(orderRow.id));
  } else {
    console.warn('No vendor phone or ORDER_NOTIFY_NUMBER configured; cannot notify vendor of paid order.');
  }

  return orderRow;
}

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
  // "menu" / "edit menu" are likewise explicit vendor commands and must be
  // recognized regardless of any in-progress stage, same rationale as
  // registration above. Checked right after registration, before stage
  // routing, so a vendor mid-flow can still jump straight to managing their
  // menu.
  const menuManagementReply = registrationReply ? null : await handleVendorMenuCommands(text, from, session);

  if (registrationReply) {
    await logMessage(from, 'inbound', message.type || 'text', text, message);
    result = registrationReply;
  } else if (menuManagementReply) {
    await logMessage(from, 'inbound', message.type || 'text', text, message);
    result = menuManagementReply;
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
    // Location sharing is no longer part of the ordering flow — everything
    // now runs off onboarded restaurants by name. Log it for the record but
    // just nudge the user back toward naming a restaurant instead.
    await logMessage(from, 'inbound', 'location', `${message.location.latitude},${message.location.longitude}`, message.location);
    result = {
      replies: {
        type: 'text',
        body: `No need to share your location — just tell me what you'd like and which restaurant it's from, e.g. "rice from Munchy".`
      },
      nextStage: null
    };
  } else {
    if (DEBUG) console.log(`Message from ${from}: ${text}`);
    await logMessage(from, 'inbound', message.type || 'text', text, message);

    const availabilityReply = await handleAvailabilityCommands(text, from, session);
    if (availabilityReply) {
      result = availabilityReply;
    } else if (role === 'vendor') {
      const dispatchReply = await handleDispatchPayload(text, from, session);
      result = dispatchReply || { replies: { type: 'text', body: 'Reply open/close to change availability, or "menu" to manage your menu.' }, nextStage: null, sessionData: session };
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
    case STAGES.ORDER_SELECT_RESTAURANT:
      return session.registeredVendors?.length
        ? [{ type: 'text', body: `Here are our restaurants again 👇` }, getRegisteredVendorListReply(session.registeredVendors)]
        : { type: 'text', body: `Which restaurant would you like to order from?` };
    case STAGES.ORDER_SELECT_COMBO:
      // Resend just the menu list — no image dump. Images are shown once a
      // specific combo is picked (see handleOrderSelectCombo).
      return session.menuItems?.length
        ? [{ type: 'text', body: `Here's the menu again 👇` }, getVendorMenuListReply(session.menuItems, `Menu for ${session.selectedVendor?.name || 'this restaurant'}`)]
        : { type: 'text', body: `Which item would you like?` };
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

// "I'm hungry" now branches two ways: order straight from a registered
// restaurant, or go through the old mood-based recommendation flow first.
//
// IMPORTANT: this button's "Order now" id is 'start_order', NOT 'order_now'.
// 'order_now' is already used by the very first "Get started" card
// (getNewUserButtonsReply) and is wired to handleHungry() itself — reusing
// the same id here would mean tapping "Order now" a second time just
// re-triggers handleHungry() again and re-sends this same prompt forever
// (an infinite loop) instead of moving forward to "What would you like to
// order?" (handleOrderNow()). Keep these two ids distinct.
function getHungryButtonsReply(bodyText = "Want me to help you order now, or find some recommendations first?") {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'start_order', title: '🛒 Order now' } },
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

// Given a vendor row from Supabase, build the "here's the menu" reply and
// move the session into ORDER_SELECT_COMBO with that vendor + parsed menu
// cached on the session. Only items currently marked available are shown
// to customers — sold-out items are filtered out here so they can never be
// selected further down the ordering flow.
function buildVendorMenuReply(vendorRecord, introText) {
  const allItems = vendorRecord.menu_items || parseVendorMenu(vendorRecord.menu);
  const menuItems = allItems.filter((it) => it.available !== false);
  const vendor = {
    id: vendorRecord.id,
    name: vendorRecord.name,
    phone: vendorRecord.phone,
    vicinity: vendorRecord.vicinity || 'Registered restaurant'
  };

  if (menuItems.length === 0) {
    return {
      replies: {
        type: 'text',
        body: `Sorry, *${vendor.name}* has nothing available right now — please check back later.`
      },
      nextStage: null,
      sessionData: {}
    };
  }

  return {
    replies: [
      { type: 'text', body: introText },
      getVendorMenuListReply(menuItems, `Menu for ${vendor.name}`)
    ],
    nextStage: STAGES.ORDER_SELECT_COMBO,
    sessionData: { selectedVendor: vendor, menuItems }
  };
}

// Triggered by the "Browse Restaurants" button (and as a fallback whenever
// no specific/valid restaurant was named) — lists every onboarded vendor
// that has a menu on file. This is now the ONLY way restaurants are
// discovered; there is no location search or map involved anywhere.
async function handleBrowseRestaurants(introText = `Here are our registered restaurants 👇 Tap one to see the menu.`) {
  const vendors = await getRegisteredVendors();

  if (vendors.length === 0) {
    return {
      replies: {
        type: 'text',
        body: `No registered restaurants are available right now. Please check back later.`
      },
      nextStage: null,
      sessionData: {}
    };
  }

  return {
    replies: [
      { type: 'text', body: introText },
      getRegisteredVendorListReply(vendors)
    ],
    nextStage: STAGES.ORDER_SELECT_RESTAURANT,
    sessionData: { registeredVendors: vendors }
  };
}

// Handle user's response to "What would you like to order?" (and the
// equivalent free-text shortcut from buildReply). Recognizes phrasing like:
//   "order rice from Munchy"
//   "i want to order from Munchy"
//   "rice from Munchy"
//   "i want to order rice from Munchy"
// A named restaurant is looked up directly in Supabase and, if found, its
// real menu is shown immediately — no location step in between. If no
// restaurant is named, or the named one isn't registered, we fall back to
// showing the full list of onboarded restaurants to pick from.
async function handleOrderAskWhat(text, name, session) {
  const trimmed = (text || '').trim();

  if (!trimmed || trimmed.length < 2) {
    return {
      replies: {
        type: 'text',
        body: `What would you like to order? (e.g., "rice from Munchy" or just "jollof rice")`
      },
      nextStage: STAGES.ORDER_ASK_WHAT,
      sessionData: {}
    };
  }

  const { foodItem, vendorName } = parseOrderRequest(trimmed);

  if (vendorName) {
    const vendorRecord = await findVendorByName(vendorName);
    if (vendorRecord && vendorRecord.menu) {
      const introText = foodItem
        ? `Great! Looking for *${foodItem}* — here's the menu for *${vendorRecord.name}* 👇`
        : `Great! Here's the menu for *${vendorRecord.name}* 👇`;
      return buildVendorMenuReply(vendorRecord, introText);
    }

    return handleBrowseRestaurants(`I couldn't find *${titleCase(vendorName)}* among our registered restaurants. Here's who is available 👇`);
  }

  // No restaurant named — show every onboarded restaurant to choose from.
  const introText = foodItem
    ? `Looking for restaurants that serve *${foodItem}* 👇 Tap one to see their menu.`
    : `Here are our registered restaurants 👇 Tap one to see the menu.`;
  return handleBrowseRestaurants(introText);
}

// Kicks off ordering: ask what they want first, then look up the vendor or
// show the full restaurant list.
function handleOrderNow() {
  return {
    replies: {
      type: 'text',
      body: `What would you like to order? 🛒\n\n(e.g., "rice", "rice from Munchy", "i want to order from Munchy")`
    },
    nextStage: STAGES.ORDER_ASK_WHAT,
    sessionData: {}
  };
}

// One-tap reorder: reuse the vendor + combo from the user's remembered last
// order and skip straight to confirming a delivery address, instead of
// walking them through restaurant -> combo -> qty again.
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

// After health goals, instead of asking for a location we now go straight
// into the full list of onboarded restaurants, so the user can pick one that
// might serve something matching their mood.
async function handleAskHealthGoals(text, name, session, shortName) {
  const selectedMood = mapMoodToCategory(session.userMood);
  const recommendations = await buildMoodReply(selectedMood, shortName, session.lastMeal || 'something');
  const browseReply = await handleBrowseRestaurants(`Here are our registered restaurants — tap one to see if they've got something *${selectedMood}* 👇`);

  return {
    replies: [
      {
        type: 'text',
        body: `✨ Based on what you told me — here are my top picks for you:\n\n*${selectedMood.charAt(0).toUpperCase() + selectedMood.slice(1)} Nigerian Foods:*`
      },
      ...(Array.isArray(recommendations) ? recommendations : [recommendations]),
      ...(Array.isArray(browseReply.replies) ? browseReply.replies : [browseReply.replies])
    ],
    nextStage: browseReply.nextStage,
    sessionData: { ...(browseReply.sessionData || {}), selectedMood }
  };
}

// Renders the full onboarded-restaurant list (one row per vendor with a menu
// on file), id-prefixed with `regvendor_` so taps are unambiguous.
function getRegisteredVendorListReply(vendors, bodyText = 'Our registered restaurants') {
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
              id: `regvendor_${idx}`,
              title: v.name.slice(0, 24),
              description: (v.vicinity || 'Tap to see menu').slice(0, 72)
            }))
          }
        ]
      }
    }
  };
}

// Step: restaurant picked — either tapped from the registered-vendor list
// (id `regvendor_<idx>`, resolved straight off the session, no lookup
// needed) or typed by hand (looked up by name in Supabase). If the typed
// name doesn't match anything registered, we don't guess or fall back to a
// generic menu — we show the real list of onboarded restaurants instead.
async function handleOrderSelectRestaurant(text, name, session) {
  const trimmed = (text || '').trim();

  if (trimmed.startsWith('regvendor_') && Array.isArray(session.registeredVendors)) {
    const regIdx = parseInt(trimmed.replace('regvendor_', ''), 10);
    const vendorRecord = session.registeredVendors[regIdx];

    if (!vendorRecord) {
      return handleBrowseRestaurants(`Please tap a restaurant from the list above 👆`);
    }

    return buildVendorMenuReply(vendorRecord, `Great pick! Here's the menu for *${vendorRecord.name}* 👇`);
  }

  if (trimmed.length < 2) {
    return handleBrowseRestaurants(`Please tap a restaurant from the list above 👆, or type the restaurant's name.`);
  }

  const vendorRecord = await findVendorByName(trimmed);
  if (vendorRecord && vendorRecord.menu) {
    return buildVendorMenuReply(vendorRecord, `Great pick! Here's the menu for *${vendorRecord.name}* 👇`);
  }

  return handleBrowseRestaurants(`I couldn't find *${titleCase(trimmed)}* among our registered restaurants. Here's who is available 👇`);
}

// Step: menu item picked — either tapped from the list (id "item_<idx>",
// resolved against session.menuItems) or a stray tap of "✅ Proceed"
// (id "proceed_qty_item_<idx>") if a two-phase confirmation was shown.
// Menu items always come from a real vendor's registered menu now — there
// is no generic combo fallback.
async function handleOrderSelectCombo(text, name, session) {
  const trimmed = (text || '').trim();
  const menuItems = Array.isArray(session.menuItems) ? session.menuItems : [];

  if (trimmed.startsWith('proceed_qty_item_')) {
    const idx = parseInt(trimmed.replace('proceed_qty_item_', ''), 10);
    const combo = menuItems[idx];
    if (!combo) {
      return {
        replies: { type: 'text', body: `Something went wrong — please pick a menu item again 👆` },
        nextStage: STAGES.ORDER_SELECT_COMBO,
        sessionData: { selectedVendor: session.selectedVendor, menuItems }
      };
    }
    return {
      replies: { type: 'text', body: `*${combo.title || combo.name}* is a great choice! How many would you like? (e.g. "2")` },
      nextStage: STAGES.ORDER_ENTER_QTY,
      sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: idx, menuItems }
    };
  }

  if (trimmed.startsWith('item_')) {
    const itemIdx = parseInt(trimmed.replace('item_', ''), 10);
    const combo = menuItems[itemIdx] || null;
    if (!combo) {
      return {
        replies: { type: 'text', body: `Please tap a menu item from the list above 👆` },
        nextStage: STAGES.ORDER_SELECT_COMBO,
        sessionData: { selectedVendor: session.selectedVendor, menuItems }
      };
    }

    return {
      replies: { type: 'text', body: `*${combo.title || combo.name}* is a great choice! How many would you like? (e.g. "2")` },
      nextStage: STAGES.ORDER_ENTER_QTY,
      sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: itemIdx, menuItems }
    };
  }

  return {
    replies: { type: 'text', body: `Please tap a menu item from the list above 👆` },
    nextStage: STAGES.ORDER_SELECT_COMBO,
    sessionData: { selectedVendor: session.selectedVendor, menuItems }
  };
}

// Parses raw vendor-entered menu text into structured items, one per line
// (or comma-separated on a single line). Each item gets:
//   - title/name: the display text
//   - price: parsed from a trailing "- 1500" / ": 1500" style suffix, or
//     null if no price was given
//   - id: a short stable identifier used to reference this exact item later
//     (e.g. toggling availability) — see makeItemId() above
//   - available: true by default
//
// `existingItems` (optional) is the vendor's current structured menu
// (vendors.menu_items). When provided, any parsed line whose title matches
// an existing item (case-insensitive) reuses that item's id and available
// flag instead of resetting it — this is what lets "edit menu" preserve
// sold-out status for items that didn't change, while still letting a
// vendor add/remove lines freely.
function parseVendorMenu(menuText, existingItems = []) {
  if (!menuText) return [];
  // Split into lines first; if single line with commas, split by commas.
  const lines = menuText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  if (lines.length === 1 && lines[0].includes(',')) {
    lines[0].split(',').forEach(part => { if (part.trim()) items.push(part.trim()); });
  } else {
    for (const l of lines) items.push(l);
  }

  const existingByTitle = new Map(
    (existingItems || []).map((it) => [(it.title || it.name || '').trim().toLowerCase(), it])
  );

  // Parse each item for an optional price like "name - 1500" or "name:1500"
  return items.map((line) => {
    const match = line.match(/^(.*?)\s*[-–—:]\s*(\d+(?:\.\d+)?)$/);
    const title = (match ? match[1] : line).trim();
    const price = match ? Math.round(Number(match[2])) : null;
    const existing = existingByTitle.get(title.toLowerCase());

    return {
      id: existing?.id || makeItemId(),
      title,
      name: title,
      description: '',
      price,
      available: existing ? existing.available !== false : true
    };
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

// Now accepts a `reference` — this is the order's own id, passed straight
// through to Paystack so both the /webhook/paystack handler and the
// /paystack/callback route can match the eventual confirmed charge back to
// a specific order row.
//
// FIX: previously any non-2xx response from Paystack was swallowed —
// `if (!response.ok) return null;` discarded the response body entirely,
// so a bad secret key, an invalid email, a malformed amount, or a rejected
// callback_url all looked identical to the customer ("I couldn't create
// the payment link right now") with NOTHING useful in the server logs.
// Now the response body is read and logged before returning null, so the
// real reason shows up in your console.
async function createPaystackTransaction(email, amount, reference) {
  if (!PAYSTACK_SECRET_KEY) {
    console.warn('PAYSTACK_SECRET_KEY is not configured — cannot create a payment link.');
    return null;
  }

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
        reference,
        callback_url: `${PUBLIC_URL}/paystack/callback`
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // This is the key fix: log Paystack's actual error message/status
      // instead of discarding it. Common causes: invalid secret key,
      // invalid email, callback_url not a valid public HTTPS URL (see the
      // PUBLIC_URL warning at startup), or amount below Paystack's minimum.
      console.error(
        `Paystack initialize failed (status ${response.status}):`,
        data?.message || JSON.stringify(data)
      );
      return null;
    }

    if (data?.status && data?.data) return data.data;

    console.error('Paystack initialize returned 2xx but an unexpected body:', JSON.stringify(data));
    return null;
  } catch (error) {
    console.error('Paystack initialize failed (network/exception):', error);
    return null;
  }
}

// Step: quantity given. We do NOT create a Paystack link yet — we still need
// an exact delivery address, so stash the qty on the session and move to the
// address step instead of paying here.
function handleOrderEnterQty(text, name, session, shortName) {
  const menuItems = Array.isArray(session.menuItems) ? session.menuItems : [];
  const combo = menuItems[session.selectedComboIdx];
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
      menuItems
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

// Step: exact delivery address given. This creates an UNPAID order and hands
// the customer a payment link — nothing else happens yet. The vendor is NOT
// notified here, and the customer does NOT get a receipt here. Both of those
// only fire from handlePaystackChargeSuccess() once Paystack confirms the
// charge — triggered either by /webhook/paystack or /paystack/callback. If
// the item has no price set, we skip payment entirely and also skip
// notifying the vendor, per policy — the customer is just told to try again
// once pricing is fixed.
async function handleOrderAwaitAddress(text, name, session, shortName, phone) {
  const menuItems = Array.isArray(session.menuItems) ? session.menuItems : [];
  const combo = menuItems[session.selectedComboIdx];
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
        menuItems
      }
    };
  }

  const address = text.trim();
  const email = parseEmail(text) || `${name.replace(/\s+/g, '.').toLowerCase()}@example.com`;
  const unitPrice = (combo && (combo.price || combo.price === 0)) ? Number(combo.price) : 0;
  const totalAmount = unitPrice * qty;

  // No price set — can't charge, so no payment, no receipt, and (per
  // policy) no vendor notification of any kind. Just tell the customer.
  if (unitPrice <= 0) {
    return {
      replies: {
        type: 'text',
        body: `This restaurant hasn't set a price for *${combo.title || combo.name}* yet, so I can't take payment right now. Please try again shortly, or pick a different item.`
      },
      nextStage: null
    };
  }

  // Create the order in an unpaid state first so we have an id to use as
  // the Paystack reference — that's what lets the webhook and callback
  // route match a confirmed payment back to this exact order.
  //
  // IMPORTANT: everything below is wrapped in try/catch. Without it, an
  // exception thrown by dispatch.createOrderRecord / dispatch.updateOrderStatus
  // (e.g. a schema mismatch, a missing column, a Supabase constraint
  // violation) propagates all the way up through buildReply ->
  // handleIncomingMessage -> the /webhook handler's catch block, which only
  // logs to console and sends NO reply to the user at all — from their side
  // it looks like the bot just went silent after they typed their address.
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
        isOpen: true
      },
      restaurantName: vendor.name,
      items: [{ title: combo.title || combo.name, qty, price: unitPrice }],
      subtotal: totalAmount,
      deliveryFee: 0,
      total: totalAmount,
      deliveryAddress: address,
      status: 'pending_payment'
    });
  } catch (error) {
    console.error('dispatch.createOrderRecord threw:', error.message || error);
    return {
      replies: { type: 'text', body: `Something went wrong starting your order — please try again, or contact support if this keeps happening.` },
      nextStage: null
    };
  }

  if (!orderRecord?.id) {
    console.error('createOrderRecord did not return an order id — order was not created. Check lib/order-dispatch.js and the orders table schema.');
    return {
      replies: { type: 'text', body: `Something went wrong starting your order — please try again.` },
      nextStage: null
    };
  }

  let payment = null;
  try {
    payment = await createPaystackTransaction(email, totalAmount, orderRecord.id);
  } catch (error) {
    console.error('createPaystackTransaction threw unexpectedly:', error.message || error);
  }

  let paymentMessage;
  if (payment) {
    // Store the reference Paystack actually assigned (falls back to the
    // order id if Paystack didn't echo one back, since we sent it as the
    // reference in the first place).
    //
    // NOTE: this write CAN still fail (network blip, transient Supabase
    // error, etc.), and if it does the customer still gets a valid payment
    // link below. That used to mean a paid order with no receipt — see the
    // fallback lookup by order id added in handlePaystackChargeSuccess()
    // above, which now covers exactly this case.
    try {
      await dispatch.updateOrderStatus(supabase, orderRecord.id, {
        paystack_reference: payment.reference || orderRecord.id
      });
    } catch (error) {
      console.error('dispatch.updateOrderStatus threw while saving paystack_reference:', error.message || error);
    }
    paymentMessage = `Please complete payment here: ${payment.authorization_url}\n\nYou'll get a receipt here the moment payment is confirmed — that's also when the restaurant is notified of your order.`;
  } else {
    paymentMessage = `I couldn't create the payment link right now. Please try again later or contact support.`;
  }

  // NOTE: no sendOrderNotification / vendor ping and no saveProfile(lastOrder)
  // here anymore — both now happen only inside handlePaystackChargeSuccess(),
  // once Paystack actually confirms the charge (via either trigger route).

  return {
    replies: {
      type: 'text',
      body: `${qty} x *${combo.title || combo.name}* from *${vendor.name}*\nDeliver to: ${address}\nTotal: ₦${totalAmount}\n${paymentMessage}`
    },
    nextStage: null
  };
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
  [STAGES.ORDER_ASK_WHAT]: handleOrderAskWhat,
  [STAGES.ORDER_SELECT_RESTAURANT]: handleOrderSelectRestaurant,
  [STAGES.ORDER_SELECT_COMBO]: handleOrderSelectCombo,
  [STAGES.ORDER_ENTER_QTY]: handleOrderEnterQty,
  [STAGES.ORDER_AWAIT_ADDRESS]: handleOrderAwaitAddress,
  [STAGES.DRIVER_AWAIT_VEHICLE_TYPE]: handleDriverVehicleType
};

// Quick heuristic for "does this free text, sent with no active stage, read
// as an order request?" — used to route straight into handleOrderAskWhat
// (which does the real vendor-name/food-item parsing) instead of falling
// through to Grok banter. Deliberately generous: a "from <name>" mention or
// the word "order" is enough, since handleOrderAskWhat itself degrades
// gracefully (showing the full restaurant list) if nothing useful is found.
function looksLikeOrderRequest(text) {
  const normalized = (text || '').toLowerCase();
  if (/\bfrom\s+[a-z0-9]/i.test(normalized)) return true;
  if (/\border\b/.test(normalized)) return true;
  if (/\b(want|need|crave|feed me|serve me)\b/.test(normalized) && /\b(rice|beans?|jollof|food|meal|meals?)\b/.test(normalized)) return true;
  return false;
}

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
  //
  // NOTE: 'order_now' (from the very first "Get started" card) and
  // 'start_order' (from the "Order now / Recommend meals" card shown by
  // handleHungry) are deliberately different ids routed to different
  // handlers. Previously both buttons used the same id 'order_now', which
  // meant tapping "Order now" a second time just called handleHungry()
  // again and re-sent the same two buttons instead of asking "What would
  // you like to order?" — an infinite loop. Keep them separate.
  if (normalized === 'start_over') return handleGreeting("let's start over", shortName, await getProfile(phone), phone);
  if (normalized === 'resume_flow') {
    // Re-send the current stage's prompt without consuming this tap as input
    // to that stage, and keep the session exactly as it was.
    return { replies: await getStageResumeReply(session), nextStage: session.stage, sessionData: session };
  }
  if (normalized === 'try_different_meals') return handleHungry();
  if (normalized === 'get_meal_plan') return handleMealPlanPlaceholder();
  // When a new user taps "Order now" from the initial "Get started" card,
  // show the hungry prompt (order now / recommend meals) rather than
  // immediately asking what to order — this matches the UX in the screenshot.
  if (normalized === 'order_now') return handleHungry();
  // When the user taps "🛒 Order now" from the hungry prompt itself, actually
  // move the flow forward and ask what they'd like to order.
  if (normalized === 'start_order') return handleOrderNow();
  if (normalized === 'recommend_meals') return handleRecommendMeals();
  if (normalized === 'reorder_last') return handleReorderLast(await getProfile(phone));
  // From the "Welcome back" reorder card: show all onboarded vendors and
  // their menus instead of reusing last time's vendor.
  if (normalized === 'browse_restaurants') return handleBrowseRestaurants();
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

  // Direct order phrasing ("order rice from Munchy", "rice from Munchy",
  // "i want to order from Munchy"...) is recognized straight from free text,
  // even with no active stage, and routed into the same vendor-lookup logic
  // used by the ORDER_ASK_WHAT stage handler.
  if (!session.stage && looksLikeOrderRequest(normalized)) {
    return handleOrderAskWhat(text, name, session);
  }

  if (normalized.includes('hungry')) return handleHungry();

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

// Quick-reply buttons shown after an order confirmation, so the user has an
// obvious next move instead of having to type something.
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

// --- Vendor order-action buttons -------------------------------------------
// Shown once payment is confirmed (see handlePaystackChargeSuccess), BEFORE
// any prep time is picked. Three options:
//   ✅ Accept       -> vendor_accept_prompt_<orderId>  (shows prep-time picker)
//   ❌ Decline      -> vendor_reject_<orderId>          (rejects just this order)
//   🚫 Unavailable  -> vendor_unavailable_<orderId>     (rejects this order AND
//                                                          closes the restaurant)
// All three payloads are handled in handleDispatchPayload above.
function getVendorOrderActionButtonsReply(orderId, bodyText = 'New paid order! Would you like to accept it?') {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `vendor_accept_prompt_${orderId}`, title: '✅ Accept' } },
          { type: 'reply', reply: { id: `vendor_reject_${orderId}`, title: '❌ Decline' } },
          { type: 'reply', reply: { id: `vendor_unavailable_${orderId}`, title: '🚫 Unavailable' } }
        ]
      }
    }
  };
}

// Prep-time picker — now shown only AFTER the vendor taps "✅ Accept" on the
// card above, rather than as the very first thing a vendor sees.
function getVendorPrepTimeButtonsReply(orderId) {
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

// Shown to the driver right after they accept a delivery, so they have
// an obvious next tap once they've physically picked up the order from the
// restaurant. Produces the `driver_pickup_<orderId>` payload already handled
// by the `pickupMatch` branch in handleDispatchPayload.
function getDriverPickedUpButtonsReply(orderId, bodyText = 'Let us know when you have the order in hand.') {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `driver_pickup_${orderId}`, title: 'Picked up' } }
        ]
      }
    }
  };
}

// Shown to the customer once the driver marks the order delivered, so
// they can confirm receipt (or flag a problem) with a tap instead of typing.
function getCustomerConfirmDeliveryButtonsReply(orderId, bodyText = 'Has your order arrived?') {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `customer_confirm_delivery_${orderId}`, title: '✅ Confirm delivery' } },
          { type: 'reply', reply: { id: `customer_report_issue_${orderId}`, title: '⚠️ Report issue' } }
        ]
      }
    }
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
    // reply.mediaId (preferred, used for anything generated on-the-fly —
    // e.g. the branded receipt PNG, see generateReceiptPNG/uploadWhatsAppMedia
    // above) or reply.imageUrl (still used for the driver photo pulled back
    // out of Supabase storage, which already has a public URL).
    payload.image = reply.mediaId ? { id: reply.mediaId } : { link: reply.imageUrl };
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