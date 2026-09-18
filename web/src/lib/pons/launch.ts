/**
 * PONS v2 ONLY.
 * Canonical docs: https://docs.ponsfamily.com/v2
 * Do NOT follow https://docs.ponsfamily.com/ — that is v1.
 * HD 0 signs. v2 → Launching a token + Getting a quote (curve integer math).
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  custom,
  decodeEventLog,
  encodeFunctionData,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import type { Eip1193Provider } from '../hlTrade';
import { PONS_DESCRIPTION_MAX, PONS_NAME_MAX, PONS_SYMBOL_MAX } from '../earnings';
import { ERC20_ABI, ESCROW_ABI, FACTORY_ABI, LAUNCH_AND_BUY_ABI, PONS_ERROR_COPY } from './abi';
import { getRobinhoodPublicClient, isNativeQuote, PONS, robinhood } from './chain';
import { canLaunch, readErc20Balance, readLaunchTerms, readNativeBalance, type LaunchTerms } from './reads';

/** Pons `Socials` struct has exactly these five fields. */
export type PonsSocials = { twitter: string; telegram: string; discord: string; website: string; farcaster: string };

export type CoinDraft = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: Partial<PonsSocials>;
  /** Zero address = native ETH. */
  pairToken: Address;
  /** Human amount in quote units ("0.5"). Empty / "0" = no dev buy. */
  devBuy: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** Empty → HD 0. Router rejects the zero address, so we always pass one. */
  creatorFeeRecipient: string;
  launchConfigId?: bigint;
  /**
   * Team wallets exempt from the launch-window snipe tax (factory cap 32).
   * The launcher (HD 0) and the fee recipient are exempted by the factory
   * itself, so only *other* wallets belong here.
   */
  snipeTaxExemptions?: Address[];
};

/** Factory `MAX_SNIPE_TAX_EXEMPTIONS`. */
export const MAX_SNIPE_TAX_EXEMPTIONS = 32;

export type LaunchStep = 'reading' | 'switching' | 'approving' | 'preparing' | 'sending' | 'confirming' | 'done';

/** Privy `sendTransaction` with a confirm modal — same pattern as Activate. */
export type PonsSendTx = (tx: {
  to: Address;
  data: Hex;
  value: bigint;
  /** Gas units (not wei). Number so Privy does not treat a hex amount as the limit. */
  gasLimit?: number;
  /** Wei. Pin this so Privy does not lock 2–3× the chain's gas price. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  title: string;
  description: string;
}) => Promise<Hex>;

export type LaunchResult = {
  txHash: Hex;
  token: Address;
  curve: Address;
  pairToken: Address;
  launchConfigId: bigint;
  devBuyQuote: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  creatorFeeRecipient: Address;
};

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Constant product in the curve's own integer order (docs → Getting a quote). */
function amountOut(inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (inAmount * reserveOut) / (reserveIn + inAmount);
}
function amountIn(outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
}

/**
 * Quote the opening buy against a curve that does not exist yet.
 *
 * Derived from the docs' `quoteBuy` with the reserves a fresh curve opens
 * with: `quoteReserve = phantomQuote`, `tokenReserve = supply`, and the
 * reserved floor `supply × phantomQuote ÷ (phantomQuote + threshold)`
 * (docs → Reading state → Curve reserves). Snipe tax is 0 because the
 * launch-and-buy `recipient` is exempted automatically.
 *
 * Verified: `simulateContract(launchAndBuy, 0.1 ETH, config 0)` on the live
 * factory returned exactly this `tokensOut` (55649241146711635750421585).
 */
export function quoteInitialBuy(terms: LaunchTerms, quoteIn: bigint, creatorTaxBps: number) {
  const supply = terms.config.supply;
  const quoteReserve = terms.phantomQuote;
  const tokenReserve = supply;
  const reserved = (supply * terms.phantomQuote) / (terms.phantomQuote + terms.graduationThreshold);
  const sellable = supply - reserved;
  const feeBps = terms.config.curveFeeBps;
  const taxBps = BigInt(Math.max(0, Math.floor(creatorTaxBps)));

  let spent = quoteIn;
  const fee = (spent * feeBps) / BPS;
  const tax = (spent * taxBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax, quoteReserve, tokenReserve);
  if (tokensOut > sellable) {
    tokensOut = sellable;
    const net = amountIn(sellable, quoteReserve, tokenReserve);
    const grossed = ceilDiv(net * BPS, BPS - feeBps - taxBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  return { tokensOut, spent, refund: quoteIn - spent };
}

/**
 * Pons stores socials as opaque strings and their UI uses them as `href`s.
 * A bare handle (`binaryflow_ai`) becomes `ponsfamily.com/launchpad/binaryflow_ai`.
 * Always write absolute URLs. We still keep handles in our own DB.
 * Website must already be a safe https domain (wizard + API normalize it).
 */
export function ponsSocialUrl(
  kind: keyof PonsSocials,
  raw?: string,
): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (kind === 'website') {
    if (!/^https:\/\//i.test(v)) return '';
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || !u.hostname.includes('.')) return '';
      return v.slice(0, 256);
    } catch {
      return '';
    }
  }
  if (/^https?:\/\//i.test(v)) return v.slice(0, 256);
  const handle = v.replace(/^@/, '').replace(/^\/+/, '');
  if (!handle) return '';
  let url = '';
  if (kind === 'twitter') url = `https://x.com/${handle}`;
  else if (kind === 'telegram') url = `https://t.me/${handle}`;
  else if (kind === 'farcaster') url = `https://warpcast.com/${handle}`;
  else if (kind === 'discord') {
    url = /^\d+$/.test(handle) ? `https://discord.com/users/${handle}` : `https://discord.gg/${handle}`;
  } else {
    url = `https://${handle}`;
  }
  return url.slice(0, 256);
}

export function buildTokenParams(draft: CoinDraft, hd0: Address, terms: LaunchTerms) {
  const s = draft.socials;
  const recipient = /^0x[a-fA-F0-9]{40}$/.test(draft.creatorFeeRecipient)
    ? (draft.creatorFeeRecipient as Address)
    : hd0;
  const tax = Math.min(terms.maxCreatorTaxBps, Math.max(0, Math.floor(draft.creatorTaxBps)));
  // CREATE2 salt: any value not used before by this wallet (docs → Deterministic launch addresses).
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return {
    params: {
      name: draft.name.trim().slice(0, PONS_NAME_MAX),
      symbol: draft.symbol.trim().toUpperCase().slice(0, PONS_SYMBOL_MAX),
      logo: draft.logo.trim().slice(0, 512),
      description: draft.description.trim().slice(0, PONS_DESCRIPTION_MAX),
      socials: {
        twitter: ponsSocialUrl('twitter', s.twitter),
        telegram: ponsSocialUrl('telegram', s.telegram),
        discord: ponsSocialUrl('discord', s.discord),
        website: ponsSocialUrl('website', s.website),
        farcaster: ponsSocialUrl('farcaster', s.farcaster),
      },
      creatorFeeRecipient: recipient,
      creatorTaxBps: tax,
      buybackEnabled: draft.buybackEnabled,
      expectedEconomics: terms.expectedEconomics,
      salt,
    },
    recipient,
    tax,
  };
}

/**
 * Our factory's launch fee is 0.00025 ETH (`contracts/pons-v2/script/Config.sol`,
 * read live by `readLaunchFee`). `trade.ts` matches on the `Launch fee is` prefix.
 */
export const INSUFFICIENT_GAS_COPY =
  'Launch fee is 0.00025 ETH plus a little gas on Robinhood Chain. The wallet quoted an impossible gas cost — close the popup and retry.';

export function ponsErrorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | undefined;
    const name = revert?.data?.errorName;
    if (name && PONS_ERROR_COPY[name]) return PONS_ERROR_COPY[name];
    for (const key of Object.keys(PONS_ERROR_COPY)) {
      if (e.message.includes(key)) return PONS_ERROR_COPY[key];
    }
    if (/insufficient funds for gas/i.test(e.message)) {
      return INSUFFICIENT_GAS_COPY;
    }
    if (/execution reverted for an unknown reason/i.test(e.message)) {
      return 'The wallet simulated this launch before you approved and it reverted. Close the popup and retry — it must run on Robinhood Chain, not Arbitrum.';
    }
    return e.shortMessage || e.message;
  }
  if (e instanceof Error && /insufficient funds for gas/i.test(e.message)) {
    return INSUFFICIENT_GAS_COPY;
  }
  if (e instanceof Error && /execution reverted for an unknown reason/i.test(e.message)) {
    return 'The wallet simulated this launch before you approved and it reverted. Close the popup and retry — it must run on Robinhood Chain, not Arbitrum.';
  }
  return e instanceof Error ? e.message : 'Launch failed';
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(message)), ms);
    p.then(resolve, reject).finally(() => window.clearTimeout(t));
  });
}

async function waitUntilChainId(provider: Eip1193Provider, chainId: number) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const hex = String(await provider.request({ method: 'eth_chainId' }));
    if (Number.parseInt(hex, 16) === chainId) return;
    await new Promise((r) => window.setTimeout(r, 200));
  }
  throw new Error('Wallet is not on Robinhood Chain yet. Retry.');
}

/** Privy `switchChain` can resolve before `eth_chainId` has flipped. */
async function ensureRobinhoodWallet(
  provider: Eip1193Provider,
  switchChain: (chainId: number) => Promise<void>,
) {
  await withTimeout(switchChain(robinhood.id), 20_000, 'Could not switch the wallet to Robinhood Chain. Retry.');
  await withTimeout(
    waitUntilChainId(provider, robinhood.id),
    15_000,
    'Wallet is not on Robinhood Chain yet. Retry.',
  );
}

/** Must succeed on Robinhood before Privy opens. Never skip a timeout into the modal. */
async function simulateLaunch(p: Promise<unknown>): Promise<void> {
  await withTimeout(p, 30_000, 'Could not preflight the launch on Robinhood Chain. Retry.');
}

/**
 * Live v2 creates on Robinhood (Alchemy receipts, same bytecode as ours) use
 * ~3.58–3.82M gas at ~0.145 gwei. Paid gas is ~0.00055 ETH; our fee is
 * 0.00025 ETH; total ~0.0008. A 20% gas pad plus Privy's default maxFee
 * (~2.5×) would over-quote and fail a small wallet. Pin units + maxFee to
 * what the chain actually charges.
 */
const LAUNCH_GAS_FALLBACK = 3_900_000n;
const LAUNCH_GAS_MAX = 4_200_000n;

async function launchFees(args: {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
}): Promise<{ gasLimit: bigint; maxFeePerGas: bigint }> {
  const client = getRobinhoodPublicClient();
  let gas = LAUNCH_GAS_FALLBACK;
  try {
    const g = await withTimeout(client.estimateGas(args), 15_000, 'GAS_TIMEOUT');
    if (g >= 1_000_000n && g <= LAUNCH_GAS_MAX) gas = (g * 108n) / 100n;
  } catch {
    /* 3.9M covers every recent successful create we sampled */
  }
  if (gas > LAUNCH_GAS_MAX) gas = LAUNCH_GAS_MAX;
  const price = await client.getGasPrice();
  return { gasLimit: gas, maxFeePerGas: (price * 110n) / 100n };
}

async function walletFor(provider: Eip1193Provider, account: Address) {
  // Privy → "Integrating with viem": switch, then createWalletClient over the EIP-1193 provider.
  return createWalletClient({ account, chain: robinhood, transport: custom(provider) });
}

/**
 * Create the launch (and the opening buy) from HD 0.
 * - dev buy > 0 → `launchAndBuy` (docs: one tx so the buy cannot be front-run)
 * - otherwise → `launchToken`
 * Native: fee (+ buy) travel as `value`. ERC-20: only the fee as value, approve router for `quoteIn` first.
 */
export async function launchCoin(args: {
  draft: CoinDraft;
  hd0: Address;
  sendTx: PonsSendTx;
  switchChain: (chainId: number) => Promise<void>;
  provider: Eip1193Provider;
  onStep?: (step: LaunchStep) => void;
}): Promise<LaunchResult> {
  const { draft, hd0, sendTx, onStep } = args;
  const step = (s: LaunchStep) => onStep?.(s);
  const publicClient = getRobinhoodPublicClient();
  const native = isNativeQuote(draft.pairToken);

  step('reading');
  const allowed = await withTimeout(
    canLaunch(hd0),
    15_000,
    'Could not check whether Pons is accepting launches.',
  );
  if (!allowed) throw new Error(PONS_ERROR_COPY.NotWhitelisted);
  let terms = await withTimeout(
    readLaunchTerms(draft.pairToken, draft.launchConfigId),
    25_000,
    'Robinhood Chain did not respond. Check ETH on that chain and retry.',
  );
  const quoteIn = draft.devBuy && Number(draft.devBuy) > 0 ? parseUnits(draft.devBuy, terms.quoteDecimals) : 0n;

  // Pre-flight balances so the wallet does not fail on gas.
  const ethNeeded = terms.launchFee + (native ? quoteIn : 0n);
  const eth = await withTimeout(readNativeBalance(hd0), 15_000, 'Could not read ETH balance on Robinhood Chain.');
  if (eth < ethNeeded) {
    throw new Error(
      `Wallet needs ${formatEth(ethNeeded)} ETH on Robinhood Chain (plus gas). Send ETH to ${hd0}.`,
    );
  }
  if (!native && quoteIn > 0n) {
    const bal = await withTimeout(
      readErc20Balance(draft.pairToken, hd0),
      15_000,
      'Could not read the quote-asset balance.',
    );
    if (bal < quoteIn) throw new Error('Wallet does not hold enough of the quote asset for the dev buy.');
  }

  step('switching');
  await withTimeout(
    args.switchChain(robinhood.id),
    20_000,
    'Could not switch the wallet to Robinhood Chain. Retry.',
  );
  await withTimeout(
    waitUntilChainId(args.provider, robinhood.id),
    15_000,
    'Wallet is not on Robinhood Chain yet. Retry.',
  );

  const WALLET_WAIT =
    'Wallet did not confirm the launch. Check Robinhood explorer before retrying — a tx may still land. The token is not on the app until this finishes.';

  // Dedupe, drop the two addresses the factory exempts anyway, cap at the factory limit.
  const autoExempt = new Set([hd0.toLowerCase(), (draft.creatorFeeRecipient || hd0).toLowerCase()]);
  const exemptions = [...new Set((draft.snipeTaxExemptions ?? []).map((a) => a.toLowerCase()))]
    .filter((a) => !autoExempt.has(a))
    .slice(0, MAX_SNIPE_TAX_EXEMPTIONS) as Address[];

  const send = async (): Promise<Hex> => {
    const { params, recipient } = buildTokenParams(draft, hd0, terms);
    if (quoteIn > 0n) {
      if (!native) {
        step('approving');
        const allowance = await publicClient.readContract({
          address: draft.pairToken,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [hd0, PONS.launchAndBuy],
        });
        if (allowance < quoteIn) {
          const approveHash = await withTimeout(
            sendTx({
              to: draft.pairToken,
              data: encodeFunctionData({
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [PONS.launchAndBuy, quoteIn],
              }),
              value: 0n,
              title: 'Approve quote asset',
              description: 'Allow Pons to spend the quote token for the opening buy.',
            }),
            180_000,
            'Wallet did not confirm the quote-asset approval. Retry.',
          );
          await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 });
        }
      }
      // minTokensOut bounds the price, not the quantity (docs) — 1% under the quoted rate.
      const { tokensOut } = quoteInitialBuy(terms, quoteIn, params.creatorTaxBps);
      const minTokensOut = (tokensOut * 99n) / 100n;
      const value = native ? terms.launchFee + quoteIn : terms.launchFee;
      const buyArgs = [params, terms.config.id, draft.pairToken, quoteIn, minTokensOut, recipient, exemptions] as const;
      step('preparing');
      const buyData = encodeFunctionData({
        abi: LAUNCH_AND_BUY_ABI,
        functionName: 'launchAndBuy',
        args: buyArgs,
      });
      await simulateLaunch(
        publicClient.simulateContract({
          account: hd0,
          address: PONS.launchAndBuy,
          abi: LAUNCH_AND_BUY_ABI,
          functionName: 'launchAndBuy',
          args: buyArgs,
          value,
        }),
      );
      const fees = await launchFees({ account: hd0, to: PONS.launchAndBuy, data: buyData, value });
      await assertEthFor(hd0, value, fees);
      step('sending');
      return withTimeout(
        sendTx({
          to: PONS.launchAndBuy,
          data: buyData,
          value,
          gasLimit: Number(fees.gasLimit),
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: 0n,
          title: `Launch ${draft.symbol || 'token'} on Pons`,
          description: 'Robinhood Chain. Launch fee (+ opening buy) is paid in ETH from your wallet.',
        }),
        180_000,
        WALLET_WAIT,
      );
    }
    step('preparing');
    // 3-arg overload when there are no team wallets (same calldata as before); 4-arg otherwise.
    const launchData = exemptions.length
      ? encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: 'launchToken',
          args: [params, terms.config.id, draft.pairToken, exemptions],
        })
      : encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: 'launchToken',
          args: [params, terms.config.id, draft.pairToken],
        });
    await simulateLaunch(
      exemptions.length
        ? publicClient.simulateContract({
            account: hd0,
            address: PONS.factory,
            abi: FACTORY_ABI,
            functionName: 'launchToken',
            args: [params, terms.config.id, draft.pairToken, exemptions],
            value: terms.launchFee,
          })
        : publicClient.simulateContract({
            account: hd0,
            address: PONS.factory,
            abi: FACTORY_ABI,
            functionName: 'launchToken',
            args: [params, terms.config.id, draft.pairToken],
            value: terms.launchFee,
          }),
    );
    const fees = await launchFees({
      account: hd0,
      to: PONS.factory,
      data: launchData,
      value: terms.launchFee,
    });
    await assertEthFor(hd0, terms.launchFee, fees);
    step('sending');
    return withTimeout(
      sendTx({
        to: PONS.factory,
        data: launchData,
        value: terms.launchFee,
        gasLimit: Number(fees.gasLimit),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: 0n,
        title: `Launch ${draft.symbol || 'token'} on Pons`,
        description: 'Robinhood Chain. Confirm to pay the Pons launch fee from your wallet.',
      }),
      180_000,
      WALLET_WAIT,
    );
  };

  let txHash: Hex;
  try {
    txHash = await send();
  } catch (e) {
    // Docs: LaunchEconomicsMismatch → re-read previewLaunchEconomics and retry.
    if (ponsErrorMessage(e) === PONS_ERROR_COPY.LaunchEconomicsMismatch) {
      terms = await readLaunchTerms(draft.pairToken, draft.launchConfigId);
      txHash = await send();
    } else {
      throw new Error(ponsErrorMessage(e));
    }
  }

  step('confirming');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error('Launch transaction reverted.');

  let launched: { token: Address; curve: Address; pairToken: Address; launchConfigId: bigint } | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PONS.factory.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics, eventName: 'TokenLaunched' });
      launched = {
        token: ev.args.token,
        curve: ev.args.curve,
        pairToken: ev.args.pairToken,
        launchConfigId: ev.args.launchConfigId,
      };
      break;
    } catch {
      /* not TokenLaunched */
    }
  }
  if (!launched) throw new Error('Launch confirmed but TokenLaunched was not found in the receipt.');

  const { recipient, tax } = buildTokenParams(draft, hd0, terms);
  step('done');
  return {
    txHash,
    ...launched,
    devBuyQuote: quoteIn > 0n ? draft.devBuy : '0',
    creatorTaxBps: tax,
    buybackEnabled: draft.buybackEnabled,
    creatorFeeRecipient: recipient,
  };
}

/** Claiming fees → `claim()` for native launches, `claimToken(quote)` for custom pairs. HD 0 signs. */
export async function claimCreatorFees(args: {
  hd0: Address;
  pairToken: Address;
  provider: Eip1193Provider;
  switchChain: (chainId: number) => Promise<void>;
}): Promise<Hex> {
  await ensureRobinhoodWallet(args.provider, args.switchChain);
  const wallet = await walletFor(args.provider, args.hd0);
  const publicClient = getRobinhoodPublicClient();
  let hash: Hex;
  if (isNativeQuote(args.pairToken)) {
    const { request } = await publicClient.simulateContract({
      account: args.hd0,
      address: PONS.feeEscrow,
      abi: ESCROW_ABI,
      functionName: 'claim',
    });
    hash = await wallet.writeContract(request);
  } else {
    const { request } = await publicClient.simulateContract({
      account: args.hd0,
      address: PONS.feeEscrow,
      abi: ESCROW_ABI,
      functionName: 'claimToken',
      args: [args.pairToken],
    });
    hash = await wallet.writeContract(request);
  }
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Creator controls → `setBuybackEnabled(token, enabled)` on the factory.
 * Current fee recipient may turn it on or off. Factory owner may only disable.
 * Pays Robinhood ETH gas only (no value).
 */
export async function setTokenBuybackEnabled(args: {
  hd0: Address;
  token: Address;
  enabled: boolean;
  provider: Eip1193Provider;
  switchChain: (chainId: number) => Promise<void>;
}): Promise<Hex> {
  await ensureRobinhoodWallet(args.provider, args.switchChain);
  const wallet = await walletFor(args.provider, args.hd0);
  const publicClient = getRobinhoodPublicClient();
  try {
    const { request } = await publicClient.simulateContract({
      account: args.hd0,
      address: PONS.factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [args.token, args.enabled],
    });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch (e) {
    throw new Error(ponsErrorMessage(e));
  }
}

async function assertEthFor(
  account: Address,
  value: bigint,
  fees: { gasLimit: bigint; maxFeePerGas: bigint },
) {
  const bal = await getRobinhoodPublicClient().getBalance({ address: account });
  const need = value + fees.gasLimit * fees.maxFeePerGas;
  if (bal >= need) return;
  throw new Error(
    `Wallet needs about ${formatEth(need)} ETH on Robinhood Chain (${formatEth(value)} launch fee + gas). It has ${formatEth(bal)}. Send a little more ETH to ${account}.`,
  );
}

function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6);
  return s.replace(/\.?0+$/, '');
}
