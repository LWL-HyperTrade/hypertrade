import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  PrivyProvider,
  useCreateWallet,
  useLinkAccount,
  useLogin,
  useLoginWithOAuth,
  usePrivy,
  useUnlinkOAuth,
  useUnlinkTelegram,
  useWallets,
} from '@privy-io/react-auth';
import type { OAuthProviderType } from '@privy-io/react-auth';
import { arbitrum } from 'viem/chains';
import { PRIVY_APP_ID, WALLETCONNECT_PROJECT_ID } from './config';
import { pickBuilderWallet, pickImportedBuilderAddress, pickTradeWallet } from './embeddedWallets';
import type { Eip1193Provider } from './hlTrade';
import { robinhood } from './pons/chain';

export type WebAuth = {
  ready: boolean;
  hydrating: boolean;
  authenticated: boolean;
  userId: string | null;
  email: string | null;
  /** Best-effort profile image from linked socials (Twitter, etc.). */
  avatarUrl: string | null;
  /** HD 0 — trade / deposit / unified. Never the builder. */
  address: `0x${string}` | null;
  /** Claimed builder EOA (HD 1 or imported MetaMask). Never unify. */
  builderAddress: `0x${string}` | null;
  login: () => void;
  loginWithGoogle: () => Promise<void>;
  googleBusy: boolean;
  loginError: string | null;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** Provider for the trade wallet (HD 0). */
  getEthereumProvider: () => Promise<Eip1193Provider | null>;
  /**
   * Switch the trade wallet (HD 0) to a chain in `supportedChains`
   * (Privy `ConnectedWallet.switchChain`). Used for Pons on Robinhood Chain.
   */
  switchTradeChain: (chainId: number) => Promise<void>;
  /**
   * Switch the claimed builder (HD 1 or imported) via `ConnectedWallet.switchChain`.
   * Embedded updates silently; MetaMask prompts. Required before Arb USDC permits.
   * https://docs.privy.io/wallets/using-wallets/ethereum/switch-chain
   */
  switchBuilderChain: (chainId: number, want?: string | null) => Promise<void>;
  /** Provider for the claimed builder. Do not run trading setup on this. */
  getBuilderEthereumProvider: (want?: string | null) => Promise<Eip1193Provider | null>;
  /** Trade wallet is a Privy embedded EOA. */
  isEmbedded: boolean;
  privyConfigured: boolean;
  /**
   * Socials Privy has OAuth-verified for this user. These are the only handles
   * an app may publish — the backend re-checks them against Privy.
   */
  socials: VerifiedSocials;
  /** Start Privy's OAuth link flow. Redirects; wizard drafts must be persisted first. */
  linkSocial: (provider: SocialProvider) => void;
  /** Unlink a Privy-verified social. Needs at least one other login method on the account. */
  unlinkSocial: (provider: SocialProvider) => Promise<void>;
  linkError: string | null;
};

export type SocialProvider =
  | 'twitter'
  | 'telegram'
  | 'discord'
  | 'tiktok'
  | 'instagram'
  | 'youtube'
  | 'twitch';
export type VerifiedSocials = Record<SocialProvider, string>;
export const SOCIAL_PROVIDERS: SocialProvider[] = [
  'twitter',
  'telegram',
  'discord',
  'tiktok',
  'instagram',
  'youtube',
  'twitch',
];
const NO_SOCIALS: VerifiedSocials = {
  twitter: '',
  telegram: '',
  discord: '',
  tiktok: '',
  instagram: '',
  youtube: '',
  twitch: '',
};

const SESSION_KEY = 'ht-pad-authed';
const LOGIN_NEXT_KEY = 'ht-pad-login-next';

/** Privy OAuth redirect allowlist is exact — always return to `/login` on this origin. */
export function oauthReturnUrl(): string {
  if (typeof window === 'undefined') return '/login';
  return `${window.location.origin}/login`;
}

function currentPath(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}

/** Same-origin relative path only — never send the session to another host. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let path = raw.trim();
  try {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      if (typeof window !== 'undefined' && u.origin !== window.location.origin) return null;
      path = `${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    return null;
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/login')) return null;
  if (path.includes('\\')) return null;
  return path;
}

function queryNext(search?: string): string | null {
  try {
    const q = new URLSearchParams(search ?? (typeof window !== 'undefined' ? window.location.search : ''));
    return safeReturnPath(q.get('next'));
  } catch {
    return null;
  }
}

/** `/login?next=/t/slug` so OAuth can round-trip to `/login` and still restore the page. */
export function loginHref(next?: string | null): string {
  const path = safeReturnPath(next) ?? safeReturnPath(currentPath());
  if (!path || path === '/') return '/login';
  return `/login?next=${encodeURIComponent(path)}`;
}

export function stashLoginReturn(path?: string | null): void {
  if (typeof window === 'undefined') return;
  const dest = safeReturnPath(path) ?? queryNext() ?? safeReturnPath(currentPath());
  if (!dest) return;
  try {
    sessionStorage.setItem(LOGIN_NEXT_KEY, dest);
  } catch {
    /* private mode */
  }
}

export function takeLoginReturn(search?: string): string {
  const fromQuery = queryNext(search);
  try {
    const raw = sessionStorage.getItem(LOGIN_NEXT_KEY);
    sessionStorage.removeItem(LOGIN_NEXT_KEY);
    return fromQuery ?? safeReturnPath(raw) ?? '/';
  } catch {
    return fromQuery ?? '/';
  }
}

function privyEmail(user: ReturnType<typeof usePrivy>['user']): string | null {
  if (!user) return null;
  if (user.email?.address?.trim()) return user.email.address.trim();
  if (user.google?.email?.trim()) return user.google.email.trim();
  return null;
}

function pictureFrom(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  for (const key of ['profilePictureUrl', 'profile_picture_url', 'photoUrl', 'photo_url']) {
    const v = o[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return null;
}

function privyAvatarUrl(user: ReturnType<typeof usePrivy>['user']): string | null {
  if (!user) return null;
  const fromTwitter = pictureFrom(user.twitter);
  if (fromTwitter) return fromTwitter;
  const fromTelegram = pictureFrom(user.telegram);
  if (fromTelegram) return fromTelegram;
  for (const account of user.linkedAccounts ?? []) {
    const url = pictureFrom(account);
    if (url) return url;
  }
  return null;
}

function cleanHandle(v: string | null | undefined): string {
  return (v ?? '').trim().replace(/^@/, '');
}

function youtubeFromGoogle(user: ReturnType<typeof usePrivy>['user']): string {
  if (!user?.google) return '';
  const name = cleanHandle(user.google.name);
  if (name) return name;
  const email = (user.google.email ?? '').trim();
  return cleanHandle(email.split('@')[0]);
}

function twitchLoginFrom(row: { username?: string | null; name?: string | null; login?: string | null; preferred_username?: string | null }): string {
  for (const raw of [row.username, row.login, row.preferred_username, row.name]) {
    const h = cleanHandle(raw);
    if (/^[a-zA-Z0-9_]{3,25}$/.test(h)) return h.toLowerCase();
  }
  return '';
}

/**
 * Native Twitch → `user.twitch` / `twitch_oauth`.
 * Custom OAuth (display name Twitch) → `custom:twitch` or legacy `privy:twitch`.
 */
function twitchFromLinked(user: ReturnType<typeof usePrivy>['user']): string {
  if (!user) return '';
  const native = (user as { twitch?: { username?: string | null; name?: string | null; login?: string | null } }).twitch;
  const fromNative = native ? twitchLoginFrom(native) : '';
  if (fromNative) return fromNative;
  for (const raw of user.linkedAccounts ?? []) {
    const row = raw as {
      type?: string;
      username?: string | null;
      name?: string | null;
      login?: string | null;
      preferred_username?: string | null;
    };
    const t = String(row.type ?? '').toLowerCase();
    if (t !== 'twitch_oauth' && !t.includes('twitch') && t !== 'custom:twitch' && t !== 'privy:twitch') {
      continue;
    }
    const hit = twitchLoginFrom(row);
    if (hit) return hit;
  }
  return '';
}

function accountSubject(account: unknown): string | null {
  if (!account || typeof account !== 'object') return null;
  const o = account as Record<string, unknown>;
  if (typeof o.subject === 'string' && o.subject) return o.subject;
  if (typeof o.telegramUserId === 'string' && o.telegramUserId) return o.telegramUserId;
  if (typeof o.telegram_user_id === 'string' && o.telegram_user_id) return o.telegram_user_id;
  return null;
}

function oauthSubject(
  user: ReturnType<typeof usePrivy>['user'],
  type: string,
): string | null {
  if (!user) return null;
  for (const raw of user.linkedAccounts ?? []) {
    const row = raw as { type?: string };
    if (String(row.type ?? '') !== type) continue;
    const sub = accountSubject(raw);
    if (sub) return sub;
  }
  return null;
}

function socialUnlinkId(
  user: NonNullable<ReturnType<typeof usePrivy>['user']>,
  provider: SocialProvider,
): { kind: 'oauth' | 'telegram' | 'custom'; provider?: string; id: string } | null {
  if (provider === 'twitter') {
    const id = accountSubject(user.twitter) ?? oauthSubject(user, 'twitter_oauth');
    return id ? { kind: 'oauth', provider: 'twitter', id } : null;
  }
  if (provider === 'discord') {
    const id = accountSubject(user.discord) ?? oauthSubject(user, 'discord_oauth');
    return id ? { kind: 'oauth', provider: 'discord', id } : null;
  }
  if (provider === 'tiktok') {
    const id = accountSubject(user.tiktok) ?? oauthSubject(user, 'tiktok_oauth');
    return id ? { kind: 'oauth', provider: 'tiktok', id } : null;
  }
  if (provider === 'instagram') {
    const id = accountSubject(user.instagram) ?? oauthSubject(user, 'instagram_oauth');
    return id ? { kind: 'oauth', provider: 'instagram', id } : null;
  }
  if (provider === 'youtube') {
    const id = accountSubject(user.google) ?? oauthSubject(user, 'google_oauth');
    return id ? { kind: 'oauth', provider: 'google', id } : null;
  }
  if (provider === 'telegram') {
    const id = accountSubject(user.telegram) ?? oauthSubject(user, 'telegram');
    return id ? { kind: 'telegram', id } : null;
  }
  if (provider === 'twitch') {
    const native = (user as { twitch?: { subject?: string | null } }).twitch;
    const nativeId = accountSubject(native) ?? (typeof native?.subject === 'string' ? native.subject : null);
    if (nativeId) return { kind: 'oauth', provider: 'twitch', id: nativeId };
    for (const raw of user.linkedAccounts ?? []) {
      const row = raw as { type?: string };
      const t = String(row.type ?? '').toLowerCase();
      const id = accountSubject(raw);
      if (!id || !t.includes('twitch')) continue;
      if (t === 'twitch_oauth') return { kind: 'oauth', provider: 'twitch', id };
      if (t.startsWith('custom:') || t.startsWith('privy:')) {
        return { kind: 'custom', provider: t, id };
      }
      return { kind: 'oauth', provider: 'twitch', id };
    }
  }
  return null;
}

function privySocials(user: ReturnType<typeof usePrivy>['user']): VerifiedSocials {
  if (!user) return NO_SOCIALS;
  return {
    twitter: cleanHandle(user.twitter?.username),
    telegram: cleanHandle(user.telegram?.username),
    discord: cleanHandle(user.discord?.username),
    tiktok: cleanHandle(user.tiktok?.username),
    instagram: cleanHandle(user.instagram?.username),
    youtube: youtubeFromGoogle(user),
    twitch: twitchFromLinked(user),
  };
}

const GUEST: WebAuth = {
  ready: true,
  hydrating: false,
  authenticated: false,
  userId: null,
  email: null,
  avatarUrl: null,
  address: null,
  builderAddress: null,
  login: () => undefined,
  loginWithGoogle: async () => undefined,
  googleBusy: false,
  loginError: null,
  logout: async () => undefined,
  getAccessToken: async () => null,
  getEthereumProvider: async () => null,
  switchTradeChain: async () => {
    throw new Error('Sign in first');
  },
  switchBuilderChain: async () => {
    throw new Error('Sign in first');
  },
  getBuilderEthereumProvider: async () => null,
  isEmbedded: false,
  privyConfigured: false,
  socials: NO_SOCIALS,
  linkSocial: () => undefined,
  unlinkSocial: async () => undefined,
  linkError: null,
};

const AuthContext = createContext<WebAuth>(GUEST);

export function useWebAuth(): WebAuth {
  return useContext(AuthContext);
}

function linkedAccountsOf(user: ReturnType<typeof usePrivy>['user']) {
  return (user?.linkedAccounts ?? []) as Array<{
    type?: string;
    address?: string;
    walletIndex?: number;
    wallet_index?: number;
    walletClientType?: string;
    connectorType?: string;
  }>;
}

function hasEmbeddedWallet(
  user: ReturnType<typeof usePrivy>['user'],
  wallets: ReturnType<typeof useWallets>['wallets'],
): boolean {
  if (wallets.some((w) => w.walletClientType === 'privy')) return true;
  for (const account of user?.linkedAccounts ?? []) {
    if (!account || typeof account !== 'object') continue;
    const row = account as { type?: string; walletClientType?: string; connectorType?: string };
    if (row.type !== 'wallet') continue;
    if (row.walletClientType === 'privy' || row.connectorType === 'embedded') return true;
  }
  return false;
}

/** Privy fires onError when the user closes the modal — not a real failure. */
function isUserExitedAuth(error: unknown): boolean {
  const raw =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : String(error ?? '');
  const s = raw.toLowerCase();
  return (
    s.includes('exited_auth_flow') ||
    s.includes('exited auth flow') ||
    s.includes('user_exited') ||
    s.includes('user_cancelled') ||
    s.includes('user canceled') ||
    s.includes('user cancelled') ||
    s.includes('closed_modal')
  );
}

function authErrorMessage(error: unknown): string | null {
  if (isUserExitedAuth(error)) return null;
  const msg =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? error)
        : String(error ?? 'Sign-in failed');
  const trimmed = msg.trim();
  return trimmed || null;
}

function PrivyAuthBridge({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const walletsState = useWallets();
  const [loginError, setLoginError] = useState<string | null>(null);
  const { login: openLoginModal } = useLogin({
    onError: (error) => setLoginError(authErrorMessage(error)),
  });
  const { initOAuth, loading: googleBusy } = useLoginWithOAuth({
    onError: (error) => setLoginError(authErrorMessage(error)),
  });
  const { createWallet } = useCreateWallet();
  const [linkError, setLinkError] = useState<string | null>(null);
  const {
    linkTwitter,
    linkTelegram,
    linkDiscord,
    linkTiktok,
    linkInstagram,
    linkGoogle,
    linkTwitch,
  } = useLinkAccount({
    onError: (error) => setLinkError(authErrorMessage(error)),
  });
  const { unlink: unlinkOAuth } = useUnlinkOAuth();
  const { unlink: unlinkTelegram } = useUnlinkTelegram();
  const walletCreateStarted = useRef(false);
  const linked = linkedAccountsOf(privy.user);
  const wallet = privy.ready ? pickTradeWallet(walletsState.wallets, linked) : null;
  const builderWallet = privy.ready
    ? pickBuilderWallet(walletsState.wallets, linked, wallet?.address)
    : null;
  const importedBuilder = privy.ready
    ? pickImportedBuilderAddress(walletsState.wallets, linked, wallet?.address)
    : null;
  const address = (wallet?.address as `0x${string}` | undefined) ?? null;
  const builderAddress =
    ((builderWallet?.address || importedBuilder) as `0x${string}` | undefined) ?? null;

  // Async flows (switch chain → get provider → send) must not read the wallets
  // captured at click time. Privy replaces `ConnectedWallet` objects after
  // `switchChain`; a stale object's provider keeps reporting the old chain, so
  // the first attempt fails and the retry works. Always go through these refs.
  const walletsRef = useRef(walletsState.wallets);
  walletsRef.current = walletsState.wallets;
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const addressRef = useRef(address);
  addressRef.current = address;
  const builderAddressRef = useRef(builderAddress);
  builderAddressRef.current = builderAddress;

  const [hadSession, setHadSession] = useState(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!privy.ready) return;
    try {
      if (privy.authenticated) {
        sessionStorage.setItem(SESSION_KEY, '1');
        setHadSession(true);
      } else {
        sessionStorage.removeItem(SESSION_KEY);
        setHadSession(false);
        walletCreateStarted.current = false;
      }
    } catch {
      /* private mode */
    }
  }, [privy.ready, privy.authenticated]);

  // Headless Google does not auto-create wallets — same as OrbCast web.
  useEffect(() => {
    if (!privy.ready || !privy.authenticated) return;
    if (hasEmbeddedWallet(privy.user, walletsState.wallets)) return;
    if (walletCreateStarted.current) return;
    walletCreateStarted.current = true;
    void createWallet().catch((err) => {
      const msg = String(err ?? '');
      if (/already has an? embedded wallet/i.test(msg)) return;
      walletCreateStarted.current = false;
      console.warn('[pad] embedded wallet create', err);
    });
  }, [privy.ready, privy.authenticated, privy.user, walletsState.wallets, createWallet]);

  const hydrating = !privy.ready || (!address && (privy.authenticated || hadSession));

  const value = useMemo<WebAuth>(
    () => ({
      ready: privy.ready,
      hydrating,
      authenticated: privy.authenticated,
      userId: privy.user?.id ?? null,
      email: privyEmail(privy.user),
      avatarUrl: privyAvatarUrl(privy.user),
      address,
      builderAddress,
      login: () => {
        setLoginError(null);
        stashLoginReturn();
        openLoginModal({ walletChainType: 'ethereum-only' });
      },
      loginWithGoogle: async () => {
        setLoginError(null);
        stashLoginReturn();
        await initOAuth({ provider: 'google' });
      },
      googleBusy,
      loginError,
      logout: () => privy.logout(),
      getAccessToken: () => privy.getAccessToken(),
      getEthereumProvider: async () => {
        const builder = builderAddressRef.current;
        const w = pickTradeWallet(walletsRef.current, linkedRef.current);
        if (!w || typeof w.getEthereumProvider !== 'function') return null;
        if (builder && w.address.toLowerCase() === builder.toLowerCase()) return null;
        return (await w.getEthereumProvider()) as Eip1193Provider;
      },
      switchTradeChain: async (chainId: number) => {
        const builder = builderAddressRef.current;
        const w = pickTradeWallet(walletsRef.current, linkedRef.current);
        if (!w) throw new Error('Trade wallet is not ready');
        if (builder && w.address.toLowerCase() === builder.toLowerCase()) {
          throw new Error('Refusing to switch the builder wallet');
        }
        await w.switchChain(chainId);
      },
      switchBuilderChain: async (chainId: number, want?: string | null) => {
        const trade = addressRef.current;
        const target = (want || builderAddressRef.current || '').toLowerCase();
        if (!target) throw new Error('Builder wallet is not ready');
        if (trade && target === trade.toLowerCase()) {
          throw new Error('Refusing to switch the trade wallet');
        }
        const w = walletsRef.current.find((row) => row.address.toLowerCase() === target);
        if (!w || typeof w.switchChain !== 'function') {
          throw new Error('Connect the builder wallet to continue');
        }
        await w.switchChain(chainId);
      },
      getBuilderEthereumProvider: async (want?: string | null) => {
        const trade = addressRef.current;
        const target = (want || builderAddressRef.current || '').toLowerCase();
        if (!target) return null;
        if (trade && target === trade.toLowerCase()) return null;
        const w = walletsRef.current.find((row) => row.address.toLowerCase() === target);
        if (!w || typeof w.getEthereumProvider !== 'function') return null;
        return (await w.getEthereumProvider()) as Eip1193Provider;
      },
      isEmbedded: wallet?.walletClientType === 'privy',
      privyConfigured: true,
      socials: privySocials(privy.user),
      linkSocial: (provider) => {
        setLinkError(null);
        // OAuth leaves the page; come back to where the wizard was.
        stashLoginReturn();
        if (provider === 'twitter') linkTwitter();
        else if (provider === 'telegram') linkTelegram();
        else if (provider === 'discord') linkDiscord();
        else if (provider === 'tiktok') linkTiktok();
        else if (provider === 'instagram') linkInstagram();
        else if (provider === 'youtube') linkGoogle();
        else if (provider === 'twitch') {
          // Native Twitch (dashboard Client ID/Secret) — first-class on react-auth ≥3.
          linkTwitch();
        }
      },
      unlinkSocial: async (provider) => {
        setLinkError(null);
        const user = privy.user;
        if (!user) {
          setLinkError('Sign in first');
          return;
        }
        const target = socialUnlinkId(user, provider);
        if (!target) {
          setLinkError('That account is not linked.');
          return;
        }
        try {
          if (target.kind === 'telegram') {
            await unlinkTelegram({ telegramUserId: target.id });
          } else if (target.provider) {
            await unlinkOAuth({
              provider: target.provider as OAuthProviderType,
              subject: target.id,
            });
          } else {
            setLinkError('Could not disconnect that account.');
          }
        } catch (e) {
          setLinkError(authErrorMessage(e) || 'Could not disconnect. Keep at least one login method on the account.');
        }
      },
      linkError,
    }),
    [
      address,
      builderAddress,
      privy,
      hydrating,
      openLoginModal,
      initOAuth,
      googleBusy,
      loginError,
      wallet,
      linked,
      walletsState.wallets,
      linkTwitter,
      linkTelegram,
      linkDiscord,
      linkTiktok,
      linkInstagram,
      linkGoogle,
      linkTwitch,
      unlinkOAuth,
      unlinkTelegram,
      linkError,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function WebAuthRoot({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) {
    return <AuthContext.Provider value={GUEST}>{children}</AuthContext.Provider>;
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // Socials used by SocialConnect must be listed or Privy can reject with
        // disallowed_login_method. Telegram works on web (Expo/mobile has limits).
        loginMethods: [
          'email',
          'google',
          'wallet',
          'twitter',
          'discord',
          'tiktok',
          'instagram',
          'telegram',
          'twitch',
        ],
        appearance: {
          theme: 'dark',
          accentColor: '#5CE1E6',
          // Installed EIP-6963 extensions first; named wallets stay as fallbacks.
          // Named `okx_wallet` must be listed — otherwise Last used reconnects OKX via a
          // stale WalletConnect session (infinite spinner) while the detected-list button
          // still uses the injected extension and works.
          // https://docs.privy.io/wallets/connectors/setup/configuring-external-connector-wallets
          walletChainType: 'ethereum-and-solana',
          walletList: [
            'detected_ethereum_wallets',
            'okx_wallet',
            'metamask',
            'coinbase_wallet',
            'phantom',
            'binance',
            'wallet_connect_qr',
          ],
        },
        customOAuthRedirectUrl: oauthReturnUrl(),
        // Own WalletConnect Cloud project for `wallet_connect_qr` (else Privy's shared one).
        ...(WALLETCONNECT_PROJECT_ID ? { walletConnectCloudProjectId: WALLETCONNECT_PROJECT_ID } : {}),
        // Arbitrum = Bridge2 deposits. Robinhood Chain = Pons v2 coin launch (HD 0).
        // Privy: a chain must be listed here before `wallet.switchChain` will accept it.
        defaultChain: arbitrum,
        supportedChains: [arbitrum, robinhood],
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
          solana: { createOnLogin: 'off' },
          showWalletUIs: false,
        },
      }}
    >
      <PrivyAuthBridge>{children}</PrivyAuthBridge>
    </PrivyProvider>
  );
}
