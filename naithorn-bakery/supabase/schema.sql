-- ============================================================
-- NAITHORN BAKERY — Supabase Database Schema
-- Run this entire file in Supabase > SQL Editor > New query
-- ============================================================

-- ── Products ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  cakes_per_mix    INTEGER NOT NULL DEFAULT 48,
  cakes_per_crate  INTEGER NOT NULL DEFAULT 30,
  flour_per_mix_kg DECIMAL(10,3) NOT NULL DEFAULT 2.0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Profiles (workers / staff) ───────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('worker','delivery','sales','admin')),
  pin        TEXT NOT NULL,
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Attendance ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id),
  login_at   TIMESTAMPTZ DEFAULT NOW(),
  logout_at  TIMESTAMPTZ,
  date       DATE DEFAULT CURRENT_DATE
);

-- ── Production logs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     UUID REFERENCES profiles(id),
  product_id    UUID REFERENCES products(id),
  mixes         INTEGER NOT NULL,
  cakes_produced INTEGER NOT NULL,
  full_crates   INTEGER NOT NULL,
  loose_cakes   INTEGER NOT NULL DEFAULT 0,
  flour_used_kg DECIMAL(10,3) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Inventory (one row per product; tracks all 3 locations) ──
CREATE TABLE IF NOT EXISTS inventory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID REFERENCES products(id) UNIQUE,
  store_crates    INTEGER DEFAULT 0,
  transit_crates  INTEGER DEFAULT 0,
  market_crates   INTEGER DEFAULT 0,
  loose_store     INTEGER DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Flour stock (append-only; latest row = current stock) ────
CREATE TABLE IF NOT EXISTS flour_stock (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quantity_kg DECIMAL(10,2) NOT NULL,
  note        TEXT,
  updated_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Deliveries ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deliveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             UUID REFERENCES profiles(id),
  status                TEXT DEFAULT 'loading'
                          CHECK (status IN ('loading','transit','arrived','confirmed','complete')),
  crates_taken          INTEGER DEFAULT 0,
  departed_at           TIMESTAMPTZ,
  arrived_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  empty_crates_returned INTEGER DEFAULT 0,
  broken_cakes          INTEGER DEFAULT 0,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── Delivery items (per-product breakdown of a delivery) ─────
CREATE TABLE IF NOT EXISTS delivery_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID REFERENCES deliveries(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products(id),
  crates      INTEGER NOT NULL
);

-- ── Customers ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  phone          TEXT,
  mpesa_balance  DECIMAL(12,2) DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Mpesa payments (webhook inserts here) ────────────────────
CREATE TABLE IF NOT EXISTS mpesa_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID REFERENCES customers(id),
  phone         TEXT,
  amount        DECIMAL(12,2) NOT NULL,
  mpesa_code    TEXT UNIQUE,
  raw_payload   JSONB,
  processed     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sales ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_person_id UUID REFERENCES profiles(id),
  customer_id     UUID REFERENCES customers(id),
  product_id      UUID REFERENCES products(id),
  cakes_sold      INTEGER NOT NULL,
  price_type      TEXT CHECK (price_type IN ('retail','wholesale')),
  unit_price      DECIMAL(10,2) NOT NULL,
  total_amount    DECIMAL(12,2) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Exchanges / returns ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS exchanges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_person_id UUID REFERENCES profiles(id),
  customer_id     UUID REFERENCES customers(id),
  product_id      UUID REFERENCES products(id),
  cakes_returned  INTEGER NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- RPC FUNCTIONS
-- ============================================================

-- Called after production log; upserts inventory store values
CREATE OR REPLACE FUNCTION add_to_store(
  p_product_id UUID,
  p_crates     INTEGER,
  p_loose      INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO inventory (product_id, store_crates, loose_store)
  VALUES (p_product_id, p_crates, p_loose)
  ON CONFLICT (product_id) DO UPDATE
    SET store_crates = inventory.store_crates + EXCLUDED.store_crates,
        loose_store  = inventory.loose_store  + EXCLUDED.loose_store,
        updated_at   = NOW();
END;
$$;

-- Called by Mpesa webhook Edge Function to credit customer balance
CREATE OR REPLACE FUNCTION credit_customer_from_mpesa(
  p_phone      TEXT,
  p_amount     DECIMAL,
  p_mpesa_code TEXT,
  p_payload    JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_payment  mpesa_payments%ROWTYPE;
BEGIN
  -- Find customer by phone (strip leading + or 254 prefix variants)
  SELECT * INTO v_customer
  FROM customers
  WHERE phone = p_phone
     OR phone = REGEXP_REPLACE(p_phone, '^(\+254|254|0)', '0')
     OR '254' || SUBSTRING(p_phone FROM 2) = p_phone
  LIMIT 1;

  -- Insert payment record regardless
  INSERT INTO mpesa_payments (customer_id, phone, amount, mpesa_code, raw_payload)
  VALUES (v_customer.id, p_phone, p_amount, p_mpesa_code, p_payload)
  ON CONFLICT (mpesa_code) DO NOTHING
  RETURNING * INTO v_payment;

  -- If customer found, add to their balance
  IF v_customer.id IS NOT NULL AND v_payment.id IS NOT NULL THEN
    UPDATE customers
    SET mpesa_balance = mpesa_balance + p_amount
    WHERE id = v_customer.id;

    UPDATE mpesa_payments SET processed = TRUE WHERE id = v_payment.id;

    RETURN jsonb_build_object('status','credited','customer',v_customer.name,'amount',p_amount);
  END IF;

  RETURN jsonb_build_object('status','pending','message','Customer not found for phone: ' || p_phone);
END;
$$;


-- ============================================================
-- ENABLE REALTIME
-- ============================================================
-- Run these in Supabase > Database > Replication or via SQL:

ALTER PUBLICATION supabase_realtime ADD TABLE production_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE inventory;
ALTER PUBLICATION supabase_realtime ADD TABLE deliveries;
ALTER PUBLICATION supabase_realtime ADD TABLE delivery_items;
ALTER PUBLICATION supabase_realtime ADD TABLE sales;
ALTER PUBLICATION supabase_realtime ADD TABLE attendance;
ALTER PUBLICATION supabase_realtime ADD TABLE flour_stock;
ALTER PUBLICATION supabase_realtime ADD TABLE mpesa_payments;
ALTER PUBLICATION supabase_realtime ADD TABLE customers;


-- ============================================================
-- ROW LEVEL SECURITY
-- This app uses PIN-based identity (not Supabase Auth).
-- All tables are open to the anon key. Restrict further
-- once Supabase Auth is integrated in a future version.
-- ============================================================

ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory        ENABLE ROW LEVEL SECURITY;
ALTER TABLE flour_stock      ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mpesa_payments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales            ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchanges        ENABLE ROW LEVEL SECURITY;

-- Grant anon access to all (PIN auth is the security layer)
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'products','profiles','attendance','production_logs','inventory',
    'flour_stock','deliveries','delivery_items','customers',
    'mpesa_payments','sales','exchanges'
  ]) LOOP
    EXECUTE format('CREATE POLICY "anon_all" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;


-- ============================================================
-- SEED DATA
-- ============================================================

-- Products
INSERT INTO products (name, cakes_per_mix, cakes_per_crate, flour_per_mix_kg) VALUES
  ('Mandazi',    48, 30, 2.0),
  ('Plain Cake', 24, 12, 1.5),
  ('Doughnuts',  36, 24, 1.8)
ON CONFLICT DO NOTHING;

-- Profiles  (change PINs before going live!)
-- Suggested PINs below — owner sets real ones after first deploy
INSERT INTO profiles (name, role, pin) VALUES
  ('Wanjiku',  'worker',   '1111'),
  ('Kamau',    'delivery', '2222'),
  ('Achieng',  'sales',    '3333'),
  ('Owner',    'admin',    '0000')
ON CONFLICT DO NOTHING;

-- Inventory rows (one per product, starting at 0)
INSERT INTO inventory (product_id, store_crates, transit_crates, market_crates)
SELECT id, 0, 0, 0 FROM products
ON CONFLICT (product_id) DO NOTHING;

-- Initial flour stock (edit kg to match your actual stock)
INSERT INTO flour_stock (quantity_kg, note)
VALUES (200.0, 'Initial stock entry')
ON CONFLICT DO NOTHING;

-- Sample customers
INSERT INTO customers (name, phone, mpesa_balance) VALUES
  ('Grace Mwangi',    '0712345678', 500.00),
  ('Peter Otieno',    '0723456789', 1200.00),
  ('Fatuma Hassan',   '0734567890', 800.00),
  ('James Kariuki',   '0745678901', 2500.00),
  ('Mary Njoroge',    '0756789012', 350.00),
  ('David Odhiambo',  '0767890123', 0.00),
  ('Alice Wambui',    '0778901234', 150.00),
  ('Samuel Maina',    '0789012345', 600.00)
ON CONFLICT DO NOTHING;
