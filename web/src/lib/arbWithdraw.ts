/**
 * Gasless Arbitrum USDC withdraw to an external wallet — same path as
 * `frontend/app/profile.tsx` `handleExternalWithdrawSubmit`
 * (permit + TransferIntent, relayer pays gas, daily cap).
 */
import { getAddress, parseUnits, type Hex } from 'viem';
import { fetchRelayerAddress, transferWithPermit } from './api';
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_CHAIN_ID_HEX,
  buildUsdcPermit,
  readUsdcNonce,
} from './arbUsdc';
import type { Eip1193Provider } from './hlTrade';

export const MIN_EXTERNAL_WITHDRAW_USDC = 5;

const INTENT_DOMAIN = {
  name: 'HyperTrade Wallet Transfer',
  version: '1',
  verifyingContract: '0x0000000000000000000000000000000000000000' as const,
} as const;

function buildTransferIntentTypedData(args: {
  owner: Hex;
  destination: Hex;
  amount: string;
  deadline: number;
  relayer: Hex;
}) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferIntent: [
        { name: 'owner', type: 'address' },
        { name: 'destination', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'relayer', type: 'address' },
      ],
    },
    primaryType: 'TransferIntent' as const,
    domain: {
      name: INTENT_DOMAIN.name,
      version: INTENT_DOMAIN.version,
      chainId: ARBITRUM_CHAIN_ID,
      verifyingContract: INTENT_DOMAIN.verifyingContract,
    },
    message: {
      owner: args.owner,
      destination: args.destination,
      amount: args.amount,
      deadline: String(args.deadline),
      relayer: args.relayer,
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

async function signTypedDataV4(provider: Eip1193Provider, owner: Hex, payload: unknown): Promise<string> {
  return (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [owner, JSON.stringify(payload)],
  })) as string;
}

export async function withdrawArbUsdcToExternal(args: {
  provider: Eip1193Provider;
  user: Hex;
  destination: string;
  amountUsdc: string;
  accessToken: string;
}): Promise<{ txHash: string }> {
  const dest = getAddress(args.destination) as Hex;
  const owner = getAddress(args.user) as Hex;
  if (dest.toLowerCase() === owner.toLowerCase()) {
    throw new Error('Destination must be a different wallet.');
  }
  const amt = Number(args.amountUsdc);
  if (!Number.isFinite(amt) || amt < MIN_EXTERNAL_WITHDRAW_USDC) {
    throw new Error(`Minimum is $${MIN_EXTERNAL_WITHDRAW_USDC}`);
  }

  await ensureArbitrum(args.provider);
  const relayer = getAddress(await fetchRelayerAddress(owner)) as Hex;
  const nonce = await readUsdcNonce(owner);
  const amountBaseUnits = parseUnits(args.amountUsdc.trim(), 6);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const amountStr = amountBaseUnits.toString();

  const intent = buildTransferIntentTypedData({
    owner,
    destination: dest,
    amount: amountStr,
    deadline,
    relayer,
  });
  const intentSignature = await signTypedDataV4(args.provider, owner, intent);

  const { typedData, permit } = await buildUsdcPermit({
    owner,
    spender: relayer,
    amountUsdc: args.amountUsdc.trim(),
    nonce,
    deadline,
  });
  const permitPayload = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: typedData.types.Permit,
    },
    primaryType: 'Permit' as const,
    domain: typedData.domain,
    message: typedData.message,
  };
  const signature = await signTypedDataV4(args.provider, owner, permitPayload);

  const res = await transferWithPermit(
    {
      user: owner,
      destination: dest,
      usd: amountStr,
      deadline,
      signature,
      intent_signature: intentSignature,
      signed_nonce: permit.signed_nonce,
    },
    args.accessToken,
  );
  const hash = res?.txHash;
  if (!hash) throw new Error('Relayer did not return a transaction');
  return { txHash: hash.startsWith('0x') ? hash : `0x${hash}` };
}
