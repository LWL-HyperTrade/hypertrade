import React, { useEffect, useLayoutEffect, useMemo, useState, useCallback, ReactNode, useRef } from 'react';
import { 
  usePrivy, 
  useLoginWithEmail,
  useLinkEmail,
  useLoginWithOAuth,
  useLoginWithSiwe,
  useEmbeddedEthereumWallet,
  useEmbeddedSolanaWallet,
  type LinkedAccount
} from '@privy-io/expo';
import { useSmartWallets } from '@privy-io/expo/smart-wallets';
import { useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthContext, User, AuthContextType, OAuthProviderName, PRIVY_APP_ID, PRIVY_CLIENT_ID, UR_TEST_WALLET_IMPORT_ENABLED, isUrTestPrivyUser } from './AuthContext';
import { useAppStore } from '../store/appStore';
import { fetchUrTestWalletInfo, importUrTestWalletApi } from '../lib/api';
import {
  clearOAuthPending,
  isOAuthCancelledError,
  isOAuthReturnUrl,
  markOAuthPending,
  maybeCompleteAuthSession,
  prepareOAuthBrowserSession,
  isOAuthBrowserBusyError,
  OAUTH_MAX_AGE_MS,
  OAUTH_SETTLE_MS,
  readOAuthPending,
} from '../lib/oauthRecovery';
import { 
  registerForPushNotifications, 
  registerPushTokenWithBackend,
  unregisterPushToken,
  getNotificationDeviceId,
  getNotificationPreferences,
  readCachedPushEnabled,
  writeCachedPushEnabled,
  readPushEnabledFlag,
  setSessionPushToken,
  getSessionPushToken,
} from '../lib/notifications';
import { Analytics } from '../lib/analytics';
import {
  AppsFlyerAnalytics,
  type AuthMethod,
} from '../lib/appsFlyerAnalytics';
import { clearDemoStatusCache } from '../lib/demo';
import { clearTradingSetupState } from '../lib/hyperliquid';
import { recoverMessageAddress, stringToHex } from 'viem';
import {
  connectExternalWallet,
  disconnectExternalWallet,
  forceCloseWalletConnectModal,
  getExternalWalletSignerAddress,
} from '../lib/externalWalletConnect';
import {
  resolvePrimaryEthereumWallet,
  userHasExternalWalletOnlyLogin,
} from '../lib/walletAccounts';
import { SIWE_CHAIN_ID_CAIP2, SIWE_DOMAIN, SIWE_URI } from '../lib/siweConfig';

// Re-export constants for use in _layout
export { PRIVY_APP_ID, PRIVY_CLIENT_ID };

const NOTIF_PROMPT_DONE_KEY = 'hypertrade_notif_prompt_done';
/** If OAuth is still pending after this long, surface retry UX. */
const OAUTH_WATCHDOG_MS = 90_000;
/**
 * Module-level so React Strict Mode remounts / effect re-runs cannot fire a
 * second `create()` while the first is still in flight (that race was creating
 * duplicate Solana embedded wallets in Privy).
 */
const solanaCreateInFlightByUserId = new Map<string, Promise<unknown>>();

function getEmailFromLinkedAccounts(linkedAccounts: LinkedAccount[]): string | undefined {
  // 1. Check for direct email account (email login)
  // NOTE: @privy-io/expo ≥0.66 dropped the `LinkedAccount.LinkedAccountEmail`
  // namespace form; narrow the discriminated union with `Extract` instead so
  // this stays correct across SDK versions.
  const emailAccount = linkedAccounts.find(
    (a): a is Extract<LinkedAccount, { type: 'email' }> => a.type === 'email',
  );
  if (emailAccount?.address) return emailAccount.address;

  // 2. Check for Google OAuth account - email is typically in the 'email' field
  const googleAccount = linkedAccounts.find((a) => a.type === 'google_oauth') as any;
  if (googleAccount?.email && typeof googleAccount.email === 'string' && googleAccount.email.includes('@')) {
    return googleAccount.email;
  }

  // 3. Fallback: Check any OAuth provider that might have an email field
  for (const account of linkedAccounts) {
    const anyAcc = account as any;
    // Check common email field names
    const possibleEmail = anyAcc?.email || anyAcc?.emailAddress || anyAcc?.userEmail;
    if (typeof possibleEmail === 'string' && possibleEmail.includes('@')) {
      return possibleEmail;
    }
  }

  return undefined;
}

function getPhoneFromLinkedAccounts(linkedAccounts: LinkedAccount[]): string | undefined {
  // See getEmailFromLinkedAccounts above re: the `Extract` narrowing.
  const phone = linkedAccounts.find(
    (a): a is Extract<LinkedAccount, { type: 'phone' }> => a.type === 'phone',
  );
  return phone?.phoneNumber || phone?.number;
}

/**
 * PrivyAuthProvider - Real Privy authentication for native development builds
 * This uses the actual Privy SDK and should only be used in native environments
 */
export function PrivyAuthProvider({ children }: { children: ReactNode }) {
  const { isReady, user: privyUser, logout: privyLogout, getAccessToken: privyGetAccessToken } = usePrivy();
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail();
  const { sendCode: sendLinkCode, linkWithCode, state: linkEmailState } = useLinkEmail();
  const { login: oauthLogin } = useLoginWithOAuth();
  const { generateSiweMessage, loginWithSiwe } = useLoginWithSiwe();
  const { wallets, create: createEthWallet } = useEmbeddedEthereumWallet();
  // Solana embedded wallet: created for email/social users only via the effect below
  // (`embedded.solana.createOnLogin` is `off` in _layout). State is kept for dev
  // logging only; we intentionally DO NOT expose the Solana address via AuthContext.
  const solanaWallet = useEmbeddedSolanaWallet();
  const { client: smartWalletClient } = useSmartWallets();
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const setGuest = useAppStore((s) => s.setGuest);
  const resetAppSession = useAppStore((s) => s.logout);
  const queryClient = useQueryClient();
  
  const [isLoading, setIsLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [pendingLinkEmail, setPendingLinkEmail] = useState<string | null>(null);
  const [isPendingOAuth, setIsPendingOAuth] = useState(false);
  const [isPendingWalletLogin, setIsPendingWalletLogin] = useState(false);
  const [pendingOAuthProvider, setPendingOAuthProvider] = useState<OAuthProviderName | null>(null);
  const [needsOAuthRetry, setNeedsOAuthRetry] = useState(false);
  const [urTestWalletAddress, setUrTestWalletAddress] = useState<string | null>(null);
  const [backendImportEnabled, setBackendImportEnabled] = useState(false);
  const urImportAttemptedRef = useRef(false);
  const authenticated = !!privyUser;
  const authenticatedRef = useRef(authenticated);
  authenticatedRef.current = authenticated;
  
  // Track push token for cleanup on logout
  const pushTokenRef = useRef<string | null>(null);
  const afAuthUserRef = useRef<string | null>(null);
  const walletLoginPromiseRef = useRef<Promise<void> | null>(null);
  const walletLoginGenerationRef = useRef(0);

  function resolveAuthMethod(linkedAccounts: LinkedAccount[]): AuthMethod {
    if (linkedAccounts.some((a) => a.type === 'google_oauth')) return 'google';
    if (linkedAccounts.some((a) => a.type === 'apple_oauth')) return 'apple';
    if (linkedAccounts.some((a) => a.type === 'twitter_oauth')) return 'twitter';
    if (linkedAccounts.some((a) => a.type === 'telegram')) return 'telegram';
    if (linkedAccounts.some((a) => a.type === 'passkey')) return 'passkey';
    return 'email';
  }

  const finishOAuthSuccess = useCallback(async () => {
    setIsPendingOAuth(false);
    setIsLoading(false);
    setNeedsOAuthRetry(false);
    setPendingOAuthProvider(null);
    await clearOAuthPending();
  }, []);

  const failOAuthSession = useCallback(async (provider?: OAuthProviderName) => {
    setIsPendingOAuth(false);
    setIsLoading(false);
    setNeedsOAuthRetry(true);
    if (provider) setPendingOAuthProvider(provider);
    await clearOAuthPending();
  }, []);

  const startOAuthSession = useCallback(async (provider: OAuthProviderName) => {
    setNeedsOAuthRetry(false);
    setPendingOAuthProvider(provider);
    await markOAuthPending(provider);
    setIsLoading(true);
    setIsPendingOAuth(true);
  }, []);

  const clearOAuthRetryHint = useCallback(() => {
    setNeedsOAuthRetry(false);
    setPendingOAuthProvider(null);
    void clearOAuthPending();
  }, []);
  
  // Clear pending OAuth flag once user is authenticated (OAuth completed successfully)
  useEffect(() => {
    if (isPendingOAuth && authenticated && isReady) {
      void finishOAuthSuccess();
    }
  }, [isPendingOAuth, authenticated, isReady, finishOAuthSuccess]);

  // expo-web-browser: complete OAuth handoff when the app opens via redirect URL.
  useEffect(() => {
    maybeCompleteAuthSession();
  }, []);

  // Deep-link listener — detect OAuth redirect on warm resume.
  useEffect(() => {
    const handleIncomingUrl = (url: string) => {
      if (!isOAuthReturnUrl(url)) return;
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[OAuth] redirect received:', url);
      }
      maybeCompleteAuthSession();
      setIsPendingOAuth(true);
      setIsLoading(true);
      void readOAuthPending().then((pending) => {
        if (pending) setPendingOAuthProvider(pending.provider);
      });
    };

    void Linking.getInitialURL().then((url) => {
      if (url) handleIncomingUrl(url);
    });

    const sub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));
    return () => sub.remove();
  }, []);

  // Cold-start recovery — persisted marker survives Android process death.
  useEffect(() => {
    if (!isReady) return;
    if (authenticated) {
      void clearOAuthPending();
      setNeedsOAuthRetry(false);
      return;
    }

    let cancelled = false;
    (async () => {
      const pending = await readOAuthPending();
      if (cancelled || !pending) return;

      const age = Date.now() - pending.startedAt;
      setPendingOAuthProvider(pending.provider);

      if (age > OAUTH_MAX_AGE_MS) {
        await clearOAuthPending();
        setNeedsOAuthRetry(true);
        return;
      }

      setIsPendingOAuth(true);
      setIsLoading(true);
      await new Promise((resolve) => setTimeout(resolve, OAUTH_SETTLE_MS));
      if (cancelled || authenticatedRef.current) return;

      await failOAuthSession(pending.provider);
    })();

    return () => {
      cancelled = true;
    };
  }, [isReady, authenticated, failOAuthSession]);

  // Watchdog — if OAuth hangs without auth, surface retry instead of spinning forever.
  useEffect(() => {
    if (!isPendingOAuth || authenticated) return;

    const timer = setTimeout(() => {
      if (authenticatedRef.current) return;
      void readOAuthPending().then((pending) => {
        if (!pending) return;
        void failOAuthSession(pending.provider);
      });
    }, OAUTH_WATCHDOG_MS);

    return () => clearTimeout(timer);
  }, [isPendingOAuth, authenticated, failOAuthSession]);

  // Get wallet address — prefer UR test signer when import mode is active
  const isUrTestWalletImportEnabled =
    UR_TEST_WALLET_IMPORT_ENABLED
    && backendImportEnabled
    && isUrTestPrivyUser(privyUser?.id);

  const walletAddress = useMemo(() => {
    if (urTestWalletAddress && isUrTestWalletImportEnabled) {
      const target = urTestWalletAddress.toLowerCase();
      const match = wallets?.find((w) => w.address.toLowerCase() === target);
      if (match) return match.address;
      // Server import may land before the Expo SDK refreshes linked wallets.
      return urTestWalletAddress;
    }
    const primary = resolvePrimaryEthereumWallet({
      embeddedAddress: wallets?.[0]?.address,
      linkedAccounts: privyUser?.linked_accounts,
    });
    return primary?.address ?? null;
  }, [wallets, urTestWalletAddress, isUrTestWalletImportEnabled, privyUser?.linked_accounts]);

  const isExternalWalletUser = useMemo(() => {
    if (urTestWalletAddress && isUrTestWalletImportEnabled) return false;
    const primary = resolvePrimaryEthereumWallet({
      embeddedAddress: wallets?.[0]?.address,
      linkedAccounts: privyUser?.linked_accounts,
    });
    return primary?.kind === 'external';
  }, [wallets, privyUser?.linked_accounts, urTestWalletAddress, isUrTestWalletImportEnabled]);

  // Transform Privy user to our User format
  const extractedEmail = privyUser ? getEmailFromLinkedAccounts(privyUser.linked_accounts) : undefined;
  
  // Debug: Log linked accounts to help diagnose email extraction issues
  if (__DEV__ && privyUser && !extractedEmail) {
    console.log('[Privy] No email extracted from linked_accounts:', JSON.stringify(privyUser.linked_accounts, null, 2));
    console.log('[Privy] Privy user email field:', (privyUser as any)?.email);
  }
  
  const user: User | null = privyUser ? {
    id: privyUser.id,
    email: extractedEmail ?? (privyUser as any)?.email,
    phone: getPhoneFromLinkedAccounts(privyUser.linked_accounts),
    wallet: walletAddress ? {
      address: walletAddress,
      chainType: 'ethereum',
    } : undefined,
    createdAt: new Date(privyUser.created_at),
  } : null;

  // Sync zustand before paint. Home used to read the store one frame after
  // Privy `isReady`, treat that gap as guest, and flash the hero carousel.
  useLayoutEffect(() => {
    if (!isReady) return;
    if (authenticated && user) {
      setAuthenticated(true, user);
      setGuest(false);
      return;
    }
    // Only tear down a live session — not the first "ready but not yet
    // restored" tick, which would mark a returning user as guest.
    if (useAppStore.getState().isAuthenticated) {
      resetAppSession();
    }
  }, [authenticated, isReady, user, setAuthenticated, setGuest, resetAppSession]);

  useEffect(() => {
    if (!isReady) return;
    if (authenticated && user) {
      if (afAuthUserRef.current !== user.id) {
        afAuthUserRef.current = user.id;
        const linkedAccounts = privyUser?.linked_accounts || [];
        const loginMethod = resolveAuthMethod(linkedAccounts);

        void (async () => {
          const registered = await AppsFlyerAnalytics.logRegistrationOnce(user.id, loginMethod);
          if (registered) {
            Analytics.logSignUp(loginMethod);
          }
          await AppsFlyerAnalytics.logLogin(loginMethod);
          Analytics.logLogin(loginMethod);
          AppsFlyerAnalytics.setCustomerUserId(user.id);
          Analytics.setUserId(user.id);
          Analytics.setUserProperties({
            has_wallet: user.wallet?.address ? 'true' : 'false',
          });
        })();
      }
    } else {
      afAuthUserRef.current = null;
      Analytics.setUserId(null);
    }
  }, [authenticated, isReady, user, privyUser]);

  // Load backend UR test-wallet config once authenticated
  useEffect(() => {
    if (
      !UR_TEST_WALLET_IMPORT_ENABLED
      || !authenticated
      || !isReady
      || !isUrTestPrivyUser(privyUser?.id)
    ) {
      setBackendImportEnabled(false);
      setUrTestWalletAddress(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await privyGetAccessToken();
        if (!token || cancelled) return;
        const info = await fetchUrTestWalletInfo(token);
        if (cancelled) return;
        setBackendImportEnabled(!!info.enabled);
        setUrTestWalletAddress(info.address ?? null);
      } catch (err) {
        if (__DEV__) {
          console.log('[Privy] UR test wallet info unavailable:', err);
        }
        if (!cancelled) {
          setBackendImportEnabled(false);
          setUrTestWalletAddress(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, isReady, privyGetAccessToken]);

  // Get smart wallet address (ERC-4337 Smart Account) from linked_accounts or the client
  const smartWalletAddress = useMemo(() => {
    // Try the Smart Wallet client first (most up-to-date)
    if (smartWalletClient?.account?.address) {
      return smartWalletClient.account.address;
    }
    // Fallback: look in linked_accounts
    if (privyUser?.linked_accounts) {
      const sw = privyUser.linked_accounts.find((a: any) => a.type === 'smart_wallet') as any;
      if (sw?.address) return sw.address as string;
    }
    return null;
  }, [smartWalletClient, privyUser]);

  // Auto-create embedded wallet on first login if not exists (skip when UR test import is active
  // or when the user logged in with an external wallet only — Privy dashboard should not create
  // embedded wallets for wallet logins; we mirror that here defensively).
  useEffect(() => {
    if (isUrTestWalletImportEnabled) return;
    if (userHasExternalWalletOnlyLogin(privyUser?.linked_accounts)) return;
    if (authenticated && privyUser && wallets.length === 0) {
      createEthWallet().catch(err => {
        console.log('[Privy] Auto wallet creation failed:', err);
      });
    }
  }, [authenticated, privyUser, wallets, createEthWallet, isUrTestWalletImportEnabled]);

  // Solana embedded wallet for email/social users only (`embedded.solana.createOnLogin`
  // is `off` in _layout). External wallet logins must not get a Solana wallet. This
  // effect also covers legacy accounts that predate Solana. A second `create()` after
  // `createOnLogin` already finished throws "already exists" — harmless (ignored below).
  // In-flight map prevents Strict Mode / remount races from minting a 2nd Solana wallet.
  useEffect(() => {
    if (!authenticated || !privyUser) return;
    if (userHasExternalWalletOnlyLogin(privyUser.linked_accounts)) return;
    if (solanaWallet?.status !== 'not-created' || typeof solanaWallet.create !== 'function') return;

    const existing = (solanaWallet as { wallets?: unknown[] } | null)?.wallets;
    if (Array.isArray(existing) && existing.length > 0) return;

    const userId = privyUser.id;
    if (!userId || solanaCreateInFlightByUserId.has(userId)) return;

    const create = solanaWallet.create;
    const run = Promise.resolve(create())
      .catch((err: unknown) => {
        const msg = String(err instanceof Error ? err.message : err);
        if (/already exists/i.test(msg)) return;
        if (__DEV__) {
          console.log('[Privy] Auto Solana wallet creation failed:', err);
        }
      })
      .finally(() => {
        solanaCreateInFlightByUserId.delete(userId);
      });
    solanaCreateInFlightByUserId.set(userId, run);
  }, [authenticated, privyUser, solanaWallet]);

  // Dev-only: confirm Solana wallet is attached to the Privy account.
  // The address is logged here but never exposed via AuthContext, per
  // product decision to keep Solana hidden from the UI for now.
  // (May log twice in dev when React Strict Mode re-runs effects — harmless.)
  useEffect(() => {
    if (!__DEV__) return;
    if (solanaWallet?.status === 'connected') {
      const addr = (solanaWallet as any)?.wallets?.[0]?.address;
      if (addr) console.log('[Privy] Solana embedded wallet ready:', addr);
    }
  }, [solanaWallet]);

  // Register push token on login (silently fails if FCM not configured)
  // Also re-registers when walletAddress becomes available (for deposit notifications)
  useEffect(() => {
    if (authenticated && privyUser && isReady) {
      // Delay to ensure auth + wallet are fully ready
      const timer = setTimeout(async () => {
        try {
          const accessToken = await privyGetAccessToken();
          const userId = privyUser?.id ?? null;
          const cachedEnabled = userId ? await readCachedPushEnabled(userId) : null;
          let serverEnabled: boolean | null = null;
          if (accessToken) {
            try {
              const prefs = await getNotificationPreferences(accessToken);
              serverEnabled = readPushEnabledFlag(prefs);
              if (userId && cachedEnabled === null && serverEnabled !== null) {
                await writeCachedPushEnabled(userId, serverEnabled);
              }
            } catch {
              serverEnabled = null;
            }
          }
          const cachedNow = userId ? await readCachedPushEnabled(userId) : null;
          const enabled = cachedNow ?? serverEnabled;
          if (enabled === false) {
            if (__DEV__) console.log('[Privy] Push skipped — notifications off');
            return;
          }
          if (enabled !== true) {
            if (__DEV__) console.log('[Privy] Push skipped — preference unknown');
            return;
          }
          const pushToken = await registerForPushNotifications();
          if (pushToken) {
            pushTokenRef.current = pushToken;
            setSessionPushToken(pushToken);
            const token = accessToken ?? (await privyGetAccessToken());
            if (token) {
              const deviceId = await getNotificationDeviceId();
              await registerPushTokenWithBackend(
                pushToken,
                token,
                deviceId ?? undefined,
                walletAddress ?? undefined,
              );
            }
          }
          // If pushToken is null, FCM may not be configured - that's okay
        } catch (error: any) {
          // Silently ignore FCM/Firebase configuration errors
          // This is expected in development or if FCM isn't set up yet
          if (__DEV__) {
            console.log('[Privy] Push notifications not available:', error?.message?.substring(0, 50));
          }
        } finally {
          // Mark prompt completion so other UI can wait for it.
          try {
            await AsyncStorage.setItem(NOTIF_PROMPT_DONE_KEY, String(Date.now()));
          } catch {
            // ignore storage errors
          }
        }
      }, 2000); // Increased delay to ensure Firebase has time to initialize
      
      return () => clearTimeout(timer);
    }
  }, [authenticated, privyUser, isReady, privyGetAccessToken, walletAddress]);

  // Send email verification code
  const sendEmailCode = useCallback(async (email: string) => {
    setIsLoading(true);
    try {
      setPendingEmail(email);
      await sendCode({ email });
    } catch (error: any) {
      setPendingEmail(null);
      console.error('[Privy] Send code error:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [sendCode]);

  // Verify email code and login
  const verifyEmailCode = useCallback(async (code: string) => {
    if (!pendingEmail) {
      throw new Error('No pending email verification');
    }
    setIsLoading(true);
    try {
      await loginWithCode({ code, email: pendingEmail });
      setPendingEmail(null);
    } catch (error: any) {
      // Only log in dev, don't show to user (UI handles the error display)
      if (__DEV__) {
        console.log('[Privy] Verify code error:', error?.message || error);
      }
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [loginWithCode, pendingEmail]);

  const clearPendingEmailVerification = useCallback(() => {
    setPendingEmail(null);
  }, []);

  const sendLinkEmailCode = useCallback(async (email: string) => {
    setIsLoading(true);
    try {
      setPendingLinkEmail(email);
      await sendLinkCode({ email });
    } catch (error: unknown) {
      setPendingLinkEmail(null);
      console.error('[Privy] Send link email code error:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [sendLinkCode]);

  const verifyLinkEmailCode = useCallback(async (code: string) => {
    if (!pendingLinkEmail) {
      throw new Error('No pending email verification');
    }
    setIsLoading(true);
    try {
      const linkedUser = await linkWithCode({ code, email: pendingLinkEmail });
      const accounts =
        linkedUser?.linked_accounts
        ?? (linkedUser as { linkedAccounts?: LinkedAccount[] } | undefined)?.linkedAccounts
        ?? [];
      const linkedEmail = getEmailFromLinkedAccounts(accounts) ?? pendingLinkEmail;
      setPendingLinkEmail(null);
      return linkedEmail;
    } catch (error: unknown) {
      if (__DEV__) {
        console.log('[Privy] Verify link email code error:', (error as Error)?.message || error);
      }
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [linkWithCode, pendingLinkEmail]);

  const clearPendingLinkEmailVerification = useCallback(() => {
    setPendingLinkEmail(null);
  }, []);

  const isLinkingEmail =
    linkEmailState.status === 'sending-code' || linkEmailState.status === 'submitting-code';

  const runOAuthLogin = useCallback(async (provider: OAuthProviderName) => {
    await startOAuthSession(provider);
    const attemptLogin = async () => {
      await prepareOAuthBrowserSession();
      await oauthLogin({ provider, redirectUri: '/' });
    };
    try {
      await attemptLogin();
    } catch (error: unknown) {
      if (isOAuthBrowserBusyError(error)) {
        await prepareOAuthBrowserSession();
        try {
          await attemptLogin();
          return;
        } catch (retryError: unknown) {
          if (isOAuthCancelledError(retryError)) {
            setIsPendingOAuth(false);
            setIsLoading(false);
            setPendingOAuthProvider(null);
            await clearOAuthPending();
            return;
          }
          await failOAuthSession(provider);
          throw retryError;
        }
      }
      if (isOAuthCancelledError(error)) {
        setIsPendingOAuth(false);
        setIsLoading(false);
        setPendingOAuthProvider(null);
        await clearOAuthPending();
        return;
      }
      await failOAuthSession(provider);
      throw error;
    }
  }, [oauthLogin, startOAuthSession, failOAuthSession]);

  // Login with Google OAuth
  const loginWithGoogle = useCallback(async () => {
    try {
      await runOAuthLogin('google');
    } catch (error: unknown) {
      if (String((error as { message?: string })?.message || '').includes('Redirect URL scheme is not allowed')) {
        console.error(
          '[Privy] Google login error: Redirect URL scheme is not allowed. ' +
            'Check Privy Dashboard → Clients → Mobile client URL schemes. ' +
            'It must include your app scheme (from app.json `expo.scheme`), e.g. `hypertrade`.',
        );
      }
      console.error('[Privy] Google login error:', error);
      throw error;
    }
  }, [runOAuthLogin]);

  // Login with Apple (native on iOS, web fallback on Android)
  const loginWithApple = useCallback(async () => {
    try {
      await runOAuthLogin('apple');
    } catch (error: unknown) {
      console.error('[Privy] Apple login error:', error);
      throw error;
    }
  }, [runOAuthLogin]);

  // Login with Telegram OAuth (Web OIDC via auth.privy.io).
  const loginWithTelegram = useCallback(async () => {
    try {
      await runOAuthLogin('telegram');
    } catch (error: unknown) {
      console.error('[Privy] Telegram login error:', error);
      throw error;
    }
  }, [runOAuthLogin]);

  const loginWithTwitter = useCallback(async () => {
    try {
      await runOAuthLogin('twitter');
    } catch (error: unknown) {
      console.error('[Privy] Twitter login error:', error);
      throw error;
    }
  }, [runOAuthLogin]);

  /**
   * Wallet login via WalletConnect + Privy SIWE.
   * @see https://docs.privy.io/authentication/user-authentication/login-methods/wallet
   */
  const loginWithWallet = useCallback(async () => {
    if (walletLoginPromiseRef.current) {
      return walletLoginPromiseRef.current;
    }

    const generation = walletLoginGenerationRef.current + 1;
    walletLoginGenerationRef.current = generation;

    const run = (async () => {
      setIsLoading(true);
      setIsPendingWalletLogin(true);
      try {
        if (__DEV__) console.log('[Privy] Wallet login: connecting…');
        const { address, provider } = await connectExternalWallet();
        if (generation !== walletLoginGenerationRef.current) return;

        if (__DEV__) console.log('[Privy] Wallet login: connected', address);

        // Guard against a stale/mismatched WalletConnect session: confirm the
        // provider is actually authorized to sign for `address` before we build
        // and submit the SIWE message. If a lingering session (e.g. a previous
        // login with a different wallet) is still active, signing would recover
        // to the wrong address and Privy would reject it as "Invalid SIWE
        // message and/or signature". Fail fast with an actionable message
        // instead. (null = couldn't determine; we proceed and let Privy decide.)
        const signerAddress = await getExternalWalletSignerAddress();
        if (generation !== walletLoginGenerationRef.current) return;
        if (signerAddress && signerAddress.toLowerCase() !== address.toLowerCase()) {
          throw new Error(
            'Connected wallet account changed. Please reconnect your wallet and try again.',
          );
        }

        const message = await generateSiweMessage({
          wallet: { address, chainId: SIWE_CHAIN_ID_CAIP2 },
          from: { domain: SIWE_DOMAIN, uri: SIWE_URI },
        });
        if (generation !== walletLoginGenerationRef.current) return;

        if (__DEV__) console.log('[Privy] Wallet login: requesting SIWE signature…');
        // Per the personal_sign spec the data param must be hex-encoded UTF-8.
        // Some wallets (Rainbow) tolerate plain text, but MetaMask mobile over
        // WalletConnect signs plain strings inconsistently, producing a
        // signature that recovers to the wrong address — Privy then rejects it
        // as "Invalid SIWE message and/or signature". Hex is the portable form.
        const hexMessage = stringToHex(message);
        const signature = (await provider.request({
          method: 'personal_sign',
          params: [hexMessage, address],
        })) as string;
        if (generation !== walletLoginGenerationRef.current) return;

        // Verify locally BEFORE submitting to Privy: recover the signer from
        // the signature and confirm it's the SIWE address. Catches the two
        // real-world failure modes with a precise, actionable error instead of
        // Privy's opaque "Invalid SIWE message and/or signature":
        //   1. Wallet signed with a different account than the connected one
        //      (MetaMask multi-account selection).
        //   2. Smart-account (EIP-1271/7702) signature — not a 65-byte EOA
        //      signature, cannot be recovered, and unusable for SIWE here.
        try {
          const recovered = await recoverMessageAddress({
            message,
            signature: signature as `0x${string}`,
          });
          if (recovered.toLowerCase() !== address.toLowerCase()) {
            if (__DEV__) {
              console.log('[Privy] SIWE signer mismatch:', { expected: address, recovered });
            }
            throw new Error(
              'Your wallet signed with a different account than the one connected. '
              + 'Open your wallet, switch to the connected account, and try again.',
            );
          }
        } catch (verifyErr: unknown) {
          if (verifyErr instanceof Error && /different account/.test(verifyErr.message)) {
            throw verifyErr;
          }
          // Recovery itself failed → not a standard 65-byte EOA signature
          // (likely a smart-account wallet). Surface a clear error.
          if (__DEV__) {
            console.log('[Privy] SIWE signature recovery failed:', verifyErr, {
              signatureLength: signature?.length,
            });
          }
          throw new Error(
            'This wallet returned a smart-account signature, which is not supported for login. '
            + 'If you use MetaMask, disable "Smart account" for this account and try again.',
          );
        }
        if (generation !== walletLoginGenerationRef.current) return;

        await loginWithSiwe({ signature, messageOverride: message });
        if (generation !== walletLoginGenerationRef.current) return;

        if (__DEV__) console.log('[Privy] Wallet login: SIWE complete');
      } catch (error: unknown) {
        if (generation !== walletLoginGenerationRef.current) return;
        if (authenticatedRef.current) return;

        const message = error instanceof Error ? error.message : '';
        const isStaleWalletError =
          message.includes('Request expired')
          || message.includes('Wallet connect cancelled')
          || message.includes('Wallet connect superseded');

        if (!isStaleWalletError) {
          console.error('[Privy] Wallet login error:', error);
        }
        throw error;
      } finally {
        // Always drop the AppKit overlay after SIWE (success or fail). A hung
        // native modal after returning from MetaMask freezes Home.
        forceCloseWalletConnectModal();
        setTimeout(forceCloseWalletConnectModal, 400);
        if (generation === walletLoginGenerationRef.current) {
          setIsLoading(false);
          setIsPendingWalletLogin(false);
        }
      }
    })();

    walletLoginPromiseRef.current = run;
    try {
      await run;
    } finally {
      if (walletLoginPromiseRef.current === run) {
        walletLoginPromiseRef.current = null;
      }
    }
  }, [generateSiweMessage, loginWithSiwe]);

  const retryPendingOAuth = useCallback(async () => {
    const provider = pendingOAuthProvider ?? (await readOAuthPending())?.provider;
    if (!provider) return;
    setNeedsOAuthRetry(false);
    if (provider === 'google') await loginWithGoogle();
    else if (provider === 'apple') await loginWithApple();
    else if (provider === 'twitter') await loginWithTwitter();
    else await loginWithTelegram();
  }, [pendingOAuthProvider, loginWithGoogle, loginWithApple, loginWithTelegram, loginWithTwitter]);

  // Create embedded wallet manually if needed
  const createWallet = useCallback(async () => {
    if (wallets.length === 0) {
      setIsLoading(true);
      try {
        await createEthWallet();
        return wallets?.[0]?.address || null;
      } catch (error: any) {
        console.error('[Privy] Create wallet error:', error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    }
    return wallets[0]?.address || null;
  }, [wallets, createEthWallet]);

  const importUrTestWallet = useCallback(async (): Promise<string> => {
    if (!isUrTestWalletImportEnabled) {
      throw new Error('UR test wallet import is not enabled');
    }
    if (!authenticated) {
      throw new Error('Sign in first, then attach the UR test wallet');
    }
    setIsLoading(true);
    try {
      const token = await privyGetAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }
      const result = await importUrTestWalletApi(token);
      // Refresh Privy session so linked_accounts pick up the imported wallet
      await privyGetAccessToken();
      if (result.address) {
        setUrTestWalletAddress(result.address);
      }
      return result.address;
    } finally {
      setIsLoading(false);
    }
  }, [authenticated, isUrTestWalletImportEnabled, privyGetAccessToken]);

  // Auto-attach UR test wallet after login when enabled
  useEffect(() => {
    if (!isUrTestWalletImportEnabled || !authenticated || !isReady || !urTestWalletAddress) {
      return;
    }
    const target = urTestWalletAddress.toLowerCase();
    const alreadyLinked = wallets.some((w) => w.address.toLowerCase() === target);
    if (alreadyLinked || urImportAttemptedRef.current) return;

    urImportAttemptedRef.current = true;
    importUrTestWallet().catch((err: unknown) => {
      urImportAttemptedRef.current = false;
      if (__DEV__) {
        console.log('[Privy] UR test wallet import failed:', err);
      }
    });
  }, [
    isUrTestWalletImportEnabled,
    authenticated,
    isReady,
    urTestWalletAddress,
    wallets,
    importUrTestWallet,
  ]);

  // Logout
  const logout = useCallback(async () => {
    setIsLoading(true);
    try {
      await clearDemoStatusCache(user?.id);
      await clearTradingSetupState();
      await disconnectExternalWallet().catch(() => { /* ignore */ });
      resetAppSession();
      queryClient.removeQueries({ queryKey: ['notification-preferences'] });

      // Unregister this device token on logout (opt-out cache stays per user).
      const tokenToDrop = getSessionPushToken() ?? pushTokenRef.current;
      if (tokenToDrop) {
        try {
          const accessToken = await privyGetAccessToken();
          if (accessToken) {
            await unregisterPushToken(tokenToDrop, accessToken);
          }
        } catch (e) {
          console.log('[Privy] Failed to unregister push token:', e);
        }
      }
      pushTokenRef.current = null;
      setSessionPushToken(null);
      
      await privyLogout();
      setPendingEmail(null);
      setPendingLinkEmail(null);
      setIsPendingOAuth(false);
      setIsPendingWalletLogin(false);
      setPendingOAuthProvider(null);
      setNeedsOAuthRetry(false);
      await clearOAuthPending();
      urImportAttemptedRef.current = false;
      setUrTestWalletAddress(null);
      setBackendImportEnabled(false);
    } catch (error: any) {
      console.error('[Privy] Logout error:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress, user?.id, resetAppSession, privyLogout, privyGetAccessToken, queryClient]);

  // Get access token for authenticated API calls
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!authenticated || !privyGetAccessToken) {
      return null;
    }
    try {
      const token = await privyGetAccessToken();
      return token;
    } catch (error: any) {
      console.error('[Privy] Get access token error:', error);
      return null;
    }
  }, [authenticated, privyGetAccessToken]);

  const value: AuthContextType = {
    isReady,
    isAuthenticated: authenticated,
    isLoading: isLoading || emailState.status === 'sending-code' || isLinkingEmail,
    isPendingOAuth,
    isPendingWalletLogin,
    pendingOAuthProvider,
    needsOAuthRetry,
    clearOAuthRetryHint,
    retryPendingOAuth,
    user,
    walletAddress,
    smartWalletAddress,
    sendEmailCode,
    verifyEmailCode,
    clearPendingEmailVerification,
    sendLinkEmailCode,
    verifyLinkEmailCode,
    clearPendingLinkEmailVerification,
    pendingLinkEmail,
    isLinkingEmail,
    loginWithGoogle,
    loginWithApple,
    loginWithTelegram,
    loginWithTwitter,
    loginWithWallet,
    isExternalWalletUser,
    createWallet,
    importUrTestWallet: isUrTestWalletImportEnabled ? importUrTestWallet : undefined,
    urTestWalletAddress: isUrTestWalletImportEnabled ? urTestWalletAddress : null,
    isUrTestWalletImportEnabled,
    logout,
    pendingEmail,
    getAccessToken,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
