import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  ActivityIndicator,
  Platform,
  Keyboard,
  Alert,
  Linking,
  Image,
  UIManager,
  findNodeHandle,
} from 'react-native';
import QRCodeStyled from 'react-native-qrcode-styled';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useActiveEthereumWallet } from '../src/hooks/useActiveEthereumWallet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAddress, getAddress } from 'viem';
import { colors } from '../src/theme/colors';
import { useAuth } from '../src/providers/AuthContext';
import { showToast, showSuccessToast, showErrorToast } from '../src/lib/toast';
import { ToastHost } from '../src/components/ToastHost';
import { DepositPanel } from '../src/components/DepositPanel';
import { ExternalWithdrawBottomSheet } from '../src/components/ExternalWithdrawBottomSheet';
import { IncomingFundsBanner } from '../src/components/IncomingFundsBanner';
import {
  getUserAbstractionMode,
  isTradingSetupComplete,
  needsUnifiedAccountMigration,
  switchAccountAbstractionToUnified,
  getHyperliquidTradingState,
  type HyperliquidAbstractionMode,
  type Eip1193Provider,
} from '../src/lib/hyperliquid';
import { arbitrum } from 'viem/chains';
import { createPublicClient, formatUnits, http, parseUnits } from 'viem';
import { api, transferWithPermit } from '../src/lib/api';
import { buildWalletTransferIntentTypedData } from '../src/lib/walletTransferIntent';
import { savePendingTransaction } from '../src/lib/arbTransfers';
import { useTranslation } from 'react-i18next';
import {
  completeOnboarding,
  getProfileGuideStepCount,
  getProfileGuideStepContent,
  type ProfileGuideStep,
} from '../src/lib/onboarding';
import { BANKING_FUNDS_UI_ENABLED } from '../src/lib/bankingEnabled';
import { useClaimBannerTopInset, useTopStripContentHeight } from '../src/components/ClaimTradingCreditBanner';
import {
  type DemoStatus,
  fetchDemoStatus,
  getCachedDemoStatus,
  claimDemoFunds,
} from '../src/lib/demo';
import { useAppStore, type TradingEnv } from '../src/store/appStore';
import { buildWhatsAppSupportUrl } from '../src/lib/support';
import { pushRouteOnce } from '../src/lib/pushRouteOnce';
import { useHyperliquidAccountStream } from '../src/lib/useHyperliquidAccountStream';
import { getBuildCommitShort, getBuildCommitUrl } from '../src/lib/buildCommit';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  registerForPushNotifications,
  registerPushTokenWithBackend,
  writeCachedPushEnabled,
  readCachedPushEnabled,
  readPushEnabledFlag,
  setSessionPushToken,
} from '../src/lib/notifications';

type Hex = `0x${string}`;

const ARBITRUM_CHAIN_ID = 42161 as const;
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
const ARBITRUM_NETWORK_ICON = require('../assets/images/symbols/arb-icon.webp');
const extra =
  (Constants.expoConfig?.extra as any) ??
  (Constants as any).manifest2?.extra ??
  (Constants as any).manifest?.extra ??
  {};
const WHITEPAPER_URL: string =
  process.env.EXPO_PUBLIC_WHITEPAPER_URL ||
  extra?.EXPO_PUBLIC_WHITEPAPER_URL ||
  'https://www.hypertrade.exchange/LWL_Whitepaper.pdf';
const RISK_DISCLOSURE_URL =
  'https://www.hypertrade.exchange/HyperTrade_Risk_Disclosure.pdf';

const ERC20_READ_ABI = [
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

/** Strip whitespace only — preserve hex case the user pasted (EIP-55 checksum). */
function sanitizeWithdrawAddressInput(text: string): string {
  return text.replace(/\s/g, '');
}

export default function ProfileScreen() {
  const router = useRouter();
  const safePush = useCallback((href: Href) => {
    pushRouteOnce(router, href);
  }, [router]);
  const params = useLocalSearchParams<{ onboarding?: string }>();
  const { t } = useTranslation();
  const { 
    isAuthenticated, 
    isReady,
    user, 
    walletAddress,
    logout, 
    isLoading,
    getAccessToken,
  } = useAuth();

  const scrollRef = useRef<ScrollView>(null);
  const scrollOffsetYRef = useRef(0);
  // Top strip (claim or demo banner) — when active, skip safe-area top edge
  // and pad explicitly so the strip can absolute-position over our top
  // region without overlapping the screen header.
  const insets = useSafeAreaInsets();
  const topStripActive = useClaimBannerTopInset();
  const topStripContentHeight = useTopStripContentHeight();
  const safeAreaEdges = (topStripActive ? ['left', 'right', 'bottom'] : undefined) as
    | undefined
    | ('top' | 'bottom' | 'left' | 'right')[];
  const safeAreaTopPad = topStripActive ? { paddingTop: insets.top + topStripContentHeight } : undefined;

  // ─── Onboarding guide — wallet deposit → trade → bank (bank step if Tier 3 on)
  const profileGuideStepCount = getProfileGuideStepCount(BANKING_FUNDS_UI_ENABLED);
  const [onboardingStep, setOnboardingStep] = useState<ProfileGuideStep>(0);

  // ─── Demo mode (HL testnet) ───────────────────────────────────────
  // Hoisted up here so the handlers below can reference it. Status is
  // hydrated from AsyncStorage cache on mount (see useEffect below) so the
  // row renders the right state instantly on cold start; then refreshed
  // from /demo/status. The trading-env Zustand state (mainnet|demo) is
  // fully orthogonal — claiming and switching modes are independent.
  const [demoStatus, setDemoStatus] = useState<DemoStatus | null>(null);
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [demoClaimLoading, setDemoClaimLoading] = useState(false);
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const setTradingEnv = useAppStore((s) => s.setTradingEnv);
  const demoCacheOwner = user?.id ?? walletAddress ?? null;

  useEffect(() => {
    if (params.onboarding === '1') {
      setTimeout(() => {
        setOnboardingStep(1);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      }, 600);
    }
  }, [params.onboarding]);

  const fundsDestinationRowRef = useRef<View>(null);

  const scrollToFundsDestinationRow = useCallback((topInsetPx: number) => {
    setTimeout(() => {
      const node = fundsDestinationRowRef.current;
      const sv = scrollRef.current;
      if (!node || !sv) return;
      const destTag = findNodeHandle(node);
      const scrollTag = findNodeHandle(sv);
      if (destTag == null || scrollTag == null) return;
      UIManager.measureInWindow(destTag, (_x, destTop) => {
        UIManager.measureInWindow(scrollTag, (_x, scrollTop) => {
          const contentY = scrollOffsetYRef.current + (destTop - scrollTop) - topInsetPx;
          sv.scrollTo({ y: Math.max(0, contentY), animated: true });
        });
      });
    }, 320);
  }, []);

  const handleOnboardingDone = useCallback(async () => {
    setOnboardingStep(0);
    try {
      const token = await getAccessToken();
      if (token) await completeOnboarding(token);
    } catch { /* non-critical */ }
  }, [getAccessToken]);

  const handleOnboardingNext = useCallback(() => {
    if (onboardingStep === 1) {
      setOnboardingStep(2);
      scrollToFundsDestinationRow(72);
    } else if (onboardingStep === 2) {
      if (profileGuideStepCount >= 3) {
        setOnboardingStep(3);
      } else {
        void handleOnboardingDone();
      }
    } else if (onboardingStep === 3) {
      void handleOnboardingDone();
    }
  }, [onboardingStep, handleOnboardingDone, profileGuideStepCount, scrollToFundsDestinationRow]);

  // Mirror cached demo status into local state on mount so the row renders
  // its correct shape (claimed vs not) without a network round-trip on cold
  // start. Then refresh authoritatively once we have a token. Background
  // failures fall back to the cached value via the lib helper.
  useEffect(() => {
    let cancelled = false;
    setDemoStatus(null);
    (async () => {
      const cached = await getCachedDemoStatus(demoCacheOwner);
      if (!cancelled && cached) setDemoStatus(cached);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const fresh = await fetchDemoStatus(token, demoCacheOwner);
        if (!cancelled) setDemoStatus(fresh);
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [getAccessToken, demoCacheOwner]);

  const refreshDemoStatus = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      const fresh = await fetchDemoStatus(token, demoCacheOwner);
      setDemoStatus(fresh);
    } catch { /* non-critical */ }
  }, [getAccessToken, demoCacheOwner]);

  // Tap on the "Try Demo Mode" row. Branches based on current state:
  //   • Already claimed → just toggle the trading env (no modal needed).
  //   • Not claimed     → open the confirmation modal.
  const handleDemoRowPress = useCallback(() => {
    if (demoStatus?.claimed) {
      const next = tradingEnv === 'demo' ? 'mainnet' : 'demo';
      setTradingEnv(next);
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { /* noop */ }
      showSuccessToast(
        next === 'demo' ? t('demo.switchedToDemo') : t('demo.switchedToReal'),
      );
      return;
    }
    setShowDemoModal(true);
  }, [demoStatus, tradingEnv, setTradingEnv, t]);

  const handleClaimDemoFunds = useCallback(async () => {
    if (!walletAddress) {
      setDemoClaimResult({ kind: 'error', outcome: 'failed', message: t('demo.claimError') });
      return;
    }
    setDemoClaimLoading(true);
    setDemoClaimResult(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setDemoClaimResult({ kind: 'error', outcome: 'failed', message: t('demo.claimError') });
        return;
      }
      const result = await claimDemoFunds(token, walletAddress, demoCacheOwner);
      if (result.ok && (result.outcome === 'granted' || result.outcome === 'already_claimed')) {
        if (result.status) setDemoStatus(result.status);
        else void refreshDemoStatus();
        setDemoClaimResult({ kind: 'success', outcome: result.outcome });
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch { /* noop */ }
        return;
      }
      // Structured error outcomes — surfaced inline in the modal
      const outcome =
        result.outcome === 'device_taken' || result.outcome === 'pending_in_flight'
          ? result.outcome
          : 'failed';
      setDemoClaimResult({
        kind: 'error',
        outcome,
        message:
          outcome === 'device_taken' ? t('demo.modalDeviceTaken')
          : outcome === 'pending_in_flight' ? t('demo.modalPendingInFlight')
          : (result.error ?? t('demo.claimError')),
      });
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch { /* noop */ }
    } catch (e: any) {
      setDemoClaimResult({ kind: 'error', outcome: 'failed', message: e?.message ?? t('demo.claimError') });
    } finally {
      setDemoClaimLoading(false);
    }
  }, [walletAddress, demoCacheOwner, getAccessToken, t, refreshDemoStatus]);

  // Modal-close handler — also clears the inline result so the next open
  // shows the idle state, not a stale success/error from the previous run.
  const closeDemoModal = useCallback(() => {
    if (demoClaimLoading) return;
    setShowDemoModal(false);
    // Defer the result clear so the modal's exit animation doesn't show
    // the layout changing back to idle while it fades out.
    setTimeout(() => setDemoClaimResult(null), 250);
  }, [demoClaimLoading]);

  // Success-state primary CTA: switch to demo mode and dismiss. Idempotent.
  const handleSwitchToDemoFromModal = useCallback(() => {
    setTradingEnv('demo');
    showSuccessToast(t('demo.switchedToDemo'));
    setShowDemoModal(false);
    setTimeout(() => setDemoClaimResult(null), 250);
  }, [setTradingEnv, t]);

  // Inline result state for the demo modal — replaces opening/closing on
  // success or showing only a toast. Lets the modal display structured
  // success / error feedback before the user dismisses.
  const [demoClaimResult, setDemoClaimResult] = useState<
    | null
    | { kind: 'success'; outcome: 'granted' | 'already_claimed' }
    | { kind: 'error'; outcome: 'device_taken' | 'pending_in_flight' | 'failed' | 'unavailable'; message?: string }
  >(null);

  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [withdrawAddress, setWithdrawAddress] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  
  // Camera permission for QR scanner
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const hasScannedRef = useRef(false); // Prevent multiple scans
  const [transferLimit, setTransferLimit] = useState<{
    max: number;
    used: number;
    remaining: number;
    resetInSeconds: number | null;
  } | null>(null);
  const [isWithdrawing, setIsWithdrawing] = useState(false);

  // ─── Confirm external withdraw modal ──────────────────────────────────
  // External-wallet withdraws are irreversible (wrong address / wrong network =
  // lost funds), so we gate the actual permit signature behind a confirm step,
  // mirroring the same pattern DepositPanel uses for wallet ↔ trade transfers.
  const [confirmWithdraw, setConfirmWithdraw] = useState<{
    amount: string;
    destination: string;
    resolve: (v: boolean) => void;
  } | null>(null);

  const requestWithdrawConfirm = useCallback(
    (payload: { amount: string; destination: string }) => {
      // Amount field uses decimal-pad; on iOS the keyboard can still be up when
      // this overlay mounts and would cover the Confirm button if we center it.
      Keyboard.dismiss();
      return new Promise<boolean>((resolve) => {
        setConfirmWithdraw({ ...payload, resolve });
      });
    },
    [],
  );

  const handleConfirmWithdrawYes = useCallback(() => {
    confirmWithdraw?.resolve(true);
    setConfirmWithdraw(null);
  }, [confirmWithdraw]);

  const handleConfirmWithdrawNo = useCallback(() => {
    confirmWithdraw?.resolve(false);
    setConfirmWithdraw(null);
  }, [confirmWithdraw]);

  // If the user closes the parent withdraw Modal (Android back, backdrop tap,
  // close X) while the confirm overlay is up, resolve the pending promise as
  // `false` so the awaiting onPress doesn't hang and leak state.
  useEffect(() => {
    if (!showWithdrawModal && confirmWithdraw) {
      confirmWithdraw.resolve(false);
      setConfirmWithdraw(null);
    }
  }, [showWithdrawModal, confirmWithdraw]);

  const { wallet: connectedWallet } = useActiveEthereumWallet();
  const connectedAddress = (connectedWallet?.address || walletAddress || null) as string | null;

  const publicClient = useMemo(() => createPublicClient({ chain: arbitrum, transport: http() }), []);
  const queryClient = useQueryClient();

  const prefsUserId = user?.id ?? null;
  const [cachedPushEnabled, setCachedPushEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    if (!prefsUserId) {
      setCachedPushEnabled(null);
      return;
    }
    void readCachedPushEnabled(prefsUserId).then((v) => {
      if (alive) setCachedPushEnabled(v);
    });
    return () => {
      alive = false;
    };
  }, [prefsUserId]);
  const { data: notificationPrefs } = useQuery({
    queryKey: ['notification-preferences', prefsUserId],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('no token');
      const prefs = await getNotificationPreferences(token);
      const cached = prefsUserId ? await readCachedPushEnabled(prefsUserId) : null;
      const serverFlag = readPushEnabledFlag(prefs);
      const enabled = cached ?? serverFlag ?? true;
      if (prefsUserId && cached === null && serverFlag !== null) {
        await writeCachedPushEnabled(prefsUserId, serverFlag);
      }
      return { ...prefs, push_enabled: enabled };
    },
    enabled: isAuthenticated && !!prefsUserId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const pushEnabled =
    readPushEnabledFlag(notificationPrefs) ?? cachedPushEnabled ?? true;
  const [pushToggleBusy, setPushToggleBusy] = useState(false);
  const pushToggleBusyRef = useRef(false);
  const pushToggleGenRef = useRef(0);

  const handleNotificationsToggle = useCallback(
    async (enabled: boolean) => {
      if (pushToggleBusyRef.current) return;
      pushToggleBusyRef.current = true;
      const gen = ++pushToggleGenRef.current;
      setPushToggleBusy(true);

      const prefsKey = ['notification-preferences', prefsUserId] as const;
      queryClient.setQueryData(prefsKey, (cur: typeof notificationPrefs) =>
        cur ? { ...cur, push_enabled: enabled } : { push_enabled: enabled, system_alerts_enabled: true },
      );

      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Not authenticated');
        if (enabled) {
          const pushToken = await registerForPushNotifications();
          if (!pushToken) {
            queryClient.setQueryData(prefsKey, (cur: typeof notificationPrefs) =>
              cur ? { ...cur, push_enabled: false } : { push_enabled: false, system_alerts_enabled: true },
            );
            showToast(
              t('priceAlerts.notificationsDisabled'),
              t('priceAlerts.enableNotificationsInSettings'),
              'info',
            );
            return;
          }
          const saved = await updateNotificationPreferences(token, { push_enabled: true });
          queryClient.setQueryData(prefsKey, {
            ...(saved ?? notificationPrefs),
            push_enabled: true,
          });
          if (prefsUserId) {
            await writeCachedPushEnabled(prefsUserId, true);
            setCachedPushEnabled(true);
          }
          await registerPushTokenWithBackend(pushToken, token, undefined, walletAddress ?? undefined);
          setSessionPushToken(pushToken);
          showSuccessToast(t('profile.notificationsOn'));
        } else {
          const saved = await updateNotificationPreferences(token, { push_enabled: false });
          queryClient.setQueryData(prefsKey, {
            ...(saved ?? notificationPrefs),
            push_enabled: false,
          });
          if (prefsUserId) {
            await writeCachedPushEnabled(prefsUserId, false);
            setCachedPushEnabled(false);
          }
          setSessionPushToken(null);
          showSuccessToast(t('profile.notificationsOff'));
        }
      } catch {
        if (gen !== pushToggleGenRef.current) return;
        queryClient.setQueryData(prefsKey, (cur: typeof notificationPrefs) =>
          cur ? { ...cur, push_enabled: !enabled } : { push_enabled: !enabled, system_alerts_enabled: true },
        );
        showErrorToast(t('profile.notificationsEnableFailed'));
      } finally {
        if (gen === pushToggleGenRef.current) {
          pushToggleBusyRef.current = false;
          setPushToggleBusy(false);
        }
      }
    },
    [getAccessToken, notificationPrefs, prefsUserId, queryClient, t, walletAddress],
  );

  const buildCommitShort = getBuildCommitShort();
  const buildCommitUrl = getBuildCommitUrl();

  // Refresh Main HL trade balance on focus. Do NOT pin/clear the active trading
  // book — that retargets the shared WS on every Home↔Profile hop and can blank
  // Trade Balance. DepositPanel reads Main via REST regardless of Dedicated.
  useFocusEffect(
    useCallback(() => {
      if (!connectedAddress || !isAddress(connectedAddress)) return;
      void queryClient.invalidateQueries({
        queryKey: ['hl_trading_state', tradingEnv, connectedAddress],
      });
    }, [connectedAddress, queryClient, tradingEnv]),
  );
  
  // Trigger to force DepositPanel to refresh balances
  const [balanceRefreshTrigger, setBalanceRefreshTrigger] = useState(0);

  // ─── HL account stream (for open-position detection) ──────────────────────
  const hlStream = useHyperliquidAccountStream(
    connectedAddress && isAddress(connectedAddress)
      ? (connectedAddress as `0x${string}`)
      : undefined,
  );
  const hlStreamIsMasterBook = useMemo(() => {
    if (!connectedAddress || !isAddress(connectedAddress) || !hlStream.subscribedUser) return false;
    return hlStream.subscribedUser.toLowerCase() === connectedAddress.toLowerCase();
  }, [connectedAddress, hlStream.subscribedUser]);
  // ─── HL account-abstraction mode (for unified account migration banner) ─
  //
  // Unified account is the target consumer UX: one USDC balance for main
  // perps, HIP-3 perps, and spot. Standard/dexAbstraction users can still
  // trade through compatibility paths, but we surface migration proactively.
  const [accountAbstractionMode, setAccountAbstractionMode] = useState<HyperliquidAbstractionMode | null>(null);
  const [accountAbstractionModeEnv, setAccountAbstractionModeEnv] = useState<TradingEnv | null>(null);
  const [tradingSetupComplete, setTradingSetupComplete] = useState(false);
  const [isMigratingToUnified, setIsMigratingToUnified] = useState(false);
  const [abstractionModeLoading, setAbstractionModeLoading] = useState(false);

  const refreshAccountAbstractionMode = useCallback(async () => {
    if (!connectedAddress || !isAddress(connectedAddress)) {
      setAccountAbstractionMode(null);
      setAccountAbstractionModeEnv(null);
      return;
    }
    const requestedEnv = tradingEnv;
    try {
      setAbstractionModeLoading(true);
      setAccountAbstractionMode(null);
      setAccountAbstractionModeEnv(null);
      const mode = await getUserAbstractionMode(connectedAddress as `0x${string}`);
      // Mainnet and demo/testnet have independent HL abstraction state. Discard
      // stale results if the user flips env while the request is in-flight.
      if (useAppStore.getState().tradingEnv === requestedEnv) {
        setAccountAbstractionMode(mode);
        setAccountAbstractionModeEnv(requestedEnv);
      }
    } catch {
      // non-critical — banner just won't render
      if (useAppStore.getState().tradingEnv === requestedEnv) {
        setAccountAbstractionMode(null);
        setAccountAbstractionModeEnv(null);
      }
    } finally {
      if (useAppStore.getState().tradingEnv === requestedEnv) {
        setAbstractionModeLoading(false);
      }
    }
  }, [connectedAddress, tradingEnv]);

  useEffect(() => {
    refreshAccountAbstractionMode();
  }, [refreshAccountAbstractionMode]);

  useEffect(() => {
    let cancelled = false;
    isTradingSetupComplete()
      .then((complete) => {
        if (!cancelled) setTradingSetupComplete(complete);
      })
      .catch(() => {
        if (!cancelled) setTradingSetupComplete(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectedAddress, tradingEnv]);

  const handleUpgradeToUnified = useCallback(async () => {
    if (!connectedWallet || !connectedAddress || !isAddress(connectedAddress)) {
      showErrorToast(t('errors.pleaseConnectWallet'));
      return;
    }
    try {
      setIsMigratingToUnified(true);
      const provider = (await connectedWallet.getProvider()) as unknown as Eip1193Provider;
      await switchAccountAbstractionToUnified({
        userWalletProvider: provider,
        userAddress: connectedAddress as `0x${string}`,
      });
      showSuccessToast(
        t('profile.unifiedUpgradeSuccess', 'Your balances are now unified for simpler trading and withdrawals.'),
        t('profile.abstractionUpgradeSuccessTitle', 'Account upgraded'),
      );
      await refreshAccountAbstractionMode();
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : 'Upgrade failed';
      showErrorToast(msg, t('profile.abstractionUpgradeErrorTitle', 'Upgrade failed'));
    } finally {
      setIsMigratingToUnified(false);
    }
  }, [connectedWallet, connectedAddress, t, refreshAccountAbstractionMode]);

  // Mainnet and demo/testnet each have their own HL abstraction mode.
  const showAbstractionUpgradeBanner =
    !!connectedAddress &&
    isAddress(connectedAddress) &&
    tradingSetupComplete &&
    !abstractionModeLoading &&
    accountAbstractionModeEnv === tradingEnv &&
    accountAbstractionMode !== null &&
    needsUnifiedAccountMigration(accountAbstractionMode);

  // Same sources as DepositPanel Trade Balance hint: pooled REST + aggregated perp
  // stream (withdrawable/accountValue across dexes). Main-only `withdrawable`
  // is often zero while Trade Balance UI still shows collateral.
  const hlWithdrawTradeHintQueryEnabled =
    !!connectedAddress && isAddress(connectedAddress) && tradingEnv !== 'demo';

  const { data: hlWithdrawTradeHintQuery } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, connectedAddress],
    enabled: hlWithdrawTradeHintQueryEnabled,
    queryFn: async () => getHyperliquidTradingState(connectedAddress as Hex),
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    staleTime: 5000,
    refetchOnReconnect: true,
    // Withdraw hint balance — keep the 30s cadence the old global default
    // provided while this screen is the only observer of the key.
    refetchInterval: 30_000,
  });

  const hlWithdrawHintStreamUsd = useMemo(() => {
    if (!hlStreamIsMasterBook) return 0;
    const byDex = hlStream.clearinghouseStatesByDex as Record<string, unknown> | undefined;
    let wd = 0;
    let av = 0;
    if (byDex && typeof byDex === 'object') {
      for (const ch of Object.values(byDex)) {
        const row = ch as { withdrawable?: string; marginSummary?: { accountValue?: string } };
        wd += parseFloat(String(row?.withdrawable ?? '0')) || 0;
        av += parseFloat(String(row?.marginSummary?.accountValue ?? '0')) || 0;
      }
    } else {
      const ch = hlStream.clearinghouseState as
        | { withdrawable?: string; marginSummary?: { accountValue?: string } }
        | undefined;
      wd = parseFloat(String(ch?.withdrawable ?? '0')) || 0;
      av = parseFloat(String(ch?.marginSummary?.accountValue ?? '0')) || 0;
    }
    return Math.max(wd, av);
  }, [hlStreamIsMasterBook, hlStream.clearinghouseStatesByDex, hlStream.clearinghouseState]);

  const withdrawModalHlTradeUsd = useMemo(() => {
    const q = hlWithdrawTradeHintQuery;
    const fromRest = Math.max(
      q != null && Number.isFinite(q.withdrawableUsd) ? q.withdrawableUsd : 0,
      q != null && Number.isFinite(q.accountValueUsd) ? q.accountValueUsd : 0,
    );
    return Math.max(fromRest, hlWithdrawHintStreamUsd);
  }, [hlWithdrawTradeHintQuery, hlWithdrawHintStreamUsd]);


  const [walletUsdc, setWalletUsdc] = useState<bigint | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [usdcDecimals, setUsdcDecimals] = useState<number>(6);
  const [relayerAddress, setRelayerAddress] = useState<string | null>(null);

  const walletUsdcFloat = useMemo(() => {
    if (walletUsdc === null) return null;
    try {
      return Number(formatUnits(walletUsdc, usdcDecimals));
    } catch {
      return null;
    }
  }, [walletUsdc, usdcDecimals]);

  useEffect(() => {
    if (!connectedAddress || !isAddress(connectedAddress)) {
      setWalletUsdc(null);
      setWalletLoading(false);
      return;
    }

    let cancelled = false;
    // Match DepositPanel: only flash "Loading…" on the first fetch for this
    // address. Interval polls must keep the last value on screen or the
    // external-withdraw sheet flickers every 15s.
    let isInitialLoad = true;

    const refreshWalletBalance = async () => {
      if (isInitialLoad) setWalletLoading(true);
      try {
        const addr = connectedAddress as Hex;
        const [decimals, usdcBal] = await Promise.all([
          publicClient.readContract({ address: ARBITRUM_USDC, abi: ERC20_READ_ABI, functionName: 'decimals' }),
          publicClient.readContract({ address: ARBITRUM_USDC, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [addr] }),
        ]);
        if (cancelled) return;
        setUsdcDecimals(Number(decimals));
        setWalletUsdc(usdcBal);
      } catch (e: any) {
        console.error('Failed to load wallet balance:', e);
      } finally {
        if (!cancelled) {
          setWalletLoading(false);
          isInitialLoad = false;
        }
      }
    };

    refreshWalletBalance();
    const t = setInterval(refreshWalletBalance, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connectedAddress, publicClient, balanceRefreshTrigger]);

  useEffect(() => {
    // Defer this cache-population call until we know the user's address;
    // with a multi-relayer pool the server requires ?user=... to return
    // the assigned relayer.
    if (!connectedAddress) {
      setRelayerAddress(null);
      return;
    }
    const fetchRelayerAddress = async () => {
      try {
        const res = await api.get('/wallet/relayer-address', {
          params: { user: connectedAddress },
        });
        setRelayerAddress(res.data?.relayer || null);
      } catch (e) {
        console.error('Failed to fetch relayer address:', e);
      }
    };
    fetchRelayerAddress();
  }, [connectedAddress]);

  // Fetch transfer limit when withdraw modal opens
  useEffect(() => {
    if (!showWithdrawModal || !connectedAddress) {
      return;
    }
    const fetchTransferLimit = async () => {
      try {
        const token = await getAccessToken();
        if (!token) {
          // Not authenticated, use defaults
          setTransferLimit({ max: 10, used: 0, remaining: 10, resetInSeconds: null });
          return;
        }
        const res = await api.get('/wallet/transfer-limit', {
          params: { wallet_address: connectedAddress },
          headers: { Authorization: `Bearer ${token}` },
        });
        setTransferLimit(res.data);
      } catch (e) {
        console.error('Failed to fetch transfer limit:', e);
        // Default to allow transfers if fetch fails
        setTransferLimit({ max: 10, used: 0, remaining: 10, resetInSeconds: null });
      }
    };
    fetchTransferLimit();
  }, [showWithdrawModal, connectedAddress, getAccessToken]);

  // Fresh HL snapshot when opening external withdraw (cache can be cold on Profile).
  useEffect(() => {
    if (!showWithdrawModal || !hlWithdrawTradeHintQueryEnabled) return;
    void hlStream.hydrateFromRest(true);
    void queryClient.invalidateQueries({
      queryKey: ['hl_trading_state', tradingEnv, connectedAddress],
    });
  }, [showWithdrawModal, hlWithdrawTradeHintQueryEnabled, tradingEnv, connectedAddress, queryClient, hlStream.hydrateFromRest]);

  const MIN_EXTERNAL_WITHDRAW_USDC_PROFILE = 5; // Matches withdraw modal min (`withdraw.minTransfer` / APIs).
  const tradeBalanceForWithdrawHintUsd = withdrawModalHlTradeUsd;
  const showWithdrawTradeToWalletHint =
    tradingEnv !== 'demo' &&
    showWithdrawModal &&
    walletUsdcFloat !== null &&
    walletUsdcFloat < MIN_EXTERNAL_WITHDRAW_USDC_PROFILE &&
    tradeBalanceForWithdrawHintUsd >= MIN_EXTERNAL_WITHDRAW_USDC_PROFILE;

  const canSubmitExternalWithdraw = useMemo(() => {
    const amt = Number(withdrawAmount);
    return (
      isAddress(withdrawAddress) &&
      Number.isFinite(amt) &&
      amt >= MIN_EXTERNAL_WITHDRAW_USDC_PROFILE &&
      walletUsdcFloat !== null &&
      amt <= walletUsdcFloat &&
      !isWithdrawing &&
      !(transferLimit && transferLimit.remaining === 0)
    );
  }, [withdrawAddress, withdrawAmount, walletUsdcFloat, isWithdrawing, transferLimit]);

  const handleExternalWithdrawMax = useCallback(() => {
    if (walletUsdcFloat !== null && walletUsdcFloat > 0) {
      const truncated = Math.floor(walletUsdcFloat * 100) / 100;
      setWithdrawAmount(truncated.toFixed(2));
    }
  }, [walletUsdcFloat]);

  const handleOpenExternalWithdrawScanner = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert(
          t('profile.cameraPermissionRequired'),
          t('profile.enableCameraAccess'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('profile.openSettings'), onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
    }
    // Force-unmount withdraw sheet first (see ExternalWithdrawBottomSheet
    // forceCloseFromParent). Opening the camera Modal while the sheet Modal
    // is still animating closed freezes native UI.
    setShowWithdrawModal(false);
    requestAnimationFrame(() => setShowQRScanner(true));
  }, [cameraPermission, requestCameraPermission, t]);

  const handleExternalWithdrawSubmit = useCallback(async () => {
    if (!connectedWallet || !connectedAddress || !isAddress(connectedAddress)) {
      showToast(t('profile.noWalletConnected'));
      return;
    }
    if (transferLimit && transferLimit.remaining === 0) {
      showToast(t('profile.dailyLimitReached'));
      return;
    }
    if (!isAddress(withdrawAddress)) {
      showToast(t('profile.invalidDestinationAddress'));
      return;
    }
    const amt = Number(withdrawAmount);
    if (!Number.isFinite(amt) || amt < MIN_EXTERNAL_WITHDRAW_USDC_PROFILE) {
      showToast(t('withdraw.minTransfer'));
      return;
    }
    if (walletUsdcFloat === null || amt > walletUsdcFloat) {
      showToast(t('withdraw.exceedsBalance'));
      return;
    }

    const confirmed = await requestWithdrawConfirm({
      amount: amt.toFixed(2),
      destination: getAddress(withdrawAddress),
    });
    if (!confirmed) return;

    setIsWithdrawing(true);
    try {
      const provider = await connectedWallet.getProvider();
      const from = connectedAddress as Hex;
      const amountBaseUnits = parseUnits(withdrawAmount.trim(), usdcDecimals);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const relayerRes = await api.get('/wallet/relayer-address', {
        params: { user: from },
      });
      const relayer = relayerRes.data?.relayer;
      if (!relayer) {
        throw new Error('Relayer not available');
      }
      setRelayerAddress(relayer);

      const checksummedRelayer = getAddress(relayer) as Hex;
      const checksummedFrom = getAddress(from) as Hex;
      const checksummedDestination = getAddress(withdrawAddress) as Hex;
      const checksummedUsdc = getAddress(ARBITRUM_USDC) as Hex;
      const amountBaseUnitsStr = amountBaseUnits.toString();

      const nonce = await publicClient.readContract({
        address: checksummedUsdc,
        abi: ERC20_READ_ABI,
        functionName: 'nonces',
        args: [checksummedFrom],
      });

      const intentTypedData = buildWalletTransferIntentTypedData({
        owner: checksummedFrom,
        destination: checksummedDestination,
        amount: amountBaseUnitsStr,
        deadline,
        relayer: checksummedRelayer,
      });
      const intentSignature = (await provider.request({
        method: 'eth_signTypedData_v4',
        params: [checksummedFrom, JSON.stringify(intentTypedData)],
      })) as string;

      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        domain: {
          name: 'USD Coin',
          version: '2',
          chainId: ARBITRUM_CHAIN_ID,
          verifyingContract: checksummedUsdc,
        },
        message: {
          owner: checksummedFrom,
          spender: checksummedRelayer,
          value: amountBaseUnits.toString(),
          nonce: nonce.toString(),
          deadline: String(deadline),
        },
      };

      const signature = (await provider.request({
        method: 'eth_signTypedData_v4',
        params: [checksummedFrom, JSON.stringify(typedData)],
      })) as string;

      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Authentication required. Please log in again.');
      }

      const res = await transferWithPermit(
        {
          user: checksummedFrom,
          destination: checksummedDestination,
          usd: amountBaseUnitsStr,
          deadline,
          signature,
          intent_signature: intentSignature,
          signed_nonce: Number(nonce),
        },
        accessToken,
      );

      const txHashRaw = res?.txHash as string | undefined;
      if (!txHashRaw) {
        throw new Error('Relayer did not return txHash');
      }
      const txHash = (txHashRaw.startsWith('0x') ? txHashRaw : `0x${txHashRaw}`) as Hex;

      savePendingTransaction({
        hash: txHash,
        type: 'transfer_out',
        amount: withdrawAmount,
        timestamp: Date.now(),
        from: from,
        to: checksummedDestination,
        description: 'Sending to External Wallet',
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      showToast(t('profile.withdrew', { amount: withdrawAmount }));
      if (transferLimit) {
        setTransferLimit({
          ...transferLimit,
          used: transferLimit.used + 1,
          remaining: Math.max(0, transferLimit.remaining - 1),
        });
      }
      setBalanceRefreshTrigger((prev) => prev + 1);
      setWithdrawAddress('');
      setWithdrawAmount('');
      setShowWithdrawModal(false);
    } catch (e: any) {
      const rawMsg = String(
        e?.response?.data?.detail || e?.shortMessage || e?.message || t('profile.transferFailed'),
      );
      let msg = rawMsg;
      if (rawMsg.includes('Permit signature invalid')) {
        msg = t('profile.signatureVerificationFailed');
      } else if (rawMsg.includes('Nonce mismatch')) {
        msg = t('profile.transactionTimingIssue');
      } else if (rawMsg.includes('nonce too low') || rawMsg.includes('nonce conflict')) {
        msg = t('profile.transactionBusy');
      }
      showErrorToast(msg, t('profile.transferFailed'));
    } finally {
      setIsWithdrawing(false);
    }
  }, [
    connectedWallet,
    connectedAddress,
    transferLimit,
    withdrawAddress,
    withdrawAmount,
    walletUsdcFloat,
    requestWithdrawConfirm,
    usdcDecimals,
    publicClient,
    getAccessToken,
    t,
  ]);

  const handleClose = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.back();
  };

  // Funds are shown inline in this screen.

  const handleLogout = async () => {
    setShowLogoutModal(true);
  };

  useEffect(() => {
    if (isReady && !isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, isReady, router]);

  if (!isReady || !isAuthenticated) {
    return <SafeAreaView style={styles.container} />;
  }

  // Authenticated view - show account settings
  return (
    <>
    <SafeAreaView style={[styles.container, safeAreaTopPad]} edges={safeAreaEdges}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile.account')}</Text>
        <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
          <Ionicons name="close" size={24} color={colors.text.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={(e) => {
          scrollOffsetYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
        {/* ─── Account abstraction upgrade banner ───────────────────────
            Rendered for any non-unified HL mode. `userSetAbstraction` is a
            user-signed action (EIP-712) that Privy's embedded wallet signs
            transparently; the builder fee address itself remains Standard. */}
        {showAbstractionUpgradeBanner && (
          <View style={styles.abstractionBanner}>
            <LinearGradient
              colors={[colors.accent.gold + '22', colors.accent.purple + '22']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.abstractionBannerGradient}
            >
              <View style={styles.abstractionBannerHeader}>
                <View style={styles.abstractionBannerIcon}>
                  <Ionicons name="shield-checkmark" size={20} color={colors.accent.gold} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.abstractionBannerTitle}>
                    {t('profile.unifiedUpgradeTitle', 'Unify Trade Balance')}
                  </Text>
                  <Text style={styles.abstractionBannerDesc}>
                    {t(
                      'profile.unifiedUpgradeDesc',
                      'Use one USDC balance for simpler trading, margin, and withdrawals.',
                    )}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={isMigratingToUnified || abstractionModeLoading}
                onPress={handleUpgradeToUnified}
                style={styles.abstractionBannerBtn}
              >
                <LinearGradient
                  colors={[colors.accent.gold, colors.accent.purple]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.abstractionBannerBtnGradient}
                >
                  {isMigratingToUnified ? (
                    <ActivityIndicator size="small" color={colors.background.primary} />
                  ) : (
                    <>
                      <Ionicons name="arrow-up-circle" size={16} color={colors.background.primary} />
                      <Text style={styles.abstractionBannerBtnText}>
                        {t('profile.unifiedUpgradeCta', 'Upgrade Account')}
                      </Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </LinearGradient>
          </View>
        )}

        {/* Funds — wallet card includes Account info chip */}
        {(() => {
          const guide = getProfileGuideStepContent(onboardingStep, profileGuideStepCount);
          const guideDots = Array.from({ length: profileGuideStepCount }, (_, i) => i + 1);
          const onboardingTooltip =
            guide != null ? (
              <View
                style={[
                  styles.obTooltip,
                  styles.obTooltipInFunds,
                  onboardingStep === 1 ? styles.obTooltipAfterWallet : styles.obTooltipAfterDestination,
                ]}
              >
                <View style={styles.obTooltipContent}>
                  <Text style={styles.obTooltipTitle}>{t(guide.titleKey)}</Text>
                  <Text style={styles.obTooltipDesc}>{t(guide.descKey)}</Text>
                </View>
                <View style={styles.obTooltipFooter}>
                  <View style={styles.obDots}>
                    {guideDots.map((n) => (
                      <View key={n} style={[styles.obDot, onboardingStep === n && styles.obDotActive]} />
                    ))}
                  </View>
                  <View style={styles.obActions}>
                    <TouchableOpacity onPress={handleOnboardingDone} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.obSkipText}>{t('common.skip') ?? 'Skip'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.obActionBtn} onPress={handleOnboardingNext} activeOpacity={0.85}>
                      <LinearGradient
                        colors={[colors.accent.gold, colors.accent.purple]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.obActionGradient}
                      >
                        <Text style={styles.obActionText}>
                          {onboardingStep < profileGuideStepCount
                            ? t('onboarding.next')
                            : t('onboarding.gotIt')}
                        </Text>
                        <Ionicons
                          name={onboardingStep < profileGuideStepCount ? 'arrow-forward' : 'checkmark'}
                          size={14}
                          color={colors.background.primary}
                        />
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ) : null;
          return (
            <DepositPanel
              walletAddress={walletAddress}
              refreshTrigger={balanceRefreshTrigger}
              highlightDeposit={onboardingStep === 1}
              highlightTrade={onboardingStep === 2}
              highlightBank={BANKING_FUNDS_UI_ENABLED && onboardingStep === 3}
              profileEmail={user?.email && user.email.includes('@') ? user.email : undefined}
              accountCreatedAtFallback={user?.createdAt}
              onOpenWalletQr={() => setShowQRModal(true)}
              accountStream={hlStream}
              parentScrollRef={scrollRef}
              parentScrollYRef={scrollOffsetYRef}
              destinationRowRef={fundsDestinationRowRef}
              profileOnboardingTooltip={onboardingTooltip}
              profileOnboardingTooltipPlacement={
                onboardingStep === 1
                  ? 'wallet'
                  : onboardingStep === 2 || (BANKING_FUNDS_UI_ENABLED && onboardingStep === 3)
                    ? 'destination'
                    : null
              }
            />
          );
        })()}

        <View style={onboardingStep >= 1 && onboardingStep <= profileGuideStepCount ? { opacity: 0.32 } : undefined}>

        {/* Menu Items */}
        <View style={styles.menuSection}>
          <Text style={styles.sectionTitle}>{t('profile.settings')}</Text>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/portfolio')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.accent.purple}20` }]}>
                <Ionicons name="pie-chart" size={18} color={colors.accent.purple} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.portfolio')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => setShowWithdrawModal(true)}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.accent.purple}20` }]}>
                <Ionicons name="wallet" size={18} color={colors.accent.purple} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.withdrawExternal')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/deposit-withdraw-history')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.accent.purple}20` }]}>
                <Ionicons name="swap-vertical" size={18} color={colors.accent.purple} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.depositWithdrawHistory')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/trade-history')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.accent.purple}20` }]}>
                <Ionicons name="receipt" size={18} color={colors.accent.purple} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.tradeHistory')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/price-alerts')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.accent.purple}20` }]}>
                <Ionicons name="notifications" size={18} color={colors.accent.purple} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.priceAlerts')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/rewards')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.accent.purple}20` }]}>
                <Ionicons name="people" size={18} color={colors.accent.purple} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.referralsRewards')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          {/* ─── Try Demo Mode ────────────────────────────────────────── */}
          <View style={styles.demoMenuOnboardingWrap}>
            <TouchableOpacity style={styles.menuItem} onPress={handleDemoRowPress} activeOpacity={0.7}>
              {/* Left side gets flex:1 so the right icon docks to the row's
                  right edge regardless of subtext length — matches the
                  visual rhythm of the other single-line rows above. */}
              <View style={[styles.menuItemLeft, { flex: 1, minWidth: 0 }]}>
                <View
                  style={[
                    styles.menuIcon,
                    {
                      backgroundColor:
                        tradingEnv === 'demo'
                          ? `${colors.accent.gold}30`
                          : `${colors.accent.gold}20`,
                    },
                  ]}
                >
                  <Ionicons name="flask" size={18} color={colors.accent.gold} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.menuItemText} numberOfLines={1}>
                    {!demoStatus?.claimed
                      ? t('profile.tryDemoMode')
                      : tradingEnv === 'demo'
                        ? t('profile.demoModeActive')
                        : t('profile.demoSwitchToDemo')}
                  </Text>
                  {!demoStatus?.claimed && (
                    <Text style={styles.demoMenuItemSubtext} numberOfLines={1}>
                      {t('profile.demoModeDesc')}
                    </Text>
                  )}
                </View>
              </View>
              {/* Wrap the right icon in a fixed-width slot so it visually
                  aligns with the chevrons on every other row above (those
                  use chevron-forward at size 20). For the active/claimed
                  states we render slightly bigger icons but keep them
                  centered within the same slot. */}
              <View style={styles.menuItemRightIcon}>
                {!demoStatus?.claimed ? (
                  <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
                ) : tradingEnv === 'demo' ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.accent.gold} />
                ) : (
                  <Ionicons name="toggle-outline" size={24} color={colors.text.tertiary} />
                )}
              </View>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => {
              if (!pushToggleBusy && isAuthenticated) {
                void handleNotificationsToggle(!pushEnabled);
              }
            }}
            activeOpacity={0.7}
            disabled={pushToggleBusy || !isAuthenticated}
          >
            <View style={[styles.menuItemLeft, { flex: 1, minWidth: 0 }]}>
              <View
                style={[
                  styles.menuIcon,
                  {
                    backgroundColor: pushEnabled
                      ? `${colors.accent.gold}30`
                      : `${colors.accent.gold}20`,
                  },
                ]}
              >
                <Ionicons name="notifications" size={18} color={colors.accent.gold} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.menuItemText} numberOfLines={1}>
                  {pushEnabled ? t('profile.notificationsOn') : t('profile.notifications')}
                </Text>
              </View>
            </View>
            <View style={styles.menuItemRightIcon}>
              {pushEnabled ? (
                <Ionicons name="checkmark-circle" size={22} color={colors.accent.gold} />
              ) : (
                <Ionicons name="toggle-outline" size={24} color={colors.text.tertiary} />
              )}
            </View>
          </TouchableOpacity>

        </View>

        {/* About Section */}
        <View style={styles.menuSection}>
          <Text style={styles.sectionTitle}>{t('profile.about')}</Text>
          
          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/terms')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="document-text" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.termsOfService')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/privacy-policy')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="shield-checkmark" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.privacyPolicy')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => {
              void Linking.openURL(RISK_DISCLOSURE_URL);
            }}
          >
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="warning" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.riskDisclosure')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/fees')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="pricetags" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.fees')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuItem} onPress={() => safePush('/faq')}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="help-circle" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.faq')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => {
              void Linking.openURL(WHITEPAPER_URL);
            }}
          >
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="reader" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.whitepaper')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuItem} onPress={() => setShowContactModal(true)}>
            <View style={styles.menuItemLeft}>
              <View style={[styles.menuIcon, { backgroundColor: `${colors.text.tertiary}20` }]}>
                <Ionicons name="mail" size={18} color={colors.text.tertiary} />
              </View>
              <Text style={styles.menuItemText}>{t('profile.contactUs')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text.tertiary} />
          </TouchableOpacity>
        </View>

        {/* Logout Button */}
        <TouchableOpacity 
          style={styles.logoutButton} 
          onPress={handleLogout}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color={colors.status.error} />
          ) : (
            <>
              <Ionicons name="log-out" size={20} color={colors.status.error} />
              <Text style={styles.logoutButtonText}>{t('profile.signOut')}</Text>
            </>
          )}
        </TouchableOpacity>

        {/* {__DEV__ && (
          <TouchableOpacity
            style={{ marginHorizontal: 16, marginBottom: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#333', alignItems: 'center' }}
            onPress={async () => {
              await resetOnboardingCache();
              Alert.alert('Dev', 'Onboarding cache cleared. Restart the app to re-trigger.');
            }}
          >
            <Text style={{ color: '#888', fontSize: 12, fontWeight: '600' }}>Reset Onboarding (Dev)</Text>
          </TouchableOpacity>
        )} */}

        <Text style={styles.version}>HyperTrade v{Constants.expoConfig?.version ?? '1.0.0'}</Text>
        {buildCommitShort && buildCommitUrl ? (
          <TouchableOpacity
            style={styles.commitRow}
            onPress={() => {
              void Linking.openURL(buildCommitUrl);
            }}
            accessibilityRole="link"
            accessibilityLabel={t('profile.verifiedCommit', { sha: buildCommitShort })}
          >
            <Ionicons name="shield-checkmark" size={13} color={colors.text.tertiary} />
            <Text style={styles.commitLink}>
              {t('profile.verifiedCommit', { sha: buildCommitShort })}
            </Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.powered}>{t('profile.copyright')}</Text>
        
        <View style={styles.socialLinks}>
          <TouchableOpacity
            style={styles.socialIconButton}
            onPress={() => Linking.openURL('https://hypertrade.exchange')}
          >
            <Ionicons name="globe-outline" size={22} color={colors.text.tertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.socialIconButton}
            onPress={() => Linking.openURL('https://x.com/HyperTrade_X')}
          >
            <Image
              source={require('../assets/images/x-logo-white.webp')}
              style={styles.xLogoIcon}
              resizeMode="contain"
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.socialIconButton}
            onPress={() => {
              void Linking.openURL(
                buildWhatsAppSupportUrl(
                  t('profile.whatsappPrefill', { defaultValue: 'Hello — HyperTrade' }),
                ),
              );
            }}
            accessibilityRole="link"
            accessibilityLabel="WhatsApp HyperTrade"
          >
            <Ionicons name="logo-whatsapp" size={24} color={colors.text.tertiary} />
          </TouchableOpacity>
        </View>
        </View>
      </ScrollView>
      {/* ─── Demo Funds Claim Modal ────────────────────────────────────
          Three render states based on demoClaimResult:
            • null        → idle: confirmation copy + Claim CTA
            • success     → checkmark + "Switch to Demo" CTA + Done link
            • error       → outcome-specific message + Retry / Close
          Loading is overlaid on the idle state via demoClaimLoading. */}
      <Modal
        transparent
        visible={showDemoModal}
        animationType="fade"
        onRequestClose={closeDemoModal}
      >
        <TouchableOpacity
          style={[styles.modalBackdrop, styles.modalScrollContent]}
          activeOpacity={1}
          onPress={closeDemoModal}
        >
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            {/* SUCCESS STATE */}
            {demoClaimResult?.kind === 'success' ? (
              <>
                <View style={styles.demoModalBadgeWrap}>
                  <View style={[styles.demoModalBadge, { backgroundColor: `${colors.accent.gold}25` }]}>
                    <Ionicons name="checkmark-circle" size={36} color={colors.accent.gold} />
                  </View>
                </View>
                <Text style={styles.modalTitle}>
                  {demoClaimResult.outcome === 'already_claimed'
                    ? t('demo.claimAlreadyClaimed')
                    : t('demo.claimSuccess')}
                </Text>
                {/*<Text style={styles.demoModalAmount}>
                  ${demoStatus?.grant_amount_usdc ?? 100} <Text style={styles.demoModalAmountUnit}>USDC (testnet)</Text>
                </Text>
                 <Text style={styles.modalText}>
                  {t('demo.modalAlreadyClaimed')}
                </Text> */}
                <View style={[styles.modalButtons, styles.demoModalButtons]}>
                  <TouchableOpacity
                    style={[styles.modalSecondary, styles.demoModalActionBtn, styles.demoModalSecondaryPad]}
                    onPress={closeDemoModal}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.modalSecondaryText, styles.demoModalBtnLabelShrink]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {t('demo.modalCancel')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalPrimarySolid, styles.demoModalPrimarySolid, styles.demoModalActionBtn]}
                    onPress={handleSwitchToDemoFromModal}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="flask" size={16} color={colors.background.primary} />
                    <Text
                      style={[styles.modalPrimarySolidText, styles.demoModalBtnLabelShrink]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {t('profile.demoSwitchToDemo')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : demoClaimResult?.kind === 'error' ? (
              /* ERROR STATE */
              <>
                <View style={styles.demoModalBadgeWrap}>
                  <View
                    style={[
                      styles.demoModalBadge,
                      { backgroundColor: `${colors.status.error}20` },
                    ]}
                  >
                    <Ionicons
                      name={
                        demoClaimResult.outcome === 'pending_in_flight' ? 'time-outline'
                        : demoClaimResult.outcome === 'device_taken' ? 'shield-outline'
                        : 'alert-circle'
                      }
                      size={32}
                      color={colors.status.error}
                    />
                  </View>
                </View>
                <Text style={styles.modalTitle}>
                  {demoClaimResult.outcome === 'device_taken' ? t('demo.modalDeviceTaken')
                    : demoClaimResult.outcome === 'pending_in_flight' ? t('demo.modalPendingInFlight')
                    : t('demo.claimError')}
                </Text>
                {demoClaimResult.message && demoClaimResult.outcome === 'failed' && (
                  <Text style={styles.modalText}>{demoClaimResult.message}</Text>
                )}
                <View style={[styles.modalButtons, styles.demoModalButtons]}>
                  <TouchableOpacity
                    style={[styles.modalSecondary, styles.demoModalActionBtn, styles.demoModalSecondaryPad]}
                    onPress={closeDemoModal}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.modalSecondaryText, styles.demoModalBtnLabelShrink]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {t('common.close')}
                    </Text>
                  </TouchableOpacity>
                  {/* Only offer Retry for transient outcomes — device_taken
                      is permanent for that device. */}
                  {demoClaimResult.outcome !== 'device_taken' && (
                    <TouchableOpacity
                      style={[styles.modalPrimarySolid, styles.demoModalPrimarySolid, styles.demoModalActionBtn]}
                      onPress={handleClaimDemoFunds}
                      disabled={demoClaimLoading}
                      activeOpacity={0.85}
                    >
                      {demoClaimLoading ? (
                        <ActivityIndicator size="small" color={colors.background.primary} />
                      ) : (
                        <>
                          <Ionicons name="refresh" size={16} color={colors.background.primary} />
                          <Text
                            style={[styles.modalPrimarySolidText, styles.demoModalBtnLabelShrink]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.72}
                          >
                            {t('demo.modalRetry')}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              </>
            ) : (
              /* IDLE STATE — confirmation copy + Claim CTA */
              <>
                <View style={styles.demoModalBadgeWrap}>
                  <View style={[styles.demoModalBadge, { backgroundColor: `${colors.accent.gold}25` }]}>
                    <Ionicons name="flask" size={32} color={colors.accent.gold} />
                  </View>
                </View>
                <Text style={styles.modalTitle}>{t('demo.modalTitle')}</Text>
                {/* <Text style={styles.demoModalAmount}>
                  ${demoStatus?.grant_amount_usdc ?? 100} <Text style={styles.demoModalAmountUnit}>USDC</Text>
                </Text> */}
                <Text style={[styles.modalText, styles.demoModalDesc]}>{t('demo.modalDesc')}</Text>
                <View style={[styles.modalButtons, styles.demoModalButtons]}>
                  <TouchableOpacity
                    style={[styles.modalSecondary, styles.demoModalActionBtn, styles.demoModalSecondaryPad]}
                    onPress={closeDemoModal}
                    disabled={demoClaimLoading}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.modalSecondaryText, styles.demoModalBtnLabelShrink]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {t('demo.modalCancel')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalPrimarySolid, styles.demoModalActionBtn]}
                    onPress={handleClaimDemoFunds}
                    disabled={demoClaimLoading}
                    activeOpacity={0.85}
                  >
                    {demoClaimLoading ? (
                      <ActivityIndicator size="small" color={colors.background.primary} />
                    ) : (
                      <Text
                        style={[styles.modalPrimarySolidText, styles.demoModalBtnLabelShrink]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.72}
                      >
                        {t('demo.modalConfirm')}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal transparent visible={showLogoutModal} animationType="fade" onRequestClose={() => setShowLogoutModal(false)}>
        <TouchableOpacity style={[styles.modalBackdrop, styles.modalScrollContent]} activeOpacity={1} onPress={() => setShowLogoutModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('profile.signOutConfirm')}</Text>
            <Text style={styles.modalText}>{t('profile.signOutMessage')}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setShowLogoutModal(false)}>
                <Text style={styles.modalSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimary}
                onPress={async () => {
                  setShowLogoutModal(false);
                  await logout();
                }}
              >
                <Text style={styles.modalPrimaryText}>{t('profile.signOut')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      <Modal transparent visible={showContactModal} animationType="fade" onRequestClose={() => setShowContactModal(false)}>
        <TouchableOpacity style={[styles.modalBackdrop, styles.modalScrollContent]} activeOpacity={1} onPress={() => setShowContactModal(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>{t('profile.contactUs')}</Text>
            <Text style={[styles.modalText, { marginBottom: 10 }]}>{t('profile.contactEmail')}</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalSecondary} onPress={() => setShowContactModal(false)}>
                <Text style={styles.modalSecondaryText}>{t('common.close')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimarySolid}
                onPress={async () => {
                  await Clipboard.setStringAsync(t('profile.contactEmail'));
                  setShowContactModal(false);
                  showToast(t('profile.emailCopied'));
                }}
              >
                <Text style={styles.modalPrimarySolidText}>{t('profile.copyEmail')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* QR Code Modal */}
      <Modal transparent visible={showQRModal} animationType="fade" onRequestClose={() => setShowQRModal(false)}>
        <TouchableOpacity style={[styles.modalBackdrop, styles.modalScrollContent]} activeOpacity={1} onPress={() => setShowQRModal(false)}>
          <TouchableOpacity style={[styles.modalCard, styles.qrModalCard]} activeOpacity={1}>
            <TouchableOpacity onPress={() => setShowQRModal(false)} style={styles.qrCloseBtn}>
              <Ionicons name="close" size={22} color={colors.text.secondary} />
            </TouchableOpacity>
            
            <Text style={styles.qrTitle}>{t('profile.walletAddress')}</Text>
            
            <Text style={styles.qrSubtitle}>
             {t('profile.scanToCopy')}
            </Text>
            
            <View style={styles.qrContainer}>
              {walletAddress && (
                <QRCodeStyled
                  data={walletAddress}
                  style={styles.qrCode}
                  pieceSize={6}
                  color="#000000"
                  pieceCornerType="rounded"
                  pieceBorderRadius={2}
                  isPiecesGlued
                  padding={16}
                  outerEyesOptions={{
                    topLeft: { borderRadius: 8 },
                    topRight: { borderRadius: 8 },
                    bottomLeft: { borderRadius: 8 },
                  }}
                  innerEyesOptions={{
                    borderRadius: 4,
                  }}
                />
              )}
            </View>
            <View style={styles.qrNetworkRow}>
              <Image source={ARBITRUM_NETWORK_ICON} style={styles.qrNetworkIcon} resizeMode="contain" />
              <Text style={styles.qrNetworkHint}>{t('profile.arbitrumNetwork')}</Text>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <ExternalWithdrawBottomSheet
        visible={showWithdrawModal}
        onClose={() => setShowWithdrawModal(false)}
        isWithdrawing={isWithdrawing}
        withdrawAddress={withdrawAddress}
        onWithdrawAddressChange={(text) => setWithdrawAddress(sanitizeWithdrawAddressInput(text))}
        withdrawAmount={withdrawAmount}
        onWithdrawAmountChange={setWithdrawAmount}
        walletUsdcFloat={walletUsdcFloat}
        walletLoading={walletLoading}
        showTradeToWalletHint={showWithdrawTradeToWalletHint}
        transferLimit={transferLimit}
        canSubmit={canSubmitExternalWithdraw}
        onSubmit={handleExternalWithdrawSubmit}
        onScanPress={handleOpenExternalWithdrawScanner}
        onMaxPress={handleExternalWithdrawMax}
        confirmOpen={!!confirmWithdraw}
        confirmAmount={confirmWithdraw?.amount ?? ''}
        confirmDestination={confirmWithdraw?.destination ?? ''}
        onConfirmYes={handleConfirmWithdrawYes}
        onConfirmNo={handleConfirmWithdrawNo}
      />

      {/* QR Scanner Modal */}
      <Modal 
        visible={showQRScanner} 
        animationType="slide" 
        onRequestClose={() => {
          hasScannedRef.current = false;
          setShowQRScanner(false);
          // Reopen withdraw modal
          setTimeout(() => setShowWithdrawModal(true), 100);
        }}
        onShow={() => {
          console.log('[Scanner] Modal opened');
          hasScannedRef.current = false;
        }}
      >
        <SafeAreaView style={styles.scannerContainer} edges={['top', 'bottom']}>
          <View style={styles.scannerHeader}>
            <Text style={styles.scannerTitle}>{t('withdraw.scanWalletAddress')}</Text>
            <TouchableOpacity 
              onPress={() => {
                hasScannedRef.current = false;
                setShowQRScanner(false);
                // Reopen withdraw modal
                setTimeout(() => setShowWithdrawModal(true), 100);
              }} 
              style={styles.scannerCloseBtn}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Ionicons name="close" size={28} color={colors.text.primary} />
            </TouchableOpacity>
          </View>
          
          <View style={styles.scannerContent}>
            {showQRScanner && cameraPermission?.granted && (
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: ['qr'],
                }}
                onBarcodeScanned={(result) => {
                  // Prevent multiple scans
                  if (hasScannedRef.current) return;
                  
                  console.log('[Scanner] Scanned:', result.data);
                  
                  if (result.data) {
                    hasScannedRef.current = true;
                    
                    // Handle ethereum: URI scheme or plain address
                    let address = result.data;
                    if (address.startsWith('ethereum:')) {
                      // Extract address from ethereum:0x... format
                      address = address.replace('ethereum:', '').split('@')[0].split('/')[0];
                    }
                    
                    const cleaned = sanitizeWithdrawAddressInput(address);
                    
                    if (isAddress(cleaned)) {
                      if (Platform.OS !== 'web') {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      }
                      setWithdrawAddress(cleaned);
                      setShowQRScanner(false);
                      showToast(t('withdraw.addressScanned'));
                      // Reopen withdraw modal with address filled
                      setTimeout(() => setShowWithdrawModal(true), 100);
                    } else {
                      if (Platform.OS !== 'web') {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                      }
                      showToast(t('withdraw.invalidWalletAddress'));
                      // Allow retrying for invalid addresses
                      setTimeout(() => {
                        hasScannedRef.current = false;
                      }, 2000);
                    }
                  }
                }}
              />
            )}
            
            {/* Show message if no permission */}
            {showQRScanner && !cameraPermission?.granted && (
              <View style={styles.noCameraPermission}>
                <Ionicons name="camera-outline" size={48} color={colors.text.tertiary} />
                <Text style={styles.noCameraText}>{t('withdraw.cameraPermission')}</Text>
                <TouchableOpacity 
                  style={styles.grantPermissionBtn}
                  onPress={async () => {
                    const result = await requestCameraPermission();
                    if (!result.granted) {
                      Linking.openSettings();
                    }
                  }}
                >
                  <Text style={styles.grantPermissionText}>{t('withdraw.grantPermission')}</Text>
                </TouchableOpacity>
              </View>
            )}
            
            {/* Scanner overlay - only show when camera is active */}
            {showQRScanner && cameraPermission?.granted && (
              <View style={styles.scannerOverlay}>
                <View style={styles.scannerFrame}>
                  <View style={[styles.scannerCorner, styles.topLeft]} />
                  <View style={[styles.scannerCorner, styles.topRight]} />
                  <View style={[styles.scannerCorner, styles.bottomLeft]} />
                  <View style={[styles.scannerCorner, styles.bottomRight]} />
                </View>
              </View>
            )}
          </View>
          
          <View style={styles.scannerFooter}>
            <Text style={styles.scannerHint}>
              {t('withdraw.positionQRCode')}
            </Text>
          </View>
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
    {/* iOS presents this screen as a native modal, so the root-level banner
        can't draw over it — mount a view-only copy here (no polling). */}
    <IncomingFundsBanner secondary />
    {/* Same iOS modal layer issue — root ToastHost renders behind /profile. */}
    <ToastHost />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.primary },
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  closeButton: { padding: 8 },
  
  // Login view styles
  loginContent: { flex: 1 },
  scrollContent: { flex: 1, paddingHorizontal: 24 },
  brandSection: { alignItems: 'center', paddingTop: 32, paddingBottom: 32 },
  logoIcon: { width: 72, height: 64, borderRadius: 16, backgroundColor: `${colors.accent.gold}10`, justifyContent: 'center', alignItems: 'center', marginBottom: 16, overflow: 'hidden' },
  logoImage: { width: 72, height: 64, resizeMode: 'contain' },
  brandTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  brandTitle: { fontSize: 28, fontWeight: '700', color: colors.text.primary },
  brandGradientMask: { marginLeft: 4 },
  brandGradientText: { fontSize: 28, fontWeight: '700' },
  brandGradientFill: { opacity: 0 },
  brandSubtitle: { fontSize: 15, color: colors.text.secondary, textAlign: 'center', lineHeight: 22 },
  
  errorContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: `${colors.status.error}15`, padding: 12, borderRadius: 8, marginBottom: 16, gap: 8 },
  errorText: { flex: 1, color: colors.status.error, fontSize: 14 },
  
  inputSection: { marginBottom: 16 },
  inputLabel: { fontSize: 14, fontWeight: '600', color: colors.text.secondary, marginBottom: 8 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background.tertiary, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: colors.border.primary, gap: 10 },
  textInput: { flex: 1, fontSize: 16, color: colors.text.primary },
  
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent.gold, paddingVertical: 14, borderRadius: 12, gap: 8, marginBottom: 16 },
  primaryButtonText: { fontSize: 16, fontWeight: '600', color: colors.background.primary },
  buttonDisabled: { opacity: 0.6 },
  
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border.primary },
  dividerText: { color: colors.text.tertiary, paddingHorizontal: 16, fontSize: 14 },
  
  socialButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background.tertiary, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.primary, gap: 10, marginBottom: 16 },
  socialButtonText: { fontSize: 16, fontWeight: '500', color: colors.text.primary },
  
  verificationSection: { alignItems: 'center' },
  verificationTitle: { fontSize: 20, fontWeight: '700', color: colors.text.primary, marginBottom: 8 },
  verificationSubtitle: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 24 },
  codeInputContainer: { width: '100%', marginBottom: 24 },
  codeInput: { fontSize: 32, fontWeight: '700', color: colors.text.primary, textAlign: 'center', backgroundColor: colors.background.tertiary, borderRadius: 12, paddingVertical: 16, borderWidth: 1, borderColor: colors.border.primary, letterSpacing: 12 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12 },
  backButtonText: { fontSize: 15, color: colors.text.secondary },
  
  termsText: { fontSize: 12, color: colors.text.muted, textAlign: 'center', marginTop: 24, marginBottom: 32, lineHeight: 18 },
  
  // Authenticated view styles
  content: { flex: 1 },
  welcomeCard: {
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 16,
    paddingTop: 20,
    paddingBottom: 16,
    paddingHorizontal: 16,
    backgroundColor: colors.background.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  userName: { fontSize: 20, fontWeight: '700', color: colors.text.primary },
  userEmail: { fontSize: 14, color: colors.text.secondary, marginTop: 4 },
  walletBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: `${colors.accent.gold}15`, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginTop: 12, gap: 6 },
  walletBadgeWrap: { position: 'relative', alignSelf: 'center' },
  walletBadgePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: `${colors.accent.gold}15`, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, gap: 6 },
  walletAddress: { fontSize: 13, fontWeight: '500', color: colors.accent.gold },

  // ── Account-abstraction upgrade banner ──────────────────────────────────
  abstractionBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.accent.gold + '55',
  },
  abstractionBannerGradient: { padding: 14, gap: 12 },
  abstractionBannerHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  abstractionBannerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.gold + '22',
  },
  abstractionBannerTitle: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  abstractionBannerDesc: {
    fontSize: 11,
    color: colors.text.secondary,
    lineHeight: 17,
    marginTop: 2,
  },
  abstractionBannerBtn: { alignSelf: 'stretch', borderRadius: 10, overflow: 'hidden' },
  abstractionBannerBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 11,
    justifyContent: 'center',
  },
  abstractionBannerBtnText: {
    color: colors.background.primary,
    fontWeight: '700',
    fontSize: 13,
  },
  walletIconBtn: { padding: 2 },
  
  balanceCard: { marginHorizontal: 16, marginBottom: 24, padding: 20, backgroundColor: colors.background.card, borderRadius: 16, borderWidth: 1, borderColor: colors.accent.gold, alignItems: 'center' },
  balanceLabel: { fontSize: 14, color: colors.text.secondary, marginBottom: 8 },
  balanceAmount: { fontSize: 32, fontWeight: '700', color: colors.text.primary, marginBottom: 4 },
  balanceNote: { fontSize: 13, color: colors.text.tertiary },
  
  logoutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: `${colors.status.error}15`, marginHorizontal: 16, paddingVertical: 14, borderRadius: 12, gap: 8, marginBottom: 12 },
  logoutButtonText: { fontSize: 16, fontWeight: '600', color: colors.status.error },
  
  menuSection: { paddingHorizontal: 16, marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.text.tertiary, textTransform: 'uppercase', marginBottom: 12, paddingLeft: 4 },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.background.card, padding: 14, borderRadius: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.primary },
  menuItemLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  menuIcon: { width: 36, height: 36, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  menuItemText: { fontSize: 14, fontWeight: '500', color: colors.text.primary },
  demoMenuItemSubtext: { fontSize: 10, color: colors.text.tertiary, marginTop: 2 },
  // Fixed-width slot for the demo row's right-side icon. Width matches the
  // visual footprint of a 20px chevron + a tiny breathing margin so the
  // checkmark (22px) and toggle (24px) variants sit at the same center as
  // the chevrons on every other row in the section.
  menuItemRightIcon: { width: 24, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },

  // Demo claim modal — shared across idle/success/error states so the layout
  // doesn't reflow as the user moves through them.
  demoModalBadgeWrap: { alignItems: 'center', marginBottom: 14 },
  demoModalBadge: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoModalAmount: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.accent.gold,
    textAlign: 'center',
    marginBottom: 4,
    marginTop: 2,
  },
  demoModalAmountUnit: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text.tertiary,
  },
  /** Idle claim modal: smaller centered body; extra space before buttons. */
  demoModalDesc: {
    marginBottom: 10,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 17,
  },
  /** Long translations: equal-width row, shrinkable labels, single line. */
  demoModalButtons: { gap: 8 },
  demoModalActionBtn: { flex: 1, minWidth: 0 },
  demoModalSecondaryPad: { paddingHorizontal: 8 },
  demoModalPrimarySolid: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 8,
    minWidth: 0,
  },
  demoModalBtnLabelShrink: {
    flexShrink: 1,
    textAlign: 'center',
    maxWidth: '100%',
  },
  
  version: { textAlign: 'center', fontSize: 13, color: colors.text.tertiary, marginTop: 4 },
  commitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 6,
  },
  commitLink: {
    fontSize: 12,
    color: colors.text.tertiary,
    textDecorationLine: 'underline',
  },
  powered: { textAlign: 'center', fontSize: 12, color: colors.text.muted, marginTop: 4, marginBottom: 16 },
  socialLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 32,
  },
  socialIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  xLogoIcon: {
    width: 18,
    height: 18,
    tintColor: colors.text.tertiary,
  },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  modalBackdropTap: { flex: 1, justifyContent: 'center' },
  modalCard: { backgroundColor: colors.background.primary, borderRadius: 16, borderWidth: 1, borderColor: colors.border.primary, padding: 16 },
  modalTitle: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: '900',
    marginBottom: 8,
    textAlign: 'center',
  },
  modalText: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginBottom: 8 },
  withdrawNetworkNote: {
    color: colors.accent.gold,
    fontSize: 10,
    lineHeight: 16,
    marginBottom: 12,
    fontWeight: '600',
  },
  withdrawTradeBalanceHintBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}55`,
    backgroundColor: `${colors.accent.gold}14`,
  },
  withdrawTradeBalanceHintText: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 17,
    color: colors.text.primary,
    fontWeight: '600',
  },
  modalButtons: { flexDirection: 'row', gap: 10 },
  modalSecondary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.background.tertiary, borderWidth: 1, borderColor: colors.border.primary },
  modalSecondaryText: { color: colors.text.primary, fontSize: 13, fontWeight: '800' },
  modalPrimary: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.status.error },
  modalPrimaryText: { color: '#fff', fontSize: 13, fontWeight: '900' },
  modalPrimaryWrapper: { flex: 1 },
  modalPrimarySolid: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.gold,
  },
  modalPrimarySolidText: { color: colors.background.primary, fontSize: 12, fontWeight: '900' },
  modalPrimaryDisabled: { opacity: 0.5 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  modalCloseBtn: { padding: 6 },
  confirmOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    paddingHorizontal: 20,
    zIndex: 50,
    elevation: 50,
  },
  confirmCard: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
  },
  confirmAddressBox: {
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
    marginBottom: 10,
  },
  confirmAddressLabel: {
    color: colors.text.tertiary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  confirmAddressValue: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  confirmWarningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255, 179, 0, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 0, 0.35)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  confirmWarningText: {
    flex: 1,
    color: colors.status.warning,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  withdrawLabel: { marginTop: 12, marginBottom: 16, fontSize: 13, fontWeight: '700', color: colors.text.primary },
  withdrawInputLabel: { fontSize: 13, fontWeight: '600', color: colors.text.secondary, marginBottom: 8 },
  withdrawInput: {
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text.primary,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  withdrawInputError: { borderColor: colors.status.error },
  withdrawAmountRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  withdrawAmountInput: { flex: 1 },
  withdrawMaxButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.tertiary,
  },
  withdrawMaxButtonText: { fontSize: 13, fontWeight: '700', color: colors.accent.gold },
  withdrawFeeNote: { marginTop: 8, fontSize: 12, color: colors.text.tertiary, lineHeight: 18 },
  withdrawNetNote: { marginTop: 6, fontSize: 13, fontWeight: '700', color: colors.accent.gold },
  
  // QR Modal styles
  qrModalCard: { alignItems: 'center', paddingTop: 48, paddingBottom: 24, paddingHorizontal: 20 },
  qrCloseBtn: { position: 'absolute', top: 12, right: 12, padding: 6, zIndex: 1 },
  qrTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary, marginBottom: 4 },
  qrSubtitle: { fontSize: 13, color: colors.text.secondary, textAlign: 'center', marginBottom: 20 },
  qrContainer: { 
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 8,
    marginBottom: 0,
  },
  qrNetworkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
  },
  qrNetworkIcon: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  qrNetworkHint: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent.gold,
  },
  qrCode: { width: 200, height: 200 },
  arbNetworkTooltipWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 6,
    alignItems: 'center',
    zIndex: 20,
  },
  arbNetworkTooltipBubble: {
    backgroundColor: colors.background.elevated,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.primary,
    maxWidth: '100%',
  },
  arbNetworkTooltipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
    textAlign: 'center',
  },
  walletArbIconBtn: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  walletArbIcon: {
    width: 14,
    height: 14,
    borderRadius: 3,
  },
  qrAddressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 8,
    width: '100%',
  },
  qrAddressText: {
    flex: 1,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.text.secondary,
  },
  
  // Address input with scan button
  addressInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  addressInput: {
    flex: 1,
  },
  scanColumn: {
    alignItems: 'center',
  },
  scanLabelAbove: {
    fontSize: 11,
    color: colors.text.muted,
    fontWeight: '500',
    marginBottom: 4,
    textAlign: 'center',
  },
  scanButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent.gold,
    backgroundColor: `${colors.accent.gold}15`,
  },
  
  // QR Scanner styles
  scannerContainer: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  scannerCloseBtn: {
    padding: 8,
    backgroundColor: colors.background.tertiary,
    borderRadius: 20,
  },
  scannerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text.primary,
  },
  scannerContent: {
    flex: 1,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  scannerFrame: {
    width: 250,
    height: 250,
    position: 'relative',
    backgroundColor: 'transparent',
  },
  scannerCorner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: colors.accent.gold,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 8,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 8,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },
  scannerFooter: {
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  scannerHint: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  noCameraPermission: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background.secondary,
    gap: 16,
  },
  noCameraText: {
    fontSize: 16,
    color: colors.text.secondary,
  },
  grantPermissionBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.accent.gold,
  },
  grantPermissionText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.background.primary,
  },

  obPulseRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2.5,
    borderColor: colors.accent.gold,
  },
  demoMenuOnboardingWrap: {
    position: 'relative',
    overflow: 'visible',
  },
  // menuSection already has paddingHorizontal: 16 — drop extra tooltip
  // margin so width matches step 1–2 tooltips / menu rows.
  obTooltipInMenuSection: {
    marginHorizontal: 0,
  },
  obTooltipInFunds: {
    marginHorizontal: 0,
  },
  obTooltipAfterWallet: {
    marginTop: 8,
    marginBottom: 2,
  },
  obTooltipAfterDestination: {
    marginTop: 10,
    marginBottom: 0,
  },
  obTooltipInWelcomeCard: {
    alignSelf: 'stretch',
    width: '100%',
    marginHorizontal: 0,
    marginTop: 14,
    marginBottom: 0,
  },
  obTooltip: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: `${colors.accent.gold}40`,
    borderRadius: 16,
    padding: 16,
    shadowColor: colors.accent.gold,
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  obTooltipContent: {
    marginBottom: 14,
  },
  obTooltipTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 4,
  },
  obTooltipDesc: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text.secondary,
    lineHeight: 18,
  },
  obTooltipFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  obDots: {
    flexDirection: 'row',
    gap: 6,
  },
  obDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.border.primary,
  },
  obDotActive: {
    backgroundColor: colors.accent.gold,
    width: 20,
  },
  obActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  obSkipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  obActionBtn: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  obActionGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  obActionText: {
    fontSize: 13,
    fontWeight: '900',
    color: colors.background.primary,
  },
});
