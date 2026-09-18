import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { colors } from '../../src/theme/colors';
import { useAuth } from '../../src/providers/AuthContext';
import { useAppStore } from '../../src/store/appStore';
import { fetchAssets, fetchCryptoAssets, type Asset } from '../../src/lib/api';
import { formatDisplaySymbol } from '../../src/lib/displaySymbols';
import {
  createTenant,
  slugError,
  normalizeTenantSlug,
  tenantPublicUrl,
  feeTenthsToPercentLabel,
  TENANT_DEFAULT_FEE_TENTHS,
  TENANT_MAX_CATALOG,
} from '../../src/tenants';
import { HL_BUILDER_ADDRESS } from '../../src/lib/hyperliquid';

const FEE_CHIPS = [0, 10, 20, 30, 50, 80, 100];

function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function CreateTenantScreen() {
  const router = useRouter();
  const { isAuthenticated, getAccessToken } = useAuth();
  const walletAddress = useAppStore((s) => s.user?.wallet?.address ?? null);

  const [step, setStep] = useState(0);
  const [appName, setAppName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [feeTenths, setFeeTenths] = useState(TENANT_DEFAULT_FEE_TENTHS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hip3 = useQuery({ queryKey: ['tenant-hip3'], queryFn: fetchAssets, staleTime: 60_000 });
  const crypto = useQuery({
    queryKey: ['tenant-crypto'],
    queryFn: fetchCryptoAssets,
    staleTime: 60_000,
  });

  const markets = useMemo(() => {
    const all = [...(hip3.data?.assets ?? []), ...(crypto.data?.assets ?? [])];
    const seen = new Set<string>();
    const out: Asset[] = [];
    for (const a of all) {
      if (a.isSpotOnly) continue;
      const key = a.coin.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }, [hip3.data, crypto.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter((a) => {
      const label = `${a.symbol} ${a.coin} ${a.name} ${a.category}`.toLowerCase();
      return label.includes(q);
    });
  }, [markets, search]);

  const slugNorm = normalizeTenantSlug(slug);
  const slugErr = slug ? slugError(slug) : 'Enter a slug';
  const nameOk = appName.trim().length >= 2;
  const catalogOk = selected.length > 0 && selected.length <= TENANT_MAX_CATALOG;
  const canNext =
    step === 0 ? nameOk && !slugErr : step === 1 ? catalogOk : true;

  const toggle = (coin: string) => {
    setSelected((prev) => {
      if (prev.includes(coin)) return prev.filter((c) => c !== coin);
      if (prev.length >= TENANT_MAX_CATALOG) return prev;
      return [...prev, coin];
    });
  };

  const publish = async () => {
    setError(null);
    if (!isAuthenticated) {
      setError(
        Platform.OS === 'web'
          ? 'Web login is not enabled yet. Create this app from the HyperTrade mobile app.'
          : 'Sign in to publish.',
      );
      if (Platform.OS !== 'web') router.push('/login');
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setError('Could not get a session token. Sign in again.');
      return;
    }
    setBusy(true);
    try {
      const tenant = await createTenant(
        {
          app_name: appName.trim(),
          slug: slugNorm,
          description: description.trim(),
          logo_url: logoUrl.trim(),
          socials: { twitter: twitter.trim(), telegram: telegram.trim(), website: website.trim() },
          catalog: selected,
          builder_fee_tenths: feeTenths,
          owner_wallet: walletAddress,
        },
        token,
      );
      router.replace(`/t/${tenant.slug}` as Href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create app');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => (step > 0 ? setStep(step - 1) : router.back())}
          style={styles.iconBtn}
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text.primary} />
        </TouchableOpacity>
        <Text style={styles.title}>
          {step === 0 ? 'Identity' : step === 1 ? 'Markets' : 'Fee'}
        </Text>
        <Text style={styles.stepLabel}>{step + 1}/3</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 0 && (
          <>
            <Field label="App name" value={appName} onChange={setAppName} placeholder="Alex Perps" />
            <Field
              label="Slug"
              value={slug}
              onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="alex"
              autoCapitalize="none"
            />
            <Text style={styles.help}>
              {slugErr && slug ? slugErr : `URL: ${tenantPublicUrl(slugNorm || 'your-app')}`}
            </Text>
            <Field
              label="Description"
              value={description}
              onChange={setDescription}
              placeholder="Trade the markets I watch"
              multiline
            />
            <Field
              label="Logo URL (https)"
              value={logoUrl}
              onChange={setLogoUrl}
              placeholder="https://…"
              autoCapitalize="none"
            />
            {!!logoUrl.trim() && (
              <Image source={{ uri: logoUrl.trim() }} style={styles.logoPreview} />
            )}
            <Field label="X / Twitter" value={twitter} onChange={setTwitter} placeholder="@handle or URL" autoCapitalize="none" />
            <Field label="Telegram" value={telegram} onChange={setTelegram} placeholder="t.me/…" autoCapitalize="none" />
            <Field label="Website" value={website} onChange={setWebsite} placeholder="https://…" autoCapitalize="none" />
          </>
        )}

        {step === 1 && (
          <>
            <Text style={styles.help}>
              Pick perps from the HyperTrade catalog (including HIP-3). Predictions are not available.
              {selected.length}/{TENANT_MAX_CATALOG} selected.
            </Text>
            <TextInput
              style={styles.input}
              value={search}
              onChangeText={setSearch}
              placeholder="Search markets"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="none"
            />
            {hip3.isLoading || crypto.isLoading ? (
              <ActivityIndicator color={colors.accent.gold} style={{ marginTop: 16 }} />
            ) : (
              filtered.slice(0, 120).map((a) => {
                const on = selected.includes(a.coin);
                return (
                  <TouchableOpacity
                    key={a.coin}
                    style={[styles.marketRow, on && styles.marketOn]}
                    onPress={() => toggle(a.coin)}
                  >
                    <View>
                      <Text style={styles.marketSym}>{formatDisplaySymbol(a.symbol || a.coin)}</Text>
                      <Text style={styles.marketMeta}>{a.name} · {a.category}</Text>
                    </View>
                    <Ionicons
                      name={on ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={on ? colors.accent.gold : colors.text.tertiary}
                    />
                  </TouchableOpacity>
                );
              })
            )}
          </>
        )}

        {step === 2 && (
          <>
            <Text style={styles.section}>Builder fee</Text>
            <Text style={styles.feeValue}>
              {feeTenthsToPercentLabel(feeTenths)} · {feeTenths / 10} bps
            </Text>
            <View style={styles.chips}>
              {FEE_CHIPS.map((n) => (
                <TouchableOpacity
                  key={n}
                  style={[styles.chip, feeTenths === n && styles.chipOn]}
                  onPress={() => setFeeTenths(n)}
                >
                  <Text style={[styles.chipText, feeTenths === n && styles.chipTextOn]}>
                    {n / 10} bps
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.help}>
              0–10 bps (0–0.10%). Charged on fills through the shared HyperTrade builder.
              You do not deposit 100 USDC and you cannot paste a different builder wallet.
            </Text>

            <Text style={styles.section}>Assigned builder</Text>
            <View style={styles.readonly}>
              <Text style={styles.readonlyLabel}>Wallet</Text>
              <Text style={styles.readonlyValue}>{shortAddr(HL_BUILDER_ADDRESS)}</Text>
            </View>
            <Text style={styles.todo}>
              Public URL is {slugNorm || 'slug'}.builderpad.xyz after publish.
            </Text>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.next, !canNext && styles.nextOff]}
          disabled={!canNext || busy}
          onPress={() => (step < 2 ? setStep(step + 1) : void publish())}
        >
          {busy ? (
            <ActivityIndicator color="#0a0a0f" />
          ) : (
            <Text style={styles.nextText}>{step < 2 ? 'Continue' : 'Publish app'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences';
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && { height: 80, textAlignVertical: 'top' }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.text.muted}
        multiline={multiline}
        autoCapitalize={autoCapitalize ?? 'sentences'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background.primary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: colors.text.primary, fontSize: 17, fontWeight: '700' },
  stepLabel: { color: colors.text.tertiary, fontSize: 13, width: 36, textAlign: 'right' },
  body: { paddingHorizontal: 20, paddingBottom: 24 },
  label: { color: colors.text.secondary, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border.primary,
    borderRadius: 10,
    color: colors.text.primary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  help: { color: colors.text.tertiary, fontSize: 12, lineHeight: 18, marginBottom: 14 },
  todo: { color: colors.text.muted, fontSize: 11, lineHeight: 16, marginTop: 16 },
  logoPreview: { width: 48, height: 48, borderRadius: 10, marginBottom: 12, backgroundColor: colors.background.card },
  marketRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.primary,
  },
  marketOn: { opacity: 1 },
  marketSym: { color: colors.text.primary, fontSize: 15, fontWeight: '600' },
  marketMeta: { color: colors.text.tertiary, fontSize: 12, marginTop: 2 },
  section: { color: colors.text.primary, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  feeValue: { color: colors.accent.gold, fontSize: 22, fontWeight: '700', marginBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border.secondary,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipOn: { borderColor: colors.accent.gold, backgroundColor: `${colors.accent.gold}22` },
  chipText: { color: colors.text.secondary, fontSize: 13 },
  chipTextOn: { color: colors.accent.gold, fontWeight: '700' },
  readonly: {
    backgroundColor: colors.background.card,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  readonlyLabel: { color: colors.text.tertiary, fontSize: 11 },
  readonlyValue: { color: colors.text.primary, fontSize: 15, marginTop: 4, fontVariant: ['tabular-nums'] },
  error: { color: '#f87171', marginTop: 12, fontSize: 13 },
  footer: { padding: 16, paddingBottom: 24 },
  next: {
    backgroundColor: colors.accent.gold,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  nextOff: { opacity: 0.4 },
  nextText: { color: '#0a0a0f', fontSize: 16, fontWeight: '700' },
});
