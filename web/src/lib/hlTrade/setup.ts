/**
 * Seamless setup — same three steps as
 * `inspectSeamlessSetupStatus` / `setupTradingAccount` in
 * `frontend/src/lib/hyperliquid.ts`:
 *   1. approveAgent (Privy EOA)
 *   2. approveBuilderFee max 0.1% for the tenant builder (else platform)
 *   3. userSetAbstraction unifiedAccount (needed for HIP-3 cross)
 *
 * Agent name is `HyperTrade Web` so we do not replace the mobile agent.
 */
import { HL_BUILDER_MAX_FEE_RATE, WEB_AGENT_NAME, orderBuilderAddress, type Hex } from './constants';
import { ensureWebAgentKey, loadStoredAgent, markWebAgentApproved } from './agent';
import { getHlInfoClient, hlInfo, withUserSignedExchange } from './clients';
import type { Eip1193Provider } from './wallet';

export type SetupStatus = {
  agent: boolean;
  builderFee: boolean;
  accountMode: boolean;
  /** Agent + unified. Silent auto-setup target — `b` is per-app. */
  accountReady: boolean;
  /** accountReady + builder fee for the given `b`. */
  allComplete: boolean;
  agentValidUntil: number | null;
};

const SETUP_CONFIRM_MS = 20_000;
const SETUP_POLL_MS = 1_200;

/**
 * Verified-ready cache. Once HL has confirmed agent + builder fee + unified
 * for a (user, builder, fee) key, later order clicks skip the ~6 `/info`
 * round-trips and go straight to signing — same idea as mobile, which
 * assumes setup is done after first run. Any order-path failure calls
 * {@link invalidateTradingReady} so the next click re-verifies on chain.
 */
const READY_TTL_MS = 10 * 60_000;
/** Do not trust the cache when the agent is close to expiry. */
const AGENT_MIN_REMAINING_MS = 60 * 60_000;

type ReadyEntry = { agentAddress: Hex; agentValidUntil: number; verifiedAt: number };
const readyCache = new Map<string, ReadyEntry>();

const setupInflight = new Map<string, Promise<{ agentPrivateKey: Hex; agentAddress: Hex }>>();

function setupKey(args: {
  userAddress: Hex;
  requiredFeeTenths: number;
  builderAddress?: string | null;
  skipBuilderFee?: boolean;
}): string {
  if (args.skipBuilderFee) return `${args.userAddress}:account`;
  return `${args.userAddress}:${orderBuilderAddress(args.builderAddress)}:${args.requiredFeeTenths}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rememberReady(key: string, agentAddress: Hex, agentValidUntil: number | null): void {
  if (!Number.isFinite(agentValidUntil) || (agentValidUntil as number) <= Date.now()) return;
  readyCache.set(key, { agentAddress, agentValidUntil: agentValidUntil as number, verifiedAt: Date.now() });
}

/**
 * Fast path: return the stored agent key without touching HL when this exact
 * (user, builder, fee) was verified recently and the agent is not near expiry.
 */
function readCachedReady(key: string, userAddress: Hex): { agentPrivateKey: Hex; agentAddress: Hex } | null {
  const entry = readyCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.verifiedAt > READY_TTL_MS || entry.agentValidUntil - now < AGENT_MIN_REMAINING_MS) {
    readyCache.delete(key);
    return null;
  }
  const stored = loadStoredAgent(userAddress);
  if (!stored || stored.agentAddress.toLowerCase() !== entry.agentAddress.toLowerCase()) {
    readyCache.delete(key);
    return null;
  }
  return { agentPrivateKey: stored.agentPrivateKey, agentAddress: stored.agentAddress };
}

/** Drop cached readiness so the next `ensureTradingReady` re-verifies on chain. */
export function invalidateTradingReady(userAddress?: Hex): void {
  if (!userAddress) {
    readyCache.clear();
    return;
  }
  const prefix = `${userAddress}:`.toLowerCase();
  for (const key of Array.from(readyCache.keys())) {
    if (key.toLowerCase().startsWith(prefix)) readyCache.delete(key);
  }
}

type AbstractionMode = 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default' | 'dexAbstraction' | string;

function isPooledAccountMode(mode: string | null | undefined): boolean {
  return mode === 'unifiedAccount' || mode === 'portfolioMargin';
}

export async function listHlExtraAgents(userAddress: Hex): Promise<Array<{ name: string; address: Hex; validUntil: number }>> {
  const res = await getHlInfoClient().extraAgents({ user: userAddress });
  if (!Array.isArray(res)) return [];
  const now = Date.now();
  return res
    .map((a) => ({
      name: String(a?.name ?? ''),
      address: a?.address as Hex,
      validUntil: Number(a?.validUntil ?? 0),
    }))
    .filter((a) => a.name && a.address && a.validUntil > now);
}

export async function getApprovedBuilderFeeTenths(
  userAddress: Hex,
  builderAddress?: string | null,
): Promise<number> {
  const info = getHlInfoClient();
  const value = await info.maxBuilderFee({
    user: userAddress,
    builder: orderBuilderAddress(builderAddress),
  });
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`maxBuilderFee returned invalid value: ${String(value)}`);
  }
  return n;
}

export async function getUserAbstractionMode(userAddress: Hex): Promise<AbstractionMode | null> {
  try {
    const data = await hlInfo<unknown>({ type: 'userAbstraction', user: userAddress });
    if (typeof data === 'string' && data) return data;
    if (data && typeof data === 'object' && 'abstraction' in data) {
      const mode = String((data as { abstraction?: unknown }).abstraction ?? '');
      return mode || null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function inspectSetupStatus(
  userAddress: Hex,
  requiredFeeTenths: number,
  builderAddress?: string | null,
  skipBuilderFee = false,
): Promise<SetupStatus> {
  const extras = await listHlExtraAgents(userAddress);
  const stored = loadStoredAgent(userAddress);
  const match = extras.find(
    (a) => !!stored && a.address.toLowerCase() === stored.agentAddress.toLowerCase(),
  );
  const agent = !!match;
  let builderFee = false;
  if (!skipBuilderFee) {
    try {
      const approved = await getApprovedBuilderFeeTenths(userAddress, builderAddress);
      builderFee = approved > 0 && approved >= requiredFeeTenths;
    } catch {
      builderFee = false;
    }
  }
  const mode = await getUserAbstractionMode(userAddress);
  const accountMode = isPooledAccountMode(mode);
  const accountReady = agent && accountMode;
  const allComplete = accountReady && builderFee;
  const agentValidUntil = match?.validUntil ?? null;
  // This is the same on-chain check the order path needs; prime the fast path.
  if (match && (skipBuilderFee ? accountReady : allComplete)) {
    rememberReady(
      setupKey({ userAddress, requiredFeeTenths, builderAddress, skipBuilderFee }),
      match.address,
      agentValidUntil,
    );
  }
  return {
    agent,
    builderFee,
    accountMode,
    accountReady,
    allComplete,
    agentValidUntil,
  };
}

export async function ensureTradingReady(args: {
  provider: Eip1193Provider;
  userAddress: Hex;
  requiredFeeTenths: number;
  builderAddress?: string | null;
  /** HD0 silent setup: agent + unified only. Order path approves `tenant.builder_address`. */
  skipBuilderFee?: boolean;
  onStep?: (label: string) => void;
}): Promise<{ agentPrivateKey: Hex; agentAddress: Hex }> {
  const key = setupKey(args);
  const cached = readCachedReady(key, args.userAddress);
  if (cached) return cached;
  const existing = setupInflight.get(key);
  if (existing) return existing;
  const pending = runEnsureTradingReady(args)
    .then((res) => {
      rememberReady(key, res.agentAddress, res.agentValidUntil);
      return { agentPrivateKey: res.agentPrivateKey, agentAddress: res.agentAddress };
    })
    .finally(() => {
      setupInflight.delete(key);
    });
  setupInflight.set(key, pending);
  return pending;
}

async function runEnsureTradingReady(args: {
  provider: Eip1193Provider;
  userAddress: Hex;
  requiredFeeTenths: number;
  builderAddress?: string | null;
  skipBuilderFee?: boolean;
  onStep?: (label: string) => void;
}): Promise<{ agentPrivateKey: Hex; agentAddress: Hex; agentValidUntil: number | null }> {
  const builder = orderBuilderAddress(args.builderAddress);
  const skipBuilderFee = !!args.skipBuilderFee;
  const extras = await listHlExtraAgents(args.userAddress);
  const storedAddr = loadStoredAgent(args.userAddress)?.agentAddress;
  const onChain = !!storedAddr && extras.some((a) => a.address.toLowerCase() === storedAddr.toLowerCase());
  const agent = ensureWebAgentKey(args.userAddress, onChain);

  if (!onChain) {
    args.onStep?.('Approve trading agent');
    await withUserSignedExchange(args.provider, args.userAddress, (exchange) =>
      exchange.approveAgent({ agentAddress: agent.agentAddress, agentName: WEB_AGENT_NAME }),
    );
    markWebAgentApproved(args.userAddress, agent.agentAddress);
  }

  if (!skipBuilderFee) {
    let approvedTenths = 0;
    try {
      approvedTenths = await getApprovedBuilderFeeTenths(args.userAddress, builder);
    } catch {
      approvedTenths = 0;
    }
    if (approvedTenths <= 0 || approvedTenths < args.requiredFeeTenths) {
      args.onStep?.('Approve builder fee');
      await withUserSignedExchange(args.provider, args.userAddress, (exchange) =>
        exchange.approveBuilderFee({
          builder,
          maxFeeRate: HL_BUILDER_MAX_FEE_RATE,
        }),
      );
    }
  }

  const mode = await getUserAbstractionMode(args.userAddress);
  if (!isPooledAccountMode(mode)) {
    args.onStep?.('Enable unified account');
    await withUserSignedExchange(args.provider, args.userAddress, (exchange) =>
      exchange.userSetAbstraction({
        user: args.userAddress,
        abstraction: 'unifiedAccount',
      }),
    );
  }

  args.onStep?.('Confirming on Hyperliquid');
  const deadline = Date.now() + SETUP_CONFIRM_MS;
  let status = await inspectSetupStatus(
    args.userAddress,
    args.requiredFeeTenths,
    builder,
    skipBuilderFee,
  );
  const ready = () => (skipBuilderFee ? status.accountReady : status.allComplete);
  while (!ready() && Date.now() < deadline) {
    await sleep(SETUP_POLL_MS);
    status = await inspectSetupStatus(
      args.userAddress,
      args.requiredFeeTenths,
      builder,
      skipBuilderFee,
    );
  }
  if (!ready()) {
    throw new Error('Trading setup did not confirm on Hyperliquid. Try again.');
  }

  return {
    agentPrivateKey: agent.agentPrivateKey,
    agentAddress: agent.agentAddress,
    agentValidUntil: status.agentValidUntil,
  };
}
