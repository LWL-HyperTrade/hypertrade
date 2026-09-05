import React, { useState, useCallback, useMemo, useRef, useEffect, useDeferredValue } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  StatusBar,
  TouchableOpacity,
  TextInput,
  Keyboard,
  Platform,
  Modal,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Animated,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Header } from '../src/components/Header';
import { MarketStats } from '../src/components/MarketStats';
import { TweenedStatText } from '../src/components/TweenedStatText';
import { AssetCard } from '../src/components/AssetCard';
import { LoadingIndicator } from '../src/components/LoadingSpinner';
import { GuestCtaSkeleton } from '../src/components/GuestCtaSkeleton';
import { AccountCardSkeleton, HOME_ACCOUNT_CARD_MIN_HEIGHT } from '../src/components/AccountCardSkeleton';
import { GuestCtaCarousel } from '../src/components/GuestCtaCarousel';
import { getHomeHeroAuthedHint } from '../src/lib/homeHeroAuthHint';
import { MarketOverviewSkeleton } from '../src/components/MarketOverviewSkeleton';
import { DemoLiveDot } from '../src/components/DemoMode';
import { BouncingDots } from '../src/components/BouncingDots';
import { fetchAssets, fetchCryptoAssets, listAiAgents, Asset, type AiAgentView } from '../src/lib/api';
import {
  useDedicatedBookLivePositionCounts,
  useMasterBookLivePositionCount,
} from '../src/hooks/useAiAgentLivePositionCounts';
import { formatBookAgentStatusLabel } from '../src/lib/aiAgentStatusLabel';
import { TradingBookPickerRow, type TradingBookPickerOption } from '../src/components/TradingBookPickerRow';
import { formatDisplaySymbol } from '../src/lib/displaySymbols';
import { colors } from '../src/theme/colors';
import { useAppStore } from '../src/store/appStore';
import { useAuth } from '../src/providers/AuthContext';
import { useActiveEthereumWallet } from '../src/hooks/useActiveEthereumWallet';
import { useActiveTradingBook } from '../src/hooks/useActiveTradingBook';
import { isDedicatedSwitcherAgent } from '../src/lib/tradingBook';
import { loadFavorites, saveFavorites, toggleFavorite } from '../src/lib/favorites';
import { usePricesRef, useWebSocketStatus } from '../src/providers/WebSocketProvider';
import { pickPrice } from '../src/lib/priceKeys';
import {
  expandAssetSearchRows,
  type AssetSearchRow,
} from '../src/lib/searchSpotRows';

import { filterNewlyListedAssets } from '../src/lib/newListings';
import { demoAllowsSpot } from '../src/lib/demo';
import { isHiddenLowLiquidityGoldSpotAsset } from '../src/lib/hiddenMarkets';
import { getHyperliquidTradingState, getHistoricalPnlTimeseries, calculate24hPnlPercent, prewarmHlTransport, computeSpotBalanceUsd, getSpotMetaAndAssetCtxsCached, isPooledAccountMode } from '../src/lib/hyperliquid';
import { useHyperliquidAccountStream } from '../src/lib/useHyperliquidAccountStream';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { useDisplayCurrency } from '../src/providers/CurrencyProvider';
import { fetchOnboardingStatus, isOnboardingCachedComplete } from '../src/lib/onboarding';
import { pushRouteOnce } from '../src/lib/pushRouteOnce';

type Hex = `0x${string}`;

const NOTIF_PROMPT_DONE_KEY = 'hypertrade_notif_prompt_done';

/** Survives Home remounts so a reconnect/empty-hydrate window can't flash $0.00. */
const lastKnownPositiveAccountValueByKey = new Map<string, number>();

type ParentTabType = 'all' | 'favorites' | 'stocks' | 'crypto' | 'commodities' | 'forex' | 'index' | 'spot';
type SecondaryFilter = 'active' | 'gainers' | 'losers' | 'new' | null;

// Labels use i18n keys - resolved at render time via getTabLabel()
const baseTabs: { id: ParentTabType; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'all', labelKey: 'home.all', icon: 'grid' },
  { id: 'stocks', labelKey: 'home.stocks', icon: 'business' },
  { id: 'crypto', labelKey: 'home.crypto', icon: 'logo-bitcoin' },
  { id: 'commodities', labelKey: 'home.commodities', icon: 'cube' },
  { id: 'forex', labelKey: 'home.forex', icon: 'swap-horizontal' },
  { id: 'index', labelKey: 'home.index', icon: 'pie-chart' },
  { id: 'spot', labelKey: 'home.spot', icon: 'cash' },
];

// Edit these lists to control market ordering on Home.
// - `all`: ordering for the ALL tab
// - category tabs: ordering within each category
const CUSTOM_MARKET_ORDER: Record<'all' | 'stocks' | 'crypto' | 'commodities' | 'forex' | 'index' | 'spot', string[]> = {
  all: [
    'SP500',
    'NDX100',
    'GOLD',
    'SILVER',
    'BTC',
    'NVDA',
    'AAPL',
    'GOOGL',
    'MSFT',
    'AMZN',
    'HYPE',
    'ETH',
    'OIL',
    'META',
    'TSLA',
    'ANTH',
    'SOL',
    'XRP',
    'EUR',
    'JPY',
  ],
  stocks: [
    'NVDA',
    'AAPL',
    'TSLA',
    'ANTH',
    'GOOGL',
    'MSFT',
    'META',
    'AMZN',
    'SPCX',
    'CXMT',
    'UNITREE',
    'MRNA',
    'LITE',
    'MSTR',
    'COIN',
    'CRCL',
    'PLTR',
    'NFLX',
    'AVGO',
    'ORCL',
    'BABA',
    'RIVN',
    'MU',
    'INTC',
    'AMD',
    'CRWV',
    'CBRS',
    'MRVL',
    'IBM',
    'DELL',
    'HOOD',
    'PURRDAT',
    'TSM',
    'GME',
    'LLY',
    'SMSN',
    'SNDK',
    'SKHY',
  ],
  crypto: [
    'BTC',
    'HYPE',
    'ETH',
    'SOL',
    'XRP',
    'BNB',
    'ZEC',
    'SUI',
    'LINK',
    'AAVE',
    'NEAR',
    'XMR',
    'UNI',
    'ONDO',
    'ARB',
    'JUP',
    'GRAM',
    'TRX',
    'LTC',
    'BCH',
    'XLM',
    'HBAR',
    'ADA',
    'AVAX',
    'APT',
    'TAO',
    'ENA',
    'PUMP',
    'MON',
    'WLD',
    'XPL',
    'ZRO',
    'PYTH',
    'WLFI',
    'JTO',
    'LIT',
    'VIRTUAL',
    'VVV',
    'MEGA',
    'PONS',
    'ASTER',
  ],
  // 'GOLDSPOT', // XAUT spot — re-enable when book deepens (see hiddenMarkets.ts)
  commodities: ['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'COPPER', 'OIL', 'BRENTOIL', 'NATGAS', 'URNM'],
  forex: ['EUR', 'JPY'],
  index: ['NDX100', 'SP500', 'EWY', 'DRAM'],
  spot: ['BTC', 'HYPE', 'ETH', 'SOL', 'ZEC', 'ENA', 'MON', 'XPL', 'KNTQ', 'USDT'],
};

const SPOT_WHITELIST = new Set(CUSTOM_MARKET_ORDER.spot.map(s => s.toUpperCase()));
// Keep GOLD wiring intact, but hide it from demo until the testnet xyz:GOLD book improves.
const DEMO_PERP_BASE_WHITELIST = new Set(['BTC', 'ETH']);
const getDemoBaseSymbol = (asset: Pick<Asset, 'symbol' | 'coin'>) => {
  const sym = (asset.symbol || asset.coin || '').toUpperCase();
  return sym.includes(':') ? sym.split(':').pop()! : sym;
};

const ORDER_FALLBACK_RANK = Number.MAX_SAFE_INTEGER;

const buildOrderRankMap = (symbols: string[]): Map<string, number> =>
  new Map(symbols.map((symbol, idx) => [symbol.toUpperCase(), idx]));

const ORDER_RANKS = {
  all: buildOrderRankMap(CUSTOM_MARKET_ORDER.all),
  stocks: buildOrderRankMap(CUSTOM_MARKET_ORDER.stocks),
  crypto: buildOrderRankMap(CUSTOM_MARKET_ORDER.crypto),
  commodities: buildOrderRankMap(CUSTOM_MARKET_ORDER.commodities),
  forex: buildOrderRankMap(CUSTOM_MARKET_ORDER.forex),
  index: buildOrderRankMap(CUSTOM_MARKET_ORDER.index),
  spot: buildOrderRankMap(CUSTOM_MARKET_ORDER.spot),
};

const STOCK_SYMBOL_OVERRIDES = new Set([
  'CRCL',
  'TSLA',
  'NVDA',
  'AAPL',
  'GOOGL',
  'GOOG',
  'AMZN',
  'MSFT',
  'META',
  'INTC',
  'AMD',
  'COIN',
  'HOOD',
  'LITE',
  'MSTR',
  'PURRDAT',
  'PLTR',
  'COST',
  'NFLX',
  'TSM',
  'RIVN',
  'MU',
  'LLY',
  'BABA',
  'SNDK',
  'ANTH',
  'ORCL',
  'CRWV',
  'SPCX',
  'CXMT',
  'UNITREE',
  'MRNA',
  'CBRS',
  'IBM',
  'DELL',
  'SKHY',
  'GME',
  'AVGO',
  'MRVL',
]);

const normalizeAsset = (asset: Asset): Asset => {
  const baseSymbol = asset.symbol || asset.coin || '';
  const symbolUpper = baseSymbol.toUpperCase();
  const nextCategory = STOCK_SYMBOL_OVERRIDES.has(symbolUpper) ? 'stock' : asset.category;
  return { ...asset, symbol: baseSymbol, name: asset.name, category: nextCategory };
};

const getAssetSortSymbol = (asset: Asset): string =>
  String(asset.symbol || asset.coin || '').toUpperCase();

const sortAssetsByCustomOrder = (assets: Asset[], tab: ParentTabType): Asset[] => {
  if (tab === 'favorites') return assets;

  const rankMap =
    tab === 'all'
      ? ORDER_RANKS.all
      : tab === 'stocks'
        ? ORDER_RANKS.stocks
        : tab === 'crypto'
          ? ORDER_RANKS.crypto
          : tab === 'commodities'
            ? ORDER_RANKS.commodities
            : tab === 'forex'
              ? ORDER_RANKS.forex
              : tab === 'spot'
                ? ORDER_RANKS.spot
                : ORDER_RANKS.index;

  return [...assets].sort((a, b) => {
    const aSymbol = getAssetSortSymbol(a);
    const bSymbol = getAssetSortSymbol(b);
    const aRank = rankMap.get(aSymbol) ?? ORDER_FALLBACK_RANK;
    const bRank = rankMap.get(bSymbol) ?? ORDER_FALLBACK_RANK;

    if (aRank !== bRank) return aRank - bRank;
    return aSymbol.localeCompare(bSymbol);
  });
};

// Extracted TabFilter component - shows first 4 tabs + dropdown for rest
const TabFilter = React.memo(({
  selectedTab,
  onSelectTab,
  tabs,
  showDropdown,
  onShowDropdownChange,
  getTabLabel,
}: {
  selectedTab: ParentTabType;
  onSelectTab: (tab: ParentTabType) => void;
  tabs: { id: ParentTabType; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[];
  showDropdown: boolean;
  onShowDropdownChange: (show: boolean) => void;
  getTabLabel: (key: string) => string;
}) => {
  const visibleTabs = tabs.slice(0, 4);
  const hiddenTabs = tabs.slice(4);
  
  // Check if a hidden category is currently selected
  const isHiddenCategorySelected = hiddenTabs.some(tab => tab.id === selectedTab);

  const handleTabSelect = useCallback((tabId: ParentTabType) => {
    onSelectTab(tabId);
    onShowDropdownChange(false);
  }, [onSelectTab, onShowDropdownChange]);

  return (
    <>
      <View style={tabFilterStyles.tabsContainer}>
        {visibleTabs.map((tab) => {
          const isSelected = selectedTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={[
                tabFilterStyles.tab,
                isSelected && tabFilterStyles.tabSelected,
              ]}
              onPress={() => handleTabSelect(tab.id)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={tab.icon}
                size={12}
                color={isSelected ? colors.accent.gold : colors.text.secondary}
              />
              <Text
                style={[
                  tabFilterStyles.tabText,
                  isSelected && tabFilterStyles.tabTextSelected,
                ]}
              >
                {getTabLabel(tab.labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
        {hiddenTabs.length > 0 && (
          <TouchableOpacity
            style={[
              tabFilterStyles.dropdownTab,
              isHiddenCategorySelected && tabFilterStyles.dropdownTabSelected,
            ]}
            onPress={() => onShowDropdownChange(true)}
            activeOpacity={0.7}
          >
            <Ionicons
              name="chevron-down"
              size={14}
              color={isHiddenCategorySelected ? colors.accent.gold : colors.text.secondary}
            />
          </TouchableOpacity>
        )}
      </View>
    </>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.selectedTab === nextProps.selectedTab &&
    prevProps.showDropdown === nextProps.showDropdown &&
    prevProps.tabs.length === nextProps.tabs.length &&
    prevProps.tabs.every((tab, i) => tab.id === nextProps.tabs[i]?.id) &&
    prevProps.onSelectTab === nextProps.onSelectTab &&
    prevProps.onShowDropdownChange === nextProps.onShowDropdownChange &&
    prevProps.getTabLabel === nextProps.getTabLabel
  );
});

// Extracted SectionHeader to isolate refresh state from TabFilter
/** Isolated reorder modal — DraggableFlatList lives here, not in the main scroll tree. */
const ReorderFavoritesModal = React.memo(({
  visible,
  assets,
  onDragEnd,
  onClose,
  labels,
}: {
  visible: boolean;
  assets: Asset[];
  onDragEnd: (data: Asset[]) => void;
  onClose: () => void;
  labels: { title: string; done: string };
}) => {
  const insets = useSafeAreaInsets();
  /** Extra space above Android 3-button / gesture nav so the last row stays draggable */
  const sheetBottomPad = 16 + insets.bottom;

  const renderItem = useCallback(({ item, drag, isActive }: RenderItemParams<Asset>) => (
    <TouchableOpacity
      onLongPress={() => {
        if (Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        drag();
      }}
      delayLongPress={200}
      disabled={isActive}
      activeOpacity={0.7}
      style={[styles.reorderDragItem, isActive && styles.reorderDragItemActive]}
    >
      <View style={styles.reorderDragHandle}>
        <Ionicons name="reorder-three" size={22} color={colors.text.tertiary} />
      </View>
      <View>
        <Text style={styles.reorderDragSymbol}>
          {(item.symbol || item.coin || '').replace(/:.*/, '')}
        </Text>
        {item.name ? <Text style={styles.reorderDragName} numberOfLines={1}>{item.name}</Text> : null}
      </View>
    </TouchableOpacity>
  ), []);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.reorderModalOverlay}>
          <View style={[styles.reorderModalContainer, { paddingBottom: sheetBottomPad }]}>
            <View style={styles.reorderModalHeader}>
              <Text style={styles.reorderModalTitle}>{labels.title}</Text>
              <TouchableOpacity onPress={onClose}>
                <Text style={styles.reorderModalDone}>{labels.done}</Text>
              </TouchableOpacity>
            </View>
            <DraggableFlatList
              style={styles.reorderDraggableList}
              data={assets}
              keyExtractor={(item) => item.coin}
              renderItem={renderItem}
              onDragEnd={({ data }) => onDragEnd(data)}
              autoscrollThreshold={80}
              activationDistance={15}
              contentContainerStyle={{ paddingBottom: 8 + insets.bottom }}
            />
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
});

const SectionHeader = React.memo(({
  title,
  assetCount,
  isRefreshing,
  showSecondaryBadges,
  secondaryFilter,
  onSecondaryPress,
  onReorderPress,
  labels,
}: {
  title: string;
  assetCount: number;
  isRefreshing: boolean;
  showSecondaryBadges: boolean;
  secondaryFilter: SecondaryFilter;
  onSecondaryPress: (filter: Exclude<SecondaryFilter, null>) => void;
  onReorderPress?: () => void;
  labels: { assets: string; mostActive: string; gainers: string; losers: string; newListings: string; refreshing: string };
}) => {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeaderTop}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <RefreshingPill active={isRefreshing} />
        </View>
        <View style={styles.sectionHeaderRight}>
          {onReorderPress ? (
            <TouchableOpacity onPress={onReorderPress} style={styles.reorderButton} activeOpacity={0.7}>
              <Ionicons name="reorder-three" size={18} color={colors.accent.gold} />
            </TouchableOpacity>
          ) : null}
          <Text style={styles.sectionSubtitle}>
            {assetCount} {labels.assets}
          </Text>
        </View>
      </View>

      {showSecondaryBadges && (
        <View style={styles.badgesRow}>
          <TouchableOpacity
            style={[styles.badge, secondaryFilter === 'active' && styles.badgeSelected]}
            onPress={() => onSecondaryPress('active')}
            activeOpacity={0.8}
          >
            <Ionicons
              name="flame"
              size={12}
              color={secondaryFilter === 'active' ? colors.accent.gold : colors.text.secondary}
            />
            <Text style={[styles.badgeText, secondaryFilter === 'active' && styles.badgeTextSelected]} numberOfLines={1}>
              {labels.mostActive}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.badge, secondaryFilter === 'gainers' && styles.badgeSelected]}
            onPress={() => onSecondaryPress('gainers')}
            activeOpacity={0.8}
          >
            <Ionicons
              name="arrow-up"
              size={12}
              color={secondaryFilter === 'gainers' ? colors.accent.gold : colors.text.secondary}
            />
            <Text style={[styles.badgeText, secondaryFilter === 'gainers' && styles.badgeTextSelected]} numberOfLines={1}>
              {labels.gainers}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.badge, secondaryFilter === 'losers' && styles.badgeSelected]}
            onPress={() => onSecondaryPress('losers')}
            activeOpacity={0.8}
          >
            <Ionicons
              name="arrow-down"
              size={12}
              color={secondaryFilter === 'losers' ? colors.accent.gold : colors.text.secondary}
            />
            <Text style={[styles.badgeText, secondaryFilter === 'losers' && styles.badgeTextSelected]} numberOfLines={1}>
              {labels.losers}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.badge, secondaryFilter === 'new' && styles.badgeSelected]}
            onPress={() => onSecondaryPress('new')}
            activeOpacity={0.8}
          >
            <Ionicons
              name="sparkles"
              size={12}
              color={secondaryFilter === 'new' ? colors.accent.gold : colors.text.secondary}
            />
            <Text style={[styles.badgeText, secondaryFilter === 'new' && styles.badgeTextSelected]} numberOfLines={1}>
              {labels.newListings}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

const tabFilterStyles = StyleSheet.create({
  tabsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 5,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 14,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 3,
  },
  tabSelected: {
    backgroundColor: `${colors.accent.gold}15`,
    borderColor: colors.accent.gold,
  },
  tabText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  tabTextSelected: {
    color: colors.accent.gold,
  },
  dropdownTab: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 14,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    minWidth: 28,
    flexShrink: 0,
  },
  dropdownTabSelected: {
    backgroundColor: `${colors.accent.gold}15`,
    borderColor: colors.accent.gold,
  },
  dropdownBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  dropdownContent: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    width: '100%',
    maxWidth: 320,
    maxHeight: '70%',
  },
  dropdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  dropdownTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
  },
  dropdownList: {
    padding: 8,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 4,
    gap: 12,
  },
  dropdownItemSelected: {
    backgroundColor: `${colors.accent.gold}15`,
  },
  dropdownItemText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.text.secondary,
  },
  dropdownItemTextSelected: {
    color: colors.accent.gold,
    fontWeight: '600',
  },
});

type HomeBookOption = TradingBookPickerOption;

// Extracted AccountCard to isolate trading state updates from main header
const AccountCard = React.memo(({
  userAddress,
  tradingState,
  isTradingStateLoading,
  isTradingStateError,
  onRetryTradingState,
  isAccountValueHidden,
  onToggleHidden,
  livePositionsCount,
  pnl24hPercent,
  isConnected,
  onPortfolioPress,
  liveAccountValueUsd,
  labels,
  bookOptions,
  onOpenBookPicker,
  bookKey,
}: {
  userAddress: string | null;
  tradingState: any;
  /** True while the HL trading-state query is loading and there is no cached data yet */
  isTradingStateLoading: boolean;
  /** True when the HL trading-state query failed and there is no cached data */
  isTradingStateError: boolean;
  onRetryTradingState: () => void;
  isAccountValueHidden: boolean;
  onToggleHidden: () => void;
  livePositionsCount: number;
  pnl24hPercent: number;
  isConnected: boolean;
  onPortfolioPress: () => void;
  /** Near-live total from the HL WebSocket stream (perp across dexes + spot). Falls back to the REST snapshot. */
  liveAccountValueUsd: number | null;
  /** Remount tweens on Main ↔ Dedicated so the prior book's $ does not roll into the new one. */
  bookKey?: string;
  labels: {
    tradeAccount: string;
    loadingAccount: string;
    walletProvisioning: string;
    accountLoadError: string;
    tapToRetry: string;
    livePositions: string;
    live: string;
    syncing: string;
    pnl: string;
    switchBook?: string;
  };
  /** When Dedicated agents exist, enables an in-card book picker on the Trade Account label. */
  bookOptions?: HomeBookOption[];
  onOpenBookPicker?: () => void;
}) => {
  const { formatDisplayPrice: fmtBal, isDisplayCurrencyLoading } = useDisplayCurrency();
  const canSwitchBook = (bookOptions?.length ?? 0) > 1 && !!onOpenBookPicker;
  // Prefer a positive live total; never let a transient live 0 override a known
  // positive REST snapshot (reconnect / empty-hydrate flash).
  const accountValueUsd = (() => {
    const live = liveAccountValueUsd;
    const rest = tradingState?.accountValueUsd;
    const liveOk = live != null && Number.isFinite(live);
    const restOk = rest != null && Number.isFinite(rest);
    if (liveOk && live > 0.01) return live;
    if (restOk && rest > 0.01) return rest;
    if (liveOk) return live;
    return restOk ? rest : 0;
  })();

  const formatAccountValue = useCallback((n: number) => fmtBal(n), [fmtBal]);
  const formatPnl24h = useCallback(
    (n: number) =>
      n === 0
        ? `0.00% ${labels.pnl}`
        : `${n >= 0 ? '+' : ''}${n.toFixed(2)}% ${labels.pnl}`,
    [labels.pnl],
  );
  const formatPositionsCount = useCallback((n: number) => String(Math.round(n)), []);

  const pnlColor =
    pnl24hPercent === 0
      ? colors.text.secondary
      : pnl24hPercent > 0
        ? colors.status.success
        : colors.status.error;

  // Logged in but embedded wallet not ready yet (Privy still provisioning)
  if (!userAddress) {
    return (
      <LinearGradient
        colors={['#1a1a2e', '#16213e', '#0f0f1a']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={accountCardStyles.card}
      >
        <View style={accountCardStyles.loading}>
          <LoadingIndicator size="medium" />
          <Text style={accountCardStyles.loadingText}>{labels.walletProvisioning}</Text>
        </View>
      </LinearGradient>
    );
  }

  // HL API failed (network, HL outage, rate limit) — not an infinite loading state
  if (isTradingStateError && !tradingState) {
    return (
      <LinearGradient
        colors={['#1a1a2e', '#16213e', '#0f0f1a']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={accountCardStyles.card}
      >
        <TouchableOpacity
          style={accountCardStyles.errorBox}
          onPress={onRetryTradingState}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={labels.tapToRetry}
        >
          <Ionicons name="cloud-offline-outline" size={22} color={colors.status.error} />
          <Text style={accountCardStyles.errorText}>{labels.accountLoadError}</Text>
          <Text style={accountCardStyles.retryHint}>{labels.tapToRetry}</Text>
        </TouchableOpacity>
      </LinearGradient>
    );
  }

  if (isTradingStateLoading && !tradingState) {
    return (
      <LinearGradient
        colors={['#1a1a2e', '#16213e', '#0f0f1a']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={accountCardStyles.card}
      >
        <View style={accountCardStyles.loading}>
          <LoadingIndicator size="medium" />
          <Text style={accountCardStyles.loadingText}>{labels.loadingAccount}</Text>
        </View>
      </LinearGradient>
    );
  }

  if (!tradingState) {
    return (
      <LinearGradient
        colors={['#1a1a2e', '#16213e', '#0f0f1a']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={accountCardStyles.card}
      >
        <View style={accountCardStyles.loading}>
          <LoadingIndicator size="medium" />
          <Text style={accountCardStyles.loadingText}>{labels.loadingAccount}</Text>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={['#1a1a2e', '#16213e', '#0f0f1a']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={accountCardStyles.card}
    >
      <View style={accountCardStyles.mainRow}>
        {/* Left: Account Value */}
        <View style={accountCardStyles.left}>
          <View style={accountCardStyles.topRow}>
            {canSwitchBook ? (
              <TouchableOpacity
                style={accountCardStyles.bookTrigger}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onOpenBookPicker?.();
                }}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={labels.switchBook ?? labels.tradeAccount}
              >
                <Text style={accountCardStyles.label} numberOfLines={1}>
                  {labels.tradeAccount}
                </Text>
                <Ionicons name="chevron-down" size={12} color={colors.text.tertiary} />
              </TouchableOpacity>
            ) : (
              <Text style={accountCardStyles.label}>{labels.tradeAccount}</Text>
            )}
            <TouchableOpacity
              onPress={onToggleHidden}
              style={accountCardStyles.eyeButton}
              activeOpacity={0.8}
            >
              <Ionicons name={isAccountValueHidden ? 'eye-off' : 'eye'} size={16} color={colors.text.tertiary} />
            </TouchableOpacity>
          </View>
          <View style={accountCardStyles.valueContainer}>
            {isAccountValueHidden ? (
              <Text
                style={accountCardStyles.value}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.35}
                {...(Platform.OS === 'android' ? { includeFontPadding: false } : {})}
              >
                *****
              </Text>
            ) : isDisplayCurrencyLoading ? (
              <BouncingDots
                color={colors.text.primary}
                dotSize={7}
                pulse
                style={accountCardStyles.valueDots}
              />
            ) : (
              <TweenedStatText
                key={`bal-${bookKey ?? 'main'}`}
                value={accountValueUsd}
                format={formatAccountValue}
                style={accountCardStyles.value}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.35}
                {...(Platform.OS === 'android' ? { includeFontPadding: false } : {})}
              />
            )}
          </View>
          {!isAccountValueHidden && (
            <TweenedStatText
              key={`pnl-${bookKey ?? 'main'}`}
              value={pnl24hPercent}
              format={formatPnl24h}
              style={[accountCardStyles.pnl, { color: pnlColor }]}
            />
          )}
        </View>

        {/* Divider */}
        <View style={accountCardStyles.divider} />

        {/* Right: Live Positions */}
        <TouchableOpacity style={accountCardStyles.right} onPress={onPortfolioPress}>
          <View style={accountCardStyles.positionsLabelRow}>
            <Text style={accountCardStyles.positionsLabel}>{labels.livePositions}</Text>
            <Ionicons name="arrow-forward-circle-outline" size={14} color={colors.text.tertiary} />
          </View>
          <TweenedStatText
            key={`pos-${bookKey ?? 'main'}`}
            value={livePositionsCount}
            format={formatPositionsCount}
            style={accountCardStyles.positionsCount}
          />
          <View style={accountCardStyles.liveRow}>
            {/* DemoLiveDot blinks gold in demo mode and renders the standard
                solid green/gold dot in mainnet. Mainnet behavior unchanged. */}
            <DemoLiveDot
              size={accountCardStyles.connectionDot.width as number}
              activeColor={isConnected ? colors.status.success : colors.accent.gold}
            />
            <Text style={accountCardStyles.sub}>{isConnected ? labels.live : labels.syncing}</Text>
          </View>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
});

function HomeBookPickerModal({
  visible,
  title,
  options,
  selectedId,
  onClose,
  onSelect,
}: {
  visible: boolean;
  title: string;
  options: HomeBookOption[];
  selectedId: 'master' | string;
  onClose: () => void;
  onSelect: (id: 'master' | string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={accountCardStyles.bookModalBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={onClose}
          accessibilityRole="button"
        />
        <View style={accountCardStyles.bookModalSheet}>
          <Text style={accountCardStyles.bookModalTitle}>{title}</Text>
          <ScrollView
            style={accountCardStyles.bookModalList}
            contentContainerStyle={accountCardStyles.bookModalListContent}
            showsVerticalScrollIndicator
            bounces
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {options.map((opt) => {
            const active = selectedId === opt.id;
            return (
              <TouchableOpacity
                key={opt.id}
                style={[accountCardStyles.bookOption, active && accountCardStyles.bookOptionActive]}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onSelect(opt.id);
                }}
                activeOpacity={0.75}
              >
                <TradingBookPickerRow option={opt} active={active} />
              </TouchableOpacity>
            );
          })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const accountCardStyles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    minHeight: HOME_ACCOUNT_CARD_MIN_HEIGHT,
    justifyContent: 'center',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  left: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  right: {
    flex: 1,
    alignItems: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  bookTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '85%',
    minWidth: 0,
  },
  label: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '500',
    flexShrink: 1,
  },
  eyeButton: {
    padding: 4,
  },
  bookModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  bookModalSheet: {
    backgroundColor: colors.background.secondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border.primary,
    paddingTop: 12,
    paddingBottom: 8,
    paddingHorizontal: 12,
    zIndex: 1,
    maxHeight: '60%',
  },
  bookModalTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.tertiary,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  bookModalList: {
    flexGrow: 0,
  },
  bookModalListContent: {
    gap: 4,
    paddingBottom: 4,
  },
  bookOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    minWidth: 0,
  },
  bookOptionActive: {
    backgroundColor: `${colors.accent.gold}14`,
  },
  valueContainer: {
    alignSelf: 'stretch',
    width: '100%',
    minWidth: 0,
    marginTop: 4,
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    flexShrink: 1,
    alignSelf: 'stretch',
    fontSize: 28,
    fontWeight: '900',
    color: colors.text.primary,
    letterSpacing: -0.5,
    textAlign: 'center',
    width: '100%',
    maxWidth: '100%',
    fontVariant: ['tabular-nums'],
  },
  valueDots: {
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pnl: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '600',
  },
  divider: {
    width: 1,
    height: 60,
    backgroundColor: colors.border.primary,
    marginHorizontal: 16,
  },
  positionsLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  positionsLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '500',
    marginBottom: 4,
  },
  positionsCount: {
    fontSize: 32,
    fontWeight: '900',
    color: colors.text.primary,
  },
  liveRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  sub: {
    fontSize: 11,
    color: colors.text.tertiary,
  },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 18,
  },
  errorBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    gap: 6,
  },
  loadingText: {
    fontSize: 13,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 13,
    color: colors.text.secondary,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 8,
  },
  retryHint: {
    fontSize: 12,
    color: colors.accent.gold,
    fontWeight: '700',
    marginTop: 6,
    textAlign: 'center',
  },
});

const RefreshingPill = ({ active }: { active: boolean }) => {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    if (active) {
      // Fade in and scale up smoothly
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 300,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      // Fade out and scale down smoothly
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.8,
          duration: 200,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [active, fadeAnim, scaleAnim]);

  return (
    <Animated.View
      style={[
        styles.refreshingPillContainer,
        {
          opacity: fadeAnim,
          transform: [{ scale: scaleAnim }],
        },
      ]}
      pointerEvents={active ? 'auto' : 'none'}
    >
      <LoadingIndicator size="small" style={styles.refreshingLoader} />
      <Text style={styles.refreshingInline}>Refreshing markets</Text>
    </Animated.View>
  );
};

function MarketDashboard() {
  const router = useRouter();
  const { t } = useTranslation();
  const { currency, formatDisplayPrice } = useDisplayCurrency();
  const [selectedTab, setSelectedTab] = useState<ParentTabType>('all');
  const [secondaryFilter, setSecondaryFilter] = useState<SecondaryFilter>(null);
  const [searchText, setSearchText] = useState('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  
  // Stable callback for dropdown state changes
  const handleDropdownChange = useCallback((show: boolean) => {
    setShowCategoryDropdown(show);
  }, []);
  
  // Tab changes must commit synchronously — wrapping in startTransition delayed the swap
  // FlatList ↔ DraggableFlatList + Reanimated and felt like a freeze on Favorites.
  const handleTabSelect = useCallback((tab: ParentTabType) => {
    setSelectedTab(tab);
  }, []);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const { selectAsset, isAuthenticated: storeAuthed, user } = useAppStore();
  const { address: activeAddr } = useActiveEthereumWallet();
  const embeddedAddress = activeAddr ?? null;
  // Demo mode (HL testnet). Drives the demo banner / labels, the live-dot
  // color, and a strict whitelist of tradable perps. Keep this aligned with
  // testnet markets; GOLD is exposed as the HIP-3 perp `xyz:GOLD`.
  const tradingEnv = useAppStore((s) => s.tradingEnv);
  const isDemo = tradingEnv === 'demo';
  const { isReady, isAuthenticated: sessionAuthed, isPendingOAuth, needsOAuthRetry, getAccessToken } = useAuth();
  // Privy session is the source of truth. Zustand lags one paint behind
  // `isReady`, which used to mount the guest hero then swap to Trade Account.
  const isAuthenticated = sessionAuthed || storeAuthed;
  const oauthRetryNavRef = useRef(false);
  const [favoriteCoins, setFavoriteCoins] = useState<string[]>([]);
  const [showAllMarkets, setShowAllMarkets] = useState(false);
  // Split WebSocket hooks: status rarely changes, prices update frequently
  const { reconnect: reconnectPriceWebSocket } = useWebSocketStatus();
  // Use stable prices ref - this hook NEVER triggers re-renders
  const pricesRef = usePricesRef();
  /** Bumped only on pull-to-refresh so rows re-read pricesRef without subscribing to every tick */
  const [livePriceRenderEpoch, setLivePriceRenderEpoch] = useState(0);
  const [isAccountValueHidden, setIsAccountValueHidden] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [showReorderModal, setShowReorderModal] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const guestCtaFade = useRef(new Animated.Value(0)).current;
  const lastHeroAuthed = getHomeHeroAuthedHint();
  // Guest hero only after Privy has settled as logged-out. Until then keep
  // the last session's skeleton so a restore cannot flash the carousel.
  const showGuestCta = isReady && !isAuthenticated && !isPendingOAuth;
  const showAccountBootSkeleton =
    !isAuthenticated && !showGuestCta && lastHeroAuthed !== false;
  const showGuestCtaSkeleton =
    !isAuthenticated && !showGuestCta && lastHeroAuthed === false;
  const isNavigatingRef = useRef(false);
  const lastNavigatedAssetRef = useRef<string | null>(null);
  const [showOnboardingPulse, setShowOnboardingPulse] = useState(false);
  const hasCheckedOnboardingRef = useRef(false);
  const userAddress = (user?.wallet?.address || null) as string | null;
  const tradingAccountAddress = useMemo(() => {
    const embedded = embeddedAddress && embeddedAddress.startsWith('0x') ? embeddedAddress : null;
    const userWallet = userAddress && userAddress.startsWith('0x') ? userAddress : null;
    return (embedded ?? userWallet) as string | null;
  }, [embeddedAddress, userAddress]);

  const {
    activeTradingBook,
    tradingAddress: bookTradingAddress,
    selectDedicatedBook,
    selectMainBook,
  } = useActiveTradingBook();
  const homeBook = activeTradingBook.agentId ?? 'master';
  const { data: homeAiAgents, isFetched: homeAiAgentsFetched } = useQuery({
    queryKey: ['ai_agents', 'books', tradingEnv],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [] as AiAgentView[];
      return (await listAiAgents(token)).agents;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    // Server-side agent status changes (auto-pause/stop) must reach the
    // home book switcher without a manual refresh.
    refetchInterval: 60_000,
  });
  const dedicatedHomeBooks = useMemo(() => {
    const master = (tradingAccountAddress || '').toLowerCase();
    return (homeAiAgents ?? []).filter((a) => {
      if (!isDedicatedSwitcherAgent(a)) return false;
      if ((a.tradingEnv === 'demo') !== isDemo) return false;
      if (master && a.hlMasterAddress.toLowerCase() !== master) return false;
      return true;
    });
  }, [homeAiAgents, tradingAccountAddress, isDemo]);
  const dedicatedHomeTargets = useMemo(
    () =>
      dedicatedHomeBooks.map((a) => ({
        id: a.id,
        subAddress: a.hlSubaccountAddress as string,
      })),
    [dedicatedHomeBooks],
  );
  const dedicatedLiveCounts = useDedicatedBookLivePositionCounts(
    dedicatedHomeTargets,
    dedicatedHomeBooks.length > 0,
  );
  const masterLiveCount = useMasterBookLivePositionCount(dedicatedHomeBooks.length > 0);
  const [homeBookPickerOpen, setHomeBookPickerOpen] = useState(false);
  const homeBookOptions = useMemo((): HomeBookOption[] => {
    if (dedicatedHomeBooks.length === 0) return [];
    return [
      { id: 'master', name: t('portfolio.bookMaster'), liveCount: masterLiveCount },
      ...dedicatedHomeBooks.map((a) => ({
        id: a.id,
        name: a.name,
        liveCount: dedicatedLiveCounts.get(a.id),
        statusLabel: formatBookAgentStatusLabel(a, t),
        statusKind: a.status,
      })),
    ];
  }, [dedicatedHomeBooks, dedicatedLiveCounts, masterLiveCount, t]);
  const openHomeBookPicker = useCallback(() => setHomeBookPickerOpen(true), []);
  const closeHomeBookPicker = useCallback(() => setHomeBookPickerOpen(false), []);
  const selectHomeBook = useCallback(
    (id: 'master' | string) => {
      if (id === 'master') {
        selectMainBook();
      } else {
        const agent = dedicatedHomeBooks.find((a) => a.id === id);
        if (agent?.hlSubaccountAddress) {
          selectDedicatedBook({
            agentId: agent.id,
            subAddress: agent.hlSubaccountAddress,
            name: agent.name,
          });
        }
      }
      setHomeBookPickerOpen(false);
    },
    [dedicatedHomeBooks, selectMainBook, selectDedicatedBook],
  );
  const selectedHomeDedicated = useMemo(
    () =>
      homeBook === 'master'
        ? null
        : dedicatedHomeBooks.find((a) => a.id === homeBook) ?? null,
    [homeBook, dedicatedHomeBooks],
  );
  useEffect(() => {
    if (homeBook === 'master') return;
    if (!homeAiAgentsFetched) return;
    if (!dedicatedHomeBooks.some((a) => a.id === homeBook)) selectMainBook();
  }, [homeBook, dedicatedHomeBooks, selectMainBook, homeAiAgentsFetched]);
  useEffect(() => {
    if (homeBookOptions.length < 2) setHomeBookPickerOpen(false);
  }, [homeBookOptions.length]);
  const displayTradingAddress = useMemo(() => {
    return bookTradingAddress || tradingAccountAddress;
  }, [bookTradingAddress, tradingAccountAddress]);

  const favoriteSet = useMemo(() => new Set(favoriteCoins), [favoriteCoins]);
  const tabs = useMemo(() => {
    const visibleBase = isDemo ? baseTabs.filter((tab) => tab.id !== 'spot') : baseTabs;
    if (isAuthenticated && userAddress) {
      return [
        visibleBase[0],
        { id: 'favorites' as const, labelKey: 'home.favorites', icon: 'star' as const },
        ...visibleBase.slice(1),
      ];
    }
    return visibleBase;
  }, [isAuthenticated, userAddress, isDemo]);

  // Stable callback to resolve tab label keys to translated strings
  const getTabLabel = useCallback((key: string) => t(key), [t]);

  const {
    data: rwaData,
    isLoading: rwaLoading,
    isFetched: rwaFetched,
    isFetching: rwaFetching,
    isError: rwaError,
    error: rwaErrorMsg,
    refetch: refetchRwa,
    isRefetching: isRefetchingRwa,
  } = useQuery({
    queryKey: ['assets'],
    queryFn: fetchAssets,
    // Home rows show 24h change / volume from this payload — keep the 30s
    // cadence the old global default provided.
    refetchInterval: 30_000,
  });

  const {
    data: cryptoData,
    isLoading: cryptoLoading,
    isFetched: cryptoFetched,
    isFetching: cryptoFetching,
    isError: cryptoError,
    error: cryptoErrorMsg,
    refetch: refetchCrypto,
    isRefetching: isRefetchingCrypto,
  } = useQuery({
    queryKey: ['crypto-assets'],
    queryFn: fetchCryptoAssets,
    // Cold start often hits a brief TLS/DNS/backend blip; without retries a
    // single failure left crypto empty until pull-to-refresh (RWA may still load).
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
    // Same as ['assets'] above — home rows read 24h stats from here.
    refetchInterval: 30_000,
  });

  const tradingQueryEnabled =
    !!isAuthenticated && !!displayTradingAddress && displayTradingAddress.startsWith('0x');

  const {
    data: tradingState,
    isLoading: isTradingStateLoading,
    isError: isTradingStateError,
    refetch: refetchTradingState,
  } = useQuery({
    queryKey: ['hl_trading_state', tradingEnv, displayTradingAddress],
    enabled: tradingQueryEnabled,
    queryFn: async () => {
      return await getHyperliquidTradingState(displayTradingAddress as Hex);
    },
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    refetchInterval: 10000,
    staleTime: 5000,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
  });

  /*
   * Debug note (2026-06-03): kept commented for future Home trade-balance
   * investigations. We used this to confirm Home should query the embedded
   * trading wallet, not the app/user wallet imported for UR test flows.
   *
   * useEffect(() => {
   *   if (!__DEV__) return;
   *   console.log('[HLHomeBalanceDebug]', {
   *     tradingQueryEnabled,
   *     isAuthenticated,
   *     isTradingStateLoading,
   *     isTradingStateError,
   *     queryAddress: tradingAccountAddress,
   *     userWalletAddress: userAddress,
   *     embeddedAddress,
   *     addressesMatch:
   *       !!tradingAccountAddress &&
   *       !!embeddedAddress &&
   *       String(tradingAccountAddress).toLowerCase() === String(embeddedAddress).toLowerCase(),
   *     hasTradingState: !!tradingState,
   *     accountValueUsd: tradingState?.accountValueUsd,
   *     withdrawableUsd: tradingState?.withdrawableUsd,
   *     spotBalanceUsd: tradingState?.spotBalanceUsd,
   *     spotUsdcBalanceUsd: tradingState?.spotUsdcBalanceUsd,
   *     perpAccountValueUsd: tradingState?.perpAccountValueUsd,
   *     accountAbstractionMode: tradingState?.accountAbstractionMode,
   *   });
   * }, [
   *   embeddedAddress,
   *   isAuthenticated,
   *   isTradingStateError,
   *   isTradingStateLoading,
   *   tradingAccountAddress,
   *   tradingQueryEnabled,
   *   tradingState,
   *   userAddress,
   * ]);
   */

  const handleRetryTradingState = useCallback(() => {
    void refetchTradingState();
  }, [refetchTradingState]);

  // ─── Live Trade Account balance (HL WebSocket) ─────────────────────
  // The REST query above is only a safety-net / fallback. The card's headline
  // number is driven by the same account stream the asset/profile screens use,
  // so it updates sub-second instead of on the 10s poll. Standard accounts:
  // perp (summed across main + HIP-3 dexes) plus spot. Unified/pooled accounts:
  // the collateral pool lives in spot — summing per-dex perp accountValues
  // double-counts and must not be used for the headline total.
  // Single account WS follows active trading book (Main or Dedicated sub).
  const hlAccountStream = useHyperliquidAccountStream();
  const streamMatchesBook =
    !!displayTradingAddress &&
    !!hlAccountStream.subscribedUser &&
    hlAccountStream.subscribedUser.toLowerCase() === displayTradingAddress.toLowerCase();

  // Recover from a zombie WS (HL silently drops idle sockets) whenever home
  // regains focus by forcing a one-shot REST hydrate into the stream state.
  useFocusEffect(
    useCallback(() => {
      if (!tradingQueryEnabled || !streamMatchesBook) return;
      void hlAccountStream.hydrateFromRest(true);
    }, [tradingQueryEnabled, streamMatchesBook, hlAccountStream.hydrateFromRest]),
  );

  // Spot meta (token list + prices) needed to value non-USDC spot holdings.
  const [spotMetaData, setSpotMetaData] = useState<any>(null);
  useEffect(() => {
    if (!tradingQueryEnabled) return;
    let cancelled = false;
    getSpotMetaAndAssetCtxsCached()
      .then((d) => { if (!cancelled) setSpotMetaData(d); })
      .catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [tradingQueryEnabled]);

  // Perp equity summed across every dex (main + HIP-3). The stream delivers
  // all dexes via allDexsClearinghouseState, so this is just in-memory math.
  const streamPerpAccountValueUsd = useMemo(() => {
    if (!streamMatchesBook) return 0;
    const byDex = hlAccountStream.clearinghouseStatesByDex;
    if (!byDex) {
      const v = parseFloat(hlAccountStream.clearinghouseState?.marginSummary?.accountValue ?? '0');
      return Number.isFinite(v) ? v : 0;
    }
    return Object.values(byDex).reduce((sum: number, ch: any) => {
      const v = parseFloat(ch?.marginSummary?.accountValue ?? '0');
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
  }, [
    streamMatchesBook,
    hlAccountStream.clearinghouseStatesByDex,
    hlAccountStream.clearinghouseState?.marginSummary?.accountValue,
  ]);

  const streamSpotBalanceUsd = useMemo(() => {
    if (!streamMatchesBook) return 0;
    const { spotBalanceUsd: v } = computeSpotBalanceUsd(hlAccountStream.spotState, spotMetaData);
    return Number.isFinite(v) ? v : 0;
  }, [streamMatchesBook, hlAccountStream.spotState, spotMetaData]);

  const queryIsPooledAccount = isPooledAccountMode(tradingState?.accountAbstractionMode);

  // Hold the last positive headline balance across WS reconnect / empty-hydrate
  // (and Home remounts) so the card never flashes $0.00 when we already knew
  // the user had funds. Cleared when REST confirms a real zero for this key.
  const accountValueCacheKey = `${tradingEnv}:${displayTradingAddress ?? ''}`;

  const streamHasAccountSnapshot =
    streamMatchesBook &&
    !!(
      hlAccountStream.spotState ||
      hlAccountStream.clearinghouseState ||
      hlAccountStream.clearinghouseStatesByDex
    );

  const liveAccountValueUsd = useMemo(() => {
    const restVal = Number.isFinite(tradingState?.accountValueUsd) ? tradingState!.accountValueUsd : null;
    const modeKnown = tradingState?.accountAbstractionMode != null;
    const held = lastKnownPositiveAccountValueByKey.get(accountValueCacheKey);

    let computed: number;
    // Unified/pooled: total equals the spot collateral pool (matches getHyperliquidTradingState).
    // HL's source of truth is spotClearinghouseState (token lots) — there is no
    // pre-summed USD total. REST already pairs that with spotMetaAndAssetCtxs
    // mark prices; stream can land before meta, so prefer REST until meta is ready.
    if (queryIsPooledAccount) {
      if (!spotMetaData && restVal != null && restVal > 0.01) {
        computed = restVal;
      } else if (restVal != null && restVal > 0.01 && streamSpotBalanceUsd > 0) {
        // Prefer REST when stream undercounts mid-hydrate (shared cache / focus race).
        computed =
          streamSpotBalanceUsd < restVal * 0.85 ? restVal : streamSpotBalanceUsd;
      } else if (streamSpotBalanceUsd > 0) {
        computed = streamSpotBalanceUsd;
      } else if (restVal != null) {
        computed = restVal;
      } else {
        computed = streamSpotBalanceUsd;
      }
    } else if (!modeKnown) {
      // Without mode, REST may have used perp+spot and double-counted unified
      // accounts. Prefer sticky / spot — never invent a fresh inflated total.
      if (held != null && held > 0.01) computed = held;
      else if (streamSpotBalanceUsd > 0) computed = streamSpotBalanceUsd;
      else if (restVal != null) computed = restVal;
      else computed = 0;
    } else {
      const streamTotal = streamPerpAccountValueUsd + streamSpotBalanceUsd;
      if (streamTotal > 0) computed = streamTotal;
      // Demo balance must never fall back to a cached live/mainnet REST value.
      else if (isDemo) computed = streamTotal;
      else if (restVal != null) computed = restVal;
      else computed = streamTotal;
    }

    if (Number.isFinite(computed) && computed > 0.01) {
      // Only pin sticky totals once mode is known — a null-mode REST result can
      // be perp+spot overcount and must not become the held baseline.
      if (modeKnown) {
        lastKnownPositiveAccountValueByKey.set(accountValueCacheKey, computed);
      }
      return computed;
    }

    // REST confirmed an empty account with a known abstraction mode — allow $0.
    if (modeKnown && restVal != null && restVal <= 0.01) {
      lastKnownPositiveAccountValueByKey.delete(accountValueCacheKey);
      return computed;
    }

    if (held != null && held > 0.01) {
      // Empty stream / reconnect / incomplete hydrate: keep the last known balance.
      if (!streamHasAccountSnapshot || computed <= 0.01) return held;
    }

    return computed;
  }, [
    accountValueCacheKey,
    isDemo,
    queryIsPooledAccount,
    spotMetaData,
    tradingState?.accountAbstractionMode,
    tradingState?.accountValueUsd,
    streamPerpAccountValueUsd,
    streamSpotBalanceUsd,
    streamHasAccountSnapshot,
  ]);

  // Fetch historical PnL for accurate 24h change
  const { data: pnlTimeseries, refetch: refetchPnlTimeseries } = useQuery({
    queryKey: ['hl-pnl-timeseries', tradingEnv, displayTradingAddress],
    enabled: !!isAuthenticated && !!displayTradingAddress && displayTradingAddress.startsWith('0x'),
    queryFn: async () => {
      return await getHistoricalPnlTimeseries(displayTradingAddress as Hex);
    },
    refetchInterval: 60000, // Refresh every minute (historical data doesn't change rapidly)
    staleTime: 30000,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (!tradingQueryEnabled) return;
    void refetchTradingState();
    void refetchPnlTimeseries();
  }, [tradingEnv, tradingQueryEnabled, refetchTradingState, refetchPnlTimeseries]);

  useFocusEffect(
    useCallback(() => {
      if (tradingQueryEnabled) {
        void refetchTradingState();
        void refetchPnlTimeseries();
      }
    }, [tradingQueryEnabled, refetchTradingState, refetchPnlTimeseries]),
  );

  const handleAssetPress = useCallback((asset: Asset) => {
    // Prevent rapid multiple navigations to the same asset
    const assetKey = asset.coin;
    if (isNavigatingRef.current || lastNavigatedAssetRef.current === assetKey) {
      return;
    }
    
    isNavigatingRef.current = true;
    lastNavigatedAssetRef.current = assetKey;
    
    selectAsset(asset);
    // When the user entered from the Spot tab, land on the spot-aware asset
    // page (chart = spot book, stats = 24h spot vol, QuickTrade defaults to
    // spot). Spot-only assets already carry this UX via `asset.isSpotOnly`
    // regardless of tab, so a raw perp tap on HYPE still goes to the perp
    // page as before.
    const wantSpot =
      demoAllowsSpot(tradingEnv) &&
      selectedTab === 'spot' &&
      asset.hasSpot === true &&
      !asset.isSpotOnly;
    if (wantSpot) {
      router.push({ pathname: '/asset/[coin]', params: { coin: asset.coin, market: 'spot' } });
    } else {
      router.push(`/asset/${encodeURIComponent(asset.coin)}`);
    }
    
    // Reset navigation guard after a short delay
    setTimeout(() => {
      isNavigatingRef.current = false;
      // Clear the last navigated asset after navigation completes
      setTimeout(() => {
        lastNavigatedAssetRef.current = null;
      }, 500);
    }, 300);
  }, [router, selectAsset, selectedTab, tradingEnv]);

  const handleRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    reconnectPriceWebSocket();
    const tasks: Promise<unknown>[] = [refetchRwa(), refetchCrypto()];
    if (tradingQueryEnabled) {
      tasks.push(refetchTradingState());
    }
    if (isAuthenticated && tradingAccountAddress?.startsWith('0x')) {
      tasks.push(refetchPnlTimeseries());
    }
    await Promise.allSettled(tasks);
    setIsManualRefreshing(false);
    // Re-read pricesRef into visible rows (ref updates do not re-render FlatList by themselves)
    setLivePriceRenderEpoch((e) => e + 1);
    setTimeout(() => setLivePriceRenderEpoch((e) => e + 1), 400);
  }, [
    reconnectPriceWebSocket,
    refetchRwa,
    refetchCrypto,
    tradingQueryEnabled,
    refetchTradingState,
    refetchPnlTimeseries,
    isAuthenticated,
    tradingAccountAddress,
    userAddress,
  ]);

  const handleRetryMarkets = useCallback(() => {
    void refetchRwa();
    void refetchCrypto();
  }, [refetchRwa, refetchCrypto]);

  const handleSearchToggle = useCallback(() => {
    setShowSearch(true);
  }, []);

  const refreshFavorites = useCallback(async () => {
    if (!isAuthenticated || !userAddress) {
      setFavoriteCoins([]);
      return;
    }
    const next = await loadFavorites(userAddress);
    setFavoriteCoins(next);
  }, [isAuthenticated, userAddress]);

  const handleSearchClose = useCallback(() => {
    setShowSearch(false);
    setSearchText('');
    setDebouncedSearch('');
    Keyboard.dismiss();
  }, []);


  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(searchText.trim());
    }, 250); // 250ms feels more natural while typing
    return () => clearTimeout(id);
  }, [searchText]);

  useFocusEffect(
    useCallback(() => {
      refreshFavorites();
    }, [refreshFavorites]),
  );

  // Warm the Hyperliquid HTTPS connection ahead of any order placement.
  // This is a no-op for guests (they can't trade) and idempotent for
  // signed-in users — getMetaCached() dedupes within its 5-minute TTL,
  // so re-focusing home a hundred times still only triggers one fetch
  // per TTL window. The win is on the first focus per cold app launch:
  // we open the TCP/TLS socket to api.hyperliquid.xyz before the user
  // navigates into a coin and taps Buy/Sell, so the order POST reuses
  // the warm connection and skips ~100-200ms of handshake latency.
  useFocusEffect(
    useCallback(() => {
      if (!isAuthenticated) return;
      prewarmHlTransport();
    }, [isAuthenticated]),
  );

  useFocusEffect(
    useCallback(() => {
      setShowCategoryDropdown(false);
      setShowSearch(false);
      return () => {};
    }, []),
  );

  useEffect(() => {
    if (!isAuthenticated && selectedTab === 'favorites') {
      setSelectedTab('all');
    }
  }, [isAuthenticated, selectedTab]);

  useEffect(() => {
    if (isDemo && selectedTab === 'spot') {
      setSelectedTab('crypto');
    }
  }, [isDemo, selectedTab]);

  // pricesRef is now managed by WebSocketProvider - no need for manual sync

  useEffect(() => {
    if (selectedTab !== 'favorites' || !isAuthenticated) {
      setShowReorderModal(false);
    }
  }, [isAuthenticated, selectedTab]);

  // Fade the guest carousel in once Privy has confirmed a logged-out session.
  useEffect(() => {
    if (!showGuestCta) {
      guestCtaFade.setValue(0);
      return;
    }
    Animated.timing(guestCtaFade, {
      toValue: 1,
      duration: 400,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [showGuestCta, guestCtaFade]);

  // After a broken OAuth round-trip (common on Android + Telegram), send the user
  // to login so the retry banner is visible instead of leaving them on home as guest.
  useEffect(() => {
    if (!needsOAuthRetry) {
      oauthRetryNavRef.current = false;
      return;
    }
    if (!isReady || isAuthenticated || oauthRetryNavRef.current) return;
    oauthRetryNavRef.current = true;
    router.push('/login');
  }, [needsOAuthRetry, isReady, isAuthenticated, router]);

  // Show onboarding pulse for first-time users after successful login
  useEffect(() => {
    if (!isReady || !isAuthenticated || !userAddress || hasCheckedOnboardingRef.current) {
      return;
    }
    hasCheckedOnboardingRef.current = true;

    (async () => {
      try {
        const cachedDone = await isOnboardingCachedComplete();
        if (cachedDone) return;

        // Wait for notifications prompt to finish first
        const waitForNotifPrompt = async () => {
          const start = Date.now();
          while (Date.now() - start < 5000) {
            const done = await AsyncStorage.getItem(NOTIF_PROMPT_DONE_KEY);
            if (done) return;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        };
        await waitForNotifPrompt();

        const token = await getAccessToken();
        if (!token) { setShowOnboardingPulse(true); return; }

        const completed = await fetchOnboardingStatus(token);
        if (!completed) {
          setShowOnboardingPulse(true);
        }
      } catch {
        // Non-critical — default to not showing
      }
    })();
  }, [isReady, isAuthenticated, userAddress, getAccessToken]);

  useEffect(() => {
    if (selectedTab !== 'all') {
      setShowAllMarkets(false);
      return;
    }
    setShowAllMarkets(false);
  }, [selectedTab, secondaryFilter]);

  // Combine all assets for 'all' tab
  const allAssets = useMemo(() => {
    const rwa = rwaData?.assets || [];
    const crypto = cryptoData?.assets || [];
    return [...rwa, ...crypto].map(normalizeAsset);
  }, [rwaData?.assets, cryptoData?.assets]);

  // Backend can return HTTP 200 with empty lists when HL payloads are malformed
  // (`/crypto-assets` explicitly returns []), which React Query treats as success —
  // no retries. Recover with bounded background refetches so users aren't stuck
  // until app restart or pull-to-refresh.
  const emptyMarketsRecoverAttemptsRef = useRef(0);
  useEffect(() => {
    const MAX_EMPTY_RECOVER_ATTEMPTS = 6;
    if (!rwaFetched || !cryptoFetched) return;
    if (rwaFetching || cryptoFetching) return;
    if (rwaError || cryptoError) return;
    if (allAssets.length > 0) {
      emptyMarketsRecoverAttemptsRef.current = 0;
      return;
    }
    if (emptyMarketsRecoverAttemptsRef.current >= MAX_EMPTY_RECOVER_ATTEMPTS) return;

    emptyMarketsRecoverAttemptsRef.current += 1;
    const attempt = emptyMarketsRecoverAttemptsRef.current;
    const delayMs = Math.min(600 * attempt ** 2, 8000);

    const id = setTimeout(() => {
      void refetchRwa();
      void refetchCrypto();
    }, delayMs);
    return () => clearTimeout(id);
  }, [
    rwaFetched,
    cryptoFetched,
    rwaFetching,
    cryptoFetching,
    rwaError,
    cryptoError,
    allAssets.length,
    refetchRwa,
    refetchCrypto,
  ]);

  // Defer market-data updates so a refetch arriving mid-interaction doesn't
  // block tab taps. React commits the new value at low priority and will
  // yield the JS thread to user input (tab change, scroll). On first load
  // the deferred value is empty, so we fall back to the sync `allAssets`
  // until at least one item has been committed — otherwise the FlatList
  // would briefly render its empty state right after the initial fetch.
  const deferredAllAssets = useDeferredValue(allAssets);
  const effectiveAllAssets =
    deferredAllAssets.length === 0 ? allAssets : deferredAllAssets;

  // Filter and sort assets based on selected tab
  const filteredAssets = useMemo(() => {
    // ── Demo mode: restrict the entire universe to known testnet perps ────
    // HL testnet liquidity is thin, so expose only markets we verify are
    // present. Filtering at the source means tabs, search, favorites and
    // secondary sorts naturally operate on the restricted set.
    const demoFilteredAssets = isDemo
      ? effectiveAllAssets.filter((a) => {
          return DEMO_PERP_BASE_WHITELIST.has(getDemoBaseSymbol(a));
        })
      : effectiveAllAssets;

    const sourceAssets = demoFilteredAssets.filter((a) => !isHiddenLowLiquidityGoldSpotAsset(a));

    let assets: Asset[] = [];
    
    switch (selectedTab) {
      case 'favorites':
        const favoritesMap = new Map<string, Asset>();
        sourceAssets.forEach((asset) => {
          if (favoriteSet.has(asset.coin)) {
            favoritesMap.set(asset.coin, asset);
          }
        });
        assets = favoriteCoins
          .map((coin) => favoritesMap.get(coin))
          .filter((asset): asset is Asset => Boolean(asset));
        break;
      case 'crypto':
        assets = sourceAssets.filter(a => a.category === 'crypto');
        break;
      case 'stocks':
        assets = sourceAssets.filter(a => a.category === 'stock');
        break;
      case 'commodities':
        assets = sourceAssets.filter(a => a.category === 'commodity');
        break;
      case 'forex':
        assets = sourceAssets.filter(a => a.category === 'forex');
        break;
      case 'index':
        assets = sourceAssets.filter(a => a.category === 'index');
        break;
      case 'spot':
        assets = isDemo
          ? []
          : sourceAssets.filter(a =>
              (a.hasSpot === true || a.isSpotOnly === true) &&
              SPOT_WHITELIST.has(String(a.symbol || a.coin || '').toUpperCase())
            );
        break;
      default: // 'all'
        assets = sourceAssets;
    }

    if (secondaryFilter === null) {
      assets = sortAssetsByCustomOrder(assets, selectedTab);
    }

    // Apply secondary filter (most active / gainers / losers) within the selected parent category
    // For favorites: show ALL favorites sorted by the filter (no slice)
    // For other categories: show top 15
    const isFavorites = selectedTab === 'favorites';
    
    if (secondaryFilter === 'gainers') {
      // Sort all assets by change descending (highest first, including negatives)
      // This ensures we always show results even if none are positive
      assets = [...assets]
        .sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0));
      if (!isFavorites) assets = assets.slice(0, 15);
    } else if (secondaryFilter === 'losers') {
      // Sort all assets by change ascending (lowest first, including positives)
      // This ensures we always show results even if none are negative
      assets = [...assets]
        .sort((a, b) => (a.change24h ?? 0) - (b.change24h ?? 0));
      if (!isFavorites) assets = assets.slice(0, 15);
    } else if (secondaryFilter === 'active') {
      assets = [...assets]
        .filter(a => a.dayNtlVlm !== null)
        .sort((a, b) => parseFloat(b.dayNtlVlm || '0') - parseFloat(a.dayNtlVlm || '0'));
      if (!isFavorites) assets = assets.slice(0, 15);
    } else if (secondaryFilter === 'new') {
      assets = filterNewlyListedAssets(assets, isFavorites ? 999 : 15);
    }
    
    return assets;
  }, [effectiveAllAssets, favoriteCoins, favoriteSet, selectedTab, secondaryFilter, isDemo]);

  const displayAssets = useMemo(() => {
    if (selectedTab !== 'all') return filteredAssets;
    if (showAllMarkets) return filteredAssets;
    return filteredAssets.slice(0, 20);
  }, [filteredAssets, selectedTab, showAllMarkets]);

  const handleToggleFavorite = useCallback(async (asset: Asset) => {
    if (!isAuthenticated || !userAddress) {
      router.push('/login');
      return;
    }
    const next = await toggleFavorite(userAddress, asset.coin);
    setFavoriteCoins(next.favorites);
  }, [isAuthenticated, router, userAddress]);

  const renderAsset = useCallback(({ item }: { item: Asset }) => {
    const livePrice = pickPrice(pricesRef.current, {
      coin: item.coin,
      symbol: item.symbol,
      isHip3: (item as any).isHip3 === true,
      dex: item.dex,
    });
    
    return (
      <AssetCard
        asset={item}
        onPress={handleAssetPress}
        livePrice={livePrice}
        showFavoriteStar={isAuthenticated && !!userAddress}
        isFavorite={favoriteSet.has(item.coin)}
        onToggleFavorite={handleToggleFavorite}
      />
    );
  }, [favoriteSet, handleAssetPress, handleToggleFavorite, isAuthenticated, userAddress, livePriceRenderEpoch]);

  const keyExtractor = useCallback((item: Asset) => item.coin, []);

  const isLoading = rwaLoading || cryptoLoading;
  const isRefetching = isRefetchingRwa || isRefetchingCrypto;
  /** Market overview skeleton while asset feeds load — revert: remove flag + skeleton branch */
  const showMarketOverviewSkeleton = isLoading && effectiveAllAssets.length === 0;

  const tabTitle = useMemo(() => {
    switch (selectedTab) {
      case 'favorites': return t('home.favorites');
      case 'stocks': return t('home.stocks');
      case 'commodities': return t('home.commodities');
      case 'forex': return t('home.forex');
      case 'crypto': return t('home.crypto');
      case 'spot': return t('home.spot');
      default: return t('home.allMarkets');
    }
  }, [selectedTab, t]);

  const showSecondaryBadges = true;

  const canReorder = selectedTab === 'favorites' && isAuthenticated && secondaryFilter === null && displayAssets.length > 1;
  const handleReorderPress = useCallback(() => {
    setShowReorderModal(true);
  }, []);

  // Same as tab changes: avoid startTransition — deferred secondary-filter updates could block
  // the next category tap for seconds while a large list re-sort was treated as low priority.
  const handleSecondaryPress = useCallback((next: Exclude<SecondaryFilter, null>) => {
    setSecondaryFilter((prev) => (prev === next ? null : next));
  }, []);

  const searchResults = useMemo(() => {
    const query = debouncedSearch.toLowerCase();
    if (!query) return [];
    // Start from the pool that already applies demo gates (when applicable).
    const demoSearchPool = isDemo
      ? effectiveAllAssets.filter(
          (a) => !a.isSpotOnly && DEMO_PERP_BASE_WHITELIST.has(getDemoBaseSymbol(a)),
        )
      : effectiveAllAssets;
    const searchPool = demoSearchPool.filter((a) => !isHiddenLowLiquidityGoldSpotAsset(a));
    const results = searchPool.filter((asset) => {
      const coin = asset.coin?.toLowerCase() ?? '';
      const symbol = asset.symbol?.toLowerCase() ?? '';
      const name = asset.name?.toLowerCase() ?? '';
      return coin.includes(query) || symbol.includes(query) || name.includes(query);
    });
    
    // Sort by priority: exact symbol match > symbol starts with > symbol contains > coin match > name match
    const sortedPerps = [...results].sort((a, b) => {
      const aSymbol = (a.symbol?.toLowerCase() ?? '');
      const bSymbol = (b.symbol?.toLowerCase() ?? '');
      const aCoin = (a.coin?.toLowerCase() ?? '');
      const bCoin = (b.coin?.toLowerCase() ?? '');
      const aName = (a.name?.toLowerCase() ?? '');
      const bName = (b.name?.toLowerCase() ?? '');
      
      // Exact symbol match
      const aExactSymbol = aSymbol === query;
      const bExactSymbol = bSymbol === query;
      if (aExactSymbol && !bExactSymbol) return -1;
      if (!aExactSymbol && bExactSymbol) return 1;
      
      // Symbol starts with query
      const aSymbolStarts = aSymbol.startsWith(query);
      const bSymbolStarts = bSymbol.startsWith(query);
      if (aSymbolStarts && !bSymbolStarts) return -1;
      if (!aSymbolStarts && bSymbolStarts) return 1;
      
      // Symbol contains query
      const aSymbolContains = aSymbol.includes(query);
      const bSymbolContains = bSymbol.includes(query);
      if (aSymbolContains && !bSymbolContains) return -1;
      if (!aSymbolContains && bSymbolContains) return 1;
      
      // Coin match
      const aCoinMatch = aCoin.includes(query);
      const bCoinMatch = bCoin.includes(query);
      if (aCoinMatch && !bCoinMatch) return -1;
      if (!aCoinMatch && bCoinMatch) return 1;
      
      // Name match (lowest priority)
      const aNameMatch = aName.includes(query);
      const bNameMatch = bName.includes(query);
      if (aNameMatch && !bNameMatch) return -1;
      if (!aNameMatch && bNameMatch) return 1;
      
      // If same priority, sort alphabetically by symbol
      return aSymbol.localeCompare(bSymbol);
    });
    return expandAssetSearchRows(sortedPerps, { allowSpot: demoAllowsSpot(tradingEnv) });
  }, [debouncedSearch, effectiveAllAssets, isDemo, tradingEnv]);

  const handleSearchSelect = useCallback((asset: AssetSearchRow) => {
    const assetKey = asset.searchRowKey;
    if (isNavigatingRef.current || lastNavigatedAssetRef.current === assetKey) {
      return;
    }
    
    isNavigatingRef.current = true;
    lastNavigatedAssetRef.current = assetKey;
    
    selectAsset(asset);
    handleSearchClose();
    if (asset.searchMarket === 'spot' && demoAllowsSpot(tradingEnv)) {
      router.push({ pathname: '/asset/[coin]', params: { coin: asset.coin, market: 'spot' } });
    } else {
      router.push({ pathname: '/asset/[coin]', params: { coin: asset.coin } });
    }
    
    // Reset navigation guard after a short delay
    setTimeout(() => {
      isNavigatingRef.current = false;
      // Clear the last navigated asset after navigation completes
      setTimeout(() => {
        lastNavigatedAssetRef.current = null;
      }, 500);
    }, 300);
  }, [handleSearchClose, router, selectAsset]);

  const handleSearchFavoriteToggle = useCallback(async (asset: Asset, e: any) => {
    e.stopPropagation();
    if (!isAuthenticated || !userAddress) {
      router.push('/login');
      return;
    }
    const next = await toggleFavorite(userAddress, asset.coin);
    setFavoriteCoins(next.favorites);
  }, [isAuthenticated, userAddress, router]);

  const formatSearchPrice = useCallback((price: string | number | null | undefined): string => {
    if (!price) return '--';
    const num = typeof price === 'string' ? parseFloat(price) : price;
    if (!Number.isFinite(num)) return '--';
    return formatDisplayPrice(num);
  }, [formatDisplayPrice]);

  const formatSearchChange = useCallback((change: number | null | undefined): string => {
    if (change === null || change === undefined) return '--';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  }, []);

  // Live positions count: Hyperliquid perp + spot only
  const livePositionsCount = useMemo(() => {
    const perpCount = tradingState?.positions?.length ?? 0;
    const spotCount = tradingState?.spotPositionsCount ?? 0;
    return perpCount + spotCount;
  }, [tradingState?.positions, tradingState?.spotPositionsCount]);
  const isAccountSyncLive = !!tradingState && !isTradingStateLoading && !isTradingStateError;

  // Calculate 24h PnL percentage from Hyperliquid historical data
  // For tiny accounts (< $1), show 0% to avoid misleading percentages
  const pnl24hPercent = useMemo(() => {
    const accountValue = tradingState?.accountValueUsd ?? 0;
    
    // Minimum threshold - below $1, any percentage is essentially noise
    const MIN_MEANINGFUL_VALUE = 1.0;
    if (accountValue < MIN_MEANINGFUL_VALUE) return 0;
    
    // Use historical data if available for accurate 24h PnL
    if (pnlTimeseries) {
      return calculate24hPnlPercent(pnlTimeseries, accountValue);
    }
    
    // Fallback to unrealized PnL as a proxy while historical data loads
    const totalUnrealizedPnl = tradingState?.positions?.reduce((sum, pos) => {
      return sum + parseFloat(pos.unrealizedPnl || '0');
    }, 0) ?? 0;
    
    // Cap the fallback percentage too
    const pnlPercent = (totalUnrealizedPnl / accountValue) * 100;
    return Math.max(-99.9, Math.min(pnlPercent, 999.9));
  }, [tradingState?.positions, tradingState?.accountValueUsd, pnlTimeseries]);

  // Stable callbacks for AccountCard (prevents re-renders)
  const handleToggleAccountHidden = useCallback(() => {
    setIsAccountValueHidden((v) => !v);
  }, []);
  
  const handlePortfolioPress = useCallback(() => {
    if (selectedHomeDedicated) {
      pushRouteOnce(
        router,
        `/portfolio?book=${encodeURIComponent(selectedHomeDedicated.id)}` as any,
      );
      return;
    }
    pushRouteOnce(router, '/portfolio');
  }, [router, selectedHomeDedicated]);

  const handleGuestLoginPress = useCallback(() => {
    pushRouteOnce(router, '/login');
  }, [router]);

  const handleProfilePress = useCallback(() => {
    // Clear pulse before navigate so a second tap in the same window can't
    // race into a different href shape; pushRouteOnce also dedupes by pathname.
    const withOnboarding = showOnboardingPulse;
    if (withOnboarding) setShowOnboardingPulse(false);
    pushRouteOnce(
      router,
      withOnboarding
        ? { pathname: '/profile', params: { onboarding: '1' } }
        : '/profile',
    );
  }, [router, showOnboardingPulse]);

  const ListHeader = useCallback(() => (
    <View>
      {/* Auth-boot skeleton — sized to last session so guest↔account doesn't jump */}
      {showAccountBootSkeleton ? <AccountCardSkeleton /> : null}
      {showGuestCtaSkeleton ? <GuestCtaSkeleton /> : null}

      {/* Guest CTA carousel — trading, AI agents, banking, rewards */}
      {showGuestCta ? (
        <Animated.View style={{ opacity: guestCtaFade }}>
          <GuestCtaCarousel onCtaPress={handleGuestLoginPress} />
        </Animated.View>
      ) : null}

      {/* Account Value - Logged In Users (extracted component for performance) */}
      {isAuthenticated ? (
        <AccountCard
          userAddress={tradingAccountAddress}
          tradingState={tradingState}
          isTradingStateLoading={isTradingStateLoading}
          isTradingStateError={isTradingStateError}
          onRetryTradingState={handleRetryTradingState}
          isAccountValueHidden={isAccountValueHidden}
          onToggleHidden={handleToggleAccountHidden}
          livePositionsCount={livePositionsCount}
          pnl24hPercent={pnl24hPercent}
          isConnected={isAccountSyncLive}
          onPortfolioPress={handlePortfolioPress}
          liveAccountValueUsd={liveAccountValueUsd}
          bookKey={`${tradingEnv}:${displayTradingAddress ?? ''}`}
          bookOptions={homeBookOptions.length > 1 ? homeBookOptions : undefined}
          onOpenBookPicker={openHomeBookPicker}
          labels={{
            // Demo mode renames the cards to make it unmistakable that the
            // numbers are testnet values, not real funds. tradeAccount and
            // livePositions are the only two strings the user reads while
            // glancing at the dashboard, so they're worth being explicit.
            // When a Dedicated book is selected, the label shows that agent
            // name; the swap control beside it opens the book picker.
            tradeAccount: selectedHomeDedicated
              ? t('portfolio.agentBookBalance', { name: selectedHomeDedicated.name })
              : isDemo
                ? t('demo.demoAccount')
                : t('home.tradeAccount'),
            loadingAccount: t('home.loadingAccount'),
            walletProvisioning: t('home.walletProvisioning'),
            accountLoadError: t('home.accountLoadError'),
            tapToRetry: t('home.tapToRetry'),
            livePositions: isDemo ? t('demo.demoPositions') : t('home.livePositions'),
            live: isDemo ? t('demo.demoStatusLabel') : t('home.live'),
            syncing: t('home.syncing'),
            pnl: t('home.pnl'),
            switchBook: t('home.switchTradeBook'),
          }}
        />
      ) : isPendingOAuth ? (
        <LinearGradient
          colors={['#1a1a2e', '#16213e', '#0f0f1a']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.accountValueCard}
        >
          <View style={styles.accountValueLoading}>
            <LoadingIndicator size="medium" />
            <Text style={styles.accountValueLoadingText}>{t('common.signingIn')}</Text>
          </View>
        </LinearGradient>
      ) : null}

      {/* Market Stats — revert: `{effectiveAllAssets.length > 0 &&` + MarketStats only */}
      {(showMarketOverviewSkeleton || effectiveAllAssets.length > 0) && (
        <View style={styles.marketStatsSection}>
          <Text style={styles.marketStatsLabel}>{t('home.marketOverview')}</Text>
          {showMarketOverviewSkeleton ? (
            <MarketOverviewSkeleton />
          ) : (
            <MarketStats assets={effectiveAllAssets} />
          )}
        </View>
      )}

      {/* Tab Filter */}
      <TabFilter
        selectedTab={selectedTab}
        onSelectTab={handleTabSelect}
        tabs={tabs}
        showDropdown={showCategoryDropdown}
        onShowDropdownChange={handleDropdownChange}
        getTabLabel={getTabLabel}
      />
      
      {/* Section Header - isolated component for refresh state */}
      <SectionHeader
        title={tabTitle}
        assetCount={filteredAssets.length}
        isRefreshing={isRefetching && !isManualRefreshing}
        showSecondaryBadges={showSecondaryBadges}
        secondaryFilter={secondaryFilter}
        onSecondaryPress={handleSecondaryPress}
        onReorderPress={canReorder ? handleReorderPress : undefined}
        labels={{
          assets: t('common.assets'),
          mostActive: t('home.mostActive'),
          gainers: t('home.gainers'),
          losers: t('home.losers'),
          newListings: t('home.newListings'),
          refreshing: t('home.refreshingMarkets'),
        }}
      />
    </View>
  ), [
    effectiveAllAssets,
    isAuthenticated,
    showAccountBootSkeleton,
    showGuestCtaSkeleton,
    showGuestCta,
    guestCtaFade,
    showMarketOverviewSkeleton,
    // AccountCard props (stable callbacks + memoized values)
    tradingAccountAddress,
    userAddress,
    tradingState,
    isTradingStateLoading,
    isTradingStateError,
    handleRetryTradingState,
    isAccountValueHidden,
    handleToggleAccountHidden,
    livePositionsCount,
    pnl24hPercent,
    isAccountSyncLive,
    handlePortfolioPress,
    dedicatedHomeBooks,
    dedicatedLiveCounts,
    homeBookOptions,
    openHomeBookPicker,
    homeBook,
    selectedHomeDedicated,
    isDemo,
    liveAccountValueUsd,
    displayTradingAddress,
    tradingEnv,
    // Other deps
    router,
    handleGuestLoginPress,
    tabs,
    selectedTab,
    handleTabSelect,
    getTabLabel,
    tabTitle,
    showCategoryDropdown,
    handleDropdownChange,
    filteredAssets.length,
    showSecondaryBadges,
    secondaryFilter,
    handleSecondaryPress,
    canReorder,
    handleReorderPress,
    isRefetching,
    isManualRefreshing,
    t,
  ]);

  const ListFooter = useCallback(() => {
    if (selectedTab !== 'all') return null;
    if (showAllMarkets) return null;
    if (filteredAssets.length <= 20) return null;
    if (isLoading) return null;
    return (
      <View style={styles.showMoreWrap}>
        <TouchableOpacity style={styles.showMoreButton} onPress={() => setShowAllMarkets(true)} activeOpacity={0.85}>
          <Text style={styles.showMoreText}>{t('home.showMore')}</Text>
        </TouchableOpacity>
      </View>
    );
  }, [filteredAssets.length, isLoading, selectedTab, showAllMarkets, t]);

  const rwaAssetCount = rwaData?.assets?.length ?? 0;
  const cryptoFailedNoRwa =
    cryptoError && rwaAssetCount === 0 && !rwaError;

  const ListEmpty = useCallback(() => (
    <View style={styles.emptyContainer}>
      {isLoading ? (
        <>
          <LoadingIndicator size={36} />
          <Text style={styles.emptyText}>{t('home.loadingAssets')}</Text>
        </>
      ) : rwaError ? (
        <>
          <Text style={styles.errorText}>{t('home.failedToLoad')}</Text>
          <Text style={styles.emptySubtext}>{rwaErrorMsg?.message || t('common.tryAgain')}</Text>
        </>
      ) : cryptoFailedNoRwa ? (
        <>
          <Text style={styles.errorText}>{t('home.failedToLoad')}</Text>
          <Text style={styles.emptySubtext}>
            {(cryptoErrorMsg as Error | undefined)?.message || t('common.tryAgain')}
          </Text>
          <TouchableOpacity style={styles.emptyRetryButton} onPress={handleRetryMarkets} activeOpacity={0.85}>
            <Text style={styles.emptyRetryButtonText}>{t('common.tryAgain')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.emptyText}>{t('home.noAssets')}</Text>
          <Text style={styles.emptySubtext}>{t('home.pullToRefresh')}</Text>
        </>
      )}
    </View>
  ), [
    isLoading,
    rwaError,
    rwaErrorMsg,
    cryptoFailedNoRwa,
    cryptoErrorMsg,
    handleRetryMarkets,
    t,
  ]);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background.primary} />
      
      <Header
        showLogo
        onSearchPress={handleSearchToggle}
        onProfilePress={handleProfilePress}
        isSearchActive={false}
        isAuthenticated={isAuthenticated}
        showProfilePulse={showOnboardingPulse}
      />

      <FlatList
        data={displayAssets}
        extraData={`${livePriceRenderEpoch}:${currency}`}
        renderItem={renderAsset}
        keyExtractor={keyExtractor}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={ListFooter}
        ListEmptyComponent={ListEmpty}
        contentContainerStyle={[styles.listContent, { paddingBottom: 80 + Math.max(0, insets.bottom) }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        refreshControl={
          <RefreshControl
            refreshing={isManualRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent.gold}
            colors={[colors.accent.gold]}
          />
        }
      />

      <HomeBookPickerModal
        visible={homeBookPickerOpen && homeBookOptions.length > 1}
        title={t('home.switchTradeBook')}
        options={homeBookOptions}
        selectedId={homeBook}
        onClose={closeHomeBookPicker}
        onSelect={selectHomeBook}
      />

      {/* Reorder Favorites Modal — DraggableFlatList is isolated here */}
      <ReorderFavoritesModal
        visible={showReorderModal}
        assets={displayAssets}
        onDragEnd={(data) => {
          if (!userAddress) return;
          const next = data.map((a) => a.coin);
          const remaining = favoriteCoins.filter((c) => !next.includes(c));
          const merged = [...next, ...remaining];
          setFavoriteCoins(merged);
          void saveFavorites(userAddress, merged);
        }}
        onClose={() => setShowReorderModal(false)}
        labels={{ title: t('home.reorderFavorites'), done: t('common.done') }}
      />

      {/* Search Modal — onShow fires after fade animation completes, then we focus
          the input. On Android, autoFocus + Modal is broken: it conflicts with manual
          focus() and the keyboard often never appears. statusBarTranslucent is required
          so the Modal sits in the same window as the keyboard. We retry once at 250ms
          for slower devices. */}
      <Modal
        visible={showSearch}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={handleSearchClose}
        onShow={() => {
          const focusInput = () => searchInputRef.current?.focus();
          setTimeout(focusInput, 80);
          setTimeout(focusInput, 250);
        }}
      >
        <Pressable style={styles.searchModalBackdrop} onPress={handleSearchClose}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.searchModalContainer}
          >
            <Pressable onPress={() => {}} onStartShouldSetResponder={() => true}>
              <View style={styles.searchInputWrapper}>
                <Ionicons name="search" size={18} color={colors.text.tertiary} />
                <TextInput
                  ref={searchInputRef}
                  style={styles.searchInput}
                  placeholder={t('header.searchPlaceholder')}
                  placeholderTextColor={colors.text.tertiary}
                  value={searchText}
                  onChangeText={setSearchText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {searchText.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchText('')}>
                    <Ionicons name="close-circle" size={18} color={colors.text.tertiary} />
                  </TouchableOpacity>
                )}
              </View>

              <FlatList
              data={searchResults}
              keyExtractor={(item) => item.searchRowKey}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.searchResultsContainer}
              initialNumToRender={10}
              maxToRenderPerBatch={10}
              windowSize={5}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                const row = item as AssetSearchRow;
                const spotSym = row.spotSymbol ? String(row.spotSymbol) : null;
                const livePrice =
                  row.searchMarket === 'spot' && spotSym
                    ? pickPrice(pricesRef.current, { coin: spotSym })
                    : pickPrice(pricesRef.current, {
                        coin: row.coin,
                        symbol: row.symbol,
                        isHip3: row.isHip3 === true,
                        dex: row.dex,
                      });
                const displayPrice =
                  livePrice ||
                  (row.searchMarket === 'spot' && !row.isSpotOnly
                    ? undefined
                    : row.markPx ?? (row as any).oraclePx);
                const change24h =
                  row.searchMarket === 'spot' && !row.isSpotOnly
                    ? null
                    : row.change24h ?? null;
                const isFavorite = favoriteSet.has(row.coin);
                const changeColor = change24h === null || change24h === 0 
                  ? colors.text.secondary 
                  : change24h >= 0 
                    ? colors.status.success 
                    : colors.status.error;

                return (
                  <TouchableOpacity style={styles.searchResultItem} onPress={() => handleSearchSelect(row)}>
                    {isAuthenticated && (
                      <TouchableOpacity
                        onPress={(e) => handleSearchFavoriteToggle(row, e)}
                        style={styles.searchFavoriteButton}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons 
                          name={isFavorite ? 'star' : 'star-outline'} 
                          size={18} 
                          color={isFavorite ? colors.accent.gold : colors.text.tertiary} 
                        />
                      </TouchableOpacity>
                    )}
                    <View style={styles.searchResultContent}>
                      <View style={styles.searchResultRow}>
                        <View style={styles.searchResultLeft}>
                          <View style={styles.searchResultTickerRow}>
                            <Text style={styles.searchResultTicker} allowFontScaling={false}>
                              {formatDisplaySymbol(row.symbol || row.coin)}
                            </Text>
                            {row.searchMarket === 'spot' && (
                              <View style={styles.searchResultBadge}>
                                <Text style={styles.searchResultBadgeText}>{t('home.spot')}</Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.searchResultName} numberOfLines={1}>{row.name}</Text>
                        </View>
                        <View style={styles.searchResultPriceColumn}>
                          <Text style={styles.searchResultPrice}>{formatSearchPrice(displayPrice)}</Text>
                          {change24h !== null && (
                            <Text style={[styles.searchResultChange, { color: changeColor }]}>
                              {formatSearchChange(change24h)}
                            </Text>
                          )}
                        </View>
                        <View style={styles.searchResultCategoryContainer}>
                          <Text style={styles.searchResultCategory} numberOfLines={1}>
                            {row.category === 'forex' ? t('home.forex') : row.category === 'commodity' ? t('home.commodity') : row.category === 'stock' ? t('home.stock') : t('home.crypto')}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <View style={styles.searchEmpty}>
                  <Text style={styles.searchEmptyText}>
                    {debouncedSearch.length > 0 ? t('common.noResults') : t('home.startTyping')}
                  </Text>
                  <TouchableOpacity onPress={handleSearchClose} style={styles.searchEmptyClose}>
                    <Text style={styles.searchEmptyCloseText}>{t('common.close')}</Text>
                  </TouchableOpacity>
                </View>
              }
            />
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* Category Dropdown Modal - rendered outside ListHeader for performance */}
      <Modal
        visible={showCategoryDropdown}
        transparent
        animationType="fade"
        onRequestClose={() => handleDropdownChange(false)}
      >
        <Pressable style={tabFilterStyles.dropdownBackdrop} onPress={() => handleDropdownChange(false)}>
          <Pressable style={tabFilterStyles.dropdownContent} onStartShouldSetResponder={() => true}>
            <View style={tabFilterStyles.dropdownHeader}>
              <Text style={tabFilterStyles.dropdownTitle}>{t('home.categories')}</Text>
              <TouchableOpacity onPress={() => handleDropdownChange(false)}>
                <Ionicons name="close" size={20} color={colors.text.secondary} />
              </TouchableOpacity>
            </View>
            <View style={tabFilterStyles.dropdownList}>
              {tabs.slice(4).map((tab) => {
                const isSelected = selectedTab === tab.id;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    style={[
                      tabFilterStyles.dropdownItem,
                      isSelected && tabFilterStyles.dropdownItemSelected,
                    ]}
                    onPress={() => {
                      handleTabSelect(tab.id);
                      handleDropdownChange(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={tab.icon}
                      size={16}
                      color={isSelected ? colors.accent.gold : colors.text.secondary}
                    />
                    <Text
                      style={[
                        tabFilterStyles.dropdownItemText,
                        isSelected && tabFilterStyles.dropdownItemTextSelected,
                      ]}
                    >
                      {t(tab.labelKey)}
                    </Text>
                    {isSelected && (
                      <Ionicons name="checkmark" size={16} color={colors.accent.gold} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

    </SafeAreaView>
  );
}

export default function Index() {
  return (
    <SafeAreaProvider>
      <MarketDashboard />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  listContent: {
    paddingBottom: 24,
  },
  showMoreWrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  showMoreButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  showMoreText: { fontSize: 13, fontWeight: '800', color: colors.accent.gold },
  searchModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 10, 15, 0.96)',
  },
  searchModalContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 70,
    zIndex: 1,
  },
  // Account Value styles (logged in)
  accountValueCard: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    minHeight: HOME_ACCOUNT_CARD_MIN_HEIGHT,
    justifyContent: 'center',
  },
  accountValueMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  accountValueLeft: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0, // Allows flex item to shrink below content size
  },
  accountValueRight: {
    flex: 1,
    alignItems: 'center',
  },
  positionsLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  accountValueDivider: {
    width: 1,
    height: 60,
    backgroundColor: colors.border.primary,
    marginHorizontal: 16,
  },
  accountValueTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  accountValueLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '500',
  },
  accountValueValueContainer: {
    width: '100%',
    marginTop: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountValueValue: {
    fontSize: 28,
    fontWeight: '900',
    color: colors.text.primary,
    letterSpacing: -0.5,
    textAlign: 'center',
    width: '100%',
  },
  accountValuePnl: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '600',
  },
  accountValueSub: {
    fontSize: 11,
    color: colors.text.tertiary,
  },
  eyeInlineButton: {
    padding: 4,
  },
  accountValueLiveRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  accountValueLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 18,
  },
  accountValueLoadingText: {
    fontSize: 13,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  positionsLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '500',
    marginBottom: 4,
  },
  positionsCount: {
    fontSize: 32,
    fontWeight: '900',
    color: colors.text.primary,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 4,
    gap: 6,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  connectionText: {
    fontSize: 12,
    color: colors.text.tertiary,
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.text.primary,
    paddingVertical: 0,
  },
  searchResultsContainer: {
    paddingTop: 12,
    paddingBottom: 24,
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 10,
    gap: 8,
  },
  searchFavoriteButton: {
    padding: 4,
  },
  searchResultContent: {
    flex: 1,
    minWidth: 0,
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  searchResultLeft: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  searchResultTicker: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text.primary,
    flexShrink: 0,
  },
  searchResultTickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  searchResultBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border.primary,
    backgroundColor: colors.background.primary,
  },
  searchResultBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.accent.gold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  searchResultName: {
    fontSize: 12,
    color: colors.text.secondary,
    marginTop: 2,
  },
  searchResultPriceColumn: {
    alignItems: 'flex-end',
    minWidth: 80,
    marginRight: 8,
    flexShrink: 0,
  },
  searchResultPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
  },
  searchResultChange: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  searchResultCategoryContainer: {
    minWidth: 70,
    maxWidth: 90,
  },
  searchResultCategory: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.gold,
    textAlign: 'right',
  },
  searchEmpty: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  searchEmptyText: {
    fontSize: 14,
    color: colors.text.tertiary,
  },
  searchEmptyClose: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.accent.gold,
  },
  searchEmptyCloseText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.background.primary,
  },
  marketStatsSection: {
    paddingTop: 8,
    paddingBottom: 2,
  },
  marketStatsLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.tertiary,
    paddingHorizontal: 16,
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  sectionHeaderTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    minHeight: 32,
  },
  refreshingPillContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  refreshingLoader: {
    marginRight: 0,
  },
  refreshingInline: {
    fontSize: 10,
    color: colors.text.muted,
    marginLeft: 0,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: colors.text.tertiary,
  },
  sectionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reorderButton: {
    padding: 4,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 4,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    flexShrink: 0,
  },
  badgeSelected: {
    backgroundColor: `${colors.accent.gold}15`,
    borderColor: colors.accent.gold,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  badgeTextSelected: {
    color: colors.accent.gold,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 16,
    color: colors.text.secondary,
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.text.tertiary,
    marginTop: 4,
  },
  errorText: {
    fontSize: 16,
    color: colors.status.error,
  },
  emptyRetryButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: colors.background.tertiary,
    borderRadius: 8,
  },
  emptyRetryButtonText: {
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 15,
  },
  reorderModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  reorderModalContainer: {
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  reorderDraggableList: {
    flexGrow: 1,
    flexShrink: 1,
  },
  reorderModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  reorderModalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text.primary,
  },
  reorderModalDone: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent.gold,
  },
  reorderDragItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: colors.background.primary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  reorderDragItemActive: {
    backgroundColor: colors.background.elevated,
    borderRadius: 12,
  },
  reorderDragHandle: {
    paddingRight: 14,
  },
  reorderDragSymbol: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  reorderDragName: {
    fontSize: 12,
    color: colors.text.secondary,
    marginTop: 2,
  },
});
