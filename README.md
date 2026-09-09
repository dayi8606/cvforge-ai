# CVForge AI — Phase 2

This is the Phase 2 full-stack version of CVForge AI.

## Included
- Account registration/login
- SQLite database for users and CVs
- HTTP-only JWT authentication cookie
- CV save/read/update/delete API
- Server-side OpenAI Responses API integration
- AI summary improvement
- AI experience improvement
- AI skills suggestions
- Job-description tailoring
- Server-side monthly AI usage limits
- Free and Pro plan limits
- Responsive CV builder
- Print / Save as PDF through the browser

## Setup

Requirements: Node.js 20+

1. Extract the project.
2. Open a terminal in the project folder.
3. Run:
   npm install
4. Copy `.env.example` to `.env`.
5. Set a strong `JWT_SECRET`.
6. Add your server-side OpenAI API key:
   OPENAI_API_KEY=your_key_here
7. Keep the API key only in `.env`. Never put it in browser JavaScript.
8. Run:
   npm start
9. Open:
   http://localhost:3000

## AI limits
Default:
- Free: 3 AI generations per month
- Pro: 100 AI generations per month

Change `FREE_AI_LIMIT` and `PRO_AI_LIMIT` in `.env` as needed.

## Important production work still needed
- Paystack/Flutterwave checkout and server-side payment verification
- Real subscription status management/webhooks
- Email verification and password reset
- Rate limiting and abuse protection
- Strong input validation
- CSRF strategy appropriate to the deployment
- HTTPS
- Production database/backups
- Privacy policy and terms
- Monitoring/logging
- Better PDF generation/templates
- Admin dashboard
- Automated tests

The AI key is deliberately not included in this download.


## Completed additions
- Classic, Modern and Minimal CV templates
- Server-side PDF generation with PDFKit
- Download PDF button
- Education and certifications
- Plans endpoint
- Payment checkout placeholder ready for Paystack/Flutterwave integration
- Template selection saved with each CV

## Payment note
The checkout endpoint does not process real money yet. Before launch, connect a real payment provider, verify transactions on the server, handle webhooks, and only then change a user's plan. Do not put payment secret keys in browser JavaScript.


## Global payments — Stripe
The project now has Stripe Checkout support for:
- Pro monthly subscription
- Career Pack one-time payment
- Server-side webhook verification
- Automatic plan activation after successful checkout
- Automatic downgrade to Free when a Pro subscription is cancelled

Configure these in `.env`:
- `APP_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_CAREER_PRICE_ID`

Stripe webhook endpoint:
`https://YOUR-DOMAIN.com/api/payments/stripe/webhook`

Recommended webhook events:
- `checkout.session.completed`
- `customer.subscription.deleted`

Keep all Stripe secret values on the server.

For a worldwide customer base, use USD prices and Stripe Checkout. Stripe lists Nigeria in its supported/extended-network markets, while actual merchant eligibility and payment-method availability depend on the account and region.
