/**
 * HL SDK clients — same transport/signing split as
 * `frontend/src/lib/hyperliquid.ts` (agent for L1 orders, Privy EOA for
 * approveAgent / approveBuilderFee / userSetAbstraction).
 */
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { HL_INFO_URL, type Hex } from './constants';
import {
  createViemJsonRpcAccount,
  parseTypedDataChainMismatch,
  readWalletSignatureChainId,
  type Eip1193Provider,
} from './wallet';

let transport: HttpTransport | null = null;
let info: InfoClient | null = null;

export function getHlTransport(): HttpTransport {
  if (!transport) transport = new HttpTransport({ isTestnet: false });
  return transport;
}

export function getHlInfoClient(): InfoClient {
  if (!info) info = new InfoClient({ transport: getHlTransport() });
  return info;
}

export function createAgentExchangeClient(agentPrivateKey: Hex) {
  return new ExchangeClient({
    transport: getHlTransport(),
    wallet: privateKeyToAccount(agentPrivateKey),
  });
}

export async function hlInfo<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return (await res.json()) as T;
}

async function createUserExchangeClient(
  provider: Eip1193Provider,
  address: Hex,
  chainIdOverride?: Hex,
) {
  const wallet = createViemJsonRpcAccount({ provider, address });
  const signatureChainId = chainIdOverride ?? (() => readWalletSignatureChainId(provider));
  return new ExchangeClient({
    transport: getHlTransport(),
    wallet,
    signatureChainId,
  });
}

export async function withUserSignedExchange<T>(
  provider: Eip1193Provider,
  address: Hex,
  fn: (exchange: ExchangeClient) => Promise<T>,
): Promise<T> {
  const run = (chain?: Hex) => createUserExchangeClient(provider, address, chain).then(fn);
  try {
    return await run();
  } catch (err) {
    const mismatch = parseTypedDataChainMismatch(err);
    if (!mismatch?.active) throw err;
    return await run(mismatch.active);
  }
}
