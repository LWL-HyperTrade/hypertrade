/**
 * BuilderPad Residents — types + pure helpers (docs/RESIDENTS.md).
 *
 * The AI-agent half is a straight port of the pure-TS parts of
 * `frontend/src/lib/api.ts` (AI section) and the client validation in
 * `frontend/app/ai-agents.tsx`. Trading rules are the backend's
 * (`backend/ai_agents.py`); these mirrors exist so the form can fail fast.
 * Keep in sync when the mobile app changes them.
 */

import { isAiAgentMarketAllowed } from './aiAgentHip3Exclude';

// ── AI agents (ported) ───────────────────────────────────────────────────────

export type AiAgentProvider = 'openai' | 'xai' | 'gemini' | 'deepseek' | 'claude';

export interface AiAgentModelChoice {
  provider: AiAgentProvider;
  model: string;
}

export type AiAgentMode = 'copilot' | 'dedicated' | 'resident';
export type AiAgentStatus = 'draft' | 'active' | 'paused' | 'stopped' | 'revoked';
export type AiAgentHorizon = 'scalper' | 'swing' | 'investor';
export type AiAgentDirection = 'long_short' | 'long_only' | 'short_only';
export type AiAgentMandate = 'active' | 'accumulate';

export interface AiAgentConfig {
  symbols: string[];
  models: {
    opening: AiAgentModelChoice;
    monitor_win?: AiAgentModelChoice;
    monitor_loss?: AiAgentModelChoice;
  };
  /** Notional ceiling across the agent's positions. */
  max_capital_usd: number;
  max_position_usd?: number;
  leverage_cap: number;
  margin_mode?: 'cross' | 'isolated';
  risk_profile?: 'standard' | 'aggressive';
  horizon?: AiAgentHorizon;
  direction?: AiAgentDirection;
  mandate?: AiAgentMandate;
}

export interface AiAgentHealth {
  degraded?: boolean;
  reasons?: string[];
  lastOkAt?: string | null;
  since?: string | null;
}

export interface AiAgentView {
  id: string;
  name: string;
  mode: AiAgentMode;
  status: AiAgentStatus;
  dryRun: boolean;
  hlMasterAddress: string;
  /** App this resident agent is bound to. Absent until it is attached to a project. */
  residentSlug?: string | null;
  hlAgentAddress: string;
  hlAgentName: string;
  hlSubaccountAddress: string | null;
  config: AiAgentConfig;
  tradingEnv: 'mainnet' | 'demo';
  hasCoinglassKey: boolean;
  modelKeyProviders: string[];
  createdAt: string;
  lastRunAt: string | null;
  health?: AiAgentHealth | null;
  /** True when this id is in the backend `SHOWCASE_AGENT_IDS` allowlist. */
  showcase?: boolean;
}

export interface AiAgentDecision {
  id: string;
  symbol: string | null;
  type: string;
  decision: unknown;
  reasoning: unknown;
  provider?: string | null;
  model?: string | null;
  created_at: string;
}

/** Mirror of `AI_AGENT_LIMITS` in frontend/src/lib/api.ts + backend/ai_agents.py. */
export const AI_AGENT_LIMITS = {
  minCapitalUsd: 100,
  maxCapitalUsd: 10_000_000,
  minPositionUsd: 20,
  /** HL equity the resident wallet must hold to activate / stay live. */
  minHlBalanceUsd: 100,
  maxLeverage: 50,
  maxSymbols: 1,
  /** One resident agent per login. HD 2 is one balance, so a second app cannot have its own. */
  maxAgentSlotsResident: 1,
  maxNameLen: 64,
} as const;

/** V1 model catalog — same choices as the mobile picker; house keys on the worker. */
export const AI_MODEL_OPTIONS: Array<{
  label: string;
  choice: AiAgentModelChoice;
  unavailable?: boolean;
}> = [
  { label: 'GPT', choice: { provider: 'openai', model: 'gpt-5.6-terra' } },
  { label: 'Gemini', choice: { provider: 'gemini', model: 'gemini-3.7-flash' } },
  { label: 'Grok', choice: { provider: 'xai', model: 'grok-4.5' } },
  { label: 'DeepSeek', choice: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
  { label: 'Claude', choice: { provider: 'claude', model: 'claude-opus-5' }, unavailable: true },
];

export function defaultModelChoice(): AiAgentModelChoice {
  return (AI_MODEL_OPTIONS.find((m) => !m.unavailable) ?? AI_MODEL_OPTIONS[0]).choice;
}

/** Same cutoffs as `frontend/app/ai-agents.tsx`. */
export const SWING_LEVERAGE_WARN_ABOVE = 10;
export const INVESTOR_LEVERAGE_WARN_ABOVE = 3;
export const ACCUMULATE_LEVERAGE_WARN_ABOVE = 3;

export const HORIZON_OPTIONS: Array<{ value: AiAgentHorizon; label: string; hint: string }> = [
  {
    value: 'scalper',
    label: 'Scalper',
    hint: 'Hours-scale trading. Looks for entries every hour, uses tighter stops and quicker profit-taking, reacts fast to order flow.',
  },
  {
    value: 'swing',
    label: 'Swing',
    hint: 'Days-scale trend trading. Looks for entries every hour, uses wider stops and larger targets, holds through intraday noise. Works best with lower leverage.',
  },
  {
    value: 'investor',
    label: 'Investor',
    hint: 'Weeks+ holds. Looks for entries every hour (to catch options/macro shifts), but re-manages open positions about every ~4 hours unless risk fires — wider stops, larger targets, longer-term EMAs/macro. Best with low leverage (≤3x).',
  },
];

export const DIRECTION_OPTIONS: Array<{ value: AiAgentDirection; label: string; hint: string }> = [
  {
    value: 'long_short',
    label: 'Free form',
    hint: 'The AI decides direction freely — long, short, or flat based on its own read. This is the default behavior.',
  },
  {
    value: 'long_only',
    label: 'Long only',
    hint: 'A one-sided campaign: the AI only trades the long side of this asset. A bearish read means staying flat, never shorting. Pick a goal below to define what success looks like.',
  },
  {
    value: 'short_only',
    label: 'Short only',
    hint: 'A one-sided campaign: the AI only trades the short side. A bullish read means staying flat, never longing. Pick a goal below to define what success looks like.',
  },
];

export const MANDATE_OPTIONS: Array<{ value: AiAgentMandate; label: string; hint: string; shortHint: string }> = [
  {
    value: 'active',
    label: 'Active trading',
    hint: 'Trade one side for realized profit.\n• Opens only when it sees a setup with edge — stays flat on hostile tape, never robotically re-enters after a stop\n• Places both a stop-loss and a take-profit on every position\n• Manages open trades: adds to winners, trims into strength, moves stops to breakeven, cuts broken theses\n• Success = realized P&L per trade',
    shortHint: 'Trade one side for realized profit.\n• Opens only when it sees a setup with edge — stays flat on hostile tape, never robotically re-enters after a stop\n• Places both a stop-loss and a take-profit on every position\n• Manages open trades: adds to winners, trims into strength, moves stops to breakeven, cuts broken theses\n• Success = realized P&L per trade',
  },
  {
    value: 'accumulate',
    label: 'Accumulate',
    hint: 'Build long exposure patiently.\n• Buys only weakness: flushes, panics, oversold dips — never chases strength, and may stay flat if direction edge is not clear\n• Places a stop-loss but NO automatic take-profit — winners are never auto-clipped; you decide when the campaign ends\n• Adds (DCA) on further dips while the thesis holds; trims only at euphoric extremes or if the thesis decays\n• Success = better average entry',
    shortHint: 'Build short exposure patiently.\n• Shorts only strength: euphoric rallies, overbought spikes into resistance — never chases breakdowns, and may stay flat if direction edge is not clear\n• Places a stop-loss but NO automatic take-profit — the position is never auto-covered; you decide when the campaign ends\n• Adds on further strength while the thesis holds; covers partially only at capitulation extremes or if the thesis decays\n• Success = better average short entry',
  },
];

export const CAPITAL_CAP_INFO =
  "Ceiling on the agent's max open notional — not a target it always fills. It sizes each trade by conviction and risk, and may use far less than this max.";

export const MARGIN_MODE_INFO =
  'If the selected asset only supports isolated margin, the agent routes to isolated automatically.';

export interface ResidentAgentForm {
  name: string;
  symbol: string;
  model: AiAgentModelChoice;
  horizon: AiAgentHorizon;
  direction: AiAgentDirection;
  mandate: AiAgentMandate;
  marginMode: 'cross' | 'isolated';
  leverageCap: number;
  maxCapitalUsd: number;
}

export const EMPTY_AGENT_FORM: ResidentAgentForm = {
  name: '',
  symbol: '',
  model: defaultModelChoice(),
  horizon: 'scalper',
  direction: 'long_short',
  mandate: 'active',
  marginMode: 'cross',
  leverageCap: 3,
  maxCapitalUsd: 100,
};

/** Client-side mirror of the checks in `ai-agents.tsx` (~1052–1161). */
export function agentFormError(
  f: ResidentAgentForm,
  opts: { assetMaxLeverage?: number | null; takenSymbols?: string[] } = {},
): string | null {
  const name = f.name.trim();
  if (!name) return 'Give the resident a name';
  if (name.length > AI_AGENT_LIMITS.maxNameLen) return `Name must be at most ${AI_AGENT_LIMITS.maxNameLen} characters`;
  const symbol = f.symbol.trim().toUpperCase();
  if (!symbol) return 'Pick one market';
  if (!isAiAgentMarketAllowed(symbol)) {
    return `${symbol} is not available for AI residents`;
  }
  if ((opts.takenSymbols ?? []).some((s) => s.toUpperCase() === symbol)) {
    return `${symbol} is already on another resident agent — one agent per market on the same wallet`;
  }
  if (!Number.isFinite(f.maxCapitalUsd) || f.maxCapitalUsd < AI_AGENT_LIMITS.minCapitalUsd) {
    return `Notional must be at least $${AI_AGENT_LIMITS.minCapitalUsd}`;
  }
  if (f.maxCapitalUsd > AI_AGENT_LIMITS.maxCapitalUsd) return 'Budget is too large';
  const lev = Math.floor(f.leverageCap);
  if (!Number.isFinite(lev) || lev < 1) return 'Leverage must be at least 1x';
  if (lev > AI_AGENT_LIMITS.maxLeverage) return `Leverage is capped at ${AI_AGENT_LIMITS.maxLeverage}x`;
  if (opts.assetMaxLeverage && lev > opts.assetMaxLeverage) {
    return `${symbol} allows at most ${opts.assetMaxLeverage}x`;
  }
  if (f.mandate === 'accumulate' && f.direction === 'long_short') {
    return 'Accumulate needs a direction (long only or short only)';
  }
  return null;
}

export function agentConfigFromForm(f: ResidentAgentForm): AiAgentConfig {
  return {
    symbols: [f.symbol.trim().toUpperCase()],
    models: { opening: f.model },
    max_capital_usd: Math.floor(f.maxCapitalUsd),
    leverage_cap: Math.max(1, Math.floor(f.leverageCap)),
    margin_mode: f.marginMode,
    horizon: f.horizon,
    direction: f.direction,
    mandate: f.direction === 'long_short' ? 'active' : f.mandate,
  };
}

// ── Cloid (port of frontend/src/lib/aiAgentCloid.ts, Web Crypto) ────────────

export const HTAI_CLOID_TAG = '0x48544149';

export function isAiAgentCloid(cloid: unknown): boolean {
  return String(cloid ?? '').toLowerCase().startsWith(HTAI_CLOID_TAG);
}

export async function aiAgentCloidPrefix(agentId: string): Promise<string> {
  const bytes = new TextEncoder().encode(agentId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${HTAI_CLOID_TAG}${hex.slice(0, 8)}`;
}

// ── Resident character ──────────────────────────────────────────────────────

export type ResidentMood = 'idle' | 'focused' | 'tense' | 'smug' | 'shrug' | 'sleep';
export const RESIDENT_MOODS: ResidentMood[] = ['idle', 'focused', 'tense', 'smug', 'shrug', 'sleep'];

export type ResidentVoiceChannel = 'trade' | 'craft' | 'macro' | 'vibe' | 'fun' | 'letter' | 'cast';

export interface ResidentPersona {
  display_name?: string;
  tone?: string[];
  catchphrases?: string[];
  show_hour_utc?: number;
  bio_voice?: string;
}

export type ResidentAvatar =
  | { kind: 'preset'; preset_id: string; poster_url?: string }
  | { kind: 'vrm'; vrm_url: string; poster_url?: string };

/** Bundled presets in `web/public/resident/presets/{id}/`.
 *  `shipped` is what the character picker offers. Model defaults to `{id}.vrm`
 *  and the poster to `poster.webp` unless a file name is set. */
export const AVATAR_PRESETS: Array<{
  id: string;
  label: string;
  shipped?: boolean;
  model?: string;
  poster?: string;
  /** Waiting-clip pool. Unset presets use the full list. */
  gender?: 'female' | 'male' | 'neutral';
}> = [
  { id: 'yuna', label: 'Yuna', shipped: true, gender: 'female' },
  { id: 'selene', label: 'Selene', shipped: true, gender: 'female' },
  { id: 'julian', label: 'Julian', shipped: true, poster: 'poster.png', gender: 'male' },
  { id: 'kuri', label: 'Kuri', shipped: true, model: 'kiba.vrm', poster: 'poster.png', gender: 'neutral' },
  { id: 'mika', label: 'Mika', shipped: true, poster: 'poster.png', gender: 'neutral' },
  { id: 'sebastian', label: 'Sebastian', shipped: true, poster: 'poster.png', gender: 'male' },
  { id: 'atlas', label: 'Atlas' },
  { id: 'nova', label: 'Nova' },
  { id: 'sol', label: 'Sol' },
];

export const SHIPPED_AVATAR_PRESETS = AVATAR_PRESETS.filter((p) => p.shipped);

/** Old folder/id. Resolve before building asset URLs. */
const PRESET_ALIASES: Record<string, string> = { luna: 'yuna' };

/** Profit (smug) dance clip. Idle uses `IDLE_ANIMS` instead. */
export const FALLBACK_ANIM = 'dance.vrma';
const PRESET_FALLBACK_ANIM: Record<string, string> = {
  yuna: 'dance.vrma',
  selene: 'dance-2.vrma',
};

/** Shared waiting clips — the stage rotates these until the book is green.
 *  Males use spin instead of idle, and skip modelpose. */
export const IDLE_ANIMS = ['idle.vrma', 'modelpose.vrma', 'spin.vrma', 'vsign.vrma', 'gunshoot.vrma'] as const;
const MALE_IDLE_SKIP = new Set<string>(['idle.vrma', 'modelpose.vrma']);

export function canonicalPresetId(presetId: string): string {
  const id = presetId.trim().toLowerCase();
  return PRESET_ALIASES[id] ?? id;
}

export function presetFallbackAnim(presetId?: string | null): string {
  if (!presetId) return FALLBACK_ANIM;
  return PRESET_FALLBACK_ANIM[canonicalPresetId(presetId)] ?? FALLBACK_ANIM;
}

export function avatarFallbackAnim(avatar: ResidentAvatar | null | undefined): string {
  if (avatar && 'kind' in avatar && avatar.kind === 'preset') return presetFallbackAnim(avatar.preset_id);
  return FALLBACK_ANIM;
}

/** Waiting clips for this look. Females and neutrals get the full pool. */
export function idleAnimsForPreset(presetId?: string | null): readonly string[] {
  const id = canonicalPresetId(presetId || '');
  const gender = AVATAR_PRESETS.find((p) => p.id === id)?.gender;
  if (gender === 'male') return IDLE_ANIMS.filter((file) => !MALE_IDLE_SKIP.has(file));
  return IDLE_ANIMS;
}

export function avatarIdleAnims(avatar: ResidentAvatar | null | undefined): readonly string[] {
  if (avatar && 'kind' in avatar && avatar.kind === 'preset') return idleAnimsForPreset(avatar.preset_id);
  return IDLE_ANIMS;
}

function presetFiles(presetId: string): { id: string; model: string; poster: string } {
  const id = canonicalPresetId(presetId);
  const row = AVATAR_PRESETS.find((p) => p.id === id);
  return {
    id,
    model: row?.model ?? `${id}.vrm`,
    poster: row?.poster ?? 'poster.webp',
  };
}

export function presetModelUrl(presetId: string): string {
  const files = presetFiles(presetId);
  return `/resident/presets/${encodeURIComponent(files.id)}/${encodeURIComponent(files.model)}`;
}

export function presetPosterUrl(presetId: string): string {
  const files = presetFiles(presetId);
  return `/resident/presets/${encodeURIComponent(files.id)}/${encodeURIComponent(files.poster)}`;
}

export function avatarModelUrl(avatar: ResidentAvatar | null | undefined): string | null {
  if (!avatar || !('kind' in avatar) || avatar.kind !== 'preset') return null;
  return avatar.preset_id ? presetModelUrl(avatar.preset_id) : null;
}

export function avatarPosterUrl(avatar: ResidentAvatar | null | undefined): string | null {
  if (!avatar || !('kind' in avatar)) return null;
  if (avatar.kind === 'preset' && avatar.preset_id) return presetPosterUrl(avatar.preset_id);
  if (avatar.poster_url) return avatar.poster_url;
  return null;
}

/** `tenant.resident` on public reads. Null = human app. */
export interface TenantResidentSummary {
  agents: number;
  persona: ResidentPersona;
  avatar: ResidentAvatar | Record<string, never>;
}

export interface ResidentVoiceLine {
  id: string;
  agent_id: string;
  channel: ResidentVoiceChannel;
  mood: ResidentMood;
  text: string;
  refs: Record<string, unknown>;
  created_at: string;
}

/** One agent slice of GET /api/tenants/{slug}/resident (same as /api/showcase/agents). */
export interface ResidentAgentSlice {
  id: string;
  name: string;
  status: string;
  symbols: string[];
  horizon?: string;
  model?: string;
  live?: boolean;
  /** Public resident wallet (HD 2). The book is this address. */
  wallet?: string | null;
  accountValue?: number | null;
  withdrawable?: number | null;
  pnlUsd?: number;
  pnlFrom1k?: number;
  equity?: Array<{ t: number; indexed: number }>;
  positions?: Array<{ unrealizedPnl?: number; [k: string]: unknown }>;
  decisions?: ResidentDecision[];
  opening?: ResidentOpening | null;
  [k: string]: unknown;
}

export interface ResidentDecision {
  id?: string;
  at?: string;
  symbol?: string;
  type?: string;
  headline?: string;
  body?: string;
  reasoning?: string | null;
  tone?: string;
  conviction?: number | null;
  direction?: string | null;
  /** ROE % at the check (price move × leverage). Openings leave this null. */
  pnlPct?: number | null;
}

export interface ResidentOpening {
  at?: string;
  symbol?: string;
  side?: string;
  conviction?: number | null;
  summary?: string;
  reasoning?: string;
  entryPrice?: number | null;
  stopPrice?: number | null;
  takeProfit?: number | null;
  sizeUsd?: number | null;
  leverage?: number | null;
}

export interface TenantResidentPayload {
  slug: string;
  app_name: string;
  persona: ResidentPersona;
  avatar: ResidentAvatar | Record<string, never>;
  mood: ResidentMood;
  agents: ResidentAgentSlice[];
  voice: ResidentVoiceLine[];
  generatedAt?: number;
}

export function residentDisplayName(
  persona: ResidentPersona | undefined,
  fallback: string,
): string {
  return (persona?.display_name || '').trim() || fallback;
}

/** Visitor-facing name. The live agent's name wins over an older character label. */
export function residentPublicName(
  agents: Array<{ name?: string; status?: string }> | undefined,
  persona: ResidentPersona | undefined,
  fallback: string,
): string {
  const rows = agents ?? [];
  const live = rows.find((a) => a.status === 'active' && (a.name || '').trim());
  const any = rows.find((a) => a.status !== 'revoked' && (a.name || '').trim());
  return (live?.name || any?.name || '').trim() || residentDisplayName(persona, fallback);
}

/** Next top-of-hour — the worker cycle boundary (same as showcase/hourlyCycle.ts). */
export function msUntilNextHourlyCycle(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return Math.max(0, d.getTime() - nowMs);
}

export function formatCycleCountdown(msLeft: number): string {
  const totalSec = Math.floor(msLeft / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const RESIDENT_MOOD_LABEL: Record<ResidentMood, string> = {
  idle: 'Sidelined',
  focused: 'Holding',
  tense: 'Managing risk',
  smug: 'In profit',
  shrug: 'Sitting out',
  sleep: 'Resting',
};

const ASLEEP_STATUS = new Set(['paused', 'stopped', 'draft', 'revoked']);

export function residentAgentPnl(a: ResidentAgentSlice): number {
  let u = 0;
  let hasU = false;
  for (const p of a.positions ?? []) {
    const n = Number(p?.unrealizedPnl);
    if (Number.isFinite(n)) {
      u += n;
      hasU = true;
    }
  }
  if (hasU) return u;
  const v = Number(a.pnlUsd ?? a.pnlFrom1k);
  return Number.isFinite(v) ? v : 0;
}

/** Signed P&L for the resident card. Cents under $100 so a $0.04 move is visible.
 *  A value that rounds to zero is unsigned — never "−$0". */
export function formatResidentPnl(n: number): { text: string; tone: 'up' | 'down' | 'flat' } {
  const digits = Math.abs(n) < 100 ? 2 : 0;
  const rounded = Number(n.toFixed(digits));
  const body = Math.abs(rounded).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (rounded === 0) return { text: `$${body}`, tone: 'flat' };
  if (rounded > 0) return { text: `+$${body}`, tone: 'up' };
  return { text: `−$${body}`, tone: 'down' };
}

function agentIsLive(a: { status?: string; live?: boolean }): boolean {
  return a.live === true || String(a.status || '').toLowerCase() === 'active';
}

/** Face + badge from the live book. Voice/API mood only fills gaps. */
export function displayResidentMood(
  mood: ResidentMood | undefined,
  agents: ResidentAgentSlice[] | undefined,
): ResidentMood {
  const list = agents ?? [];
  const live = list.some(agentIsLive);
  if (list.length && !live && list.every((a) => ASLEEP_STATUS.has(String(a.status || '').toLowerCase()))) {
    return 'sleep';
  }
  if (live) {
    let open = 0;
    let upnl = 0;
    for (const a of list) {
      const pos = a.positions ?? [];
      open += pos.length;
      for (const p of pos) {
        const n = Number(p?.unrealizedPnl);
        if (Number.isFinite(n)) upnl += n;
      }
    }
    if (open === 0) return 'idle';
    // An open book is a position, not a fresh decision. Sign of uPnL picks
    // the face; exactly flat is Holding.
    if (upnl < 0) return 'tense';
    if (upnl > 0) return 'smug';
    return 'focused';
  }
  return mood && mood !== 'sleep' ? mood : 'idle';
}
