import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { colors } from '../../src/theme/colors';
import { useAuth } from '../../src/providers/AuthContext';
import { listMyTenants, tenantPublicUrl, feeTenthsToPercentLabel } from '../../src/tenants';

export default function TenantLaunchpadScreen() {
  const router = useRouter();
  const { isAuthenticated, getAccessToken } = useAuth();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['my-tenants'],
    enabled: isAuthenticated,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) return [];
      return listMyTenants(token);
    },
  });

  useFocusEffect(
    useCallback(() => {
      if (isAuthenticated) void refetch();
    }, [isAuthenticated, refetch]),
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>Trading apps</Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lede}>
          Launch a branded perps app on HyperTrade. Same wallet, deposits, and builder —
          your name, markets, and fee.
        </Text>
        <Text style={styles.todo}>
          Live apps are at {'{slug}'}.builderpad.xyz. This Expo screen is not the BuilderPad console.
        </Text>

        <TouchableOpacity
          style={styles.primary}
          onPress={() => router.push('/t/create' as Href)}
          activeOpacity={0.85}
        >
          <Ionicons name="add-circle-outline" size={20} color="#0a0a0f" />
          <Text style={styles.primaryText}>Create an app</Text>
        </TouchableOpacity>

        {!isAuthenticated ? (
          <Text style={styles.hint}>
            {Platform.OS === 'web'
              ? 'Publishing requires a HyperTrade login. Web auth is not enabled yet — create from the iOS/Android app, or sign in there first.'
              : 'Sign in to publish and manage your apps.'}
          </Text>
        ) : isLoading ? (
          <ActivityIndicator color={colors.accent.gold} style={{ marginTop: 24 }} />
        ) : (data ?? []).length === 0 ? (
          <Text style={styles.hint}>You have not published an app yet.</Text>
        ) : (
          <View style={styles.list}>
            {(data ?? []).map((row) => (
              <TouchableOpacity
                key={row.id}
                style={styles.card}
                onPress={() => router.push(`/t/${row.slug}` as Href)}
                activeOpacity={0.8}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{row.app_name}</Text>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {tenantPublicUrl(row.slug)}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {row.catalog.length} markets · {feeTenthsToPercentLabel(row.builder_fee_tenths)} fee · {row.status}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.text.tertiary} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background.primary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text.primary, fontSize: 17, fontWeight: '700' },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  lede: { color: colors.text.secondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  todo: { color: colors.text.tertiary, fontSize: 12, lineHeight: 18, marginBottom: 20 },
  primary: {
    backgroundColor: colors.accent.gold,
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryText: { color: '#0a0a0f', fontSize: 16, fontWeight: '700' },
  hint: { color: colors.text.tertiary, fontSize: 13, lineHeight: 20, marginTop: 20 },
  list: { marginTop: 24, gap: 10 },
  card: {
    backgroundColor: colors.background.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardName: { color: colors.text.primary, fontSize: 16, fontWeight: '600' },
  cardMeta: { color: colors.text.tertiary, fontSize: 12, marginTop: 3 },
});
