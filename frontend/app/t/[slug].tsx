import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { colors } from '../../src/theme/colors';
import { fetchAssets, fetchCryptoAssets, type Asset } from '../../src/lib/api';
import { formatDisplaySymbol } from '../../src/lib/displaySymbols';
import { pickPrice } from '../../src/lib/priceKeys';
import { usePricesRef } from '../../src/providers/WebSocketProvider';
import { useDisplayCurrency } from '../../src/providers/CurrencyProvider';
import {
  useTenant,
  filterAssetsForTenant,
  tenantPublicUrl,
  feeTenthsToPercentLabel,
} from '../../src/tenants';

function socialHref(kind: 'twitter' | 'telegram' | 'discord' | 'website', raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (kind === 'twitter') return `https://x.com/${v.replace(/^@/, '')}`;
  if (kind === 'telegram') return `https://t.me/${v.replace(/^@/, '')}`;
  if (kind === 'discord') return v.includes('.') ? `https://${v}` : null;
  if (kind === 'website') return `https://${v}`;
  return null;
}

export default function TenantHomeScreen() {
  const router = useRouter();
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string }>();
  const { tenant, isLoading, error } = useTenant();
  const pricesRef = usePricesRef();
  const { formatCompactPrice } = useDisplayCurrency();

  const hip3 = useQuery({ queryKey: ['tenant-home-hip3'], queryFn: fetchAssets, staleTime: 30_000 });
  const crypto = useQuery({
    queryKey: ['tenant-home-crypto'],
    queryFn: fetchCryptoAssets,
    staleTime: 30_000,
  });

  const assets = useMemo(() => {
    const all = [...(hip3.data?.assets ?? []), ...(crypto.data?.assets ?? [])];
    if (!tenant?.catalog?.length) return [];
    return filterAssetsForTenant(all, tenant.catalog);
  }, [hip3.data, crypto.data, tenant]);

  const openAsset = (asset: Asset) => {
    router.push(`/asset/${encodeURIComponent(asset.coin)}`);
  };

  const socials = tenant
    ? (
        [
          ['logo-twitter', socialHref('twitter', tenant.socials.twitter)],
          ['paper-plane-outline', socialHref('telegram', tenant.socials.telegram)],
          ['chatbubbles-outline', socialHref('discord', tenant.socials.discord)],
          ['globe-outline', socialHref('website', tenant.socials.website)],
        ] as const
      ).filter(([, href]) => !!href)
    : [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.replace('/')} style={styles.iconBtn} hitSlop={12}>
          <Ionicons name="close" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.topTitle} numberOfLines={1}>
          {tenant?.app_name || rawSlug}
        </Text>
        <TouchableOpacity onPress={() => router.push('/t' as Href)} style={styles.iconBtn} hitSlop={12}>
          <Ionicons name="apps-outline" size={20} color={colors.text.secondary} />
        </TouchableOpacity>
      </View>

      {isLoading && !tenant ? (
        <ActivityIndicator color={colors.accent.gold} style={{ marginTop: 40 }} />
      ) : error || !tenant ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>App not found</Text>
          <Text style={styles.emptyBody}>{error || 'This trading app is not live.'}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.brand}>
            {tenant.logo_url ? (
              <Image source={{ uri: tenant.logo_url }} style={styles.logo} />
            ) : (
              <View style={[styles.logo, styles.logoFallback]}>
                <Text style={styles.logoLetter}>
                  {(tenant.app_name || '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{tenant.app_name}</Text>
              {!!tenant.description && (
                <Text style={styles.desc}>{tenant.description}</Text>
              )}
              <Text style={styles.meta}>
                {feeTenthsToPercentLabel(tenant.builder_fee_tenths)} builder fee · powered by HyperTrade
              </Text>
              <Text style={styles.url} numberOfLines={1}>
                {tenantPublicUrl(tenant.slug)}
              </Text>
            </View>
          </View>

          {socials.length > 0 && (
            <View style={styles.socials}>
              {socials.map(([icon, href]) => (
                <TouchableOpacity
                  key={icon}
                  style={styles.socialBtn}
                  onPress={() => href && Linking.openURL(href)}
                >
                  <Ionicons name={icon} size={18} color={colors.text.primary} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.section}>Markets</Text>
          {hip3.isLoading || crypto.isLoading ? (
            <ActivityIndicator color={colors.accent.gold} />
          ) : assets.length === 0 ? (
            <Text style={styles.meta}>No listed markets matched this catalog.</Text>
          ) : (
            assets.map((asset) => {
              const live = pickPrice(pricesRef.current, asset);
              const px = live || asset.markPx;
              return (
                <TouchableOpacity
                  key={asset.coin}
                  style={styles.row}
                  onPress={() => openAsset(asset)}
                  activeOpacity={0.75}
                >
                  <View>
                    <Text style={styles.sym}>{formatDisplaySymbol(asset.symbol || asset.coin)}</Text>
                    <Text style={styles.rowMeta}>{asset.name}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.px}>
                      {px ? formatCompactPrice(parseFloat(px)) : '—'}
                    </Text>
                    <Text
                      style={[
                        styles.chg,
                        (asset.change24h ?? 0) >= 0 ? styles.up : styles.down,
                      ]}
                    >
                      {asset.change24h == null
                        ? '—'
                        : `${asset.change24h >= 0 ? '+' : ''}${asset.change24h.toFixed(2)}%`}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background.primary },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  topTitle: { flex: 1, textAlign: 'center', color: colors.text.primary, fontSize: 16, fontWeight: '700' },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  brand: { flexDirection: 'row', gap: 14, marginBottom: 16 },
  logo: { width: 56, height: 56, borderRadius: 14, backgroundColor: colors.background.card },
  logoFallback: { alignItems: 'center', justifyContent: 'center' },
  logoLetter: { color: colors.accent.gold, fontSize: 22, fontWeight: '800' },
  name: { color: colors.text.primary, fontSize: 22, fontWeight: '800' },
  desc: { color: colors.text.secondary, fontSize: 14, marginTop: 4, lineHeight: 20 },
  meta: { color: colors.text.tertiary, fontSize: 12, marginTop: 6 },
  url: { color: colors.text.muted, fontSize: 11, marginTop: 4 },
  socials: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  socialBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.background.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  section: { color: colors.text.primary, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  sym: { color: colors.text.primary, fontSize: 16, fontWeight: '700' },
  rowMeta: { color: colors.text.tertiary, fontSize: 12, marginTop: 2 },
  px: { color: colors.text.primary, fontSize: 16, fontWeight: '600' },
  chg: { fontSize: 12, marginTop: 2 },
  up: { color: '#34d399' },
  down: { color: '#f87171' },
  empty: { padding: 32, alignItems: 'center' },
  emptyTitle: { color: colors.text.primary, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: colors.text.secondary, textAlign: 'center' },
});
