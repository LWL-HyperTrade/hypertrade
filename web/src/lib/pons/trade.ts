/**
 * PONS v2 ONLY.
 * Canonical docs: https://docs.ponsfamily.com/v2
 * Do NOT follow https://docs.ponsfamily.com/ — that is v1.
 * Curve ticket (phase 0): v2 → Getting a quote + Buying and selling.
 * Uniswap v4 after graduation is a later ticket, not this module.
 */
import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';
import { isWalletUserRejectedRequest, type Eip1193Provider } from '../hlTrade';
import { CURVE_ABI, ERC20_ABI } from './abi';
import { getRobinhoodPublicClient, isNativeQuote, robinhood } from './chain';
import { ponsErrorMessage, type PonsSendTx } from './launch';
import { getLaunchedToken, readErc20Balance, readNativeBalance } from './reads';

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Constant product in the curve's own integer order. Fees sit outside this step. */
function amountOut(inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (inAmount * reserveOut) / (reserveIn + inAmount);
}
function amountIn(outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
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

const TRADE_GAS_FALLBACK = 280_000n;
const TRADE_GAS_MAX = 800_000n;
const APPROVE_GAS_FALLBACK = 80_000n;

async function pinFees(args: {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  fallback: bigint;
}): Promise<{ gasLimit: bigint; maxFeePerGas: bigint }> {
  const client = getRobinhoodPublicClient();
  let gas = args.fallback;
  try {
    const g = await withTimeout(
      client.estimateGas({ account: args.account, to: args.to, data: args.data, value: args.value }),
      12_000,
      'GAS_TIMEOUT',
    );
    if (g > 21_000n && g <= TRADE_GAS_MAX) gas = (g * 120n) / 100n;
  } catch {
    /* keep fallback */
  }
  if (gas > TRADE_GAS_MAX) gas = TRADE_GAS_MAX;
  const price = await client.getGasPrice();
  return { gasLimit: gas, maxFeePerGas: (price * 110n) / 100n };
}

async function assertEthFor(account: Address, value: bigint, fees: { gasLimit: bigint; maxFeePerGas: bigint }) {
  const bal = await getRobinhoodPublicClient().getBalance({ address: account });
  const need = value + fees.gasLimit * fees.maxFeePerGas;
  if (bal >= need) return;
  throw new Error(
    `Wallet needs about ${formatEth(need)} ETH on Robinhood Chain for this trade + gas. It has ${formatEth(bal)}.`,
  );
}

function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6);
  return s.replace(/\.?0+$/, '');
}

export type CurveTicket = {
  curve: Address;
  token: Address;
  pairToken: Address;
  phase: number;
  graduated: boolean;
  readyToGraduate: boolean;
  sellable: bigint;
  raised: bigint;
  threshold: bigint;
  quoteDecimals: number;
  quoteSymbol: string;
  tokenDecimals: number;
  native: boolean;
};

/** Factory `phase` is the venue. Curve fields feed the progress bar and quote gate. */
export async function readCurveTicket(token: Address): Promise<CurveTicket> {
  const launch = await getLaunchedToken(token);
  if (!launch.exists) throw new Error('Launch was not found on Pons.');
  const client = getRobinhoodPublicClient();
  const native = isNativeQuote(launch.pairToken);
  const [raised, threshold, sellable, ready, graduated, tokenDecimals, quoteMeta] = await Promise.all([
    client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'realQuoteReserve' }),
    client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'graduationThreshold' }),
    client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'sellableTokens' }),
    client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'readyToGraduate' }),
    client.readContract({ address: launch.curve, abi: CURVE_ABI, functionName: 'graduated' }),
    client.readContract({ address: launch.token, abi: ERC20_ABI, functionName: 'decimals' }).then(Number),
    native
      ? Promise.resolve({ decimals: 18, symbol: 'ETH' })
      : Promise.all([
          client.readContract({ address: launch.pairToken, abi: ERC20_ABI, functionName: 'decimals' }).then(Number),
          client.readContract({ address: launch.pairToken, abi: ERC20_ABI, functionName: 'symbol' }),
        ]).then(([decimals, symbol]) => ({ decimals, symbol })),
  ]);
  return {
    curve: launch.curve,
    token: launch.token,
    pairToken: launch.pairToken,
    phase: launch.phase,
    graduated: graduated || launch.phase >= 2,
    readyToGraduate: ready,
    sellable,
    raised,
    threshold,
    quoteDecimals: quoteMeta.decimals,
    quoteSymbol: quoteMeta.symbol,
    tokenDecimals,
    native,
  };
}

export async function readTradeBalances(args: {
  account: Address;
  token: Address;
  pairToken: Address;
  native: boolean;
}): Promise<{ quote: bigint; token: bigint }> {
  const [quote, token] = await Promise.all([
    args.native ? readNativeBalance(args.account) : readErc20Balance(args.pairToken, args.account),
    readErc20Balance(args.token, args.account),
  ]);
  return { quote, token };
}

export type BuyQuote = { tokensOut: bigint; spent: bigint; refund: bigint };
export type SellQuote = { quoteOut: bigint };

/** Quote asset in, launch token out. Live `getReserves()`, not phantom opening reserves. */
export async function quoteBuy(curve: Address, quoteIn: bigint, recipient: Address): Promise<BuyQuote> {
  if (quoteIn <= 0n) return { tokensOut: 0n, spent: 0n, refund: 0n };
  const client = getRobinhoodPublicClient();
  const [reserves, sellable, feeBps, creatorTaxBps, rawSnipeBps] = await Promise.all([
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'getReserves' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'sellableTokens' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'feeBps' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'creatorTaxBps' }),
    client.readContract({
      address: curve,
      abi: CURVE_ABI,
      functionName: 'currentSnipeTaxBps',
      args: [recipient],
    }),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  const fee = feeBps;
  const tax = creatorTaxBps;
  let snipeBps = rawSnipeBps;
  if (snipeBps > 0n) {
    const maxSnipeBps = BPS - fee - tax - 100n;
    if (snipeBps > maxSnipeBps && maxSnipeBps > 0n) snipeBps = maxSnipeBps;
  }

  let spent = quoteIn;
  const feeAmt = (spent * fee) / BPS;
  const taxAmt = (spent * tax) / BPS;
  const snipeTax = (spent * snipeBps) / BPS;
  const netIn = spent - feeAmt - taxAmt - snipeTax;
  if (netIn <= 0n) return { tokensOut: 0n, spent: 0n, refund: quoteIn };
  let tokensOut = amountOut(netIn, quoteReserve, tokenReserve);

  if (tokensOut > sellable) {
    tokensOut = sellable;
    const net = amountIn(tokensOut, quoteReserve, tokenReserve);
    const denom = BPS - fee - tax - snipeBps;
    const grossed = denom > 0n ? ceilDiv(net * BPS, denom) : quoteIn;
    spent = grossed < quoteIn ? grossed : quoteIn;
  }

  return { tokensOut, spent, refund: quoteIn - spent };
}

/** Launch token in, quote asset out. Fees come off the output. No snipe tax. */
export async function quoteSell(curve: Address, tokensIn: bigint): Promise<SellQuote> {
  if (tokensIn <= 0n) return { quoteOut: 0n };
  const client = getRobinhoodPublicClient();
  const [reserves, feeBps, creatorTaxBps] = await Promise.all([
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'getReserves' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'feeBps' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'creatorTaxBps' }),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  const gross = amountOut(tokensIn, tokenReserve, quoteReserve);
  const fee = (gross * feeBps) / BPS;
  const tax = (gross * creatorTaxBps) / BPS;
  return { quoteOut: gross - fee - tax };
}

const SLIPPAGE_BPS = 100n; // 1% — same as the Pons ticket default.

export function minOut(quoted: bigint, slippageBps = SLIPPAGE_BPS): bigint {
  if (quoted <= 0n) return 0n;
  return (quoted * (BPS - slippageBps)) / BPS;
}

export type TradeStep = 'switching' | 'approving' | 'preparing' | 'sending' | 'confirming' | 'done';

type TradeBase = {
  hd0: Address;
  sendTx: PonsSendTx;
  switchChain: (chainId: number) => Promise<void>;
  provider: Eip1193Provider;
  onStep?: (step: TradeStep) => void;
};

async function prepareWallet(args: TradeBase) {
  args.onStep?.('switching');
  await withTimeout(args.switchChain(robinhood.id), 20_000, 'Could not switch the wallet to Robinhood Chain. Retry.');
  await withTimeout(
    waitUntilChainId(args.provider, robinhood.id),
    15_000,
    'Wallet is not on Robinhood Chain yet. Retry.',
  );
}

const WALLET_WAIT =
  'Wallet did not confirm the trade. Check Robinhood explorer before retrying — a tx may still land.';

async function sendPrepared(
  args: TradeBase & {
    to: Address;
    data: Hex;
    value: bigint;
    fallbackGas: bigint;
    title: string;
    description: string;
    simulate: () => Promise<unknown>;
  },
): Promise<Hex> {
  args.onStep?.('preparing');
  await withTimeout(args.simulate(), 20_000, 'Could not preflight this trade on Robinhood Chain. Retry.');
  const fees = await pinFees({
    account: args.hd0,
    to: args.to,
    data: args.data,
    value: args.value,
    fallback: args.fallbackGas,
  });
  await assertEthFor(args.hd0, args.value, fees);
  args.onStep?.('sending');
  const hash = await withTimeout(
    args.sendTx({
      to: args.to,
      data: args.data,
      value: args.value,
      gasLimit: Number(fees.gasLimit),
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      title: args.title,
      description: args.description,
    }),
    180_000,
    WALLET_WAIT,
  );
  args.onStep?.('confirming');
  const receipt = await getRobinhoodPublicClient().waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error('Trade transaction reverted.');
  args.onStep?.('done');
  return hash;
}

/**
 * Approve once, trade many. `unlimited` grants `maxUint256` so every later
 * sell of the launch token is a single tx. Safe here because the spender is
 * the launch's own bonding curve — a known, immutable contract that can only
 * pull tokens inside `sell()`. Quote-asset approvals for buys stay exact.
 */
async function approveIfNeeded(
  args: TradeBase & { token: Address; spender: Address; amount: bigint; title: string; unlimited?: boolean },
) {
  const client = getRobinhoodPublicClient();
  const allowance = await client.readContract({
    address: args.token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [args.hd0, args.spender],
  });
  if (allowance >= args.amount) return;
  args.onStep?.('approving');
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [args.spender, args.unlimited ? maxUint256 : args.amount],
  });
  const hash = await withTimeout(
    args.sendTx({
      to: args.token,
      data,
      value: 0n,
      gasLimit: Number(APPROVE_GAS_FALLBACK),
      title: args.title,
      description: args.unlimited
        ? 'One-time approval so the bonding curve can take this token when you sell. Future sells are a single transaction.'
        : 'Allow the Pons curve to spend this token for the trade.',
    }),
    180_000,
    'Wallet did not confirm the approval. Retry.',
  );
  await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
}

/** Native: `msg.value` must equal `quoteIn`. ERC-20: approve the curve first, value = 0. */
export async function buyOnCurve(
  args: TradeBase & {
    curve: Address;
    pairToken: Address;
    quoteIn: bigint;
    minTokensOut: bigint;
    native: boolean;
    symbol: string;
  },
): Promise<Hex> {
  try {
    await prepareWallet(args);
    const publicClient = getRobinhoodPublicClient();
    if (!args.native) {
      await approveIfNeeded({
        ...args,
        token: args.pairToken,
        spender: args.curve,
        amount: args.quoteIn,
        title: `Approve ${args.symbol} quote`,
      });
    }
    const value = args.native ? args.quoteIn : 0n;
    const buyArgs = [args.quoteIn, args.minTokensOut, args.hd0] as const;
    const data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'buy', args: buyArgs });
    return await sendPrepared({
      ...args,
      to: args.curve,
      data,
      value,
      fallbackGas: TRADE_GAS_FALLBACK,
      title: `Buy ${args.symbol}`,
      description: 'Robinhood Chain. Spend quote on the Pons bonding curve.',
      simulate: () =>
        publicClient.simulateContract({
          account: args.hd0,
          address: args.curve,
          abi: CURVE_ABI,
          functionName: 'buy',
          args: buyArgs,
          value,
        }),
    });
  } catch (e) {
    throw new Error(tradeErrorMessage(e));
  }
}

export async function sellOnCurve(
  args: TradeBase & {
    curve: Address;
    token: Address;
    tokensIn: bigint;
    minQuoteOut: bigint;
    symbol: string;
  },
): Promise<Hex> {
  try {
    await prepareWallet(args);
    const publicClient = getRobinhoodPublicClient();
    await approveIfNeeded({
      ...args,
      token: args.token,
      spender: args.curve,
      amount: args.tokensIn,
      title: `Approve ${args.symbol} once`,
      unlimited: true,
    });
    const sellArgs = [args.tokensIn, args.minQuoteOut, args.hd0] as const;
    const data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'sell', args: sellArgs });
    return await sendPrepared({
      ...args,
      to: args.curve,
      data,
      value: 0n,
      fallbackGas: TRADE_GAS_FALLBACK,
      title: `Sell ${args.symbol}`,
      description: 'Robinhood Chain. Sell the token back into the Pons bonding curve.',
      simulate: () =>
        publicClient.simulateContract({
          account: args.hd0,
          address: args.curve,
          abi: CURVE_ABI,
          functionName: 'sell',
          args: sellArgs,
        }),
    });
  } catch (e) {
    throw new Error(tradeErrorMessage(e));
  }
}

function tradeErrorMessage(e: unknown): string {
  if (isWalletUserRejectedRequest(e)) return 'Wallet request was rejected.';
  const msg = ponsErrorMessage(e);
  if (/^Launch fee is /.test(msg)) {
    return 'Not enough ETH on Robinhood Chain for this trade plus gas. Send a little more ETH and retry.';
  }
  if (/simulated this launch/.test(msg)) {
    return 'The wallet simulated this trade before you approved and it reverted. Close the popup and retry — it must run on Robinhood Chain, not Arbitrum.';
  }
  if (msg === 'Launch failed') return 'Trade failed';
  return msg;
}
