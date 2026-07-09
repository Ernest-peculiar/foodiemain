require('dotenv').config();
const express = require('express');
const path = require('path');
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
const DEBUG = process.env.DEBUG === 'true';

const imageCache = new Map();
const sessions = new Map();

// Centralizing stage names avoids typo bugs like 'askLastmeal' vs 'askLastMeal'
// scattered across the file.
const STAGES = {
  ASK_LAST_MEAL: 'askLastMeal',
  ASK_MOOD: 'askMood',
  ASK_HEALTH_GOALS: 'askHealthGoals'
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
    { name: 'Moi Moi & Pap', description: 'Steamed bean pudding with fermented corn porridge', tags: ['Healthy', 'Light', 'Affordable'], kcal: 280, searchQuery: 'Nigerian moi moi pap', fallbackImageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500' },
    { name: 'Akara & Fried Plantain', description: 'Crispy bean fritters with sweet fried plantain', tags: ['Light', 'Affordable'], kcal: 310, searchQuery: 'Nigerian akara plantain', fallbackImageUrl: 'https://images.unsplash.com/photo-1585238341710-4913d3ca7cc0?w=500' },
    { name: 'Grilled Fish Salad', description: 'Grilled fish over a fresh salad with light Nigerian flavors', tags: ['Light', 'Healthy'], kcal: 340, searchQuery: 'grilled fish salad bowl', fallbackImageUrl: 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=500' },
    { name: 'Steamed Veg & Lean Protein', description: 'Steamed vegetables with a lean protein of choice', tags: ['Healthy', 'Light'], kcal: 320, searchQuery: 'steamed vegetables lean protein plate', fallbackImageUrl: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=500' },
    { name: 'Fruit & Nut Bowl', description: 'Fresh fruit and nut bowl with a ginger syrup drizzle', tags: ['Light', 'Healthy'], kcal: 250, searchQuery: 'fruit nut bowl ginger', fallbackImageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500' }
  ],
  heavy: [
    { name: 'Pounded Yam & Egusi', description: 'Rich, comforting egusi soup with pounded yam', tags: ['Heavy', 'Filling'], kcal: 750, searchQuery: 'pounded yam egusi soup', fallbackImageUrl: 'https://images.unsplash.com/photo-1645112411341-6c4ee36b2e5d?w=500' },
    { name: 'Oha Soup & Fufu', description: 'Wholesome oha soup with fufu and deep, savory flavor', tags: ['Heavy', 'Filling'], kcal: 700, searchQuery: 'oha soup fufu Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1604909052743-94e838986d24?w=500' },
    { name: 'Ogbono & Eba', description: 'Thick ogbono soup with eba — very satisfying', tags: ['Heavy'], kcal: 680, searchQuery: 'ogbono soup eba Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1631515243349-e0cb75fb8d3a?w=500' },
    { name: 'Fried Rice & Chicken Stew', description: 'Loaded fried rice served with chicken stew', tags: ['Heavy', 'Filling'], kcal: 620, searchQuery: 'Nigerian fried rice chicken stew', fallbackImageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500' },
    { name: 'Suya Platter', description: 'Bold, hearty suya platter with spicy beef', tags: ['Heavy', 'Spicy'], kcal: 590, searchQuery: 'suya beef skewers platter', fallbackImageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500' }
  ],
  healthy: [
    { name: 'Grilled Fish & Greens', description: 'Grilled fish with steamed greens — protein-rich', tags: ['Healthy'], kcal: 380, searchQuery: 'grilled fish steamed greens', fallbackImageUrl: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=500' },
    { name: 'Okra Soup & Light Swallow', description: 'Okra soup with fish and a light swallow', tags: ['Healthy'], kcal: 420, searchQuery: 'Nigerian okra soup fish', fallbackImageUrl: 'https://images.unsplash.com/photo-1607330289024-1535c6b4e1c1?w=500' },
    { name: 'Boiled Plantain & Lean Stew', description: 'Balanced, wholesome boiled plantain with lean stew', tags: ['Healthy'], kcal: 400, searchQuery: 'boiled plantain stew', fallbackImageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500' },
    { name: 'Vegetable Soup & Lean Protein', description: 'Fresh vegetable soup with a lean protein', tags: ['Healthy'], kcal: 410, searchQuery: 'Nigerian vegetable soup', fallbackImageUrl: 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=500' },
    { name: 'Fruit Bowl & Honey', description: 'Natural, energizing fruit bowl with nuts and honey', tags: ['Healthy', 'Light'], kcal: 260, searchQuery: 'fruit bowl nuts honey', fallbackImageUrl: 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=500' }
  ],
  spicy: [
    { name: 'Suya', description: 'Smoky suya with onions and chili — a spicy classic', tags: ['Spicy'], kcal: 480, searchQuery: 'suya onions chili', fallbackImageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500' },
    { name: 'Pepper Soup', description: 'Hearty, warming pepper soup with meat', tags: ['Spicy', 'Heavy'], kcal: 440, searchQuery: 'Nigerian pepper soup meat', fallbackImageUrl: 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=500' },
    { name: 'Spicy Jollof Rice', description: 'Bold, flavorful jollof rice with extra pepper', tags: ['Spicy'], kcal: 520, searchQuery: 'spicy jollof rice', fallbackImageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500' },
    { name: 'Peppered Goat Meat', description: 'Intensely flavored peppered goat meat', tags: ['Spicy', 'Heavy'], kcal: 500, searchQuery: 'peppered goat meat Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=500' },
    { name: 'Scotch Bonnet Stew', description: 'Fiery hot stew with extra scotch bonnet pepper', tags: ['Spicy'], kcal: 460, searchQuery: 'scotch bonnet pepper stew', fallbackImageUrl: 'https://images.unsplash.com/photo-1606850780554-b55ea4dd0b70?w=500' }
  ],
  affordable: [
    { name: 'Beans & Plantain', description: 'Budget-friendly, filling beans with fried plantain', tags: ['Affordable', 'Filling'], kcal: 450, searchQuery: 'beans plantain Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1626082927389-6cd097cee6a6?w=500' },
    { name: 'Fried Rice & Chicken', description: 'Affordable, satisfying fried rice with chicken', tags: ['Affordable'], kcal: 560, searchQuery: 'fried rice chicken plate', fallbackImageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500' },
    { name: 'Akara & Bread', description: 'Cheap and cheerful morning meal', tags: ['Affordable', 'Light'], kcal: 340, searchQuery: 'akara bread Nigerian breakfast', fallbackImageUrl: 'https://images.unsplash.com/photo-1585238341710-4913d3ca7cc0?w=500' },
    { name: 'Yam Porridge', description: 'Economical, tasty yam porridge with savory sauce', tags: ['Affordable'], kcal: 500, searchQuery: 'Nigerian yam porridge', fallbackImageUrl: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?w=500' },
    { name: 'Rice & Stew', description: 'Classic, affordable rice and stew combo', tags: ['Affordable'], kcal: 530, searchQuery: 'rice and stew Nigerian', fallbackImageUrl: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=500' }
  ]
};

function formatFoodCaption(item, basePrefix) {
  const tagLine = item.tags.join(' • ');
  return `${basePrefix}*${item.name}*\n${item.description}\n🏷 ${tagLine} — ~${item.kcal} kcal`;
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
  const text = message.text?.body
    || message.button?.payload
    || message.interactive?.button_reply?.id
    || message.interactive?.button_reply?.title
    || message.interactive?.list_reply?.id
    || message.interactive?.list_reply?.title
    || '';
  const senderName = value.contacts?.[0]?.profile?.name || 'Foodie friend';
  const session = sessions.get(from) || {};

  if (DEBUG) console.log(`Message from ${from}: ${text}`);

  const result = await buildReply(text, senderName, session);
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
        model: 'grok-beta',
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

function handleGreeting() {
  return {
    replies: {
      type: 'text',
      body: `Hi! I'm *Foodie* — your personal Nigerian food guide. Tell me you're hungry and I'll handle the rest!`
    },
    nextStage: null
  };
}

function handleCapabilities() {
  return {
    replies: {
      type: 'text',
      body: `I help you: 🍽️ Decide what to eat based on your mood & goals 🔄 Avoid meal repetition 🏪 Find nearby vendors selling your meal 📋 Plan weekly meals (Premium) Just say you're hungry to get started!`
    },
    nextStage: null
  };
}

function handleHungry() {
  return {
    replies: {
      type: 'text',
      body: `Hey! 😄 What did you last eat?`
    },
    nextStage: STAGES.ASK_LAST_MEAL
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

  const vendorPrompt = `You are a Nigerian food delivery expert. Recommend 3-4 specific restaurants or food vendors in Nigeria that serve ${selectedMood} Nigerian foods. Format as:\n🏪 Restaurant Name - Brief description\nKeep it concise for WhatsApp. Focus on real or likely vendor names.`;
  const vendors = await askGrok(vendorPrompt, {});

  return {
    replies: [
      {
        type: 'text',
        body: `✨ Based on what you told me — here are my top picks for you:\n\n*${selectedMood.charAt(0).toUpperCase() + selectedMood.slice(1)} Nigerian Foods:*`
      },
      ...(Array.isArray(recommendations) ? recommendations : [recommendations]),
      {
        type: 'text',
        body: `\n🏪 *Places to find these meals:*\n${vendors || '• Jollof House\n• Healthy Eats NG\n• Local food vendors'}\n\nEnjoy your meal! 😋`
      }
    ],
    nextStage: null
  };
}

const STAGE_HANDLERS = {
  [STAGES.ASK_LAST_MEAL]: handleAskLastMeal,
  [STAGES.ASK_MOOD]: handleAskMood,
  [STAGES.ASK_HEALTH_GOALS]: handleAskHealthGoals
};

async function buildReply(text, name = 'friend', session = {}) {
  const normalized = text.trim().toLowerCase();
  const shortName = name.split(' ')[0] || 'friend';

  if (!normalized) return handleGreeting();
  if (['hi', 'hello', 'hey', 'start'].includes(normalized)) return handleGreeting();

  if (
    normalized.includes('what can you do')
    || normalized.includes('what do you do')
    || normalized.includes('capabilities')
    || normalized.includes('help')
  ) {
    return handleCapabilities();
  }

  if (normalized.includes('hungry')) return handleHungry();

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
  const items = MOOD_CATALOG[category];

  if (category === 'surprise' || !items) {
    return {
      type: 'text',
      body: `${basePrefix}I can suggest meals based on your mood, ${shortName}. Try: hungry, light, heavy, healthy, spicy, or affordable.`
    };
  }

  const images = await Promise.all(
    items.map(async (item) => {
      const imageUrl = (await searchGoogleImage(item.searchQuery)) || item.fallbackImageUrl;
      return { type: 'image', imageUrl, caption: formatFoodCaption(item, basePrefix) };
    })
  );

  return [
    { type: 'text', body: `${basePrefix}Here are some ${category} options for you 👇` },
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
