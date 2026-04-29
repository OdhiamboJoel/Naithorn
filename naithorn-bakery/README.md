# 🍞 Naithorn Bakery Management System

Real-time bakery operations for **Naithorn Bakery Ltd.** — one URL, four roles, zero blind spots.

---

## What this system does

| Role | What they see |
|------|--------------|
| **Worker** | Logs production batches → system calculates crates, cakes, flour |
| **Delivery** | Loads crates, live transit timer, arrival logging |
| **Sales** | Customer search, Mpesa balance, record sales, live stock |
| **Admin** | Everything — revenue, chart, inventory, flour days, attendance, every sale |

All screens update in real time. No page refresh needed.

---

## Tech stack

- **Frontend** — React + Vite (runs in any phone browser)
- **Database & Realtime** — Supabase (Postgres + WebSockets)
- **Hosting** — Vercel (free tier is fine)
- **Payments** — Mpesa Daraja API (STK Push + C2B webhook)

---

## Setup (one time, ~30 minutes)

### Step 1 — Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Name it `naithorn-bakery`, choose a strong database password, pick **Africa (South Africa)** region for lowest latency from Kenya
3. Wait for the project to be ready (~2 minutes)
4. Go to **SQL Editor → New query**
5. Paste the entire contents of `supabase/schema.sql` and click **Run**
6. You should see "Success" — all tables, seed data, and functions are now created

### Step 2 — Get your Supabase credentials

In Supabase go to **Settings → API**:
- Copy **Project URL** → this is your `VITE_SUPABASE_URL`
- Copy **anon / public** key → this is your `VITE_SUPABASE_ANON_KEY`

### Step 3 — Enable Realtime

In Supabase go to **Database → Replication**:
- Enable realtime for these tables: `sales`, `inventory`, `production_logs`, `deliveries`, `delivery_items`, `attendance`, `flour_stock`, `customers`, `mpesa_payments`
- (The schema.sql does this automatically but double-check here)

### Step 4 — Deploy to Vercel

1. Push this folder to a GitHub repository
2. Go to [vercel.com](https://vercel.com) → New Project → Import your repo
3. Framework preset: **Vite**
4. Add environment variables:
   ```
   VITE_SUPABASE_URL       = https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY  = your-anon-key
   ```
5. Click **Deploy**
6. Your URL will be something like `naithorn-bakery.vercel.app`

To set a custom domain (e.g. `app.naithorn.co.ke`), go to Vercel → Project Settings → Domains.

### Step 5 — Change the default PINs

In Supabase → **Table Editor → profiles**, change the PIN column for each user:
```sql
UPDATE profiles SET pin = '7823' WHERE name = 'Wanjiku';
UPDATE profiles SET pin = '4591' WHERE name = 'Kamau';
UPDATE profiles SET pin = '6207' WHERE name = 'Achieng';
UPDATE profiles SET pin = '9134' WHERE name = 'Owner';
```
Use 4-digit PINs that your staff will remember. Tell each person their PIN privately.

### Step 6 — Add your real customers

Either edit the seed customers in the SQL, or insert directly via SQL:
```sql
INSERT INTO customers (name, phone, mpesa_balance)
VALUES ('Customer Name', '07XXXXXXXX', 0.00);
```

Or use Supabase Table Editor to add rows with a GUI.

---

## Mpesa Daraja integration

When a customer pays on the till number, the system receives the payment and automatically credits their balance in the app.

### Create a Supabase Edge Function (the webhook receiver)

1. In Supabase go to **Edge Functions → New Function** → name it `mpesa-webhook`
2. Paste this code:

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  try {
    const body = await req.json()

    // Safaricom C2B callback structure
    const result = body?.Body?.stkCallback || body
    const items  = result?.CallbackMetadata?.Item || []

    const getItem = (name: string) =>
      items.find((i: any) => i.Name === name)?.Value

    const amount     = getItem('Amount')
    const phone      = String(getItem('PhoneNumber') || '')
    const mpesaCode  = getItem('MpesaReceiptNumber')

    if (!amount || !phone || !mpesaCode) {
      return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 })
    }

    // Credit customer balance
    const { data, error } = await supabase.rpc('credit_customer_from_mpesa', {
      p_phone:      phone,
      p_amount:     parseFloat(amount),
      p_mpesa_code: mpesaCode,
      p_payload:    body,
    })

    if (error) throw error

    return new Response(JSON.stringify({ success: true, result: data }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
```

3. Deploy the function — Supabase gives you a URL like:
   `https://your-project.supabase.co/functions/v1/mpesa-webhook`

### Register the webhook on Safaricom Daraja

1. Go to [developer.safaricom.co.ke](https://developer.safaricom.co.ke)
2. Log in → select your Till Number / Shortcode app
3. Under **C2B URLs**, set:
   - Confirmation URL: `https://your-project.supabase.co/functions/v1/mpesa-webhook`
   - Validation URL: same URL (or a simple 200-response endpoint)
4. Safaricom will now POST every payment to your function, which credits the customer's balance in real time

> **Note:** For sandbox testing, use the Safaricom test till numbers. The app works fully without Mpesa — you can manually top up customer balances via Supabase Table Editor while waiting for Daraja approval.

---

## Local development

```bash
# Clone your repo
git clone https://github.com/yourname/naithorn-bakery
cd naithorn-bakery

# Install dependencies
npm install

# Create .env from template
cp .env.example .env
# Edit .env with your Supabase credentials

# Start dev server
npm run dev
# Opens at http://localhost:5173
```

---

## Business constants (edit in code if needed)

Located in `src/views/SalesView.jsx` and `src/views/AdminView.jsx`:
```js
const RETAIL    = 50  // KES per cake
const WHOLESALE = 43  // KES per cake
```

Located in `supabase/schema.sql` seed data:
```sql
-- Products: name, cakes_per_mix, cakes_per_crate, flour_per_mix_kg
('Mandazi',    48, 30, 2.0),
('Plain Cake', 24, 12, 1.5),
('Doughnuts',  36, 24, 1.8)
```
Adjust these numbers to match your actual bakery recipes.

---

## Adding new products

In Supabase SQL Editor:
```sql
INSERT INTO products (name, cakes_per_mix, cakes_per_crate, flour_per_mix_kg)
VALUES ('New Product', 40, 20, 1.6);

INSERT INTO inventory (product_id) SELECT id FROM products WHERE name = 'New Product';
```

## Adding a new staff member

```sql
INSERT INTO profiles (name, role, pin)
VALUES ('New Person', 'worker', '5678');
-- Roles: worker | delivery | sales | admin
```

---

## Security notes

- PINs are stored as plain text in this MVP. Before going live, hash them with `pgcrypto` and update the login query.
- The anon key has full table access — this is fine for a small trusted team on a private URL. For a public app, restrict RLS policies per role.
- Never share your Supabase `service_role` key — it bypasses all RLS.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Missing Supabase environment variables" | Check `.env` file exists and has correct values |
| Login shows no profiles | Run `SELECT * FROM profiles;` in SQL Editor — must have rows |
| Real-time not updating | Check Replication settings in Supabase — all 9 tables must be enabled |
| Mpesa payments not reflecting | Check Edge Function logs in Supabase → Logs → Edge Functions |
| Inventory not updating after sale | Verify `inventory` table has a row for every product |

---

*Built for Naithorn Bakery Ltd. — production-ready, mobile-first, real-time.*
