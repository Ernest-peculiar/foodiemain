// WhatsApp and Paystack webhook handlers
module.exports = function setupWebhookRoutes(app, dependencies) {
  const { crypto, isValidWhatsAppPayload, VERIFY_TOKEN, WHATSAPP_TOKEN, PAYSTACK_SECRET_KEY,  DEBUG, handleIncomingMessage } = dependencies;

  // WhatsApp webhook verification
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  });

  // WhatsApp incoming messages webhook
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
              // Safety net: never let one bad message crash the whole webhook
              console.error('handleIncomingMessage failed:', error);
            }
          }
        }
      }
    }

    res.sendStatus(200);
  });

  // Paystack webhook for payment verification
  app.post('/webhook/paystack', async (req, res) => {
    console.log(`📩 /webhook/paystack hit — event=${req.body?.event || '(no event field)'} reference=${req.body?.data?.reference || '(none)'}`);

    const signature = req.headers['x-paystack-signature'];

    if (!PAYSTACK_SECRET_KEY) {
      console.error('🔴 PAYSTACK_SECRET_KEY is not set — rejecting webhook with 400.');
      return res.sendStatus(400);
    }
    if (!signature) {
      console.error('🔴 Request had no x-paystack-signature header — rejecting with 400.');
      return res.sendStatus(400);
    }
    if (!req.rawBody) {
      console.error('🔴 req.rawBody is missing — check middleware order.');
      return res.sendStatus(400);
    }

    const expectedHash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest('hex');

    if (expectedHash !== signature) {
      console.warn('🔴 Paystack webhook signature mismatch — ignoring request.');
      return res.sendStatus(401);
    }

    console.log('✅ Signature verified.');
    res.sendStatus(200);

    // Note: Payment event handling implemented in handlePaystackChargeSuccess
    const event = req.body;
    if (event?.event === 'charge.success') {
      console.log(`Processing charge success for reference ${event.data?.reference}`);
      // Handle payment - see server.js for full implementation
    } else {
      console.log(`ℹ️ Ignoring non-charge.success event: ${event?.event}`);
    }
  });
};
