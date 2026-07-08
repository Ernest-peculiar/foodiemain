# Foodie WhatsApp Bot

This project is a starter WhatsApp Business API bot for the Foodie concept.

## What it does
- Receives WhatsApp messages through a webhook
- Sends simple food recommendations based on the user’s mood
- Can be extended into a full meal recommendation and vendor discovery experience

## Setup
1. Copy .env.example to .env
2. Fill in your Meta WhatsApp Cloud API credentials
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Webhook configuration
Configure your Meta app webhook to point to:
- Callback URL: https://your-domain.com/webhook
- Verify Token: the value in VERIFY_TOKEN

## Next steps
- Add a multi-step conversation flow
- Connect restaurant/vendor data
- Add location-based suggestions for Enugu
- Add meal planning and health goal logic
