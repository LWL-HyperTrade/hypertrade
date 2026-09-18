/**
 * Silent HL setup — same first-run idea as
 * `frontend/src/hooks/useSeamlessAutoSetup.ts`.
 *
 * Privy embedded wallets auto-sign approveAgent + userSetAbstraction on HD 0.
 * Builder fee is per-app (`tenant.builder_address`) and runs on first order.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TENANT_MAX_FEE_TENTHS } from './config';
import { fetchClearinghouse, hasHlTradeBalance } from './hlMarket';
import { ensureTradingReady, inspectSetupStatus, type Hex, type SetupStatus } from './hlTrade';
import { useWebAuth } from './auth';

const RENEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FIRSTRUN_ATTEMPTS = 3;
const FIRSTRUN_RETRY_MS = 8_000;

export function useHlSetupStatus(address: string | null) {
  return useQuery({
    queryKey: ['hl', 'setup', address],
    enabled: !!address,
    queryFn: () => inspectSetupStatus(address as Hex, TENANT_MAX_FEE_TENTHS, null, true),
    refetchInterval: 20_000,
  });
}

export function useHlAutoSetup(): {
  inFlight: boolean;
  failed: boolean;
  status: SetupStatus | undefined;
} {
  const { address, builderAddress, getEthereumProvider, isEmbedded, authenticated } = useWebAuth();
  const qc = useQueryClient();
  const setupQ = useHlSetupStatus(authenticated ? address : null);
  const clearingQ = useQuery({
    queryKey: ['hl', 'clearinghouse', address],
    enabled: authenticated && !!address,
    queryFn: () => fetchClearinghouse(address!),
    refetchInterval: 8_000,
  });

  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ready = setupQ.isSuccess && clearingQ.isSuccess;
  const accountReady = setupQ.data?.accountReady ?? false;
  const agentValidUntil = setupQ.data?.agentValidUntil ?? null;
  const hasBalance = hasHlTradeBalance(clearingQ.data ?? null);

  useEffect(() => {
    failuresRef.current = 0;
    setFailed(false);
    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
  }, [address]);

  useEffect(() => () => {
    if (retryRef.current) clearTimeout(retryRef.current);
  }, []);

  useEffect(() => {
    if (!isEmbedded || !authenticated || !address || !ready) return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) return;
    const needsFirstRun = !accountReady && hasBalance;
    const needsRenewal =
      accountReady && agentValidUntil != null && agentValidUntil - Date.now() <= RENEW_WINDOW_MS;
    if (!needsFirstRun && !needsRenewal) return;
    if (inFlightRef.current) return;
    if (needsFirstRun && failuresRef.current >= MAX_FIRSTRUN_ATTEMPTS) return;

    inFlightRef.current = true;
    setInFlight(true);
    void (async () => {
      try {
        const provider = await getEthereumProvider();
        if (!provider) throw new Error('Wallet is not ready');
        await ensureTradingReady({
          provider,
          userAddress: address,
          requiredFeeTenths: TENANT_MAX_FEE_TENTHS,
          skipBuilderFee: true,
        });
        failuresRef.current = 0;
        setFailed(false);
        void qc.invalidateQueries({ queryKey: ['hl', 'setup', address] });
      } catch {
        if (needsFirstRun) {
          failuresRef.current += 1;
          if (failuresRef.current >= MAX_FIRSTRUN_ATTEMPTS) {
            setFailed(true);
          } else {
            retryRef.current = setTimeout(() => {
              retryRef.current = null;
              void qc.invalidateQueries({ queryKey: ['hl', 'setup', address] });
              void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
            }, FIRSTRUN_RETRY_MS);
          }
        }
      } finally {
        inFlightRef.current = false;
        setInFlight(false);
      }
    })();
  }, [
    isEmbedded,
    authenticated,
    address,
    builderAddress,
    ready,
    accountReady,
    hasBalance,
    agentValidUntil,
    getEthereumProvider,
    qc,
  ]);

  return { inFlight, failed, status: setupQ.data };
}

export function HlAutoSetup() {
  useHlAutoSetup();
  return null;
}
