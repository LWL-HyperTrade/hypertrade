/**
 * PONS v2 ONLY.
 * Canonical docs: https://docs.ponsfamily.com/v2
 * Do NOT follow https://docs.ponsfamily.com/ — that is v1.
 * Each function mirrors a v2 Integration snippet (section in the comment).
 */
import { encodeAbiParameters, formatUnits, keccak256, type Address } from 'viem';
import { CURVE_ABI, ERC20_ABI, ESCROW_ABI, FACTORY_ABI, HOOK_ABI } from './abi';
import { getRobinhoodPublicClient, isNativeQuote, PONS } from './chain';

/** Robinhood WETH — price native quote fees into USD via Dexscreener. */
const ROBINHOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;
const STABLE_SYMBOLS = new Set(['USDG', 'USDC', 'USDT', 'DAI', 'USD']);

export type LaunchConfig = {
  id: bigint;
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
};

/** Launching a token → Enumerating launch configs. Only `enabled` configs are offered. */
export async function openLaunchConfigs(): Promise<LaunchConfig[]> {
  const client = getRobinhoodPublicClient();
  const count = await client.readContract({
    address: PONS.factory,
    abi: FACTORY_ABI,
    functionName: 'launchConfigCount',
  });
  const configs = await Promise.all(
    Array.from({ length: Number(count) }, (_, id) =>
      client.readContract({
        address: PONS.factory,
        abi: FACTORY_ABI,
        functionName: 'getLaunchConfig',
        args: [BigInt(id)],
      }),
    ),
  );
  return configs
    .map((config, id) => ({ id: BigInt(id), ...config }))
    .filter((config) => config.enabled);
}

/** Bonding-curve trade fee (bps) for a live curve — distinct from creator tax. */
export async function fetchCurveTradeFeeBps(curve: Address): Promise<number> {
  const client = getRobinhoodPublicClient();
  const fee = await client.readContract({
    address: curve,
    abi: CURVE_ABI,
    functionName: 'feeBps',
  });
  const n = Number(fee);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** Launching a token → `canLaunch(address)`. False while the public gate is closed and the address is not whitelisted. */
export async function canLaunch(account: Address): Promise<boolean> {
  return getRobinhoodPublicClient().readContract({
    address: PONS.factory,
    abi: FACTORY_ABI,
    functionName: 'canLaunch',
    args: [account],
  });
}

export type PairEconomics = { phantomQuote: bigint; graduationThreshold: bigint; decimals: number };

/** Launching a token → Choosing a quote asset. Skip an asset that fails either read. */
export async function usableQuoteAsset(pairToken: Address): Promise<PairEconomics | null> {
  const client = getRobinhoodPublicClient();
  const [approved, economics] = await Promise.all([
    client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'approvedPairTokens', args: [pairToken] }),
    client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'pairTokenEconomics', args: [pairToken] }),
  ]);
  const [phantomQuote, graduationThreshold, decimals] = economics;
  if (!approved || phantomQuote === 0n || graduationThreshold === 0n) return null;
  return { phantomQuote, graduationThreshold, decimals: Number(decimals) };
}

export type LaunchTerms = {
  config: LaunchConfig;
  launchFee: bigint;
  expectedEconomics: `0x${string}`;
  maxCreatorTaxBps: number;
  /** Reserves the curve opens with. Native → config; ERC-20 → pairTokenEconomics (docs: economics are per asset). */
  phantomQuote: bigint;
  graduationThreshold: bigint;
  quoteDecimals: number;
};

/**
 * Everything `launchToken` / `launchAndBuy` needs, read immediately before the
 * tx so the `expectedEconomics` pin is fresh (docs: "Pass an economics pin so a
 * launch cannot settle on terms you did not read").
 */
export async function readLaunchTerms(pairToken: Address, configId?: bigint): Promise<LaunchTerms> {
  const client = getRobinhoodPublicClient();
  const id = configId ?? 0n;
  const raw = await client.readContract({
    address: PONS.factory,
    abi: FACTORY_ABI,
    functionName: 'getLaunchConfig',
    args: [id],
  });
  const config: LaunchConfig = { id, ...raw };
  if (!config.enabled) throw new Error('That Pons launch config is no longer enabled.');

  const [expectedEconomics, launchFee, maxTax] = await Promise.all([
    client.readContract({
      address: PONS.factory,
      abi: FACTORY_ABI,
      functionName: 'previewLaunchEconomics',
      args: [config.id, pairToken],
    }),
    client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'launchFee' }),
    client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'maxCreatorTaxBps' }),
  ]);

  let phantomQuote = config.phantomQuote;
  let graduationThreshold = config.graduationThreshold;
  let quoteDecimals = 18;
  if (!isNativeQuote(pairToken)) {
    const eco = await usableQuoteAsset(pairToken);
    if (!eco) throw new Error('That quote asset is not approved by Pons.');
    phantomQuote = eco.phantomQuote;
    graduationThreshold = eco.graduationThreshold;
    quoteDecimals = eco.decimals;
  }

  return {
    config,
    launchFee,
    expectedEconomics,
    maxCreatorTaxBps: Number(maxTax),
    phantomQuote,
    graduationThreshold,
    quoteDecimals,
  };
}

export type LaunchedToken = {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  /** Docs: pool fee is zero — the hook charges, not the Uniswap pool. */
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued */
  phase: number;
  exists: boolean;
};

/** Reading state → Reading the launch record. */
export async function getLaunchedToken(token: Address): Promise<LaunchedToken> {
  const r = await getRobinhoodPublicClient().readContract({
    address: PONS.factory,
    abi: FACTORY_ABI,
    functionName: 'getLaunchedToken',
    args: [token],
  });
  return {
    token: r.token,
    curve: r.curve,
    deployer: r.deployer,
    creatorFeeRecipient: r.creatorFeeRecipient,
    pairToken: r.pairToken,
    graduationThreshold: r.graduationThreshold,
    poolFee: Number(r.poolFee),
    tickSpacing: Number(r.tickSpacing),
    creatorTaxBps: Number(r.creatorTaxBps),
    buybackEnabled: r.buybackEnabled,
    phase: Number(r.phase),
    exists: r.exists,
  };
}

/**
 * Uniswap v4 pools → Reconstructing the pool. Native ETH is address(0)
 * and always sorts into currency0.
 */
export function poolIdForLaunch(launch: LaunchedToken): `0x${string}` {
  const [currency0, currency1] =
    launch.pairToken.toLowerCase() < launch.token.toLowerCase()
      ? [launch.pairToken, launch.token]
      : [launch.token, launch.pairToken];
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [currency0, currency1, launch.poolFee, launch.tickSpacing, PONS.memeHook],
    ),
  );
}

export type CreatorFees = {
  /** Escrow balance, already claimable. */
  claimable: bigint;
  /** Quote-asset fees still sitting on the curve (phase 0) or hook (phase 2) until a sweep. */
  unsweptFee: bigint;
  unsweptTax: bigint;
  /** Launch-token pending on the hook (post-graduation swaps can accrue in either currency). */
  unsweptToken: bigint;
  unsweptVenue: 'curve' | 'pool' | null;
  quoteDecimals: number;
  quoteSymbol: string;
  tokenDecimals: number;
};

/**
 * v2 → Claiming fees → "Fees reach the escrow only after a sweep".
 * Graduation is automatic; fee sweep into escrow is not. Show escrow plus
 * curve (phase 0) or hook pending (phase 2). This is not v1 locker shares.
 */
export async function readCreatorFees(recipient: Address, launch: LaunchedToken): Promise<CreatorFees> {
  const client = getRobinhoodPublicClient();
  const native = isNativeQuote(launch.pairToken);
  const claimable = native
    ? await client.readContract({ address: PONS.feeEscrow, abi: ESCROW_ABI, functionName: 'balanceOf', args: [recipient] })
    : await client.readContract({
        address: PONS.feeEscrow,
        abi: ESCROW_ABI,
        functionName: 'balanceOfToken',
        args: [recipient, launch.pairToken],
      });

  let unsweptFee = 0n;
  let unsweptTax = 0n;
  let unsweptToken = 0n;
  let unsweptVenue: CreatorFees['unsweptVenue'] = null;
  if (launch.phase === 0) {
    unsweptVenue = 'curve';
    [unsweptFee, unsweptTax] = await Promise.all([
      client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'quoteFeeBalance' }),
      client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'creatorTaxBalance' }),
    ]);
  } else if (launch.phase === 2) {
    unsweptVenue = 'pool';
    const poolId = poolIdForLaunch(launch);
    const quote = launch.pairToken;
    const [feeQ, taxQ, feeT, taxT] = await Promise.all([
      client.readContract({
        address: PONS.memeHook,
        abi: HOOK_ABI,
        functionName: 'pendingFees',
        args: [poolId, quote],
      }),
      client.readContract({
        address: PONS.memeHook,
        abi: HOOK_ABI,
        functionName: 'pendingCreatorTax',
        args: [poolId, quote],
      }),
      client.readContract({
        address: PONS.memeHook,
        abi: HOOK_ABI,
        functionName: 'pendingFees',
        args: [poolId, launch.token],
      }),
      client.readContract({
        address: PONS.memeHook,
        abi: HOOK_ABI,
        functionName: 'pendingCreatorTax',
        args: [poolId, launch.token],
      }),
    ]);
    unsweptFee = feeQ;
    unsweptTax = taxQ;
    unsweptToken = feeT + taxT;
  }

  let quoteDecimals = 18;
  let quoteSymbol = 'ETH';
  let tokenDecimals = 18;
  if (!native) {
    [quoteDecimals, quoteSymbol] = await Promise.all([
      client.readContract({ address: launch.pairToken, abi: ERC20_ABI, functionName: 'decimals' }).then(Number),
      client.readContract({ address: launch.pairToken, abi: ERC20_ABI, functionName: 'symbol' }),
    ]);
  }
  if (unsweptToken > 0n) {
    tokenDecimals = Number(
      await client.readContract({ address: launch.token, abi: ERC20_ABI, functionName: 'decimals' }),
    );
  }
  return { claimable, unsweptFee, unsweptTax, unsweptToken, unsweptVenue, quoteDecimals, quoteSymbol, tokenDecimals };
}

/**
 * Escrow + unswept curve fees in USD for public creator cards.
 * Stables ≈ $1; ETH / stock quotes via Dexscreener on the pair (or WETH).
 */
export async function fetchCreatorEarnedUsd(coin: {
  token: string;
  pair_token: string;
  fee_recipient?: string | null;
}): Promise<number> {
  const launch = await getLaunchedToken(coin.token as Address);
  if (!launch.exists) return 0;
  const recipient = ((coin.fee_recipient || launch.creatorFeeRecipient) ?? '') as Address;
  if (!recipient || recipient === '0x0000000000000000000000000000000000000000') return 0;

  const fees = await readCreatorFees(recipient, launch);
  const qty = Number(formatUnits(fees.claimable + fees.unsweptFee + fees.unsweptTax, fees.quoteDecimals));
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (STABLE_SYMBOLS.has(fees.quoteSymbol.toUpperCase())) return qty;

  const priceToken = isNativeQuote(coin.pair_token) ? ROBINHOOD_WETH : (coin.pair_token as Address);
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${priceToken}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as {
      pairs?: Array<{ baseToken?: { address?: string }; priceUsd?: string; chainId?: string }>;
    };
    const want = priceToken.toLowerCase();
    const pairs = (data.pairs ?? []).filter((p) => p.baseToken?.address?.toLowerCase() === want);
    const robinhood = pairs.filter((p) => (p.chainId || '').toLowerCase() === 'robinhood');
    const pool = robinhood.length ? robinhood : pairs;
    const px = Number(pool[0]?.priceUsd);
    return Number.isFinite(px) ? qty * px : 0;
  } catch {
    return 0;
  }
}

/** Launching a token → `launchFee()` is sent as value on the call. */
export async function readLaunchFee(): Promise<bigint> {
  return getRobinhoodPublicClient().readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'launchFee' });
}

/** Launching a token → `creatorTaxBps` is rejected above `maxCreatorTaxBps()`. Owner-mutable, so read it live. */
export async function readMaxCreatorTaxBps(): Promise<number> {
  const v = await getRobinhoodPublicClient().readContract({
    address: PONS.factory,
    abi: FACTORY_ABI,
    functionName: 'maxCreatorTaxBps',
  });
  return Number(v);
}

/** Hook fee policy a launch snapshots: protocol share of every fee, buyback slice of the creator share, v4 hook fee. */
export async function readFeePolicy(): Promise<{ protocolShareBps: number; buybackBurnBps: number; hookFeeBps: number }> {
  const client = getRobinhoodPublicClient();
  const [protocolShareBps, buybackBurnBps, hookFeeBps] = await Promise.all([
    client.readContract({ address: PONS.memeHook, abi: HOOK_ABI, functionName: 'protocolFeeShareBps' }),
    client.readContract({ address: PONS.memeHook, abi: HOOK_ABI, functionName: 'buybackBurnBps' }),
    client.readContract({ address: PONS.memeHook, abi: HOOK_ABI, functionName: 'hookFeeBps' }),
  ]);
  return { protocolShareBps: Number(protocolShareBps), buybackBurnBps: Number(buybackBurnBps), hookFeeBps: Number(hookFeeBps) };
}

/** Launch-window anti-snipe tax: opening bps and how many seconds it decays over. Owner-mutable → read live. */
export async function readSnipeTax(): Promise<{ startBps: number; seconds: number }> {
  const client = getRobinhoodPublicClient();
  const [startBps, seconds] = await Promise.all([
    client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'snipeTaxStartBps' }),
    client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: 'snipeTaxSeconds' }),
  ]);
  return { startBps: Number(startBps), seconds: Number(seconds) };
}

export async function readNativeBalance(account: Address): Promise<bigint> {
  return getRobinhoodPublicClient().getBalance({ address: account });
}

export async function readErc20Balance(token: Address, account: Address): Promise<bigint> {
  return getRobinhoodPublicClient().readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
}
