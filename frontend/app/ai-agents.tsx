/**
 * AI Trading Agents — foundational screen (V1).
 *
 * Deliberately utilitarian: list + create + approval ceremony + controls.
 * Final UX/branding (wizard, mode explainers, equity charts) comes later —
 * this proves the full flow: create draft → approveAgent signature (silent
 * for embedded users, wallet prompt for external) → verified activation →
 * dry-run monitoring → decisions feed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Image,
  InteractionManager,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useRouter, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueries, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../src/theme/colors';
import { useDisplayCurrency } from '../src/providers/CurrencyProvider';
import { useAuth } from '../src/providers/AuthContext';
import { useAppStore } from '../src/store/appStore';
import { useActiveEthereumWallet } from '../src/hooks/useActiveEthereumWallet';
import { isHlSigningChainError, isWalletUserRejectedRequest } from '../src/lib/hlWalletChain';
import { ensureExternalWalletOnHlSigningChain } from '../src/lib/externalWalletConnect';
import {
  approveNamedAgent,
  createHlSubAccount,
  ensureSubAccountUnified,
  listHlExtraAgents,
  listHlSubAccounts,
  revokeNamedAgent,
  transferUsdToSubAccount,
  getHyperliquidTradingState,
  getPerpMarginSupport,
  getUserFillsReplay,
  getUserPortfolioSummary,
  type HyperliquidTradingState,
  type UserPortfolioSummary,
} from '../src/lib/hyperliquid';
import { roundTripWinRate } from '../src/lib/hlRoundTripWinRate';
import {
  DedicatedTransferBottomSheet,
  type DedicatedTransferDirection,
} from '../src/components/DedicatedTransferBottomSheet';
import {
  activateAiAgent,
  createAiAgent,
  deleteAiAgent,
  fetchAiAgentDecisionsPage,
  fetchAiAgentPositions,
  fetchAiAgentStats,
  listAiAgents,
  renameAiAgent,
  revokeAiAgent,
  setAiAgentDryRun,
  pauseAiAgent,
  stopAiAgent,
  updateAiAgent,
  fetchCryptoAssets,
  fetchAssets,
  AI_AGENT_LIMITS,
  AI_AGENT_SHOW_PER_POSITION_CAP,
  type AiAgentDecision,
  type AiAgentHealth,
  type AiAgentModelChoice,
  type AiAgentPosition,
  type AiAgentStats,
  type AiAgentView,
} from '../src/lib/api';
import {
  decisionSummary,
  directionColor,
  decisionActionColor,
  toneColor,
  formatDecisionPnlPct,
  CopyableDecisionText,
} from '../src/components/AiReasoningModal';
import { AssetLogo, getAssetImageSource } from '../src/components/AssetLogo';
import { BouncingDots } from '../src/components/BouncingDots';
import { AiAgentsEmptyState } from '../src/components/AiAgentsEmptyState';
import { AiAgentsListSkeleton } from '../src/components/AiAgentsListSkeleton';
import { BankConfirmModal } from '../src/components/bank/BankConfirmModal';
import { showToast } from '../src/lib/toast';
import { pushRouteOnce } from '../src/lib/pushRouteOnce';
import { formatDisplaySymbol as formatAppDisplaySymbol, getDisplayAssetRouteSymbol } from '../src/lib/displaySymbols';
import {
  isRestingLimitDedicatedFundWarnDismissed,
  isRestingLimitSharedWarnDismissed,
  normalizeAiTradeSymbol,
  setRestingLimitDedicatedFundWarnDismissed,
  setRestingLimitSharedWarnDismissed,
} from '../src/lib/aiSharedTradeGuard';

import { formatNextHourlyCycle, useNextCycleCountdown } from '../src/lib/aiAgentHourlyCycle';
import { AI_AGENT_SUPPORTED_HIP3_DEXES, isAiAgentHip3Excluded } from '../src/lib/aiAgentHip3Exclude';

const AGENT_CARD_GRADIENT = ['#1a1a2e', '#16213e', '#0f0f1a'] as const;
const STAT_CARD_GRADIENT = ['#1a1a2e', '#151525', '#0f0f1a'] as const;
const DECISIONS_PAGE_SIZE = 3;

type PendingConfirm =
  | { type: 'create' }
  | { type: 'save' }
  | { type: 'stop' | 'resume' | 'revoke' | 'delete' | 'activate'; agent: AiAgentView }
  /** Free an on-chain agent slot, then retry activate for `agent`. */
  | { type: 'freeSlot'; agent: AiAgentView; freeName: string; freeDbId?: string; freeLabel: string };

/** Prefer oldest stopped/paused agent as a slot to free (never the one activating). */
function pickAgentSlotToFree(
  agents: AiAgentView[],
  activatingId: string,
): AiAgentView | null {
  const candidates = agents
    .filter(
      (a) =>
        a.id !== activatingId &&
        (a.status === 'stopped' || a.status === 'paused') &&
        !!a.hlAgentName,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return candidates[0] ?? null;
}

/** WalletConnect / MetaMask / etc. when the user declines the signature prompt. */
function isWalletSignatureRejected(err: unknown): boolean {
  return isWalletUserRejectedRequest(err);
}

/**
 * Time-box an external-wallet signature and abort when a newer attempt supersedes
 * this one (app resume unlock, new tap). A lost WC response must not hang the UI
 * forever — the underlying provider request can't be cancelled, but the button
 * unlocks so the user can retry (or reject the stale prompt in their wallet).
 */
function raceWalletSignature<T>(
  signature: Promise<T>,
  opts: { timeoutMs: number; isCurrent: () => boolean },
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let pollId: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (timeoutId != null) clearTimeout(timeoutId);
    if (pollId != null) clearInterval(pollId);
  };
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    signature.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
    timeoutId = setTimeout(() => {
      finish(() => reject(new Error('__approve_timeout__')));
    }, opts.timeoutMs);
    pollId = setInterval(() => {
      if (!opts.isCurrent()) {
        finish(() => reject(new Error('__approve_aborted__')));
      }
    }, 300);
  });
}

/**
 * WalletConnect can't cancel an in-flight request. Stacking a second
 * `session_request` while the first is still open orphans the first response
 * (`emitting session_request:… without any listeners`). One lock for approve,
 * dedicated create, and dedicated transfer. UI timeout unlocks the button via
 * `__approve_pending__` on the next tap until the user rejects/completes it.
 */
let externalWalletSignLock: Promise<unknown> | null = null;
const EXTERNAL_WALLET_SIGN_LOCK_MAX_MS = 120_000;

async function withExternalWalletSign<T>(
  start: () => Promise<T>,
  opts: { timeoutMs: number; isCurrent: () => boolean; reusePriorSuccess?: boolean },
): Promise<T | void> {
  if (externalWalletSignLock) {
    try {
      await Promise.race([
        externalWalletSignLock,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('__approve_pending__')), 1_200);
        }),
      ]);
      if (opts.reusePriorSuccess) return;
    } catch (err) {
      if (err instanceof Error && err.message === '__approve_pending__') throw err;
    }
  }

  // No-op for embedded wallets; for WalletConnect sessions this parks MetaMask
  // on Arbitrum so the EIP-712 prompt isn't rejected with a chainId mismatch.
  await ensureExternalWalletOnHlSigningChain();

  const signPromise = start();
  externalWalletSignLock = signPromise;
  const release = () => {
    if (externalWalletSignLock === signPromise) externalWalletSignLock = null;
  };
  const maxWaitId = setTimeout(release, EXTERNAL_WALLET_SIGN_LOCK_MAX_MS);
  void signPromise.finally(() => {
    clearTimeout(maxWaitId);
    release();
  });
  void signPromise.then(
    () => undefined,
    () => undefined,
  );

  await raceWalletSignature(signPromise, opts);
  return signPromise;
}

function isHlNotApprovedYetError(err: unknown): boolean {
  const e = err as { response?: { data?: { detail?: string }; status?: number }; message?: string } | null;
  const detail = `${e?.response?.data?.detail ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return /not approved on hyperliquid|sign the approval and retry/.test(detail);
}

function isActivateMinBalanceError(err: unknown): boolean {
  const e = err as { response?: { data?: { detail?: string } }; message?: string } | null;
  const detail = `${e?.response?.data?.detail ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return /needs at least \$\d+ on hyperliquid to run an agent/.test(detail);
}

/** Backend couldn't verify HL yet (rate limit / info blip) — keep polling, don't re-prompt wallet. */
function isActivateVerifyRetryableError(err: unknown): boolean {
  const e = err as { response?: { data?: { detail?: string }; status?: number }; message?: string } | null;
  const status = e?.response?.status;
  if (status === 503 || status === 429) return true;
  const detail = `${e?.response?.data?.detail ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return (
    /could not verify hyperliquid|hl rate limited|rate limited|try again in a moment/.test(detail) ||
    isTransientNetworkError(err)
  );
}

type ActivateProbe = 'ok' | 'need_approval' | 'retry';

async function approveNamedAgentForActivate(
  args: Parameters<typeof approveNamedAgent>[0],
  opts: { timeoutMs: number; isCurrent: () => boolean },
): Promise<void> {
  await withExternalWalletSign(() => approveNamedAgent(args), {
    ...opts,
    reusePriorSuccess: true,
  });
}

async function isNamedAgentStillApprovedOnHl(args: {
  userAddress: `0x${string}`;
  agentName: string;
  agentAddress: string;
}): Promise<boolean> {
  const extras = await listHlExtraAgents(args.userAddress);
  const addr = args.agentAddress.toLowerCase();
  return extras.some(
    (x) => x.name === args.agentName || x.address.toLowerCase() === addr,
  );
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = `${(err as { message?: string } | null)?.message ?? ''} ${String(err ?? '')}`.toLowerCase();
  return /network request failed|network error|failed to fetch|http request error|econnreset|econnrefused|etimedout|socket hang up|temporarily unavailable/.test(
    msg,
  );
}

/**
 * Returning from an external wallet often blips the network right as HL/API
 * calls fire. Poll a few times before treating revoke as failed.
 * `true` = cleared on HL, `false` = still approved, `null` = checks failed.
 */
async function pollNamedAgentClearedOnHl(args: {
  userAddress: `0x${string}`;
  agentName: string;
  agentAddress: string;
  attempts?: number;
  delayMs?: number;
}): Promise<boolean | null> {
  const attempts = args.attempts ?? 6;
  const delayMs = args.delayMs ?? 1_500;
  let sawOk = false;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const still = await isNamedAgentStillApprovedOnHl(args);
      sawOk = true;
      if (!still) return true;
    } catch {
      // keep trying through resume network blips
    }
  }
  return sawOk ? false : null;
}

/** HL volume-gated named-agent cap (often 3) — Stop does not free a slot; Revoke does. */
function isHlExtraAgentLimitError(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { detail?: string } } } | null;
  const msg = `${e?.response?.data?.detail ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return /too many extra agents|extra agents for cumulative volume/.test(msg);
}

/**
 * V1 model catalog. House API keys (worker env) cover usage.
 * TODO(BYOK): optional per-user model keys later.
 */
const MODEL_OPTIONS: {
  labelKey: string;
  logo: ImageSourcePropType;
  /** Dark logo for gold/active pill (white logos wash out on gold). */
  logoActive?: ImageSourcePropType;
  choice: AiAgentModelChoice;
  /** Temporarily blocked in the picker (entry kept for logos / existing agents). */
  unavailable?: boolean;
}[] = [
  {
    labelKey: 'aiAgents.models.gpt',
    logo: require('../assets/images/chatgpt.webp'),
    logoActive: require('../assets/images/chatgpt-black.webp'),
    choice: { provider: 'openai', model: 'gpt-5.6-terra' },
  },
  {
    labelKey: 'aiAgents.models.gemini',
    logo: require('../assets/images/gemini.webp'),
    choice: { provider: 'gemini', model: 'gemini-3.7-flash' },
  },
  {
    labelKey: 'aiAgents.models.grok',
    logo: require('../assets/images/xai.webp'),
    logoActive: require('../assets/images/xai-black.webp'),
    choice: { provider: 'xai', model: 'grok-4.5' },
  },
  {
    labelKey: 'aiAgents.models.deepseek',
    logo: require('../assets/images/deepseek.webp'),
    choice: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  },
  {
    labelKey: 'aiAgents.models.claude',
    logo: require('../assets/images/claude.webp'),
    choice: { provider: 'claude', model: 'claude-opus-5' },
    // Temporary Anthropic account restriction — keep entry, block new picks.
    unavailable: true,
  },
];

function firstAvailableModelIdx(): number {
  const idx = MODEL_OPTIONS.findIndex((m) => !m.unavailable);
  return idx >= 0 ? idx : 0;
}
function resolveModelLogo(choice: AiAgentModelChoice): ImageSourcePropType | null {
  const match =
    MODEL_OPTIONS.find((m) => m.choice.provider === choice.provider) ??
    MODEL_OPTIONS.find((m) => m.choice.model === choice.model);
  return match?.logo ?? null;
}

/**
 * Dedicated (HL sub-account) mode. Create + fund via sendAsset spot↔spot after
 * ensureSubAccountUnified (classic subAccountTransfer is disabled under
 * unified masters). Keep in sync with backend AI_AGENT_DEDICATED_ENABLED.
 */
const DEDICATED_MODE_ENABLED = true;
const EMPTY_RESTING_COINS: string[] = [];
const DEDICATED_MIN_VOLUME_USD = 100_000;

/**
 * TEMPORARY (testing-phase data collection): the Risk Profile selector is
 * hidden and every new agent is created 'aggressive' (backend forces it too).
 * Flip to `true` to restore the user choice — all code paths preserved.
 */
const RISK_PROFILE_SELECTOR_ENABLED = false;

/** Swing/investor + high leverage is a self-contradiction (wide stops × high lev = liq before stop). */
const SWING_LEVERAGE_WARN_ABOVE = 10;
const INVESTOR_LEVERAGE_WARN_ABOVE = 3;
/** Accumulate = weeks-long perp campaign: funding drag + liq risk compound with leverage. Warn only, never force. */
const ACCUMULATE_LEVERAGE_WARN_ABOVE = 3;

type DedicatedEligibility =
  | { state: 'checking' }
  | { state: 'eligible' }
  | { state: 'ineligible'; lifetimeVolumeUsd: number }
  | { state: 'unknown' };

/**
 * UI label for a symbol: hide the HIP-3 dex prefix (`xyz:TSLA` → `TSLA`) and
 * apply the app-wide display aliases (`CL` → `OIL`, `XYZ100` → `NDX100`),
 * matching how the homepage / portfolio render tickers. The canonical
 * `dex:COIN` form stays in state / API payloads — display-only.
 */
function displaySymbol(sym: string): string {
  return formatAppDisplaySymbol(sym);
}

function symbolHasRestingLimit(symbol: string, restingCoins: Iterable<string>): boolean {
  const raw = String(symbol || '').toUpperCase();
  const want = normalizeAiTradeSymbol(raw);
  if (!want) return false;
  for (const c of restingCoins) {
    if (c === raw || normalizeAiTradeSymbol(c) === want) return true;
  }
  return false;
}

function resolveLeverageCapForSymbols(
  symbols: string[],
  assets: { coin: string; maxLeverage: number }[],
): {
  /** Hard UI ceiling: highest HL max among selected (capped by product limit). */
  max: number;
  /** Symbol that sets the hard ceiling (highest max), for "allows up to Nx" errors. */
  ceilingSymbol: string | null;
  /** Per-asset HL maxes for soft clamp hints. */
  bySymbol: { symbol: string; maxLeverage: number }[];
} {
  if (!symbols.length) {
    return { max: AI_AGENT_LIMITS.maxLeverage, ceilingSymbol: null, bySymbol: [] };
  }
  const bySymbol: { symbol: string; maxLeverage: number }[] = [];
  let highest = 0;
  let ceilingSymbol: string | null = null;
  for (const sym of symbols) {
    const asset = assets.find((a) => a.coin.toUpperCase() === sym);
    const lev = asset?.maxLeverage;
    if (lev == null || !Number.isFinite(lev) || lev <= 0) continue;
    bySymbol.push({ symbol: sym, maxLeverage: lev });
    if (lev > highest) {
      highest = lev;
      ceilingSymbol = sym;
    }
  }
  const max = Math.min(
    AI_AGENT_LIMITS.maxLeverage,
    highest > 0 ? highest : AI_AGENT_LIMITS.maxLeverage,
  );
  return { max, ceilingSymbol, bySymbol };
}

/** Assets whose HL max is below the user's chosen leverage (will be clamped at open). */
function leverageClampDetails(
  bySymbol: { symbol: string; maxLeverage: number }[],
  chosenLeverage: number,
  limit = 3,
): { parts: string[]; extra: number } {
  if (!(chosenLeverage > 0) || !bySymbol.length) return { parts: [], extra: 0 };
  const clamped = bySymbol
    .filter((a) => a.maxLeverage < chosenLeverage)
    .sort((a, b) => a.maxLeverage - b.maxLeverage || a.symbol.localeCompare(b.symbol));
  const shown = clamped.slice(0, limit);
  return {
    parts: shown.map((a) => `${displaySymbol(a.symbol)} ≤${a.maxLeverage}x`),
    extra: Math.max(0, clamped.length - shown.length),
  };
}

function FieldLabel({
  label,
  required,
  optional,
  onInfo,
}: {
  label: string;
  required?: boolean;
  optional?: string;
  onInfo?: () => void;
}) {
  return (
    <View style={styles.fieldLabelRow}>
      <Text style={styles.fieldLabel}>
        {label}
        {required ? <Text style={styles.requiredMark}> *</Text> : null}
        {optional ? <Text style={styles.optionalMark}> ({optional})</Text> : null}
      </Text>
      {onInfo ? (
        <TouchableOpacity
          onPress={onInfo}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Info"
          style={styles.fieldInfoBtn}
        >
          <Ionicons name="information-circle-outline" size={18} color={colors.text.tertiary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function AiAgentsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { isAuthenticated, isReady: authReady, getAccessToken } = useAuth();
  const { wallet, address, isReady, isExternal } = useActiveEthereumWallet();
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const isDemo = tradingEnv === 'demo';
  const queryClient = useQueryClient();
  const onCycleRollover = useCallback(() => {
    // Worker writes decisions shortly after the hour — refresh a few times.
    const refreshLive = () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-agent-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-agent-positions'] });
      void queryClient.invalidateQueries({ queryKey: ['ai_agent_positions'] });
    };
    refreshLive();
    const t15 = setTimeout(refreshLive, 15_000);
    const t45 = setTimeout(refreshLive, 45_000);
    const t90 = setTimeout(refreshLive, 90_000);
    return () => {
      clearTimeout(t15);
      clearTimeout(t45);
      clearTimeout(t90);
    };
  }, [queryClient]);
  // Keep cleanup if the screen unmounts mid-burst.
  const rolloverCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => rolloverCleanupRef.current?.(), []);
  const nextCycleCountdown = useNextCycleCountdown(() => {
    rolloverCleanupRef.current?.();
    rolloverCleanupRef.current = onCycleRollover() ?? null;
  });

  const [agents, setAgents] = useState<AiAgentView[]>([]);
  // While Privy/auth is still hydrating, treat as loading — never flash the
  // marketing empty state for a signed-in user whose session isn't ready yet.
  const [loading, setLoading] = useState(() => !authReady || isAuthenticated);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  /** Which control is busy — so the spinner sits on Revoke vs play/pause vs Activate. */
  const [busyAction, setBusyAction] = useState<
    'activate' | 'stop' | 'resume' | 'revoke' | 'delete' | null
  >(null);
  /** Bumps to cancel an in-flight wallet signature (approve / revoke / delete; timeout, app resume, new tap). */
  const approveGenRef = useRef(0);
  /** Resume Dedicated create after a WC timeout without minting a second HL sub. */
  const pendingDedicatedCreateRef = useRef<{
    subName: string;
    subAddress?: `0x${string}`;
  } | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const approveAndActivateRef = useRef<(agent: AiAgentView) => Promise<void>>(async () => {});
  const [showCreate, setShowCreate] = useState(false);
  /** When set, the create form is editing this draft (settings only; not active/stopped). */
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);

  // Create / draft-edit form state.
  const [name, setName] = useState('');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbolQuery, setSymbolQuery] = useState('');
  const [modelIdx, setModelIdx] = useState(0); // GPT default (first in list)
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  // Aggressive default while the selector is hidden (RISK_PROFILE_SELECTOR_ENABLED).
  const [riskProfile, setRiskProfile] = useState<'standard' | 'aggressive'>('aggressive');
  const [horizon, setHorizon] = useState<'scalper' | 'swing' | 'investor'>('scalper');
  const [direction, setDirection] = useState<'long_short' | 'long_only' | 'short_only'>('long_short');
  const [mandate, setMandate] = useState<'active' | 'accumulate'>('active');
  const [budgetText, setBudgetText] = useState('');
  /** Dedicated create-only: USDC to sendAsset into the sub (not the notional cap). */
  const [fundingText, setFundingText] = useState('');
  const [maxPositionText, setMaxPositionText] = useState('');
  const [leverageText, setLeverageText] = useState('');
  const [coinglassKey, setCoinglassKey] = useState('');
  /** Draft edit: show masked saved key until the user chooses to replace it. */
  const [coinglassReplaceMode, setCoinglassReplaceMode] = useState(false);
  /** Server flag: house CoinGlass key serves everyone → hide the key step. */
  const [cgGlobalMode, setCgGlobalMode] = useState(false);
  const [dedicatedMode, setDedicatedMode] = useState(false);
  const [dedicatedEligibility, setDedicatedEligibility] = useState<DedicatedEligibility>({ state: 'checking' });
  const [creating, setCreating] = useState(false);
  const [transferAgent, setTransferAgent] = useState<AiAgentView | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  /** Show after the transfer sheet Modal unmounts — nested Modals freeze touches on RN. */
  const pendingTransferInfoRef = useRef<{ title: string; message?: string } | null>(null);

  const isEditingDraft = editingAgentId != null;
  /** Dedicated draft already funded at create — Transfer sheet for later moves. */
  const fundingAlreadySent = isEditingDraft && dedicatedMode;
  const dedicatedLocked =
    !isEditingDraft && dedicatedEligibility.state === 'ineligible';

  /** Stop/pause keep a slot; revoke frees it. Shared drafts do not count. */
  const sharedSlotsUsed = useMemo(
    () =>
      agents.filter(
        (a) => a.status !== 'draft' && a.status !== 'revoked' && a.mode !== 'dedicated',
      ).length,
    [agents],
  );
  /** Dedicated drafts count — Create already booked an HL sub-account. */
  const dedicatedSlotsUsed = useMemo(
    () =>
      agents.filter(
        (a) => a.status !== 'revoked' && a.mode === 'dedicated',
      ).length,
    [agents],
  );
  const sharedSlotsMax = AI_AGENT_LIMITS.maxAgentSlots;
  const dedicatedSlotsMax = AI_AGENT_LIMITS.maxAgentSlotsDedicated;
  /** Dedicated mode available (volume / existing subs / existing dedicated agent). */
  const dedicatedSlotsUnlocked =
    DEDICATED_MODE_ENABLED &&
    (dedicatedEligibility.state === 'eligible' ||
      agents.some((a) => a.mode === 'dedicated'));
  const sharedSlotsFull = sharedSlotsUsed >= sharedSlotsMax;
  const dedicatedSlotsFull = dedicatedSlotsUsed >= dedicatedSlotsMax;
  /** No room to create in any mode the wallet can use. */
  const createSlotsBlocked = dedicatedSlotsUnlocked
    ? sharedSlotsFull && dedicatedSlotsFull
    : sharedSlotsFull;

  // Symbol autocomplete source: main-dex crypto perps (/crypto-assets) plus
  // HIP-3 stock/RWA perps (/assets — coins like `xyz:TSLA`). Unified accounts
  // trade HIP-3 from spot USDC with the agent key (proven by the xyz spike),
  // so agents may target both universes.
  const { data: cryptoAssets } = useQuery({
    queryKey: ['crypto-assets'], // shared cache key with homepage/price-alerts
    queryFn: fetchCryptoAssets,
    enabled: showCreate,
    staleTime: 5 * 60_000,
  });
  const { data: hip3Assets } = useQuery({
    queryKey: ['assets'], // shared cache key with homepage/price-alerts
    queryFn: fetchAssets,
    enabled: showCreate,
    staleTime: 5 * 60_000,
  });
  const selectableAssets = useMemo(() => {
    const crypto = (cryptoAssets?.assets ?? []).filter(
      (a) => !a.isHip3 && !a.isSpotOnly && !a.coin.includes(':') && !a.coin.startsWith('@'),
    );
    // HIP-3 picker: catalog allowlist + supported dexs (`xyz`, `io`).
    // Pre-IPO (io:ANTH) is never selectable.
    const seen = new Set(crypto.map((a) => a.coin.toUpperCase()));
    const hip3 = (hip3Assets?.assets ?? []).filter((a) => {
      const coin = String(a.coin ?? '');
      if (!coin.includes(':')) return false;
      const dex = coin.slice(0, coin.indexOf(':')).toLowerCase();
      if (!AI_AGENT_SUPPORTED_HIP3_DEXES.has(dex)) return false;
      if (a.isPreIpo === true) return false;
      if (seen.has(coin.toUpperCase())) return false;
      if (isAiAgentHip3Excluded(coin)) return false;
      return true;
    });
    return [...crypto, ...hip3];
  }, [cryptoAssets, hip3Assets]);
  const symbolSuggestions = useMemo(() => {
    const q = symbolQuery.trim().toUpperCase();
    if (!q) return [];
    return selectableAssets
      .filter(
        (a) =>
          !symbols.includes(a.coin.toUpperCase()) &&
          (a.coin.toUpperCase().includes(q) ||
            a.symbol?.toUpperCase().includes(q) ||
            a.name?.toUpperCase().includes(q)),
      )
      .slice(0, 6);
  }, [symbolQuery, selectableAssets, symbols]);

  /** Copilot peers on this wallet already claiming a symbol → block at pick time. */
  const copilotTakenSymbols = useMemo(() => {
    const map = new Map<string, string>(); // SYMBOL → peer agent name
    if (dedicatedMode) return map;
    for (const a of agents) {
      if (editingAgentId && a.id === editingAgentId) continue;
      if (a.mode === 'dedicated') continue;
      if (!['draft', 'active', 'paused'].includes(a.status)) continue;
      for (const s of a.config.symbols ?? []) {
        const sym = s.toUpperCase();
        if (!map.has(sym)) map.set(sym, a.name);
      }
    }
    return map;
  }, [agents, dedicatedMode, editingAgentId]);

  const findSymbolOverlap = useCallback(
    (syms: string[]) => {
      if (dedicatedMode) return null;
      for (const s of syms) {
        const peer = copilotTakenSymbols.get(s.toUpperCase());
        if (peer) return { symbol: s.toUpperCase(), peerName: peer };
      }
      return null;
    },
    [dedicatedMode, copilotTakenSymbols],
  );

  const hasCopilotLive = agents.some(
    (a) => a.mode === 'copilot' && a.status !== 'draft' && a.status !== 'revoked'
  );

  // Master book: shared-agent live PnL, dedicated-create margin warning, and
  // blocking symbols the user already holds (avoids forever-skipping agents).
  const {
    data: masterTradingState,
    isPending: masterStatePending,
  } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, address],
    queryFn: () => getHyperliquidTradingState(address as `0x${string}`),
    enabled: Boolean(
      address && (hasCopilotLive || showCreate || transferAgent != null || agents.some((a) => a.mode === 'dedicated')),
    ),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  /** Open master-perp coins (manual or AI) — shared agents must not select these. */
  const masterOpenSymbols = useMemo(
    () => liveOpenCoinSet(masterTradingState),
    [masterTradingState],
  );

  const findManualOpenConflict = useCallback(
    (syms: string[]) => {
      // Dedicated clears on a sub-account — master book doesn't block.
      if (dedicatedMode && DEDICATED_MODE_ENABLED) return null;
      for (const s of syms) {
        const sym = s.toUpperCase();
        if (masterOpenSymbols.has(sym)) return sym;
      }
      return null;
    },
    [dedicatedMode, masterOpenSymbols],
  );

  const masterRestingCoins = masterTradingState?.restingLimitCoins ?? EMPTY_RESTING_COINS;
  const masterHasRestingLimits = masterRestingCoins.length > 0;
  const findRestingLimitConflict = useCallback(
    (syms: string[], opts?: { dedicated?: boolean }) => {
      const dedicated = opts?.dedicated ?? (dedicatedMode && DEDICATED_MODE_ENABLED);
      if (dedicated) return null;
      for (const s of syms) {
        if (symbolHasRestingLimit(s, masterRestingCoins)) return s.toUpperCase();
      }
      return null;
    },
    [dedicatedMode, masterRestingCoins],
  );
  const selectedHasRestingLimits =
    !(DEDICATED_MODE_ENABLED && dedicatedMode) &&
    symbols.some((s) => symbolHasRestingLimit(s, masterRestingCoins));

  // Per-symbol HL margin support — if any selected asset is isolated-only,
  // mute Cross so we don't burn LLM/HL cycles on a mode that will always fall back.
  const marginSupportQueries = useQueries({
    queries: symbols.map((sym) => ({
      queryKey: ['perp-margin-support', sym],
      queryFn: () => getPerpMarginSupport(sym),
      enabled: showCreate && symbols.length > 0,
      staleTime: 60 * 60_000,
    })),
  });
  const marginSupportLoading = marginSupportQueries.some((q) => q.isLoading || q.isPending);
  const marginSupportFlags = marginSupportQueries
    .map((q) => (q.data == null ? '?' : q.data.supportsCross ? '1' : '0'))
    .join(',');
  /** Isolated-only picks (e.g. some HIP-3 assets) — the worker auto-routes these to isolated per asset. */
  const isolatedOnlySymbols = useMemo(() => {
    const flags = marginSupportFlags.split(',');
    return symbols.filter((_, i) => flags[i] === '0');
  }, [symbols, marginSupportFlags]);
  const crossAllowedForSymbols = useMemo(() => {
    if (!symbols.length || marginSupportLoading) return true;
    // Cross only becomes pointless when EVERY selected asset is isolated-only;
    // mixed baskets keep Cross — the worker falls back per asset (see hint).
    const flags = marginSupportFlags.split(',');
    return flags.some((f) => f !== '0');
  }, [symbols.length, marginSupportLoading, marginSupportFlags]);
  useEffect(() => {
    if (!crossAllowedForSymbols && marginMode === 'cross') {
      setMarginMode('isolated');
    }
  }, [crossAllowedForSymbols, marginMode]);

  // Dedicated-mode eligibility — drives create toggle + header slots max (2 vs 10).
  // HL gates sub-account creation behind ~$100k *qualifying* volume (fee-tier
  // contribution; HIP-3 growth mode ~10%) — see getUserLifetimeVolumeUsd.
  useEffect(() => {
    if (!DEDICATED_MODE_ENABLED) {
      setDedicatedMode(false);
      setDedicatedEligibility({ state: 'ineligible', lifetimeVolumeUsd: 0 });
      return;
    }
    if (!address) {
      setDedicatedEligibility({ state: 'checking' });
      return;
    }
    let aborted = false;
    setDedicatedEligibility({ state: 'checking' });
    (async () => {
      try {
        const { getUserLifetimeVolumeUsd, listHlSubAccounts } = await import('../src/lib/hyperliquid');
        const [vlm, subs] = await Promise.all([
          getUserLifetimeVolumeUsd(address as `0x${string}`),
          listHlSubAccounts(address as `0x${string}`).catch(() => []),
        ]);
        if (aborted) return;
        if (subs.length > 0 || vlm >= DEDICATED_MIN_VOLUME_USD) {
          setDedicatedEligibility({ state: 'eligible' });
        } else {
          setDedicatedEligibility({ state: 'ineligible', lifetimeVolumeUsd: vlm });
          // Only clear the toggle when creating a new agent (not editing a draft).
          if (showCreate && !editingAgentId) setDedicatedMode(false);
        }
      } catch {
        if (!aborted) setDedicatedEligibility({ state: 'unknown' });
      }
    })();
    return () => {
      aborted = true;
    };
  }, [address, showCreate, editingAgentId]);

  const [decisionsByAgent, setDecisionsByAgent] = useState<Record<string, AiAgentDecision[]>>({});
  const [decisionsHasMore, setDecisionsHasMore] = useState<Record<string, boolean>>({});
  /** Per-agent ticker filter for Recent Decisions (`all` = no symbol param). */
  const [decisionsSymbolByAgent, setDecisionsSymbolByAgent] = useState<Record<string, string>>({});
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [loadingDecisionsId, setLoadingDecisionsId] = useState<string | null>(null);
  const [loadingMoreDecisionsId, setLoadingMoreDecisionsId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmDontAskAgain, setConfirmDontAskAgain] = useState(false);
  const [restingSharedDismissed, setRestingSharedDismissed] = useState(false);
  const [restingDedicatedDismissed, setRestingDedicatedDismissed] = useState(false);
  const [pendingFundWarnUsd, setPendingFundWarnUsd] = useState<number | null>(null);
  const [fundDontAskAgain, setFundDontAskAgain] = useState(false);
  const [infoAlert, setInfoAlert] = useState<{ title: string; message: string } | null>(null);
  const [symbolNavList, setSymbolNavList] = useState<string[] | null>(null);
  const showInfo = useCallback((title: string, message = '') => {
    setInfoAlert({ title, message });
  }, []);
  const navigateToAsset = useCallback((coin: string) => {
    const raw = String(coin ?? '').trim();
    if (!raw) return;
    // Agent config stores symbols uppercased (`XYZ:TSLA`). The asset page /
    // `/assets/{coin}` lookup matches Home: lowercase HIP-3 dex + ticker
    // (`xyz:TSLA`). Core perps stay a bare coin (`BTC`). Never strip `xyz:`.
    const routeCoin = raw.includes(':')
      ? `${raw.slice(0, raw.indexOf(':')).toLowerCase()}:${raw.slice(raw.indexOf(':') + 1)}`
      : getDisplayAssetRouteSymbol(raw);
    if (!routeCoin) return;
    pushRouteOnce(router, `/asset/${encodeURIComponent(routeCoin)}` as Href);
  }, [router]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      isRestingLimitSharedWarnDismissed(),
      isRestingLimitDedicatedFundWarnDismissed(),
    ]).then(([shared, dedicated]) => {
      if (cancelled) return;
      setRestingSharedDismissed(shared);
      setRestingDedicatedDismissed(dedicated);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!pendingConfirm) setConfirmDontAskAgain(false);
  }, [pendingConfirm]);
  useEffect(() => {
    if (pendingFundWarnUsd == null) setFundDontAskAgain(false);
  }, [pendingFundWarnUsd]);
  const [renamingAgentId, setRenamingAgentId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'active' | 'stopped' | 'draft' | 'revoked'
  >('all');
  const [modeFilter, setModeFilter] = useState<'all' | 'shared' | 'dedicated'>('all');
  const [symbolFilter, setSymbolFilter] = useState<string>('all');
  /** UI window over filteredAgents — avoids rendering dozens of revoked/draft cards. */
  const [agentListVisibleCount, setAgentListVisibleCount] = useState(5);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    // Full-page spinner only for the first list load — per-agent actions
    // (stop/resume/…) should keep the cards on screen and use busyAgentId.
    const silent = opts?.silent === true;
    if (!silent) setLoading(true);
    try {
      const list = await listAiAgents(token);
      setAgents(list.agents);
      setCgGlobalMode(list.coinglassGlobalMode);
      void queryClient.invalidateQueries({ queryKey: ['ai-agent-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-agent-hl-summary'] });
    } catch (e) {
      console.log('[ai-agents] list failed', e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [getAccessToken, queryClient]);

  useEffect(() => {
    if (!authReady) {
      setLoading(true);
      return;
    }
    if (!isAuthenticated) {
      setLoading(false);
      setAgents([]);
      return;
    }
    void refresh();
  }, [authReady, isAuthenticated, refresh]);

  const resetForm = useCallback(() => {
    setName('');
    setSymbols([]);
    setSymbolQuery('');
    setModelIdx(firstAvailableModelIdx());
    setMarginMode('cross');
    setRiskProfile('aggressive');
    setHorizon('scalper');
    setDirection('long_short');
    setMandate('active');
    setBudgetText('');
    setFundingText('');
    setMaxPositionText('');
    setLeverageText('');
    setCoinglassKey('');
    setCoinglassReplaceMode(false);
    setDedicatedMode(false);
    setEditingAgentId(null);
  }, []);

  const closeForm = useCallback(() => {
    setShowCreate(false);
    resetForm();
  }, [resetForm]);

  const openCreateForm = useCallback(() => {
    if (!isAuthenticated) {
      pushRouteOnce(router, '/login');
      return;
    }
    if (createSlotsBlocked) {
      showInfo(
        t('aiAgents.slotsFullTitle'),
        dedicatedSlotsUnlocked
          ? t('aiAgents.slotsFullDescBoth', {
              sharedUsed: sharedSlotsUsed,
              sharedMax: sharedSlotsMax,
              dedicatedUsed: dedicatedSlotsUsed,
              dedicatedMax: dedicatedSlotsMax,
            })
          : t('aiAgents.slotsFullDesc', {
              kind: t('aiAgents.modeShared'),
              used: sharedSlotsUsed,
              max: sharedSlotsMax,
            }),
      );
      return;
    }
    resetForm();
    setShowCreate(true);
  }, [
    isAuthenticated,
    resetForm,
    router,
    createSlotsBlocked,
    dedicatedSlotsUnlocked,
    sharedSlotsUsed,
    sharedSlotsMax,
    dedicatedSlotsUsed,
    dedicatedSlotsMax,
    showInfo,
    t,
  ]);

  const openEditDraft = useCallback((agent: AiAgentView) => {
    if (agent.status !== 'draft') return;
    const opening = agent.config.models?.opening;
    const foundExact = opening
      ? MODEL_OPTIONS.findIndex(
          (m) => m.choice.provider === opening.provider && m.choice.model === opening.model,
        )
      : -1;
    // Provider-only fallback (e.g. gemini-3.6-flash agents after catalog bump to 3.7).
    const foundProvider =
      foundExact < 0 && opening
        ? MODEL_OPTIONS.findIndex((m) => m.choice.provider === opening.provider)
        : -1;
    const found = foundExact >= 0 ? foundExact : foundProvider;
    setEditingAgentId(agent.id);
    setName(agent.name);
    setSymbols([...(agent.config.symbols ?? [])].map((s) => s.toUpperCase()));
    setSymbolQuery('');
    // Don't leave an unavailable model selected in the picker.
    setModelIdx(
      found >= 0 && !MODEL_OPTIONS[found].unavailable ? found : firstAvailableModelIdx(),
    );
    setMarginMode(agent.config.margin_mode === 'isolated' ? 'isolated' : 'cross');
    setRiskProfile(agent.config.risk_profile === 'aggressive' ? 'aggressive' : 'standard');
    setHorizon(
      agent.config.horizon === 'investor'
        ? 'investor'
        : agent.config.horizon === 'swing'
          ? 'swing'
          : 'scalper',
    );
    setDirection(
      agent.config.direction === 'long_only'
        ? 'long_only'
        : agent.config.direction === 'short_only'
          ? 'short_only'
          : 'long_short',
    );
    setMandate(agent.config.mandate === 'accumulate' ? 'accumulate' : 'active');
    setBudgetText(String(agent.config.max_capital_usd ?? ''));
    setFundingText('');
    setMaxPositionText(
      agent.config.max_position_usd != null ? String(agent.config.max_position_usd) : ''
    );
    setLeverageText(String(agent.config.leverage_cap ?? ''));
    setCoinglassKey('');
    setCoinglassReplaceMode(!agent.hasCoinglassKey);
    setDedicatedMode(DEDICATED_MODE_ENABLED && agent.mode === 'dedicated');
    setShowCreate(true);
  }, []);

  const handleCreate = useCallback(async () => {
    const token = await getAccessToken();
    if (!token || !address) return;
    const budget = Number(budgetText);
    const funding = Number(fundingText);
    const leverage = Number(leverageText);
    const maxPosition =
      AI_AGENT_SHOW_PER_POSITION_CAP && maxPositionText.trim()
        ? Number(maxPositionText)
        : undefined;
    const notionalCeiling = budget;
    const useDedicated = DEDICATED_MODE_ENABLED && dedicatedMode;
    if (!isEditingDraft) {
      if (useDedicated && dedicatedSlotsFull) {
        showInfo(
          t('aiAgents.slotsFullTitle'),
          t('aiAgents.slotsFullDesc', {
            kind: t('aiAgents.modeDedicated'),
            used: dedicatedSlotsUsed,
            max: dedicatedSlotsMax,
          }),
        );
        return;
      }
      if (!useDedicated && sharedSlotsFull) {
        showInfo(
          t('aiAgents.slotsFullTitle'),
          t('aiAgents.slotsFullDesc', {
            kind: t('aiAgents.modeShared'),
            used: sharedSlotsUsed,
            max: sharedSlotsMax,
          }),
        );
        return;
      }
    }
    if (!name.trim()) {
      showInfo(t('aiAgents.nameRequired'));
      return;
    }
    if (!symbols.length) {
      showInfo(t('aiAgents.noSymbols'));
      return;
    }
    const overlap = findSymbolOverlap(symbols);
    if (overlap) {
      showInfo(
        t('aiAgents.symbolOverlapTitle'),
        t('aiAgents.symbolOverlapDesc', { symbol: displaySymbol(overlap.symbol), name: overlap.peerName }),
      );
      return;
    }
    const manualOpen = findManualOpenConflict(symbols);
    if (manualOpen) {
      showInfo(
        t('aiAgents.symbolManualOpenTitle'),
        t('aiAgents.symbolManualOpenDesc', { symbol: displaySymbol(manualOpen) }),
      );
      return;
    }
    // Capital floor exists because the AI sizes positions as a fraction of the
    // total and the worker floors each order at ~$15 (above HL's min notional);
    // below the floor there's no room to trade. Keep in sync with backend.
    if (!Number.isFinite(budget) || budget < AI_AGENT_LIMITS.minCapitalUsd || budget > AI_AGENT_LIMITS.maxCapitalUsd) {
      showInfo(t('aiAgents.invalidCapital', {
          defaultValue: 'Enter a total between ${{min}} and ${{max}}.',
          min: AI_AGENT_LIMITS.minCapitalUsd,
          max: AI_AGENT_LIMITS.maxCapitalUsd.toLocaleString(),
        }));
      return;
    }
    if (
      useDedicated &&
      (!Number.isFinite(funding) ||
        funding < AI_AGENT_LIMITS.minCapitalUsd ||
        funding > AI_AGENT_LIMITS.maxCapitalUsd)
    ) {
      showInfo(
        t('aiAgents.invalidFunding', {
          min: AI_AGENT_LIMITS.minCapitalUsd,
          max: AI_AGENT_LIMITS.maxCapitalUsd.toLocaleString(),
        }),
      );
      return;
    }
    const { max: effectiveMaxLeverage, ceilingSymbol } = resolveLeverageCapForSymbols(
      symbols,
      selectableAssets
    );
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > effectiveMaxLeverage) {
      showInfo(ceilingSymbol
          ? t('aiAgents.leverageMaxHint', { symbol: displaySymbol(ceilingSymbol), max: effectiveMaxLeverage })
          : t('aiAgents.leverageRangeHint', { max: effectiveMaxLeverage }));
      return;
    }
    if (
      maxPosition !== undefined &&
      (!Number.isFinite(maxPosition) ||
        maxPosition < AI_AGENT_LIMITS.minPositionUsd ||
        maxPosition > notionalCeiling)
    ) {
      showInfo(maxPosition < AI_AGENT_LIMITS.minPositionUsd
          ? t('aiAgents.minPositionHint', { min: AI_AGENT_LIMITS.minPositionUsd })
          : t('aiAgents.invalidMaxPosition', 'Max per position must be a positive amount no larger than the total.'));
      return;
    }
    if (!cgGlobalMode && !coinglassKey.trim()) {
      showInfo(t('aiAgents.keysRequired'), t('aiAgents.keysRequiredDesc'));
      return;
    }
    setCreating(true);
    const signTimeoutMs = 90_000;
    const stillCurrent = () => true;
    try {
      // Dedicated: createSub → unify sub → sendAsset spot fund (master-signed).
      // External wallets: time-box each prompt, never abort an in-flight WC
      // request, and reuse a sub created on a prior tap that timed out.
      let subaccountAddress: string | undefined;
      if (useDedicated) {
        if (!wallet) throw new Error(t('aiAgents.walletNotReady'));
        const walletProvider = await wallet.getProvider();
        const userAddress = address as `0x${string}`;
        if (!pendingDedicatedCreateRef.current) {
          pendingDedicatedCreateRef.current = {
            subName: `ai-${Date.now().toString(36).slice(-6)}`,
          };
        }
        const pending = pendingDedicatedCreateRef.current;

        if (!pending.subAddress) {
          const existing = (await listHlSubAccounts(userAddress)).find(
            (s) => s.name === pending.subName,
          );
          if (existing) {
            pending.subAddress = existing.subAccountUser;
          } else {
            const created = await withExternalWalletSign(
              () =>
                createHlSubAccount({
                  userWalletProvider: walletProvider,
                  userAddress,
                  name: pending.subName,
                }),
              { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
            );
            if (!created) throw new Error(t('aiAgents.createFailed'));
            pending.subAddress = created;
            if (isExternal) await new Promise((r) => setTimeout(r, 1_200));
          }
        }

        await withExternalWalletSign(
          () =>
            ensureSubAccountUnified({
              userWalletProvider: walletProvider,
              userAddress,
              subAccountAddress: pending.subAddress!,
            }),
          { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
        );
        if (isExternal) await new Promise((r) => setTimeout(r, 1_200));

        let alreadyFunded = false;
        try {
          const equity = Number(
            (await getHyperliquidTradingState(pending.subAddress!)).accountValueUsd,
          );
          alreadyFunded = Number.isFinite(equity) && equity >= funding * 0.98;
        } catch {
          alreadyFunded = false;
        }
        if (!alreadyFunded) {
          await withExternalWalletSign(
            () =>
              transferUsdToSubAccount({
                userWalletProvider: walletProvider,
                userAddress,
                subAccountAddress: pending.subAddress!,
                usd: funding,
                isDeposit: true,
              }),
            { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
          );
        }
        subaccountAddress = pending.subAddress;
      }

      await createAiAgent(
        {
          name: name.trim(),
          hlMasterAddress: address,
          config: {
            symbols,
            models: { opening: MODEL_OPTIONS[modelIdx].choice },
            max_capital_usd: budget,
            ...(maxPosition !== undefined ? { max_position_usd: maxPosition } : {}),
            leverage_cap: leverage,
            margin_mode: marginMode,
            risk_profile: riskProfile,
            horizon,
            direction,
            mandate: direction !== 'long_short' ? mandate : 'active',
          },
          ...(coinglassKey.trim() ? { coinglassApiKey: coinglassKey.trim() } : {}),
          mode: useDedicated ? 'dedicated' : 'copilot',
          hlSubaccountAddress: subaccountAddress,
        },
        token
      );
      pendingDedicatedCreateRef.current = null;
      closeForm();
      await refresh({ silent: true });
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (isWalletSignatureRejected(e)) {
        showInfo(t('aiAgents.approveRejectedTitle'), t('aiAgents.approveRejected'));
      } else if (isHlSigningChainError(e)) {
        showInfo(t('aiAgents.approveChainSwitchTitle'), t('aiAgents.approveChainSwitch'));
      } else if (msg === '__approve_pending__') {
        showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.approvePendingRetry'));
      } else if (msg === '__approve_timeout__' || msg === '__approve_aborted__') {
        showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.approveTimeout'));
      } else {
        const detail = String(e?.response?.data?.detail ?? e?.message ?? e);
        showInfo(t('aiAgents.createFailed'),
          /volume|sub.?account/i.test(detail) && dedicatedMode && DEDICATED_MODE_ENABLED
            ? t('aiAgents.dedicatedUnavailable')
            : detail);
      }
    } finally {
      setCreating(false);
    }
  }, [getAccessToken, address, wallet, isExternal, symbols, selectableAssets, budgetText, fundingText, maxPositionText, leverageText, name, modelIdx, marginMode, riskProfile, horizon, direction, mandate, coinglassKey, cgGlobalMode, dedicatedMode, closeForm, refresh, showInfo, t, findSymbolOverlap, findManualOpenConflict, isEditingDraft, sharedSlotsFull, dedicatedSlotsFull, sharedSlotsUsed, sharedSlotsMax, dedicatedSlotsUsed, dedicatedSlotsMax]);

  const handleSaveDraft = useCallback(async () => {
    const token = await getAccessToken();
    if (!token || !editingAgentId) return;
    const budget = Number(budgetText);
    const leverage = Number(leverageText);
    const maxPosition =
      AI_AGENT_SHOW_PER_POSITION_CAP && maxPositionText.trim()
        ? Number(maxPositionText)
        : undefined;
    const notionalCeiling = budget;
    if (!name.trim()) {
      showInfo(t('aiAgents.nameRequired'));
      return;
    }
    if (!symbols.length) {
      showInfo(t('aiAgents.noSymbols'));
      return;
    }
    const overlap = findSymbolOverlap(symbols);
    if (overlap) {
      showInfo(
        t('aiAgents.symbolOverlapTitle'),
        t('aiAgents.symbolOverlapDesc', { symbol: displaySymbol(overlap.symbol), name: overlap.peerName }),
      );
      return;
    }
    const manualOpen = findManualOpenConflict(symbols);
    if (manualOpen) {
      showInfo(
        t('aiAgents.symbolManualOpenTitle'),
        t('aiAgents.symbolManualOpenDesc', { symbol: displaySymbol(manualOpen) }),
      );
      return;
    }
    if (!Number.isFinite(budget) || budget < AI_AGENT_LIMITS.minCapitalUsd || budget > AI_AGENT_LIMITS.maxCapitalUsd) {
      showInfo(t('aiAgents.invalidCapital', {
          defaultValue: 'Enter a total between ${{min}} and ${{max}}.',
          min: AI_AGENT_LIMITS.minCapitalUsd,
          max: AI_AGENT_LIMITS.maxCapitalUsd.toLocaleString(),
        }));
      return;
    }
    const { max: effectiveMaxLeverage, ceilingSymbol } = resolveLeverageCapForSymbols(
      symbols,
      selectableAssets
    );
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > effectiveMaxLeverage) {
      showInfo(ceilingSymbol
          ? t('aiAgents.leverageMaxHint', { symbol: displaySymbol(ceilingSymbol), max: effectiveMaxLeverage })
          : t('aiAgents.leverageRangeHint', { max: effectiveMaxLeverage }));
      return;
    }
    if (
      maxPosition !== undefined &&
      (!Number.isFinite(maxPosition) ||
        maxPosition < AI_AGENT_LIMITS.minPositionUsd ||
        maxPosition > notionalCeiling)
    ) {
      showInfo(maxPosition < AI_AGENT_LIMITS.minPositionUsd
          ? t('aiAgents.minPositionHint', { min: AI_AGENT_LIMITS.minPositionUsd })
          : t('aiAgents.invalidMaxPosition', 'Max per position must be a positive amount no larger than the total.'));
      return;
    }
    if (coinglassReplaceMode && !coinglassKey.trim()) {
      showInfo(t('aiAgents.keysRequired'), t('aiAgents.keysRequiredDesc'));
      return;
    }
    setCreating(true);
    try {
      await updateAiAgent(
        editingAgentId,
        {
          name: name.trim(),
          config: {
            symbols,
            models: { opening: MODEL_OPTIONS[modelIdx].choice },
            max_capital_usd: budget,
            ...(maxPosition !== undefined ? { max_position_usd: maxPosition } : {}),
            leverage_cap: leverage,
            margin_mode: marginMode,
            risk_profile: riskProfile,
            horizon,
            direction,
            mandate: direction !== 'long_short' ? mandate : 'active',
          },
          ...(coinglassReplaceMode && coinglassKey.trim()
            ? { coinglassApiKey: coinglassKey.trim() }
            : {}),
        },
        token
      );
      closeForm();
      await refresh({ silent: true });
    } catch (e: any) {
      showInfo(t('aiAgents.saveFailed'),
        String(e?.response?.data?.detail ?? e?.message ?? e));
    } finally {
      setCreating(false);
    }
  }, [
    getAccessToken,
    editingAgentId,
    symbols,
    selectableAssets,
    budgetText,
    maxPositionText,
    leverageText,
    name,
    modelIdx,
    marginMode,
    riskProfile,
    horizon,
    direction,
    mandate,
    coinglassKey,
    coinglassReplaceMode,
    dedicatedMode,
    closeForm,
    refresh,
    showInfo,
    t,
    findSymbolOverlap,
    findManualOpenConflict,
  ]);

  /**
   * approveAgent signature + verified activation — self-healing for the
   * WalletConnect round-trip races that external wallets hit:
   *   • App backgrounding when the wallet deep-links can suspend JS before the
   *     request finishes publishing — the wallet opens with nothing to show,
   *     or our promise never resolves even though the user DID sign.
   *   • Therefore: try activation FIRST (the approval may already be live on
   *     HL from a previous attempt), time-box the signature so the button can
   *     never hang forever, and poll activation afterwards (HL propagation +
   *     lost-response tolerance). Every retry tap is safe and idempotent.
   *   • On resume we only refresh — we never abort the in-flight WC promise
   *     (aborting mid-return was what caused "didn't catch the signature").
   */
  const handleApproveAndActivate = useCallback(
    async (agent: AiAgentView) => {
      if (isDemo) {
        showInfo(
          t('aiAgents.demoActivateBlockedTitle'),
          t('aiAgents.demoActivateBlockedDesc'),
        );
        return;
      }
      const token = await getAccessToken();
      if (!token || !wallet || !address) return;
      if (address.toLowerCase() !== agent.hlMasterAddress.toLowerCase()) {
        showInfo(t('aiAgents.wrongWallet'), t('aiAgents.wrongWalletDesc'));
        return;
      }
      // Shared draft → live needs a free Shared slot. Dedicated draft already
      // holds one (HL sub at Create); resume already holds one either mode.
      if (agent.status === 'draft' && agent.mode !== 'dedicated' && sharedSlotsFull) {
        showInfo(
          t('aiAgents.slotsFullTitle'),
          t('aiAgents.slotsFullDesc', {
            kind: t('aiAgents.modeShared'),
            used: sharedSlotsUsed,
            max: sharedSlotsMax,
          }),
        );
        return;
      }

      const manualOpen = findManualOpenConflict(agent.config.symbols ?? []);
      if (manualOpen) {
        showInfo(
          t('aiAgents.symbolManualOpenTitle'),
          t('aiAgents.symbolManualOpenDesc', { symbol: displaySymbol(manualOpen) }),
        );
        return;
      }

      // Cancel any previous attempt for this (or another) agent.
      const gen = ++approveGenRef.current;
      const stillCurrent = () => approveGenRef.current === gen;
      setBusyAgentId(agent.id);
      setBusyAction('activate');

      const clearBusyIfCurrent = () => {
        if (stillCurrent()) {
          setBusyAgentId(null);
          setBusyAction(null);
        }
      };

      // Activation is verified on HL by the backend:
      //   ok             → agent is active
      //   need_approval  → 409 not approved yet → must wallet-sign
      //   retry          → 503 / HL rate limit / transient → poll again, do NOT
      //                    treat as "unsigned" (that caused a useless 2nd tap)
      const tryActivate = async (): Promise<ActivateProbe> => {
        try {
          const updated = await activateAiAgent(agent.id, token);
          setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
          return 'ok';
        } catch (e: any) {
          if (e?.response?.status === 409) {
            const detail = String(e?.response?.data?.detail ?? '');
            if (/status active/i.test(detail) || /already active/i.test(detail)) {
              setAgents((prev) =>
                prev.map((a) => (a.id === agent.id ? { ...a, status: 'active' } : a))
              );
              return 'ok';
            }
            // Only the "not approved yet" 409 means sign. $100 / slots / CG
            // must not open a wallet prompt (that burns an extraAgents slot).
            if (isHlNotApprovedYetError(e)) return 'need_approval';
            throw e;
          }
          if (isActivateVerifyRetryableError(e)) return 'retry';
          throw e;
        }
      };

      const pollActivateUntil = async (
        attempts: number,
        delayMs: number,
        opts?: { /** Stop early when HL says approval is missing (pre-sign only). */ stopOnNeedApproval?: boolean },
      ): Promise<boolean> => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (!stillCurrent()) {
            const late = await tryActivate().catch(() => 'retry' as ActivateProbe);
            return late === 'ok';
          }
          const probe = await tryActivate();
          if (probe === 'ok') {
            await refresh({ silent: true });
            return true;
          }
          if (probe === 'need_approval' && opts?.stopOnNeedApproval) {
            return false;
          }
          // need_approval (post-sign) OR retry → wait; approval may still be
          // propagating, or HL info may be rate-limited.
          if (attempt < attempts - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        return false;
      };

      // External WC sessions often never resolve if the user backs out of the
      // wallet — time-box so the button unlocks for a retry (resume must NOT
      // abort the promise; that raced the returning signature).
      const signTimeoutMs = 90_000;
      const pollAttempts = isExternal ? 8 : 12;
      const pollDelayMs = isExternal ? 2_000 : 2_500;
      const preflightAttempts = isExternal ? 4 : 3;

      try {
        // 1) Already approved / active? Absorb HL verify rate-limits before
        //    opening a new wallet prompt. Exit ASAP on a clear need_approval.
        if (await pollActivateUntil(preflightAttempts, pollDelayMs, { stopOnNeedApproval: true })) {
          return;
        }
        if (!stillCurrent()) return;

        const preSign = await tryActivate();
        if (preSign === 'ok') {
          await refresh({ silent: true });
          return;
        }
        if (preSign === 'retry') {
          // Couldn't verify — soft message; next tap retries without a forced
          // duplicate sign if approval already landed.
          clearBusyIfCurrent();
          showInfo(t('aiAgents.activateNotConfirmedTitle'), t('aiAgents.activateNotConfirmed'));
          return;
        }
        if (!stillCurrent()) return;

        // 2) Request the signature, time-boxed so a lost WC response can't
        //    hang the button forever (user can safely tap again).
        const provider0 = await wallet.getProvider();
        if (!stillCurrent()) return;

        try {
          await approveNamedAgentForActivate(
            {
              userWalletProvider: provider0,
              userAddress: address as `0x${string}`,
              agentAddress: agent.hlAgentAddress as `0x${string}`,
              agentName: agent.hlAgentName,
            },
            { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
          );
        } catch (signErr) {
          if (!stillCurrent() && String((signErr as Error)?.message) === '__approve_aborted__') {
            await pollActivateUntil(pollAttempts, pollDelayMs);
            return;
          }
          throw signErr;
        }
        if (!stillCurrent()) {
          await pollActivateUntil(pollAttempts, pollDelayMs);
          return;
        }

        // 3) Confirm on HL — poll through propagation + HL rate-limit blips.
        if (await pollActivateUntil(pollAttempts, pollDelayMs)) return;
        if (!stillCurrent()) return;

        clearBusyIfCurrent();
        showInfo(t('aiAgents.activateNotConfirmedTitle'), t('aiAgents.activateNotConfirmed'));
      } catch (e: any) {
        // Even if this attempt was superseded, a late success should refresh.
        if (!stillCurrent()) {
          try {
            await pollActivateUntil(3, 1_000);
          } catch {
            // ignore — superseded attempt
          }
          return;
        }
        clearBusyIfCurrent();
        const msg = String(e?.message ?? '');
        // Reject / cancel never reaches the HL poll loop — only a resolved
        // approveNamedAgent does. Unlock quietly with a soft message.
        if (isWalletSignatureRejected(e)) {
          showInfo(t('aiAgents.approveRejectedTitle'), t('aiAgents.approveRejected'));
        } else if (isHlSigningChainError(e)) {
          showInfo(t('aiAgents.approveChainSwitchTitle'), t('aiAgents.approveChainSwitch'));
        } else if (msg === '__approve_pending__') {
          showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.approvePendingRetry'));
        } else if (msg === '__approve_timeout__' || msg === '__approve_aborted__') {
          // The request may still be sitting in the wallet — signing it late
          // is fine; the next tap starts with the activation check.
          if (await pollActivateUntil(pollAttempts, pollDelayMs)) return;
          showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.approveTimeout'));
        } else if (isHlNotApprovedYetError(e)) {
          // Never surface the raw backend 409 — it usually means the wallet
          // never completed approveAgent (stuck WC), not a hard failure.
          showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.approveTimeout'));
        } else if (isActivateVerifyRetryableError(e)) {
          // Signature may already be on HL; rate-limit blocked verify.
          if (await pollActivateUntil(pollAttempts, pollDelayMs)) return;
          showInfo(t('aiAgents.activateNotConfirmedTitle'), t('aiAgents.activateNotConfirmed'));
        } else if (isHlExtraAgentLimitError(e)) {
          const victim = pickAgentSlotToFree(agents, agent.id);
          if (victim && wallet && address) {
            setPendingConfirm({
              type: 'freeSlot',
              agent,
              freeName: victim.hlAgentName,
              freeDbId: victim.id,
              freeLabel: victim.name,
            });
          } else if (wallet && address) {
            // No stopped agent in-app — maybe a deleted agent left an orphan
            // htai-* approval. Offer to free the oldest one and retry.
            try {
              const extras = await listHlExtraAgents(address as `0x${string}`);
              const knownNames = new Set(
                agents.map((a) => a.hlAgentName).filter(Boolean)
              );
              const orphan = extras
                .filter((x) => x.name.startsWith('htai-') && !knownNames.has(x.name))
                .sort((a, b) => a.validUntil - b.validUntil)[0];
              if (orphan) {
                setPendingConfirm({
                  type: 'freeSlot',
                  agent,
                  freeName: orphan.name,
                  freeLabel: orphan.name,
                });
              } else {
                showInfo(
                  t('aiAgents.agentSlotLimitTitle'),
                  t('aiAgents.agentSlotLimitDesc', { max: sharedSlotsMax }),
                );
              }
            } catch {
              showInfo(
                t('aiAgents.agentSlotLimitTitle'),
                t('aiAgents.agentSlotLimitDesc', { max: sharedSlotsMax }),
              );
            }
          } else {
            showInfo(
              t('aiAgents.agentSlotLimitTitle'),
              t('aiAgents.agentSlotLimitDesc', { max: sharedSlotsMax }),
            );
          }
        } else {
          showInfo(
            t('aiAgents.activateFailed'),
            isActivateMinBalanceError(e)
              ? t('aiAgents.activateMinBalance', {
                  min: AI_AGENT_LIMITS.minHlBalanceUsd,
                  found: String(e?.response?.data?.detail ?? '').match(/found \$([0-9.]+)/i)?.[1] ?? '—',
                })
              : String(e?.response?.data?.detail ?? e?.message ?? e),
          );
        }
      } finally {
        clearBusyIfCurrent();
      }
    },
    [
      getAccessToken,
      wallet,
      address,
      isExternal,
      agents,
      refresh,
      showInfo,
      t,
      findManualOpenConflict,
      isDemo,
      sharedSlotsFull,
      sharedSlotsUsed,
      sharedSlotsMax,
    ]
  );

  // Keep ref in sync — freeSlot confirm retries via this without stale closure.
  approveAndActivateRef.current = handleApproveAndActivate;

  // External wallets: returning from MetaMask/etc. often means the user just
  // signed. Refresh quietly so cards catch up if HL already applied the action.
  //
  // Do NOT bump `approveGenRef` here — that used to abort `raceWalletSignature`
  // ~4s after resume and surface "didn't catch the signature" even when the
  // user had approved. The WC promise must stay current so the signed payload
  // can still POST to HL (same class of bug as the seamless-setup modal
  // unmount). Button unlock remains the signature timeout (25s external).
  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = undefined;
      }
      if (
        !isExternal ||
        (!busyAgentId && !creating && !transferBusy) ||
        (prev !== 'background' && prev !== 'inactive') ||
        next !== 'active'
      ) {
        return;
      }
      resumeTimer = setTimeout(() => {
        resumeTimer = undefined;
        if (AppState.currentState !== 'active') return;
        void refresh({ silent: true }).catch(() => {
          // non-fatal — in-flight sign/recover paths also re-check HL
        });
      }, 1_500);
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => {
      if (resumeTimer) clearTimeout(resumeTimer);
      sub.remove();
    };
  }, [isExternal, busyAgentId, creating, transferBusy, refresh]);

  const startRename = useCallback((agent: AiAgentView) => {
    setRenamingAgentId(agent.id);
    setRenameDraft(agent.name);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingAgentId(null);
    setRenameDraft('');
  }, []);

  const commitRename = useCallback(
    async (agent: AiAgentView) => {
      const next = renameDraft.trim();
      if (!next) {
        showInfo(t('aiAgents.nameRequired'));
        return;
      }
      if (next === agent.name) {
        cancelRename();
        return;
      }
      const token = await getAccessToken();
      if (!token) return;
      setRenameSaving(true);
      try {
        const updated = await renameAiAgent(agent.id, next, token);
        setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, name: updated.name } : a)));
        cancelRename();
      } catch (e: any) {
        showInfo(t('aiAgents.renameFailed'),
          String(e?.response?.data?.detail ?? e?.message ?? e));
      } finally {
        setRenameSaving(false);
      }
    },
    [renameDraft, getAccessToken, cancelRename, t]
  );

  const loadDecisionsPage = useCallback(
    async (agent: AiAgentView, opts: { symbol: string; offset: number; append: boolean }) => {
      const token = await getAccessToken();
      if (!token) return;
      const page = await fetchAiAgentDecisionsPage(
        {
          agentId: agent.id,
          limit: DECISIONS_PAGE_SIZE,
          offset: opts.offset,
          ...(opts.symbol !== 'all' ? { symbol: opts.symbol } : {}),
        },
        token
      );
      setDecisionsByAgent((prev) => ({
        ...prev,
        [agent.id]: opts.append
          ? [...(prev[agent.id] ?? []), ...page.decisions]
          : page.decisions,
      }));
      setDecisionsHasMore((prev) => ({ ...prev, [agent.id]: page.hasMore }));
    },
    [getAccessToken]
  );

  const handleToggleDecisions = useCallback(
    async (agent: AiAgentView) => {
      if (expandedAgentId === agent.id) {
        setExpandedAgentId(null);
        return;
      }
      setExpandedAgentId(agent.id);
      if (decisionsByAgent[agent.id]) return;
      setLoadingDecisionsId(agent.id);
      try {
        const symbol = decisionsSymbolByAgent[agent.id] ?? 'all';
        await loadDecisionsPage(agent, { symbol, offset: 0, append: false });
      } catch {
        // non-fatal — empty state shown below
      } finally {
        setLoadingDecisionsId(null);
      }
    },
    [expandedAgentId, decisionsByAgent, decisionsSymbolByAgent, loadDecisionsPage]
  );

  const handleDecisionsSymbolFilter = useCallback(
    async (agent: AiAgentView, symbol: string) => {
      const current = decisionsSymbolByAgent[agent.id] ?? 'all';
      if (current === symbol && decisionsByAgent[agent.id]) return;
      setDecisionsSymbolByAgent((prev) => ({ ...prev, [agent.id]: symbol }));
      setLoadingDecisionsId(agent.id);
      try {
        await loadDecisionsPage(agent, { symbol, offset: 0, append: false });
      } catch {
        // keep previous list on failure
      } finally {
        setLoadingDecisionsId(null);
      }
    },
    [decisionsSymbolByAgent, decisionsByAgent, loadDecisionsPage]
  );

  const handleLoadMoreDecisions = useCallback(
    async (agent: AiAgentView) => {
      if (loadingMoreDecisionsId === agent.id) return;
      const existing = decisionsByAgent[agent.id] ?? [];
      const symbol = decisionsSymbolByAgent[agent.id] ?? 'all';
      setLoadingMoreDecisionsId(agent.id);
      try {
        await loadDecisionsPage(agent, {
          symbol,
          offset: existing.length,
          append: true,
        });
      } catch {
        // keep existing page
      } finally {
        setLoadingMoreDecisionsId(null);
      }
    },
    [decisionsByAgent, decisionsSymbolByAgent, loadingMoreDecisionsId, loadDecisionsPage]
  );

  const runControl = useCallback(
    async (agent: AiAgentView, action: 'stop' | 'resume' | 'toggleDryRun') => {
      if (action === 'resume' && isDemo) {
        showInfo(
          t('aiAgents.demoActivateBlockedTitle'),
          t('aiAgents.demoActivateBlockedDesc'),
        );
        return;
      }
      const token = await getAccessToken();
      if (!token) return;
      setBusyAgentId(agent.id);
      setBusyAction(action === 'toggleDryRun' ? null : action);
      try {
        if (action === 'stop') await stopAiAgent(agent.id, token);
        else if (action === 'resume') await activateAiAgent(agent.id, token);
        else await setAiAgentDryRun(agent.id, !agent.dryRun, token);
        await refresh({ silent: true });
      } catch (e: any) {
        showInfo(
          t('aiAgents.actionFailed'),
          isActivateMinBalanceError(e)
            ? t('aiAgents.activateMinBalance', {
                min: AI_AGENT_LIMITS.minHlBalanceUsd,
                found: String(e?.response?.data?.detail ?? '').match(/found \$([0-9.]+)/i)?.[1] ?? '—',
              })
            : String(e?.response?.data?.detail ?? e?.message ?? e),
        );
      } finally {
        setBusyAgentId(null);
        setBusyAction(null);
      }
    },
    [getAccessToken, refresh, showInfo, t, isDemo]
  );

  const executePendingConfirm = useCallback(async () => {
    if (!pendingConfirm) return;
    const pending = pendingConfirm;
    setPendingConfirm(null);

    switch (pending.type) {
      case 'create':
        await handleCreate();
        return;
      case 'save':
        await handleSaveDraft();
        return;
      case 'activate':
        await handleApproveAndActivate(pending.agent);
        return;
      case 'stop':
        await runControl(pending.agent, 'stop');
        return;
      case 'resume':
        await runControl(pending.agent, 'resume');
        return;
      case 'freeSlot': {
        const { agent, freeName, freeDbId } = pending;
        if (!wallet || !address) {
          showInfo(t('aiAgents.walletNotReady'));
          return;
        }
        const gen = ++approveGenRef.current;
        const stillCurrent = () => approveGenRef.current === gen;
        setBusyAgentId(agent.id);
        setBusyAction('activate');
        const clearBusyIfCurrent = () => {
          if (stillCurrent()) {
            setBusyAgentId(null);
            setBusyAction(null);
          }
        };
        const signTimeoutMs = 90_000;
        try {
          // Slot already free on HL (prior attempt signed while we were away)?
          if (freeDbId) {
            try {
              const extras = await listHlExtraAgents(address as `0x${string}`);
              if (!extras.some((x) => x.name === freeName)) {
                const token2 = await getAccessToken();
                if (token2) {
                  try {
                    await revokeAiAgent(freeDbId, token2);
                  } catch {
                    // best-effort
                  }
                }
                if (!stillCurrent()) return;
                await refresh({ silent: true });
                await approveAndActivateRef.current(agent);
                return;
              }
            } catch {
              // proceed to on-chain revoke
            }
          }
          if (!stillCurrent()) return;
          const walletProvider = await wallet.getProvider();
          if (!stillCurrent()) return;
          await withExternalWalletSign(
            () =>
              revokeNamedAgent({
                userWalletProvider: walletProvider,
                userAddress: address as `0x${string}`,
                agentName: freeName,
              }),
            { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
          );
          if (!stillCurrent()) return;
          if (freeDbId) {
            const token2 = await getAccessToken();
            if (token2) {
              try {
                await revokeAiAgent(freeDbId, token2);
              } catch {
                // Slot already freed on-chain; DB revoke is best-effort.
              }
            }
          }
          await refresh({ silent: true });
          await approveAndActivateRef.current(agent);
        } catch (e: any) {
          if (!stillCurrent()) return;
          const msg = String(e?.message ?? '');
          if (isWalletSignatureRejected(e)) {
            showInfo(t('aiAgents.approveRejectedTitle'), t('aiAgents.approveRejected'));
          } else if (isHlSigningChainError(e)) {
            showInfo(t('aiAgents.approveChainSwitchTitle'), t('aiAgents.approveChainSwitch'));
          } else if (msg === '__approve_timeout__' || msg === '__approve_aborted__' || isTransientNetworkError(e)) {
            // Signed while away? If the slot is already free on HL, continue.
            try {
              const extras = await listHlExtraAgents(address as `0x${string}`);
              const stillThere = extras.some((x) => x.name === freeName);
              if (!stillThere) {
                if (freeDbId) {
                  const token2 = await getAccessToken();
                  if (token2) {
                    try {
                      await revokeAiAgent(freeDbId, token2);
                    } catch {
                      // best-effort
                    }
                  }
                }
                await refresh({ silent: true });
                await approveAndActivateRef.current(agent);
                return;
              }
            } catch {
              // fall through
            }
            showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.revokeTimeout'));
          } else {
            showInfo(
              t('aiAgents.activateFailed'),
              String(e?.response?.data?.detail ?? e?.message ?? e)
            );
          }
        } finally {
          clearBusyIfCurrent();
        }
        return;
      }
      case 'revoke': {
        const agent = pending.agent;
        const token = await getAccessToken();
        if (!token || !wallet || !address) return;
        const gen = ++approveGenRef.current;
        const stillCurrent = () => approveGenRef.current === gen;
        setBusyAgentId(agent.id);
        setBusyAction('revoke');
        const clearBusyIfCurrent = () => {
          if (stillCurrent()) {
            setBusyAgentId(null);
            setBusyAction(null);
          }
        };
        const signTimeoutMs = 90_000;
        const hlArgs = {
          userAddress: address as `0x${string}`,
          agentName: agent.hlAgentName,
          agentAddress: agent.hlAgentAddress,
        };

        const syncDbRevoke = async () => {
          // Backend call can also blip on resume — retry once.
          try {
            await revokeAiAgent(agent.id, token);
          } catch (e) {
            if (!isTransientNetworkError(e)) throw e;
            await new Promise((r) => setTimeout(r, 1_000));
            await revokeAiAgent(agent.id, token);
          }
          await refresh({ silent: true });
        };

        /** Prefer verifying HL + syncing DB over surfacing a resume network blip. */
        const recoverIfCleared = async (): Promise<boolean> => {
          const cleared = await pollNamedAgentClearedOnHl(hlArgs);
          if (cleared === true) {
            try {
              await syncDbRevoke();
              return true;
            } catch {
              // On-chain done; refresh may still show old status — next load heals.
              try {
                await refresh({ silent: true });
              } catch {
                // ignore
              }
              return true;
            }
          }
          return false;
        };

        try {
          // Already cleared on HL from a prior wallet sign? Just sync DB — no new prompt.
          try {
            const stillApproved = await isNamedAgentStillApprovedOnHl(hlArgs);
            if (!stillApproved) {
              await syncDbRevoke();
              return;
            }
          } catch {
            // HL info blip / rate limit — poll before opening another wallet prompt.
            if (await recoverIfCleared()) return;
          }
          if (!stillCurrent()) return;

          const walletProvider = await wallet.getProvider();
          if (!stillCurrent()) return;
          await withExternalWalletSign(
            () =>
              revokeNamedAgent({
                userWalletProvider: walletProvider,
                userAddress: address as `0x${string}`,
                agentName: agent.hlAgentName,
              }),
            { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
          );
          if (!stillCurrent()) {
            await recoverIfCleared();
            return;
          }
          try {
            await syncDbRevoke();
          } catch (syncErr) {
            // Signature + HL submit may have landed; don't fail hard on API blip.
            if (await recoverIfCleared()) return;
            throw syncErr;
          }
        } catch (e: any) {
          if (!stillCurrent()) {
            await recoverIfCleared();
            return;
          }
          const msg = String(e?.message ?? '');
          if (isWalletSignatureRejected(e)) {
            showInfo(t('aiAgents.approveRejectedTitle'), t('aiAgents.revokeRejected'));
          } else if (isHlSigningChainError(e)) {
            showInfo(t('aiAgents.approveChainSwitchTitle'), t('aiAgents.approveChainSwitch'));
          } else if (
            msg === '__approve_timeout__' ||
            msg === '__approve_aborted__' ||
            isTransientNetworkError(e) ||
            isActivateVerifyRetryableError(e)
          ) {
            if (await recoverIfCleared()) return;
            showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.revokeTimeout'));
          } else {
            const detail = String(e?.response?.data?.detail ?? e?.message ?? e);
            if (/open positions/i.test(detail)) {
              showInfo(
                t('aiAgents.revokeConfirmTitle', 'Revoke this agent?'),
                t('aiAgents.revokeHasOpen'),
              );
              return;
            }
            if (await recoverIfCleared()) return;
            showInfo(
              t('aiAgents.revokeFailed', 'Revoke incomplete'),
              t('aiAgents.revokeFailedDesc') + `\n\n${detail}`
            );
          }
        } finally {
          clearBusyIfCurrent();
        }
        return;
      }
      case 'delete': {
        const agent = pending.agent;
        const token = await getAccessToken();
        if (!token) return;
        const gen = ++approveGenRef.current;
        const stillCurrent = () => approveGenRef.current === gen;
        setBusyAgentId(agent.id);
        setBusyAction('delete');
        const clearBusyIfCurrent = () => {
          if (stillCurrent()) {
            setBusyAgentId(null);
            setBusyAction(null);
          }
        };
        const signTimeoutMs = 90_000;
        try {
          // Non-draft / non-revoked agents that still hold an on-chain approval
          // must free that slot before the DB row disappears. Already-revoked
          // agents skip this — permission was cleared when they were revoked.
          if (agent.status !== 'draft' && agent.status !== 'revoked') {
            if (!wallet || !address) {
              showInfo(t('aiAgents.walletNotReady'));
              return;
            }
            let stillApproved = true;
            try {
              stillApproved = await isNamedAgentStillApprovedOnHl({
                userAddress: address as `0x${string}`,
                agentName: agent.hlAgentName,
                agentAddress: agent.hlAgentAddress,
              });
            } catch {
              stillApproved = true;
            }
            if (stillApproved) {
              if (!stillCurrent()) return;
              const walletProvider = await wallet.getProvider();
              if (!stillCurrent()) return;
              const hlArgs = {
                userAddress: address as `0x${string}`,
                agentName: agent.hlAgentName,
                agentAddress: agent.hlAgentAddress,
              };
              try {
                await withExternalWalletSign(
                  () =>
                    revokeNamedAgent({
                      userWalletProvider: walletProvider,
                      userAddress: address as `0x${string}`,
                      agentName: agent.hlAgentName,
                    }),
                  { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
                );
              } catch (revokeErr) {
                if (isWalletSignatureRejected(revokeErr)) throw revokeErr;
                const cleared = await pollNamedAgentClearedOnHl(hlArgs);
                if (cleared !== true) throw revokeErr;
              }
              if (!stillCurrent()) return;
              try {
                await revokeAiAgent(agent.id, token);
              } catch {
                // On-chain slot already freed; DB status update is best-effort.
              }
            }
          }

          // Dedicated USDC stays on the sub until the user Transfers it out
          // (backend 409 if ≥ $1 remains). Do not auto-reclaim on delete.
          if (!stillCurrent()) return;
          await deleteAiAgent(agent.id, token);
          await refresh({ silent: true });
        } catch (e: any) {
          if (!stillCurrent()) return;
          const msg = String(e?.message ?? '');
          if (isWalletSignatureRejected(e)) {
            showInfo(t('aiAgents.approveRejectedTitle'), t('aiAgents.deleteRevokeRejected'));
          } else if (isHlSigningChainError(e)) {
            showInfo(t('aiAgents.approveChainSwitchTitle'), t('aiAgents.approveChainSwitch'));
          } else if (msg === '__approve_timeout__' || msg === '__approve_aborted__') {
            showInfo(t('aiAgents.approveTimeoutTitle'), t('aiAgents.revokeTimeout'));
          } else {
            const detail = String(e?.response?.data?.detail ?? e?.message ?? e);
            showInfo(
              t('aiAgents.deleteFailed', 'Could not delete'),
              /open positions/i.test(detail)
                ? t('aiAgents.deleteHasOpen')
                : /still holds|dedicated account/i.test(detail)
                  ? t('aiAgents.deleteHasBalance')
                  : /revoke.*before deleting|trading permission/i.test(detail)
                    ? t('aiAgents.deleteNeedsRevoke')
                    : detail
            );
          }
        } finally {
          clearBusyIfCurrent();
        }
        return;
      }
      default:
        return;
    }
  }, [
    pendingConfirm,
    handleCreate,
    handleSaveDraft,
    handleApproveAndActivate,
    runControl,
    getAccessToken,
    wallet,
    address,
    isExternal,
    refresh,
    showInfo,
    t,
  ]);

  const persistRestingDismiss = useCallback(async (key: 'shared' | 'dedicated' | undefined) => {
    if (!key) return;
    if (key === 'shared') {
      await setRestingLimitSharedWarnDismissed();
      setRestingSharedDismissed(true);
      return;
    }
    await setRestingLimitDedicatedFundWarnDismissed();
    setRestingDedicatedDismissed(true);
  }, []);

  const confirmMeta = useMemo((): {
    title: string;
    message: string;
    confirmLabel?: string;
    showDontAskAgain?: boolean;
    dismissKey?: 'shared' | 'dedicated';
  } | null => {
    if (!pendingConfirm) return null;
    const nextCycle = formatNextHourlyCycle();
    const { type } = pendingConfirm;
    const continueLabel = t('aiAgents.sharedTradeWarnContinue');
    switch (type) {
      case 'create': {
        const masterHasOpenPositions =
          (masterTradingState?.perpPositionsCount ?? 0) > 0 ||
          (masterTradingState?.positions?.some((p) => Math.abs(Number(p.szi)) > 0) ?? false) ||
          (masterTradingState?.totalCrossInitialMarginUsedUsd ?? 0) > 0 ||
          (masterTradingState?.totalIsolatedMarginUsedUsd ?? 0) > 0;
        const parts = [t('aiAgents.createConfirmDesc', { time: nextCycle })];
        let showDontAskAgain = false;
        let dismissKey: 'shared' | 'dedicated' | undefined;
        if (dedicatedMode && DEDICATED_MODE_ENABLED) {
          if (masterHasOpenPositions) {
            parts.push(t('aiAgents.createConfirmDedicatedMarginWarning'));
          }
          if (masterHasRestingLimits && !restingDedicatedDismissed) {
            parts.push(t('aiAgents.restingLimitDedicatedWarn'));
            showDontAskAgain = true;
            dismissKey = 'dedicated';
          }
        } else {
          const resting = findRestingLimitConflict(symbols, { dedicated: false });
          if (resting && !restingSharedDismissed) {
            parts.push(t('aiAgents.restingLimitSharedWarn', { symbol: displaySymbol(resting) }));
            showDontAskAgain = true;
            dismissKey = 'shared';
          }
        }
        return {
          title: t('aiAgents.createConfirmTitle'),
          message: parts.join('\n\n'),
          confirmLabel: showDontAskAgain ? continueLabel : undefined,
          showDontAskAgain,
          dismissKey,
        };
      }
      case 'save': {
        const resting = findRestingLimitConflict(symbols, {
          dedicated: dedicatedMode && DEDICATED_MODE_ENABLED,
        });
        const showDontAskAgain = Boolean(resting && !restingSharedDismissed);
        return {
          title: t('aiAgents.saveConfirmTitle'),
          message: showDontAskAgain
            ? `${t('aiAgents.saveConfirmDesc')}\n\n${t('aiAgents.restingLimitSharedWarn', {
                symbol: displaySymbol(resting!),
              })}`
            : t('aiAgents.saveConfirmDesc'),
          confirmLabel: showDontAskAgain ? continueLabel : undefined,
          showDontAskAgain,
          dismissKey: showDontAskAgain ? ('shared' as const) : undefined,
        };
      }
      case 'activate': {
        const agent = pendingConfirm.agent;
        const dedicated = agent.mode === 'dedicated';
        const resting = findRestingLimitConflict(agent.config.symbols ?? [], { dedicated });
        const showDontAskAgain = Boolean(!dedicated && resting && !restingSharedDismissed);
        const base = t('aiAgents.activateConfirmDesc', { time: nextCycle });
        return {
          title: t('aiAgents.activateConfirmTitle'),
          message: showDontAskAgain
            ? `${base}\n\n${t('aiAgents.restingLimitSharedWarn', { symbol: displaySymbol(resting!) })}`
            : base,
          confirmLabel: showDontAskAgain ? continueLabel : undefined,
          showDontAskAgain,
          dismissKey: showDontAskAgain ? ('shared' as const) : undefined,
        };
      }
      case 'stop':
        return {
          title: t('aiAgents.stopConfirmTitle', 'Stop this agent?'),
          message: t('aiAgents.stopConfirmDesc'),
          confirmLabel: undefined as string | undefined,
        };
      case 'resume':
        return {
          title: t('aiAgents.resumeConfirmTitle', 'Resume this agent?'),
          message: t('aiAgents.resumeConfirmDesc', { time: nextCycle }),
          confirmLabel: undefined as string | undefined,
        };
      case 'revoke':
        return {
          title: t('aiAgents.revokeConfirmTitle', 'Revoke this agent?'),
          message: t('aiAgents.revokeConfirmDesc'),
          confirmLabel: undefined as string | undefined,
        };
      case 'freeSlot':
        return {
          title: t('aiAgents.agentSlotLimitTitle'),
          message: pendingConfirm.freeDbId
            ? t('aiAgents.agentSlotLimitFreeDesc', {
                name: pendingConfirm.freeLabel,
                max: sharedSlotsMax,
              })
            : t('aiAgents.agentSlotLimitOrphanDesc'),
          confirmLabel: t('aiAgents.agentSlotLimitFreeAction'),
        };
      case 'delete': {
        const agent = pendingConfirm.agent;
        const dedicated = agent.mode === 'dedicated' && !!agent.hlSubaccountAddress;
        const needsRevoke = agent.status !== 'draft' && agent.status !== 'revoked';
        let message: string;
        if (agent.status === 'revoked') {
          message = t('aiAgents.deleteRevokedConfirmDesc');
        } else if (dedicated && needsRevoke) {
          message = t('aiAgents.deleteRevokeDedicatedConfirmDesc');
        } else if (dedicated) {
          message = t('aiAgents.deleteDedicatedConfirmDesc');
        } else if (needsRevoke) {
          message = t('aiAgents.deleteRevokeConfirmDesc');
        } else {
          message = t('aiAgents.deleteConfirmDesc');
        }
        return {
          title: t('aiAgents.deleteConfirmTitle', 'Delete this agent?'),
          message,
          confirmLabel: undefined as string | undefined,
        };
      }
      default:
        return null;
    }
  }, [
    pendingConfirm,
    t,
    dedicatedMode,
    masterTradingState,
    masterHasRestingLimits,
    findRestingLimitConflict,
    symbols,
    restingSharedDismissed,
    restingDedicatedDismissed,
  ]);

  const confirmPendingWithDismiss = useCallback(async () => {
    if (confirmDontAskAgain && confirmMeta?.dismissKey) {
      await persistRestingDismiss(confirmMeta.dismissKey);
    }
    await executePendingConfirm();
  }, [confirmDontAskAgain, confirmMeta?.dismissKey, persistRestingDismiss, executePendingConfirm]);

  const leverageCap = useMemo(
    () => resolveLeverageCapForSymbols(symbols, selectableAssets),
    [symbols, selectableAssets]
  );

  const leverageNum = Number(leverageText);
  const budgetNum = Number(budgetText);
  const fundingNum = Number(fundingText);
  const maxPositionNum = maxPositionText.trim() ? Number(maxPositionText) : undefined;
  const notionalCeilingNum = budgetNum;
  const fundingNeededForFullNotional =
    Number.isFinite(budgetNum) &&
    budgetNum > 0 &&
    Number.isFinite(leverageNum) &&
    leverageNum >= 1
      ? budgetNum / leverageNum
      : null;
  const fundingThin =
    DEDICATED_MODE_ENABLED &&
    dedicatedMode &&
    !fundingAlreadySent &&
    fundingText.trim().length > 0 &&
    Number.isFinite(fundingNum) &&
    fundingNeededForFullNotional != null &&
    fundingNum + 1e-9 < fundingNeededForFullNotional;

  // Inline capital validation (only once the user has typed something).
  const budgetTooLow =
    budgetText.trim().length > 0 &&
    Number.isFinite(budgetNum) &&
    budgetNum < AI_AGENT_LIMITS.minCapitalUsd;
  const budgetTooHigh =
    budgetText.trim().length > 0 &&
    Number.isFinite(budgetNum) &&
    budgetNum > AI_AGENT_LIMITS.maxCapitalUsd;
  const budgetInvalid =
    budgetText.trim().length > 0 &&
    (!Number.isFinite(budgetNum) || budgetTooLow || budgetTooHigh);
  const fundingInvalid =
    DEDICATED_MODE_ENABLED &&
    dedicatedMode &&
    !fundingAlreadySent &&
    fundingText.trim().length > 0 &&
    (!Number.isFinite(fundingNum) ||
      fundingNum < AI_AGENT_LIMITS.minCapitalUsd ||
      fundingNum > AI_AGENT_LIMITS.maxCapitalUsd);

  const leverageInvalid =
    leverageText.trim().length > 0 &&
    (!Number.isFinite(leverageNum) ||
      leverageNum < 1 ||
      leverageNum > leverageCap.max);

  const leverageClamp = useMemo(() => {
    if (!Number.isFinite(leverageNum) || leverageNum < 1 || leverageInvalid) {
      return { parts: [] as string[], extra: 0 };
    }
    return leverageClampDetails(leverageCap.bySymbol, leverageNum);
  }, [leverageCap.bySymbol, leverageNum, leverageInvalid]);

  const maxPositionInvalid =
    AI_AGENT_SHOW_PER_POSITION_CAP &&
    maxPositionText.trim().length > 0 &&
    (!Number.isFinite(maxPositionNum!) ||
      maxPositionNum! < AI_AGENT_LIMITS.minPositionUsd ||
      (Number.isFinite(notionalCeilingNum) &&
        notionalCeilingNum > 0 &&
        maxPositionNum! > notionalCeilingNum));

  const coinglassOk =
    cgGlobalMode ||
    (isEditingDraft && !coinglassReplaceMode
      ? true
      : coinglassKey.trim().length > 0);
  const canCreate =
    name.trim().length > 0 &&
    symbols.length > 0 &&
    budgetText.trim().length > 0 &&
    !budgetInvalid &&
    leverageText.trim().length > 0 &&
    !leverageInvalid &&
    !maxPositionInvalid &&
    coinglassOk &&
    (!(DEDICATED_MODE_ENABLED && dedicatedMode && !fundingAlreadySent) ||
      (fundingText.trim().length > 0 && !fundingInvalid));

  const statusRank = (s: AiAgentView['status']) => {
    // Stop/pause stay with active so the card does not drop. Only revoke sinks.
    if (s === 'active' || s === 'paused' || s === 'stopped') return 0;
    if (s === 'draft') return 1;
    if (s === 'revoked') return 2;
    return 3;
  };

  const sortedAgents = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const byStatus = statusRank(a.status) - statusRank(b.status);
        if (byStatus !== 0) return byStatus;
        return a.createdAt < b.createdAt ? 1 : -1;
      }),
    [agents]
  );

  const filterSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) {
      for (const s of a.config.symbols ?? []) set.add(s.toUpperCase());
    }
    return [...set].sort();
  }, [agents]);

  const filteredAgents = useMemo(() => {
    return sortedAgents.filter((a) => {
      if (statusFilter === 'active' && a.status !== 'active') return false;
      if (statusFilter === 'draft' && a.status !== 'draft') return false;
      if (statusFilter === 'revoked' && a.status !== 'revoked') return false;
      if (
        statusFilter === 'stopped' &&
        a.status !== 'stopped' &&
        a.status !== 'paused'
      ) {
        return false;
      }
      if (modeFilter === 'shared' && a.mode === 'dedicated') return false;
      if (modeFilter === 'dedicated' && a.mode !== 'dedicated') return false;
      if (symbolFilter !== 'all' && !(a.config.symbols ?? []).map((s) => s.toUpperCase()).includes(symbolFilter)) {
        return false;
      }
      return true;
    });
  }, [sortedAgents, statusFilter, modeFilter, symbolFilter]);

  useEffect(() => {
    setAgentListVisibleCount(5);
  }, [statusFilter, modeFilter, symbolFilter]);

  const visibleAgents = useMemo(
    () => filteredAgents.slice(0, agentListVisibleCount),
    [filteredAgents, agentListVisibleCount],
  );
  const hasMoreAgents = filteredAgents.length > visibleAgents.length;

  const hasRevokedAgents = agents.some((a) => a.status === 'revoked');
  const showModeFilter =
    agents.some((a) => a.mode === 'dedicated') && agents.some((a) => a.mode !== 'dedicated');
  const showFilters = !showCreate && agents.length >= 2;

  useEffect(() => {
    if (!showModeFilter && modeFilter !== 'all') setModeFilter('all');
  }, [showModeFilter, modeFilter]);

  const {
    data: agentStats = {},
    isPending: agentStatsPending,
    isFetched: agentStatsFetched,
  } = useQuery({
    queryKey: ['ai-agent-stats'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return {} as Record<string, AiAgentStats>;
      return fetchAiAgentStats(token);
    },
    enabled: isAuthenticated && agents.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Include draft + revoked: USDC is sent at create, so the card should show
  // the dedicated balance before activate. Transfer still needs live balances.
  const dedicatedForHl = useMemo(
    () =>
      agents.filter(
        (a) => a.mode === 'dedicated' && a.hlSubaccountAddress,
      ),
    [agents]
  );

  const {
    data: openAiPositions = [],
    isPending: openPositionsPending,
    isSuccess: openPositionsReady,
  } = useQuery({
    queryKey: ['ai-agent-positions'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [] as AiAgentPosition[];
      return fetchAiAgentPositions(token);
    },
    enabled: isAuthenticated && agents.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const hlSummaryQueries = useQueries({
    queries: dedicatedForHl.map((agent) => ({
      queryKey: ['ai-agent-hl-summary', agent.id, agent.hlSubaccountAddress],
      queryFn: () => getUserPortfolioSummary(agent.hlSubaccountAddress as `0x${string}`),
      enabled: Boolean(agent.hlSubaccountAddress),
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: 1,
    })),
  });

  const hasSharedAgents = agents.some((a) => a.mode !== 'dedicated');
  const {
    data: masterFillsReplay,
    isPending: masterFillsPending,
    isError: masterFillsError,
    isFetched: masterFillsFetched,
  } = useQuery({
    queryKey: ['hl_user_fills_replay', tradingEnv, address],
    queryFn: () => getUserFillsReplay(address as `0x${string}`),
    enabled: Boolean(address) && isAuthenticated && hasSharedAgents,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  const dedicatedFillsQueries = useQueries({
    queries: dedicatedForHl.map((agent) => ({
      queryKey: ['hl_user_fills_replay', tradingEnv, agent.hlSubaccountAddress],
      queryFn: () => getUserFillsReplay(agent.hlSubaccountAddress as `0x${string}`),
      enabled: Boolean(agent.hlSubaccountAddress),
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: 1,
    })),
  });

  const bookWinRateByAgentId = useMemo(() => {
    const map: Record<string, number | null> = {};
    dedicatedForHl.forEach((agent, idx) => {
      const fills = dedicatedFillsQueries[idx]?.data;
      if (!Array.isArray(fills)) return;
      map[agent.id] = roundTripWinRate(fills).winRatePct;
    });
    if (Array.isArray(masterFillsReplay)) {
      for (const agent of agents) {
        if (agent.mode === 'dedicated') continue;
        map[agent.id] = roundTripWinRate(
          masterFillsReplay,
          agent.config.symbols ?? [],
        ).winRatePct;
      }
    }
    return map;
  }, [agents, dedicatedForHl, dedicatedFillsQueries, masterFillsReplay]);

  const dedicatedStateQueries = useQueries({
    queries: dedicatedForHl.map((agent) => ({
      queryKey: ['hl_trading_state', tradingEnv, agent.hlSubaccountAddress],
      queryFn: () => getHyperliquidTradingState(agent.hlSubaccountAddress as `0x${string}`),
      enabled: Boolean(agent.hlSubaccountAddress),
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: 1,
      placeholderData: keepPreviousData,
    })),
  });

  const hlSummaryByAgentId = useMemo(() => {
    const map: Record<string, UserPortfolioSummary> = {};
    dedicatedForHl.forEach((agent, idx) => {
      const summary = hlSummaryQueries[idx]?.data;
      if (summary) map[agent.id] = summary;
    });
    return map;
  }, [dedicatedForHl, hlSummaryQueries]);

  const dedicatedStateByAgentId = useMemo(() => {
    const map: Record<string, HyperliquidTradingState> = {};
    dedicatedForHl.forEach((agent, idx) => {
      const state = dedicatedStateQueries[idx]?.data;
      if (state) map[agent.id] = state;
    });
    return map;
  }, [dedicatedForHl, dedicatedStateQueries]);

  /** Last-known positive equity so a mid-refetch $0 snapshot doesn't flash. */
  const dedicatedBalanceByAgentId = useMemo(() => {
    const map: Record<string, number | null> = {};
    dedicatedForHl.forEach((agent, idx) => {
      const q = dedicatedStateQueries[idx];
      map[agent.id] = stickyDedicatedBalanceUsd({
        env: tradingEnv,
        address: agent.hlSubaccountAddress,
        state: q?.data,
        fetching: !!(q?.isFetching || q?.isPending || q?.isLoading),
      });
    });
    return map;
  }, [dedicatedForHl, dedicatedStateQueries, tradingEnv]);

  // Book often sees a new fill before /positions refetches. Hold sidelined
  // chips whenever the live symbol set drifts from the last synced key, and
  // refetch AI rows until they catch up (avoids "paused · manual" flash).
  const masterOpenKey = useMemo(
    () => [...masterOpenSymbols].sort().join(','),
    [masterOpenSymbols],
  );
  const dedicatedOpenKey = useMemo(
    () =>
      dedicatedForHl
        .map((a) => {
          const coins = [...liveOpenCoinSet(dedicatedStateByAgentId[a.id])].sort().join(',');
          return `${a.id}:${coins}`;
        })
        .join('|'),
    [dedicatedForHl, dedicatedStateByAgentId],
  );
  const bookOpenKey = `${masterOpenKey}#${dedicatedOpenKey}`;
  const [syncedBookOpenKey, setSyncedBookOpenKey] = useState<string | null>(null);
  const sidelineSyncHold =
    openPositionsReady && syncedBookOpenKey !== bookOpenKey;
  useEffect(() => {
    if (!openPositionsReady) return;
    if (syncedBookOpenKey === bookOpenKey) return;
    let cancelled = false;
    void queryClient
      .refetchQueries({ queryKey: ['ai-agent-positions'] })
      .finally(() => {
        if (!cancelled) setSyncedBookOpenKey(bookOpenKey);
      });
    return () => {
      cancelled = true;
    };
  }, [bookOpenKey, openPositionsReady, syncedBookOpenKey, queryClient]);

  const openSymbolsByAgentId = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const p of openAiPositions) {
      const aid = p.agentId;
      if (!map[aid]) map[aid] = [];
      map[aid].push(p.symbol.toUpperCase());
    }
    return map;
  }, [openAiPositions]);

  /**
   * Configured symbols the agent is sidelined on: live on its book (Main for
   * Shared, the agent's sub for Dedicated) but not this agent's OPEN row.
   * Wait until AI positions have loaded / finished syncing — otherwise a
   * just-filled AI coin briefly looks "manual" and the yellow paused chip
   * flashes until the next /positions poll.
   */
  const sidelinedSymbolsForAgent = useCallback(
    (agent: AiAgentView): string[] => {
      if (agent.status === 'draft' || agent.status === 'revoked') return [];
      if (!openPositionsReady || sidelineSyncHold) return [];
      const liveCoins =
        agent.mode === 'dedicated'
          ? liveOpenCoinSet(dedicatedStateByAgentId[agent.id])
          : masterOpenSymbols;
      if (liveCoins.size === 0) return [];
      const owned = new Set(
        (openSymbolsByAgentId[agent.id] ?? []).map((s) => s.toUpperCase()),
      );
      const out: string[] = [];
      for (const raw of agent.config.symbols ?? []) {
        const sym = raw.toUpperCase();
        if (liveCoins.has(sym) && !owned.has(sym)) out.push(sym);
      }
      return out;
    },
    [
      dedicatedStateByAgentId,
      masterOpenSymbols,
      openPositionsReady,
      sidelineSyncHold,
      openSymbolsByAgentId,
    ],
  );

  /** Fallback side for older monitor rows that omitted `direction`. */
  const openDirectionByAgentSymbol = useMemo(() => {
    const map = new Map<string, 'LONG' | 'SHORT'>();
    for (const p of openAiPositions) {
      map.set(`${p.agentId}:${p.symbol.toUpperCase()}`, p.direction);
    }
    return map;
  }, [openAiPositions]);

  /** Dedicated HL portfolio summary not in yet — keep Net PnL / volume on dots. */
  const isDedicatedHlSummaryPending = useCallback(
    (agent: AiAgentView) => {
      if (agent.mode !== 'dedicated' || !agent.hlSubaccountAddress) return false;
      if (hlSummaryByAgentId[agent.id]) return false;
      const idx = dedicatedForHl.findIndex((a) => a.id === agent.id);
      if (idx < 0) return true;
      const q = hlSummaryQueries[idx];
      if (q?.data) return false;
      if (q?.isFetching || q?.isPending || q?.isLoading) return true;
      if (q?.isError) return false;
      return true;
    },
    [dedicatedForHl, hlSummaryQueries, hlSummaryByAgentId],
  );

  /** Book fills not in yet — keep win rate on dots (DB win rate is agent-only). */
  const isBookFillsPending = useCallback(
    (agent: AiAgentView) => {
      if (agent.mode === 'dedicated') {
        if (!agent.hlSubaccountAddress) return false;
        if (Object.prototype.hasOwnProperty.call(bookWinRateByAgentId, agent.id)) return false;
        const idx = dedicatedForHl.findIndex((a) => a.id === agent.id);
        if (idx < 0) return true;
        const q = dedicatedFillsQueries[idx];
        if (Array.isArray(q?.data)) return false;
        if (q?.isFetching || q?.isPending || q?.isLoading) return true;
        if (q?.isError) return false;
        return true;
      }
      if (!hasSharedAgents) return false;
      if (Object.prototype.hasOwnProperty.call(bookWinRateByAgentId, agent.id)) return false;
      if (masterFillsError) return false;
      if (Array.isArray(masterFillsReplay)) return false;
      if (!masterFillsFetched && (masterFillsPending || !address)) return true;
      return masterFillsPending;
    },
    [
      bookWinRateByAgentId,
      dedicatedForHl,
      dedicatedFillsQueries,
      hasSharedAgents,
      masterFillsError,
      masterFillsFetched,
      masterFillsPending,
      masterFillsReplay,
      address,
    ],
  );

  /** Dedicated sub clearinghouse not in yet — keep the balance row on dots. */
  const isDedicatedHlStatePending = useCallback(
    (agent: AiAgentView) => {
      if (agent.mode !== 'dedicated' || !agent.hlSubaccountAddress) return false;
      const sticky = dedicatedBalanceByAgentId[agent.id];
      if (sticky != null && Number.isFinite(sticky) && sticky > 0.01) return false;
      if (dedicatedStateByAgentId[agent.id]) return false;
      const idx = dedicatedForHl.findIndex((a) => a.id === agent.id);
      if (idx < 0) return true;
      const q = dedicatedStateQueries[idx];
      // Keep dots while the first snapshot is in flight (including retries).
      // A failed empty query used to flip to "—" then jump to the real balance.
      if (q?.data) return false;
      if (q?.isFetching || q?.isPending || q?.isLoading) return true;
      if (q?.isError) return false;
      return true;
    },
    [dedicatedForHl, dedicatedStateQueries, dedicatedStateByAgentId, dedicatedBalanceByAgentId],
  );

  const isAgentPerfLoading = useCallback(
    (agent: AiAgentView) => {
      // Draft: funds sit on the sub — wait on that balance only.
      if (agent.status === 'draft') {
        return isDedicatedHlStatePending(agent);
      }
      if (agent.status === 'revoked') {
        return isDedicatedHlStatePending(agent) || isBookFillsPending(agent);
      }
      if (!agentStatsFetched || agentStatsPending || openPositionsPending) return true;
      if (isBookFillsPending(agent)) return true;
      if (agent.mode === 'dedicated') {
        if (isDedicatedHlSummaryPending(agent)) return true;
        const openSyms = openSymbolsByAgentId[agent.id] ?? [];
        if (openSyms.length === 0) return false;
        return isDedicatedHlStatePending(agent);
      }
      const openSyms = openSymbolsByAgentId[agent.id] ?? [];
      if (openSyms.length === 0) return false;
      // Copilot: wait for master clearinghouse so unrealized doesn't flash $0 → live.
      return masterStatePending && masterTradingState == null;
    },
    [
      agentStatsFetched,
      agentStatsPending,
      openPositionsPending,
      openSymbolsByAgentId,
      isBookFillsPending,
      isDedicatedHlSummaryPending,
      isDedicatedHlStatePending,
      masterStatePending,
      masterTradingState,
    ],
  );
  const { formatDisplayVolume, formatDisplayPrice } = useDisplayCurrency();

  const formatPnlValue = useCallback((n: number | null | undefined) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    // Sub-cent dust rounds to $0.00 — show plain zero, not "$0.00-" in red.
    if (Math.abs(n) < 0.005) return '$0.00';
    return `$${Math.abs(n).toFixed(2)}${n > 0 ? '+' : '-'}`;
  }, []);

  const formatVolumeValue = useCallback(
    (n: number | null | undefined) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—';
      return formatDisplayVolume(n);
    },
    [formatDisplayVolume]
  );

  const formatBalanceValue = useCallback(
    (n: number | null | undefined) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—';
      return formatDisplayPrice(n);
    },
    [formatDisplayPrice],
  );

  const masterTransferAvailableUsd = useMemo(() => {
    const s = masterTradingState;
    if (!s) return 0;
    const unified = Number(s.unifiedSpotTransferableUsd);
    if (Number.isFinite(unified) && unified > 0) return unified;
    const w = Number(s.withdrawableUsd);
    return Number.isFinite(w) ? Math.max(0, w) : 0;
  }, [masterTradingState]);

  const transferDedicatedAvailableUsd = useMemo(() => {
    if (!transferAgent?.id) return 0;
    const s = dedicatedStateByAgentId[transferAgent.id];
    if (!s) return 0;
    const unified = Number(s.unifiedSpotTransferableUsd);
    if (Number.isFinite(unified) && unified > 0) return unified;
    const w = Number(s.withdrawableUsd);
    return Number.isFinite(w) ? Math.max(0, w) : 0;
  }, [transferAgent, dedicatedStateByAgentId]);

  const handleDedicatedTransfer = useCallback(
    async (args: { direction: DedicatedTransferDirection; usd: number }) => {
      if (!transferAgent?.hlSubaccountAddress || !wallet || !address) {
        setTransferError(t('aiAgents.walletNotReady'));
        return;
      }
      const agentSnapshot = transferAgent;
      const equityBefore = Number(
        dedicatedStateByAgentId[agentSnapshot.id]?.accountValueUsd,
      );
      setTransferBusy(true);
      setTransferError(null);
      const signTimeoutMs = 90_000;
      const stillCurrent = () => true;
      try {
        const walletProvider = await wallet.getProvider();
        const sub = agentSnapshot.hlSubaccountAddress as `0x${string}`;
        const userAddress = address as `0x${string}`;
        await withExternalWalletSign(
          () =>
            ensureSubAccountUnified({
              userWalletProvider: walletProvider,
              userAddress,
              subAccountAddress: sub,
            }),
          { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
        );
        if (isExternal) await new Promise((r) => setTimeout(r, 1_200));
        await withExternalWalletSign(
          () =>
            transferUsdToSubAccount({
              userWalletProvider: walletProvider,
              userAddress,
              subAccountAddress: sub,
              usd: args.usd,
              isDeposit: args.direction === 'toDedicated',
            }),
          { timeoutMs: signTimeoutMs, isCurrent: stillCurrent },
        );

        // Immediate equity-floor pause (same $100 as activate / worker). Don't
        // wait for the hourly cycle — paused agents are excluded from LLM runs.
        let pausedLowEquity = false;
        if (agentSnapshot.status === 'active') {
          const floor = AI_AGENT_LIMITS.minHlBalanceUsd;
          let liveEquity: number | null = null;
          try {
            liveEquity = Number((await getHyperliquidTradingState(sub)).accountValueUsd);
          } catch {
            liveEquity = null;
          }
          const estimated = Number.isFinite(equityBefore)
            ? args.direction === 'toMain'
              ? equityBefore - args.usd
              : equityBefore + args.usd
            : null;
          const signals = [liveEquity, estimated].filter(
            (v): v is number => v != null && Number.isFinite(v),
          );
          // toMain: take the lower signal so a briefly-stale HL read can't skip pause.
          const equitySignal =
            signals.length === 0
              ? null
              : args.direction === 'toMain'
                ? Math.min(...signals)
                : Math.max(...signals);
          if (equitySignal != null && equitySignal < floor) {
            try {
              const token = await getAccessToken();
              if (token) {
                await pauseAiAgent(agentSnapshot.id, token);
                pausedLowEquity = true;
              }
            } catch {
              // Worker cycle still pauses; don't fail the transfer UX.
            }
          }
        }

        const amountLabel = args.usd.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 6,
        });
        pendingTransferInfoRef.current = {
          title: t('aiAgents.dedicatedTransferDone', { amount: amountLabel }),
          message: pausedLowEquity
            ? t('aiAgents.dedicatedTransferDonePaused', {
                min: AI_AGENT_LIMITS.minHlBalanceUsd,
              })
            : undefined,
        };
        // Close before balance refetch — otherwise available drops to $0 while the
        // sheet still shows the sent amount and flashes "insufficient".
        setTransferBusy(false);
        setTransferAgent(null);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ['hl_trading_state'] }),
          queryClient.invalidateQueries({ queryKey: ['ai-agent-hl-summary'] }),
          pausedLowEquity ? refresh({ silent: true }) : Promise.resolve(),
        ]);
      } catch (e: any) {
        const msg = String(e?.message ?? '');
        if (isWalletSignatureRejected(e)) {
          setTransferError(t('aiAgents.approveRejected'));
        } else if (isHlSigningChainError(e)) {
          setTransferError(t('aiAgents.approveChainSwitch'));
        } else if (msg === '__approve_pending__') {
          setTransferError(t('aiAgents.approvePendingRetry'));
        } else if (msg === '__approve_timeout__' || msg === '__approve_aborted__') {
          setTransferError(t('aiAgents.approveTimeout'));
        } else {
          setTransferError(String(e?.message ?? e ?? t('aiAgents.createFailed')));
        }
        setTransferBusy(false);
      }
    },
    [
      transferAgent,
      dedicatedStateByAgentId,
      wallet,
      address,
      isExternal,
      queryClient,
      getAccessToken,
      refresh,
      t,
    ],
  );

  const requestDedicatedTransfer = useCallback(
    async (args: { direction: DedicatedTransferDirection; usd: number }) => {
      if (
        args.direction === 'toDedicated' &&
        masterHasRestingLimits &&
        !restingDedicatedDismissed
      ) {
        setPendingFundWarnUsd(args.usd);
        return;
      }
      await handleDedicatedTransfer(args);
    },
    [handleDedicatedTransfer, masterHasRestingLimits, restingDedicatedDismissed],
  );

  const confirmDedicatedFundWarn = useCallback(async () => {
    const usd = pendingFundWarnUsd;
    setPendingFundWarnUsd(null);
    if (fundDontAskAgain) {
      await persistRestingDismiss('dedicated');
    }
    if (usd == null) return;
    await handleDedicatedTransfer({ direction: 'toDedicated', usd });
  }, [pendingFundWarnUsd, fundDontAskAgain, persistRestingDismiss, handleDedicatedTransfer]);

  const handleDedicatedTransferSheetClose = useCallback(() => {
    setTransferAgent(null);
    setTransferError(null);
    setTransferBusy(false);
    const info = pendingTransferInfoRef.current;
    pendingTransferInfoRef.current = null;
    if (!info) return;
    // Wait until the sheet Modal is gone so the toast isn't swallowed by the
    // native modal layer (same reason we used to defer BankConfirmModal).
    InteractionManager.runAfterInteractions(() => {
      if (info.message) {
        showToast(info.message, info.title, 'info', 5000);
      } else {
        showToast(info.title, undefined, 'copied');
      }
    });
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color={colors.text.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.headerCenter}>
          <Text style={styles.title} numberOfLines={1}>
            {t('aiAgents.title')}
          </Text>
          {authReady && isAuthenticated ? (
            <Text
              style={styles.slotsUsage}
              accessibilityRole="text"
              accessibilityLabel={
                dedicatedSlotsUnlocked
                  ? t('aiAgents.slotsUsageA11yDual', {
                      sharedUsed: sharedSlotsUsed,
                      sharedMax: sharedSlotsMax,
                      dedicatedUsed: dedicatedSlotsUsed,
                      dedicatedMax: dedicatedSlotsMax,
                    })
                  : t('aiAgents.slotsUsageA11y', {
                      used: sharedSlotsUsed,
                      max: sharedSlotsMax,
                      defaultValue: '{{used}} of {{max}} Shared agent slots used',
                    })
              }
            >
              {dedicatedSlotsUnlocked
                ? t('aiAgents.slotsUsageDual', {
                    sharedUsed: sharedSlotsUsed,
                    sharedMax: sharedSlotsMax,
                    dedicatedUsed: dedicatedSlotsUsed,
                    dedicatedMax: dedicatedSlotsMax,
                  })
                : t('aiAgents.slotsUsage', {
                    used: sharedSlotsUsed,
                    max: sharedSlotsMax,
                  })}
            </Text>
          ) : null}
        </View>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          <TouchableOpacity
            onPress={() => pushRouteOnce(router, '/ai-agents-faq' as Href)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('aiAgentsFaq.helpA11y')}
          >
            <Ionicons name="help-circle-outline" size={22} color={colors.text.primary} />
          </TouchableOpacity>
          {authReady && isAuthenticated ? (
            <TouchableOpacity
              onPress={() => {
                if (showCreate) closeForm();
                else openCreateForm();
              }}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={showCreate ? t('common.close', 'Close') : t('aiAgents.create')}
            >
              <Ionicons name={showCreate ? 'close' : 'add'} size={24} color={colors.text.primary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 80 + Math.max(0, insets.bottom) },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        bottomOffset={36}
        extraKeyboardSpace={Platform.OS === 'ios' ? 20 : 24}
      >
        {showCreate ? (
          <View style={styles.card}>
            {/* <Text style={styles.cardTitle}>
              {isEditingDraft ? t('aiAgents.editTitle') : t('aiAgents.create')}
            </Text> */}
            <FieldLabel label={t('aiAgents.agentNameLabel')} required />
            <TextInput
              style={[styles.input, styles.nameInput]}
              value={name}
              onChangeText={setName}
              placeholder={t('aiAgents.namePlaceholder')}
              placeholderTextColor={colors.text.muted}
            />

            {/* ── Assets: search + confirm-by-tap, selected shown as chips ── */}
            <FieldLabel label={t('aiAgents.assetsLabel')} required />
            {symbols.length ? (
              <View style={styles.chipsRow}>
                {symbols.map((s) => {
                  const conflict =
                    !(DEDICATED_MODE_ENABLED && dedicatedMode) && masterOpenSymbols.has(s);
                  return (
                  <TouchableOpacity
                    key={s}
                    style={[styles.chip, conflict ? styles.chipConflict : null]}
                    onPress={() => {
                      if (conflict) {
                        showInfo(
                          t('aiAgents.symbolManualOpenTitle'),
                          t('aiAgents.symbolManualOpenDesc', { symbol: displaySymbol(s) }),
                        );
                      }
                      setSymbols((prev) => prev.filter((x) => x !== s));
                    }}
                  >
                    <Text style={styles.chipText}>{displaySymbol(s)}</Text>
                    <Ionicons name="close" size={12} color={colors.background.primary} />
                  </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
            {selectedHasRestingLimits ? (
              <Text style={styles.hint}>{t('aiAgents.restingLimitSharedHint')}</Text>
            ) : null}
            {symbols.length < AI_AGENT_LIMITS.maxSymbols ? (
              <TextInput
                style={styles.input}
                value={symbolQuery}
                onChangeText={setSymbolQuery}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder={t('aiAgents.searchAsset')}
                placeholderTextColor={colors.text.muted}
              />
            ) : null}
            {symbolSuggestions.map((a) => {
              const coin = a.coin.toUpperCase();
              const takenBy = !dedicatedMode ? copilotTakenSymbols.get(coin) : undefined;
              const manualOpen =
                !takenBy &&
                !(DEDICATED_MODE_ENABLED && dedicatedMode) &&
                masterOpenSymbols.has(coin);
              const blocked = !!takenBy || manualOpen;
              return (
              <TouchableOpacity
                key={a.coin}
                style={[styles.suggestionRow, blocked ? styles.suggestionRowDisabled : null]}
                disabled={blocked}
                onPress={() => {
                  if (takenBy) {
                    showInfo(
                      t('aiAgents.symbolOverlapTitle'),
                      t('aiAgents.symbolOverlapDesc', { symbol: displaySymbol(coin), name: takenBy }),
                    );
                    return;
                  }
                  if (manualOpen) {
                    showInfo(
                      t('aiAgents.symbolManualOpenTitle'),
                      t('aiAgents.symbolManualOpenDesc', { symbol: displaySymbol(coin) }),
                    );
                    return;
                  }
                  setSymbols((prev) => [...prev, coin]);
                  setSymbolQuery('');
                }}
              >
                <Text style={[styles.suggestionSymbol, blocked ? styles.suggestionMuted : null]}>{displaySymbol(a.coin)}</Text>
                <Text style={[styles.suggestionName, blocked ? styles.suggestionMuted : null]} numberOfLines={1}>
                  {takenBy
                    ? t('aiAgents.symbolTakenBy', { name: takenBy })
                    : manualOpen
                      ? t('aiAgents.symbolManualOpenHint')
                      : a.name}
                </Text>
                <Text style={[styles.suggestionLev, blocked ? styles.suggestionMuted : null]}>{a.maxLeverage}x</Text>
                <Ionicons
                  name={blocked ? 'lock-closed-outline' : 'add-circle-outline'}
                  size={16}
                  color={blocked ? colors.text.muted : colors.accent.gold}
                />
              </TouchableOpacity>
              );
            })}
            {symbolQuery.trim() && !symbolSuggestions.length ? (
              <Text style={styles.hint}>
                {t('aiAgents.noAssetMatch')}
              </Text>
            ) : null}
            {/* ── Model (house keys; single pick) ── */}
            <FieldLabel label={t('aiAgents.modelLabel')} required />
            <View style={styles.pillsWrap}>
              {MODEL_OPTIONS.map((m, idx) => {
                const unavailable = !!m.unavailable;
                const active = modelIdx === idx && !unavailable;
                return (
                  <TouchableOpacity
                    key={m.choice.provider}
                    style={[
                      styles.pill,
                      styles.modelPill,
                      active && styles.pillActive,
                      unavailable && styles.pillDisabled,
                    ]}
                    onPress={() => {
                      if (!unavailable) setModelIdx(idx);
                    }}
                    disabled={unavailable}
                    accessibilityState={{ disabled: unavailable }}
                  >
                    <Image
                      source={active && m.logoActive ? m.logoActive : m.logo}
                      style={[styles.modelPillLogo, unavailable && styles.modelPillLogoMuted]}
                      resizeMode="contain"
                    />
                    <Text
                      style={[
                        styles.pillText,
                        active && styles.pillTextActive,
                        unavailable && styles.pillTextDisabled,
                      ]}
                    >
                      {t(m.labelKey)}
                    </Text>
                    {unavailable ? (
                      <View style={styles.modelSoonBadge}>
                        <Text style={styles.modelSoonBadgeText}>{t('aiAgents.modelSoon')}</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.hint}>{MODEL_OPTIONS[modelIdx].choice.model}</Text>

            {/* ── Margin mode ── */}
            <FieldLabel
              label={t('aiAgents.marginModeLabel')}
              required
              onInfo={() =>
                showInfo(
                  t('aiAgents.marginModeLabel'),
                  crossAllowedForSymbols
                    ? t('aiAgents.crossFallbackNote')
                    : t('aiAgents.crossDisabledIsolatedOnly'),
                )
              }
            />
            <View style={styles.pillsWrap}>
              <TouchableOpacity
                style={[
                  styles.pill,
                  marginMode === 'cross' && styles.pillActive,
                  !crossAllowedForSymbols && styles.pillDisabled,
                ]}
                disabled={!crossAllowedForSymbols}
                onPress={() => setMarginMode('cross')}
              >
                <Text
                  style={[
                    styles.pillText,
                    marginMode === 'cross' && styles.pillTextActive,
                    !crossAllowedForSymbols && styles.pillTextDisabled,
                  ]}
                >
                  {t('trading.cross')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, marginMode === 'isolated' && styles.pillActive]}
                onPress={() => setMarginMode('isolated')}
              >
                <Text style={[styles.pillText, marginMode === 'isolated' && styles.pillTextActive]}>
                  {t('trading.isolated')}
                </Text>
              </TouchableOpacity>
            </View>
            {!crossAllowedForSymbols ? (
              <Text style={styles.hint}>{t('aiAgents.crossDisabledIsolatedOnly')}</Text>
            ) : marginMode === 'cross' && isolatedOnlySymbols.length ? (
              <Text style={styles.hint}>
                {t('aiAgents.crossAutoIsolatedHint', {
                  symbols: isolatedOnlySymbols.map(displaySymbol).join(', '),
                })}
              </Text>
            ) : null}

            {/* ── Risk profile — hidden during testing (all agents aggressive).
                 RISK_PROFILE_SELECTOR_ENABLED restores the choice. ── */}
            {RISK_PROFILE_SELECTOR_ENABLED ? (
              <>
                <FieldLabel
                  label={t('aiAgents.riskProfileLabel')}
                  required
                  onInfo={() =>
                    showInfo(
                      t('aiAgents.riskProfileLabel'),
                      [
                        `${t('aiAgents.riskProfileStandard')}: ${t('aiAgents.riskProfileStandardHint')}`,
                        `${t('aiAgents.riskProfileAggressive')}: ${t('aiAgents.riskProfileAggressiveHint')}`,
                      ].join('\n\n'),
                    )
                  }
                />
                <View style={styles.pillsWrap}>
                  <TouchableOpacity
                    style={[styles.pill, riskProfile === 'standard' && styles.pillActive]}
                    onPress={() => setRiskProfile('standard')}
                  >
                    <Text style={[styles.pillText, riskProfile === 'standard' && styles.pillTextActive]}>
                      {t('aiAgents.riskProfileStandard')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.pill, riskProfile === 'aggressive' && styles.pillActive]}
                    onPress={() => setRiskProfile('aggressive')}
                  >
                    <Text style={[styles.pillText, riskProfile === 'aggressive' && styles.pillTextActive]}>
                      {t('aiAgents.riskProfileAggressive')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}

            {/* ── Trading horizon ── */}
            <FieldLabel
              label={t('aiAgents.horizonLabel')}
              required
              onInfo={() =>
                showInfo(
                  t('aiAgents.horizonLabel'),
                  [
                    `${t('aiAgents.horizonScalper')}: ${t('aiAgents.horizonScalperHint')}`,
                    `${t('aiAgents.horizonSwing')}: ${t('aiAgents.horizonSwingHint')}`,
                    `${t('aiAgents.horizonInvestor')}: ${t('aiAgents.horizonInvestorHint')}`,
                  ].join('\n\n'),
                )
              }
            />
            <View style={styles.pillsWrap}>
              <TouchableOpacity
                style={[styles.pill, horizon === 'scalper' && styles.pillActive]}
                onPress={() => setHorizon('scalper')}
              >
                <Text style={[styles.pillText, horizon === 'scalper' && styles.pillTextActive]}>
                  {t('aiAgents.horizonScalper')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, horizon === 'swing' && styles.pillActive]}
                onPress={() => setHorizon('swing')}
              >
                <Text style={[styles.pillText, horizon === 'swing' && styles.pillTextActive]}>
                  {t('aiAgents.horizonSwing')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, horizon === 'investor' && styles.pillActive]}
                onPress={() => setHorizon('investor')}
              >
                <Text style={[styles.pillText, horizon === 'investor' && styles.pillTextActive]}>
                  {t('aiAgents.horizonInvestor')}
                </Text>
              </TouchableOpacity>
            </View>
            {horizon === 'swing' &&
            Number.isFinite(parseFloat(leverageText)) &&
            parseFloat(leverageText) > SWING_LEVERAGE_WARN_ABOVE ? (
              <Text style={styles.warnHint}>
                {t('aiAgents.horizonSwingLeverageWarn', { max: SWING_LEVERAGE_WARN_ABOVE })}
              </Text>
            ) : null}
            {horizon === 'investor' &&
            Number.isFinite(parseFloat(leverageText)) &&
            parseFloat(leverageText) > INVESTOR_LEVERAGE_WARN_ABOVE ? (
              <Text style={styles.warnHint}>
                {t('aiAgents.horizonInvestorLeverageWarn', { max: INVESTOR_LEVERAGE_WARN_ABOVE })}
              </Text>
            ) : null}

            {/* ── Trading style: free form vs one-direction mandate ── */}
            <FieldLabel
              label={t('aiAgents.directionLabel')}
              required
              onInfo={() =>
                showInfo(
                  t('aiAgents.directionLabel'),
                  [
                    `${t('aiAgents.directionFreeForm')}: ${t('aiAgents.directionFreeFormHint')}`,
                    `${t('aiAgents.directionLongOnly')}: ${t('aiAgents.directionLongOnlyHint')}`,
                    `${t('aiAgents.directionShortOnly')}: ${t('aiAgents.directionShortOnlyHint')}`,
                  ].join('\n\n'),
                )
              }
            />
            <View style={styles.pillsWrap}>
              <TouchableOpacity
                style={[styles.pill, direction === 'long_short' && styles.pillActive]}
                onPress={() => {
                  setDirection('long_short');
                  setMandate('active');
                }}
              >
                <Text style={[styles.pillText, direction === 'long_short' && styles.pillTextActive]}>
                  {t('aiAgents.directionFreeForm')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, direction === 'long_only' && styles.pillActive]}
                onPress={() => setDirection('long_only')}
              >
                <Text style={[styles.pillText, direction === 'long_only' && styles.pillTextActive]}>
                  {t('aiAgents.directionLongOnly')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, direction === 'short_only' && styles.pillActive]}
                onPress={() => setDirection('short_only')}
              >
                <Text style={[styles.pillText, direction === 'short_only' && styles.pillTextActive]}>
                  {t('aiAgents.directionShortOnly')}
                </Text>
              </TouchableOpacity>
            </View>
            {direction !== 'long_short' ? (
              <>
                <FieldLabel
                  label={t('aiAgents.mandateLabel')}
                  onInfo={() =>
                    showInfo(
                      t('aiAgents.mandateLabel'),
                      [
                        `${t('aiAgents.mandateActive')}: ${t('aiAgents.mandateActiveHint')}`,
                        `${t('aiAgents.mandateAccumulate')}: ${
                          direction === 'short_only'
                            ? t('aiAgents.mandateAccumulateShortHint')
                            : t('aiAgents.mandateAccumulateHint')
                        }`,
                      ].join('\n\n'),
                    )
                  }
                />
                <View style={styles.pillsWrap}>
                  <TouchableOpacity
                    style={[styles.pill, mandate === 'active' && styles.pillActive]}
                    onPress={() => setMandate('active')}
                  >
                    <Text style={[styles.pillText, mandate === 'active' && styles.pillTextActive]}>
                      {t('aiAgents.mandateActive')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.pill, mandate === 'accumulate' && styles.pillActive]}
                    onPress={() => setMandate('accumulate')}
                  >
                    <Text style={[styles.pillText, mandate === 'accumulate' && styles.pillTextActive]}>
                      {t('aiAgents.mandateAccumulate')}
                    </Text>
                  </TouchableOpacity>
                </View>
                {mandate === 'accumulate' &&
                Number.isFinite(parseFloat(leverageText)) &&
                parseFloat(leverageText) > ACCUMULATE_LEVERAGE_WARN_ABOVE ? (
                  <Text style={styles.warnHint}>
                    {t('aiAgents.mandateAccumulateLeverageWarn', { max: ACCUMULATE_LEVERAGE_WARN_ABOVE })}
                  </Text>
                ) : null}
              </>
            ) : null}

            {/* Dedicated toggle — volume-gated; funding via sendAsset. */}
            {DEDICATED_MODE_ENABLED ? (
            <View style={styles.dedicatedBlock}>
              <View
                style={styles.dedicatedRow}
                accessibilityState={dedicatedLocked ? { disabled: true } : undefined}
              >
                <View style={styles.dedicatedLabelRow}>
                  <Text
                    style={[
                      styles.fieldLabel,
                      dedicatedLocked && styles.dedicatedLabelLocked,
                    ]}
                  >
                    {t('aiAgents.dedicatedBalance')}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (isEditingDraft) {
                        showInfo(
                          t('aiAgents.dedicatedBalance'),
                          dedicatedMode
                            ? t('aiAgents.dedicatedBalanceDesc')
                            : t('aiAgents.capitalCapDesc'),
                        );
                      } else if (dedicatedEligibility.state === 'ineligible') {
                        showInfo(
                          t('aiAgents.dedicatedBalance'),
                          t('aiAgents.dedicatedIneligible', {
                            volume: Math.floor(
                              dedicatedEligibility.lifetimeVolumeUsd,
                            ).toLocaleString(),
                          }),
                        );
                      } else {
                        showInfo(
                          t('aiAgents.dedicatedBalance'),
                          t('aiAgents.dedicatedBalanceDesc'),
                        );
                      }
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Info"
                    style={styles.fieldInfoBtn}
                  >
                    <Ionicons
                      name="information-circle-outline"
                      size={18}
                      color={colors.text.tertiary}
                    />
                  </TouchableOpacity>
                </View>
                {!isEditingDraft && dedicatedEligibility.state === 'checking' ? (
                  <ActivityIndicator size="small" color={colors.accent.gold} />
                ) : (
                  <View
                    pointerEvents={dedicatedLocked ? 'none' : 'auto'}
                    style={dedicatedLocked ? styles.dedicatedSwitchLocked : undefined}
                  >
                    <Switch
                      value={dedicatedMode}
                      onValueChange={setDedicatedMode}
                      disabled={isEditingDraft || dedicatedLocked}
                      accessibilityState={{
                        disabled: isEditingDraft || dedicatedLocked,
                      }}
                      trackColor={
                        dedicatedLocked
                          ? {
                              true: colors.border.secondary,
                              false: colors.border.secondary,
                            }
                          : {
                              true: colors.accent.goldDark,
                              false: colors.border.secondary,
                            }
                      }
                      thumbColor={
                        dedicatedLocked ? colors.text.tertiary : colors.text.primary
                      }
                      ios_backgroundColor={
                        dedicatedLocked ? colors.border.secondary : undefined
                      }
                    />
                  </View>
                )}
              </View>
              {dedicatedLocked ? (
                <Text style={styles.dedicatedHint}>{t('aiAgents.dedicatedUnavailableShort')}</Text>
              ) : null}

              {dedicatedMode && !fundingAlreadySent ? (
                <>
                  <FieldLabel
                    label={t('aiAgents.fundingAmountLabel')}
                    required
                    onInfo={() =>
                      showInfo(
                        t('aiAgents.fundingAmountLabel'),
                        t('aiAgents.fundingAmountDesc'),
                      )
                    }
                  />
                  <Text style={styles.rowFieldLabel}>
                    {t('aiAgents.fundingFieldLabel')}
                    <Text style={styles.requiredMark}> *</Text>
                  </Text>
                  <TextInput
                    style={[styles.input, fundingInvalid && styles.inputError]}
                    value={fundingText}
                    onChangeText={setFundingText}
                    keyboardType="decimal-pad"
                    placeholder={t('aiAgents.fundingPlaceholder')}
                    placeholderTextColor={colors.text.muted}
                  />
                  {fundingInvalid ? (
                    <Text style={styles.errorHint}>
                      {t('aiAgents.invalidFunding', {
                        min: AI_AGENT_LIMITS.minCapitalUsd,
                        max: AI_AGENT_LIMITS.maxCapitalUsd.toLocaleString(),
                      })}
                    </Text>
                  ) : fundingThin && fundingNeededForFullNotional != null ? (
                    <Text style={styles.warnHint}>
                      {t('aiAgents.fundingThinHint', {
                        leverage: leverageNum,
                        needed: Math.ceil(fundingNeededForFullNotional).toLocaleString(),
                        notional: Math.floor(budgetNum).toLocaleString(),
                      })}
                    </Text>
                  ) : null}
                </>
              ) : dedicatedMode && fundingAlreadySent ? (
                <Text style={styles.hint}>{t('aiAgents.fundingLockedHint')}</Text>
              ) : null}
            </View>
            ) : null}

            {/* ── Notional + leverage (same for Shared and Dedicated) ── */}
            <FieldLabel
              label={t('aiAgents.capitalCapLabel')}
              required
              onInfo={() =>
                showInfo(t('aiAgents.capitalCapLabel'), t('aiAgents.capitalCapDesc'))
              }
            />
            <View style={styles.row}>
              <View style={styles.rowInput}>
                <Text style={styles.rowFieldLabel}>
                  {t('aiAgents.capitalFieldLabel')}
                  <Text style={styles.requiredMark}> *</Text>
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    styles.rowInputField,
                    budgetInvalid && styles.inputError,
                  ]}
                  value={budgetText}
                  onChangeText={setBudgetText}
                  keyboardType="decimal-pad"
                  placeholder={t('aiAgents.capPlaceholder')}
                  placeholderTextColor={colors.text.muted}
                />
                {budgetInvalid ? (
                  <Text style={styles.errorHint}>
                    {budgetTooHigh
                      ? t('aiAgents.maxCapitalHint', {
                          max: AI_AGENT_LIMITS.maxCapitalUsd.toLocaleString(),
                        })
                      : budgetTooLow
                        ? t('aiAgents.minCapitalHint', {
                            min: AI_AGENT_LIMITS.minCapitalUsd,
                          })
                        : t('aiAgents.invalidCapital', {
                            min: AI_AGENT_LIMITS.minCapitalUsd,
                            max: AI_AGENT_LIMITS.maxCapitalUsd.toLocaleString(),
                          })}
                  </Text>
                ) : (
                  <Text style={styles.hint}>
                    {t('aiAgents.minCapitalHint', {
                      min: AI_AGENT_LIMITS.minCapitalUsd,
                    })}
                  </Text>
                )}
              </View>
              <View style={styles.rowInput}>
                <Text style={styles.rowFieldLabel}>
                  {t('aiAgents.leverageFieldLabel')}
                  <Text style={styles.requiredMark}> *</Text>
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    styles.rowInputField,
                    leverageInvalid && styles.inputError,
                  ]}
                  value={leverageText}
                  onChangeText={setLeverageText}
                  keyboardType="decimal-pad"
                  placeholder={t('aiAgents.leveragePlaceholder')}
                  placeholderTextColor={colors.text.muted}
                />
                {leverageInvalid ? (
                  <Text style={styles.errorHint}>
                    {leverageCap.ceilingSymbol
                      ? t('aiAgents.leverageMaxHint', {
                          symbol: displaySymbol(leverageCap.ceilingSymbol),
                          max: leverageCap.max,
                        })
                      : t('aiAgents.leverageRangeHint', { max: leverageCap.max })}
                  </Text>
                ) : leverageClamp.parts.length > 0 ? (
                  <Text style={styles.hint}>
                    {leverageClamp.extra > 0
                      ? t('aiAgents.leverageClampHintMore', {
                          details: leverageClamp.parts.join(' · '),
                          count: leverageClamp.extra,
                          leverage: leverageNum,
                        })
                      : t('aiAgents.leverageClampHint', {
                          details: leverageClamp.parts.join(' · '),
                          leverage: leverageNum,
                        })}
                  </Text>
                ) : null}
              </View>
            </View>

            {/*
              Optional per-position clamp — hidden while maxSymbols === 1
              (duplicates total notional). Kept for multi-symbol revert.
            */}
            {AI_AGENT_SHOW_PER_POSITION_CAP ? (
              <>
                <FieldLabel
                  label={t('aiAgents.maxPositionLabel')}
                  optional={t('aiAgents.maxPositionOptional')}
                  onInfo={() =>
                    showInfo(t('aiAgents.maxPositionLabel'), t('aiAgents.maxPositionDesc'))
                  }
                />
                <TextInput
                  style={[styles.input, maxPositionInvalid && styles.inputError]}
                  value={maxPositionText}
                  onChangeText={setMaxPositionText}
                  keyboardType="decimal-pad"
                  placeholder={t(
                    'aiAgents.maxPositionPlaceholder',
                    'Leave empty to let the AI decide',
                  )}
                  placeholderTextColor={colors.text.muted}
                />
                {maxPositionInvalid ? (
                  <Text style={styles.errorHint}>
                    {maxPositionNum != null && maxPositionNum < AI_AGENT_LIMITS.minPositionUsd
                      ? t('aiAgents.minPositionHint', { min: AI_AGENT_LIMITS.minPositionUsd })
                      : t('aiAgents.invalidMaxPosition')}
                  </Text>
                ) : null}
              </>
            ) : null}

            {cgGlobalMode ? null : (
              <>
                <FieldLabel
                  label={t('aiAgents.dataKeyLabel')}
                  required={!isEditingDraft || coinglassReplaceMode}
                  onInfo={() =>
                    showInfo(
                      t('aiAgents.dataKeyLabel'),
                      isEditingDraft && !coinglassReplaceMode
                        ? t('aiAgents.coinglassSavedHint')
                        : t('aiAgents.coinglassKeyInfo'),
                    )
                  }
                />
                {isEditingDraft && !coinglassReplaceMode ? (
                  <View style={styles.coinglassSavedRow}>
                    <Text style={styles.coinglassMasked} accessibilityLabel={t('aiAgents.coinglassSaved')}>
                      {'•'.repeat(28)}
                    </Text>
                    <TouchableOpacity
                      onPress={() => {
                        setCoinglassReplaceMode(true);
                        setCoinglassKey('');
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.coinglassReplaceText}>{t('aiAgents.coinglassReplace')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={styles.coinglassEditBlock}>
                    <TextInput
                      style={styles.input}
                      value={coinglassKey}
                      onChangeText={setCoinglassKey}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                      placeholder={t('aiAgents.coinglassPlaceholder')}
                      placeholderTextColor={colors.text.muted}
                    />
                    {isEditingDraft ? (
                      <TouchableOpacity
                        onPress={() => {
                          setCoinglassReplaceMode(false);
                          setCoinglassKey('');
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={styles.coinglassKeepLink}
                      >
                        <Text style={styles.coinglassReplaceText}>{t('aiAgents.coinglassKeepSaved')}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                )}
              </>
            )}

            <TouchableOpacity
              style={[styles.primary, (!canCreate || creating || !isReady) && styles.primaryDisabled]}
              onPress={() => setPendingConfirm({ type: isEditingDraft ? 'save' : 'create' })}
              disabled={!canCreate || creating || !isReady}
            >
              {creating ? (
                <ActivityIndicator color={colors.background.primary} />
              ) : (
                <Text style={styles.primaryText}>
                  {isEditingDraft ? t('aiAgents.saveButton') : t('aiAgents.createButton')}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Auth not ready → skeleton. Never show empty pitch until we know guest vs list. */}
        {(!authReady || loading) && !showCreate ? (
          <AiAgentsListSkeleton />
        ) : !showCreate && !sortedAgents.length ? (
          <AiAgentsEmptyState onCreate={openCreateForm} />
        ) : !showCreate ? (
          <>
          {showFilters ? (
            <View style={styles.filterBlock}>
              <View style={styles.statusSegment}>
                {(
                  [
                    ['all', t('aiAgents.filterAll')],
                    ['active', t('aiAgents.filterActive')],
                    ['stopped', t('aiAgents.filterStopped')],
                    ['draft', t('aiAgents.filterDraft')],
                    ...(hasRevokedAgents
                      ? ([['revoked', t('aiAgents.filterRevoked')]] as const)
                      : []),
                  ] as const
                ).map(([key, label]) => {
                  const active = statusFilter === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.statusSegmentItem, active && styles.statusSegmentItemActive]}
                      onPress={() => setStatusFilter(key)}
                      activeOpacity={0.75}
                    >
                      <Text style={[styles.statusSegmentText, active && styles.statusSegmentTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {showModeFilter ? (
                <View style={styles.statusSegment}>
                  {(
                    [
                      ['all', t('aiAgents.filterAll')],
                      ['shared', t('aiAgents.modeShared')],
                      ['dedicated', t('aiAgents.modeDedicated')],
                    ] as const
                  ).map(([key, label]) => {
                    const active = modeFilter === key;
                    return (
                      <TouchableOpacity
                        key={key}
                        style={[styles.statusSegmentItem, active && styles.statusSegmentItemActive]}
                        onPress={() => setModeFilter(key)}
                        activeOpacity={0.75}
                      >
                        <Text style={[styles.statusSegmentText, active && styles.statusSegmentTextActive]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : null}
              {filterSymbols.length > 1 ? (
                <View style={styles.symbolFilterScrollWrap}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    bounces={false}
                    alwaysBounceHorizontal={false}
                    overScrollMode="never"
                    contentContainerStyle={styles.symbolFilterRow}
                  >
                    <TouchableOpacity
                      style={styles.symbolTab}
                      onPress={() => setSymbolFilter('all')}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.symbolTabText, symbolFilter === 'all' && styles.symbolTabTextActive]}>
                        {t('aiAgents.filterAllSymbols')}
                      </Text>
                      {symbolFilter === 'all' ? <View style={styles.symbolTabUnderline} /> : null}
                    </TouchableOpacity>
                    {filterSymbols.map((sym) => {
                      const active = symbolFilter === sym;
                      return (
                        <TouchableOpacity
                          key={sym}
                          style={styles.symbolTab}
                          onPress={() => setSymbolFilter(sym)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.symbolTabText, active && styles.symbolTabTextActive]}>{displaySymbol(sym)}</Text>
                          {active ? <View style={styles.symbolTabUnderline} /> : null}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                  <LinearGradient
                    colors={[`${colors.background.primary}00`, colors.background.primary]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.symbolFilterFade}
                    pointerEvents="none"
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          {filteredAgents.length === 0 ? (
            <Text style={styles.filterEmpty}>{t('aiAgents.filterEmpty')}</Text>
          ) : null}
          {visibleAgents.map((agent) => {
            const busy = busyAgentId === agent.id;
            const busyStopResume = busy && (busyAction === 'stop' || busyAction === 'resume');
            const busyRevoke = busy && busyAction === 'revoke';
            const busyActivate = busy && busyAction === 'activate';
            const busyDelete = busy && busyAction === 'delete';
            const expanded = expandedAgentId === agent.id;
            const perf = resolveAgentPerformance(
              agent,
              agentStats[agent.id],
              hlSummaryByAgentId[agent.id],
              {
                openSymbols: openSymbolsByAgentId[agent.id] ?? [],
                masterState: masterTradingState,
                dedicatedState: dedicatedStateByAgentId[agent.id],
                dedicatedBalanceUsd: dedicatedBalanceByAgentId[agent.id] ?? null,
              },
              bookWinRateByAgentId[agent.id],
            );
            const perfLoading = isAgentPerfLoading(agent);
            const balanceLoading = isDedicatedHlStatePending(agent);
            const modelChoice = agent.config.models.opening;
            const modelLogo = resolveModelLogo(modelChoice);
            const isStopped = agent.status === 'stopped' || agent.status === 'paused';
            const isRevoked = agent.status === 'revoked';
            const isDimmed = isStopped || isRevoked;
            const isRenaming = renamingAgentId === agent.id;
            const decisionCount = agentStats[agent.id]?.decisionCount ?? 0;
            const showCountdown = agent.status === 'active';
            const showRevoke = agent.status !== 'revoked' && agent.status !== 'draft';
            const showDegraded = agent.status === 'active' && !!agent.health?.degraded;
            const sidelinedSymbols = sidelinedSymbolsForAgent(agent);
            const hasSidelined = sidelinedSymbols.length > 0;
            // Manual-conflict chips take the countdown slot; otherwise countdown/degraded.
            const hasActivityLeft = hasSidelined || showCountdown || showDegraded;
            /** No mid row → Revoke shares the badges line so config chips sit up. */
            const revokeOnBadgesRow = showRevoke && !hasActivityLeft;
            const onPressRevoke = () => {
              const tracked = openSymbolsByAgentId[agent.id] ?? [];
              const dbOpen = agentStats[agent.id]?.openPositions ?? 0;
              const liveState =
                agent.mode === 'dedicated'
                  ? dedicatedStateByAgentId[agent.id]
                  : masterTradingState;
              const liveOpens = countAgentBookLivePositions({
                dedicated: agent.mode === 'dedicated',
                configuredSymbols: agent.config.symbols ?? [],
                trackedSymbols: tracked,
                state: liveState,
                dbOpenCount: dbOpen,
              });
              if (liveOpens > 0) {
                showInfo(
                  t('aiAgents.revokeConfirmTitle', 'Revoke this agent?'),
                  t('aiAgents.revokeHasOpen'),
                );
                return;
              }
              setPendingConfirm({ type: 'revoke', agent });
            };
            return (
              <LinearGradient
                key={agent.id}
                colors={AGENT_CARD_GRADIENT}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.agentCard}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardHeaderTop}>
                    <View style={[styles.cardTitleRow, isDimmed && styles.stoppedDim]}>
                      {modelLogo ? (
                        <Image source={modelLogo} style={styles.cardTitleModelLogo} resizeMode="contain" />
                      ) : null}
                      {agent.config.symbols.length === 1 ? (
                        (() => {
                          const sym = agent.config.symbols[0];
                          const symbolSrc = getAssetImageSource(sym);
                          return (
                            <TouchableOpacity
                              style={styles.cardSymbolNav}
                              onPress={() => navigateToAsset(sym)}
                              hitSlop={8}
                              activeOpacity={0.7}
                              accessibilityRole="button"
                              accessibilityLabel={displaySymbol(sym)}
                            >
                              {symbolSrc ? (
                                <Image
                                  source={symbolSrc}
                                  style={styles.cardTitleModelLogo}
                                  resizeMode="contain"
                                />
                              ) : (
                                <AssetLogo
                                  symbol={sym}
                                  size={18}
                                  style={styles.cardTitleSymbolLogo}
                                />
                              )}
                              <Ionicons name="chevron-forward" size={10} color={colors.text.tertiary} />
                            </TouchableOpacity>
                          );
                        })()
                      ) : agent.config.symbols.length > 1 ? (
                        <TouchableOpacity
                          style={styles.cardMultiSymbolsBtn}
                          onPress={() => setSymbolNavList(agent.config.symbols.map((s) => s.toUpperCase()))}
                          hitSlop={8}
                          activeOpacity={0.75}
                          accessibilityRole="button"
                          accessibilityLabel={t('aiAgents.targetedSymbolsTitle', {
                            count: agent.config.symbols.length,
                          })}
                        >
                          <Ionicons name="layers-outline" size={15} color={colors.accent.gold} />
                          <Text style={styles.cardMultiSymbolsCount}>
                            {agent.config.symbols.length}
                          </Text>
                          <Ionicons name="chevron-forward" size={10} color={colors.accent.gold} />
                        </TouchableOpacity>
                      ) : null}
                      {isRenaming ? (
                        <>
                          <TextInput
                            style={styles.renameInput}
                            value={renameDraft}
                            onChangeText={setRenameDraft}
                            autoFocus
                            maxLength={64}
                            editable={!renameSaving}
                            onSubmitEditing={() => void commitRename(agent)}
                            returnKeyType="done"
                            placeholderTextColor={colors.text.muted}
                          />
                          <View style={styles.renameActions}>
                            <TouchableOpacity
                              onPress={() => void commitRename(agent)}
                              disabled={renameSaving}
                              hitSlop={8}
                            >
                              {renameSaving ? (
                                <ActivityIndicator size="small" color={colors.accent.gold} />
                              ) : (
                                <Ionicons name="checkmark" size={18} color={colors.accent.gold} />
                              )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={cancelRename} disabled={renameSaving} hitSlop={8}>
                              <Ionicons name="close" size={18} color={colors.text.tertiary} />
                            </TouchableOpacity>
                          </View>
                        </>
                      ) : (
                        <View style={styles.cardTitleNameCluster}>
                          <Text style={styles.cardTitle} numberOfLines={1}>
                            {agent.name}
                          </Text>
                          {!isRevoked ? (
                            <TouchableOpacity
                              onPress={() => startRename(agent)}
                              hitSlop={8}
                              style={styles.renamePencil}
                            >
                              <Ionicons name="pencil" size={13} color={colors.text.tertiary} />
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      )}
                    </View>
                    {/* Hide status/controls while renaming so the input keeps a usable width. */}
                    {!isRenaming ? (
                      <View style={styles.statusCluster}>
                        {agent.status === 'draft' ||
                        agent.status === 'paused' ||
                        agent.status === 'stopped' ||
                        agent.status === 'revoked' ? (
                          <TouchableOpacity
                            onPress={() => setPendingConfirm({ type: 'delete', agent })}
                            disabled={busy}
                            hitSlop={6}
                            style={styles.statusControlIcon}
                            accessibilityLabel={t('aiAgents.delete', 'Delete')}
                          >
                            {busyDelete ? (
                              <ActivityIndicator color={colors.status.error} size="small" />
                            ) : (
                              <Ionicons name="trash-outline" size={16} color={colors.status.error} />
                            )}
                          </TouchableOpacity>
                        ) : null}
                        {agent.status === 'paused' || agent.status === 'stopped' ? (
                          <View style={styles.statusControlDivider} />
                        ) : null}
                        {agent.status === 'active' ? (
                          <TouchableOpacity
                            onPress={() => setPendingConfirm({ type: 'stop', agent })}
                            disabled={busy}
                            hitSlop={6}
                            style={styles.statusControlIcon}
                          >
                            {busyStopResume ? (
                              <ActivityIndicator color={colors.accent.gold} size="small" />
                            ) : (
                              <Ionicons name="pause" size={16} color={colors.accent.gold} />
                            )}
                          </TouchableOpacity>
                        ) : agent.status === 'paused' || agent.status === 'stopped' ? (
                          <TouchableOpacity
                            onPress={() => {
                              if (isDemo) {
                                showInfo(
                                  t('aiAgents.demoActivateBlockedTitle'),
                                  t('aiAgents.demoActivateBlockedDesc'),
                                );
                                return;
                              }
                              setPendingConfirm({ type: 'resume', agent });
                            }}
                            disabled={busy}
                            hitSlop={6}
                            style={styles.statusControlIcon}
                          >
                            {busyStopResume ? (
                              <ActivityIndicator color={colors.accent.gold} size="small" />
                            ) : (
                              <Ionicons name="play" size={16} color={colors.accent.gold} />
                            )}
                          </TouchableOpacity>
                        ) : null}
                        <View
                          style={[
                            styles.statusPill,
                            statusStyle(agent.status),
                            isStopped && styles.stoppedDim,
                          ]}
                        >
                          <Text style={styles.statusText} numberOfLines={1}>
                            {formatAgentStatus(agent, t)}
                          </Text>
                        </View>
                      </View>
                    ) : null}
                  </View>

                  {hasActivityLeft ? (
                    <View style={styles.cardActivityRow}>
                      <View style={[styles.cardActivityLeft, isDimmed && styles.stoppedDim]}>
                        {hasSidelined ? (
                          sidelinedSymbols.map((sym) => (
                            <TouchableOpacity
                              key={sym}
                              style={styles.sidelinedChip}
                              onPress={() =>
                                showInfo(
                                  t('aiAgents.sidelinedManualTitle', {
                                    symbol: displaySymbol(sym),
                                  }),
                                  t('aiAgents.sidelinedManualDesc', {
                                    symbol: displaySymbol(sym),
                                  }),
                                )
                              }
                              activeOpacity={0.75}
                            >
                              <Ionicons
                                name="pause-circle-outline"
                                size={13}
                                color={colors.status.warning}
                              />
                              <Text style={styles.sidelinedChipText}>
                                {t('aiAgents.sidelinedManualChip', {
                                  symbol: displaySymbol(sym),
                                })}
                              </Text>
                            </TouchableOpacity>
                          ))
                        ) : showCountdown ? (
                          <View style={styles.cardActivityItem}>
                            <Ionicons name="time-outline" size={13} color={colors.accent.gold} />
                            <Text style={styles.cardActivityText} numberOfLines={1}>
                              {t('aiAgents.nextDecisionIn', { time: nextCycleCountdown })}
                            </Text>
                          </View>
                        ) : null}
                        {!hasSidelined && showDegraded ? (
                          <TouchableOpacity
                            style={styles.degradedChip}
                            onPress={() =>
                              showInfo(
                                t('aiAgents.degradedTitle'),
                                degradedHealthBody(agent.health, t),
                              )
                            }
                            activeOpacity={0.75}
                            hitSlop={6}
                          >
                            <Ionicons
                              name="warning-outline"
                              size={13}
                              color={colors.status.warning}
                            />
                            <Text style={styles.degradedChipText} numberOfLines={1}>
                              {t('aiAgents.degradedChip')}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                      {showRevoke ? (
                        <TouchableOpacity
                          style={styles.cardMetaActionBtn}
                          onPress={onPressRevoke}
                          disabled={busy}
                        >
                          {busyRevoke ? (
                            <ActivityIndicator color={colors.status.error} size="small" />
                          ) : (
                            <Text style={[styles.cardMetaActionText, styles.cardMetaActionDanger]}>
                              {t('aiAgents.revoke', 'Revoke')}
                            </Text>
                          )}
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : null}

                  <View
                    style={[
                      styles.cardBadgesRow,
                      revokeOnBadgesRow && styles.cardBadgesRowWithRevoke,
                    ]}
                  >
                    <View style={[styles.cardBadgesMain, isDimmed && styles.stoppedDim]}>
                      <AgentConfigBadges agent={agent} t={t} />
                    </View>
                    {revokeOnBadgesRow ? (
                      <TouchableOpacity
                        style={styles.cardMetaActionBtn}
                        onPress={onPressRevoke}
                        disabled={busy}
                      >
                        {busyRevoke ? (
                          <ActivityIndicator color={colors.status.error} size="small" />
                        ) : (
                          <Text style={[styles.cardMetaActionText, styles.cardMetaActionDanger]}>
                            {t('aiAgents.revoke', 'Revoke')}
                          </Text>
                        )}
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>

                <AgentPerformanceRow
                  perf={perf}
                  statsLoading={perfLoading}
                  balanceLoading={balanceLoading}
                  formatPnl={formatPnlValue}
                  formatVolume={formatVolumeValue}
                  formatBalance={formatBalanceValue}
                  dimmed={isDimmed}
                  onPressLivePositions={() =>
                    pushRouteOnce(
                      router,
                      agent.mode === 'dedicated' && agent.hlSubaccountAddress
                        ? (`/portfolio?book=${encodeURIComponent(agent.id)}` as any)
                        : '/portfolio',
                    )
                  }
                  onPressBalance={
                    agent.mode === 'dedicated' && agent.hlSubaccountAddress
                      ? () => {
                          setTransferError(null);
                          setTransferAgent(agent);
                        }
                      : undefined
                  }
                  t={t}
                />

                {agent.status === 'draft' ? (
                  <View style={styles.draftActions}>
                    <TouchableOpacity
                      style={[styles.draftActionBtn, styles.draftActionBtnSecondary]}
                      onPress={() => openEditDraft(agent)}
                      disabled={busy}
                    >
                      <Text
                        style={styles.draftActionTextSecondary}
                        numberOfLines={2}
                        adjustsFontSizeToFit
                        minimumFontScale={0.85}
                      >
                        {t('aiAgents.edit')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.draftActionBtn, styles.draftActionBtnPrimary]}
                      onPress={() => {
                        if (isDemo) {
                          showInfo(
                            t('aiAgents.demoActivateBlockedTitle'),
                            t('aiAgents.demoActivateBlockedDesc'),
                          );
                          return;
                        }
                        setPendingConfirm({ type: 'activate', agent });
                      }}
                      disabled={busy}
                    >
                      {busyActivate ? (
                        <ActivityIndicator color={colors.background.primary} />
                      ) : (
                        <Text
                          style={styles.draftActionTextPrimary}
                          numberOfLines={2}
                          adjustsFontSizeToFit
                          minimumFontScale={0.85}
                        >
                          {t('aiAgents.approveActivate')}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    {agent.status === 'active' && __DEV__ ? (
                      <View style={styles.shadowRow}>
                        <Text style={styles.controlLabel}>{t('aiAgents.shadowMode')}</Text>
                        <Switch
                          value={agent.dryRun}
                          onValueChange={() => void runControl(agent, 'toggleDryRun')}
                          disabled={busy}
                          trackColor={{ true: colors.accent.goldDark, false: colors.border.secondary }}
                        />
                      </View>
                    ) : null}

                    <TouchableOpacity
                      style={[
                        styles.decisionsToggle,
                        expanded && styles.decisionsToggleActive,
                        isDimmed && styles.stoppedDim,
                      ]}
                      onPress={() => void handleToggleDecisions(agent)}
                      activeOpacity={0.85}
                    >
                      {/* Gold button → dark dots/icons (match label text, not white). */}
                      {loadingDecisionsId === agent.id && !expanded ? (
                        <BouncingDots color={colors.background.primary} dotSize={4} />
                      ) : (
                        <>
                          <Ionicons name="pulse-outline" size={15} color={colors.background.primary} />
                          {!agentStatsFetched || agentStatsPending ? (
                            <>
                              <Text style={styles.decisionsToggleText}>
                                {t('aiAgents.recentDecisions')}
                              </Text>
                              <BouncingDots color={colors.background.primary} dotSize={3} />
                            </>
                          ) : (
                            <Text style={styles.decisionsToggleText}>
                              {decisionCount > 0
                                ? t('aiAgents.recentDecisionsWithCount', { count: decisionCount })
                                : t('aiAgents.recentDecisions')}
                            </Text>
                          )}
                          <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={16}
                            color={colors.background.primary}
                          />
                        </>
                      )}
                    </TouchableOpacity>

                    {expanded ? (
                      <View style={[styles.decisions, isStopped && styles.stoppedDim]}>
                        {(agent.config.symbols?.length ?? 0) > 1 ? (
                          <View style={styles.decisionSymbolChips}>
                            {(['all', ...agent.config.symbols.map((s) => s.toUpperCase())] as string[]).map(
                              (sym) => {
                                const active = (decisionsSymbolByAgent[agent.id] ?? 'all') === sym;
                                return (
                                  <TouchableOpacity
                                    key={sym}
                                    style={[
                                      styles.decisionSymbolChip,
                                      active && styles.decisionSymbolChipActive,
                                    ]}
                                    onPress={() => void handleDecisionsSymbolFilter(agent, sym)}
                                    disabled={loadingDecisionsId === agent.id}
                                    activeOpacity={0.8}
                                  >
                                    <Text
                                      style={[
                                        styles.decisionSymbolChipText,
                                        active && styles.decisionSymbolChipTextActive,
                                      ]}
                                    >
                                      {sym === 'all' ? t('aiAgents.filterAll') : displaySymbol(sym)}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              }
                            )}
                          </View>
                        ) : null}
                        {loadingDecisionsId === agent.id ? (
                          <ActivityIndicator
                            color={colors.accent.gold}
                            size="small"
                            style={{ marginVertical: 12 }}
                          />
                        ) : (decisionsByAgent[agent.id] ?? []).length === 0 ? (
                          <Text style={styles.hint}>{t('aiAgents.noDecisions')}</Text>
                        ) : (
                          <>
                            {decisionsByAgent[agent.id].map((d) => {
                              const summary = decisionSummary(d);
                              const dir =
                                summary.direction ??
                                (d.symbol
                                  ? openDirectionByAgentSymbol.get(
                                      `${agent.id}:${d.symbol.toUpperCase()}`,
                                    ) ?? null
                                  : null);
                              const lead = d.symbol ? displaySymbol(d.symbol) : '';
                              const createdAt = new Date(d.created_at);
                              return (
                                <View key={d.id} style={styles.decisionCard}>
                                  <View style={styles.decisionCardHeader}>
                                    <Text style={styles.decisionSymbol} numberOfLines={1}>
                                      {lead ? `${lead} · ` : ''}
                                      {dir ? (
                                        <>
                                          <Text style={{ color: directionColor(dir) }}>{dir}</Text>
                                          <Text style={styles.decisionSymbol}> · </Text>
                                        </>
                                      ) : null}
                                      <Text style={{ color: decisionActionColor(summary.tone, d.type) }}>
                                        {summary.headline}
                                      </Text>
                                    </Text>
                                    <View style={styles.decisionTimeCol}>
                                      <Text style={styles.decisionTime}>
                                        {createdAt.toLocaleDateString()}
                                      </Text>
                                      <Text style={styles.decisionTime}>
                                        {createdAt.toLocaleTimeString(undefined, {
                                          hour: 'numeric',
                                          minute: '2-digit',
                                        })}
                                      </Text>
                                    </View>
                                  </View>
                                  {summary.conviction != null ? (
                                    <Text style={styles.decisionConviction}>
                                      <Text style={styles.decisionConvictionLabel}>
                                        {t('aiAgents.conviction')}:{' '}
                                      </Text>
                                      <Text style={styles.decisionConvictionValue}>
                                        {summary.conviction}/100
                                      </Text>
                                    </Text>
                                  ) : null}
                                  {summary.pnlPct != null ? (
                                    <Text style={styles.decisionConviction}>
                                      <Text style={styles.decisionConvictionLabel}>
                                        {t('aiAgents.pnlAtCheck')}:{' '}
                                      </Text>
                                      <Text
                                        style={[
                                          styles.decisionConvictionValue,
                                          { color: toneColor(summary.tone) },
                                        ]}
                                      >
                                        {formatDecisionPnlPct(summary.pnlPct)}
                                      </Text>
                                    </Text>
                                  ) : null}
                                  {summary.body ? (
                                    <CopyableDecisionText
                                      text={summary.body}
                                      style={styles.decisionBody}
                                      containerStyle={{ marginTop: 6 }}
                                    />
                                  ) : (
                                    <Text style={styles.decisionBodyMuted}>{t('aiAgents.noReasoningText')}</Text>
                                  )}
                                </View>
                              );
                            })}
                            {decisionsHasMore[agent.id] ? (
                              <TouchableOpacity
                                style={styles.loadMoreDecisions}
                                onPress={() => void handleLoadMoreDecisions(agent)}
                                disabled={loadingMoreDecisionsId === agent.id}
                              >
                                {loadingMoreDecisionsId === agent.id ? (
                                  <ActivityIndicator size="small" color={colors.accent.gold} />
                                ) : (
                                  <Text style={styles.loadMoreDecisionsText}>
                                    {t('aiAgents.loadMoreDecisions')}
                                  </Text>
                                )}
                              </TouchableOpacity>
                            ) : null}
                          </>
                        )}
                      </View>
                    ) : null}
                  </>
                )}
              </LinearGradient>
            );
          })}
          {hasMoreAgents ? (
            <TouchableOpacity
              style={styles.showMoreAgents}
              onPress={() => setAgentListVisibleCount((n) => n + 5)}
              activeOpacity={0.8}
            >
              <Text style={styles.showMoreAgentsText}>
                {t('home.showMore')}
              </Text>
            </TouchableOpacity>
          ) : null}
          </>
        ) : null}
      </KeyboardAwareScrollView>

      {confirmMeta ? (
        <BankConfirmModal
          visible={pendingConfirm != null}
          title={confirmMeta.title}
          message={confirmMeta.message}
          confirmLabel={confirmMeta.confirmLabel}
          dontAskAgain={confirmMeta.showDontAskAgain ? confirmDontAskAgain : undefined}
          onToggleDontAskAgain={
            confirmMeta.showDontAskAgain ? () => setConfirmDontAskAgain((v) => !v) : undefined
          }
          onConfirm={() => void confirmPendingWithDismiss()}
          onCancel={() => setPendingConfirm(null)}
        />
      ) : null}

      <BankConfirmModal
        visible={pendingFundWarnUsd != null}
        title={t('aiAgents.restingLimitDedicatedTitle')}
        message={t('aiAgents.restingLimitDedicatedWarn')}
        confirmLabel={t('aiAgents.sharedTradeWarnContinue')}
        dontAskAgain={fundDontAskAgain}
        onToggleDontAskAgain={() => setFundDontAskAgain((v) => !v)}
        onConfirm={() => void confirmDedicatedFundWarn()}
        onCancel={() => setPendingFundWarnUsd(null)}
      />

      <BankConfirmModal
        visible={infoAlert != null}
        mode="alert"
        title={infoAlert?.title ?? ''}
        message={infoAlert?.message ?? ''}
        onConfirm={() => setInfoAlert(null)}
        onCancel={() => setInfoAlert(null)}
      />

      <Modal
        visible={symbolNavList != null}
        transparent
        animationType="fade"
        statusBarTranslucent
        presentationStyle={Platform.OS === 'ios' ? 'overFullScreen' : undefined}
        onRequestClose={() => setSymbolNavList(null)}
      >
        <View style={styles.symbolNavOverlay} pointerEvents="box-none">
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setSymbolNavList(null)}
          />
          <View style={styles.symbolNavCard}>
            <Text style={styles.symbolNavTitle}>
              {t('aiAgents.targetedSymbolsTitle', {
                count: symbolNavList?.length ?? 0,
              })}
            </Text>
            {(symbolNavList ?? []).map((sym) => (
              <TouchableOpacity
                key={sym}
                style={styles.symbolNavRow}
                onPress={() => {
                  setSymbolNavList(null);
                  navigateToAsset(sym);
                }}
                activeOpacity={0.75}
              >
                <Text style={styles.symbolNavRowText}>{displaySymbol(sym)}</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.text.tertiary} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      <DedicatedTransferBottomSheet
        visible={transferAgent != null}
        onClose={handleDedicatedTransferSheetClose}
        agentName={transferAgent?.name ?? ''}
        mainAvailableUsd={masterTransferAvailableUsd}
        dedicatedAvailableUsd={transferDedicatedAvailableUsd}
        busy={transferBusy}
        error={transferError}
        onTransfer={requestDedicatedTransfer}
      />
    </SafeAreaView>
  );
}

/** Survives remounts — same idea as portfolio's last-known-positive total. */
const lastKnownPositiveDedicatedBalanceByKey = new Map<string, number>();

function stickyDedicatedBalanceUsd(args: {
  env: string;
  address: string | null | undefined;
  state: HyperliquidTradingState | undefined;
  fetching: boolean;
}): number | null {
  const addr = String(args.address ?? '').toLowerCase();
  const raw =
    args.state && Number.isFinite(args.state.accountValueUsd)
      ? args.state.accountValueUsd
      : null;
  if (!addr.startsWith('0x')) return raw;

  const key = `${args.env}:${addr}`;
  const held = lastKnownPositiveDedicatedBalanceByKey.get(key);

  if (raw != null && raw > 0.01) {
    lastKnownPositiveDedicatedBalanceByKey.set(key, raw);
    return raw;
  }

  if (held != null && held > 0.01) {
    // Mid-refetch or mode-unknown empty hydrate — keep the last good number.
    if (args.fetching || !args.state || args.state.accountAbstractionMode == null) {
      return held;
    }
    lastKnownPositiveDedicatedBalanceByKey.delete(key);
    return raw ?? 0;
  }

  return raw;
}

function liveOpenCoinSet(state: HyperliquidTradingState | undefined): Set<string> {
  const set = new Set<string>();
  for (const p of state?.positions ?? []) {
    if (Math.abs(Number(p.szi)) > 0) set.add(String(p.coin).toUpperCase());
  }
  return set;
}

function unrealizedForSymbols(
  state: HyperliquidTradingState | undefined,
  symbols: string[],
): number {
  if (!state?.positions?.length || !symbols.length) return 0;
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  let sum = 0;
  for (const p of state.positions) {
    const coin = String(p.coin ?? '').toUpperCase();
    if (!want.has(coin)) continue;
    if (!(Math.abs(Number(p.szi)) > 0)) continue;
    const u = Number(p.unrealizedPnl);
    if (Number.isFinite(u)) sum += u;
  }
  return sum;
}

/**
 * Live positions on this agent's book.
 * Dedicated: every open HL position on the sub (AI + manual).
 * Shared: AI-tracked coins plus manual opens on the agent's assigned symbols.
 * Prefer HL when the clearinghouse is in; otherwise the DB count.
 */
function countAgentBookLivePositions(args: {
  dedicated: boolean;
  configuredSymbols: string[];
  trackedSymbols: string[];
  state: HyperliquidTradingState | undefined;
  dbOpenCount: number;
}): number {
  if (!args.state) return args.dbOpenCount;
  const live = liveOpenCoinSet(args.state);
  if (args.dedicated) return live.size;
  const want = new Set<string>();
  for (const s of args.trackedSymbols) want.add(s.toUpperCase());
  for (const s of args.configuredSymbols) want.add(s.toUpperCase());
  if (want.size === 0) return 0;
  let n = 0;
  for (const coin of live) {
    if (want.has(coin)) n += 1;
  }
  return n;
}

function resolveAgentPerformance(
  agent: AiAgentView,
  dbStats: AiAgentStats | undefined,
  hlSummary: UserPortfolioSummary | undefined,
  live: {
    openSymbols: string[];
    masterState?: HyperliquidTradingState;
    dedicatedState?: HyperliquidTradingState;
    dedicatedBalanceUsd?: number | null;
  },
  /** Book round-trip win rate from HL fills. `undefined` = not ready (use DB). */
  bookWinRatePct?: number | null,
): {
  pnlUsd: number;
  volumeUsd: number;
  openPositions: number;
  winRatePct: number | null;
  balanceUsd: number | null;
} {
  const dbOpen = dbStats?.openPositions ?? live.openSymbols.length;
  const dbPnl = dbStats?.realizedPnlUsd ?? 0;
  const dbVolume = dbStats?.volumeUsd ?? 0;
  const winRatePct =
    bookWinRatePct !== undefined
      ? bookWinRatePct
      : dbStats?.winRatePct != null && Number.isFinite(dbStats.winRatePct)
        ? dbStats.winRatePct
        : 0;

  // Dedicated: HL book PnL on the sub (same series as showcase / explorer).
  // Includes agent + manual fills on that book; deposits do not inflate it.
  // Shared: stay attributed — master is mixed across you + every Shared agent.
  if (agent.mode === 'dedicated') {
    const hlPnl = hlSummary?.allTimePnl;
    const bookPnl =
      hlPnl != null && Number.isFinite(hlPnl)
        ? hlPnl
        : dbPnl + unrealizedForSymbols(live.dedicatedState, live.openSymbols);
    return {
      openPositions: countAgentBookLivePositions({
        dedicated: true,
        configuredSymbols: agent.config.symbols ?? [],
        trackedSymbols: live.openSymbols,
        state: live.dedicatedState,
        dbOpenCount: dbOpen,
      }),
      pnlUsd: bookPnl,
      volumeUsd: hlSummary?.allTimeVlm ?? dbVolume,
      winRatePct,
      balanceUsd:
        live.dedicatedBalanceUsd !== undefined
          ? live.dedicatedBalanceUsd
          : live.dedicatedState && Number.isFinite(live.dedicatedState.accountValueUsd)
            ? live.dedicatedState.accountValueUsd
            : null,
    };
  }

  const unrealized = unrealizedForSymbols(live.masterState, live.openSymbols);
  return {
    openPositions: countAgentBookLivePositions({
      dedicated: false,
      configuredSymbols: agent.config.symbols ?? [],
      trackedSymbols: live.openSymbols,
      state: live.masterState,
      dbOpenCount: dbOpen,
    }),
    pnlUsd: dbPnl + unrealized,
    volumeUsd: dbVolume,
    winRatePct,
    balanceUsd: null,
  };
}

function AgentPerformanceRow({
  perf,
  statsLoading = false,
  balanceLoading = false,
  formatPnl,
  formatVolume,
  formatBalance,
  dimmed = false,
  onPressLivePositions,
  onPressBalance,
  t,
}: {
  perf: {
    pnlUsd: number;
    volumeUsd: number;
    openPositions: number;
    winRatePct: number | null;
    balanceUsd: number | null;
  };
  /** Waiting on /stats + live HL — show dots instead of snapping 0 → real values. */
  statsLoading?: boolean;
  /** Dedicated sub balance still fetching — keep this row on dots independently. */
  balanceLoading?: boolean;
  formatPnl: (n: number | null | undefined) => string;
  formatVolume: (n: number | null | undefined) => string;
  formatBalance: (n: number | null | undefined) => string;
  /** Paused/stopped/revoked — dim stats, but keep Transfer (balance) full opacity when tappable. */
  dimmed?: boolean;
  onPressLivePositions: () => void;
  /** Dedicated: tap balance opens Transfer sheet (no extra chrome on the card). */
  onPressBalance?: () => void;
  t: TFunction;
}) {
  const pnlColor =
    Math.abs(perf.pnlUsd) < 0.005
      ? colors.text.tertiary
      : perf.pnlUsd > 0
        ? colors.status.success
        : colors.status.error;
  const showBalance = perf.balanceUsd != null || !!onPressBalance || balanceLoading;
  const winRateLabel = (() => {
    const n =
      perf.winRatePct == null || !Number.isFinite(perf.winRatePct) ? 0 : perf.winRatePct;
    if (Math.abs(n) < 0.005) return '0.00%';
    return `${Number.isInteger(n) ? String(n) : n.toFixed(1)}%`;
  })();
  /** Dark card → muted dots (matches value text, not white). */
  const dotsOnCard = colors.text.tertiary;

  const balanceInner = (
    <LinearGradient
      colors={STAT_CARD_GRADIENT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.balanceCard}
    >
      <View style={styles.balanceLabelRow}>
        <Text style={styles.statLabel}>{t('aiAgents.dedicatedBalance')}</Text>
        {onPressBalance ? (
          <Ionicons name="swap-horizontal" size={12} color={colors.accent.gold} />
        ) : null}
      </View>
      {balanceLoading ? (
        <View style={styles.statValueLoading}>
          <BouncingDots color={dotsOnCard} dotSize={3} pulse />
        </View>
      ) : (
        <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {formatBalance(perf.balanceUsd)}
        </Text>
      )}
    </LinearGradient>
  );

  return (
    <View style={styles.statsBlock}>
      {showBalance ? (
        onPressBalance ? (
          <TouchableOpacity
            onPress={onPressBalance}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={t('aiAgents.dedicatedBalance')}
            accessibilityHint={t('aiAgents.dedicatedTransferHint')}
          >
            {balanceInner}
          </TouchableOpacity>
        ) : (
          <View style={dimmed ? styles.stoppedDim : undefined}>{balanceInner}</View>
        )
      ) : null}
      <View style={[styles.statsGrid, dimmed && styles.stoppedDim]}>
        <View style={styles.statsRow}>
          <View style={styles.statCardSlot}>
            <LinearGradient colors={STAT_CARD_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.statCard}>
              <Text style={styles.statLabel}>{t('portfolio.netPnl')}</Text>
              {statsLoading ? (
                <View style={styles.statValueLoading}>
                  <BouncingDots color={dotsOnCard} dotSize={3} />
                </View>
              ) : (
                <Text style={[styles.statValue, { color: pnlColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                  {formatPnl(perf.pnlUsd)}
                </Text>
              )}
            </LinearGradient>
          </View>
          <View style={styles.statCardSlot}>
            <LinearGradient colors={STAT_CARD_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.statCard}>
              <Text style={styles.statLabel}>{t('portfolio.totalVolume')}</Text>
              {statsLoading ? (
                <View style={styles.statValueLoading}>
                  <BouncingDots color={dotsOnCard} dotSize={3} />
                </View>
              ) : (
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                  {formatVolume(perf.volumeUsd)}
                </Text>
              )}
            </LinearGradient>
          </View>
        </View>
        <View style={styles.statsRow}>
          <View style={styles.statCardSlot}>
            <LinearGradient colors={STAT_CARD_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.statCard}>
              <Text style={styles.statLabel}>{t('portfolio.winRate')}</Text>
              {statsLoading ? (
                <View style={styles.statValueLoading}>
                  <BouncingDots color={dotsOnCard} dotSize={3} />
                </View>
              ) : (
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                  {winRateLabel}
                </Text>
              )}
            </LinearGradient>
          </View>
          <TouchableOpacity style={styles.statCardSlot} onPress={onPressLivePositions} activeOpacity={0.85}>
            <LinearGradient colors={STAT_CARD_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.statCard}>
              <View style={styles.livePositionsLabelRow}>
                <Text style={styles.statLabel}>{t('home.livePositions')}</Text>
                <Ionicons name="chevron-forward" size={11} color={colors.text.tertiary} style={styles.livePositionsChevron} />
              </View>
              {statsLoading ? (
                <View style={styles.statValueLoading}>
                  <BouncingDots color={dotsOnCard} dotSize={3} />
                </View>
              ) : (
                <Text style={styles.statValue}>{perf.openPositions}</Text>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function AgentConfigBadges({ agent, t }: { agent: AiAgentView; t: TFunction }) {
  const { config } = agent;
  const margin = config.margin_mode ?? 'cross';
  // /pos badge only useful when an agent spans multiple markets.
  const hasMaxPos =
    config.symbols.length > 1 &&
    config.max_position_usd != null &&
    config.max_position_usd > 0;
  const marginLabel = margin === 'isolated' ? t('trading.isolated') : t('trading.cross');
  const horizonLabel =
    config.horizon === 'investor'
      ? t('aiAgents.horizonInvestor')
      : config.horizon === 'swing'
        ? t('aiAgents.horizonSwing')
        : t('aiAgents.horizonScalper');
  const direction = config.direction ?? 'long_short';
  const mandate = config.mandate ?? 'active';
  const directionLabel =
    direction === 'long_only'
      ? t('aiAgents.directionLongBadge')
      : direction === 'short_only'
        ? t('aiAgents.directionShortBadge')
        : t('aiAgents.directionFreeForm');
  const oneSided = direction === 'long_only' || direction === 'short_only';
  const styleLabel =
    oneSided && mandate === 'accumulate'
      ? `${directionLabel} · ${t('aiAgents.mandateAccumulateBadge')}`
      : directionLabel;
  // Model + symbols shown via logos next to agent name — omitted here to save space.

  return (
    <View style={styles.badgeRow}>
      <View style={styles.metaBadge}>
        <Text style={styles.metaBadgeText}>
          {horizonLabel}
          <Text style={styles.metaBadgeSep}> | </Text>
          {styleLabel}
        </Text>
      </View>
      <View style={styles.metaBadge}>
        <Text style={styles.metaBadgeText}>
          {marginLabel}
          <Text style={styles.metaBadgeSep}> | </Text>
          {config.leverage_cap}x
        </Text>
      </View>
      <View style={styles.metaBadge}>
        <Text style={styles.metaBadgeText}>
          ${formatUsdCompact(config.max_capital_usd)}
          {hasMaxPos ? (
            <>
              <Text style={styles.metaBadgeSep}> | </Text>
              ≤${formatUsdCompact(config.max_position_usd!)}/pos
            </>
          ) : null}
        </Text>
      </View>
    </View>
  );
}

/** Body copy for the degraded chip info sheet — never implies the agent stopped. */
function degradedHealthBody(health: AiAgentHealth | null | undefined, t: TFunction): string {
  const reasons = health?.reasons ?? [];
  const parts: string[] = [t('aiAgents.degradedBodyIntro')];
  if (reasons.includes('market_data_unavailable')) {
    parts.push(t('aiAgents.degradedReasonMarketData'));
  }
  if (reasons.includes('llm_errors')) {
    parts.push(t('aiAgents.degradedReasonLlm'));
  }
  if (reasons.includes('exit_retrying')) {
    parts.push(t('aiAgents.degradedReasonExit'));
  }
  if (parts.length === 1) {
    parts.push(t('aiAgents.degradedReasonGeneric'));
  }
  parts.push(t('aiAgents.degradedBodyFooter'));
  return parts.join('\n\n');
}

/** One badge: `ACTIVE | DED` / `STOPPED | SHR` (short mode keeps the name usable). */
function formatAgentStatus(agent: AiAgentView, t: TFunction): string {
  const base = t(`aiAgents.status.${agent.status}`);
  const withShadow =
    agent.status === 'active' && agent.dryRun
      ? `${base} · ${t('aiAgents.shadowBadge')}`
      : base;
  if (!DEDICATED_MODE_ENABLED) {
    return agent.mode === 'dedicated'
      ? `${withShadow} | ${t('aiAgents.dedicatedShort')}`
      : withShadow;
  }
  const mode =
    agent.mode === 'dedicated' ? t('aiAgents.dedicatedShort') : t('aiAgents.sharedShort');
  return `${withShadow} | ${mode}`;
}

function statusStyle(status: AiAgentView['status']) {
  switch (status) {
    case 'active':
      return { backgroundColor: 'rgba(16,185,129,0.15)' };
    case 'draft':
      return { backgroundColor: 'rgba(255,179,0,0.15)' };
    case 'revoked':
      return { backgroundColor: 'rgba(239,68,68,0.18)' };
    default:
      return { backgroundColor: colors.background.tertiary };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  /** Equal flex sides keep the title optically centered with FAQ + add on the right. */
  headerSide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSideRight: {
    justifyContent: 'flex-end',
    gap: 14,
  },
  headerCenter: {
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    maxWidth: '55%',
  },
  title: {
    color: colors.text.primary,
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  slotsUsage: {
    marginTop: 2,
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  scroll: { padding: 16, paddingBottom: 48, gap: 12 },
  card: {
    backgroundColor: colors.background.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 14,
    marginBottom: 12,
  },
  cardHeader: { gap: 0 },
  cardHeaderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  statusCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    maxWidth: '58%',
  },
  statusControlIcon: {
    width: 26,
    height: 26,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusControlDivider: {
    width: StyleSheet.hairlineWidth,
    height: 16,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 6,
  },
  cardActivityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
  },
  cardActivityLeft: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  cardActivityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  cardActivityText: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: '700',
  },
  degradedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
  },
  degradedChipText: {
    color: colors.status.warning,
    fontSize: 11,
    fontWeight: '800',
  },
  cardBadgesRow: {
    marginTop: 6,
  },
  cardBadgesRowWithRevoke: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardBadgesMain: {
    flex: 1,
    minWidth: 0,
  },
  sidelinedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.status.warning,
    backgroundColor: `${colors.status.warning}18`,
  },
  sidelinedChipText: {
    color: colors.status.warning,
    fontSize: 11,
    fontWeight: '700',
  },
  cardMetaLeft: { flex: 1, minWidth: 0 },
  cardMetaActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
    gap: 6,
    flexShrink: 0,
  },
  cardMetaActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    minWidth: 52,
    alignItems: 'center',
    flexShrink: 0,
  },
  cardMetaActionText: {
    color: colors.text.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  cardMetaActionDanger: {
    color: colors.status.error,
  },
  cardTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  cardTitleNameCluster: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  cardTitleModelLogo: {
    width: 18,
    height: 18,
    borderRadius: 4,
    flexShrink: 0,
  },
  cardSymbolNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    flexShrink: 0,
  },
  cardMultiSymbolsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(92,225,230,0.35)',
    backgroundColor: 'rgba(92,225,230,0.1)',
    flexShrink: 0,
  },
  cardMultiSymbolsCount: {
    color: colors.accent.gold,
    fontSize: 11,
    fontWeight: '800',
  },
  symbolNavOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  symbolNavCard: {
    backgroundColor: colors.background.secondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
  },
  symbolNavTitle: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 10,
  },
  symbolNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.primary,
  },
  symbolNavRowText: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  cardTitleSymbolLogo: {
    backgroundColor: 'transparent',
    borderRadius: 4,
    flexShrink: 0,
  },
  cardTitle: {
    flexShrink: 1,
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '800',
    minWidth: 48,
  },
  renamePencil: { padding: 2, flexShrink: 0 },
  renameInput: {
    flex: 1,
    minWidth: 120,
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '800',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.accent.gold,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  renameActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  stoppedDim: { opacity: 0.45 },
  filterBlock: { gap: 12, marginBottom: 8 },
  statusSegment: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  statusSegmentItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusSegmentItemActive: {
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  statusSegmentText: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '700',
  },
  statusSegmentTextActive: {
    color: colors.text.primary,
    fontWeight: '800',
  },
  symbolFilterScrollWrap: {
    position: 'relative',
  },
  symbolFilterRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 16,
    paddingHorizontal: 2,
    paddingRight: 20,
  },
  symbolFilterFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 24,
  },
  symbolTab: {
    paddingBottom: 6,
    alignItems: 'center',
  },
  symbolTabText: {
    color: colors.text.tertiary,
    fontSize: 12,
    fontWeight: '600',
  },
  symbolTabTextActive: {
    color: colors.text.primary,
    fontWeight: '800',
  },
  symbolTabUnderline: {
    marginTop: 5,
    height: 2,
    width: '100%',
    borderRadius: 1,
    backgroundColor: colors.text.primary,
  },
  filterEmpty: {
    color: colors.text.tertiary,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 24,
    marginBottom: 12,
  },
  metaBadgesOuter: {
    gap: 5,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 5,
  },
  metaBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    maxWidth: '100%',
    flexShrink: 1,
  },
  metaBadgeText: {
    color: colors.text.secondary,
    fontSize: 10,
    fontWeight: '700',
    flexShrink: 1,
  },
  metaBadgeSep: {
    color: 'rgba(255,255,255,0.28)',
    fontSize: 10,
    fontWeight: '600',
  },
  agentCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 14,
    marginBottom: 12,
    overflow: 'hidden',
  },
  statsBlock: {
    marginTop: 10,
    gap: 6,
  },
  balanceCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    overflow: 'hidden',
    gap: 4,
  },
  balanceLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  statsGrid: {
    gap: 6,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 6,
  },
  /** Equal flex slot so every card (View or Touchable) gets the same width/height. */
  statCardSlot: {
    flex: 1,
    height: 68,
  },
  statCard: {
    flex: 1,
    width: '100%',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    gap: 4,
  },
  livePositionsLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  livePositionsChevron: {
    marginTop: -1,
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.text.tertiary,
    textAlign: 'center',
  },
  statValue: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
  },
  statValueLoading: {
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusPill: {
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 8,
    flexShrink: 1,
    maxWidth: 128,
  },
  statusText: {
    color: colors.text.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  hint: { color: colors.text.tertiary, fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 8 },
  input: {
    backgroundColor: colors.background.tertiary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    color: colors.text.primary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    marginTop: 8,
  },
  inputError: { borderColor: colors.status.error },
  inputLocked: { opacity: 0.55 },
  errorHint: { color: colors.status.error, fontSize: 10, fontWeight: '700', marginTop: 6 },
  warnHint: { color: colors.status.warning, fontSize: 10, fontWeight: '700', marginTop: 6 },
  draftActions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    marginTop: 12,
  },
  draftActionBtn: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    marginTop: 0,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftActionBtnSecondary: {
    backgroundColor: colors.background.tertiary,
    borderColor: colors.border.primary,
  },
  draftActionBtnPrimary: {
    backgroundColor: colors.accent.gold,
    borderColor: colors.accent.gold,
  },
  draftActionTextSecondary: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  draftActionTextPrimary: {
    color: colors.background.primary,
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
  },
  fieldLabel: { color: colors.text.primary, fontSize: 12, fontWeight: '800', flexShrink: 1 },
  fieldInfoBtn: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coinglassSavedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.secondary,
  },
  coinglassMasked: {
    color: colors.text.secondary,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.5,
    flexShrink: 1,
  },
  coinglassReplaceText: {
    color: colors.accent.gold,
    fontSize: 12,
    fontWeight: '800',
  },
  coinglassEditBlock: { gap: 8 },
  coinglassKeepLink: { alignSelf: 'flex-start' },
  requiredMark: { color: colors.status.error, fontWeight: '800' },
  optionalMark: { color: colors.text.tertiary, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'flex-start' },
  rowInput: { flex: 1, minWidth: 0 },
  rowFieldLabel: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
    minHeight: 15,
  },
  rowInputField: { marginTop: 0 },
  nameInput: { marginTop: 6 },
  pillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.accent.gold,
  },
  chipConflict: {
    backgroundColor: colors.status.error,
  },
  chipText: { color: colors.background.primary, fontSize: 12, fontWeight: '900' },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
  },
  suggestionSymbol: { color: colors.text.primary, fontSize: 13, fontWeight: '800', minWidth: 52 },
  suggestionName: { color: colors.text.tertiary, fontSize: 11, flex: 1 },
  suggestionLev: { color: colors.text.secondary, fontSize: 11, fontWeight: '700' },
  suggestionRowDisabled: { opacity: 0.55 },
  suggestionMuted: { color: colors.text.muted },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  modelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  modelPillLogo: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  modelPillLogoMuted: { opacity: 0.55 },
  modelSoonBadge: {
    marginLeft: 2,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.background.secondary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  modelSoonBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: colors.text.tertiary,
  },
  pillActive: { backgroundColor: colors.accent.gold, borderColor: colors.accent.gold },
  pillDisabled: { opacity: 0.4 },
  pillText: { color: colors.text.secondary, fontSize: 12, fontWeight: '700' },
  pillTextActive: { color: colors.background.primary },
  pillTextDisabled: { color: colors.text.muted },
  primary: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.accent.gold,
  },
  primaryDisabled: { opacity: 0.45 },
  primaryText: { color: colors.background.primary, fontSize: 13, fontWeight: '900' },
  shadowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  dedicatedBlock: { marginTop: 14, gap: 2 },
  dedicatedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minHeight: 28,
  },
  dedicatedLabelRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dedicatedLabelLocked: { color: colors.text.tertiary, fontWeight: '700' },
  dedicatedSwitchLocked: { opacity: 0.4 },
  /** Tighter than `hint` — sits directly under the dedicated toggle row. */
  dedicatedHint: {
    color: colors.text.tertiary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 0,
    marginBottom: 0,
  },
  controlLabel: { color: colors.text.secondary, fontSize: 12, fontWeight: '700' },
  secondary: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  secondaryText: { color: colors.text.primary, fontSize: 12, fontWeight: '700' },
  decisionsToggle: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.accent.gold,
  },
  decisionsToggleActive: {
    backgroundColor: colors.accent.goldDark,
  },
  decisionsToggleText: {
    color: colors.background.primary,
    fontSize: 13,
    fontWeight: '900',
  },
  decisionSymbolChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  decisionSymbolChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
  },
  decisionSymbolChipActive: {
    borderColor: colors.accent.goldDark,
    backgroundColor: 'rgba(92,225,230,0.12)',
  },
  decisionSymbolChipText: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '700',
  },
  decisionSymbolChipTextActive: {
    color: colors.accent.gold,
    fontWeight: '800',
  },
  decisions: {
    marginTop: 10,
    gap: 8,
  },
  decisionCard: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    padding: 10,
  },
  decisionCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  decisionSymbol: {
    flex: 1,
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: '800',
  },
  decisionConviction: {
    marginTop: 4,
    fontSize: 11,
    lineHeight: 15,
  },
  decisionConvictionLabel: {
    color: colors.text.tertiary,
    fontWeight: '600',
  },
  decisionConvictionValue: {
    color: colors.text.primary,
    fontWeight: '700',
  },
  decisionBody: {
    color: colors.text.secondary,
    fontSize: 11,
    lineHeight: 16,
  },
  decisionBodyMuted: {
    color: colors.text.muted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
    fontStyle: 'italic',
  },
  decisionTimeCol: {
    alignItems: 'flex-end',
    flexShrink: 0,
    gap: 1,
  },
  decisionTime: { color: colors.text.muted, fontSize: 10, lineHeight: 13 },
  loadMoreDecisions: {
    marginTop: 2,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  loadMoreDecisionsText: {
    color: colors.accent.gold,
    fontSize: 12,
    fontWeight: '800',
  },
  showMoreAgents: {
    marginTop: 4,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  showMoreAgentsText: {
    color: colors.accent.gold,
    fontSize: 13,
    fontWeight: '800',
  },
});
