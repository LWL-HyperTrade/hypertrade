import axios from 'axios';
import Constants from 'expo-constants';

type ExpoExtra = Record<string, unknown> | undefined;

function getExtra(): ExpoExtra {
  // Expo runtime metadata differs between Expo Go / dev-client / production builds.
  // Try the common locations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Constants.expoConfig?.extra as any) ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((Constants as any).manifest2?.extra as any) ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((Constants as any).manifest?.extra as any);
}

const extra = getExtra();

// Prefer process.env so dev integrations can override without requiring a rebuild.
// No committed production URL — set EXPO_PUBLIC_BACKEND_URL in .env / EAS.
const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  (extra?.EXPO_PUBLIC_BACKEND_URL as string | undefined) ||
  '';

export const RESOLVED_BACKEND_URL = BACKEND_URL;
export const API_BASE_URL = BACKEND_URL ? `${BACKEND_URL}/api` : '/api';

if (!BACKEND_URL) {
  // eslint-disable-next-line no-console
  console.error(
    '[api] EXPO_PUBLIC_BACKEND_URL is not set. Copy frontend/.env.example → frontend/.env (or EAS secrets).',
  );
} else if (__DEV__) {
  // Helps confirm on-device which backend URL is being used.
  // eslint-disable-next-line no-console
  console.log('[api] RESOLVED_BACKEND_URL =', RESOLVED_BACKEND_URL);
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

if (__DEV__) {
  api.interceptors.response.use(
    (r) => r,
    (error) => {
      // eslint-disable-next-line no-console
      console.log('[api] request failed', {
        baseURL: api.defaults.baseURL,
        url: error?.config?.url,
        method: error?.config?.method,
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });
      return Promise.reject(error);
    }
  );
}

// Types
export interface Asset {
  coin: string;
  name: string;
  symbol: string;
  category: string;
  maxLeverage: number;
  szDecimals: number;
  markPx: string | null;
  prevDayPx: string | null;
  dayNtlVlm: string | null;
  openInterest: string | null;
  funding: string | null;
  change24h: number | null;
  isHip3: boolean;
  /** Live Pre-IPO perpetual — Home + asset-page badge. */
  isPreIpo?: boolean;
  /** HIP-3: true when HL meta growthMode is enabled (90% fee discount). */
  growthMode?: boolean | null;
  /** HIP-3: deployer fee scale from HL meta (drives hip3Scale in fee formula). */
  deployerFeeScale?: number | null;
  nextEarnings?: string;
  /** HIP-3 perp dex name (`xyz`, `io`). Omitted `dex` in metadata means xyz. */
  dex?: string | null;
  /** Pre-IPO mark/oracle clip bounds (Entropy L/U). Book can still trade outside. */
  preIpoBoundLow?: number | null;
  preIpoBoundHigh?: number | null;
  /** Deployer OI cap label (e.g. `3M`). */
  openInterestCapLabel?: string | null;
  /** True when $1 of contract = $1B issuer market cap. */
  preIpoMcapQuote?: boolean | null;
  isSpotOnly?: boolean;
  hasSpot?: boolean;
  spotSymbol?: string | null;
}

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface BuilderConfig {
  address: string;
  fee: number;
  base_fee?: number;
  discount?: number;
}

// API Functions
export async function fetchAssets(): Promise<{ assets: Asset[]; count: number }> {
  const response = await api.get('/assets');
  return response.data;
}

export async function fetchCryptoAssets(): Promise<{ assets: Asset[]; count: number }> {
  const response = await api.get('/crypto-assets');
  return response.data;
}

export async function fetchAssetDetail(coin: string): Promise<Asset & { oraclePx?: string; midPx?: string; impactPxs?: string[] }> {
  const response = await api.get(`/assets/${encodeURIComponent(coin)}`);
  return response.data;
}

export async function fetchCandles(
  coin: string,
  interval: string = '1h',
  limit: number = 100,
  startTime?: number,
  endTime?: number
): Promise<{ candles: Candle[]; coin: string; interval: string }> {
  const response = await api.get(`/candles/${encodeURIComponent(coin)}`, {
    params: { interval, limit, startTime, endTime }
  });
  return response.data;
}

export async function fetchPrices(dex?: string): Promise<{ prices: Record<string, string> }> {
  const response = await api.get('/prices', { params: dex ? { dex } : undefined });
  return response.data;
}

export async function fetchBuilderConfig(walletAddress?: string): Promise<BuilderConfig> {
  const params = walletAddress ? { wallet_address: walletAddress } : undefined;
  const response = await api.get('/builder-config', { params });
  return response.data;
}

export async function fetchDexes(): Promise<{ dexes: any[]; hip3_dexes: string[] }> {
  const response = await api.get('/dexes');
  return response.data;
}

export interface CryptoMetadata {
  symbol: string;
  coingecko_id: string | null;
  category: string | null;
  description: string | null;
  max_supply: number | null;
  circulating_supply: number | null;
  whitepaper_url: string | null;
  supply_updated_at: string | null;
}

export async function fetchCryptoMetadata(symbol: string): Promise<CryptoMetadata> {
  const response = await api.get(`/crypto-metadata/${encodeURIComponent(symbol)}`);
  return response.data;
}

export interface StockFundamentals {
  symbol: string;
  description: string | null;
  sector: string | null;
  industry: string | null;
  mkt_cap: number | null;
  outstanding_shares: number | null;
  shares_updated_at: string | null;
  pe_ratio: number | null;
  eps: number | null;
  revenue: number | null;
  net_income: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  ebitda: number | null;
  profit_margin: number | null;
  free_cash_flow: number | null;
  week52_high: number | null;
  week52_low: number | null;
  fetched_at: string | null;
}

export async function fetchStockFundamentals(symbol: string): Promise<StockFundamentals> {
  const sym = symbol.toUpperCase();
  try {
    const response = await api.get(`/stock-fundamentals/${encodeURIComponent(sym)}`);
    return response.data;
  } catch (err: unknown) {
    // Legacy servers returned 404 when Finnhub had no row yet — treat as empty
    // so Info still renders TBA rows without dev-console noise.
    if (
      err &&
      typeof err === 'object' &&
      'response' in err &&
      (err as { response?: { status?: number } }).response?.status === 404
    ) {
      return {
        symbol: sym,
        description: null,
        sector: null,
        industry: null,
        mkt_cap: null,
        outstanding_shares: null,
        shares_updated_at: null,
        pe_ratio: null,
        eps: null,
        revenue: null,
        net_income: null,
        gross_profit: null,
        operating_income: null,
        ebitda: null,
        profit_margin: null,
        free_cash_flow: null,
        week52_high: null,
        week52_low: null,
        fetched_at: null,
      };
    }
    throw err;
  }
}

export interface AssetDescription {
  symbol: string;
  lang: string;
  description: string;
}

export async function fetchAssetDescription(symbol: string, lang: string): Promise<AssetDescription> {
  const response = await api.get(`/asset-description/${encodeURIComponent(symbol)}?lang=${encodeURIComponent(lang)}`);
  return response.data;
}

export interface GeminiAnalysis {
  symbol: string;
  category: string;
  analysis: string;
  search_grounded?: boolean;
}

// Market news (Finnhub-backed; cached server-side).
// `stocks` is aggregated per-ticker /company-news for the symbols this app
// lists; the other four are Finnhub's /news categories.
export type NewsCategory = 'general' | 'stocks' | 'crypto';

export interface NewsItem {
  id: number | null;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string;
  datetime: number;
  related: string;
  category: string;
  /** Map of locale code → translated headline. Backend only populates the
   *  top-N items (typically 7). Missing locale ⇒ fall back to `headline`. */
  translations?: Record<string, string>;
}

export interface MarketNewsResponse {
  category: NewsCategory;
  count: number;
  items: NewsItem[];
  fetched_at: number;
  ttl_seconds: number;
}

export async function fetchMarketNews(
  category: NewsCategory = 'general',
  limit: number = 10,
  options?: { refresh?: boolean; locale?: string },
): Promise<MarketNewsResponse> {
  const params: Record<string, string | number> = { category, limit };
  if (options?.refresh) {
    params.refresh = 1;
  }
  const locale = options?.locale?.trim();
  if (locale) {
    params.locale = locale.split('-')[0].toLowerCase();
  }
  const response = await api.get('/news', {
    params,
  });
  return response.data;
}

export async function fetchGeminiAnalysis(
  symbol: string,
  accessToken: string,
  category?: string,
  lang?: string
): Promise<GeminiAnalysis> {
  const params: Record<string, string> = {};
  if (category) params.category = category;
  if (lang && lang !== 'en') params.lang = lang;
  const response = await api.get(
    `/gemini/analysis/${encodeURIComponent(symbol)}`,
    { params, ...withAuth(accessToken) }
  );
  return response.data;
}

// --------------------------------------------------------------------------- //
// Authenticated API calls (require Privy access token)
// --------------------------------------------------------------------------- //

/**
 * Creates an authenticated API request config with Privy access token.
 */
export function withAuth(accessToken: string) {
  return {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
}

export interface UrTestWalletInfo {
  enabled: boolean;
  address: string | null;
  ur_env?: string;
}

export interface ImportUrTestWalletResponse {
  privy_user_id: string;
  address: string;
  already_imported?: boolean;
  wallet_id?: string;
}

/** Dev-only: check if backend will import UR_API_SIGNER_PRIVKEY_* for this user. */
export async function fetchUrTestWalletInfo(
  accessToken: string,
): Promise<UrTestWalletInfo> {
  const response = await api.get<UrTestWalletInfo>('/dev/ur-test-wallet', withAuth(accessToken));
  return response.data;
}

/** Dev-only: import UR test signer wallet into the authenticated Privy user. */
export async function importUrTestWalletApi(
  accessToken: string,
): Promise<ImportUrTestWalletResponse> {
  const response = await api.post<ImportUrTestWalletResponse>(
    '/dev/import-ur-test-wallet',
    {},
    withAuth(accessToken),
  );
  return response.data;
}

export interface Bridge2DepositRequest {
  user: string;
  usd: string;
  deadline: number;
  signature: string;
}

export interface WalletTransferRequest {
  user: string;
  destination: string;
  usd: string;
  deadline: number;
  signature: string;
  intent_signature: string;
  signed_nonce?: number;  // nonce used when signing (for server-side validation)
}

export interface PermitTxResponse {
  ok: boolean;
  txHash: string;
}

/**
 * Submit a gasless Bridge2 deposit with permit signature.
 * Requires Privy access token for authentication.
 */
export async function depositWithPermit(
  req: Bridge2DepositRequest,
  accessToken: string
): Promise<PermitTxResponse> {
  const response = await api.post('/bridge2/deposit-with-permit', req, withAuth(accessToken));
  return response.data;
}

/**
 * Submit a gasless wallet transfer with permit signature.
 * Requires Privy access token for authentication.
 */
export async function transferWithPermit(
  req: WalletTransferRequest,
  accessToken: string
): Promise<PermitTxResponse> {
  const response = await api.post('/wallet/transfer-with-permit', req, withAuth(accessToken));
  return response.data;
}

// --------------------------------------------------------------------------- //
// Rewards & Referral API
// --------------------------------------------------------------------------- //

export interface TierInfo {
  name: string;
  min_points: number;
  fee_discount_tenths: number;
}

export interface VolumeMilestone {
  threshold: number;
  points: number;
  label: string;
}

export interface AchievementDef {
  id: string;
  points: number;
  title: string;
  desc: string;
  category?: 'trading' | 'cash';
}

export interface RewardsProfile {
  wallet_address: string;
  referral_code: string;
  total_points: number;
  tier: string;
  fee_discount_tenths: number;
  lifetime_volume_usd: number;
  lifetime_cash_volume_usd: number;
  referral_count: number;
  achievements: string[];
  next_tier: string | null;
  points_to_next_tier: number;
  next_volume_milestone: VolumeMilestone | null;
  volume_progress_pct: number;
  next_cash_volume_milestone: VolumeMilestone | null;
  cash_volume_progress_pct: number;
  tier_list: TierInfo[];
}

export interface ReferralEntry {
  referee: string;
  status: string;
  created_at: string;
  qualified_at: string | null;
}

export async function fetchRewardsProfile(
  walletAddress: string,
  accessToken: string,
): Promise<RewardsProfile> {
  const res = await api.get('/rewards/profile', {
    params: { wallet_address: walletAddress },
    ...withAuth(accessToken),
  });
  return res.data;
}

export async function applyReferralCode(
  walletAddress: string,
  referralCode: string,
  accessToken: string,
): Promise<{ success: boolean; referrer?: string; error?: string }> {
  const res = await api.post(
    '/rewards/apply-referral',
    { wallet_address: walletAddress, referral_code: referralCode },
    withAuth(accessToken),
  );
  return res.data;
}

export async function fetchReferrals(
  walletAddress: string,
  accessToken: string,
): Promise<{ referrals: ReferralEntry[] }> {
  const res = await api.get('/rewards/referrals', {
    params: { wallet_address: walletAddress },
    ...withAuth(accessToken),
  });
  return res.data;
}

export async function fetchPointHistory(
  walletAddress: string,
  accessToken: string,
  limit: number = 50,
): Promise<{ history: Array<{ points: number; reason: string; metadata: any; created_at: string }> }> {
  const res = await api.get('/rewards/history', {
    params: { wallet_address: walletAddress, limit },
    ...withAuth(accessToken),
  });
  return res.data;
}

export async function fetchRewardsAchievements(): Promise<{
  achievements: Record<string, AchievementDef>;
  volume_milestones: VolumeMilestone[];
  cash_volume_milestones: VolumeMilestone[];
  tiers: TierInfo[];
}> {
  const res = await api.get('/rewards/achievements');
  return res.data;
}

export async function reportTrade(
  walletAddress: string,
  accessToken: string,
): Promise<{ volume_updated: number; new_achievements: string[]; points_earned: number }> {
  const res = await api.post(
    '/rewards/report-trade',
    { wallet_address: walletAddress },
    withAuth(accessToken),
  );
  return res.data;
}

// TODO(prod): DEV-ONLY. Calls the backend cash-rewards simulator, which itself
// only works while ENABLE_UR_TEST_WALLET_IMPORT=1. UI caller is gated behind
// __DEV__ so it never ships in a production build.
export async function simulateCashReward(
  kind: 'kyc' | 'deposit' | 'card_spend',
  amountUsd: number,
  accessToken: string,
): Promise<any> {
  const res = await api.post(
    '/rewards/dev/simulate-cash',
    { kind, amount_usd: amountUsd },
    withAuth(accessToken),
  );
  return res.data;
}

export async function fetchLeaderboard(
  accessToken: string,
  limit: number = 20,
): Promise<{ leaderboard: Array<{ rank: number; wallet: string; points: number; tier: string; referrals: number; volume: number }> }> {
  const res = await api.get('/rewards/leaderboard', {
    params: { limit },
    ...withAuth(accessToken),
  });
  return res.data;
}

// Forex display-currency rates
export interface ForexRatesResponse {
  base: string;
  rates: Record<string, number>;
  updated_at: string;
}

export async function fetchForexRates(): Promise<ForexRatesResponse> {
  const res = await api.get('/forex/rates');
  return res.data;
}

// Geo-fence check
export async function checkGeo(): Promise<{ allowed: boolean; country: string | null }> {
  const res = await api.get('/geo-check');
  return res.data;
}

// ── AI trading agents (docs/AI_AGENTS.md) ────────────────────────────────────

export interface AiAgentModelChoice {
  provider: 'openai' | 'xai' | 'gemini' | 'deepseek' | 'claude';
  model: string;
}

export interface AiAgentConfig {
  symbols: string[];
  models: {
    opening: AiAgentModelChoice;
    monitor_win?: AiAgentModelChoice;
    monitor_loss?: AiAgentModelChoice;
  };
  /** Max total notional cap (shared and dedicated). Sub funding is a separate transfer. */
  max_capital_usd: number;
  /** Optional per-position notional clamp on top of the AI's own sizing. */
  max_position_usd?: number;
  leverage_cap: number;
  margin_mode?: 'cross' | 'isolated';
  /** Entry appetite: aggressive = lower conviction gates / more positions, same size & risk limits. */
  risk_profile?: 'standard' | 'aggressive';
  /** Time structure: scalper = hours (default); swing = days (wider stops/targets, calmer monitors). */
  horizon?: 'scalper' | 'swing' | 'investor';
  /** Allowed sides: free form (default) or one-direction mandate. */
  direction?: 'long_short' | 'long_only' | 'short_only';
  /** What success means: active trading (default) or accumulate (long_only only). */
  mandate?: 'active' | 'accumulate';
}

/** Worker-written runtime health — orthogonal to status (never auto-stops). */
export interface AiAgentHealth {
  degraded?: boolean;
  reasons?: Array<'market_data_unavailable' | 'llm_errors' | 'exit_retrying' | string>;
  marketDataBadStreak?: number;
  llmErrorStreak?: number;
  exitFailStreak?: number;
  lastOkAt?: string | null;
  since?: string | null;
  updatedAt?: string;
}

export interface AiAgentView {
  id: string;
  name: string;
  mode: 'copilot' | 'dedicated' | 'resident';
  status: 'draft' | 'active' | 'paused' | 'stopped' | 'revoked';
  dryRun: boolean;
  hlMasterAddress: string;
  hlAgentAddress: string;
  hlAgentName: string;
  hlSubaccountAddress: string | null;
  config: AiAgentConfig;
  tradingEnv: 'mainnet' | 'demo';
  hasCoinglassKey: boolean;
  modelKeyProviders: string[];
  createdAt: string;
  lastRunAt: string | null;
  /** Optional; missing/{} on older rows means healthy. */
  health?: AiAgentHealth | null;
}

export interface AiAgentDecision {
  id: string;
  symbol: string | null;
  type: string;
  decision: unknown;
  reasoning: unknown;
  /** LLM attribution (null for non-LLM rows like skips/reconciliation). */
  provider?: string | null;
  model?: string | null;
  created_at: string;
}

export interface AiAgentRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'error' | 'skipped';
  error: string | null;
  equity_snapshot: number | null;
}

export async function createAiAgent(
  body: {
    name?: string;
    hlMasterAddress: string;
    config: AiAgentConfig;
    coinglassApiKey?: string;
    modelApiKeys?: Record<string, string>;
    tradingEnv?: 'mainnet' | 'demo';
    /** dedicated = trades an HL sub-account (created + funded client-side). */
    mode?: 'copilot' | 'dedicated';
    hlSubaccountAddress?: string;
  },
  accessToken: string,
): Promise<AiAgentView> {
  const res = await api.post('/ai-agents', body, withAuth(accessToken));
  return res.data.agent;
}

export interface AiAgentsList {
  agents: AiAgentView[];
  /** True when the house CoinGlass key serves market data for all agents (no personal key needed). */
  coinglassGlobalMode: boolean;
  /** True when CoinAnk replaces CoinGlass. Personal CoinGlass keys are not used. */
  coinankMode: boolean;
}

export async function listAiAgents(accessToken: string): Promise<AiAgentsList> {
  const res = await api.get('/ai-agents', withAuth(accessToken));
  const agents = ((res.data.agents ?? []) as AiAgentView[]).filter((a) => a.mode !== 'resident');
  return {
    agents,
    coinglassGlobalMode: res.data.coinglassGlobalMode === true,
    coinankMode: res.data.coinankMode === true,
  };
}

export async function renameAiAgent(
  agentId: string,
  name: string,
  accessToken: string,
): Promise<AiAgentView> {
  const res = await api.patch(`/ai-agents/${agentId}`, { name }, withAuth(accessToken));
  return res.data.agent;
}

/** Draft settings + optional rename. Config/market-data key only accepted while status=draft. */
export async function updateAiAgent(
  agentId: string,
  body: {
    name?: string;
    config?: AiAgentConfig;
    coinglassApiKey?: string;
  },
  accessToken: string,
): Promise<AiAgentView> {
  const res = await api.patch(`/ai-agents/${agentId}`, body, withAuth(accessToken));
  return res.data.agent;
}

export async function activateAiAgent(agentId: string, accessToken: string): Promise<AiAgentView> {
  const res = await api.post(`/ai-agents/${agentId}/activate`, {}, withAuth(accessToken));
  return res.data.agent;
}

export async function pauseAiAgent(agentId: string, accessToken: string): Promise<void> {
  await api.post(`/ai-agents/${agentId}/pause`, {}, withAuth(accessToken));
}

export async function stopAiAgent(agentId: string, accessToken: string): Promise<void> {
  await api.post(`/ai-agents/${agentId}/stop`, {}, withAuth(accessToken));
}

export async function revokeAiAgent(
  agentId: string,
  accessToken: string,
): Promise<{ ok: boolean; stillApprovedOnHl: boolean | null }> {
  const res = await api.post(`/ai-agents/${agentId}/revoke`, {}, withAuth(accessToken));
  return res.data;
}

export async function deleteAiAgent(agentId: string, accessToken: string): Promise<void> {
  await api.delete(`/ai-agents/${agentId}`, withAuth(accessToken));
}

/** Shared V1 limits — keep in sync with backend/ai_agents.py where applicable. */
export const AI_AGENT_LIMITS = {
  minCapitalUsd: 100,
  maxCapitalUsd: 10_000_000,
  minPositionUsd: 20,
  /** HL equity required to activate — keep in sync with backend MIN_HL_BALANCE_USD. */
  minHlBalanceUsd: 100,
  maxLeverage: 50,
  /**
   * 1 symbol per agent: decisions are per-symbol with no portfolio-level
   * coordination (budget contention is first-come, correlated exposure is
   * invisible), and direction/mandate are per-agent — so per-asset strategy
   * is the honest unit. Existing multi-symbol agents keep working.
   * TODO(portfolio-brain): raise once a portfolio-level pass exists
   * (conviction budget / correlation awareness across symbols).
   */
  maxSymbols: 1,
  /**
   * Shared (copilot) product slots — separate from Dedicated.
   * HL typically allows ~3 named agents total; the device `HyperTrade` agent
   * uses one, leaving this many Shared AI agents. Drafts do not count (named
   * agent is approved at activate). Stop keeps the slot; revoke frees it.
   */
  maxAgentSlots: 2,
  /**
   * Dedicated product slots — separate from Shared. Matches HL's base
   * sub-account limit (10) once volume unlocks Dedicated. Drafts count because
   * Create already books an HL sub-account. Stop keeps the slot; revoke frees
   * the product slot (the HL sub itself cannot be deleted).
   */
  maxAgentSlotsDedicated: 10,
} as const;

/**
 * Wizard “max per position” only matters with multi-symbol agents (otherwise
 * it duplicates the total notional ceiling). Flip with maxSymbols.
 */
export const AI_AGENT_SHOW_PER_POSITION_CAP = AI_AGENT_LIMITS.maxSymbols > 1;

export async function setAiAgentDryRun(
  agentId: string,
  dryRun: boolean,
  accessToken: string,
): Promise<void> {
  await api.post(`/ai-agents/${agentId}/dry-run`, { dryRun }, withAuth(accessToken));
}

export async function fetchAiAgentDecisions(
  agentId: string,
  accessToken: string,
  limit = 50,
): Promise<AiAgentDecision[]> {
  const res = await api.get(`/ai-agents/${agentId}/decisions?limit=${limit}`, withAuth(accessToken));
  return res.data.decisions;
}

/** One OPEN agent-tracked position (bot badge + Reasoning wiring). */
export interface AiAgentPosition {
  agentId: string;
  agentName: string;
  agentMode: 'copilot' | 'dedicated';
  tradingEnv: 'mainnet' | 'demo';
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  sizeUsd: number;
  leverage: number;
  conviction: number | null;
  openedAt: string;
}

export async function fetchAiAgentPositions(accessToken: string): Promise<AiAgentPosition[]> {
  const res = await api.get('/ai-agents/positions', withAuth(accessToken));
  return res.data.positions;
}

export async function fetchAiAgentDecisionsPage(
  args: {
    agentId: string;
    symbol?: string;
    kind?: 'opening' | 'monitor';
    /** ISO timestamp — only decisions at/after this (current position openedAt). */
    since?: string;
    offset?: number;
    limit?: number;
  },
  accessToken: string,
): Promise<{ decisions: AiAgentDecision[]; hasMore: boolean; offset: number }> {
  const params = new URLSearchParams();
  params.set('limit', String(args.limit ?? 10));
  params.set('offset', String(args.offset ?? 0));
  if (args.symbol) params.set('symbol', args.symbol);
  if (args.kind) params.set('kind', args.kind);
  if (args.since) params.set('since', args.since);
  const res = await api.get(
    `/ai-agents/${args.agentId}/decisions?${params.toString()}`,
    withAuth(accessToken),
  );
  return res.data;
}

export async function fetchAiAgentRuns(
  agentId: string,
  accessToken: string,
  limit = 100,
): Promise<AiAgentRun[]> {
  const res = await api.get(`/ai-agents/${agentId}/runs?limit=${limit}`, withAuth(accessToken));
  return res.data.runs;
}

export interface AiAgentStats {
  openPositions: number;
  realizedPnlUsd: number;
  volumeUsd: number;
  /** Closed rows with known outcome; null when none yet. */
  winRatePct?: number | null;
  closedPositions?: number;
  winningCloses?: number;
  /** Total decision rows (incl. flat / skipped) — proves cycles ran. */
  decisionCount?: number;
}

export async function fetchAiAgentStats(
  accessToken: string,
): Promise<Record<string, AiAgentStats>> {
  const res = await api.get('/ai-agents/stats', withAuth(accessToken));
  return res.data.stats ?? {};
}
