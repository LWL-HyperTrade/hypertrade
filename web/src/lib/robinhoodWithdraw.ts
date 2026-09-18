/**
 * Native ETH send on Robinhood Chain (4663). User pays gas — ETH is the gas
 * token, so the Arbitrum USDC relayer must not touch this path.
 */
import { formatUnits, getAddress, isAddress, type Address, type Hex } from 'viem';
import { floorTokenAmount, formatTokenAmount, parseTokenAmount } from './amounts';
import { getRobinhoodPublicClient, ROBINHOOD_CHAIN_ID } from './pons/chain';
import { ensureTradeWalletChain, type ChainSwitcher, type ProviderGetter } from './walletChain';

export type RobinhoodSendTx = (
  request: {
    to: Address;
    from: Address;
    value: string;
    chainId: number;
  },
  opts: {
    address: Address;
    uiOptions: {
      showWalletUIs: boolean;
      description: string;
      buttonText: string;
      transactionInfo: { title: string; action: string };
    };
  },
) => Promise<{ hash: string }>;

export const ETH_DECIMALS = 18;
/** Decimals shown in Available / filled by Max. Floored, so always spendable. */
export const ETH_SHOWN_DECIMALS = 8;

export function parseEthAmount(raw: string): bigint | null {
  return parseTokenAmount(raw, ETH_DECIMALS);
}

export function formatEthInput(wei: bigint): string {
  return formatTokenAmount(wei, ETH_DECIMALS, ETH_SHOWN_DECIMALS);
}

const GAS_RESERVE_FALLBACK = 20_000_000_000_000n; // 0.00002 ETH

/**
 * Native ETH kept back so a plain transfer can pay its own gas
 * (21k gas × maxFeePerGas × 1.3). Public RPC hiccup → conservative fallback.
 */
export async function robinhoodGasReserve(): Promise<bigint> {
  try {
    const fees = await getRobinhoodPublicClient().estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    if (maxFee > 0n) {
      const est = (21_000n * maxFee * 13n) / 10n;
      if (est > 0n) return est;
    }
  } catch {
    /* fall through */
  }
  return GAS_RESERVE_FALLBACK;
}

/** Balance minus gas reserve, floored to what the UI shows. Never negative. */
export function spendableRobinhoodEth(balance: bigint, reserve: bigint): bigint {
  if (balance <= reserve) return 0n;
  return floorTokenAmount(balance - reserve, ETH_DECIMALS, ETH_SHOWN_DECIMALS);
}

/** HD 0 on Robinhood Chain with a provider that reports 4663. Use before any Pons send. */
export function ensureRobinhoodWallet(args: {
  switchChain: ChainSwitcher;
  getProvider: ProviderGetter;
}) {
  return ensureTradeWalletChain({
    chainId: ROBINHOOD_CHAIN_ID,
    chainName: 'Robinhood Chain',
    switchChain: args.switchChain,
    getProvider: args.getProvider,
  });
}

export async function withdrawRobinhoodEth(args: {
  from: Address;
  destination: string;
  amountWei: bigint;
  balanceWei?: bigint;
  switchChain: ChainSwitcher;
  getProvider: ProviderGetter;
  sendTransaction: RobinhoodSendTx;
}): Promise<{ txHash: Hex }> {
  const destRaw = args.destination.trim();
  if (!isAddress(destRaw)) throw new Error('Enter a valid destination address');
  const from = getAddress(args.from);
  const dest = getAddress(destRaw);
  if (dest.toLowerCase() === from.toLowerCase()) {
    throw new Error('Destination must be a different wallet.');
  }
  if (args.amountWei <= 0n) throw new Error('Enter an amount');
  if (args.balanceWei != null && args.amountWei > args.balanceWei) {
    throw new Error('Insufficient ETH on Robinhood Chain');
  }

  await ensureRobinhoodWallet({ switchChain: args.switchChain, getProvider: args.getProvider });

  const { hash } = await args.sendTransaction(
    {
      to: dest,
      from,
      value: args.amountWei.toString(),
      chainId: ROBINHOOD_CHAIN_ID,
    },
    {
      address: from,
      uiOptions: {
        showWalletUIs: true,
        description: `Send ${formatUnits(args.amountWei, 18)} ETH on Robinhood Chain. You pay gas in ETH.`,
        buttonText: 'Send',
        transactionInfo: { title: 'Withdraw ETH', action: 'Send ETH' },
      },
    },
  );
  const txHash = (hash.startsWith('0x') ? hash : `0x${hash}`) as Hex;
  return { txHash };
}
