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

## Admin dashboard access

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` for the advanced admin login. To give
the team access only to vendor and driver registration, also set
`ADMIN_TEAM_USERNAME` and `ADMIN_TEAM_PASSWORD` to a different username and
password. Team accounts can use the registration forms but cannot view dashboard
statistics, orders, registered vendor/driver lists, or charts. Restart the
server after changing these values.

## Webhook configuration

Configure your Meta app webhook to point to:

- Callback URL: https://your-domain.com/webhook
- Verify Token: the value in VERIFY_TOKEN

## Live delivery tracking

After a driver accepts an order, Foodie sends the customer a private tracking
link and the driver a separate location-sharing link. The customer sees an
order-status sheet with a button to reveal the live map. The driver must open
their link on a phone, allow location access, and keep the page open while
delivering. Browser GPS requires the deployed site to use HTTPS.

Before enabling tracking on an existing Supabase database, apply
`migrations/002_delivery_tracking.sql` and
`migrations/003_delivery_confirmation_code.sql` in the Supabase SQL editor.
The tracking table stores only hashed access tokens and the latest rider
location; row-level security is enabled, and the server accesses it using the
service-role key.

After Paystack confirms payment, the customer receives a six-digit delivery
confirmation code by WhatsApp. The rider must enter that code on their rider
tracking page after handing over the order before it can be marked delivered.
Only a hash of the code is stored, and five incorrect entries lock code checks
for that order.

Set `GEOAPIFY_API_KEY` in the server environment to enable address geocoding
and road directions. Keep this key server-side; it is not sent to the browser.
The tracking pages use OpenStreetMap tiles with attribution as the basemap.
`PUBLIC_URL` must be the public HTTPS URL of the deployed app so WhatsApp can
open the rider and customer links.

Tracking updates are polled every five seconds. Location sharing is accepted
only for the assigned rider and only while the order is assigned or picked up;
direction routing to the customer becomes available after pickup and stops when
the order is delivered or cancelled.

## Voice notes

Users can send voice notes as orders. The bot downloads the WhatsApp audio,
transcribes it with OpenAI Whisper, and sends the transcript through the normal
ordering flow. Add these variables to `.env` to enable it:

```text
OPENAI_API_KEY=your-openai-api-key
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

If `OPENAI_API_KEY` is missing, text ordering continues to work and voice notes
receive a configuration message instead.

## Next steps

- Add a multi-step conversation flow
- Connect restaurant/vendor data
- Add location-based suggestions for Enugu
- Add meal planning and health goal logic
