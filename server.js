require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const GROK_API_KEY = process.env.GROK_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DEBUG = process.env.DEBUG === 'true';
// WhatsApp number (E.164, e.g. 2348012345678) that gets notified when an order
// comes in. NOTE: WhatsApp's Business API only allows free-form messages to a
// number that has messaged the bot within the last 24h, or via an approved
// template. In practice this should be a staff/admin line that has an open
// session with the bot (or a template message — see sendOrderNotification()).
const ORDER_NOTIFY_NUMBER = process.env.ORDER_NOTIFY_NUMBER;

const imageCache = new Map();
const sessions = new Map();

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
  ORDER_AWAIT_ADDRESS: 'orderAwaitAddress'
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

// Each entry's searchQuery is what we use to look up a real matching photo via
// searchGoogleImage(). fallbackImageUrl only applies if that search is unavailable
// or fails, so we're not stuck with one recycled stock photo per multiple dishes.
// name/description/tags/kcal drive the caption text formatted to mirror the
// "name, description, tags, kcal" card layout, since WhatsApp captions can't
// render actual colored badges — this is the closest text approximation.
const MOOD_CATALOG = {
  light: [
    { name: 'Moi Moi & Pap', description: 'Steamed bean pudding with fermented corn porridge', tags: ['Healthy', 'Light', 'Affordable'], kcal: 280, localImage: 'moi-moi-pap.jpg', searchQuery: 'Nigerian moi moi pap', fallbackImageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500' },
    { name: 'Akara & Fried Plantain', description: 'Crispy bean fritters with sweet fried plantain', tags: ['Light', 'Affordable'], kcal: 310, localImage: 'akara-plantain.jpg', searchQuery: 'Nigerian akara plantain', fallbackImageUrl: 'https://images.unsplash.com/photo-1585238341710-4913d3ca7cc0?w=500' },
    { name: 'Grilled Fish Salad', description: 'Grilled fish over a fresh salad with light Nigerian flavors', tags: ['Light', 'Healthy'], kcal: 340, localImage: 'grilled-fish-salad.jpg', searchQuery: 'grilled fish salad bowl', fallbackImageUrl: 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=500' },
    { name: 'Steamed Veg & Lean Protein', description: 'Steamed vegetables with a lean protein of choice', tags: ['Healthy', 'Light'], kcal: 320, localImage: 'steamed-veg-protein.jpg', searchQuery: 'steamed vegetables lean protein plate', fallbackImageUrl: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=500' },
    { name: 'Fruit & Nut Bowl', description: 'Fresh fruit and nut bowl with a ginger syrup drizzle', tags: ['Light', 'Healthy'], kcal: 250, localImage: 'fruit-nut-bowl.jpg', searchQuery: 'fruit nut bowl ginger', fallbackImageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500' }
  ],
  heavy: [
    { name: 'Pounded Yam & Egusi', description: 'Rich, comforting egusi soup with pounded yam', tags: ['Heavy', 'Filling'], kcal: 750, localImage: 'pounded-yam-egusi.jpg', searchQuery: 'pounded yam egusi soup', fallbackImageUrl: 'https://images.unsplash.com/photo-1645112411341-6c4ee36b2e5d?w=500' },
    { name: 'Oha Soup & Fufu', description: 'Wholesome oha soup with fufu and deep, savory flavor', tags: ['Heavy', 'Filling'], kcal: 700, localImage: 'oha-soup-fufu.jpg', searchQuery: 'oha soup fufu Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1604909052743-94e838986d24?w=500' },
    { name: 'Ogbono & Eba', description: 'Thick ogbono soup with eba — very satisfying', tags: ['Heavy'], kcal: 680, localImage: 'ogbono-eba.jpg', searchQuery: 'ogbono soup eba Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1631515243349-e0cb75fb8d3a?w=500' },
    { name: 'Fried Rice & Chicken Stew', description: 'Loaded fried rice served with chicken stew', tags: ['Heavy', 'Filling'], kcal: 620, localImage: 'fried-rice-chicken-stew.jpg', searchQuery: 'Nigerian fried rice chicken stew', fallbackImageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500' },
    { name: 'Suya Platter', description: 'Bold, hearty suya platter with spicy beef', tags: ['Heavy', 'Spicy'], kcal: 590, localImage: 'suya-platter.jpg', searchQuery: 'suya beef skewers platter', fallbackImageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500' }
  ],
  healthy: [
    { name: 'Grilled Fish & Greens', description: 'Grilled fish with steamed greens — protein-rich', tags: ['Healthy'], kcal: 380, localImage: 'grilled-fish-greens.jpg', searchQuery: 'grilled fish steamed greens', fallbackImageUrl: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=500' },
    { name: 'Okra Soup & Light Swallow', description: 'Okra soup with fish and a light swallow', tags: ['Healthy'], kcal: 420, localImage: 'okra-soup.jpg', searchQuery: 'Nigerian okra soup fish', fallbackImageUrl: 'https://images.unsplash.com/photo-1607330289024-1535c6b4e1c1?w=500' },
    { name: 'Boiled Plantain & Lean Stew', description: 'Balanced, wholesome boiled plantain with lean stew', tags: ['Healthy'], kcal: 400, localImage: 'boiled-plantain-stew.jpg', searchQuery: 'boiled plantain stew', fallbackImageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500' },
    { name: 'Vegetable Soup & Lean Protein', description: 'Fresh vegetable soup with a lean protein', tags: ['Healthy'], kcal: 410, localImage: 'vegetable-soup.jpg', searchQuery: 'Nigerian vegetable soup', fallbackImageUrl: 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=500' },
    { name: 'Fruit Bowl & Honey', description: 'Natural, energizing fruit bowl with nuts and honey', tags: ['Healthy', 'Light'], kcal: 260, localImage: 'fruit-bowl-honey.jpg', searchQuery: 'fruit bowl nuts honey', fallbackImageUrl: 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=500' }
  ],
  spicy: [
    { name: 'Suya', description: 'Smoky suya with onions and chili — a spicy classic', tags: ['Spicy'], kcal: 480, localImage: 'suya.jpg', searchQuery: 'suya onions chili', fallbackImageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500' },
    { name: 'Pepper Soup', description: 'Hearty, warming pepper soup with meat', tags: ['Spicy', 'Heavy'], kcal: 440, localImage: 'pepper-soup.jpg', searchQuery: 'Nigerian pepper soup meat', fallbackImageUrl: 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=500' },
    { name: 'Spicy Jollof Rice', description: 'Bold, flavorful jollof rice with extra pepper', tags: ['Spicy'], kcal: 520, localImage: 'spicy-jollof-rice.jpg', searchQuery: 'spicy jollof rice', fallbackImageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500' },
    { name: 'Peppered Goat Meat', description: 'Intensely flavored peppered goat meat', tags: ['Spicy', 'Heavy'], kcal: 500, localImage: 'peppered-goat-meat.jpg', searchQuery: 'peppered goat meat Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=500' },
    { name: 'Scotch Bonnet Stew', description: 'Fiery hot stew with extra scotch bonnet pepper', tags: ['Spicy'], kcal: 460, localImage: 'scotch-bonnet-stew.jpg', searchQuery: 'scotch bonnet pepper stew', fallbackImageUrl: 'https://images.unsplash.com/photo-1606850780554-b55ea4dd0b70?w=500' }
  ],
  affordable: [
    { name: 'Beans & Plantain', description: 'Budget-friendly, filling beans with fried plantain', tags: ['Affordable', 'Filling'], kcal: 450, localImage: 'beans-plantain.jpg', searchQuery: 'beans plantain Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1626082927389-6cd097cee6a6?w=500' },
    { name: 'Fried Rice & Chicken', description: 'Affordable, satisfying fried rice with chicken', tags: ['Affordable'], kcal: 560, localImage: 'fried-rice-chicken.jpg', searchQuery: 'fried rice chicken plate', fallbackImageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500' },
    { name: 'Akara & Bread', description: 'Cheap and cheerful morning meal', tags: ['Affordable', 'Light'], kcal: 340, localImage: 'akara-bread.jpg', searchQuery: 'akara bread Nigerian breakfast', fallbackImageUrl: 'https://images.unsplash.com/photo-1585238341710-4913d3ca7cc0?w=500' },
    { name: 'Yam Porridge', description: 'Economical, tasty yam porridge with savory sauce', tags: ['Affordable'], kcal: 500, localImage: 'yam-porridge.jpg', searchQuery: 'Nigerian yam porridge', fallbackImageUrl: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?w=500' },
    { name: 'Rice & Stew', description: 'Classic, affordable rice and stew combo', tags: ['Affordable'], kcal: 530, localImage: 'rice-stew.jpg', searchQuery: 'rice and stew Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=500' }
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

const ORDER_COMBOS = [
  { title: 'Plain Rice', description: 'Steamed rice with tomato stew and salad', category: 'Rice', price: 1500 },
  { title: 'Rice & Beans', description: 'Rice served with beans and plantain', category: 'Rice & Beans', price: 1700 },
  { title: 'Rice & Meat', description: 'Rice with chicken stew and a side of greens', category: 'Rice & Meat', price: 2200 },
  { title: 'Rice, Meat & Fanta', description: 'Rice, meat stew, and Fanta to wash it down', category: 'Rice Combos', price: 2800 }
];

function parseEmail(text) {
  const match = (text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
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

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];

        for (const message of messages) {
          await handleIncomingMessage(message, value);
        }
      }
    }
  }

  res.sendStatus(200);
});

async function handleIncomingMessage(message, value) {
  const from = message.from;
  const senderName = value.contacts?.[0]?.profile?.name || 'Foodie friend';
  const session = sessions.get(from) || {};

  let result;

  if (message.type === 'location' && message.location) {
    const { latitude, longitude } = message.location;
    if (session.stage === STAGES.ORDER_AWAIT_LOCATION) {
      result = await handleOrderLocationReceived(latitude, longitude, session);
    } else {
      const replies = await buildVendorLocationReply(latitude, longitude, session.selectedMood);
      result = { replies, nextStage: null };
    }
  } else {
    const text = message.text?.body
      || message.button?.payload
      || message.interactive?.button_reply?.id
      || message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.id
      || message.interactive?.list_reply?.title
      || '';

    if (DEBUG) console.log(`Message from ${from}: ${text}`);
    result = await buildReply(text, senderName, session);
  }

  const replies = result.replies;

  if (from) {
    if (result.nextStage) {
      sessions.set(from, { stage: result.nextStage, ...(result.sessionData || {}) });
    } else if (session.stage) {
      sessions.delete(from);
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

async function handleGreeting(seedText = 'hello', name = 'friend') {
  const grokReply = await askGrok(seedText, {}, { creative: true });
  const greetingText = `Hi ${name}, I'm *Foodie* — your personal Nigerian food guide. Tell me what you'd like to eat and I'll handle the rest!`;

  return {
    replies: [
      { type: 'text', body: greetingText },
      { type: 'text', body: grokReply || `I'm here to help you order food, find nearby restaurants, or get meal ideas.` },
      getGreetingButtonsReply()
    ],
    nextStage: null
  };
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
      getLocationRequestReply()
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

  const replies = await buildVendorLocationReply(coords.latitude, coords.longitude, session.selectedMood, session.orderIntent);
  return { replies, nextStage: null };
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
    ? `Here's what's nearby that can serve ${session.orderIntent} 👇 Tap a restaurant to choose.`
    : `Here's what's nearby 👇 Tap a restaurant to choose.`;

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

// Step 2: restaurant picked. We don't have that restaurant's real menu (Places
// doesn't expose one), so we offer our curated dish list against it, grouped
// into sections by mood category to stay under WhatsApp's list-row limits.
function handleOrderSelectRestaurant(text, name, session) {
  const idx = parseInt((text || '').replace('vendor_', ''), 10);
  const vendor = Number.isInteger(idx) ? session.nearbyVendors?.[idx] : null;

  if (!vendor) {
    return {
      replies: {
        type: 'text',
        body: `Please tap a restaurant from the list above 👆`
      },
      nextStage: STAGES.ORDER_SELECT_RESTAURANT,
      sessionData: { nearbyVendors: session.nearbyVendors, userLat: session.userLat, userLng: session.userLng }
    };
  }

  return {
    replies: [
      { type: 'text', body: `Great pick! I found rice and rice-combo meals for *${vendor.name}*. Pick one:` },
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

// Step 3: combo picked, ask quantity as free text.
function handleOrderSelectCombo(text, name, session) {
  const idx = parseInt((text || '').replace('combo_', ''), 10);
  const combo = Number.isInteger(idx) ? ORDER_COMBOS[idx] : null;

  if (!combo) {
    return {
      replies: { type: 'text', body: `Please tap a meal combo from the list above 👆` },
      nextStage: STAGES.ORDER_SELECT_COMBO,
      sessionData: { selectedVendor: session.selectedVendor, userLat: session.userLat, userLng: session.userLng }
    };
  }

  return {
    replies: {
      type: 'text',
      body: `*${combo.title}* is a great choice! How many would you like? (e.g. "2")`
    },
    nextStage: STAGES.ORDER_ENTER_QTY,
    sessionData: { selectedVendor: session.selectedVendor, selectedComboIdx: idx, userLat: session.userLat, userLng: session.userLng }
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
  const combo = ORDER_COMBOS[session.selectedComboIdx];
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
      userLng: session.userLng
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
// notify staff — this is the payment gate the user asked for.
async function handleOrderAwaitAddress(text, name, session, shortName) {
  const combo = ORDER_COMBOS[session.selectedComboIdx];
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
        userLng: session.userLng
      }
    };
  }

  const address = text.trim();
  const email = parseEmail(text) || `${name.replace(/\s+/g, '.').toLowerCase()}@example.com`;
  const payment = await createPaystackTransaction(email, combo.price * qty);

  const paymentMessage = payment
    ? `Please complete payment here: ${payment.authorization_url}`
    : `I couldn't create the payment link right now. Please try again later or contact support.`;

  await sendOrderNotification({ customerName: name, item: combo, qty, vendor, address, paymentUrl: payment?.authorization_url });

  return {
    replies: [
      {
        type: 'text',
        body: `✅ Almost done, ${shortName}!\n${qty} x *${combo.title}* from *${vendor.name}*\nDeliver to: ${address}\nTotal: ₦${combo.price * qty}\n${paymentMessage}`
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
async function sendOrderNotification({ customerName, item, qty, vendor, address, paymentUrl }) {
  if (!ORDER_NOTIFY_NUMBER) {
    console.warn('ORDER_NOTIFY_NUMBER is not configured; order was not relayed.');
    return;
  }

  const body = `🆕 New order from ${customerName}:\n${qty} x ${item.title || item.name}\nRestaurant: ${vendor.name} (${vendor.vicinity || 'location shared'})${address ? `\nDeliver to: ${address}` : ''}${paymentUrl ? `\nPayment: ${paymentUrl}` : ''}`;
  await sendWhatsAppMessage(ORDER_NOTIFY_NUMBER, { type: 'text', body });
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
  [STAGES.ORDER_AWAIT_ADDRESS]: handleOrderAwaitAddress
};

async function buildReply(text, name = 'friend', session = {}) {
  const normalized = text.trim().toLowerCase();
  const shortName = name.split(' ')[0] || 'friend';

  if (!normalized) return handleGreeting('hello', shortName);
  if (['hi', 'hello', 'hey', 'start'].includes(normalized)) return handleGreeting(text, shortName);

  // Quick-reply buttons shown after vendor recommendations / the hungry prompt.
  if (normalized === 'start_over') return handleGreeting("let's start over", shortName);
  if (normalized === 'try_different_meals') return handleHungry();
  if (normalized === 'get_meal_plan') return handleMealPlanPlaceholder();
  if (normalized === 'order_now') return handleOrderNow();
  if (normalized === 'recommend_meals') return handleRecommendMeals();

  if (
    normalized.includes('what can you do')
    || normalized.includes('what do you do')
    || normalized.includes('capabilities')
    || normalized.includes('help')
  ) {
    return handleCapabilities();
  }

  if (normalized.includes('hungry')) return handleHungry();

  const orderIntent = detectOrderFoodRequest(normalized);
  if (orderIntent) {
    return {
      replies: [
        { type: 'text', body: `Got it! I can search restaurants nearby that offer ${orderIntent}. Share your location or type your area.` },
        getLocationRequestReply()
      ],
      nextStage: STAGES.ORDER_AWAIT_LOCATION,
      sessionData: { orderIntent }
    };
  }

  const handler = STAGE_HANDLERS[session.stage];
  if (handler) return handler(text, name, session, shortName);

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

  const images = await Promise.all(
    items.map(async (item) => {
      const imageUrl = await resolveImageUrl(item);
      return { type: 'image', imageUrl, caption: formatFoodCaption(item, basePrefix) };
    })
  );

  const headerText = category === 'surprise'
    ? `${basePrefix}Here's a surprise pick for you, ${shortName} 🎉`
    : `${basePrefix}Here are some ${category} options for you 👇`;

  return [
    { type: 'text', body: headerText },
    ...images
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

function getLocalImageUrl(filename) {
  return `${PUBLIC_URL}/images/${encodeURIComponent(filename)}`;
}

async function searchGoogleImage(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) return null;
  if (imageCache.has(query)) return imageCache.get(query);

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CSE_ID)}&searchType=image&q=${encodeURIComponent(query)}&num=1`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const imageUrl = data.items?.[0]?.link;
    if (imageUrl) {
      imageCache.set(query, imageUrl);
      return imageUrl;
    }
  } catch (error) {
    console.error('Google image search failed:', error);
  }

  return null;
}

const localImageExistsCache = new Map();

function localImageExists(filename) {
  if (localImageExistsCache.has(filename)) return localImageExistsCache.get(filename);
  const exists = fs.existsSync(path.join(__dirname, 'public/images', filename));
  localImageExistsCache.set(filename, exists);
  if (DEBUG && !exists) console.warn(`Local image missing: public/images/${filename}`);
  return exists;
}

// Resolution order: your own curated photo (guaranteed to match) > a live
// Google Image Search result > the hand-picked stock fallback. This means
// dropping a correctly-named file into public/images/ immediately overrides
// the other two sources for that dish, no code change needed.
async function resolveImageUrl(item) {
  if (item.localImage && localImageExists(item.localImage)) {
    return getLocalImageUrl(item.localImage);
  }
  const searched = await searchGoogleImage(item.searchQuery);
  return searched || item.fallbackImageUrl;
}

// Requires the Places API (New or legacy Nearby Search) enabled on GOOGLE_API_KEY —
// this is a separate API from the Custom Search JSON API used for images, so it
// needs enabling separately in Google Cloud Console.
async function findNearbyVendors(latitude, longitude, mood, orderIntent) {
  if (!GOOGLE_API_KEY) {
    console.warn('Google API key is not configured; cannot look up nearby vendors.');
    return null;
  }

  let keyword = 'Nigerian food';
  if (orderIntent) keyword = `${orderIntent} Nigerian food`;
  else if (mood) keyword = `${mood} Nigerian food`;

  try {
    const baseUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}&radius=5000&type=restaurant&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
    const keywordUrl = `${baseUrl}&keyword=${encodeURIComponent(keyword)}`;

    let response = await fetch(keywordUrl);
    if (!response.ok) return null;

    let data = await response.json();
    let results = (data.results || []).slice(0, 5);

    if (results.length === 0 && (orderIntent || mood)) {
      // Fallback to a less restrictive search if keyword filtering returns nothing.
      response = await fetch(baseUrl);
      if (!response.ok) return null;
      data = await response.json();
      results = (data.results || []).slice(0, 5);
    }

    return results;
  } catch (error) {
    console.error('Places nearby search failed:', error);
    return null;
  }
}

// Nearby Search doesn't return delivery/dine-in/takeout or today's exact closing
// time — those need a Place Details call per venue (extra API cost, which is why
// we only enrich the top 3 rather than all 5).
async function fetchPlaceDetails(placeId) {
  if (!GOOGLE_API_KEY || !placeId) return null;

  try {
    const fields = 'name,rating,opening_hours,delivery,dine_in,takeout,geometry';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.result || null;
  } catch (error) {
    console.error('Place details lookup failed:', error);
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

function formatClockTime(hhmm) {
  if (!hhmm || hhmm.length !== 4) return null;
  let hours = parseInt(hhmm.slice(0, 2), 10);
  const minutes = hhmm.slice(2);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}${minutes !== '00' ? ':' + minutes : ''} ${ampm}`;
}

function getTodayClosingTime(periods) {
  if (!periods) return null;
  const today = new Date().getDay(); // 0 = Sunday
  const todayPeriod = periods.find((p) => p.open?.day === today);
  return todayPeriod?.close?.time ? formatClockTime(todayPeriod.close.time) : null;
}

function getServiceText(details) {
  const services = [];
  if (details.delivery) services.push('Delivery available');
  if (details.dine_in) services.push('Dine-in');
  if (details.takeout) services.push('Takeout');
  return services.length > 0 ? services.join(' & ') : 'Walk-in';
}

async function enrichVendor(vendor, userLat, userLng) {
  const details = await fetchPlaceDetails(vendor.place_id);
  const lat = vendor.geometry?.location?.lat;
  const lng = vendor.geometry?.location?.lng;

  return {
    name: vendor.name,
    vicinity: vendor.vicinity,
    rating: details?.rating ?? vendor.rating,
    openNow: details?.opening_hours?.open_now ?? vendor.opening_hours?.open_now,
    closingTime: getTodayClosingTime(details?.opening_hours?.periods),
    serviceText: getServiceText(details || {}),
    distanceKm: (lat != null && lng != null) ? distanceKm(userLat, userLng, lat, lng) : null,
    lat,
    lng
  };
}

function formatVendorCard(v) {
  const stars = v.rating ? '⭐'.repeat(Math.round(v.rating)) : '';
  const statusText = v.closingTime
    ? `Closes ${v.closingTime}`
    : (v.openNow === true ? 'Open now' : v.openNow === false ? 'Closed now' : 'Hours unknown');
  const distanceText = v.distanceKm != null ? `${v.distanceKm.toFixed(1)} km away` : '';

  return `*${v.name}*\n${statusText} · ${v.serviceText}${stars ? ` ${stars}` : ''}\n${distanceText}`.trim();
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
    return [
      {
        type: 'text',
        body: `I couldn't find vendors near you right now — try Jollof House, Healthy Eats NG, or a local food vendor nearby. 🏪`
      },
      getPostVendorButtonsReply()
    ];
  }

  // Place Details costs an extra call per venue, so we only enrich the top 3.
  const topVendors = vendors.slice(0, 3);
  const enriched = await Promise.all(topVendors.map((v) => enrichVendor(v, latitude, longitude)));

  const replies = enriched.map((v) => ({ type: 'text', body: formatVendorCard(v) }));

  for (const v of enriched) {
    if (v.lat != null && v.lng != null) {
      replies.push({
        type: 'location',
        location: { latitude: v.lat, longitude: v.lng, name: v.name, address: v.vicinity || '' }
      });
    }
  }

  replies.push(getPostVendorButtonsReply());
  return replies;
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
}

app.listen(PORT, () => {
  console.log(`Foodie WhatsApp bot running on port ${PORT}`);
});