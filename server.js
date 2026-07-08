require('dotenv').config();
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const imageCache = new Map();
const { getMealsByCategory, getRandomMeals, buildMealReplies } = require('./foodService');

app.use(express.json());

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
    const surpriseMeals = getMealsByCategory('surprise');
    const picks = getRandomMeals(surpriseMeals, 1);
    const text = picks[0]
      ? `${basePrefix}${shortName}, here is a surprise pick: ${picks[0].name}. ${picks[0].description}`
      : `${basePrefix}${shortName}, here is a surprise pick: jollof rice with fried plantain.`;
    return { type: 'text', body: text };
  }

  const meals = getMealsByCategory(category);
  if (!meals || meals.length === 0) {
    return {
      type: 'text',
      body: `${basePrefix}I can suggest meals based on your mood, ${shortName}. Try: hungry, light, heavy, healthy, spicy, or affordable.`
    };
  }

  const picks = getRandomMeals(meals, 5);
  return buildMealReplies(picks, basePrefix);
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

async function searchGoogleImage(query) {
  // Deprecated - removed dynamic Google image search in favor of local catalog
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
