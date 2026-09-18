/**
 * Trade → Wallet (HL `withdraw3`). Same path as
 * `frontend/src/lib/hyperliquid.ts` `withdrawFromHyperliquid`.
 * HL cuts ~1 USDC to land USDC on Arbitrum; minimum send is 2 USDC.
 */
import { withUserSignedExchange } from './clients';
import type { Hex } from './constants';
import type { Eip1193Provider } from './wallet';

export const HL_WITHDRAW_FEE_USDC = 1;
export const MIN_HL_WITHDRAW_USDC = 2;

function isNonceError(error: unknown): boolean {
  const e = error as { message?: string; shortMessage?: string } | null;
  const msg = `${e?.message ?? ''} ${e?.shortMessage ?? ''} ${String(error ?? '')}`.toLowerCase();
  return msg.includes('nonce') || msg.includes('already been used') || msg.includes('stale') || msg.includes('expired');
}

let withdrawLock = false;

export function netHlWithdrawReceive(grossUsd: number): number {
  if (!Number.isFinite(grossUsd)) return 0;
  return Math.max(0, grossUsd - HL_WITHDRAW_FEE_USDC);
}

export async function withdrawFromHyperliquid(args: {
  provider: Eip1193Provider;
  userAddress: Hex;
  destination: Hex;
  amountUsd: string;
}): Promise<void> {
  if (withdrawLock) {
    throw new Error('A withdrawal is already in progress. Please wait.');
  }
  withdrawLock = true;
  const maxRetries = 3;
  try {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 50));
        await withUserSignedExchange(args.provider, args.userAddress, (exchange) =>
          exchange.withdraw3({ destination: args.destination, amount: args.amountUsd }),
        );
        return;
      } catch (error) {
        lastError = error;
        if (isNonceError(error) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Withdrawal failed');
  } finally {
    withdrawLock = false;
  }
}
