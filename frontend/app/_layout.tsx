import React, { useState, useEffect, useRef } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, LogBox, View, Text, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrivyProvider } from '@privy-io/expo';
import { AppKitProvider } from '@reown/appkit-react-native';
import { SmartWalletsProvider } from '@privy-io/expo/smart-wallets';
import { PrivyElements } from '@privy-io/expo/ui';
import * as SplashScreen from 'expo-splash-screen';
import * as ScreenOrientation from 'expo-screen-orientation';
import type { Chain } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../src/theme/colors';
import { Analytics } from '../src/lib/analytics';
import '../src/i18n'; 
import { getSavedLanguage } from '../src/i18n';
import i18n from '../src/i18n';
import { primeIntervalCache } from '../src/lib/intervalPrefs';
import { primeChartPrefsCache } from '../src/lib/chartPrefs';
import { primeHomeHeroAuthedHint } from '../src/lib/homeHeroAuthHint';
import { hydrateActiveTradingBook, hydrateTradingEnv } from '../src/store/appStore';
import {
  getMantleChain,
  MANTLE_MAINNET_CHAIN_ID,
  MANTLE_SEPOLIA_CHAIN_ID,
} from '../src/lib/mantleFiatBalance';
import { PrivyAuthProvider, PRIVY_APP_ID, PRIVY_CLIENT_ID } from '../src/providers/PrivyAuthProvider';
import { MockAuthProvider } from '../src/providers/MockAuthProvider';
import { WebSocketProvider } from '../src/providers/WebSocketProvider';
import { BuilderConfigProvider, useSyncBuilderConfigToGlobal } from '../src/providers/BuilderConfigProvider';
import { CurrencyProvider } from '../src/providers/CurrencyProvider';
import { UrAccountProvider } from '../src/providers/UrAccountProvider';
import { HyperliquidAccountStreamProvider } from '../src/providers/HyperliquidAccountStreamProvider';
import { SeamlessSetupProvider } from '../src/providers/SeamlessSetupProvider';
import { useAppStore } from '../src/store/appStore';
import CustomSplashScreen from '../assets/splash/CustomSplashScreen';
import { ApiCounterOverlay } from '../src/components/ApiCounterOverlay';
import { BottomNavBar } from '../src/components/BottomNavBar';
import { ClaimBannerRoot } from '../src/components/ClaimTradingCreditBanner';
import { IncomingFundsBanner } from '../src/components/IncomingFundsBanner';
import { AppUpdateBanner } from '../src/components/AppUpdateBanner';
import { checkGeo } from '../src/lib/api';
import { initAppsFlyerSdk } from '../src/lib/appsFlyerAnalytics';
import { RootToastHost } from '../src/components/ToastHost';
import { AppKitHost } from '../src/components/AppKitHost';
import { appKit } from '../src/lib/appKitConfig';
import { TenantProvider } from '../src/tenants';

// Syncs builder config from React context to global singleton (for non-React code like order signing)
// Also refreshes with wallet address when user authenticates (for personalized fee discount).
function BuilderConfigSync({ children }: { children: React.ReactNode }) {
  const { refreshForWallet } = useSyncBuilderConfigToGlobal();
  const walletAddress = useAppStore((s) => s.user?.wallet?.address ?? null);

  React.useEffect(() => {
    refreshForWallet(walletAddress);
  }, [walletAddress, refreshForWallet]);

  return <>{children}</>;
}

LogBox.ignoreLogs([
  'This method is deprecated',
  // WalletConnect relay noise: after we purge stale sessions (logout / new
  // login), late relay messages for the deleted topic reject an uncaught
  // promise inside @walletconnect/sign-client. Expected and harmless.
  /No matching key\. session topic doesn't exist/,
]);

// Also filter console.warn for Firebase deprecation warnings
const originalWarn = console.warn;
console.warn = (...args) => {
  const message = args[0];
  if (typeof message === 'string' && message.includes('This method is deprecated')) {
    return; // Suppress Firebase v22 migration warnings
  }
  originalWarn.apply(console, args);
};

// Keep native splash screen visible until we're ready to show custom splash
SplashScreen.preventAutoHideAsync();


// Use EXPO_PUBLIC_ so Expo can inject it at build/dev time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extra = (Constants.expoConfig?.extra as any) ?? (Constants as any).manifest2?.extra ?? (Constants as any).manifest?.extra;
const ARBITRUM_RPC_URL: string | undefined =
  process.env.EXPO_PUBLIC_ARBITRUM_RPC_URL ||
  extra?.EXPO_PUBLIC_ARBITRUM_RPC_URL;

const ARB_SEPOLIA_RPC_URL: string | undefined =
  process.env.EXPO_PUBLIC_ARB_SEPOLIA_RPC_URL ||
  extra?.EXPO_PUBLIC_ARB_SEPOLIA_RPC_URL;

const arbitrumChain: Chain = ARBITRUM_RPC_URL
  ? {
      ...arbitrum,
      rpcUrls: {
        ...arbitrum.rpcUrls,
        default: { http: [ARBITRUM_RPC_URL] },
        public: { http: [ARBITRUM_RPC_URL] },
      },
    }
  : arbitrum;

// Arb Sepolia must be in supportedChains so Privy's embedded wallet honours
// wallet_switchEthereumChain to 0x66eee for testnet UR deposits. Without this
// the DigitalDepositBottomSheet logs "Unsupported chainId 421614" and the EOA stays
// on whatever chain Privy defaulted to, which silently breaks the 7702 auth
// signature (chainId is baked into the typed-data hash).
const arbitrumSepoliaChain: Chain = ARB_SEPOLIA_RPC_URL
  ? {
      ...arbitrumSepolia,
      rpcUrls: {
        ...arbitrumSepolia.rpcUrls,
        default: { http: [ARB_SEPOLIA_RPC_URL] },
        public: { http: [ARB_SEPOLIA_RPC_URL] },
      },
    }
  : arbitrumSepolia;

// Mantle hosts all UR fiat tokens (USD24, EUR24, …) + Fiat24CryptoRelay.
// Both testnet (5003) and mainnet (5000) are registered so Privy honours
// wallet_switchEthereumChain / 7702 signing on whichever UR_ENV uses.
const mantleSepoliaChain = getMantleChain(MANTLE_SEPOLIA_CHAIN_ID);
const mantleMainnetChain = getMantleChain(MANTLE_MAINNET_CHAIN_ID);

const supportedChains: [Chain, ...Chain[]] = [
  arbitrumChain,
  arbitrumSepoliaChain,
  mantleSepoliaChain,
  mantleMainnetChain,
];

if (__DEV__ && ARBITRUM_RPC_URL) {
  try {
    // eslint-disable-next-line no-console
    console.log('[chain] Using custom Arbitrum RPC origin:', new URL(ARBITRUM_RPC_URL).origin);
  } catch {
    // eslint-disable-next-line no-console
    console.log('[chain] Using custom Arbitrum RPC (invalid URL format)');
  }
}
if (__DEV__ && ARB_SEPOLIA_RPC_URL) {
  try {
    // eslint-disable-next-line no-console
    console.log('[chain] Using custom Arb Sepolia RPC origin:', new URL(ARB_SEPOLIA_RPC_URL).origin);
  } catch {
    // eslint-disable-next-line no-console
    console.log('[chain] Using custom Arb Sepolia RPC (invalid URL format)');
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      // No global polling. Every query that the user watches live (prices,
      // positions, orders, balances, funding, chart) sets its own explicit
      // refetchInterval at the call site; static/metadata queries refetch
      // only when stale. The old 30s global default made EVERY mounted
      // query poll — dozens of hidden REST hits per minute that compounded
      // with HL IP rate limits and degraded long sessions.
    },
  },
});

function AppContent() {
  const defaultAnimation = Platform.OS === 'web' ? 'fade' : 'ios_from_right';
  const modalAnimation = Platform.OS === 'web' ? 'fade' : 'slide_from_bottom';
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);
  
  // Track screen views with Firebase Analytics
  useEffect(() => {
    if (Platform.OS === 'web') return; // Skip on web
    if (!pathname || pathname === lastPathRef.current) return;
    
    lastPathRef.current = pathname;
    
    // Convert pathname to readable screen name
    let screenName = pathname;
    if (pathname === '/') screenName = 'Home';
    else if (pathname.startsWith('/asset/')) screenName = `Asset_${pathname.split('/')[2]}`;
    else if (pathname.startsWith('/trade/')) screenName = `Trade_${pathname.split('/')[2]}`;
    else if (pathname === '/profile') screenName = 'Profile';
    else if (pathname === '/login') screenName = 'Login';
    else if (pathname === '/portfolio') screenName = 'Portfolio';
    else if (pathname === '/news') screenName = 'News';
    else if (pathname === '/price-alerts') screenName = 'PriceAlerts';
    else if (pathname === '/deposit') screenName = 'Deposit';
    else if (pathname === '/rewards') screenName = 'Rewards';
    else if (pathname === '/trade-history') screenName = 'TradeHistory';
    else screenName = pathname.replace(/^\//, '').replace(/\//g, '_') || 'Unknown';
    
    Analytics.logScreenView(screenName);
  }, [pathname]);
  
  return (
    <TenantProvider>
      <StatusBar style="light" backgroundColor={colors.background.primary} />
      <ClaimBannerRoot>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background.primary },
            animation: defaultAnimation,
            freezeOnBlur: true,
          }}
        >
        <Stack.Screen name="index" options={{ freezeOnBlur: false }} />
        <Stack.Screen 
          name="asset/[coin]" 
          options={{ animation: defaultAnimation }}
        />
        <Stack.Screen 
          name="profile" 
          options={{
            animation: modalAnimation,
            presentation: 'modal',
          }}
        />
        <Stack.Screen 
          name="login" 
          options={{
            animation: modalAnimation,
            presentation: 'modal',
            // Keep login alive through MetaMask backgrounding so SIWE completion
            // can dismiss this modal. freezeOnBlur here left a ghost overlay on Home.
            freezeOnBlur: false,
          }}
        />
        <Stack.Screen 
          name="trade/[coin]" 
          options={{
            animation: modalAnimation,
            presentation: 'modal',
          }}
        />
        <Stack.Screen 
            name="deposit" 
            options={{
              animation: modalAnimation,
              presentation: 'modal',
            }}
          />
      </Stack>
      </ClaimBannerRoot>
      <IncomingFundsBanner />
      <AppUpdateBanner />
      <BottomNavBar />
      {/*{__DEV__ && <ApiCounterOverlay />}*/}
    </TenantProvider>
  );
}

// Web layout - uses mock auth (Privy doesn't work on web)
function WebLayout() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <CurrencyProvider>
            <BuilderConfigProvider>
              <BuilderConfigSync>
                <WebSocketProvider>
                  <MockAuthProvider>
                    <HyperliquidAccountStreamProvider>
                      <UrAccountProvider>
                        <AppContent />
                      </UrAccountProvider>
                    </HyperliquidAccountStreamProvider>
                  </MockAuthProvider>
                </WebSocketProvider>
              </BuilderConfigSync>
            </BuilderConfigProvider>
          </CurrencyProvider>
        </QueryClientProvider>
        <RootToastHost />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Geo-fence: block restricted regions
// ---------------------------------------------------------------------------

function GeoBlockedScreen() {
  return (
    <View style={geoStyles.container}>
      <StatusBar style="light" backgroundColor={colors.background.primary} />
      <Ionicons name="globe-outline" size={64} color={colors.text.secondary} style={{ marginBottom: 20 }} />
      <Text style={geoStyles.title}>Region Not Supported</Text>
      <Text style={geoStyles.subtitle}>
        This app is not available in your region due to regulatory restrictions.
      </Text>
    </View>
  );
}

const geoStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: colors.text.primary,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.text.secondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
});

// Native layout - uses REAL Privy authentication
function NativeLayout() {
  const [isSplashDone, setIsSplashDone] = useState(false);
  const [isI18nReady, setIsI18nReady] = useState(false);
  const [geoBlocked, setGeoBlocked] = useState(false);
  const nativeSplashHidden = useRef(false);

  // Geo-fence: check region once on cold start (non-blocking – if it fails, allow)
  useEffect(() => {
    checkGeo()
      .then((r) => { if (!r.allowed) setGeoBlocked(true); })
      .catch(() => { /* allow on failure */ });
  }, []);

  // Load saved language preference on startup. Also prime chart caches
  // here so the first chart mount can read the saved timeframe and
  // pinned interval chips synchronously — no '1h -> saved' or
  // '15m 1h 4h 1d -> user's pins' flash on cold start. Runs in
  // parallel so we don't add latency to the splash screen.
  useEffect(() => {
    (async () => {
      try {
        const [savedLang] = await Promise.all([
          getSavedLanguage(),
          primeIntervalCache().catch(() => {}),
          primeChartPrefsCache().catch(() => {}),
          // Restore the user's last trading env (mainnet/demo) BEFORE any HL
          // transport / SDK call fires, so the lazy transport singleton picks
          // up the right endpoint on first access. Synchronous getters in
          // appStore default to mainnet until this resolves.
          hydrateTradingEnv().catch(() => {}),
          hydrateActiveTradingBook().catch(() => {}),
          primeHomeHeroAuthedHint().catch(() => {}),
        ]);
        if (savedLang !== i18n.language) {
          await i18n.changeLanguage(savedLang);
        }
        // Apply RTL on initial load
        const { applyRTL } = await import('../src/i18n');
        applyRTL(savedLang);
      } catch {
        // Ignore - will use default language
      } finally {
        setIsI18nReady(true);
      }
    })();
  }, []);

  // Hide the native (static) splash screen as soon as the custom animated
  // splash component mounts so the user sees the animated version.
  useEffect(() => {
    if (!nativeSplashHidden.current) {
      nativeSplashHidden.current = true;
      SplashScreen.hideAsync().catch(() => {});
    }
  }, []);

  // Lock to portrait by default (app.json orientation is "default" so
  // the chart component can programmatically switch to landscape).
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  useEffect(() => {
    initAppsFlyerSdk();
  }, []);

  const handleSplashComplete = () => {
    setIsSplashDone(true);
  };

  // Show custom animated splash until its animation completes AND i18n is ready
  if (!isSplashDone || !isI18nReady) {
    return <CustomSplashScreen onAnimationComplete={handleSplashComplete} />;
  }

  // Block restricted regions after splash
  if (geoBlocked) {
    return <GeoBlockedScreen />;
  }

  if (!PRIVY_APP_ID || !PRIVY_CLIENT_ID) {
    console.error(
      '[HyperTrade] Missing EXPO_PUBLIC_PRIVY_APP_ID / EXPO_PUBLIC_PRIVY_CLIENT_ID. ' +
        'Copy frontend/.env.example → frontend/.env and set your Privy app credentials.',
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      supportedChains={supportedChains}
      config={{
        embedded: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
          // Off globally — PrivyAuthProvider creates Solana only for email/social users.
          // External SIWE logins have an EVM wallet but no Solana wallet; per-chain
          // `users-without-wallets` would still auto-create Solana otherwise.
          solana: {
            createOnLogin: 'off',
          },
        },
      }}
    >
      <SmartWalletsProvider>
        <SafeAreaProvider>
          <AppKitProvider instance={appKit}>
            <KeyboardProvider>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <QueryClientProvider client={queryClient}>
                  <CurrencyProvider>
                    <BuilderConfigProvider>
                      <BuilderConfigSync>
                        <WebSocketProvider>
                          <PrivyAuthProvider>
                            <HyperliquidAccountStreamProvider>
                              <UrAccountProvider>
                                <SeamlessSetupProvider>
                                  <AppContent />
                                </SeamlessSetupProvider>
                              </UrAccountProvider>
                            </HyperliquidAccountStreamProvider>
                          </PrivyAuthProvider>
                        </WebSocketProvider>
                      </BuilderConfigSync>
                    </BuilderConfigProvider>
                  </CurrencyProvider>
                </QueryClientProvider>
                <PrivyElements
                  config={{
                    appearance: {
                      colorScheme: 'dark',
                      accentColor: '#D4AF37',
                    },
                  }}
                />
                <AppKitHost />
              </GestureHandlerRootView>
              <RootToastHost />
            </KeyboardProvider>
          </AppKitProvider>
        </SafeAreaProvider>
      </SmartWalletsProvider>
    </PrivyProvider>
  );
}

export default function RootLayout() {
  // Web uses MockAuth (Privy SDK doesn't support web)
  // Native (Android/iOS) uses REAL Privy authentication
  if (Platform.OS === 'web') {
    return <WebLayout />;
  }
  
  return <NativeLayout />;
}
