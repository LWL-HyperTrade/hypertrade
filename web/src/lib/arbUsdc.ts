/**
 * Arbitrum native USDC + Bridge2 — same addresses and permit shape as
 * `frontend/src/components/DepositPanel.tsx`.
 * HL: min 5 USDC. Relayer: POST /api/bridge2/deposit-with-permit
 */
import { createPublicClient, formatUnits, http, parseUnits, type Hex } from 'viem';
import { arbitrum } from 'viem/chains';
import { ARBITRUM_RPC_URL } from './config';
import type { Eip1193Provider } from './hlTrade';

export const ARBITRUM_CHAIN_ID = 42161 as const;
export const ARBITRUM_CHAIN_ID_HEX = '0xa4b1' as const;
export const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
export const HL_BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7' as const;
export const MIN_BRIDGE2_USDC = 5;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
] as const;

export function getArbPublicClient() {
  return createPublicClient({
    chain: arbitrum,
    transport: ARBITRUM_RPC_URL ? http(ARBITRUM_RPC_URL) : http(),
  });
}

export async function fetchArbUsdc(address: Hex): Promise<{ raw: bigint; decimals: number; formatted: number }> {
  const client = getArbPublicClient();
  const [decimals, raw] = await Promise.all([
    client.readContract({ address: ARBITRUM_USDC, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: ARBITRUM_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
  ]);
  const dec = Number(decimals);
  return { raw, decimals: dec, formatted: Number(formatUnits(raw, dec)) };
}

export async function readUsdcNonce(owner: Hex): Promise<bigint> {
  return getArbPublicClient().readContract({
    address: ARBITRUM_USDC,
    abi: ERC20_ABI,
    functionName: 'nonces',
    args: [owner],
  });
}

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type UsdcPermitTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: typeof ARBITRUM_USDC;
  };
  types: typeof PERMIT_TYPES;
  primaryType: 'Permit';
  message: {
    owner: Hex;
    spender: Hex;
    value: string;
    nonce: string;
    deadline: string;
  };
};

export type SignedUsdcPermit = {
  usd: string;
  deadline: number;
  signature: string;
  signed_nonce: number;
};

/** Build an EIP-2612 permit. Pass `nonce` when signing a second permit before the first is mined. */
export async function buildUsdcPermit(args: {
  owner: Hex;
  spender: Hex;
  amountUsdc: string;
  nonce: bigint;
  deadline?: number;
}): Promise<{ typedData: UsdcPermitTypedData; permit: Omit<SignedUsdcPermit, 'signature'> }> {
  const client = getArbPublicClient();
  const decimals = await client.readContract({
    address: ARBITRUM_USDC,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  const amountBaseUnits = parseUnits(args.amountUsdc, Number(decimals));
  const deadline = args.deadline ?? Math.floor(Date.now() / 1000) + 60 * 20;
  const typedData: UsdcPermitTypedData = {
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: ARBITRUM_CHAIN_ID,
      verifyingContract: ARBITRUM_USDC,
    },
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner: args.owner,
      spender: args.spender,
      value: amountBaseUnits.toString(),
      nonce: args.nonce.toString(),
      deadline: String(deadline),
    },
  };
  return {
    typedData,
    permit: {
      usd: amountBaseUnits.toString(),
      deadline,
      signed_nonce: Number(args.nonce),
    },
  };
}

async function ensureArbitrum(provider: Eip1193Provider): Promise<void> {
  const chainIdHex = (await provider.request({ method: 'eth_chainId', params: [] })) as string;
  const chainId = parseInt(chainIdHex, 16);
  if (chainId === ARBITRUM_CHAIN_ID) return;
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: ARBITRUM_CHAIN_ID_HEX }],
  });
}

/** JSON-RPC fallback (MetaMask via EIP-1193). Prefer Privy `signTypedData({ address })`. */
export async function signUsdcPermitWithProvider(args: {
  provider: Eip1193Provider;
  owner: Hex;
  spender: Hex;
  amountUsdc: string;
  nonce: bigint;
}): Promise<SignedUsdcPermit> {
  await ensureArbitrum(args.provider);
  const { typedData, permit } = await buildUsdcPermit(args);
  const payload = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: PERMIT_TYPES.Permit,
    },
    primaryType: 'Permit',
    domain: typedData.domain,
    message: typedData.message,
  };
  const signature = (await args.provider.request({
    method: 'eth_signTypedData_v4',
    params: [args.owner, JSON.stringify(payload)],
  })) as string;
  return { ...permit, signature };
}

export async function signBridge2Permit(args: {
  provider: Eip1193Provider;
  user: Hex;
  amountUsdc: string;
}): Promise<{ usd: string; deadline: number; signature: string }> {
  const nonce = await readUsdcNonce(args.user);
  const signed = await signUsdcPermitWithProvider({
    provider: args.provider,
    owner: args.user,
    spender: HL_BRIDGE2,
    amountUsdc: args.amountUsdc,
    nonce,
  });
  return { usd: signed.usd, deadline: signed.deadline, signature: signed.signature };
}
