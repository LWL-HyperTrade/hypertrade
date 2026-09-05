-- AI agents: signal snapshots + forward outcomes (worker-only, Tier 2).
--
-- One row per symbol × bar interval × horizon per worker cycle: the flag
-- state and composite score the LLM saw, the HL mid / book at that moment,
-- and — back-filled on later cycles from the CoinGlass bar series — the
-- realized forward returns and max favorable / adverse excursions.
--
-- Purpose: make the hand-set composite weights and flag thresholds
-- *checkable*. Nothing reads this table on the trade path.
-- Writer: workers/ai-agent/src/lib/signalSnapshots.ts (service role).
-- RLS enabled with NO policies (deny-all for anon/authenticated), matching
-- the other ai_agent* tables.

CREATE TABLE IF NOT EXISTS ai_signal_snapshots (
  id bigserial PRIMARY KEY,
  -- Cycle boundary the decision belonged to (floor to the opening window).
  cycle_ts timestamptz NOT NULL,
  symbol text NOT NULL,
  bar_interval text NOT NULL CHECK (bar_interval IN ('1h', '30m')),
  -- Flag lookbacks scale with horizon, so the same bars yield different flags.
  horizon text NOT NULL CHECK (horizon IN ('scalper', 'swing', 'investor')),
  trading_env text NOT NULL CHECK (trading_env IN ('mainnet', 'demo')),

  -- Price fed to the decision (HL live mid, or bar close when HL was down).
  price numeric NOT NULL,
  price_source text NOT NULL CHECK (price_source IN ('hl_mid', 'bar_close')),
  -- Return basis: open ts + close of the last CLOSED CoinGlass bar.
  bar_close_ts timestamptz NOT NULL,
  bar_close numeric NOT NULL,

  long_score int NOT NULL,
  short_score int NOT NULL,
  drivers_long jsonb,
  drivers_short jsonb,
  -- Full ScalperFlags object (brain/computeScalperFlags.ts).
  flags jsonb NOT NULL,
  -- L2 snapshot summary (spread / imbalance / depth) when available.
  book jsonb,

  -- Forward outcomes (fractional, bar close → bar close). Filled later.
  ret_1h numeric,
  ret_4h numeric,
  ret_24h numeric,
  -- Max favorable / adverse excursion from the long perspective
  -- (high/low over the window ÷ bar_close − 1). Flip signs for shorts.
  max_up_4h numeric,
  max_down_4h numeric,
  max_up_24h numeric,
  max_down_24h numeric,
  outcomes_filled_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (cycle_ts, symbol, bar_interval, horizon, trading_env)
);

CREATE INDEX IF NOT EXISTS idx_ai_signal_snapshots_symbol_ts
  ON ai_signal_snapshots (symbol, cycle_ts DESC);

-- Backfill scan: recent rows still missing the 24h outcome.
CREATE INDEX IF NOT EXISTS idx_ai_signal_snapshots_pending
  ON ai_signal_snapshots (cycle_ts) WHERE ret_24h IS NULL;

ALTER TABLE ai_signal_snapshots ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ai_signal_snapshots IS
  'Per-cycle AI signal state (flags, composite score, HL mid, L2 book) with back-filled 1h/4h/24h forward returns and excursions. Calibration data only — no trade-path reads. Service-role only.';
COMMENT ON COLUMN ai_signal_snapshots.flags IS
  'ScalperFlags jsonb as computed for this horizon (workers/ai-agent/src/brain/computeScalperFlags.ts).';
COMMENT ON COLUMN ai_signal_snapshots.ret_1h IS
  'Fractional bar-to-bar return 1h after bar_close_ts (close(t0+1h)/bar_close − 1). NULL until the target bar has closed.';
