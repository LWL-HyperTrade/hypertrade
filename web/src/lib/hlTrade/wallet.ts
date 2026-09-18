/**
 * Privy EIP-1193 → SDK wallet adapter.
 * Copied from `frontend/src/lib/hyperliquid.ts` `createViemJsonRpcAccount`
 * + `frontend/src/lib/hlWalletChain.ts`.
 *
 * Privy: ConnectedWallet.getEthereumProvider()
 * https://docs.privy.io/wallets/using-wallets/ethereum/ethereum-provider
 */
import { HL_SIGNATURE_CHAIN_ID, type Hex } from './constants';

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function createViemJsonRpcAccount(args: { provider: Eip1193Provider; address: Hex }) {
  const { provider, address } = args;
  return {
    async getAddresses() {
      return [address];
    },
    async getChainId() {
      const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string;
      return parseInt(chainIdHex, 16);
    },
    async signTypedData(params: {
      domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, unknown>;
    }) {
      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          ...params.types,
        },
        domain: params.domain,
        primaryType: params.primaryType,
        message: params.message,
      };
      return (await provider.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(typedData)],
      })) as Hex;
    },
  };
}

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: string; shortMessage?: string; details?: string; cause?: unknown };
    parts.push(e.message ?? '', e.shortMessage ?? '', e.details ?? '');
    cur = e.cause;
  }
  parts.push(String(err ?? ''));
  return parts.join(' ');
}

const CHAIN_MISMATCH_RE =
  /active chainid is\s+(0x[0-9a-f]+)\s+but received\s+(0x[0-9a-f]+)/i;

function normalizeHexChainId(hex: string): Hex | null {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return `0x${BigInt(hex).toString(16)}` as Hex;
  } catch {
    return null;
  }
}

export function parseTypedDataChainMismatch(
  err: unknown,
): { active: Hex; received: Hex } | null {
  const match = CHAIN_MISMATCH_RE.exec(collectErrorText(err));
  if (!match) return null;
  const active = normalizeHexChainId(match[1]);
  const received = normalizeHexChainId(match[2]);
  if (!active || !received) return null;
  return { active, received };
}

export function isWalletUserRejectedRequest(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string; shortMessage?: string } | null;
  const code = e?.code;
  if (code === 4001 || code === 'ACTION_REJECTED' || code === 'USER_REJECTED') return true;
  const msg = `${e?.message ?? ''} ${e?.shortMessage ?? ''} ${collectErrorText(err)}`.toLowerCase();
  return /user rejected|user denied|rejected the request|denied request|request rejected|user cancel/.test(
    msg,
  );
}

export async function readWalletSignatureChainId(provider: Eip1193Provider): Promise<Hex> {
  try {
    const hex = await provider.request({ method: 'eth_chainId' });
    if (typeof hex === 'string') {
      const normalized = normalizeHexChainId(hex);
      if (normalized) return normalized;
    }
  } catch {
    /* fallback */
  }
  return HL_SIGNATURE_CHAIN_ID;
}
