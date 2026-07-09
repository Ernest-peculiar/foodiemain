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
const imageCache = new Map();

app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public/images')));

const sessions = new Map();

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
 
  console.log("📩 WEBHOOK RECEIVED!");
  console.log(JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];

        for (const message of messages) {
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

          console.log(`Message from ${from}: ${text}`);

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
              console.log(`Replying with: ${reply.type === 'image' ? reply.caption : reply.body}`);
              await sendWhatsAppMessage(from, reply);
            }
          }
        }
      }
    }
  }

  res.sendStatus(200);
});

async function askGrok(userMessage, sessionData = {}) {
  if (!GROK_API_KEY) {
    console.warn('Grok API key is not configured.');
    return null;
  }

  try {
    const systemPrompt = `You are Foodie, a friendly Nigerian food recommendation WhatsApp bot. You help users discover what to eat based on their mood and preferences. You're knowledgeable about Nigerian cuisine and friendly. Keep responses concise for WhatsApp (under 160 characters when possible). ${sessionData.mood ? `The user is interested in ${sessionData.mood} food.` : ''}`;

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
        temperature: 0.7,
        max_tokens: 150
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

async function buildReply(text, name = 'friend', session = {}) {
  const normalized = text.trim().toLowerCase();
  const shortName = name.split(' ')[0] || 'friend';

  // Initial greeting - no text
  if (!normalized) {
    return {
      replies: {
        type: 'text',
        body: `Hi! I'm *Foodie* — your personal Nigerian food guide. Tell me you're hungry and I'll handle the rest!`
      },
      nextStage: null
    };
  }

  // Greetings
  if (['hi', 'hello', 'hey', 'start'].includes(normalized)) {
    return {
      replies: {
        type: 'text',
        body: `Hi! I'm *Foodie* — your personal Nigerian food guide. Tell me you're hungry and I'll handle the rest!`
      },
      nextStage: null
    };
  }

  // What can you do
  if (normalized.includes('what can you do') || normalized.includes('what do you do') || normalized.includes('capabilities') || normalized.includes('help')) {
    return {
      replies: {
        type: 'text',
        body: `I help you: 🍽️ Decide what to eat based on your mood & goals 🔄 Avoid meal repetition 🏪 Find nearby vendors selling your meal 📋 Plan weekly meals (Premium) Just say you're hungry to get started!`
      },
      nextStage: null
    };
  }

  // User says hungry
  if (normalized.includes('hungry')) {
    return {
      replies: {
        type: 'text',
        body: `Hey! 😄 What did you last eat?`
      },
      nextStage: 'askLastMeal'
    };
  }

  // Stage: Ask what they last ate
  if (session.stage === 'askLastMeal') {
  return {
    replies: [
      { type: 'text', body: `Got it! What are you in the mood for?` },
      getMoodButtonsReply()
    ],
    nextStage: 'askMood',
    sessionData: { lastMeal: text.trim() }
  };
}

  // Stage: Ask mood/preference
  if (session.stage === 'askMood') {
    return {
      replies: {
        type: 'text',
        body: `Nice. Any health goals I should know about?`
      },
      nextStage: 'askHealthGoals',
      sessionData: { lastMeal: session.lastMeal, userMood: text.trim() }
    };
  }

  // Stage: Ask health goals
  if (session.stage === 'askHealthGoals') {
    // Map user's mood preference to a category
    const userMoodText = session.userMood || 'light';
    const moodMapping = {
      'light': 'light',
      'heavy': 'heavy',
      'healthy': 'healthy',
      'spicy': 'spicy',
      'affordable': 'affordable',
      'soup': 'healthy',
      'salad': 'healthy',
      'grilled': 'healthy',
      'protein': 'healthy'
    };
    
    // Find the best matching category
    let selectedMood = 'light';
    for (const [key, value] of Object.entries(moodMapping)) {
      if (userMoodText.toLowerCase().includes(key)) {
        selectedMood = value;
        break;
      }
    }
    
    const recommendations = await buildMoodReply(selectedMood, shortName, session.lastMeal || 'something');
    
    // Get vendor recommendations using Grok
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

  // Use Grok API for unknown queries
  const grokResponse = await askGrok(text, session);
  if (grokResponse) {
    return {
      replies: {
        type: 'text',
        body: grokResponse
      },
      nextStage: null
    };
  }

  return {
    replies: {
      type: 'text',
      body: `Just say you're hungry and I'll guide you through finding the perfect meal! 😊`
    },
    nextStage: null
  };
}

function getMoodCategory(normalized) {
  if (normalized.includes('light') && normalized.includes('healthy')) return 'healthy';
  if (normalized.includes('light')) return 'light';
  if (normalized.includes('heavy') || normalized.includes('filling')) return 'heavy';
  if (normalized.includes('healthy')) return 'healthy';
  if (normalized.includes('spicy') || normalized.includes('pepper') || normalized.includes('hot')) return 'spicy';
  if (normalized.includes('affordable') || normalized.includes('budget') || normalized.includes('cheap') || normalized.includes('economy')) return 'affordable';
  if (normalized.includes('surprise') || normalized.includes('anything') || normalized.includes('whatever')) return 'surprise';
  return null;
}

async function buildMoodReply(category, shortName, lastMeal) {
  const basePrefix = lastMeal ? `Based on what you last ate (${lastMeal}), ` : '';

  if (category === 'light') {
    return [
      {
        type: 'text',
        body: `${basePrefix}Here are some lighter options for you 👇`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `${basePrefix}Light option 1: Nigerian moi moi with a side of pap - Steamed bean pudding.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1585238341710-4913d3ca7cc0?w=500',
        caption: `${basePrefix}Light option 2: Akara and fresh fried plantain - Crispy bean fritters.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=500',
        caption: `${basePrefix}Light option 3: Salad bowl with grilled fish and light Nigerian flavors.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `${basePrefix}Light option 4: Steamed vegetables with lean protein - Healthy & nutritious.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500',
        caption: `${basePrefix}Light option 5: Fruit and nut bowl with ginger syrup - Refreshing & light.`
      }
    ];
  }

  if (category === 'heavy') {
    return [
      {
        type: 'text',
        body: `${basePrefix}Here are some hearty options for you 👇`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1645112411341-6c4ee36b2e5d?w=500',
        caption: `🍲 Pounded yam with egusi soup — rich, comforting, and filling.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `🍲 Oha soup with fufu — a wholesome heavy meal with deep flavor.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `🍲 Ogbono with eba — thick, oily, and very satisfying.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500',
        caption: `🍚 Fried rice with chicken stew — loaded and delicious.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500',
        caption: `🥩 Suya platter with spicy beef — bold, hearty, and perfect.`
      }
    ];
  }

  if (category === 'healthy') {
    return [
      {
        type: 'text',
        body: `${basePrefix}Here are some healthy options for you 👇`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `🐟 Grilled fish with steamed greens - Protein-rich & healthy.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `🥘 Okra soup with fish and a light swallow - Nutritious Nigerian classic.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500',
        caption: `🍌 Boiled plantain with lean stew - Balanced & wholesome.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=500',
        caption: `🥗 Vegetable soup with lean protein - Fresh & healthy.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1599599810694-b5ac1ea27830?w=500',
        caption: `🍎 Fruit bowl with nuts and honey - Natural & energizing.`
      }
    ];
  }

  if (category === 'spicy') {
    return [
      {
        type: 'text',
        body: `${basePrefix}Here are some spicy options for you 👇`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500',
        caption: `🌶️ Suya with onions and chili - Spicy & smoky Nigerian delight.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `🌶️ Hearty pepper soup with meat - Warming & spicy.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500',
        caption: `🌶️ Spicy jollof rice with extra pepper - Bold & flavorful.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500',
        caption: `🌶️ Peppered goat meat with bold spices - Intense flavor.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `🌶️ Stew with extra scotch bonnet pepper - Fiery hot!`
      }
    ];
  }

  if (category === 'affordable') {
    return [
      {
        type: 'text',
        body: `${basePrefix}Here are some wallet-friendly options for you 👇`
      },
      {
        type: 'image',
        imageUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSE5UD25IlDZA5bFrhFNlm8rZlMVI2Zu9zo5obekKmfOg&s=10',
        caption: `💰 Beans and plantain - Budget-friendly & filling.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500',
        caption: `💰 Fried rice with chicken - Affordable & satisfying.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1585238341710-4913d3ca7cc0?w=500',
        caption: `💰 Akara and bread - Cheap & cheerful morning meal.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500',
        caption: `💰 Yam porridge with savory sauce - Economical & tasty.`
      },
      {
        type: 'image',
        imageUrl: 'https://images.unsplash.com/photo-1551632786-de41ec16a01d?w=500',
        caption: `💰 Rice and stew - Classic affordable combo.`
      }
    ];
  }

  if (category === 'surprise') {
    return [
      {
        type: 'text',
        body: `${basePrefix}${shortName}, here is a surprise pick: jollof rice with fried plantain and peppered fish.`
      },
      {
        type: 'image',
        imageUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSE5UD25IlDZA5bFrhFNlm8rZlMVI2Zu9zo5obekKmfOg&s=10',
        caption: `🎉 Surprise option: jollof rice with fried plantain and peppered fish.`
      }
    ];
  }

  return {
    type: 'text',
    body: `${basePrefix}I can suggest meals based on your mood, ${shortName}. Try: hungry, light, heavy, healthy, spicy, or affordable.`
  };
}

function getMoodButtonsReply(bodyText = 'Got it! Tap a category button or type a mood 😊') {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: {
        text: bodyText
      },
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
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    return null;
  }

  if (imageCache.has(query)) {
    return imageCache.get(query);
  }

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

  console.log('WhatsApp API response:', data);

  if (!response.ok) {
    console.error('Failed to send WhatsApp message:', data);
  } else {
    console.log('✅ Message sent successfully!');
  }
}

app.listen(PORT, () => {
  console.log(`Foodie WhatsApp bot running on port ${PORT}`);
});
