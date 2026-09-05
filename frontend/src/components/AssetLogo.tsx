import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { hip3DisplaySymbol } from '../lib/hip3Dexes';

/** Strip HIP-3 dex prefix so `xyz:TSLA` / `io:ANTH` resolve like `TSLA` / `ANTH`. */
function logoLookupKey(symbol: string): string {
  const raw = hip3DisplaySymbol(symbol || '').trim().toUpperCase();
  return raw || 'DEFAULT';
}

const ASSET_IMAGES: Record<string, any> = {
  // Stocks
  TSLA: require('../../assets/images/symbols/tsla.webp'),
  NVDA: require('../../assets/images/symbols/nvidia.webp'),
  AAPL: require('../../assets/images/symbols/apple.webp'),
  GOOGL: require('../../assets/images/symbols/google.webp'),
  GOOG: require('../../assets/images/symbols/google.webp'),
  AMZN: require('../../assets/images/symbols/amazon.webp'),
  MSFT: require('../../assets/images/symbols/microsoft.webp'),
  META: require('../../assets/images/symbols/meta.webp'),
  INTC: require('../../assets/images/symbols/intel.webp'),
  AMD: require('../../assets/images/symbols/amd.webp'),
  COIN: require('../../assets/images/symbols/coinbase.webp'),
  HOOD: require('../../assets/images/symbols/hood.webp'),
  LITE: require('../../assets/images/symbols/lite.webp'),
  MSTR: require('../../assets/images/symbols/mstr.webp'),
  BOT: require('../../assets/images/symbols/bot.webp'),
  PURRDAT: require('../../assets/images/symbols/purr.webp'),
  PLTR: require('../../assets/images/symbols/pltr.webp'),
  CRCL: require('../../assets/images/symbols/crcl.webp'),
  CRWV: require('../../assets/images/symbols/crwv.webp'),
  SPCX: require('../../assets/images/symbols/spcx.webp'),
  CXMT: require('../../assets/images/symbols/cxmt.webp'),
  CBRS: require('../../assets/images/symbols/cbrs.webp'),
  IBM: require('../../assets/images/symbols/ibm.webp'),
  DELL: require('../../assets/images/symbols/dell.webp'),
  AVGO: require('../../assets/images/symbols/avgo.webp'),
  MRVL: require('../../assets/images/symbols/mrvl.webp'),
  COST: require('../../assets/images/symbols/cost.webp'),
  NFLX: require('../../assets/images/symbols/nflx.webp'),
  TSM: require('../../assets/images/symbols/tsm.webp'),
  RIVN: require('../../assets/images/symbols/rivn.webp'),
  MU: require('../../assets/images/symbols/micron.webp'),
  GME: require('../../assets/images/symbols/gme.webp'),
  LLY: require('../../assets/images/symbols/lly.webp'),
  BABA: require('../../assets/images/symbols/baba.webp'),
  SNDK: require('../../assets/images/symbols/sndk.webp'),
  ORCL: require('../../assets/images/symbols/oracle.webp'),
  SKHY: require('../../assets/images/symbols/skhy.webp'),
  SMSN: require('../../assets/images/symbols/samsung.webp'),
  UNITREE: require('../../assets/images/symbols/unitree.webp'),
  MRNA: require('../../assets/images/symbols/mrna.webp'),
  ANTH: require('../../assets/images/symbols/anth.webp'),

  // Index/ETFs
  NDX100: require('../../assets/images/symbols/ndx100.webp'),
  SP500: require('../../assets/images/symbols/sp500.webp'),
  EWY: require('../../assets/images/symbols/ewy.webp'),
  DRAM: require('../../assets/images/symbols/dram.webp'),

  // Commodities
  GOLD: require('../../assets/images/symbols/gold.webp'),
  SILVER: require('../../assets/images/symbols/silver.webp'),
  PLATINUM: require('../../assets/images/symbols/platinum.webp'),
  PALLADIUM: require('../../assets/images/symbols/palladium.webp'),
  COPPER: require('../../assets/images/symbols/copper.webp'),
  OIL: require('../../assets/images/symbols/oil.webp'),
  CL: require('../../assets/images/symbols/oil.webp'),
  BZ: require('../../assets/images/symbols/oil.webp'),
  BRENTOIL: require('../../assets/images/symbols/oil.webp'),
  NATGAS: require('../../assets/images/symbols/natgas.webp'),
  URNM: require('../../assets/images/symbols/uranium.webp'),

  // Forex
  EUR: require('../../assets/images/symbols/eur.webp'),
  JPY: require('../../assets/images/symbols/jpy.webp'),

  // Crypto
  BTC: require('../../assets/images/symbols/btc-icon.webp'),
  ETH: require('../../assets/images/symbols/eth-icon.webp'),
  SOL: require('../../assets/images/symbols/sol-icon.webp'),
  XRP: require('../../assets/images/symbols/xrp-icon.webp'),
  ZEC: require('../../assets/images/symbols/zcash-icon.webp'),
  HYPE: require('../../assets/images/symbols/hype-icon.webp'),
  LIT: require('../../assets/images/symbols/lit-icon.webp'),
  BNB: require('../../assets/images/symbols/bnb-icon.webp'),
  LINK: require('../../assets/images/symbols/link-icon.webp'),
  AAVE: require('../../assets/images/symbols/aave-icon.webp'),
  KNTQ: require('../../assets/images/symbols/kntq-icon.webp'),
  XPL: require('../../assets/images/symbols/xpl-icon.webp'),
  SUI: require('../../assets/images/symbols/sui-icon.webp'),
  XMR: require('../../assets/images/symbols/xmr-icon.webp'),
  UNI: require('../../assets/images/symbols/uni-icon.webp'),
  ONDO: require('../../assets/images/symbols/ondo-icon.webp'),
  GRAM: require('../../assets/images/symbols/ton-icon.webp'),
  TRX: require('../../assets/images/symbols/trx-icon.webp'),
  ADA: require('../../assets/images/symbols/ada-icon.webp'),
  AVAX: require('../../assets/images/symbols/avax-icon.webp'),
  ENA: require('../../assets/images/symbols/ena-icon.webp'),
  MON: require('../../assets/images/symbols/mon-icon.webp'),
  WLD: require('../../assets/images/symbols/wld-icon.webp'),
  ZRO: require('../../assets/images/symbols/zro-icon.webp'),
  APT: require('../../assets/images/symbols/apt-icon.webp'),
  WLFI: require('../../assets/images/symbols/wlfi-icon.webp'),
  TAO: require('../../assets/images/symbols/tao-icon.webp'),
  BCH: require('../../assets/images/symbols/bch-icon.webp'),
  XLM: require('../../assets/images/symbols/xlm-icon.webp'),
  HBAR: require('../../assets/images/symbols/hbar-icon.webp'),
  LTC: require('../../assets/images/symbols/ltc-icon.webp'),
  JUP: require('../../assets/images/symbols/jup-icon.webp'),
  JTO: require('../../assets/images/symbols/jto-icon.webp'),
  PYTH: require('../../assets/images/symbols/pyth-icon.webp'),
  NEAR: require('../../assets/images/symbols/near-icon.webp'),
  ARB: require('../../assets/images/symbols/arb-icon.webp'),
  VVV: require('../../assets/images/symbols/vvv-icon.webp'),
  PUMP: require('../../assets/images/symbols/pump-icon.webp'),
  MEGA: require('../../assets/images/symbols/mega-icon.webp'),
  VIRTUAL: require('../../assets/images/symbols/virtual-icon.webp'),
  PONS: require('../../assets/images/symbols/pons-icon.webp'),
  ASTER: require('../../assets/images/symbols/aster-icon.webp'),
  // USDH: require('../../assets/images/symbols/usdh-icon.webp'),
  USDT: require('../../assets/images/symbols/usdt-icon.webp'),
  // GOLDSPOT: require('../../assets/images/symbols/gold.webp'), // XAUT spot — re-enable with hiddenMarkets + whitelist
};

// Asset logo configuration
const ASSET_LOGOS: Record<string, {
  type: 'icon' | 'text' | 'image';
  icon?: string;
  iconSet?: 'ionicons' | 'material' | 'fontawesome';
  text?: string;
  bgColor: string;
  textColor: string;
}> = {
  // Stocks
  TSLA: { type: 'text', text: 'T', bgColor: '#CC0000', textColor: '#fff' },
  NVDA: { type: 'text', text: 'N', bgColor: '#76B900', textColor: '#fff' },
  AAPL: { type: 'icon', icon: 'logo-apple', iconSet: 'ionicons', bgColor: '#555555', textColor: '#fff' },
  GOOGL: { type: 'icon', icon: 'logo-google', iconSet: 'ionicons', bgColor: '#4285F4', textColor: '#fff' },
  GOOG: { type: 'icon', icon: 'logo-google', iconSet: 'ionicons', bgColor: '#4285F4', textColor: '#fff' },
  AMZN: { type: 'text', text: 'a', bgColor: '#FF9900', textColor: '#232F3E' },
  MSFT: { type: 'icon', icon: 'logo-microsoft', iconSet: 'ionicons', bgColor: '#00A4EF', textColor: '#fff' },
  META: { type: 'text', text: 'M', bgColor: '#0081FB', textColor: '#fff' },
  INTC: { type: 'text', text: 'intel', bgColor: '#0071C5', textColor: '#fff' },
  HOOD: { type: 'icon', icon: 'leaf', iconSet: 'ionicons', bgColor: '#00C805', textColor: '#fff' },
  AMD: { type: 'text', text: 'AMD', bgColor: '#ED1C24', textColor: '#fff' },
  COIN: { type: 'text', text: 'C', bgColor: '#0052FF', textColor: '#fff' },
  PLTR: { type: 'text', text: 'P', bgColor: '#101010', textColor: '#fff' },
  MSTR: { type: 'icon', icon: 'cube', iconSet: 'ionicons', bgColor: '#C8102E', textColor: '#fff' },
  BOT: { type: 'icon', icon: 'cube', iconSet: 'ionicons', bgColor: '#C8102E', textColor: '#fff' },
  PURRDAT: { type: 'icon', icon: 'cube', iconSet: 'ionicons', bgColor: '#C8102E', textColor: '#fff' },
  SNOW: { type: 'icon', icon: 'snow', iconSet: 'ionicons', bgColor: '#29B5E8', textColor: '#fff' },
  SQ: { type: 'icon', icon: 'square', iconSet: 'ionicons', bgColor: '#3E4348', textColor: '#fff' },
  SHOP: { type: 'icon', icon: 'bag-handle', iconSet: 'ionicons', bgColor: '#96BF48', textColor: '#fff' },
  SPACEX: { type: 'icon', icon: 'rocket', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  SPCX: { type: 'icon', icon: 'rocket', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  CXMT: { type: 'icon', icon: 'rocket', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  IBM: { type: 'icon', icon: 'logo-ibm', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  DELL: { type: 'icon', icon: 'logo-dell', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  AVGO: { type: 'icon', icon: 'logo-avgo', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  MRVL: { type: 'icon', icon: 'logo-mrvl', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  LITE: { type: 'icon', icon: 'logo-lite', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  UNITREE: { type: 'icon', icon: 'logo-unitree', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  MRNA: { type: 'icon', icon: 'logo-mrna', iconSet: 'ionicons', bgColor: '#005288', textColor: '#fff' },
  ANTH: { type: 'text', text: 'A', bgColor: '#D97757', textColor: '#fff' },
  // Commodities
  GOLD: { type: 'icon', icon: 'cube', iconSet: 'material', bgColor: '#FFD700', textColor: '#8B4513' },
  SILVER: { type: 'icon', icon: 'cube', iconSet: 'material', bgColor: '#C0C0C0', textColor: '#2F4F4F' },
  OIL: { type: 'icon', icon: 'water', iconSet: 'ionicons', bgColor: '#1a1a1a', textColor: '#FFD700' },
  CL: { type: 'icon', icon: 'water', iconSet: 'ionicons', bgColor: '#1a1a1a', textColor: '#FFD700' },
  BZ: { type: 'icon', icon: 'water', iconSet: 'ionicons', bgColor: '#1a1a1a', textColor: '#FFD700' },
  BRENTOIL: { type: 'icon', icon: 'water', iconSet: 'ionicons', bgColor: '#1a1a1a', textColor: '#FFD700' },
  
  // Forex
  EUR: { type: 'text', text: '€', bgColor: '#003399', textColor: '#FFCC00' },
  EURUSDC: { type: 'text', text: '€', bgColor: '#003399', textColor: '#FFCC00' },
  JPY: { type: 'text', text: '¥', bgColor: '#BC002D', textColor: '#fff' },
  USDJPYUSDC: { type: 'text', text: '¥', bgColor: '#BC002D', textColor: '#fff' },
  
  // Index/ETFs
  NDX100: { type: 'icon', icon: 'trending-up', iconSet: 'ionicons', bgColor: '#0071C5', textColor: '#fff' },
  SP500: { type: 'icon', icon: 'trending-up', iconSet: 'ionicons', bgColor: '#0071C5', textColor: '#fff' },
  EWY: { type: 'icon', icon: 'trending-up', iconSet: 'ionicons', bgColor: '#0071C5', textColor: '#fff' },
  DRAM: { type: 'icon', icon: 'trending-up', iconSet: 'ionicons', bgColor: '#0071C5', textColor: '#fff' },
  
  // Crypto
  BTC: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ETH: { type: 'icon', icon: 'diamond', iconSet: 'ionicons', bgColor: '#627EEA', textColor: '#fff' },
  SOL: { type: 'icon', icon: 'sunny', iconSet: 'ionicons', bgColor: '#9945FF', textColor: '#fff' },
  XRP: { type: 'text', text: 'X', bgColor: '#23292F', textColor: '#fff' },
  ZEC: { type: 'text', text: 'Z', bgColor: '#ECB244', textColor: '#231F20' },
  HYPE: { type: 'icon', icon: 'flash', iconSet: 'ionicons', bgColor: '#00D4AA', textColor: '#fff' },
  LIT: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  BNB: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  LINK: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  AAVE: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  XPL: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  PUMP: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  MEGA: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  VIRTUAL: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  PONS: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ASTER: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  SUI: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  JUP: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  JTO: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  PYTH: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  NEAR: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ARB: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  XMR: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  UNI: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ONDO: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  GRAM: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  TRX: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ADA: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  AVAX: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  APT: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  WLFI: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  TAO: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  VVV: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  WLD: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ZRO: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  ENA: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  MON: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  BCH: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  XLM: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  HBAR: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  LTC: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  KNTQ: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  //USDH: { type: 'text', text: '$', bgColor: '#00D4AA', textColor: '#fff' },
  USDT: { type: 'icon', icon: 'logo-bitcoin', iconSet: 'ionicons', bgColor: '#F7931A', textColor: '#fff' },
  // GOLDSPOT: { type: 'icon', icon: 'cube', iconSet: 'ionicons', bgColor: '#FFD700', textColor: '#8B4513' }, // XAUT spot — re-enable with market list
  // Default
  DEFAULT: { type: 'icon', icon: 'stats-chart', iconSet: 'ionicons', bgColor: colors.background.tertiary, textColor: colors.text.secondary },
};

interface AssetLogoProps {
  symbol: string;
  size?: number;
  style?: any;
}

/** Image source from `assets/images/symbols` when available; otherwise null. */
export function getAssetImageSource(symbol: string): any | null {
  const key = logoLookupKey(symbol);
  return ASSET_IMAGES[key] ?? null;
}

export const AssetLogo: React.FC<AssetLogoProps> = ({ symbol, size = 48, style }) => {
  const symbolKey = logoLookupKey(symbol || 'DEFAULT');
  const imageSource = ASSET_IMAGES[symbolKey];
  const config = ASSET_LOGOS[symbolKey] || ASSET_LOGOS.DEFAULT;
  const iconSize = size * 0.5;
  const fontSize = size * 0.35;

  const renderContent = () => {
    if (imageSource) {
      return (
        <Image
          source={imageSource}
          style={[styles.image, { width: size * 0.8, height: size * 0.8 }]}
        />
      );
    }
    switch (config.type) {
      case 'text':
        return (
          <Text style={[styles.text, { fontSize, color: config.textColor }]} numberOfLines={1}>
            {config.text}
          </Text>
        );
      case 'icon':
        if (config.iconSet === 'material') {
          return (
            <MaterialCommunityIcons
              name={config.icon as any}
              size={iconSize}
              color={config.textColor}
            />
          );
        } else if (config.iconSet === 'fontawesome') {
          return (
            <FontAwesome5
              name={config.icon as any}
              size={iconSize}
              color={config.textColor}
            />
          );
        }
        return (
          <Ionicons
            name={config.icon as any}
            size={iconSize}
            color={config.textColor}
          />
        );
      default:
        return (
          <Ionicons
            name="stats-chart"
            size={iconSize}
            color={config.textColor}
          />
        );
    }
  };

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size * 0.25,
          backgroundColor: imageSource ? colors.background.tertiary : config.bgColor,
        },
        style,
      ]}
    >
      {renderContent()}
    </View>
  );
};

export const AssetLogoSmall: React.FC<Omit<AssetLogoProps, 'size'>> = (props) => (
  <AssetLogo {...props} size={40} />
);

export const getCategoryIcon = (category: string): { name: keyof typeof Ionicons.glyphMap; color: string } => {
  switch (category) {
    case 'stock':
      return { name: 'business', color: colors.accent.blue };
    case 'commodity':
      return { name: 'cube', color: colors.accent.gold };
    case 'forex':
      return { name: 'swap-horizontal', color: '#00D4AA' };
    case 'index':
      return { name: 'analytics', color: colors.accent.purple };
    case 'etf':
      return { name: 'pie-chart', color: colors.status.success };
    case 'crypto':
      return { name: 'logo-bitcoin', color: '#F7931A' };
    default:
      return { name: 'stats-chart', color: colors.text.secondary };
  }
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  image: {
    resizeMode: 'cover',
  },
  text: {
    fontWeight: '700',
    textAlign: 'center',
  },
});
