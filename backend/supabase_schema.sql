-- =============================================================================
-- HyperTrade — Supabase bootstrap schema (HL mobile builder)
-- =============================================================================
-- Run once in Supabase → SQL Editor on a fresh project.
--
-- Prerequisites (enabled by default on Supabase):
--   • gen_random_uuid()  (pgcrypto / pgcatalog)
--
-- Backend uses the service_role key (bypasses RLS). Client-facing tables
-- have RLS policies if you later connect the mobile app directly to Supabase.
-- =============================================================================

-- =============================================================================
-- 1. Tables (dependency order)
-- =============================================================================

-- --- Infra (mutex, leadership, replay guard) ---
CREATE TABLE IF NOT EXISTS relayer_lock (
    id TEXT PRIMARY KEY,
    holder_id TEXT,
    acquired_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS worker_leader (
    task_name TEXT PRIMARY KEY,
    holder_id TEXT,
    heartbeat_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS used_signatures (
    sig_hash TEXT PRIMARY KEY,
    used_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_used_signatures_used_at ON used_signatures(used_at);

-- --- Rewards ---
CREATE TABLE IF NOT EXISTS user_rewards (
    wallet_address TEXT PRIMARY KEY,              -- lowercase EOA
    referral_code TEXT NOT NULL UNIQUE,
    total_points INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze' CHECK (tier IN ('bronze', 'silver', 'gold', 'diamond', 'legend')),
    lifetime_volume_usd DOUBLE PRECISION DEFAULT 0,
    lifetime_cash_volume_usd DOUBLE PRECISION DEFAULT 0,  -- UR banking deposits + card spend (USD)
    referral_count INTEGER DEFAULT 0,
    achievements JSONB DEFAULT '[]'::jsonb,
    fee_discount_tenths INTEGER DEFAULT 0,
    last_volume_sync_at BIGINT DEFAULT 0,         -- HL fill timestamp cursor (master)
    volume_sync_watermarks JSONB DEFAULT '{}'::jsonb, -- per-address fill cursors (master + owned Dedicated subs)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Migration for existing deployments (CREATE TABLE IF NOT EXISTS won't add it):
ALTER TABLE user_rewards ADD COLUMN IF NOT EXISTS lifetime_cash_volume_usd DOUBLE PRECISION DEFAULT 0;
ALTER TABLE user_rewards ADD COLUMN IF NOT EXISTS volume_sync_watermarks JSONB DEFAULT '{}'::jsonb;

-- Idempotency ledger for cash (UR banking) reward credits. One row per credited
-- transaction so webhook retries / v1+v2 duplicate deliveries never double-count.
CREATE TABLE IF NOT EXISTS cash_reward_events (
    event_key TEXT PRIMARY KEY,                   -- e.g. "tx:<hash>:deposit" or content hash
    wallet_address TEXT NOT NULL,                 -- lowercase EOA credited
    amount_usd DOUBLE PRECISION NOT NULL,
    kind TEXT NOT NULL,                           -- 'deposit' | 'card_spend'
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cash_reward_events_wallet ON cash_reward_events(wallet_address);
-- Backend-only ledger: RLS on + no policies => anon/authenticated blocked,
-- service_role (backend key) bypasses RLS.
ALTER TABLE cash_reward_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS point_transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    wallet_address TEXT NOT NULL REFERENCES user_rewards(wallet_address),
    points INTEGER NOT NULL,
    reason TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pt_wallet ON point_transactions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_pt_reason ON point_transactions(reason);

CREATE TABLE IF NOT EXISTS referrals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    referrer_wallet TEXT NOT NULL REFERENCES user_rewards(wallet_address),
    referee_wallet TEXT NOT NULL UNIQUE,
    referral_code TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'qualified')),
    points_awarded BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    qualified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_wallet);
CREATE INDEX IF NOT EXISTS idx_ref_code ON referrals(referral_code);

CREATE TABLE IF NOT EXISTS pending_trade_syncs (
    wallet_address TEXT PRIMARY KEY,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_trade_syncs_enqueued_at ON pending_trade_syncs(enqueued_at);

-- --- Push & alerts ---
CREATE TABLE IF NOT EXISTS push_tokens (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id TEXT NOT NULL,                        -- Privy DID
    push_token TEXT NOT NULL,                     -- Expo push token
    device_id TEXT,
    platform TEXT CHECK (platform IN ('ios', 'android', 'web')),
    wallet_address TEXT,                          -- embedded EOA (deposit alerts)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, push_token)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_wallet_address ON push_tokens(wallet_address);

CREATE TABLE IF NOT EXISTS price_alerts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    target_price NUMERIC NOT NULL CHECK (target_price > 0),
    condition TEXT NOT NULL CHECK (condition IN ('above', 'below')),
    is_active BOOLEAN DEFAULT TRUE,
    is_triggered BOOLEAN DEFAULT FALSE,
    triggered_at TIMESTAMPTZ,
    triggered_price NUMERIC,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(is_active, is_triggered)
    WHERE is_active = TRUE AND is_triggered = FALSE;
CREATE INDEX IF NOT EXISTS idx_price_alerts_user_id ON price_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_symbol ON price_alerts(symbol)
    WHERE is_active = TRUE AND is_triggered = FALSE;

CREATE TABLE IF NOT EXISTS alert_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    target_price NUMERIC NOT NULL,
    triggered_price NUMERIC NOT NULL,
    condition TEXT NOT NULL,
    note TEXT,
    triggered_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_history_user_id ON alert_history(user_id);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id TEXT PRIMARY KEY,
    push_enabled BOOLEAN NOT NULL DEFAULT TRUE,   -- master Expo push (Profile toggle)
    system_alerts_enabled BOOLEAN DEFAULT TRUE,   -- BTC / GOLD major-move alerts
    ur_transaction_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ur_card_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ur_kyc_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Migration for existing deployments (CREATE TABLE IF NOT EXISTS won't add them):
ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS ur_transaction_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS ur_card_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS ur_kyc_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS system_alerts_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    symbol TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    from_price NUMERIC NOT NULL,
    to_price NUMERIC NOT NULL,
    move_amount NUMERIC NOT NULL,
    threshold NUMERIC NOT NULL,
    users_notified INTEGER DEFAULT 0,
    sent_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_recent ON system_alerts_log(symbol, sent_at DESC);

CREATE TABLE IF NOT EXISTS system_alert_price_snapshots (
    symbol TEXT PRIMARY KEY,
    baseline_price NUMERIC NOT NULL,
    last_alert_price NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- --- Deposits & transfers ---
CREATE TABLE IF NOT EXISTS transfer_rate_limits (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    destination TEXT NOT NULL,
    transferred_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transfer_rate_limits_user_recent
    ON transfer_rate_limits(user_address, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_rate_limits_transferred_at
    ON transfer_rate_limits(transferred_at);

CREATE TABLE IF NOT EXISTS deposit_scan_cursor (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    last_block BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_notifications_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    notified_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tx_hash, wallet_address)
);

-- --- Demo / testnet ---
CREATE TABLE IF NOT EXISTS demo_funding (
    privy_user_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    device_id TEXT,
    amount_usdc NUMERIC NOT NULL DEFAULT 100,
    tx_hash TEXT,
    master_account TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'failed')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS demo_funding_wallet_idx ON demo_funding(wallet_address);
CREATE INDEX IF NOT EXISTS demo_funding_status_claimed_idx ON demo_funding(status, claimed_at);
CREATE UNIQUE INDEX IF NOT EXISTS demo_funding_device_idx ON demo_funding(device_id)
    WHERE device_id IS NOT NULL;

-- --- Onboarding & caches ---
CREATE TABLE IF NOT EXISTS user_onboarding (
    user_id TEXT PRIMARY KEY,
    email TEXT,
    guide_completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    asset_guide_completed BOOLEAN DEFAULT FALSE,
    card_interest BOOLEAN DEFAULT FALSE,
    card_interest_at TIMESTAMPTZ,
    bank_interest BOOLEAN DEFAULT FALSE,
    bank_interest_at TIMESTAMPTZ,
    bank_region_interest BOOLEAN DEFAULT FALSE,
    bank_region_interest_country TEXT,
    bank_region_interest_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS earnings_cache (
    symbol TEXT PRIMARY KEY,
    next_earnings_date DATE,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_earnings_cache_fetched_at ON earnings_cache(fetched_at);

CREATE TABLE IF NOT EXISTS crypto_metadata (
    symbol TEXT PRIMARY KEY,
    coingecko_id TEXT,
    category TEXT,
    description TEXT,
    max_supply BIGINT,
    circulating_supply BIGINT,
    whitepaper_url TEXT,
    supply_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_fundamentals (
    symbol TEXT PRIMARY KEY,
    description TEXT,
    sector TEXT,
    industry TEXT,
    mkt_cap BIGINT,
    pe_ratio DOUBLE PRECISION,
    eps DOUBLE PRECISION,
    revenue BIGINT,
    profit_margin DOUBLE PRECISION,
    free_cash_flow BIGINT,
    fetched_at TIMESTAMPTZ,
    net_income BIGINT,
    gross_profit BIGINT,
    operating_income BIGINT,
    ebitda BIGINT,
    week52_high DOUBLE PRECISION,
    week52_low DOUBLE PRECISION,
    outstanding_shares BIGINT,              -- manual; live mcap = shares × HL price
    shares_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS outstanding_shares BIGINT;
ALTER TABLE stock_fundamentals ADD COLUMN IF NOT EXISTS shares_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS asset_descriptions (
    symbol TEXT NOT NULL,
    lang TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (symbol, lang)
);

CREATE TABLE IF NOT EXISTS news_cache (
    key TEXT PRIMARY KEY,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forex_rates_cache (
    base_currency TEXT PRIMARY KEY DEFAULT 'USD',
    rates JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 2. Functions & RPC (backend calls these via supabase.rpc)
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Relayer mutex — Bridge2/permit deposits, multi-replica safe
CREATE OR REPLACE FUNCTION acquire_relayer_lock_v2(
    p_lock_id TEXT,
    p_holder_id TEXT,
    p_ttl_seconds INTEGER DEFAULT 60
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_expires TIMESTAMPTZ := v_now + make_interval(secs => p_ttl_seconds);
BEGIN
    INSERT INTO relayer_lock (id, holder_id, acquired_at, expires_at)
    VALUES (p_lock_id, p_holder_id, v_now, v_expires)
    ON CONFLICT (id) DO NOTHING;

    IF FOUND THEN RETURN TRUE; END IF;

    -- `expires_at IS NULL` is treated as expired so orphaned rows (left over
    -- from old code paths or manual edits) cannot permanently poison a lock.
    UPDATE relayer_lock
    SET holder_id = p_holder_id,
        acquired_at = v_now,
        expires_at = v_expires
    WHERE id = p_lock_id
      AND (
          holder_id = p_holder_id
          OR expires_at IS NULL
          OR expires_at < v_now
      );

    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION release_relayer_lock_v2(
    p_lock_id TEXT,
    p_holder_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM relayer_lock
    WHERE id = p_lock_id AND holder_id = p_holder_id;
END;
$$;

CREATE OR REPLACE FUNCTION acquire_relayer_lock(
    p_holder_id TEXT,
    p_ttl_seconds INTEGER DEFAULT 60
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN acquire_relayer_lock_v2('singleton', p_holder_id, p_ttl_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION release_relayer_lock(p_holder_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM release_relayer_lock_v2('singleton', p_holder_id);
END;
$$;

-- Background worker leadership — alert loop, cache sync, demo cleanup
CREATE OR REPLACE FUNCTION try_claim_leadership(
    p_task TEXT,
    p_holder_id TEXT,
    p_ttl_seconds INTEGER DEFAULT 45
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_expires TIMESTAMPTZ := v_now + make_interval(secs => p_ttl_seconds);
BEGIN
    INSERT INTO worker_leader (task_name, holder_id, heartbeat_at, expires_at)
    VALUES (p_task, p_holder_id, v_now, v_expires)
    ON CONFLICT (task_name) DO NOTHING;

    IF FOUND THEN RETURN TRUE; END IF;

    UPDATE worker_leader
    SET holder_id = p_holder_id,
        heartbeat_at = v_now,
        expires_at = v_expires
    WHERE task_name = p_task
      AND (holder_id = p_holder_id OR expires_at < v_now);

    RETURN FOUND;
END;
$$;

-- EIP-2612 permit replay protection
CREATE OR REPLACE FUNCTION check_and_mark_signature(p_sig_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO used_signatures (sig_hash) VALUES (p_sig_hash);
    RETURN TRUE;
EXCEPTION
    WHEN unique_violation THEN RETURN FALSE;
END;
$$;

-- Rewards — matches tier ladder in backend/rewards.py
CREATE OR REPLACE FUNCTION award_points_atomic(
    p_wallet TEXT,
    p_points INTEGER,
    p_reason TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(new_total INTEGER, new_tier TEXT, new_discount INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
    v_tier TEXT;
    v_discount INTEGER;
BEGIN
    IF p_points <= 0 THEN
        SELECT total_points, tier, fee_discount_tenths
        INTO v_total, v_tier, v_discount
        FROM user_rewards WHERE wallet_address = lower(p_wallet);
        IF NOT FOUND THEN RAISE EXCEPTION 'user_rewards row not found for %', p_wallet; END IF;
        RETURN QUERY SELECT v_total, v_tier, v_discount;
        RETURN;
    END IF;

    UPDATE user_rewards
    SET total_points = total_points + p_points, updated_at = NOW()
    WHERE wallet_address = lower(p_wallet)
    RETURNING total_points INTO v_total;

    IF NOT FOUND THEN RAISE EXCEPTION 'user_rewards row not found for %', p_wallet; END IF;

    -- Keep in sync with TIERS in backend/rewards.py and the tier CHECK below.
    IF v_total >= 150000 THEN v_tier := 'legend'; v_discount := 25;  -- 0.025%
    ELSIF v_total >= 50000 THEN v_tier := 'diamond'; v_discount := 15;  -- 0.015%
    ELSIF v_total >= 10000 THEN v_tier := 'gold';    v_discount := 10;  -- 0.010%
    ELSIF v_total >= 3000  THEN v_tier := 'silver';  v_discount := 5;   -- 0.005%
    ELSE v_tier := 'bronze'; v_discount := 0;
    END IF;

    UPDATE user_rewards
    SET tier = v_tier, fee_discount_tenths = v_discount, updated_at = NOW()
    WHERE wallet_address = lower(p_wallet);

    INSERT INTO point_transactions (wallet_address, points, reason, metadata)
    VALUES (lower(p_wallet), p_points, p_reason, p_metadata);

    RETURN QUERY SELECT v_total, v_tier, v_discount;
END;
$$;

CREATE OR REPLACE FUNCTION grant_achievement_atomic(
    p_wallet TEXT,
    p_ach TEXT
)
RETURNS TABLE(granted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE user_rewards
    SET achievements = achievements || jsonb_build_array(p_ach),
        updated_at = NOW()
    WHERE wallet_address = lower(p_wallet)
      AND NOT (achievements @> jsonb_build_array(p_ach));

    RETURN QUERY SELECT FOUND;
END;
$$;

-- Replica-safe cash-volume credit: idempotency insert + cumulative increment in
-- ONE row-locked transaction. Concurrent webhook deliveries across replicas can
-- neither double-count one tx (PK on event_key) nor lose a cumulative update.
CREATE OR REPLACE FUNCTION credit_cash_volume_atomic(
    p_wallet TEXT,
    p_amount DOUBLE PRECISION,
    p_kind TEXT,
    p_event_key TEXT
)
RETURNS TABLE(credited BOOLEAN, old_volume DOUBLE PRECISION, new_volume DOUBLE PRECISION)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_old DOUBLE PRECISION;
    v_new DOUBLE PRECISION;
BEGIN
    BEGIN
        INSERT INTO cash_reward_events (event_key, wallet_address, amount_usd, kind)
        VALUES (p_event_key, lower(p_wallet), p_amount, p_kind);
    EXCEPTION WHEN unique_violation THEN
        RETURN QUERY SELECT FALSE, 0::double precision, 0::double precision;
        RETURN;
    END;

    UPDATE user_rewards
    SET lifetime_cash_volume_usd = COALESCE(lifetime_cash_volume_usd, 0) + p_amount,
        updated_at = NOW()
    WHERE wallet_address = lower(p_wallet)
    RETURNING lifetime_cash_volume_usd - p_amount, lifetime_cash_volume_usd
    INTO v_old, v_new;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'user_rewards row not found for %', p_wallet;
    END IF;

    RETURN QUERY SELECT TRUE, v_old, v_new;
END;
$$;

-- These SECURITY DEFINER rewards RPCs must only be callable by the backend
-- (service_role). Without this, anon/authenticated could grant themselves
-- points/achievements directly via PostgREST (/rest/v1/rpc/...).
REVOKE EXECUTE ON FUNCTION award_points_atomic(TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION award_points_atomic(TEXT, INTEGER, TEXT, JSONB) TO service_role;
REVOKE EXECUTE ON FUNCTION grant_achievement_atomic(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_achievement_atomic(TEXT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION credit_cash_volume_atomic(TEXT, DOUBLE PRECISION, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION credit_cash_volume_atomic(TEXT, DOUBLE PRECISION, TEXT, TEXT) TO service_role;

-- =============================================================================
-- 3. Triggers
-- =============================================================================
DROP TRIGGER IF EXISTS update_push_tokens_updated_at ON push_tokens;
CREATE TRIGGER update_push_tokens_updated_at
    BEFORE UPDATE ON push_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_price_alerts_updated_at ON price_alerts;
CREATE TRIGGER update_price_alerts_updated_at
    BEFORE UPDATE ON price_alerts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_notification_preferences_updated_at ON user_notification_preferences;
CREATE TRIGGER update_user_notification_preferences_updated_at
    BEFORE UPDATE ON user_notification_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_system_alert_price_snapshots_updated_at ON system_alert_price_snapshots;
CREATE TRIGGER update_system_alert_price_snapshots_updated_at
    BEFORE UPDATE ON system_alert_price_snapshots
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 4. Row Level Security (client-facing tables only)
-- =============================================================================
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own push tokens" ON push_tokens;
CREATE POLICY "Users can view own push tokens" ON push_tokens
    FOR SELECT USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can insert own push tokens" ON push_tokens;
CREATE POLICY "Users can insert own push tokens" ON push_tokens
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can delete own push tokens" ON push_tokens;
CREATE POLICY "Users can delete own push tokens" ON push_tokens
    FOR DELETE USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can view own alerts" ON price_alerts;
CREATE POLICY "Users can view own alerts" ON price_alerts
    FOR SELECT USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can insert own alerts" ON price_alerts;
CREATE POLICY "Users can insert own alerts" ON price_alerts
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can update own alerts" ON price_alerts;
CREATE POLICY "Users can update own alerts" ON price_alerts
    FOR UPDATE USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can delete own alerts" ON price_alerts;
CREATE POLICY "Users can delete own alerts" ON price_alerts
    FOR DELETE USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can view own alert history" ON alert_history;
CREATE POLICY "Users can view own alert history" ON alert_history
    FOR SELECT USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can view own preferences" ON user_notification_preferences;
CREATE POLICY "Users can view own preferences" ON user_notification_preferences
    FOR SELECT USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON user_notification_preferences;
CREATE POLICY "Users can update own preferences" ON user_notification_preferences
    FOR UPDATE USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON user_notification_preferences;
CREATE POLICY "Users can insert own preferences" ON user_notification_preferences
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);

-- =============================================================================
-- 5. Optional seeds (uncomment on first deploy)
-- =============================================================================
-- INSERT INTO system_alert_price_snapshots (symbol, baseline_price)
-- VALUES ('BTC', 0), ('GOLD', 0) ON CONFLICT (symbol) DO NOTHING;
--
-- INSERT INTO deposit_scan_cursor (id, last_block) VALUES ('singleton', 0)
-- ON CONFLICT (id) DO NOTHING;
