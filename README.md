# Examly Webapp

Next.js (App Router) + Supabase Auth + Stripe checkout + server-side credits.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open: http://localhost:3000

> If `OPENAI_API_KEY` is missing, the app will still render, but AI routes will error.

## Supabase setup (required)

1) Create a Supabase project
2) In Supabase SQL editor, run **supabase.sql** (in this repo)
3) Supabase Dashboard → Settings → API:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - anon public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - service_role key → `SUPABASE_SERVICE_ROLE_KEY` (server-only)
4) Supabase Dashboard → Authentication → Providers → Email:
   - Turn OFF email confirmation (optional, but recommended for smooth signup)

## Stripe setup (Pro credits)

Examly uses a **one-time credit pack**:
- **Pro**: 30 generations for **3500 Ft** (≈ €8.9)
- Credits are stored **server-side** in Supabase.

### 1) Create the product/price
Stripe Dashboard → Products → Add product
- Name: `Examly Pro (30 generations)`
- Pricing: **One-time** (NOT recurring)
- Currency: EUR or HUF (either is fine)
- Amount: 3500 Ft or ~€8.9

Copy the **Price ID** and put it into:
- `STRIPE_PRICE_ID_PRO`

### 2) Webhook
Stripe Dashboard → Developers → Webhooks → Add endpoint
Endpoint:
- `https://YOUR_DOMAIN/api/stripe/webhook`
Events to send:
- `checkout.session.completed`

Copy the signing secret → `STRIPE_WEBHOOK_SECRET`

## Environment variables
See **.env.example**.

Important:
- `SUPABASE_SERVICE_ROLE_KEY` must be set on Vercel (Server env) and NEVER exposed to the browser.
- `NEXT_PUBLIC_SITE_URL` should be your final domain so Stripe redirect URLs are correct.

## Deploy to Vercel

1) Push repo to GitHub
2) Vercel → New Project → Import repo
3) Add env vars from `.env.example` in Vercel Project Settings
4) Deploy
5) After deploy:
   - Stripe Webhook endpoint should point to the deployed domain
   - Supabase Auth → URL configuration should include your domain as Site URL/Redirect URLs

## Credit rules
- You must be logged in to use any AI endpoint
- **Free**: 10 generations total for 48 hours (activated once per account)
- **Pro**: each purchase adds +30 credits; when credits reach 0 you can buy again

