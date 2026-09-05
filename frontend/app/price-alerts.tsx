import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Switch,
  Platform,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { showToast, showErrorToast } from '../src/lib/toast';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { colors } from '../src/theme/colors';
import { useAuth } from '../src/providers/AuthContext';
import {
  PriceAlert,
  AlertHistory,
  getUserAlerts,
  createPriceAlert,
  updatePriceAlert,
  deletePriceAlert,
  getAlertHistory,
  areNotificationsEnabled,
  registerForPushNotifications,
  registerPushTokenWithBackend,
  getNotificationPreferences,
  updateNotificationPreferences,
  writeCachedPushEnabled,
  setSessionPushToken,
} from '../src/lib/notifications';
import { useWebSocket } from '../src/providers/WebSocketProvider';
import { pickPrice } from '../src/lib/priceKeys';
import { useTranslation } from 'react-i18next';
import { fetchAssets, fetchCryptoAssets, Asset } from '../src/lib/api';
import { isHiddenLowLiquidityGoldSpotAsset } from '../src/lib/hiddenMarkets';
import { formatDisplaySymbol } from '../src/lib/displaySymbols';
import { hip3DisplaySymbol } from '../src/lib/hip3Dexes';

/** HIP-3 labels: `GOLD:xyz` / `xyz:SNDK` / `io:ANTH` → `GOLD` / `SNDK` / `ANTH`. */
const getDisplaySymbol = (symbol: string): string => {
  if (!symbol) return symbol;
  const raw = String(symbol).trim();
  const stripped = hip3DisplaySymbol(raw);
  return formatDisplaySymbol(stripped) || stripped || raw;
};

type TabType = 'active' | 'triggered' | 'history';

export default function PriceAlertsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { coin: coinParam, create: createParam } = useLocalSearchParams<{ coin?: string; create?: string }>();
  const prefilledCoin = useMemo(() => {
    const raw = Array.isArray(coinParam) ? coinParam[0] : coinParam;
    if (!raw) return '';
    try {
      return decodeURIComponent(raw).trim();
    } catch {
      return raw.trim();
    }
  }, [coinParam]);
  const shouldOpenCreate = createParam === '1' || createParam === 'true';
  const { isAuthenticated, getAccessToken, walletAddress, user } = useAuth();
  const queryClient = useQueryClient();
  const { prices } = useWebSocket();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  /** Cap sheet height so it never extends into the status bar / notch when the keyboard adjusts layout */
  const createModalMaxHeight = Math.min(windowHeight * 0.92, windowHeight - insets.top - 8);
  
  // State
  const [selectedTab, setSelectedTab] = useState<TabType>('active');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  
  // Create modal state
  const [newSymbol, setNewSymbol] = useState('');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showSymbolResults, setShowSymbolResults] = useState(false);
  const [newTargetPrice, setNewTargetPrice] = useState('');
  const [newCondition, setNewCondition] = useState<'above' | 'below'>('above');
  const [newNote, setNewNote] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [editingAlert, setEditingAlert] = useState<PriceAlert | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; symbol: string } | null>(null);
  const selectedAssetRef = useRef<Asset | null>(null);
  const prefillConsumedRef = useRef(false);

  const resetCreateForm = useCallback(() => {
    setEditingAlert(null);
    setNewSymbol('');
    setSymbolSearch('');
    setShowSymbolResults(false);
    selectedAssetRef.current = null;
    setNewTargetPrice('');
    setNewCondition('above');
    setNewNote('');
  }, []);

  const closeModal = useCallback(() => {
    setShowCreateModal(false);
    resetCreateForm();
  }, [resetCreateForm]);

  const openCreateModal = useCallback(() => {
    resetCreateForm();
    setShowCreateModal(true);
  }, [resetCreateForm]);

  const openEditModal = useCallback((alert: PriceAlert) => {
    setEditingAlert(alert);
    const disp = getDisplaySymbol(alert.symbol);
    setNewSymbol(disp);
    setSymbolSearch(disp);
    setShowSymbolResults(false);
    selectedAssetRef.current = null;
    setNewTargetPrice(String(alert.target_price));
    setNewCondition(alert.condition);
    setNewNote(alert.note ?? '');
    setShowCreateModal(true);
  }, []);
  
  // Check notification status on mount
  useEffect(() => {
    areNotificationsEnabled().then(setNotificationsEnabled);
  }, []);

  // Debounce symbol search input
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(symbolSearch.trim());
    }, 200);
    return () => clearTimeout(id);
  }, [symbolSearch]);

  // Fetch all assets for symbol autocomplete (shared cache with homepage)
  const { data: rwaData, isFetched: rwaFetched } = useQuery({
    queryKey: ['assets'],
    queryFn: fetchAssets,
    staleTime: 30_000,
  });

  const { data: cryptoData, isFetched: cryptoFetched } = useQuery({
    queryKey: ['crypto-assets'],
    queryFn: fetchCryptoAssets,
    staleTime: 30_000,
  });

  const allAssets = useMemo(() => {
    const rwa = (rwaData?.assets || []).map((a: Asset) => ({ ...a, category: a.category || 'stock' }));
    const crypto = (cryptoData?.assets || []).map((a: Asset) => ({ ...a, category: 'crypto' }));
    return [...rwa, ...crypto];
  }, [rwaData?.assets, cryptoData?.assets]);

  // Asset page → price alerts: pre-select symbol and open create modal.
  useEffect(() => {
    if (prefillConsumedRef.current || !prefilledCoin || !rwaFetched || !cryptoFetched) return;

    const coinLower = prefilledCoin.toLowerCase();
    const matchedAsset = allAssets.find((asset) => {
      const assetCoin = String(asset.coin ?? '').toLowerCase();
      const assetSymbol = String(asset.symbol ?? '').toLowerCase();
      return assetCoin === coinLower || assetSymbol === coinLower;
    });

    prefillConsumedRef.current = true;

    if (matchedAsset) {
      const displaySym = getDisplaySymbol(matchedAsset.symbol || matchedAsset.coin);
      setNewSymbol(displaySym);
      setSymbolSearch(displaySym);
      setShowSymbolResults(false);
      selectedAssetRef.current = matchedAsset;
    } else {
      const displaySym = getDisplaySymbol(prefilledCoin);
      setNewSymbol(displaySym);
      setSymbolSearch(displaySym);
      setShowSymbolResults(false);
      selectedAssetRef.current = null;
    }

    if (shouldOpenCreate) {
      setEditingAlert(null);
      setShowCreateModal(true);
    }
  }, [prefilledCoin, shouldOpenCreate, allAssets, rwaFetched, cryptoFetched]);

  const symbolSearchResults = useMemo(() => {
    const query = debouncedSearch.toLowerCase();
    if (!query) return [];
    const results = allAssets.filter((asset) => {
      if (isHiddenLowLiquidityGoldSpotAsset(asset)) return false;
      const coin = asset.coin?.toLowerCase() ?? '';
      const symbol = asset.symbol?.toLowerCase() ?? '';
      const name = asset.name?.toLowerCase() ?? '';
      return coin.includes(query) || symbol.includes(query) || name.includes(query);
    });
    return results
      .sort((a, b) => {
        const aSymbol = (a.symbol?.toLowerCase() ?? '');
        const bSymbol = (b.symbol?.toLowerCase() ?? '');
        const aCoin = (a.coin?.toLowerCase() ?? '');
        const bCoin = (b.coin?.toLowerCase() ?? '');
        const aName = (a.name?.toLowerCase() ?? '');
        const bName = (b.name?.toLowerCase() ?? '');

        const aExact = aSymbol === query;
        const bExact = bSymbol === query;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;

        const aStarts = aSymbol.startsWith(query);
        const bStarts = bSymbol.startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;

        const aContains = aSymbol.includes(query);
        const bContains = bSymbol.includes(query);
        if (aContains && !bContains) return -1;
        if (!aContains && bContains) return 1;

        const aCoinMatch = aCoin.includes(query);
        const bCoinMatch = bCoin.includes(query);
        if (aCoinMatch && !bCoinMatch) return -1;
        if (!aCoinMatch && bCoinMatch) return 1;

        const aNameMatch = aName.includes(query);
        const bNameMatch = bName.includes(query);
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;

        return aSymbol.localeCompare(bSymbol);
      })
      .slice(0, 8);
  }, [debouncedSearch, allAssets]);

  const handleSymbolSelect = useCallback((asset: Asset) => {
    const displaySym = getDisplaySymbol(asset.symbol || asset.coin);
    setNewSymbol(displaySym);
    setSymbolSearch(displaySym);
    setShowSymbolResults(false);
    selectedAssetRef.current = asset;
  }, []);

  const handleSymbolSearchChange = useCallback((text: string) => {
    setSymbolSearch(text);
    setNewSymbol(text.toUpperCase());
    setShowSymbolResults(true);
    selectedAssetRef.current = null;
  }, []);

  // Fetch notification preferences
  const { data: preferences, refetch: refetchPreferences } = useQuery({
    queryKey: ['notification-preferences', user?.id ?? 'anon'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return { system_alerts_enabled: true };
      return getNotificationPreferences(token);
    },
    enabled: isAuthenticated,
  });

  const systemAlertsEnabled = preferences?.system_alerts_enabled ?? true;

  // Toggle system alerts mutation
  const toggleSystemAlertsMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      return updateNotificationPreferences(token, { system_alerts_enabled: enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
  });

  // Fetch alerts
  const { data: alerts = [], isLoading: alertsLoading, refetch: refetchAlerts } = useQuery({
    queryKey: ['price-alerts'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [];
      return getUserAlerts(token);
    },
    enabled: isAuthenticated,
    refetchInterval: 30000, // Refresh every 30s
  });

  // Fetch alert history
  const { data: history = [], isLoading: historyLoading, refetch: refetchHistory } = useQuery({
    queryKey: ['alert-history'],
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [];
      return getAlertHistory(token);
    },
    enabled: isAuthenticated && selectedTab === 'history',
    // Newly-fired alerts should appear while the tab is open — keep the 30s
    // cadence the old global default provided.
    refetchInterval: 30_000,
  });

  // Split alerts into active and triggered
  const activeAlerts = useMemo(() => 
    alerts.filter(a => a.is_active && !a.is_triggered),
    [alerts]
  );
  
  const triggeredAlerts = useMemo(() => 
    alerts.filter(a => a.is_triggered),
    [alerts]
  );

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (alertId: string) => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      return deletePriceAlert(alertId, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['price-alerts'] });
    },
  });

  // Toggle active mutation
  const toggleMutation = useMutation({
    mutationFn: async ({ alertId, isActive }: { alertId: string; isActive: boolean }) => {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      return updatePriceAlert(alertId, { is_active: isActive }, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['price-alerts'] });
    },
  });

  // Create or update alert (symbol is fixed when editing; API only allows target, condition, note)
  const handleSaveAlert = useCallback(async () => {
    if (!newSymbol.trim() || !newTargetPrice.trim()) {
      showErrorToast(t('priceAlerts.enterSymbolAndPrice'));
      return;
    }

    const targetPriceNum = parseFloat(newTargetPrice);
    if (isNaN(targetPriceNum) || targetPriceNum <= 0) {
      showErrorToast(t('priceAlerts.enterValidTargetPrice'));
      return;
    }

    setIsCreating(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      if (editingAlert) {
        await updatePriceAlert(
          editingAlert.id,
          {
            target_price: targetPriceNum,
            condition: newCondition,
            note: newNote.trim(),
          },
          token
        );
      } else {
        await createPriceAlert(
          {
            symbol: newSymbol.trim().toUpperCase(),
            target_price: targetPriceNum,
            condition: newCondition,
            note: newNote.trim() || undefined,
          },
          token
        );
      }

      closeModal();
      queryClient.invalidateQueries({ queryKey: ['price-alerts'] });
    } catch (error: any) {
      showErrorToast(
        error.message ||
          (editingAlert ? t('priceAlerts.failedToUpdateAlert') : t('priceAlerts.failedToCreateAlert'))
      );
    } finally {
      setIsCreating(false);
    }
  }, [
    editingAlert,
    newSymbol,
    newTargetPrice,
    newCondition,
    newNote,
    getAccessToken,
    queryClient,
    closeModal,
    t,
  ]);

  // Handle delete alert — branded in-app modal (not system Alert.alert)
  const handleDeleteAlert = useCallback((alertId: string, symbol: string) => {
    setPendingDelete({ id: alertId, symbol });
  }, []);

  const confirmDeleteAlert = useCallback(() => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    deleteMutation.mutate(id);
  }, [pendingDelete, deleteMutation]);

  // Handle toggle alert
  const handleToggleAlert = useCallback((alertId: string, currentState: boolean) => {
    toggleMutation.mutate({ alertId, isActive: !currentState });
  }, [toggleMutation]);

  // Enable notifications
  const handleEnableNotifications = useCallback(async () => {
    const token = await registerForPushNotifications();
    if (token) {
      const accessToken = await getAccessToken();
      if (accessToken) {
        await updateNotificationPreferences(accessToken, { push_enabled: true });
        if (user?.id) await writeCachedPushEnabled(user.id, true);
        await registerPushTokenWithBackend(token, accessToken, undefined, walletAddress ?? undefined);
        setSessionPushToken(token);
        queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
      }
      setNotificationsEnabled(true);
    } else {
      showToast(t('priceAlerts.notificationsDisabled'), t('priceAlerts.enableNotificationsInSettings'), 'info');
    }
  }, [getAccessToken, walletAddress, queryClient, user?.id]);

  // Render alert item
  const renderAlertItem = useCallback(({ item }: { item: PriceAlert }) => {
    const currentPriceRaw = pickPrice(prices, {
      coin: item.symbol,
      isHip3: item.symbol.includes(':'),
    });
    const currentPrice = currentPriceRaw ? parseFloat(String(currentPriceRaw)) : null;
    const priceColor = currentPrice !== null
      ? item.condition === 'above'
        ? currentPrice >= item.target_price
          ? colors.status.success
          : colors.text.secondary
        : currentPrice <= item.target_price
          ? colors.status.success
          : colors.text.secondary
      : colors.text.secondary;

    return (
      <View style={styles.alertCard}>
        <View style={styles.alertHeader}>
          <View style={styles.alertSymbolRow}>
            <Text style={styles.alertSymbol}>{getDisplaySymbol(item.symbol)}</Text>
            <View style={[
              styles.conditionBadge,
              { backgroundColor: item.condition === 'above' 
                ? 'rgba(16, 185, 129, 0.15)' 
                : 'rgba(244, 63, 94, 0.15)' 
              }
            ]}>
              <Ionicons 
                name={item.condition === 'above' ? 'arrow-up' : 'arrow-down'} 
                size={12} 
                color={item.condition === 'above' ? colors.status.success : colors.status.error} 
              />
              <Text style={[
                styles.conditionText,
                { color: item.condition === 'above' ? colors.status.success : colors.status.error }
              ]}>
                {item.condition === 'above' ? t('priceAlerts.above') : t('priceAlerts.below')}
              </Text>
            </View>
          </View>
          
          {!item.is_triggered && (
            <Switch
              value={item.is_active}
              onValueChange={() => handleToggleAlert(item.id, item.is_active)}
              trackColor={{ false: colors.border.primary, true: colors.accent.gold }}
              thumbColor={item.is_active ? '#fff' : colors.text.tertiary}
            />
          )}
        </View>
        
        <View style={styles.alertPrices}>
          <View style={styles.priceColumn}>
            <Text style={styles.priceLabel}>{t('priceAlerts.target')}</Text>
            <Text style={styles.priceValue}>${item.target_price.toLocaleString()}</Text>
          </View>
          
          {currentPrice !== null && !item.is_triggered && (
            <View style={styles.priceColumn}>
              <Text style={styles.priceLabel}>{t('priceAlerts.current')}</Text>
              <Text style={[styles.priceValue, { color: priceColor }]}>
                ${currentPrice.toLocaleString()}
              </Text>
            </View>
          )}
          
          {item.is_triggered && item.triggered_price && (
            <View style={styles.priceColumn}>
              <Text style={styles.priceLabel}>{t('priceAlerts.triggeredAt')}</Text>
              <Text style={[styles.priceValue, { color: colors.status.success }]}>
                ${item.triggered_price.toLocaleString()}
              </Text>
            </View>
          )}
        </View>
        
        {item.note && (
          <Text style={styles.alertNote} numberOfLines={2}>{item.note}</Text>
        )}
        
        <View style={styles.alertFooter}>
          <Text style={styles.alertDate}>
            {item.is_triggered && item.triggered_at
              ? t('priceAlerts.triggeredDate', { date: new Date(item.triggered_at).toLocaleDateString() })
              : t('priceAlerts.createdDate', { date: new Date(item.created_at).toLocaleDateString() })
            }
          </Text>

          <View style={styles.alertFooterActions}>
            {!item.is_triggered && (
              <TouchableOpacity
                onPress={() => openEditModal(item)}
                style={styles.footerIconButton}
                accessibilityRole="button"
                accessibilityLabel={t('priceAlerts.editAlert')}
              >
                <Ionicons name="create-outline" size={18} color={colors.accent.gold} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => handleDeleteAlert(item.id, getDisplaySymbol(item.symbol))}
              style={styles.footerIconButton}
            >
              <Ionicons name="trash-outline" size={18} color={colors.status.error} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }, [prices, handleToggleAlert, handleDeleteAlert, openEditModal, t]);

  // Render history item
  const renderHistoryItem = useCallback(({ item }: { item: AlertHistory }) => (
    <View style={styles.historyCard}>
      <View style={styles.historyHeader}>
        <Text style={styles.alertSymbol}>{getDisplaySymbol(item.symbol)}</Text>
        <View style={[
          styles.conditionBadge,
          { backgroundColor: item.condition === 'above' 
            ? 'rgba(16, 185, 129, 0.15)' 
            : 'rgba(244, 63, 94, 0.15)' 
          }
        ]}>
          <Text style={[
            styles.conditionText,
            { color: item.condition === 'above' ? colors.status.success : colors.status.error }
          ]}>
            {item.condition === 'above' ? t('priceAlerts.above') : t('priceAlerts.below')}
          </Text>
        </View>
      </View>
      
      <View style={styles.alertPrices}>
        <View style={styles.priceColumn}>
          <Text style={styles.priceLabel}>{t('priceAlerts.target')}</Text>
          <Text style={styles.priceValue}>${item.target_price.toLocaleString()}</Text>
        </View>
        <View style={styles.priceColumn}>
          <Text style={styles.priceLabel}>{t('priceAlerts.triggered')}</Text>
          <Text style={[styles.priceValue, { color: colors.status.success }]}>
            ${item.triggered_price.toLocaleString()}
          </Text>
        </View>
      </View>
      
      {item.note && (
        <Text style={styles.alertNote} numberOfLines={2}>{item.note}</Text>
      )}
      
      <Text style={styles.alertDate}>
        {new Date(item.triggered_at).toLocaleString()}
      </Text>
    </View>
  ), []);

  // Get current list data
  const currentData = selectedTab === 'active' 
    ? activeAlerts 
    : selectedTab === 'triggered' 
      ? triggeredAlerts 
      : history;

  const isLoading = selectedTab === 'history' ? historyLoading : alertsLoading;

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <View style={styles.headerSide}>
            <TouchableOpacity onPress={() => router.back()} style={styles.headerIconButton} accessibilityRole="button" accessibilityLabel={t('common.goBack')}>
              <Ionicons name="arrow-back" size={24} color={colors.text.primary} />
            </TouchableOpacity>
          </View>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {t('priceAlerts.title')}
            </Text>
          </View>
          <View style={styles.headerSide} />
        </View>
        
        <View style={styles.emptyContainer}>
          <Ionicons name="notifications-off-outline" size={64} color={colors.text.tertiary} />
          <Text style={styles.emptyTitle}>{t('priceAlerts.loginRequired')}</Text>
          <Text style={styles.emptyText}>{t('priceAlerts.loginToCreateAlerts')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerIconButton} accessibilityRole="button" accessibilityLabel={t('common.goBack')}>
            <Ionicons name="arrow-back" size={24} color={colors.text.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t('priceAlerts.title')}
          </Text>
        </View>
        <View style={styles.headerSide}>
          <TouchableOpacity onPress={openCreateModal} style={styles.headerIconButton} accessibilityRole="button" accessibilityLabel={t('priceAlerts.createAlert')}>
            <Ionicons name="add" size={24} color={colors.accent.gold} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Notifications Banner */}
      {!notificationsEnabled && (
        <TouchableOpacity style={styles.notificationBanner} onPress={handleEnableNotifications}>
          <Ionicons name="notifications-outline" size={20} color={colors.status.warning} />
          <Text style={styles.notificationBannerText}>
            {t('priceAlerts.enableNotificationsToReceive')}
          </Text>
          <Ionicons name="chevron-forward" size={20} color={colors.status.warning} />
        </TouchableOpacity>
      )}

      {/* System Alerts Toggle */}
      <View style={styles.settingsSection}>
        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <View style={styles.settingTitleRow}>
              <Ionicons name="trending-up" size={18} color={colors.accent.gold} />
              <Text style={styles.settingTitle}>{t('priceAlerts.marketMoveAlerts')}</Text>
            </View>
            <Text style={styles.settingDescription}>
              {t('priceAlerts.marketMoveAlertsDescription')}
            </Text>
          </View>
          <Switch
            value={systemAlertsEnabled}
            onValueChange={(value) => toggleSystemAlertsMutation.mutate(value)}
            trackColor={{ false: colors.border.primary, true: colors.accent.gold }}
            thumbColor={systemAlertsEnabled ? '#fff' : colors.text.tertiary}
            disabled={toggleSystemAlertsMutation.isPending}
          />
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabsContainer}>
        {(['active', 'triggered', 'history'] as TabType[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, selectedTab === tab && styles.tabActive]}
            onPress={() => setSelectedTab(tab)}
          >
            <Text
              style={[styles.tabText, selectedTab === tab && styles.tabTextActive]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
            >
              {tab === 'active' ? t('priceAlerts.active', { count: activeAlerts.length })
                : tab === 'triggered' ? t('priceAlerts.triggeredLabel', { count: triggeredAlerts.length })
                : t('priceAlerts.history')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.accent.gold} />
        </View>
      ) : currentData.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons 
            name={selectedTab === 'active' ? 'notifications-outline' : 'checkmark-circle-outline'} 
            size={64} 
            color={colors.text.tertiary} 
          />
          <Text style={styles.emptyTitle}>
            {selectedTab === 'active' ? t('priceAlerts.noActiveAlerts')
              : selectedTab === 'triggered' ? t('priceAlerts.noTriggeredAlerts')
              : t('priceAlerts.noAlertHistory')}
          </Text>
          <Text style={styles.emptyText}>
            {selectedTab === 'active' 
              ? t('priceAlerts.createAlertDescription')
              : t('priceAlerts.triggeredAlertsDescription')}
          </Text>
          {selectedTab === 'active' && (
            <TouchableOpacity 
              style={styles.createButton} 
              onPress={openCreateModal}
            >
              <Ionicons name="add" size={20} color={colors.background.primary} />
                    <Text style={styles.createButtonText}>{t('priceAlerts.createAlert')}</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={currentData as any}
          keyExtractor={(item) => item.id}
          renderItem={selectedTab === 'history' ? renderHistoryItem as any : renderAlertItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {
                refetchAlerts();
                if (selectedTab === 'history') refetchHistory();
              }}
              tintColor={colors.accent.gold}
            />
          }
        />
      )}

      {/* Create Alert Modal */}
      <Modal
        visible={showCreateModal}
        animationType="slide"
        transparent={true}
        onRequestClose={closeModal}
      >
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalSheetSafe} edges={['top']}>
            <View style={[styles.modalContainer, { maxHeight: createModalMaxHeight }]}>
            <LinearGradient
              colors={[colors.background.elevated, colors.background.secondary]}
              style={styles.modalGradient}
            >
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {editingAlert ? t('priceAlerts.editPriceAlert') : t('priceAlerts.createPriceAlert')}
                </Text>
                <TouchableOpacity
                  onPress={closeModal}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                >
                  <Ionicons name="close" size={24} color={colors.text.secondary} />
                </TouchableOpacity>
              </View>

            <KeyboardAwareScrollView
              style={styles.modalFormScroll}
              contentContainerStyle={styles.modalFormScrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              bottomOffset={36}
              extraKeyboardSpace={Platform.OS === 'ios' ? 20 : 24}
            >
              {/* Symbol: read-only when editing; search when creating */}
              <View style={[styles.inputGroup, { zIndex: 10 }]}>
                <Text style={styles.inputLabel}>{t('priceAlerts.symbol')}</Text>
                {editingAlert ? (
                  <>
                    <Text style={styles.symbolReadOnly}>{getDisplaySymbol(editingAlert.symbol)}</Text>
                    <Text style={styles.symbolReadOnlyHint}>{t('priceAlerts.symbolCannotChange')}</Text>
                  </>
                ) : (
                <View>
                  <TextInput
                    style={styles.textInput}
                    placeholder={t('priceAlerts.symbolPlaceholder')}
                    placeholderTextColor={colors.text.tertiary}
                    value={symbolSearch}
                    onChangeText={handleSymbolSearchChange}
                    onFocus={() => { if (symbolSearch.trim()) setShowSymbolResults(true); }}
                    autoCapitalize="characters"
                  />
                  {showSymbolResults && symbolSearchResults.length > 0 && (
                    <View style={styles.autocompleteDropdown}>
                      <View style={styles.autocompleteList}>
                        {symbolSearchResults.map((item) => {
                          const displaySym = getDisplaySymbol(item.symbol || item.coin);
                          const livePriceRaw = pickPrice(prices, {
                            coin: item.coin,
                            symbol: item.symbol,
                            isHip3: item.isHip3 === true,
                            dex: item.dex,
                          });
                          const displayPrice = livePriceRaw || item.markPx;
                          const categoryLabel =
                            item.category === 'forex' ? t('home.forex')
                            : item.category === 'commodity' ? t('home.commodity')
                            : item.category === 'stock' ? t('home.stock')
                            : t('home.crypto');
                          const rowKey = `${item.coin}-${item.symbol ?? ''}`;
                          return (
                            <TouchableOpacity
                              key={rowKey}
                              style={styles.autocompleteItem}
                              onPress={() => handleSymbolSelect(item)}
                            >
                              <View style={styles.autocompleteItemLeft}>
                                <Text style={styles.autocompleteSymbol}>{displaySym}</Text>
                                <Text style={styles.autocompleteName} numberOfLines={1}>{item.name}</Text>
                              </View>
                              <View style={styles.autocompleteItemRight}>
                                {displayPrice && (
                                  <Text style={styles.autocompletePrice}>
                                    ${parseFloat(String(displayPrice)).toLocaleString()}
                                  </Text>
                                )}
                                <View style={styles.autocompleteCategoryBadge}>
                                  <Text style={styles.autocompleteCategoryText}>{categoryLabel}</Text>
                                </View>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}
                  {showSymbolResults && debouncedSearch.length > 0 && symbolSearchResults.length === 0 && (
                    <View style={styles.autocompleteDropdown}>
                      <View style={styles.autocompleteEmpty}>
                        <Ionicons name="search-outline" size={16} color={colors.text.tertiary} />
                        <Text style={styles.autocompleteEmptyText}>{t('common.noResults')}</Text>
                      </View>
                    </View>
                  )}
                </View>
                )}
              </View>

              {/* Target Price Input */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>{t('priceAlerts.targetPrice')}</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="0.00"
                  placeholderTextColor={colors.text.tertiary}
                  value={newTargetPrice}
                  onChangeText={setNewTargetPrice}
                  keyboardType="decimal-pad"
                />
              </View>

              {/* Condition Selector */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>{t('priceAlerts.condition')}</Text>
                <View style={styles.conditionSelector}>
                  <TouchableOpacity
                    style={[
                      styles.conditionOption,
                      newCondition === 'above' && styles.conditionOptionActive,
                    ]}
                    onPress={() => setNewCondition('above')}
                  >
                    <Ionicons 
                      name="arrow-up" 
                      size={18} 
                      color={newCondition === 'above' ? colors.status.success : colors.text.tertiary} 
                    />
                    <Text style={[
                      styles.conditionOptionText,
                      newCondition === 'above' && { color: colors.status.success }
                    ]}>
                      {t('priceAlerts.above')}
                    </Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity
                    style={[
                      styles.conditionOption,
                      newCondition === 'below' && styles.conditionOptionActiveRed,
                    ]}
                    onPress={() => setNewCondition('below')}
                  >
                    <Ionicons 
                      name="arrow-down" 
                      size={18} 
                      color={newCondition === 'below' ? colors.status.error : colors.text.tertiary} 
                    />
                    <Text style={[
                      styles.conditionOptionText,
                      newCondition === 'below' && { color: colors.status.error }
                    ]}>
                      {t('priceAlerts.below')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Note Input */}
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>{t('priceAlerts.noteOptional')}</Text>
                <TextInput
                  style={[styles.textInput, styles.noteInput]}
                  placeholder={t('priceAlerts.addNote')}
                  placeholderTextColor={colors.text.tertiary}
                  value={newNote}
                  onChangeText={setNewNote}
                  multiline
                  maxLength={200}
                />
              </View>

              {/* Submit Button */}
              <TouchableOpacity
                style={[styles.submitButton, isCreating && styles.submitButtonDisabled]}
                onPress={handleSaveAlert}
                disabled={isCreating}
              >
                {isCreating ? (
                  <ActivityIndicator color={colors.background.primary} />
                ) : (
                  <>
                    <Ionicons
                      name={editingAlert ? 'checkmark-circle' : 'notifications'}
                      size={20}
                      color={colors.background.primary}
                    />
                    <Text style={styles.submitButtonText}>
                      {editingAlert ? t('priceAlerts.saveChanges') : t('priceAlerts.createAlert')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </KeyboardAwareScrollView>
            </LinearGradient>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      {/* Delete confirmation — matches in-app modal pattern (trade / portfolio) */}
      <Modal
        visible={!!pendingDelete}
        transparent
        animationType="fade"
        onRequestClose={() => setPendingDelete(null)}
      >
        <View style={styles.confirmModalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPendingDelete(null)} />
          <View style={styles.confirmModalCard}>
            <Text style={styles.confirmModalTitle}>{t('priceAlerts.deleteAlert')}</Text>
            <Text style={styles.confirmModalBody}>
              {pendingDelete
                ? t('priceAlerts.deleteAlertConfirm', { symbol: pendingDelete.symbol })
                : ''}
            </Text>
            <View style={styles.confirmModalButtons}>
              <TouchableOpacity
                style={styles.confirmModalSecondary}
                onPress={() => setPendingDelete(null)}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <Text style={styles.confirmModalSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmModalDestructive}
                onPress={confirmDeleteAlert}
                disabled={deleteMutation.isPending}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
              >
                {deleteMutation.isPending ? (
                  <ActivityIndicator color={colors.background.primary} size="small" />
                ) : (
                  <Text style={styles.confirmModalDestructiveText}>{t('common.delete')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  /** Equal width slots so the title stays centered with back + add (LTR/RTL). */
  headerSide: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    width: '100%',
  },
  notificationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 179, 0, 0.1)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  notificationBannerText: {
    flex: 1,
    fontSize: 14,
    color: colors.status.warning,
    fontWeight: '500',
  },
  settingsSection: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background.card,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  settingTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
  },
  settingDescription: {
    fontSize: 12,
    color: colors.text.secondary,
    lineHeight: 16,
  },
  tabsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: colors.background.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: 'rgba(92, 225, 230, 0.15)',
  },
  tabText: {
    width: '100%',
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
    textAlign: 'center',
    ...Platform.select({
      android: { includeFontPadding: false as const },
      default: {},
    }),
  },
  tabTextActive: {
    color: colors.accent.gold,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent.gold,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    gap: 8,
    marginTop: 16,
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.background.primary,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  alertCard: {
    backgroundColor: colors.background.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 12,
  },
  alertHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  alertSymbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  alertSymbol: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
  },
  conditionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  conditionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  alertPrices: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 8,
  },
  priceColumn: {
    gap: 4,
  },
  priceLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
  },
  priceValue: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text.primary,
  },
  alertNote: {
    fontSize: 13,
    color: colors.text.secondary,
    fontStyle: 'italic',
    marginVertical: 8,
  },
  alertFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border.primary,
  },
  alertFooterActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  footerIconButton: {
    padding: 8,
  },
  alertDate: {
    fontSize: 12,
    color: colors.text.tertiary,
    flex: 1,
    marginRight: 8,
  },
  symbolReadOnly: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 4,
  },
  symbolReadOnlyHint: {
    fontSize: 12,
    color: colors.text.tertiary,
    lineHeight: 16,
    marginBottom: 4,
  },
  historyCard: {
    backgroundColor: colors.background.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    marginBottom: 12,
    gap: 8,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  modalSheetSafe: {
    width: '100%',
    justifyContent: 'flex-end',
    flex: 1,
  },
  modalContainer: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    width: '100%',
  },
  /** Sheet body: horizontal padding matches former modalContent; header uses safe-area top inset in JSX */
  modalGradient: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  modalFormScroll: {
    flexGrow: 0,
  },
  modalFormScrollContent: {
    flexGrow: 1,
    paddingBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.secondary,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: colors.background.secondary,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text.primary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  noteInput: {
    height: 80,
    textAlignVertical: 'top',
  },
  conditionSelector: {
    flexDirection: 'row',
    gap: 12,
  },
  conditionOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.background.secondary,
    borderWidth: 1,
    borderColor: colors.border.primary,
    gap: 8,
  },
  conditionOptionActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: colors.status.success,
  },
  conditionOptionActiveRed: {
    backgroundColor: 'rgba(244, 63, 94, 0.1)',
    borderColor: colors.status.error,
  },
  conditionOptionText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.secondary,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.gold,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.background.primary,
  },
  autocompleteDropdown: {
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 12,
    marginTop: 4,
    overflow: 'hidden',
  },
  autocompleteList: {
    maxHeight: 240,
  },
  autocompleteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
  },
  autocompleteItemLeft: {
    flex: 1,
    marginRight: 12,
  },
  autocompleteSymbol: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  autocompleteName: {
    fontSize: 12,
    color: colors.text.secondary,
    marginTop: 2,
  },
  autocompleteItemRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  autocompletePrice: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.primary,
  },
  autocompleteCategoryBadge: {
    backgroundColor: 'rgba(92, 225, 230, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  autocompleteCategoryText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.accent.gold,
    textTransform: 'capitalize',
  },
  autocompleteEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  autocompleteEmptyText: {
    fontSize: 13,
    color: colors.text.tertiary,
  },

  confirmModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  confirmModalCard: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 20,
    zIndex: 1,
  },
  confirmModalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text.primary,
    marginBottom: 10,
  },
  confirmModalBody: {
    fontSize: 14,
    color: colors.text.secondary,
    lineHeight: 20,
    marginBottom: 20,
  },
  confirmModalButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  confirmModalSecondary: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  confirmModalSecondaryText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text.primary,
  },
  confirmModalDestructive: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.status.error,
    minHeight: 48,
  },
  confirmModalDestructiveText: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.background.primary,
  },
});
