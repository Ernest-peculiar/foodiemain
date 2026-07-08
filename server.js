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

async function buildReply(text, name = 'friend', session = {}) {
  const normalized = text.trim().toLowerCase();
  const shortName = name.split(' ')[0] || 'friend';
  const mood = getMoodCategory(normalized);

  if (!normalized) {
    return {
      replies: {
        type: 'text',
        body: `Hi ${shortName}! I am Foodie. I can help you choose what to eat. Reply with: hungry, light, heavy, healthy, spicy, affordable, or just say hi.`
      },
      nextStage: null
    };
  }

  if (session.stage === 'askCategory') {
    if (mood) {
      return {
        replies: {
          type: 'text',
          body: `Yum! What did you eat last? 🍲 😊`
        },
        nextStage: 'askLastMeal',
        sessionData: { mood }
      };
    }

    return {
      replies: getMoodButtonsReply('Hmm, I didn\'t catch that. Pick a tasty mood! 😊'),
      nextStage: 'askCategory'
    };
  }

  if (session.stage === 'askLastMeal') {
    return {
      replies: await buildMoodReply(session.mood, shortName, text.trim()),
      nextStage: null
    };
  }

  if (['hi', 'hello', 'hey', 'start'].includes(normalized)) {
    return {
      replies: {
        type: 'text',
        body: `Hi ${shortName}! 😂 I'm Foodie — your personal Nigerian food guide. What do you want to eat? Reply with hungry, light, heavy, healthy, spicy, or affordable.`
      },
      nextStage: null
    };
  }

  if (normalized.includes('hungry')) {
    return {
      replies: getMoodButtonsReply('Yay! Let\'s pick something yummy 😄'),
      nextStage: 'askCategory'
    };
  }

  if (mood) {
    return {
      replies: {
        type: 'text',
        body: `Great choice! What did you eat last? 🍲 😊`
      },
      nextStage: 'askLastMeal',
      sessionData: { mood }
    };
  }

  return {
    replies: {
      type: 'text',
      body: `I can suggest meals based on your mood, ${shortName}. Try: hungry, light, heavy, healthy, spicy, or affordable.`
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

  if (category === 'surprise') {
    return [
      {
        type: 'text',
        body: `${basePrefix}${shortName}, here is a surprise pick: jollof rice with fried plantain and peppered fish.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('surprise1.png'),
        caption: `${basePrefix}Surprise option: jollof rice with fried plantain and peppered fish.`
      }
    ];
  }

  if (category === 'light') {
    return [
      {
        type: 'text',
        body: `${basePrefix}Here are some lighter options for you 👇`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('light1.png'),
        caption: `${basePrefix}Light option 1 for ${shortName}: Nigerian moi moi with a side of pap.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('light2.png'),
        caption: `${basePrefix}Light option 2 for ${shortName}: akara and fresh fried plantain.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('light3.png'),
        caption: `${basePrefix}Light option 3 for ${shortName}: salad bowl with grilled fish and light Nigerian flavors.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('light4.png'),
        caption: `${basePrefix}Light option 4 for ${shortName}: steamed vegetables with a small portion of lean protein.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('light5.png'),
        caption: `${basePrefix}Light option 5 for ${shortName}: fruit and nut bowl with ginger syrup.`
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
        type: 'text',
        body: `1. Pounded yam with egusi soup — rich, comforting, and filling.`
      },
      {
        type: 'text',
        body: `2. Oha soup with fufu — a wholesome heavy meal with deep flavor.`
      },
      {
        type: 'text',
        body: `3. Ogbono with eba — thick, oily, and very satisfying.`
      },
      {
        type: 'text',
        body: `4. Fried rice with chicken stew — loaded and delicious.`
      },
      {
        type: 'text',
        body: `5. Suya platter with spicy beef — bold, hearty, and perfect for a big appetite.`
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
        imageUrl: getLocalImageUrl('healthy1.png'),
        caption: `${basePrefix}Healthy option 1 for ${shortName}: grilled fish with steamed greens.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('healthy2.png'),
        caption: `${basePrefix}Healthy option 2 for ${shortName}: okra soup with fish and a light swallow.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('healthy3.png'),
        caption: `${basePrefix}Healthy option 3 for ${shortName}: boiled plantain with lean stew.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('healthy4.png'),
        caption: `${basePrefix}Healthy option 4 for ${shortName}: vegetable soup with lean protein.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('healthy5.png'),
        caption: `${basePrefix}Healthy option 5 for ${shortName}: fruit bowl with nuts and honey.`
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
        imageUrl: getLocalImageUrl('spicy1.png'),
        caption: `${basePrefix}Spicy option 1 for ${shortName}: suya with onions and chili.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('spicy2.png'),
        caption: `${basePrefix}Spicy option 2 for ${shortName}: hearty pepper soup with meat.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('spicy3.png'),
        caption: `${basePrefix}Spicy option 3 for ${shortName}: spicy jollof rice with extra pepper.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('spicy4.png'),
        caption: `${basePrefix}Spicy option 4 for ${shortName}: peppered goat meat with bold spices.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('spicy5.png'),
        caption: `${basePrefix}Spicy option 5 for ${shortName}: stew with extra scotch bonnet pepper.`
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
        imageUrl: getLocalImageUrl('affordable1.png'),
        caption: `${basePrefix}Affordable option 1 for ${shortName}: beans and plantain.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('affordable2.png'),
        caption: `${basePrefix}Affordable option 2 for ${shortName}: fried rice with chicken.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('affordable3.png'),
        caption: `${basePrefix}Affordable option 3 for ${shortName}: akara and bread.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('affordable4.png'),
        caption: `${basePrefix}Affordable option 4 for ${shortName}: yam porridge with savory sauce.`
      },
      {
        type: 'image',
        imageUrl: getLocalImageUrl('affordable5.png'),
        caption: `${basePrefix}Affordable option 5 for ${shortName}: rice and stew.`
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
      type: 'button',
      body: {
        text: bodyText
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'light', title: '🥗 Light & lovely' } },
          { type: 'reply', reply: { id: 'spicy', title: '🌶️ Spicy & bold' } },
          { type: 'reply', reply: { id: 'surprise', title: '🌟 Surprise me' } }
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
