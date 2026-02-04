CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  added_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS phone_code_seq START 1 INCREMENT 1;

CREATE TABLE IF NOT EXISTS listings (
  id BIGSERIAL PRIMARY KEY,
  code INTEGER UNIQUE NOT NULL DEFAULT nextval('phone_code_seq'),
  mode TEXT NOT NULL CHECK (mode IN ('db_channel', 'only_channel')),
  model TEXT NOT NULL,
  name TEXT NOT NULL,
  condition TEXT NOT NULL,
  storage TEXT NOT NULL,
  color TEXT NOT NULL,
  box TEXT NOT NULL,
  price NUMERIC NOT NULL,
  price_formatted TEXT NOT NULL,
  battery TEXT NOT NULL,
  exchange BOOLEAN NOT NULL DEFAULT TRUE,
  warranty TEXT NOT NULL DEFAULT '1 oy',
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  images TEXT[] NOT NULL,
  telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id BIGSERIAL PRIMARY KEY,
  order_code TEXT UNIQUE NOT NULL,
  listing_code INTEGER NOT NULL REFERENCES listings(code) ON DELETE CASCADE,
  user_id BIGINT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  down_payment NUMERIC NOT NULL,
  months INTEGER NOT NULL CHECK (months >= 2 AND months <= 12),
  monthly_payment NUMERIC NOT NULL,
  total_payment NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'sold', 'canceled')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
