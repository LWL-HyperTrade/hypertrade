/**
 * Local agent key for this browser session.
 * Mobile uses SecureStore (`hl_agent_pk_v1`). Web cannot share that key.
 * Keyed by master address so two Privy accounts on one browser never share.
 *
 * HL: do not reuse an agent address after deregister/expiry
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from './constants';

const KEY_PREFIX = 'ht_web_hl_agent_v1_mainnet_';

type StoredAgent = {
  agentPrivateKey: Hex;
  agentAddress: Hex;
  approved: boolean;
};

function storageKey(userAddress: Hex): string {
  return `${KEY_PREFIX}${userAddress.toLowerCase()}`;
}

export function loadStoredAgent(userAddress: Hex): StoredAgent | null {
  try {
    const raw = localStorage.getItem(storageKey(userAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAgent;
    if (!parsed?.agentPrivateKey || !parsed?.agentAddress) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredAgent(userAddress: Hex, agent: StoredAgent): void {
  localStorage.setItem(storageKey(userAddress), JSON.stringify(agent));
}

export function createFreshAgent(): Omit<StoredAgent, 'approved'> {
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  return { agentPrivateKey: pk, agentAddress: acct.address };
}

/** Reuse stored key unless it was marked approved and is gone from extraAgents. */
export function ensureWebAgentKey(
  userAddress: Hex,
  onChainMatch: boolean,
): StoredAgent {
  const stored = loadStoredAgent(userAddress);
  if (stored && (onChainMatch || !stored.approved)) {
    return stored;
  }
  const next = createFreshAgent();
  const row: StoredAgent = { ...next, approved: false };
  saveStoredAgent(userAddress, row);
  return row;
}

export function markWebAgentApproved(userAddress: Hex, agentAddress: Hex): void {
  const stored = loadStoredAgent(userAddress);
  if (!stored || stored.agentAddress.toLowerCase() !== agentAddress.toLowerCase()) return;
  saveStoredAgent(userAddress, { ...stored, approved: true });
}
