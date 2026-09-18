const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../src/assets/images/symbols');
const out = path.join(__dirname, '../src/lib/quoteLogos.ts');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp'));

function toIdent(f) {
  return f
    .replace(/\.webp$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^([0-9])/, 's$1');
}

const aliases = {
  TSLA: 'tsla.webp',
  NVDA: 'nvidia.webp',
  AAPL: 'apple.webp',
  GOOGL: 'google.webp',
  GOOG: 'google.webp',
  AMZN: 'amazon.webp',
  MSFT: 'microsoft.webp',
  META: 'meta.webp',
  INTC: 'intel.webp',
  AMD: 'amd.webp',
  COIN: 'coinbase.webp',
  HOOD: 'hood.webp',
  LITE: 'lite.webp',
  MSTR: 'mstr.webp',
  BOT: 'bot.webp',
  PURRDAT: 'purr.webp',
  PURR: 'purr.webp',
  PLTR: 'pltr.webp',
  CRCL: 'crcl.webp',
  CRWV: 'crwv.webp',
  SPCX: 'spcx.webp',
  CXMT: 'cxmt.webp',
  CBRS: 'cbrs.webp',
  IBM: 'ibm.webp',
  DELL: 'dell.webp',
  AVGO: 'avgo.webp',
  MRVL: 'mrvl.webp',
  COST: 'cost.webp',
  NFLX: 'nflx.webp',
  TSM: 'tsm.webp',
  RIVN: 'rivn.webp',
  MU: 'micron.webp',
  GME: 'gme.webp',
  LLY: 'lly.webp',
  BABA: 'baba.webp',
  SNDK: 'sndk.webp',
  ORCL: 'oracle.webp',
  SKHY: 'skhy.webp',
  SMSN: 'samsung.webp',
  UNITREE: 'unitree.webp',
  MRNA: 'mrna.webp',
  ANTH: 'anth.webp',
  NDX100: 'ndx100.webp',
  SP500: 'sp500.webp',
  SPY: 'sp500.webp',
  EWY: 'ewy.webp',
  DRAM: 'dram.webp',
  GOLD: 'gold.webp',
  SILVER: 'silver.webp',
  PLATINUM: 'platinum.webp',
  PALLADIUM: 'palladium.webp',
  COPPER: 'copper.webp',
  OIL: 'oil.webp',
  CL: 'oil.webp',
  BZ: 'oil.webp',
  BRENTOIL: 'oil.webp',
  NATGAS: 'natgas.webp',
  URNM: 'uranium.webp',
  EUR: 'eur.webp',
  JPY: 'jpy.webp',
  BTC: 'btc-icon.webp',
  ETH: 'eth-icon.webp',
  SOL: 'sol-icon.webp',
  XRP: 'xrp-icon.webp',
  ZEC: 'zcash-icon.webp',
  HYPE: 'hype-icon.webp',
  LIT: 'lit-icon.webp',
  BNB: 'bnb-icon.webp',
  LINK: 'link-icon.webp',
  AAVE: 'aave-icon.webp',
  KNTQ: 'kntq-icon.webp',
  XPL: 'xpl-icon.webp',
  SUI: 'sui-icon.webp',
  XMR: 'xmr-icon.webp',
  UNI: 'uni-icon.webp',
  ONDO: 'ondo-icon.webp',
  GRAM: 'ton-icon.webp',
  TRX: 'trx-icon.webp',
  ADA: 'ada-icon.webp',
  AVAX: 'avax-icon.webp',
  ENA: 'ena-icon.webp',
  MON: 'mon-icon.webp',
  WLD: 'wld-icon.webp',
  ZRO: 'zro-icon.webp',
  APT: 'apt-icon.webp',
  WLFI: 'wlfi-icon.webp',
  TAO: 'tao-icon.webp',
  BCH: 'bch-icon.webp',
  XLM: 'xlm-icon.webp',
  HBAR: 'hbar-icon.webp',
  LTC: 'ltc-icon.webp',
  JUP: 'jup-icon.webp',
  JTO: 'jto-icon.webp',
  PYTH: 'pyth-icon.webp',
  NEAR: 'near-icon.webp',
  ARB: 'arb-icon.webp',
  VVV: 'vvv-icon.webp',
  PUMP: 'pump-icon.webp',
  MEGA: 'mega-icon.webp',
  VIRTUAL: 'virtual-icon.webp',
  PONS: 'pons-icon.webp',
  ASTER: 'aster-icon.webp',
  USDT: 'usdt-icon.webp',
  USDG: 'usdh-icon.webp',
  USDH: 'usdh-icon.webp',
  GOLDSPOT: 'gold.webp',
};

const usedFiles = new Set(Object.values(aliases));
const importByFile = new Map();
const imports = [];

for (const f of [...new Set(Object.values(aliases))]) {
  if (!files.includes(f)) {
    console.error('missing', f);
    continue;
  }
  const id = toIdent(f);
  importByFile.set(f, id);
  imports.push(`import ${id} from '../assets/images/symbols/${f}';`);
}

for (const f of files) {
  if (usedFiles.has(f)) continue;
  const id = toIdent(f);
  importByFile.set(f, id);
  imports.push(`import ${id} from '../assets/images/symbols/${f}';`);
  const stem = f.replace(/\.webp$/, '').replace(/-icon$/, '');
  aliases[stem.toUpperCase()] = f;
}

const lines = [
  '/** Local asset logos — synced from frontend/assets/images/symbols. */',
  ...imports,
  '',
  'const BY_SYMBOL: Record<string, string> = {',
];

for (const [sym, file] of Object.entries(aliases).sort((a, b) => a[0].localeCompare(b[0]))) {
  const id = importByFile.get(file);
  if (!id) continue;
  lines.push(`  ${sym}: ${id},`);
}
lines.push('};', '');
lines.push(
  'function lookupKey(symbol: string): string {',
  "  const raw = String(symbol ?? '').trim();",
  "  if (!raw) return '';",
  "  const base = raw.includes(':') ? raw.split(':').pop() || raw : raw;",
  '  return base.toUpperCase();',
  '}',
  '',
  'export function quoteLogoSrc(symbol: string, remoteUrl?: string | null): string | null {',
  '  const key = lookupKey(symbol);',
  '  if (key && BY_SYMBOL[key]) return BY_SYMBOL[key];',
  "  return remoteUrl?.trim() || null;",
  '}',
  '',
);

fs.writeFileSync(out, lines.join('\n'));
console.log('wrote', out, Object.keys(aliases).length, 'aliases');
