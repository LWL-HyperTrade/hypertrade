from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Query, Header, Body, BackgroundTasks
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import sys
import logging
from pathlib import Path
from pydantic import BaseModel, field_validator
from typing import List, Optional, Dict, Any, Tuple, Literal
import uuid
from datetime import datetime, timedelta, timezone, date
from zoneinfo import ZoneInfo
import csv
import io
import httpx
import asyncio
import json
import collections
import base64
import hashlib
import hmac
import secrets
from web3 import Web3
from web3.exceptions import ContractLogicError, TransactionNotFound
import jwt
from jwt import PyJWKClient
import yfinance as yf
from supabase import create_client, Client as SupabaseClient
from exponent_server_sdk import (
    PushClient,
    PushMessage,
    PushServerError,
    DeviceNotRegisteredError,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from hip3_dexes import enabled_hip3_dexes, hip3_display_symbol, is_hip3_dex_name, split_hip3_coin

from rewards import (
    get_rewards_profile,
    apply_referral_code,
    get_referrals,
    get_point_history,
    get_fee_discount_tenths,
    get_leaderboard,
    on_trade_completed,
    on_cash_activity,
    on_cash_kyc_completed,
    ensure_rewards_profile,
    ACHIEVEMENTS,
    VOLUME_MILESTONES,
    CASH_VOLUME_MILESTONES,
    TIERS,
    ApplyReferralRequest,
)

import ur_api
import ur_chain
import ur_db
import ur_relayer
import privy_import
import ur_statement
import ur_onramp_permit

# Configure logging — use stdout so Railway classifies levels correctly
# (Python defaults to stderr, which Railway treats as "error" for every line)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


# MongoDB connection -- for future use
mongo_url = os.getenv('MONGO_URL')
db_name = os.getenv('DB_NAME')
client: Optional[AsyncIOMotorClient] = None
db = None

if mongo_url and db_name:
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
else:
    logger.warning("MongoDB not configured (MONGO_URL/DB_NAME missing). Continuing without DB.")

# Supabase configuration for push notifications
SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
supabase: Optional[SupabaseClient] = None

if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    logger.info("Supabase client initialized for push notifications")
else:
    logger.warning("Supabase not configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing). Push notifications disabled.")

# Expo Push Client for sending notifications
push_client = PushClient()

# Price alert background worker state
_alert_worker_task: Optional[asyncio.Task] = None
ALERT_CHECK_INTERVAL_SECONDS = 30  # Check prices every 30 seconds
_LEADER_TTL_SECONDS = 45  # Leadership lease; must be > ALERT_CHECK_INTERVAL_SECONDS

# System alerts configuration (round number level crossings)
# Alert when price crosses these round number increments (e.g., BTC crossing 88k, 89k, etc.)
SYSTEM_ALERT_LEVELS = {
    "BTC": 1000.0,   # Alert on $1000 level crossings (87k, 88k, 89k...)
    "GOLD": 100.0,   # Alert on $100 level crossings (2900, 3000, 3100...)
}
# Hysteresis buffer: price must move this % PAST the threshold to trigger
# Prevents rapid oscillation alerts when price hovers around a level
SYSTEM_ALERT_HYSTERESIS = {
    "BTC": 0.001,    # 0.1% = ~$80 buffer at $80k
    "GOLD": 0.001,   # 0.1% = ~$3 buffer at $3k
}
SYSTEM_ALERT_COOLDOWN_MINUTES = 1  # 1 minute cooldown for ANY alert on the same level
_system_alert_last_levels: Dict[str, int] = {}  # In-memory: last notified level per symbol

# Hyperliquid API configuration
HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info"
HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws"

# Alpha Vantage API configuration (fundamentals + macro)
ALPHAVANTAGE_API_URL = "https://www.alphavantage.co/query"
ALPHAVANTAGE_KEY = os.getenv("ALPHAVANTAGE_KEY")
ALPHA_WARMUP_SECRET = os.getenv("ALPHA_WARMUP_SECRET")
INTERNAL_SYNC_SECRET = os.getenv("INTERNAL_SYNC_SECRET") or ALPHA_WARMUP_SECRET

FINNHUB_API_KEY = os.getenv("FINNHUB_KEY")
FINNHUB_BASE_URL = "https://finnhub.io/api/v1"

# ── Finnhub global rate gate (sliding 60s window) ────────────────────────────
# Free-tier limit is 60 req/min. We cap at 50 to leave headroom in case the
# upstream window edges don't align with ours. Every Finnhub HTTP call in this
# process *must* await this gate first; if multiple background loops happen
# to overlap (e.g. daily fundamentals sync + 30-min stocks-news sync + ad-hoc
# market-news refresh) the gate serializes them so we never burst above the
# limit. Steady-state usage is far below the cap so the gate is a no-op.
_FINNHUB_MAX_PER_MINUTE = 50
_finnhub_call_history: "collections.deque[float]" = collections.deque()
_finnhub_rate_lock = asyncio.Lock()


async def _finnhub_rate_gate() -> None:
    """Block until another Finnhub call fits inside the 60s sliding window."""
    import time as _t
    async with _finnhub_rate_lock:
        now = _t.monotonic()
        while _finnhub_call_history and (now - _finnhub_call_history[0]) >= 60.0:
            _finnhub_call_history.popleft()
        if len(_finnhub_call_history) >= _FINNHUB_MAX_PER_MINUTE:
            wait = 60.0 - (now - _finnhub_call_history[0]) + 0.05
            if wait > 0:
                logger.warning(
                    "Finnhub rate gate: sleeping %.2fs (queue=%d)",
                    wait, len(_finnhub_call_history),
                )
                await asyncio.sleep(wait)
                now = _t.monotonic()
                while _finnhub_call_history and (now - _finnhub_call_history[0]) >= 60.0:
                    _finnhub_call_history.popleft()
        _finnhub_call_history.append(now)

# Google Gemini API configuration (with Google Search grounding)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# TODO(2026-10): gemini-2.5-flash is scheduled to retire ~2026-10-16 (Google GA
# retirement). Migrate Ask AI (`/gemini/analysis`) + news headline translation
# (same GEMINI_MODEL_ID) to gemini-3.6-flash or a cheaper 3.x Flash-Lite —
# confirm Search grounding + structured JSON + thinking_budget=0 still work,
# and re-check token vs grounding pricing (3.x is ~3–5× tokens vs 2.5).
GEMINI_MODEL_ID = "gemini-2.5-flash"  # Fast model with search grounding support

# ExchangeRate-API (display-currency conversion)
FOREXRATE_KEY = os.getenv("FOREXRATE_KEY")
FOREXRATE_BASE_URL = "https://v6.exchangerate-api.com/v6"
FOREXRATE_SUPPORTED = {"AED", "ARS", "AUD", "BDT", "BRL", "CAD", "CHF", "CNH", "EGP", "EUR", "HKD", "IDR", "INR", "JPY", "KRW", "NGN", "PHP", "RUB", "SAR", "SGD", "TRY"}


def _normalize_forex_rates(rates: Dict[str, Any]) -> Dict[str, Any]:
    """Map legacy CNY cache rows to CNH (UR bank ledger uses CNH)."""
    out = dict(rates)
    if "CNH" not in out and "CNY" in out:
        out["CNH"] = out["CNY"]
    return out

# Initialize Gemini client (lazy initialization)
_gemini_client = None

def _get_gemini_client():
    """Get or create the Gemini client."""
    global _gemini_client
    if _gemini_client is None and GEMINI_API_KEY:
        from google import genai
        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    return _gemini_client

# Alpha Vantage rate-limit handling + caching (free tier is very strict)
_alpha_lock = asyncio.Lock()
_alpha_last_call = 0.0
_alpha_cache: Dict[str, Dict[str, Any]] = {}

# Persistent earnings date cache: symbol -> (next_earnings_date_iso_str | None, fetched_timestamp)
# Populated from Supabase on startup, updated by warmup cron.
_earnings_mem_cache: Dict[str, Tuple[Optional[str], float]] = {}
_EARNINGS_MEM_TTL = 8 * 86400  # 8 days — stale only if not refreshed for over a week
_EARNINGS_NULL_REWARM_INTERVAL = 12 * 3600  # Re-warm NULL-date symbols every 12 hours
_last_earnings_null_rewarm: float = 0.0  # Timestamp of last periodic earnings re-warm

# Gemini AI analysis caching (4-hour TTL, shared across all users)
_gemini_cache: Dict[str, Dict[str, Any]] = {}
_gemini_cache_lock = asyncio.Lock()
GEMINI_CACHE_TTL_SECONDS = 4 * 60 * 60  # 4 hours

# CoinGecko symbol to coin ID mapping for crypto
COINGECKO_SYMBOL_MAP = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "ZEC": "zcash",
    "XRP": "ripple",
    "DOGE": "dogecoin",
    "ADA": "cardano",
    "BCH": "bitcoin-cash",
    "AVAX": "avalanche-2",
    "DOT": "polkadot",
    "LINK": "chainlink",
    "MATIC": "matic-network",
    "UNI": "uniswap",
    "LTC": "litecoin",
    "XLM": "stellar",
    "HBAR": "hedera",
    "ATOM": "cosmos",
    "ARB": "arbitrum",
    "OP": "optimism",
    "APT": "aptos",
    "SUI": "sui",
    "KNTQ": "kinetiq",
    "NEAR": "near",
    "FTM": "fantom",
    "INJ": "injective-protocol",
    "SEI": "sei-network",
    "TIA": "celestia",
    "HYPE": "hyperliquid",
    "PEPE": "pepe",
    "WIF": "dogwifhat",
    "BONK": "bonk",
    "SHIB": "shiba-inu",
    "RENDER": "render-token",
    "FET": "fetch-ai",
    "TAO": "bittensor",
    "RNDR": "render-token",
    "JUP": "jupiter-exchange-solana",
    "JTO": "jito-governance-token",
    "STX": "blockstack",
    "IMX": "immutable-x",
    "AAVE": "aave",
    "XPL": "plasma",
    "VIRTUAL": "virtual-protocol",
    "MKR": "maker",
    "CRV": "curve-dao-token",
    "LDO": "lido-dao",
    "RUNE": "thorchain",
    "PENDLE": "pendle",
    "ENA": "ethena",
    "MON": "monad",
    "WLD": "worldcoin",
    "ONDO": "ondo-finance",
    "PYTH": "pyth-network",
    "JTO": "jito-governance-token",
    "W": "wormhole",
    "ZRO": "layerzero",
    "VVV": "venice-token",
    "PUMP": "pump-fun",
    "MEGA": "megaeth",
    "PONS": "pons",
    "ASTER": "aster-2",
    "EIGEN": "eigenlayer",
    "STRK": "starknet",
    "ZK": "zksync",
    "BLUR": "blur",
    "ENS": "ethereum-name-service",
    "GMX": "gmx",
    "GALA": "gala",
    "AXL": "axelar",
    "SNX": "havven",
    "GRT": "the-graph",
    "SAND": "the-sandbox",
    "MANA": "decentraland",
    "LIT": "lighter",
    "WLFI": "world-liberty-financial",
    "TRX": "tron",
    "GRAM": "telegram",
}


async def fetch_crypto_live_context(symbol: str) -> str:
    """
    Fetch live crypto market data from CoinGecko (free tier).
    Returns a formatted string with real data for Grok to use.
    """
    try:
        coin_id = COINGECKO_SYMBOL_MAP.get(symbol.upper(), symbol.lower())
        url = f"https://api.coingecko.com/api/v3/coins/{coin_id}"
        params = {
            "tickers": "false",
            "market_data": "true",
            "community_data": "false",
            "developer_data": "false",
            "sparkline": "false",
        }
        
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, timeout=10.0)
            if response.status_code != 200:
                logger.warning(f"CoinGecko API error for {symbol}: {response.status_code}")
                return f"Live data fetch failed for {symbol}. Use general knowledge cautiously."
            
            data = response.json()
            market_data = data.get("market_data", {})
            
            price = market_data.get("current_price", {}).get("usd", "N/A")
            price_change_24h = market_data.get("price_change_percentage_24h", "N/A")
            price_change_7d = market_data.get("price_change_percentage_7d", "N/A")
            market_cap = market_data.get("market_cap", {}).get("usd", "N/A")
            volume_24h = market_data.get("total_volume", {}).get("usd", "N/A")
            ath = market_data.get("ath", {}).get("usd", "N/A")
            ath_change = market_data.get("ath_change_percentage", {}).get("usd", "N/A")
            circulating_supply = market_data.get("circulating_supply", "N/A")
            total_supply = market_data.get("total_supply", "N/A")
            
            # Format large numbers
            def fmt_num(n):
                if n == "N/A" or n is None:
                    return "N/A"
                if isinstance(n, (int, float)):
                    if n >= 1_000_000_000:
                        return f"${n/1_000_000_000:.2f}B"
                    elif n >= 1_000_000:
                        return f"${n/1_000_000:.2f}M"
                    elif n >= 1000:
                        return f"${n:,.2f}"
                    else:
                        return f"${n:.4f}" if n < 1 else f"${n:.2f}"
                return str(n)
            
            def fmt_pct(n):
                if n == "N/A" or n is None:
                    return "N/A"
                return f"{n:+.2f}%" if isinstance(n, (int, float)) else str(n)
            
            # Format supply numbers
            circ_supply_str = f"{circulating_supply:,.0f}" if isinstance(circulating_supply, (int, float)) else str(circulating_supply)
            total_supply_str = f"{total_supply:,.0f}" if isinstance(total_supply, (int, float)) else str(total_supply)
            
            context = f"""LIVE MARKET DATA (Source: CoinGecko, fetched just now):
- Current Price: {fmt_num(price)}
- 24h Change: {fmt_pct(price_change_24h)}
- 7d Change: {fmt_pct(price_change_7d)}
- Market Cap: {fmt_num(market_cap)}
- 24h Volume: {fmt_num(volume_24h)}
- All-Time High: {fmt_num(ath)} ({fmt_pct(ath_change)} from ATH)
- Circulating Supply: {circ_supply_str}
- Total Supply: {total_supply_str}"""
            
            return context
            
    except Exception as e:
        logger.warning(f"Failed to fetch crypto context for {symbol}: {e}")
        return f"Live data fetch failed for {symbol}. Use general knowledge cautiously."


def fetch_stock_live_context_sync(symbol: str) -> str:
    """
    Fetch live stock data from Yahoo Finance via yfinance (synchronous).
    Returns a formatted string with real data for Grok to use.
    """
    try:
        ticker = yf.Ticker(symbol)
        
        # Get fast info (price, etc.)
        info = ticker.info
        
        # Get recent news
        try:
            news = ticker.news[:5] if hasattr(ticker, 'news') else []
            news_summary = "; ".join([n.get('title', '') for n in news if n.get('title')])[:500]
        except Exception:
            news_summary = "News fetch failed"
        
        # Extract key data
        price = info.get("currentPrice") or info.get("regularMarketPrice", "N/A")
        prev_close = info.get("previousClose", "N/A")
        open_price = info.get("open") or info.get("regularMarketOpen", "N/A")
        day_high = info.get("dayHigh") or info.get("regularMarketDayHigh", "N/A")
        day_low = info.get("dayLow") or info.get("regularMarketDayLow", "N/A")
        volume = info.get("volume") or info.get("regularMarketVolume", "N/A")
        avg_volume = info.get("averageVolume", "N/A")
        market_cap = info.get("marketCap", "N/A")
        pe_ratio = info.get("trailingPE", "N/A")
        forward_pe = info.get("forwardPE", "N/A")
        fifty_two_week_high = info.get("fiftyTwoWeekHigh", "N/A")
        fifty_two_week_low = info.get("fiftyTwoWeekLow", "N/A")
        short_ratio = info.get("shortRatio", "N/A")
        short_percent = info.get("shortPercentOfFloat", "N/A")
        beta = info.get("beta", "N/A")
        
        # Calculate price change
        price_change = "N/A"
        price_change_pct = "N/A"
        if isinstance(price, (int, float)) and isinstance(prev_close, (int, float)) and prev_close > 0:
            change = price - prev_close
            change_pct = (change / prev_close) * 100
            price_change = f"{'+' if change >= 0 else ''}{change:.2f}"
            price_change_pct = f"{'+' if change_pct >= 0 else ''}{change_pct:.2f}%"
        
        def fmt_num(n, prefix="$"):
            if n == "N/A" or n is None:
                return "N/A"
            if isinstance(n, (int, float)):
                if n >= 1_000_000_000_000:
                    return f"{prefix}{n/1_000_000_000_000:.2f}T"
                elif n >= 1_000_000_000:
                    return f"{prefix}{n/1_000_000_000:.2f}B"
                elif n >= 1_000_000:
                    return f"{prefix}{n/1_000_000:.2f}M"
                elif n >= 1000:
                    return f"{prefix}{n:,.2f}"
                else:
                    return f"{prefix}{n:.2f}"
            return str(n)
        
        def fmt_ratio(n):
            if n == "N/A" or n is None:
                return "N/A"
            return f"{n:.2f}" if isinstance(n, (int, float)) else str(n)
        
        def fmt_pct(n):
            if n == "N/A" or n is None:
                return "N/A"
            if isinstance(n, (int, float)):
                return f"{n*100:.2f}%" if n < 1 else f"{n:.2f}%"
            return str(n)
        
        context = f"""LIVE MARKET DATA (Source: Yahoo Finance, fetched just now):
- Current Price: {fmt_num(price)}
- Daily Change: {price_change} ({price_change_pct})
- Previous Close: {fmt_num(prev_close)}
- Open: {fmt_num(open_price)}
- Day Range: {fmt_num(day_low)} - {fmt_num(day_high)}
- Volume: {fmt_num(volume, '')} (Avg: {fmt_num(avg_volume, '')})
- Market Cap: {fmt_num(market_cap)}
- P/E Ratio (TTM): {fmt_ratio(pe_ratio)}
- Forward P/E: {fmt_ratio(forward_pe)}
- 52-Week Range: {fmt_num(fifty_two_week_low)} - {fmt_num(fifty_two_week_high)}
- Beta: {fmt_ratio(beta)}
- Short Ratio: {fmt_ratio(short_ratio)}
- Short % of Float: {fmt_pct(short_percent)}

RECENT NEWS HEADLINES: {news_summary if news_summary else 'No recent news available'}"""
        
        return context
        
    except Exception as e:
        logger.warning(f"Failed to fetch stock context for {symbol}: {e}")
        return f"Live data fetch failed for {symbol}. Use general knowledge cautiously."


async def fetch_stock_live_context(symbol: str) -> str:
    """Async wrapper for the synchronous yfinance fetch."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fetch_stock_live_context_sync, symbol)


# Builder configuration  (HL unit: tenths of a basis point)
# 1 tenth = 0.1 bps = 0.001 % = ×0.00001 decimal
# Defaults = HyperTrade reference builder. Forks that want their own fees must
# set BUILDER_ADDRESS / BUILDER_FEE (or replace these defaults). See docs/FORKING.md.
BUILDER_ADDRESS = (
    os.getenv("BUILDER_ADDRESS", "0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB").strip()
    or "0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB"
)
BUILDER_FEE = int(os.getenv("BUILDER_FEE", "30") or "30")  # 30 tenths = 3 bps = 0.03 %

# Bridge2 (Arbitrum) configuration for gasless deposits (permit + relayer)
ARBITRUM_USDC_ADDRESS = os.getenv("ARBITRUM_USDC_ADDRESS", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")
BRIDGE2_ADDRESS = os.getenv("HL_BRIDGE2_ADDRESS", "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7")
BRIDGE2_MIN_DEPOSIT_USDC = 5  # per HL docs
ARBITRUM_CHAIN_ID = 42161  # Required chain ID for all operations

# EIP-712 domain for gasless USDC external transfers (must match frontend
# `walletTransferIntent.ts`).
WALLET_TRANSFER_INTENT_DOMAIN_NAME = "HyperTrade Wallet Transfer"
WALLET_TRANSFER_INTENT_DOMAIN_VERSION = "1"
WALLET_TRANSFER_INTENT_VERIFYING_CONTRACT = "0x0000000000000000000000000000000000000000"

# ---------------------------------------------------------------------------
# Arbitrum RPC configuration — primary + optional fallbacks.
# Set ARBITRUM_RPC_URL to your dedicated provider; optionally provide a
# comma-separated ARBITRUM_RPC_URL_FALLBACKS. Public arb1 is appended as a
# last-ditch safety net so a provider outage doesn't freeze deposits.
# ---------------------------------------------------------------------------
ARBITRUM_RPC_URL = os.getenv("ARBITRUM_RPC_URL") or os.getenv("EXPO_PUBLIC_ARBITRUM_RPC_URL")


def _load_arbitrum_rpc_urls() -> List[str]:
    urls: List[str] = []
    if ARBITRUM_RPC_URL:
        urls.append(ARBITRUM_RPC_URL)
    raw_fallbacks = os.getenv("ARBITRUM_RPC_URL_FALLBACKS") or ""
    for u in raw_fallbacks.split(","):
        u = u.strip()
        if u and u not in urls:
            urls.append(u)
    public_fallback = "https://arb1.arbitrum.io/rpc"
    if public_fallback not in urls:
        urls.append(public_fallback)
    return urls


_ARBITRUM_RPC_URLS: List[str] = _load_arbitrum_rpc_urls()


def _redact_rpc(url: str) -> str:
    """Strip query-string (API keys) from RPC URL for safe logging."""
    try:
        return url.split("?", 1)[0]
    except Exception:
        return "<rpc>"


def _make_web3() -> "Web3":
    """Construct a Web3 client, falling back across configured RPC URLs.

    Validates chain ID on construction so a misconfigured RPC can never
    quietly point the relayer at the wrong network.
    """
    if not _ARBITRUM_RPC_URLS:
        raise RuntimeError("ARBITRUM_RPC_URL not configured")
    last_exc: Optional[Exception] = None
    for url in _ARBITRUM_RPC_URLS:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 15}))
            cid = w3.eth.chain_id
            if cid != ARBITRUM_CHAIN_ID:
                raise RuntimeError(
                    f"Invalid chain ID from RPC {_redact_rpc(url)}: got {cid}, expected {ARBITRUM_CHAIN_ID}"
                )
            return w3
        except Exception as exc:
            last_exc = exc
            logger.warning("Arbitrum RPC %s unavailable: %s", _redact_rpc(url), exc)
            continue
    raise RuntimeError(f"No Arbitrum RPC reachable: {last_exc}")


# ---------------------------------------------------------------------------
# Relayer pool — one or more private keys. Users are deterministically mapped
# to a single relayer via SHA-256(user_address) so every replica agrees on
# the assignment without any shared state.
# ---------------------------------------------------------------------------

def _load_relayer_keys() -> List[str]:
    raw = (
        os.getenv("BRIDGE2_RELAYER_PRIVATE_KEYS")
        or os.getenv("BRIDGE2_RELAYER_PRIVATE_KEY")
        or os.getenv("RELAYER_PRIVATE_KEY")
        or ""
    )
    keys: List[str] = []
    seen: set = set()
    for k in raw.split(","):
        k = k.strip()
        if not k:
            continue
        norm = k.lower()
        if norm in seen:
            continue
        seen.add(norm)
        keys.append(k)
    return keys


_RELAYER_PRIVATE_KEYS: List[str] = _load_relayer_keys()

# Precompute addresses once at startup. Fail fast on invalid keys — better a
# hard crash at boot than silently serving a broken relayer to real users.
_RELAYER_ADDRESSES: List[str] = []
_RELAYER_KEY_BY_ADDRESS: Dict[str, str] = {}
if _RELAYER_PRIVATE_KEYS:
    from eth_account import Account as _RelayerAccount
    for _k in _RELAYER_PRIVATE_KEYS:
        try:
            _addr = Web3.to_checksum_address(_RelayerAccount.from_key(_k).address)
        except Exception as _e:
            raise RuntimeError(f"Invalid relayer private key in config: {_e}")
        if _addr in _RELAYER_KEY_BY_ADDRESS:
            logger.warning("Duplicate relayer address %s in pool — ignoring duplicate key", _addr)
            continue
        _RELAYER_ADDRESSES.append(_addr)
        _RELAYER_KEY_BY_ADDRESS[_addr] = _k
    logger.info("Relayer pool initialised with %d address(es): %s",
                len(_RELAYER_ADDRESSES), ", ".join(_RELAYER_ADDRESSES))
else:
    logger.warning("No relayer private keys configured — gasless endpoints will be disabled")

# Back-compat alias: legacy references still work in any code path not yet
# migrated. Always points at the first key in the pool.
BRIDGE2_RELAYER_PRIVATE_KEY: Optional[str] = _RELAYER_PRIVATE_KEYS[0] if _RELAYER_PRIVATE_KEYS else None


def select_relayer_for_user(user_address: str) -> Tuple[str, str]:
    """Deterministically assign a relayer (address, private_key) to a user.

    Uses SHA-256 of the lowercased checksum address so all replicas agree
    regardless of Python's per-process hash randomisation.
    """
    if not _RELAYER_ADDRESSES:
        raise RuntimeError("No relayer private keys configured")
    if not Web3.is_address(user_address):
        raise ValueError("Invalid user address")
    import hashlib as _hashlib
    addr = Web3.to_checksum_address(user_address)
    digest = _hashlib.sha256(addr.lower().encode("utf-8")).digest()
    idx = int.from_bytes(digest[:8], "big") % len(_RELAYER_ADDRESSES)
    relayer_addr = _RELAYER_ADDRESSES[idx]
    return relayer_addr, _RELAYER_KEY_BY_ADDRESS[relayer_addr]


import time

# Unique identifier for this server replica (used for distributed locks)
_REPLICA_ID = uuid.uuid4().hex

# Rate limiting for wallet transfers (anti-griefing)
TRANSFER_RATE_LIMIT_MAX = 10  # Max transfers per window
TRANSFER_RATE_LIMIT_WINDOW_SECONDS = 86400  # 24 hours
TRANSFER_MIN_AMOUNT_USDC = 5  # Minimum transfer amount (matches deposit minimum)

# ---------------------------------------------------------------------------
# Per-relayer distributed lock via Supabase. Each relayer address gets its
# own lock row keyed by `relayer:<address_lowercase>` so two replicas can
# send txs for DIFFERENT relayers in parallel, while txs for the SAME
# relayer still serialise (required for sequential Arbitrum nonces).
# The lock auto-expires after 60s so a crashed replica cannot stall things.
# ---------------------------------------------------------------------------

def _relayer_lock_key(relayer_address: str) -> str:
    return f"relayer:{relayer_address.lower()}"


def _acquire_relayer_lock_for(relayer_address: str, timeout_seconds: float = 20.0) -> bool:
    if not supabase:
        return True  # dev mode without DB — allow through
    key = _relayer_lock_key(relayer_address)
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            res = supabase.rpc("acquire_relayer_lock_v2", {
                "p_lock_id": key,
                "p_holder_id": _REPLICA_ID,
                "p_ttl_seconds": 60,
            }).execute()
            if res.data is True:
                return True
        except Exception as exc:
            logger.warning("relayer lock(%s) acquire attempt error: %s", key, exc)
        time.sleep(0.4)
    logger.error("Failed to acquire relayer lock %s within %ss", key, timeout_seconds)
    return False


def _release_relayer_lock_for(relayer_address: str) -> None:
    if not supabase:
        return
    key = _relayer_lock_key(relayer_address)
    try:
        supabase.rpc("release_relayer_lock_v2", {
            "p_lock_id": key,
            "p_holder_id": _REPLICA_ID,
        }).execute()
    except Exception as exc:
        logger.warning("relayer lock(%s) release error (will auto-expire): %s", key, exc)


class _NonceTooLowError(Exception):
    """Raised when relayer nonce is behind the chain's pending nonce."""
    pass


# ---------------------------------------------------------------------------
# Demo trading mode (Hyperliquid testnet) — one-shot $100 USDC grant per user.
#
# Flow: user taps "Claim demo USDC" in the app → backend builds an HL testnet
# `usdSend` action signed with the master account's API wallet (agent) → the
# user's same EOA address now has $100 on testnet. They flip the
# tradingEnv toggle and trade against testnet liquidity, no real funds at risk.
#
# The master account itself is a wallet you control off-chain (you faucet it
# manually). The backend never sees the master's L1 private key — only the
# agent key, which can `usdSend` and place orders but cannot withdraw to L1
# via Bridge2 (HL agents are scope-limited by design). Worst case if the
# agent key leaks: someone drains testnet USDC. No real funds.
#
# Replica safety:
#   • Per-user one-shot enforced atomically by `demo_funding` UNIQUE PK.
#   • Concurrent claims serialised on the master agent via the same Supabase
#     `relayer_lock` table (lock id `demo_master:hl_testnet`) so two replicas
#     never sign two `usdSend` actions in the same ms (would collide on the
#     monotonic-nonce check inside HL).
#   • Stuck `pending` rows older than 2min are swept by the
#     `_demo_claim_cleanup_loop` background task, which runs only on the
#     replica that holds the `demo_claim_cleanup` leadership lease.
# ---------------------------------------------------------------------------

# Mainnet HL signing-domain chainId is the same value (`0x66eee` = 421614, the
# Arbitrum Sepolia chainId) on testnet exchange actions per HL docs and
# verified against @nktkas/hyperliquid esm/api/exchange/_methods/usdSend.js.
HL_TESTNET_API_URL = os.getenv("HL_TESTNET_API_URL", "https://api.hyperliquid-testnet.xyz")
HL_TESTNET_SIGNATURE_CHAIN_ID = os.getenv("HL_TESTNET_SIGNATURE_CHAIN_ID", "0x66eee")
HL_TESTNET_MASTER_ADDRESS: Optional[str] = os.getenv("HL_TESTNET_MASTER_ADDRESS") or None
# Master account L1 private key. Required for demo mode because HL Core USDC
# transfers (`usdSend`) are USER-SIGNED actions — agents/API wallets are
# explicitly NOT permitted to sign them per HL design (verified empirically:
# agent-signed usdSend returns "Insufficient balance for withdrawal" because
# HL routes the debit to the agent, not the master). The agent key is now
# unused for /demo/* but kept supported in case we need it for L1-action
# flows later (orders/cancels signed on behalf of the master).
HL_TESTNET_MASTER_PK: Optional[str] = os.getenv("HL_TESTNET_MASTER_PK") or None
HL_TESTNET_MASTER_AGENT_PK: Optional[str] = os.getenv("HL_TESTNET_MASTER_AGENT_PK") or None

try:
    # The advertised grant the user sees in the UI. NET amount that lands in
    # their HL testnet account after HL's transfer fee.
    DEMO_GRANT_AMOUNT_USDC = float(os.getenv("DEMO_GRANT_AMOUNT_USDC", "100"))
except Exception:
    DEMO_GRANT_AMOUNT_USDC = 100.0

try:
    # HL charges a flat $1 fee on Core USDC transfers. We gross up the on-the-
    # wire amount so the recipient nets the advertised grant. Make this
    # configurable so we can adapt without a redeploy if HL changes the fee.
    DEMO_TRANSFER_FEE_USDC = float(os.getenv("DEMO_TRANSFER_FEE_USDC", "1"))
except Exception:
    DEMO_TRANSFER_FEE_USDC = 1.0

# Lock id used in the relayer_lock table for the demo master account. Single
# string because we run with exactly one master account in v1; multi-master
# fan-out (à la `select_relayer_for_user`) is a Phase 1.5 expansion.
DEMO_MASTER_LOCK_ID = "demo_master:hl_testnet"

# Cached addresses derived from the keys at boot. Failing fast here is
# better than failing inside a request hours after deploy.
_DEMO_MASTER_DERIVED_ADDRESS: Optional[str] = None
_DEMO_MASTER_AGENT_ADDRESS: Optional[str] = None

if HL_TESTNET_MASTER_PK:
    try:
        from eth_account import Account as _DemoAcct
        _DEMO_MASTER_DERIVED_ADDRESS = _DemoAcct.from_key(HL_TESTNET_MASTER_PK).address
    except Exception as _e:
        raise RuntimeError(f"Invalid HL_TESTNET_MASTER_PK: {_e}")
    # If both env vars are set, sanity-check they refer to the same account.
    # Catches a copy-paste mistake (e.g. wrong PK pasted under the right
    # address label) before we burn nonces signing for the wrong account.
    if HL_TESTNET_MASTER_ADDRESS and HL_TESTNET_MASTER_ADDRESS.lower() != _DEMO_MASTER_DERIVED_ADDRESS.lower():
        raise RuntimeError(
            "HL_TESTNET_MASTER_PK derives address %s but HL_TESTNET_MASTER_ADDRESS=%s — "
            "config mismatch, refusing to start." % (
                _DEMO_MASTER_DERIVED_ADDRESS, HL_TESTNET_MASTER_ADDRESS
            )
        )
    if not HL_TESTNET_MASTER_ADDRESS:
        HL_TESTNET_MASTER_ADDRESS = _DEMO_MASTER_DERIVED_ADDRESS

if HL_TESTNET_MASTER_AGENT_PK:
    try:
        from eth_account import Account as _DemoAcct
        _DEMO_MASTER_AGENT_ADDRESS = _DemoAcct.from_key(HL_TESTNET_MASTER_AGENT_PK).address
    except Exception as _e:
        raise RuntimeError(f"Invalid HL_TESTNET_MASTER_AGENT_PK: {_e}")

if HL_TESTNET_MASTER_PK:
    logger.info(
        "Demo mode: HL testnet master=%s, agent=%s, grant=$%.2f, fee=$%.2f, wire=$%.2f",
        HL_TESTNET_MASTER_ADDRESS,
        _DEMO_MASTER_AGENT_ADDRESS or "(unused)",
        DEMO_GRANT_AMOUNT_USDC,
        DEMO_TRANSFER_FEE_USDC,
        DEMO_GRANT_AMOUNT_USDC + DEMO_TRANSFER_FEE_USDC,
    )
else:
    logger.warning(
        "Demo mode disabled: HL_TESTNET_MASTER_PK not configured. "
        "/demo/* endpoints will return 503."
    )


def demo_mode_enabled() -> bool:
    """Cheap config check — gate /demo/* endpoints behind it so a half-configured
    deploy doesn't try to send testnet USDC with a missing key."""
    return bool(HL_TESTNET_MASTER_PK and HL_TESTNET_MASTER_ADDRESS and supabase)


def _acquire_demo_master_lock(timeout_seconds: float = 20.0) -> bool:
    """Acquire the singleton master-agent lock. Reuses the same Supabase
    primitive (acquire_relayer_lock_v2) as the Bridge2/permit relayer pool —
    only the lock id namespace differs (`demo_master:*` vs `relayer:*`), so
    two replicas signing concurrently still serialise on the master agent
    nonce."""
    if not supabase:
        return True
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            res = supabase.rpc("acquire_relayer_lock_v2", {
                "p_lock_id": DEMO_MASTER_LOCK_ID,
                "p_holder_id": _REPLICA_ID,
                "p_ttl_seconds": 60,
            }).execute()
            if res.data is True:
                return True
        except Exception as exc:
            logger.warning("demo master lock acquire attempt error: %s", exc)
        time.sleep(0.4)
    logger.error("Failed to acquire demo master lock within %ss", timeout_seconds)
    return False


def _release_demo_master_lock() -> None:
    if not supabase:
        return
    try:
        supabase.rpc("release_relayer_lock_v2", {
            "p_lock_id": DEMO_MASTER_LOCK_ID,
            "p_holder_id": _REPLICA_ID,
        }).execute()
    except Exception as exc:
        logger.warning("demo master lock release error (will auto-expire): %s", exc)


def _hl_testnet_usd_send(destination: str, amount_usdc: float) -> str:
    """Build, sign, and submit an HL testnet `usdSend` exchange action from
    the master account to `destination`.

    IMPORTANT: HL Core USDC transfers (`usdSend`) are USER-SIGNED actions.
    Per the HL design (verified empirically and against the docs), API wallets
    / agents CANNOT sign these — only L1 actions like orders/cancels. So this
    function signs with HL_TESTNET_MASTER_PK directly. The agent PK is now
    irrelevant to demo claims.

    The `amount_usdc` arg is the GROSS amount that will be debited from the
    master (recipient gets gross − HL fee). The caller is responsible for
    grossing up so the recipient nets the advertised grant.

    Returns an audit identifier (timestamp-based string) — HL's exchange
    response for `usdSend` doesn't include a tx hash since the transfer is
    a pure off-chain L2 action.

    Mirrors the EIP-712 shape produced by @nktkas/hyperliquid:
      - domain: HyperliquidSignTransaction v1, chainId=int(signatureChainId),
        verifyingContract=0x0
      - primaryType: HyperliquidTransaction:UsdSend
      - fields: hyperliquidChain, destination, amount, time
    See @nktkas/hyperliquid esm/signing/mod.js → signUserSignedAction()
    and esm/api/exchange/_methods/usdSend.js for the canonical reference.
    """
    if not HL_TESTNET_MASTER_PK:
        raise RuntimeError("HL_TESTNET_MASTER_PK not configured")
    if not Web3.is_address(destination):
        raise ValueError(f"Invalid destination address: {destination}")

    from eth_account import Account

    # HL's API schema lowercases all addresses before hashing the action
    # (see @nktkas/hyperliquid esm/api/_schemas.js → Address → toLowerCase
    # transform). We must do the same here or the signature won't match
    # what HL re-derives server-side.
    dest_lower = destination.lower()
    if not dest_lower.startswith("0x"):
        dest_lower = "0x" + dest_lower
    # HL expects amount as a string with `1` = $1, max 6 decimal places
    # (USDC precision). Trim trailing zeros so signed payload matches what
    # the SDK would have produced byte-for-byte.
    amount_str = f"{amount_usdc:.6f}".rstrip("0").rstrip(".")
    if not amount_str or amount_str == "0":
        raise ValueError(f"Invalid amount: {amount_usdc}")

    # Single ms-precision timestamp used as both the EIP-712 `time` field
    # AND the request `nonce`. They MUST be equal — HL re-derives the action
    # hash from the action body, so a mismatch fails signature verification.
    nonce_ms = int(time.time() * 1000)

    # Schema lowercases hex strings (see @nktkas/hyperliquid esm/api/_schemas.js
    # → Hex). We mirror that to keep the signed bytes byte-identical to what
    # the JS SDK would produce for the same logical input.
    sig_chain_id_lower = HL_TESTNET_SIGNATURE_CHAIN_ID.lower()
    chain_id_int = int(sig_chain_id_lower, 16)

    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "HyperliquidTransaction:UsdSend": [
                {"name": "hyperliquidChain", "type": "string"},
                {"name": "destination", "type": "string"},
                {"name": "amount", "type": "string"},
                {"name": "time", "type": "uint64"},
            ],
        },
        "primaryType": "HyperliquidTransaction:UsdSend",
        "domain": {
            "name": "HyperliquidSignTransaction",
            "version": "1",
            "chainId": chain_id_int,
            "verifyingContract": "0x0000000000000000000000000000000000000000",
        },
        "message": {
            "hyperliquidChain": "Testnet",
            "destination": dest_lower,
            "amount": amount_str,
            "time": nonce_ms,
        },
    }

    # Account.sign_typed_data is the one-shot form of
    # encode_typed_data + sign_message. Same output, fewer imports.
    # CRITICAL: signed by the MASTER PK, not the agent — HL agents cannot
    # sign user-signed actions (usdSend / withdraw3 / usdClassTransfer).
    signed = Account.sign_typed_data(HL_TESTNET_MASTER_PK, full_message=typed_data)

    # HL trims leading zeros from r/s per @nktkas/hyperliquid trimSignature(),
    # but only for multi-sig payloads. For single-wallet user-signed actions
    # the SDK passes the raw hex through, so we do the same — full 32-byte
    # padded hex is what HL's verifier expects on the single-sig path.
    sig = {
        "r": "0x" + signed.r.to_bytes(32, "big").hex(),
        "s": "0x" + signed.s.to_bytes(32, "big").hex(),
        "v": int(signed.v),
    }

    action = {
        "type": "usdSend",
        "signatureChainId": sig_chain_id_lower,
        "hyperliquidChain": "Testnet",
        "destination": dest_lower,
        "amount": amount_str,
        "time": nonce_ms,
    }

    body = {"action": action, "signature": sig, "nonce": nonce_ms}

    # We hit /exchange directly via httpx rather than wiring up a full HL
    # SDK in Python — the Python `hyperliquid-python-sdk` works fine but
    # adds another async dependency for a single endpoint.
    import httpx
    url = f"{HL_TESTNET_API_URL.rstrip('/')}/exchange"
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(url, json=body, headers={"Content-Type": "application/json"})
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(f"HL testnet returned non-JSON: HTTP {resp.status_code} {resp.text[:200]}")

    if resp.status_code >= 400:
        raise RuntimeError(f"HL testnet HTTP {resp.status_code}: {data}")

    # HL response shape on success: {"status":"ok","response":{"type":"default"}}
    # On failure: {"status":"err","response":"<reason>"} — same envelope as
    # the SDK's executeUserSignedAction expects.
    status = data.get("status")
    if status != "ok":
        raise RuntimeError(f"HL testnet usdSend failed: {data}")

    logger.info(
        "[demo] usdSend ok: master=%s → dest=%s amount=$%s nonce=%s",
        HL_TESTNET_MASTER_ADDRESS,
        Web3.to_checksum_address(dest_lower),
        amount_str,
        nonce_ms,
    )
    # We return the nonce as the audit id since HL doesn't return a tx hash
    # for off-chain L2 actions. Stored in `tx_hash` column for compatibility.
    return f"hl-testnet-usdsend:{nonce_ms}"


# --------------------------------------------------------------------------- #
# Privy JWT Authentication
# --------------------------------------------------------------------------- #
PRIVY_APP_ID = os.getenv("PRIVY_APP_ID", "").strip()
PRIVY_JWKS_URL = (
    f"https://auth.privy.io/api/v1/apps/{PRIVY_APP_ID}/jwks.json" if PRIVY_APP_ID else ""
)

# Cache for JWKS client (thread-safe, caches keys automatically)
_privy_jwks_client: Optional[PyJWKClient] = None


def _get_privy_jwks_client() -> PyJWKClient:
    """Get or create the Privy JWKS client with caching."""
    global _privy_jwks_client
    if _privy_jwks_client is None:
        _privy_jwks_client = PyJWKClient(PRIVY_JWKS_URL, cache_keys=True, lifespan=3600)
    return _privy_jwks_client


# Security scheme for Swagger UI
_bearer_scheme = HTTPBearer(auto_error=False)


class PrivyAuthUser(BaseModel):
    """Authenticated user info from Privy JWT."""
    user_id: str  # Privy DID (e.g., "did:privy:abc123")
    session_id: str
    app_id: str


async def verify_privy_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> PrivyAuthUser:
    """
    FastAPI dependency to verify Privy access tokens.
    
    Extracts the Bearer token from the Authorization header, verifies it
    against Privy's JWKS endpoint, and returns the authenticated user info.
    """
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Missing authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not PRIVY_APP_ID:
        raise HTTPException(
            status_code=503,
            detail="PRIVY_APP_ID is not configured on the server",
        )
    
    token = credentials.credentials
    
    try:
        # Get the signing key from JWKS
        jwks_client = _get_privy_jwks_client()
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        
        # Verify and decode the token
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            issuer="privy.io",
            audience=PRIVY_APP_ID,
            options={
                "verify_exp": True,
                "verify_iat": True,
                "require": ["sub", "iss", "aud", "exp", "iat", "sid"],
            },
        )
        
        return PrivyAuthUser(
            user_id=payload["sub"],
            session_id=payload["sid"],
            app_id=payload["aud"],
        )
        
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid Privy token: {e}")
        raise HTTPException(
            status_code=401,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except Exception as e:
        logger.exception("Unexpected error verifying Privy token")
        raise HTTPException(
            status_code=401,
            detail="Authentication failed",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _is_nonce_too_low(err: Exception) -> bool:
    msg = ""
    if isinstance(err, ValueError) and err.args:
        arg0 = err.args[0]
        if isinstance(arg0, dict):
            msg = str(arg0.get("message", ""))
        else:
            msg = str(arg0)
    else:
        msg = str(err)
    return "nonce too low" in msg.lower()

# Create the main app without a prefix
app = FastAPI(title="Hypertrade API", version="1.0.0")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# HTTP client for Hyperliquid
http_client: Optional[httpx.AsyncClient] = None

# HIP-3 venues we fetch/subscribe (catalog tickers are still ASSET_METADATA).
# Override with HIP3_ENABLED_DEXES=xyz or xyz,io — never dump every perpDexs name.
HIP3_DEXES = enabled_hip3_dexes()

# Display/base symbol → Hyperliquid HIP-3 perp name for candleSnapshot (HL UI may differ from our keys).
# 2026-07-22: tradeXYZ listed SKHY (Nasdaq ADS). Old SKHX bookmarks/charts
# resolve to the live coin so leftover links don't 500.
HL_CANDLE_SYMBOL_ALIASES: Dict[str, str] = {
    "SKHX": "SKHY",
}


def _resolve_hl_candle_coin(coin: str) -> str:
    """Map `{dex}:{DISPLAY}` to `{dex}:{HL_NAME}` when the listing uses a different perp symbol."""
    if not coin or ":" not in coin:
        return coin
    dex, base = split_hip3_coin(coin)
    mapped = HL_CANDLE_SYMBOL_ALIASES.get(base.upper())
    hl_base = mapped or base
    return f"{dex}:{hl_base}"


# Asset display names and metadata
ASSET_METADATA = {
    "TSLA": {"name": "Tesla", "symbol": "TSLA", "category": "stock", "icon": "🚗"},
    "NVDA": {"name": "Nvidia", "symbol": "NVDA", "category": "stock", "icon": "💻"},
    "AAPL": {"name": "Apple", "symbol": "AAPL", "category": "stock", "icon": "🍎"},
    "GOOGL": {"name": "Google", "symbol": "GOOGL", "category": "stock", "icon": "🔍"},
    "AMZN": {"name": "Amazon", "symbol": "AMZN", "category": "stock", "icon": "📦"},
    "MSFT": {"name": "Microsoft", "symbol": "MSFT", "category": "stock", "icon": "🖥️"},
    "META": {"name": "Meta", "symbol": "META", "category": "stock", "icon": "👤"},
    "INTC": {"name": "Intel", "symbol": "INTC", "category": "stock", "icon": "💻"},
    "AMD": {"name": "AMD", "symbol": "AMD", "category": "stock", "icon": "💻"},
    "COIN": {"name": "Coinbase", "symbol": "COIN", "category": "stock", "icon": "₿"},
    "HOOD": {"name": "Robinhood", "symbol": "HOOD", "category": "stock", "icon": "🍃"},
    "MSTR": {"name": "Strategy", "symbol": "MSTR", "category": "stock", "icon": "📊"},
    "PURRDAT": {"name": "Purr", "symbol": "PURRDAT", "category": "stock", "icon": "📊"},
    "PLTR": {"name": "Palantir", "symbol": "PLTR", "category": "stock", "icon": "🔮"},
    "ORCL": {"name": "Oracle", "symbol": "ORCL", "category": "stock", "icon": "🔍"},
    "BOT": {"name": "RoboStrategy Inc.", "symbol": "BOT", "category": "stock", "icon": "🤖"},
    # SK Hynix Nasdaq ADS (tradeXYZ SKHY). Each ADS = 1/10 common share (KRX:000660).
    "SKHY": {"name": "SK Hynix", "symbol": "SKHY", "category": "stock", "icon": "💻"},
    "RIVN": {"name": "Rivian", "symbol": "RIVN", "category": "stock", "icon": "🚗"},
    "MU": {"name": "Micron", "symbol": "MU", "category": "stock", "icon": "💻"},
    "BABA": {"name": "Alibaba", "symbol": "BABA", "category": "stock", "icon": "🐘"},
    "SNDK": {"name": "Sandisk", "symbol": "SNDK", "category": "stock", "icon": "💾"},
    # EntropyIO (`io`) pre-IPO — `dex` required so io:SNDK does not collide with xyz:SNDK.
    "ANTH": {
        "name": "Anthropic",
        "symbol": "ANTH",
        "category": "stock",
        "icon": "🤖",
        "isPreIpo": True,
        "dex": "io",
        # EntropyIO pre-IPO spec — https://docs.entropy.io/asset-directory/pre-ipo-assets
        # Operator may revise L/U/OI on the same cadence as other HIP-3 caps.
        "preIpoBoundLow": 300,
        "preIpoBoundHigh": 4200,
        "openInterestCapLabel": "3M",
        "preIpoMcapQuote": True,
    },
    "CRCL": {"name": "Circle", "symbol": "CRCL", "category": "stock", "icon": "🔄"},
    "CRWV": {"name": "CoreWeave", "symbol": "CRWV", "category": "stock", "icon": "☁️"},
    # SpaceX — live Nasdaq equity perp (IPO Jun 2026). Do NOT set isPreIpo.
    "SPCX": {"name": "SpaceX", "symbol": "SPCX", "category": "stock", "icon": "🚀"},
    "CXMT": {"name": "ChangXin Technology", "symbol": "CXMT", "category": "stock", "icon": "💻"},
    # Converted IPOP → STAR A-share perp (SHE: 688836). Do NOT set isPreIpo.
    "UNITREE": {"name": "Unitree Technology", "symbol": "UNITREE", "category": "stock", "icon": "🤖"},
    # Converted IPOP → standard equity perp (no isPreIpo).
    "CBRS": {"name": "Cerebras", "symbol": "CBRS", "category": "stock", "icon": "☁️"},
    "IBM": {"name": "IBM", "symbol": "IBM", "category": "stock", "icon": "💻"},
    "DELL": {"name": "Dell", "symbol": "DELL", "category": "stock", "icon": "💻"},
    "AVGO": {"name": "Broadcom", "symbol": "AVGO", "category": "stock", "icon": "💻"},
    "MRVL": {"name": "Marvell", "symbol": "MRVL", "category": "stock", "icon": "💻"},
    "LLY": {"name": "Eli Lilly", "symbol": "LLY", "category": "stock", "icon": "💊"},
    "GME": {"name": "GameStop", "symbol": "GME", "category": "stock", "icon": "🎮"},
    "NFLX": {"name": "Netflix", "symbol": "NFLX", "category": "stock", "icon": "📺"},
    "TSM": {"name": "TSM", "symbol": "TSM", "category": "stock", "icon": "💻"},
    "LITE": {"name": "Lumentum Holdings", "symbol": "LITE", "category": "stock", "icon": "💡"},
    "MRNA": {"name": "Moderna", "symbol": "MRNA", "category": "stock", "icon": "💉"},
    "SMSN": {"name": "Samsung", "symbol": "SMSN", "category": "stock", "icon": "💻"},
    # Forex pairs - on HIP-3 xyz DEX
    "EUR": {"name": "Euro", "symbol": "EUR", "category": "forex", "icon": "💶"},
    "JPY": {"name": "Japanese Yen", "symbol": "JPY", "category": "forex", "icon": "💴"},
    # Commodities
    "GOLD": {"name": "Gold", "symbol": "GOLD", "category": "commodity", "icon": "🥇"},
    "SILVER": {"name": "Silver", "symbol": "SILVER", "category": "commodity", "icon": "🥈"},
    "PLATINUM": {"name": "Platinum", "symbol": "PLATINUM", "category": "commodity", "icon": "🥇"},
    "PALLADIUM": {"name": "Palladium", "symbol": "PALLADIUM", "category": "commodity", "icon": "🥇"},
    "COPPER": {"name": "Copper", "symbol": "COPPER", "category": "commodity", "icon": "🥉"},
    "CL": {"name": "Crude Oil", "symbol": "OIL", "displayName": "OIL", "category": "commodity", "icon": "🛢️"},
    "BZ": {"name": "Brent Oil", "symbol": "BRENTOIL", "displayName": "BRENTOIL", "category": "commodity", "icon": "🛢️"},
    "NATGAS": {"name": "Natural Gas", "symbol": "NATGAS", "category": "commodity", "icon": "💨"},
    "URNM": {"name": "Uranium", "symbol": "URNM", "category": "commodity", "icon": "💊"},
    "GOLDSPOT": {"name": "Gold Spot", "symbol": "GOLDSPOT", "category": "commodity", "icon": "🥇", "isSpotOnly": True, "hlBaseCoin": "XAUT"},
    # Indices
    "XYZ100": {"name": "Nasdaq 100", "symbol": "XYZ100", "displayName": "NDX100", "category": "index", "icon": "📊"},
    "SP500": {"name": "S&P 500", "symbol": "SP500", "displayName": "SP500", "category": "index", "icon": "📊"},
    "EWY": {"name": "iShares South Korea ETF", "symbol": "EWY", "displayName": "EWY", "category": "index", "icon": "📊"},
    "DRAM": {"name": "Roundhill Memory ETF", "symbol": "DRAM", "displayName": "DRAM", "category": "index", "icon": "💻"},
}

# Forex pairs are now in ASSET_METADATA above
FOREX_METADATA = {k: v for k, v in ASSET_METADATA.items() if v.get("category") == "forex"}
FOREX_COINS = set(FOREX_METADATA.keys())


def _hip3_meta_dex(meta: dict) -> str:
    """Catalog dex for an ASSET_METADATA row. Omitted `dex` means xyz (no io collision)."""
    return str(meta.get("dex") or "xyz").lower()


def _pre_ipo_catalog_fields(meta: dict | None) -> dict:
    """Optional pre-IPO spec fields for API/UI (bounds, OI cap, market-cap quote)."""
    if not meta or not meta.get("isPreIpo"):
        return {}
    out: dict = {}
    lo, hi = meta.get("preIpoBoundLow"), meta.get("preIpoBoundHigh")
    if lo is not None:
        try:
            out["preIpoBoundLow"] = float(lo)
        except (TypeError, ValueError):
            pass
    if hi is not None:
        try:
            out["preIpoBoundHigh"] = float(hi)
        except (TypeError, ValueError):
            pass
    cap = meta.get("openInterestCapLabel")
    if cap:
        out["openInterestCapLabel"] = str(cap)
    if meta.get("preIpoMcapQuote"):
        out["preIpoMcapQuote"] = True
    return out


def _lookup_hip3_metadata(symbol: str, dex_name: str) -> tuple[str | None, dict | None]:
    """Match a universe coin to catalog metadata on this dex only."""
    dex_l = (dex_name or "").lower()
    symbol_u = (symbol or "").upper()
    if not symbol_u:
        return None, None
    for key, meta in ASSET_METADATA.items():
        if _hip3_meta_dex(meta) != dex_l:
            continue
        api_sym = str(meta.get("symbol") or key)
        if api_sym.upper() == symbol_u or str(key).upper() == symbol_u:
            return str(key), meta
    return None, None


def _prefix_catalog_hip3_coin(bare: str) -> str:
    """Bare catalog ticker → `{dex}:{hlSymbol}`. Prefixed coins pass through."""
    raw = (bare or "").strip()
    if not raw:
        return raw
    if ":" in raw:
        return raw
    meta = ASSET_METADATA.get(raw) or ASSET_METADATA.get(raw.upper())
    key = raw
    if meta is None:
        for k, v in ASSET_METADATA.items():
            if v.get("displayName") == raw or v.get("symbol") == raw:
                meta = v
                key = k
                break
    if meta:
        dex = _hip3_meta_dex(meta)
        base = meta.get("symbol") or key
        return f"{dex}:{base}"
    return f"xyz:{raw}"

# Crypto asset metadata
CRYPTO_METADATA = {
    "BTC": {"name": "Bitcoin", "symbol": "BTC", "category": "crypto"},
    "ETH": {"name": "Ethereum", "symbol": "ETH", "category": "crypto"},
    "SOL": {"name": "Solana", "symbol": "SOL", "category": "crypto"},
    "XRP": {"name": "XRP", "symbol": "XRP", "category": "crypto"},
    "ZEC": {"name": "Zcash", "symbol": "ZEC", "category": "crypto"},
    "HYPE": {"name": "Hyperliquid", "symbol": "HYPE", "category": "crypto"},
    "LIT": {"name": "Lighter", "symbol": "LIT", "category": "crypto"},
    "BNB": {"name": "Binance", "symbol": "BNB", "category": "crypto"},
    "LINK": {"name": "Chainlink", "symbol": "LINK", "category": "crypto"},
    "AAVE": {"name": "Aave", "symbol": "AAVE", "category": "crypto"},
    "NEAR": {"name": "Near", "symbol": "NEAR", "category": "crypto"},
    "ARB": {"name": "Arbitrum", "symbol": "ARB", "category": "crypto"},
    "JUP": {"name": "Jupiter", "symbol": "JUP", "category": "crypto"},
    "JTO": {"name": "Jito", "symbol": "JTO", "category": "crypto"},
    "PYTH": {"name": "Pyth", "symbol": "PYTH", "category": "crypto"},
    "PUMP": {"name": "Pump Fun", "symbol": "PUMP", "category": "crypto"},
    "SUI": {"name": "Sui", "symbol": "SUI", "category": "crypto"},
    "KNTQ": {"name": "Kinetiq", "symbol": "KNTQ", "category": "crypto", "isSpotOnly": True},
    "XPL": {"name": "Plasma", "symbol": "XPL", "category": "crypto"},
    "XMR": {"name": "Monero", "symbol": "XMR", "category": "crypto"},
    "UNI": {"name": "Uniswap", "symbol": "UNI", "category": "crypto"},
    "ONDO": {"name": "Ondo", "symbol": "ONDO", "category": "crypto"},
    "GRAM": {"name": "Telegram", "symbol": "GRAM", "category": "crypto"},
    "TRX": {"name": "Tron", "symbol": "TRX", "category": "crypto"},
    "LTC": {"name": "Litecoin", "symbol": "LTC", "category": "crypto"},
    "XLM": {"name": "Stellar", "symbol": "XLM", "category": "crypto"},
    "HBAR": {"name": "Hedera", "symbol": "HBAR", "category": "crypto"},
    "BCH": {"name": "Bitcoin Cash", "symbol": "BCH", "category": "crypto"},
    "ADA": {"name": "Cardano", "symbol": "ADA", "category": "crypto"},
    "AVAX": {"name": "Avalanche", "symbol": "AVAX", "category": "crypto"},
    "ENA": {"name": "Ethena", "symbol": "ENA", "category": "crypto"},
    "MON": {"name": "Monad", "symbol": "MON", "category": "crypto"},
    "APT": {"name": "Aptos", "symbol": "APT", "category": "crypto"},
    "WLFI": {"name": "World Liberty Financial", "symbol": "WLFI", "category": "crypto"},
    "TAO": {"name": "Bittensor", "symbol": "TAO", "category": "crypto"},
    "WLD": {"name": "Worldcoin", "symbol": "WLD", "category": "crypto"},
    "ZRO": {"name": "LayerZero", "symbol": "ZRO", "category": "crypto"},
    "VIRTUAL": {"name": "Virtual", "symbol": "VIRTUAL", "category": "crypto"},
    "VVV": {"name": "Venice AI", "symbol": "VVV", "category": "crypto"},
    "MEGA": {"name": "MegaETH", "symbol": "MEGA", "category": "crypto"},
    "PONS": {"name": "Pons", "symbol": "PONS", "category": "crypto"},
    "ASTER": {"name": "Aster", "symbol": "ASTER", "category": "crypto"},
    "USDT": {"name": "USDT", "symbol": "USDT", "category": "crypto", "isSpotOnly": True},
}

# List of crypto coins to fetch
CRYPTO_COINS = list(CRYPTO_METADATA.keys())
SPOT_ONLY_COINS = (
    {k for k, v in CRYPTO_METADATA.items() if v.get("isSpotOnly")}
    | {k for k, v in ASSET_METADATA.items() if v.get("isSpotOnly")}
)
_CRYPTO_SPOT_ONLY = {k for k, v in CRYPTO_METADATA.items() if v.get("isSpotOnly")}
_NON_CRYPTO_SPOT_ONLY = {k for k, v in ASSET_METADATA.items() if v.get("isSpotOnly")}


def _get_hl_base_coin(coin: str) -> str:
    """Return the Hyperliquid base-coin symbol for a metadata key.

    E.g. 'GOLDSPOT' -> 'XAUT' (via hlBaseCoin override), 'USDH' -> 'USDH'.
    """
    meta = CRYPTO_METADATA.get(coin) or ASSET_METADATA.get(coin) or {}
    return meta.get("hlBaseCoin", coin)

# Helpers for main-exchange assets (crypto/forex)
def _normalize_coin_key(coin: str) -> str:
    return coin.strip().upper()

def _resolve_main_coin(coin: str, universe: List[Dict[str, Any]]) -> Optional[str]:
    """Match a coin symbol to the actual universe name (case-insensitive)."""
    key = _normalize_coin_key(coin)
    aliases = {key, f"{key}-PERP", f"{key}-USD"}
    for asset in universe:
        name = str(asset.get("name", ""))
        if name.upper() in aliases:
            return name
    return None

def _normalize_growth_mode(value: Any) -> Optional[bool]:
    """HL meta returns growthMode as \"enabled\" (str) or omits it when off."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("enabled", "true", "1"):
            return True
        if s in ("disabled", "false", "0", ""):
            return False
        return None
    return bool(value)


def _normalize_deployer_fee_scale(value: Any) -> Optional[float]:
    """Per-asset HIP-3 deployerFeeScale from meta.universe (decimal string)."""
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n < 0:  # NaN or negative
        return None
    return n


# Models
class AssetInfo(BaseModel):
    coin: str
    name: str
    symbol: str
    category: str
    maxLeverage: int
    szDecimals: int
    markPx: Optional[str] = None
    prevDayPx: Optional[str] = None
    dayNtlVlm: Optional[str] = None
    openInterest: Optional[str] = None
    funding: Optional[str] = None
    change24h: Optional[float] = None
    isHip3: bool = True
    isSpotOnly: Optional[bool] = None
    isPreIpo: Optional[bool] = None
    dex: Optional[str] = None
    preIpoBoundLow: Optional[float] = None
    preIpoBoundHigh: Optional[float] = None
    openInterestCapLabel: Optional[str] = None
    preIpoMcapQuote: Optional[bool] = None
    hasSpot: Optional[bool] = None
    spotSymbol: Optional[str] = None
    # HIP-3 fee params from HL meta (drive client fee UI; see hip3Fees.ts)
    growthMode: Optional[bool] = None
    deployerFeeScale: Optional[float] = None

class CandleData(BaseModel):
    t: int  # timestamp
    o: str  # open
    h: str  # high
    l: str  # low
    c: str  # close
    v: str  # volume

class BuilderConfig(BaseModel):
    address: str = BUILDER_ADDRESS
    fee: int = BUILDER_FEE


class Bridge2PermitDepositRequest(BaseModel):
    user: str
    usd: str  # base units (e.g. 1 USDC = 1_000_000)
    deadline: int  # unix seconds
    signature: str  # 65-byte hex signature (0x...)

    @field_validator("user")
    @classmethod
    def _validate_user(cls, v: str) -> str:
        if not Web3.is_address(v):
            raise ValueError("Invalid user address")
        return Web3.to_checksum_address(v)

    @field_validator("signature")
    @classmethod
    def _validate_sig(cls, v: str) -> str:
        if not isinstance(v, str) or not v.startswith("0x"):
            raise ValueError("Invalid signature")
        return v


class WalletTransferRequest(BaseModel):
    user: str  # wallet address
    destination: str  # external address to send to
    usd: str  # base units (e.g. 1 USDC = 1_000_000)
    deadline: int  # unix seconds
    signature: str  # 65-byte hex signature (0x...) - USDC permit signature
    intent_signature: str  # EIP-712 TransferIntent — binds destination + amount
    signed_nonce: Optional[int] = None  # nonce used when signing (for validation)

    @field_validator("user")
    @classmethod
    def _validate_user(cls, v: str) -> str:
        if not Web3.is_address(v):
            raise ValueError("Invalid user address")
        return Web3.to_checksum_address(v)

    @field_validator("signature", "intent_signature")
    @classmethod
    def _validate_sig(cls, v: str) -> str:
        if not isinstance(v, str) or not v.startswith("0x"):
            raise ValueError("Invalid signature")
        return v

    @field_validator("destination")
    @classmethod
    def _validate_destination(cls, v: str) -> str:
        if not Web3.is_address(v):
            raise ValueError("Invalid destination address")
        return Web3.to_checksum_address(v)


# ============================================================================
# Demo Trading Mode Models
# ============================================================================

class DemoClaimFundsRequest(BaseModel):
    """POST /demo/claim-funds — user claims their one-shot $100 testnet USDC.

    Identity is the Privy user id (extracted server-side from the auth token,
    not trusted from the body). The wallet_address is where the testnet USDC
    is sent — must match a Privy embedded wallet for the same user. The
    device_id (optional, supplied by getNotificationDeviceId() on the client)
    is used as a sybil-defense secondary unique key — same physical device
    cannot claim across multiple Privy identities.
    """
    wallet_address: str
    device_id: Optional[str] = None


class DemoStatusResponse(BaseModel):
    """GET /demo/status — current demo claim state for the authed user."""
    claimed: bool
    status: Optional[str] = None  # 'pending' | 'sent' | 'failed' | None
    claimed_at: Optional[str] = None
    sent_at: Optional[str] = None
    tx_hash: Optional[str] = None
    amount_usdc: Optional[float] = None
    grant_amount_usdc: float  # what a fresh claim would receive (for UI hinting)


# ============================================================================
# Push Notifications & Price Alerts Models
# ============================================================================

class RegisterPushTokenRequest(BaseModel):
    push_token: str  # Expo push token (e.g., "ExponentPushToken[xxx]")
    device_id: Optional[str] = None  # Optional device identifier
    platform: Optional[str] = None  # "ios", "android", or "web"
    wallet_address: Optional[str] = None  # Privy embedded wallet (for deposit notifications)


class CreatePriceAlertRequest(BaseModel):
    symbol: str  # Asset symbol (e.g., "BTC", "ETH", "AAPL:Trade.XYZ")
    target_price: float  # Target price to trigger alert
    condition: str  # "above" or "below"
    note: Optional[str] = None  # Optional user note

    @field_validator("condition")
    @classmethod
    def _validate_condition(cls, v: str) -> str:
        if v not in ("above", "below"):
            raise ValueError("Condition must be 'above' or 'below'")
        return v

    @field_validator("target_price")
    @classmethod
    def _validate_price(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Target price must be positive")
        return v


class UpdatePriceAlertRequest(BaseModel):
    is_active: Optional[bool] = None
    target_price: Optional[float] = None
    condition: Optional[str] = None
    note: Optional[str] = None

    @field_validator("condition")
    @classmethod
    def _validate_condition(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("above", "below"):
            raise ValueError("Condition must be 'above' or 'below'")
        return v

    @field_validator("target_price")
    @classmethod
    def _validate_price(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("Target price must be positive")
        return v


def _split_signature(sig_hex: str):
    """Split signature into r, s, v components.
    
    Returns:
        For Bridge2 (uint256 r, uint256 s): returns (r_int, s_int, v_int)
        For USDC permit (bytes32 r, bytes32 s): use _split_signature_bytes32() instead
    """
    raw = bytes.fromhex(sig_hex[2:])
    if len(raw) != 65:
        raise ValueError("Signature must be 65 bytes")
    r = int.from_bytes(raw[0:32], "big")
    s = int.from_bytes(raw[32:64], "big")
    v = raw[64]
    if v < 27:
        v += 27
    return r, s, v


def _split_signature_bytes32(sig_hex: str):
    """Split signature into bytes32 r, bytes32 s, and uint8 v for USDC permit.
    
    Returns:
        (r_bytes32, s_bytes32, v_int) where r and s are 32-byte bytes objects
    """
    raw = bytes.fromhex(sig_hex[2:])
    if len(raw) != 65:
        raise ValueError("Signature must be 65 bytes")
    r_bytes = raw[0:32]
    s_bytes = raw[32:64]
    v = raw[64]
    if v < 27:
        v += 27
    return r_bytes, s_bytes, v


def _verify_permit_signature_offchain(
    owner: str,
    spender: str,
    value: int,
    nonce: int,
    deadline: int,
    signature: str,
    chain_id: int = ARBITRUM_CHAIN_ID,
) -> str:
    """
    Verify EIP-712 permit signature OFF-CHAIN before submitting to blockchain.
    
    This saves gas by rejecting invalid signatures before broadcast.
    Returns the recovered address if valid, raises ValueError if invalid.
    
    Note: Arbitrum USDC uses domain name "USD Coin" and version "2".
    """
    from eth_account import Account
    from eth_account.messages import encode_structured_data
    
    owner_checksummed = Web3.to_checksum_address(owner)
    spender_checksummed = Web3.to_checksum_address(spender)
    contract_checksummed = Web3.to_checksum_address(ARBITRUM_USDC_ADDRESS)
    
    # Full EIP-712 typed data structure (must match frontend exactly)
    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Permit": [
                {"name": "owner", "type": "address"},
                {"name": "spender", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
            ],
        },
        "primaryType": "Permit",
        "domain": {
            "name": "USD Coin",
            "version": "2",
            "chainId": chain_id,
            "verifyingContract": contract_checksummed,
        },
        "message": {
            "owner": owner_checksummed,
            "spender": spender_checksummed,
            "value": value,
            "nonce": nonce,
            "deadline": deadline,
        },
    }
    
    try:
        # Encode the structured data
        signable = encode_structured_data(primitive=typed_data)
        
        # Parse signature
        sig_hex = signature[2:] if signature.startswith("0x") else signature
        sig_bytes = bytes.fromhex(sig_hex)
        if len(sig_bytes) != 65:
            raise ValueError(f"Signature must be 65 bytes, got {len(sig_bytes)}")
        
        # Recover the address that signed this message
        recovered = Account.recover_message(signable, signature=sig_bytes)
        recovered_checksummed = Web3.to_checksum_address(recovered)
        
        logger.info(f"Permit sig recovery: recovered={recovered_checksummed}, expected={owner_checksummed}")
        
        if recovered_checksummed.lower() != owner_checksummed.lower():
            raise ValueError(
                f"Signature mismatch: signed by {recovered_checksummed}, expected {owner_checksummed}"
            )
        
        logger.info(f"Permit signature verified off-chain: owner={owner_checksummed}")
        return recovered_checksummed
        
    except ValueError:
        raise
    except Exception as e:
        logger.error(f"Permit signature verification failed: {e}", exc_info=True)
        raise ValueError(f"Permit signature verification failed: {str(e)}")


def _verify_transfer_intent_offchain(
    *,
    owner: str,
    destination: str,
    amount: int,
    deadline: int,
    relayer: str,
    signature: str,
    chain_id: int = ARBITRUM_CHAIN_ID,
) -> str:
    """Verify EIP-712 TransferIntent signed via eth_signTypedData_v4.

    Binds destination (and amount/deadline/relayer) so the relayer cannot
    be tricked into transferFrom() to an address the user did not sign for.
    Schema must match ``frontend/src/lib/walletTransferIntent.ts``.
    """
    from eth_account import Account

    owner_cs = Web3.to_checksum_address(owner)
    dest_cs = Web3.to_checksum_address(destination)
    relayer_cs = Web3.to_checksum_address(relayer)
    verifying = Web3.to_checksum_address(WALLET_TRANSFER_INTENT_VERIFYING_CONTRACT)

    sig_hex = signature[2:] if signature.startswith("0x") else signature
    sig_bytes = bytes.fromhex(sig_hex)
    if len(sig_bytes) != 65:
        raise ValueError(f"Intent signature must be 65 bytes, got {len(sig_bytes)}")

    message_data = {
        "owner": owner_cs,
        "destination": dest_cs,
        "amount": int(amount),
        "deadline": int(deadline),
        "relayer": relayer_cs,
    }
    domain_data = {
        "name": WALLET_TRANSFER_INTENT_DOMAIN_NAME,
        "version": WALLET_TRANSFER_INTENT_DOMAIN_VERSION,
        "chainId": int(chain_id),
        "verifyingContract": verifying,
    }
    message_types = {
        "TransferIntent": [
            {"name": "owner", "type": "address"},
            {"name": "destination", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "relayer", "type": "address"},
        ],
    }

    try:
        try:
            from eth_account.messages import encode_typed_data

            signable = encode_typed_data(
                domain_data=domain_data,
                message_types=message_types,
                message_data=message_data,
            )
        except ImportError:
            from eth_account.messages import encode_structured_data

            typed_data = {
                "types": {
                    "EIP712Domain": [
                        {"name": "name", "type": "string"},
                        {"name": "version", "type": "string"},
                        {"name": "chainId", "type": "uint256"},
                        {"name": "verifyingContract", "type": "address"},
                    ],
                    **message_types,
                },
                "primaryType": "TransferIntent",
                "domain": domain_data,
                "message": message_data,
            }
            signable = encode_structured_data(primitive=typed_data)

        recovered = Account.recover_message(signable, signature=sig_bytes)
        recovered_cs = Web3.to_checksum_address(recovered)
        if recovered_cs.lower() != owner_cs.lower():
            raise ValueError(
                f"Transfer intent signed by {recovered_cs}, expected {owner_cs}"
            )
        logger.info("Transfer intent verified off-chain: owner=%s dest=%s", owner_cs, dest_cs)
        return recovered_cs
    except ValueError:
        raise
    except Exception as e:
        logger.error("Transfer intent verification failed: %s", e, exc_info=True)
        raise ValueError(f"Transfer intent verification failed: {str(e)}") from e


def _check_replay_protection(signature: str) -> None:
    """Check if signature has been used before (replay protection).

    Uses a Supabase table with a UNIQUE constraint so the check-and-mark
    is atomic — safe across multiple replicas.
    Raises ValueError if signature was already used.
    """
    import hashlib
    sig_hash = hashlib.sha256(signature.encode()).hexdigest()

    if not supabase:
        return  # dev mode without DB — skip

    try:
        res = supabase.rpc("check_and_mark_signature", {
            "p_sig_hash": sig_hash,
        }).execute()
        is_new = res.data
        if not is_new:
            raise ValueError("Signature already used (replay protection)")
    except ValueError:
        raise
    except Exception as exc:
        logger.error("Replay protection DB error (blocking): %s", exc)
        raise ValueError("Service temporarily unavailable — please retry in a moment")


def _bridge2_batched_deposit_with_permit_sync(req: Bridge2PermitDepositRequest) -> str:
    if not _RELAYER_PRIVATE_KEYS:
        raise RuntimeError("BRIDGE2_RELAYER_PRIVATE_KEY not configured")

    # Replay protection
    _check_replay_protection(req.signature)

    usd_int = int(req.usd)
    if usd_int <= 0:
        raise ValueError("usd must be > 0")
    # 5 USDC minimum in base units (6 decimals)
    if usd_int < BRIDGE2_MIN_DEPOSIT_USDC * 1_000_000:
        raise ValueError(f"Minimum deposit is {BRIDGE2_MIN_DEPOSIT_USDC} USDC")
    if usd_int > (2**64 - 1):
        raise ValueError("usd too large")

    # _make_web3() validates chain ID internally across configured RPC URLs.
    w3 = _make_web3()

    # Deterministic relayer assignment. The frontend MUST have signed the
    # permit with this exact relayer as `spender`; otherwise the on-chain
    # permit() call reverts (funds stay safe, only gas is at risk — and
    # estimate_gas below will catch the mismatch before we broadcast).
    relayer, relayer_pk = select_relayer_for_user(req.user)
    relayer_acct = w3.eth.account.from_key(relayer_pk)

    bridge2_abi = [
        {
            "inputs": [
                {
                    "components": [
                        {"internalType": "address", "name": "user", "type": "address"},
                        {"internalType": "uint64", "name": "usd", "type": "uint64"},
                        {"internalType": "uint64", "name": "deadline", "type": "uint64"},
                        {
                            "components": [
                                {"internalType": "uint256", "name": "r", "type": "uint256"},
                                {"internalType": "uint256", "name": "s", "type": "uint256"},
                                {"internalType": "uint8", "name": "v", "type": "uint8"},
                            ],
                            "internalType": "struct Signature",
                            "name": "signature",
                            "type": "tuple",
                        },
                    ],
                    "internalType": "struct DepositWithPermit[]",
                    "name": "deposits",
                    "type": "tuple[]",
                }
            ],
            "name": "batchedDepositWithPermit",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function",
        }
    ]

    # Verify nonce before submitting (nonce is checked on-chain, but we verify off-chain to save gas)
    usdc_abi_for_nonce = [
        {
            "constant": True,
            "inputs": [{"name": "_owner", "type": "address"}],
            "name": "nonces",
            "outputs": [{"name": "", "type": "uint256"}],
            "type": "function",
        },
        {
            "constant": True,
            "inputs": [
                {"name": "_owner", "type": "address"},
                {"name": "_spender", "type": "address"},
            ],
            "name": "allowance",
            "outputs": [{"name": "", "type": "uint256"}],
            "type": "function",
        },
    ]
    usdc_contract_for_nonce = w3.eth.contract(
        address=Web3.to_checksum_address(ARBITRUM_USDC_ADDRESS), abi=usdc_abi_for_nonce
    )
    # Note: We can't verify the exact nonce used in the permit without decoding the signature,
    # but the on-chain permit() will revert if nonce is wrong. This check is mainly for logging.
    # The frontend should fetch and use the correct nonce, which it does.
    user_nonce = usdc_contract_for_nonce.functions.nonces(Web3.to_checksum_address(req.user)).call()
    logger.info(f"Bridge2 deposit: user {req.user} nonce: {user_nonce}")
    
    # Optional: Check current allowance (sanity check - permit will set this, but useful for debugging)
    current_allowance = usdc_contract_for_nonce.functions.allowance(
        Web3.to_checksum_address(req.user), Web3.to_checksum_address(BRIDGE2_ADDRESS)
    ).call()
    if current_allowance >= usd_int:
        logger.info(f"Bridge2 deposit: user {req.user} already has sufficient allowance: {current_allowance} >= {usd_int}")
    # Note: We still proceed with permit() call - if deadline expired or nonce wrong, it will revert on-chain

    contract = w3.eth.contract(address=Web3.to_checksum_address(BRIDGE2_ADDRESS), abi=bridge2_abi)
    r, s, v = _split_signature(req.signature)

    # Arbitrum is EIP-1559. Using `gasPrice` can occasionally be *lower* than the
    # current base fee, causing: "max fee per gas less than block base fee".
    tx_fee_params: Dict[str, int] = {}
    try:
        pending = w3.eth.get_block("pending")
        base_fee = pending.get("baseFeePerGas")
        if base_fee is not None:
            # Small priority fee + buffered max fee to survive tiny base-fee bumps.
            priority_fee = int(w3.to_wei("0.01", "gwei"))
            max_fee = int(int(base_fee) * 3 + priority_fee)
            # Safety: ensure maxFeePerGas is never below baseFee + priorityFee
            max_fee = max(max_fee, int(base_fee) + priority_fee)
            tx_fee_params = {
                "maxFeePerGas": max_fee,
                "maxPriorityFeePerGas": priority_fee,
            }
    except Exception:
        tx_fee_params = {}

    # Fallback for providers that don't return baseFeePerGas
    if not tx_fee_params:
        gas_price = int(w3.eth.gas_price)
        tx_fee_params = {"gasPrice": int(gas_price * 1.2)}

    if not _acquire_relayer_lock_for(relayer):
        raise RuntimeError("Server busy — please try again in a moment.")
    try:
        deposit_nonce = w3.eth.get_transaction_count(relayer, "pending")
        tx = contract.functions.batchedDepositWithPermit(
            [(req.user, usd_int, int(req.deadline), (r, s, v))]
        ).build_transaction(
            {
                "from": relayer,
                "nonce": deposit_nonce,
                "chainId": w3.eth.chain_id,
                **tx_fee_params,
            }
        )

        # Estimate gas; a failure here almost always means the permit would
        # revert on-chain (wrong spender, bad sig, expired deadline, etc.).
        # Reject fast rather than burn relayer gas on a guaranteed revert.
        try:
            estimated = w3.eth.estimate_gas(tx)
            tx["gas"] = int(estimated * 1.3)
        except Exception as est_err:
            raise ValueError(
                "Deposit would revert on-chain (invalid permit signature, wrong relayer, "
                "expired deadline, or nonce mismatch). Please refresh and try again."
            ) from est_err

        signed = relayer_acct.sign_transaction(tx)
        raw_tx = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction", None)
        if raw_tx is None:
            raise RuntimeError("Signed transaction missing raw transaction bytes")

        tx_hash = w3.eth.send_raw_transaction(raw_tx)
    finally:
        _release_relayer_lock_for(relayer)

    tx_hash_hex = tx_hash.hex()
    if not tx_hash_hex.startswith("0x"):
        tx_hash_hex = f"0x{tx_hash_hex}"
    return tx_hash_hex


def _check_transfer_rate_limit(user_address: str) -> None:
    """Check if user has exceeded transfer rate limit (anti-griefing).
    
    Uses Supabase for persistence (survives server restarts).
    Raises ValueError if rate limit exceeded.
    """
    if not supabase:
        # If Supabase not configured, allow transfers (dev mode)
        logger.warning("Supabase not configured - rate limiting disabled")
        return
    
    user_key = user_address.lower()
    current_time = datetime.utcnow()
    cutoff_time = current_time - timedelta(seconds=TRANSFER_RATE_LIMIT_WINDOW_SECONDS)
    
    try:
        # Query recent transfers from Supabase
        result = supabase.table('transfer_rate_limits').select('transferred_at').eq(
            'user_address', user_key
        ).gte('transferred_at', cutoff_time.isoformat()).execute()
        
        recent_transfers = result.data if result.data else []
        recent_count = len(recent_transfers)
        
        if recent_count >= TRANSFER_RATE_LIMIT_MAX:
            # Find oldest transfer to calculate wait time
            oldest = min(datetime.fromisoformat(t['transferred_at'].replace('Z', '+00:00')) for t in recent_transfers)
            reset_time = oldest + timedelta(seconds=TRANSFER_RATE_LIMIT_WINDOW_SECONDS)
            hours_remaining = int((reset_time - datetime.now(oldest.tzinfo)).total_seconds() / 3600) + 1
            raise ValueError(
                f"Transfer limit reached ({TRANSFER_RATE_LIMIT_MAX} per 24h). "
                f"Try again in ~{hours_remaining} hours."
            )
    except ValueError:
        # Re-raise rate limit errors
        raise
    except Exception as e:
        logger.error(f"Rate limit check failed: {e}", exc_info=True)
        raise ValueError(
            "Service temporarily unavailable — please retry in a moment"
        ) from e


def _record_transfer(user_address: str, tx_hash: str, amount_usdc: float, destination: str) -> None:
    """Record a successful transfer for rate limiting (persisted in Supabase)."""
    if not supabase:
        return
    
    user_key = user_address.lower()
    try:
        supabase.table('transfer_rate_limits').insert({
            'user_address': user_key,
            'tx_hash': tx_hash,
            'amount_usdc': amount_usdc,
            'destination': destination.lower(),
            'transferred_at': datetime.utcnow().isoformat(),
        }).execute()
    except Exception as e:
        logger.error(f"Failed to record transfer: {e}", exc_info=True)
        # Non-fatal - transfer already succeeded


def _wallet_transfer_with_permit_sync(req: WalletTransferRequest) -> str:
    """Gasless USDC transfer from wallet to external address using permit + relayer."""
    if not _RELAYER_PRIVATE_KEYS:
        raise RuntimeError("BRIDGE2_RELAYER_PRIVATE_KEY not configured")

    # Rate limiting (anti-griefing) - check BEFORE doing any work
    _check_transfer_rate_limit(req.user)

    # Replay protection (permit + intent are independent replay surfaces)
    _check_replay_protection(req.signature)
    _check_replay_protection(req.intent_signature)

    usd_int = int(req.usd)
    if usd_int <= 0:
        raise ValueError("usd must be > 0")
    
    # Minimum transfer amount (anti-griefing)
    min_amount_base = TRANSFER_MIN_AMOUNT_USDC * 1_000_000  # 5 USDC in base units
    if usd_int < min_amount_base:
        raise ValueError(f"Minimum transfer is {TRANSFER_MIN_AMOUNT_USDC} USDC")
    
    if usd_int > (2**64 - 1):
        raise ValueError("usd too large")

    # _make_web3() validates chain ID internally across configured RPC URLs.
    w3 = _make_web3()

    # Deterministic relayer assignment. The permit was signed with
    # `spender = <this relayer>`; a mismatch is caught by estimate_gas
    # (or by the on-chain permit() revert) before any user funds move.
    relayer, relayer_pk = select_relayer_for_user(req.user)
    relayer_acct = w3.eth.account.from_key(relayer_pk)

    # Bind destination to a user-signed intent before spending relayer gas.
    current_time = int(time.time())
    if int(req.deadline) < current_time:
        raise ValueError(f"Transfer deadline expired: {req.deadline} < {current_time}")
    _verify_transfer_intent_offchain(
        owner=req.user,
        destination=req.destination,
        amount=usd_int,
        deadline=int(req.deadline),
        relayer=relayer,
        signature=req.intent_signature,
    )

    # Check user has enough balance
    usdc_abi = [
        {
            "constant": True,
            "inputs": [{"name": "_owner", "type": "address"}],
            "name": "balanceOf",
            "outputs": [{"name": "balance", "type": "uint256"}],
            "type": "function",
        },
        {
            "constant": True,
            "inputs": [
                {"name": "_owner", "type": "address"},
                {"name": "_spender", "type": "address"},
            ],
            "name": "allowance",
            "outputs": [{"name": "", "type": "uint256"}],
            "type": "function",
        },
        {
            "constant": True,
            "inputs": [{"name": "owner", "type": "address"}],
            "name": "nonces",
            "outputs": [{"name": "", "type": "uint256"}],
            "type": "function",
        },
        {
            "constant": False,
            "inputs": [
                {"name": "_spender", "type": "address"},
                {"name": "_value", "type": "uint256"},
            ],
            "name": "approve",
            "outputs": [{"name": "", "type": "bool"}],
            "type": "function",
        },
        {
            "constant": False,
            "inputs": [
                {"name": "_from", "type": "address"},
                {"name": "_to", "type": "address"},
                {"name": "_value", "type": "uint256"},
            ],
            "name": "transferFrom",
            "outputs": [{"name": "", "type": "bool"}],
            "type": "function",
        },
        {
            "constant": False,
            "inputs": [
                {"name": "owner", "type": "address"},
                {"name": "spender", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
                {"name": "v", "type": "uint8"},
                {"name": "r", "type": "bytes32"},
                {"name": "s", "type": "bytes32"},
            ],
            "name": "permit",
            "outputs": [],
            "type": "function",
        },
    ]

    usdc_contract = w3.eth.contract(address=Web3.to_checksum_address(ARBITRUM_USDC_ADDRESS), abi=usdc_abi)
    user_balance = usdc_contract.functions.balanceOf(Web3.to_checksum_address(req.user)).call()
    if user_balance < usd_int:
        raise ValueError(f"Insufficient balance: have {user_balance}, need {usd_int}")

    # Get user's current nonce for permit verification
    user_nonce = usdc_contract.functions.nonces(Web3.to_checksum_address(req.user)).call()
    
    # Log detailed info for debugging permit issues
    logger.info(f"Wallet transfer: user={req.user}, on-chain nonce={user_nonce}, signed_nonce={req.signed_nonce}, amount={usd_int}, deadline={req.deadline}")
    logger.info(f"Wallet transfer: relayer={relayer}, USDC={ARBITRUM_USDC_ADDRESS}")
    
    # Validate nonce if provided (prevents wasted gas on guaranteed-to-fail permits)
    if req.signed_nonce is not None and req.signed_nonce != user_nonce:
        raise ValueError(
            f"Nonce mismatch: you signed with nonce {req.signed_nonce} but chain expects {user_nonce}. "
            f"Please try again."
        )
    
    # Verify the user address matches what was provided (case-insensitive but log for debugging)
    user_checksummed = Web3.to_checksum_address(req.user)
    logger.info(f"Wallet transfer: user_checksummed={user_checksummed}")
    
    # Check deadline hasn't expired
    if int(req.deadline) < current_time:
        raise ValueError(f"Permit deadline expired: {req.deadline} < {current_time}")

    # Verify permit signature and extract r, s, v
    # Use bytes32 directly for USDC permit (more reliable than hex string conversion)
    r_bytes, s_bytes, v = _split_signature_bytes32(req.signature)
    
    # Log signature components for debugging
    logger.info(f"Wallet transfer sig: v={v}, r={r_bytes.hex()[:16]}..., s={s_bytes.hex()[:16]}...")
    
    # Verify v value is correct (should be 27 or 28 for Ethereum)
    if v not in (27, 28):
        raise ValueError(f"Invalid signature v value: {v} (expected 27 or 28)")

    # Get gas price
    tx_fee_params: Dict[str, int] = {}
    try:
        pending = w3.eth.get_block("pending")
        base_fee = pending.get("baseFeePerGas")
        if base_fee is not None:
            priority_fee = int(w3.to_wei("0.01", "gwei"))
            max_fee = int(int(base_fee) * 3 + priority_fee)
            max_fee = max(max_fee, int(base_fee) + priority_fee)
            tx_fee_params = {
                "maxFeePerGas": max_fee,
                "maxPriorityFeePerGas": priority_fee,
            }
    except Exception:
        tx_fee_params = {}

    if not tx_fee_params:
        gas_price = int(w3.eth.gas_price)
        tx_fee_params = {"gasPrice": int(gas_price * 1.2)}

    for attempt in range(2):
        try:
            permit_hash = None

            # PHASE 1: Always broadcast permit() — never skip based on existing
            # allowance alone. The old skip path let anyone with a valid Privy
            # token drain leftover allowance using a junk signature because
            # transferFrom ran without an on-chain permit check. estimate_gas
            # on permit() is the authoritative pre-flight (off-chain EIP-712
            # recovery is disabled due to eth_signTypedData_v4 encoding drift).
            if not _acquire_relayer_lock_for(relayer):
                raise RuntimeError("Server busy — please try again in a moment.")
            try:
                permit_nonce = w3.eth.get_transaction_count(relayer, "pending")
                permit_tx = usdc_contract.functions.permit(
                    Web3.to_checksum_address(req.user),
                    relayer,
                    usd_int,
                    int(req.deadline),
                    v,
                    r_bytes,
                    s_bytes,
                ).build_transaction(
                    {
                        "from": relayer,
                        "nonce": permit_nonce,
                        "chainId": w3.eth.chain_id,
                        **tx_fee_params,
                    }
                )

                # Estimate gas also acts as a free pre-flight check —
                # if the permit would revert (wrong spender, bad sig,
                # expired deadline, stale nonce) the node returns an
                # error here and we refuse to broadcast.
                try:
                    estimated_permit = w3.eth.estimate_gas(permit_tx)
                    permit_tx["gas"] = int(estimated_permit * 1.3)
                except Exception as est_err:
                    raise ValueError(
                        "Permit would revert on-chain (invalid signature, wrong relayer, "
                        "expired deadline, or nonce mismatch). Please refresh and try again."
                    ) from est_err

                signed_permit = relayer_acct.sign_transaction(permit_tx)
                raw_permit = getattr(signed_permit, "raw_transaction", None) or getattr(signed_permit, "rawTransaction", None)
                if raw_permit is None:
                    raise RuntimeError("Signed permit transaction missing raw transaction bytes")
                try:
                    permit_hash = w3.eth.send_raw_transaction(raw_permit)
                    logger.info(f"Wallet transfer: permit tx sent, hash={permit_hash.hex()}")
                except ValueError as e:
                    if _is_nonce_too_low(e):
                        raise _NonceTooLowError() from e
                    raise
            finally:
                _release_relayer_lock_for(relayer)

            # PHASE 2: Wait for permit receipt (NO LOCK — allows concurrency)
            if permit_hash is not None:
                permit_receipt = w3.eth.wait_for_transaction_receipt(permit_hash)

                new_allowance = 0
                max_allowance_checks = 5
                allowance_retry_delay = 2

                for allowance_check in range(max_allowance_checks):
                    new_allowance = usdc_contract.functions.allowance(
                        Web3.to_checksum_address(req.user), relayer
                    ).call()

                    if new_allowance >= usd_int:
                        break

                    if allowance_check < max_allowance_checks - 1:
                        logger.info(f"Allowance check {allowance_check + 1}/{max_allowance_checks}: got {new_allowance}, expected >= {usd_int}, retrying in {allowance_retry_delay}s...")
                        time.sleep(allowance_retry_delay)

                if permit_receipt.status != 1:
                    if new_allowance >= usd_int:
                        logger.info(
                            f"Wallet transfer: our permit tx failed but allowance is sufficient "
                            f"(likely front-run). allowance={new_allowance}, proceeding to transfer."
                        )
                    else:
                        raise ValueError(
                            "Permit transaction failed on-chain (invalid signature, wrong nonce, or expired deadline)"
                        )
                elif new_allowance < usd_int:
                    logger.error(f"Permit allowance check failed after retries! allowance={new_allowance}, expected>={usd_int}")
                    logger.error(f"  user={Web3.to_checksum_address(req.user)}, relayer={relayer}")
                    logger.error(f"  deadline={req.deadline}, permit_tx={permit_hash.hex()}")
                    raise ValueError(
                        f"Permit verification failed. Please try again in a moment. "
                        f"(allowance: {new_allowance}, needed: {usd_int})"
                    )
                else:
                    logger.info(f"Wallet transfer: permit succeeded, allowance set to {new_allowance}")

            # PHASE 3: Acquire lock again, send transferFrom
            transfer_attempts = 0
            max_transfer_attempts = 2
            while transfer_attempts < max_transfer_attempts:
                transfer_attempts += 1
                try:
                    if not _acquire_relayer_lock_for(relayer):
                        raise RuntimeError("Server busy — please try again in a moment.")
                    try:
                        transfer_nonce = w3.eth.get_transaction_count(relayer, "pending")
                        transfer_tx = usdc_contract.functions.transferFrom(
                            Web3.to_checksum_address(req.user),
                            Web3.to_checksum_address(req.destination),
                            usd_int,
                        ).build_transaction(
                            {
                                "from": relayer,
                                "nonce": transfer_nonce,
                                "chainId": w3.eth.chain_id,
                                **tx_fee_params,
                            }
                        )

                        # Pre-flight: a revert here usually means the
                        # permit never landed or allowance was clobbered.
                        try:
                            estimated_transfer = w3.eth.estimate_gas(transfer_tx)
                            transfer_tx["gas"] = int(estimated_transfer * 1.3)
                        except Exception as est_err:
                            raise ValueError(
                                "Transfer would revert on-chain (allowance missing or insufficient "
                                "balance). Please try again in a moment."
                            ) from est_err

                        signed_transfer = relayer_acct.sign_transaction(transfer_tx)
                        raw_transfer = getattr(signed_transfer, "raw_transaction", None) or getattr(signed_transfer, "rawTransaction", None)
                        if raw_transfer is None:
                            raise RuntimeError("Signed transfer transaction missing raw transaction bytes")
                        try:
                            tx_hash = w3.eth.send_raw_transaction(raw_transfer)
                        except ValueError as e:
                            if _is_nonce_too_low(e):
                                raise _NonceTooLowError() from e
                            raise
                    finally:
                        _release_relayer_lock_for(relayer)
                    break
                except (ConnectionError, TimeoutError, OSError) as net_err:
                    if transfer_attempts < max_transfer_attempts:
                        logger.warning(f"Network error during transfer (attempt {transfer_attempts}), retrying: {net_err}")
                        time.sleep(1)
                        continue
                    else:
                        logger.error(f"Transfer failed after {max_transfer_attempts} attempts due to network error: {net_err}")
                        raise ValueError(
                            "Network busy. Your funds are safe - please try again in a minute."
                        ) from net_err
                except Exception as e:
                    err_str = str(e).lower()
                    if any(x in err_str for x in ["timeout", "connection", "network", "refused", "reset"]):
                        if transfer_attempts < max_transfer_attempts:
                            logger.warning(f"Network-like error during transfer (attempt {transfer_attempts}), retrying: {e}")
                            time.sleep(1)
                            continue
                        else:
                            logger.error(f"Transfer failed after {max_transfer_attempts} attempts: {e}")
                            raise ValueError(
                                "Network busy. Your funds are safe - please try again in a minute."
                            ) from e
                    raise

            tx_hash_hex = tx_hash.hex()
            if not tx_hash_hex.startswith("0x"):
                tx_hash_hex = f"0x{tx_hash_hex}"

            _record_transfer(req.user, tx_hash_hex, usd_int / 1_000_000, req.destination)
            logger.info(f"Wallet transfer successful: {req.user} -> {req.destination}, amount={usd_int}, tx={tx_hash_hex}")

            return tx_hash_hex
        except _NonceTooLowError:
            if attempt == 0:
                logger.warning("Relayer nonce too low, retrying...")
                time.sleep(0.5)
                continue
            raise


@app.on_event("startup")
async def startup():
    global http_client
    # Higher pool limits so many users can fan out to external APIs
    # (Hyperliquid, Finnhub, CoinGecko, Gemini, ipapi.co) without connection
    # starvation. Defaults are only (100, 20) which becomes a silent
    # bottleneck under burst traffic.
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        limits=httpx.Limits(
            max_connections=200,
            max_keepalive_connections=50,
            keepalive_expiry=30.0,
        ),
        # HTTP/2 multiplexes many requests per TCP connection — big win
        # when we spam the same host (e.g. api.hyperliquid.xyz).
        http2=False,  # keep off unless `h2` is installed; flip when the dep is added
    )

    # asyncio.to_thread uses the loop's default ThreadPoolExecutor, which
    # caps at min(32, cpu+4) — only 5 workers on a 1-CPU Railway replica.
    # Every supabase.*.execute() call we just wrapped goes through this
    # pool, so we need a lot more headroom before threads become the
    # bottleneck.
    try:
        import concurrent.futures
        loop = asyncio.get_running_loop()
        loop.set_default_executor(
            concurrent.futures.ThreadPoolExecutor(
                max_workers=64,
                thread_name_prefix="sb-io",
            )
        )
        logger.info("Default executor set to ThreadPoolExecutor(max_workers=64)")
    except Exception as e:
        logger.warning("Failed to resize default executor: %s", e)

    logger.info("Hypertrade API started")


@app.on_event("shutdown")
async def shutdown():
    global http_client
    if http_client:
        await http_client.aclose()
    try:
        await ur_api.aclose_async_client()
    except Exception:
        pass
    if client:
        client.close()
    logger.info("Hypertrade API shutdown")


async def fetch_hyperliquid(request_type: str, params: dict = None) -> Any:
    """Make a request to Hyperliquid API"""
    payload = {"type": request_type}
    if params:
        payload.update(params)
    
    try:
        response = await http_client.post(HYPERLIQUID_API_URL, json=payload)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as e:
        logger.error(f"Hyperliquid API error: {e}")
        raise HTTPException(status_code=502, detail=f"Hyperliquid API error: {str(e)}")


# ---------------------------------------------------------------------------
# Cached metaAndAssetCtxs – weight-20 call, reused across many endpoints.
# TTL 10 s keeps data fresh enough while dramatically cutting HL API weight.
# keyed by dex name (None = main exchange).
# ---------------------------------------------------------------------------
import asyncio as _asyncio

_meta_cache: Dict[Optional[str], Any] = {}           # dex -> parsed JSON
_meta_cache_ts: Dict[Optional[str], float] = {}      # dex -> epoch
_meta_cache_lock = _asyncio.Lock()
_META_CACHE_TTL = 10  # seconds


async def _get_meta_and_asset_ctxs(dex: Optional[str] = None) -> Any:
    """Return cached metaAndAssetCtxs for *dex* (None = main exchange).

    If the cache is stale (> _META_CACHE_TTL seconds), performs a fresh fetch
    and stores the result.  Concurrent callers share the same fetch via an
    asyncio lock so only one request is made per TTL window.
    """
    import time as _time

    now = _time.time()
    cached = _meta_cache.get(dex)
    ts = _meta_cache_ts.get(dex, 0)
    if cached is not None and (now - ts) < _META_CACHE_TTL:
        return cached

    async with _meta_cache_lock:
        # Double-check after acquiring lock (another coroutine may have refreshed)
        ts = _meta_cache_ts.get(dex, 0)
        if _meta_cache.get(dex) is not None and (_time.time() - ts) < _META_CACHE_TTL:
            return _meta_cache[dex]

        payload: dict = {"type": "metaAndAssetCtxs"}
        if dex:
            payload["dex"] = dex

        try:
            response = await http_client.post(HYPERLIQUID_API_URL, json=payload)
            response.raise_for_status()
            data = response.json()
        except Exception as exc:
            # If we have a stale cached value, return it rather than failing
            if cached is not None:
                logger.warning(f"HL metaAndAssetCtxs refresh failed (dex={dex}), serving stale cache: {exc}")
                return cached
            raise

        _meta_cache[dex] = data
        _meta_cache_ts[dex] = _time.time()
        return data


_spot_meta_cache: Any = None
_spot_meta_cache_ts: float = 0
_spot_meta_cache_lock = _asyncio.Lock()

async def _get_spot_meta_and_asset_ctxs() -> Any:
    """Return cached spotMetaAndAssetCtxs (spot universe + asset contexts)."""
    import time as _time

    global _spot_meta_cache, _spot_meta_cache_ts

    now = _time.time()
    if _spot_meta_cache is not None and (now - _spot_meta_cache_ts) < _META_CACHE_TTL:
        return _spot_meta_cache

    async with _spot_meta_cache_lock:
        if _spot_meta_cache is not None and (_time.time() - _spot_meta_cache_ts) < _META_CACHE_TTL:
            return _spot_meta_cache

        try:
            response = await http_client.post(
                HYPERLIQUID_API_URL, json={"type": "spotMetaAndAssetCtxs"}
            )
            response.raise_for_status()
            data = response.json()
        except Exception as exc:
            if _spot_meta_cache is not None:
                logger.warning(f"HL spotMetaAndAssetCtxs refresh failed, serving stale cache: {exc}")
                return _spot_meta_cache
            raise

        _spot_meta_cache = data
        _spot_meta_cache_ts = _time.time()
        return data


def _resolve_spot_coin(coin: str, universe: List[Dict[str, Any]], tokens: List[Dict[str, Any]]) -> Optional[str]:
    """Match a coin symbol to its spot universe pair name (e.g. 'USDH' -> 'USDH/USDC')."""
    key = _normalize_coin_key(coin)
    names = {str(u.get("name", "")).upper(): u.get("name") for u in universe}

    if key in names:
        return names[key]
    pair = f"{key}/USDC"
    if pair in names:
        return names[pair]
    prefixed_pair = f"U{key}/USDC"
    if prefixed_pair in names:
        return names[prefixed_pair]
    if key.startswith("U") and len(key) > 1:
        unprefixed_pair = f"{key[1:]}/USDC"
        if unprefixed_pair in names:
            return names[unprefixed_pair]

    usdc_idx = next((t.get("index") for t in tokens if str(t.get("name", "")).upper() == "USDC"), None)
    # Prefer U-wrapped spot tokens (UMON) before bare symbols: HL can list both
    # `MON` and `UMON` with very different prices; perp MON aligns with UMON.
    if key.startswith("U"):
        candidates = [key, key[1:]] if len(key) > 1 else [key]
    else:
        candidates = [f"U{key}", key]

    for name in candidates:
        token = next((t for t in tokens if str(t.get("name", "")).upper() == name), None)
        if token is not None and usdc_idx is not None:
            for u in universe:
                toks = u.get("tokens", [])
                if len(toks) >= 2 and toks[0] == token.get("index") and toks[1] == usdc_idx:
                    return u.get("name")

    # Non-canonical tokens often have a trailing digit suffix (e.g. XAUT0)
    for name in candidates:
        token = next(
            (t for t in tokens if str(t.get("name", "")).upper().startswith(name) and len(str(t.get("name", ""))) <= len(name) + 1),
            None,
        )
        if token is not None and usdc_idx is not None:
            for u in universe:
                toks = u.get("tokens", [])
                if len(toks) >= 2 and toks[0] == token.get("index") and toks[1] == usdc_idx:
                    return u.get("name")

    return None


def _require_alpha_key() -> str:
    if not ALPHAVANTAGE_KEY:
        raise HTTPException(status_code=500, detail="ALPHAVANTAGE_KEY is not configured")
    return ALPHAVANTAGE_KEY


def _alpha_vantage_error(data: Any) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    return data.get("Error Message") or data.get("Note") or data.get("Information")


async def fetch_alpha_vantage_json(
    params: Dict[str, Any],
    min_interval_seconds: float = 1.05,
) -> Dict[str, Any]:
    today_key = datetime.utcnow().date().isoformat()
    cache_key = json.dumps({"__date": today_key, **params}, sort_keys=True)
    cached = _alpha_cache.get(cache_key)
    if cached:
        return cached
    key = _require_alpha_key()
    try:
        async with _alpha_lock:
            global _alpha_last_call
            now = asyncio.get_event_loop().time()
            wait = max(0.0, min_interval_seconds - (now - _alpha_last_call))
            if wait > 0:
                await asyncio.sleep(wait)
            response = await http_client.get(ALPHAVANTAGE_API_URL, params={**params, "apikey": key})
            _alpha_last_call = asyncio.get_event_loop().time()
        response.raise_for_status()
        data = response.json()
        err = _alpha_vantage_error(data)
        if err:
            raise HTTPException(status_code=502, detail=f"Alpha Vantage error: {err}")
        _alpha_cache[cache_key] = data
        return data
    except httpx.HTTPError as e:
        logger.error(f"Alpha Vantage API error: {e}")
        raise HTTPException(status_code=502, detail=f"Alpha Vantage API error: {str(e)}")


async def fetch_alpha_vantage_csv(
    params: Dict[str, Any],
    min_interval_seconds: float = 1.05,
) -> List[Dict[str, Any]]:
    today_key = datetime.utcnow().date().isoformat()
    cache_key = json.dumps({"__date": today_key, **params, "datatype": "csv"}, sort_keys=True)
    cached = _alpha_cache.get(cache_key)
    if cached:
        return cached
    key = _require_alpha_key()
    try:
        async with _alpha_lock:
            global _alpha_last_call
            now = asyncio.get_event_loop().time()
            wait = max(0.0, min_interval_seconds - (now - _alpha_last_call))
            if wait > 0:
                await asyncio.sleep(wait)
            response = await http_client.get(
                ALPHAVANTAGE_API_URL,
                params={**params, "apikey": key, "datatype": "csv"},
            )
            _alpha_last_call = asyncio.get_event_loop().time()
        response.raise_for_status()
        content = response.text
        reader = csv.DictReader(io.StringIO(content))
        data = [row for row in reader]
        _alpha_cache[cache_key] = data
        return data
    except httpx.HTTPError as e:
        logger.error(f"Alpha Vantage API error: {e}")
        raise HTTPException(status_code=502, detail=f"Alpha Vantage API error: {str(e)}")


@api_router.get("/")
async def root():
    return {"message": "Hypertrade API", "version": "1.0.0"}


@api_router.get("/health")
async def health():
    return {"status": "healthy", "service": "hypertrade-api"}


def _parse_semver(v: Optional[str]) -> tuple:
    """Parse a dotted version string into a comparable tuple of ints.

    Tolerant: strips a leading 'v', ignores build/pre-release suffixes, and pads
    missing segments with 0 ('1.9' -> (1, 9, 0)). Unparseable input -> (0, 0, 0).
    """
    if not v or not isinstance(v, str):
        return (0, 0, 0)
    core = v.strip().lstrip("vV").split("+")[0].split("-")[0]
    parts = []
    for seg in core.split("."):
        digits = "".join(ch for ch in seg if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _semver_lt(a: Optional[str], b: Optional[str]) -> bool:
    """True iff version a < version b."""
    return _parse_semver(a) < _parse_semver(b)


@api_router.get("/app-version")
async def get_app_version_policy(
    platform: str = Query("android"),
    version: Optional[str] = Query(None),
):
    """Mobile update-policy check driving the in-app update banner.

    Source of truth is the ``app_version_policy`` table (one row per platform),
    editable live without a deploy. Returns a resolved decision so the client
    stays dumb:

      • ``updateAvailable`` — installed ``version`` < ``latest_version`` (soft)
      • ``forceUpdate``     — installed ``version`` < ``min_version`` (reserved)

    Fails open: any error / missing config returns a no-update response so a DB
    hiccup can never lock users out of the app.

    TODO(app-release): ``app.json`` version can be bumped early for the *next*
    EAS build. ``app_version_policy.latest_version`` must match what is *live on
    the store* — update only after Play/App Store publish, e.g.::

        UPDATE app_version_policy
        SET latest_version = '1.9.2', updated_at = now()
        WHERE platform IN ('android', 'ios');

    Setting ``latest_version`` to an unreleased app.json value makes the Update
    button open the store with nothing to install.
    """
    plat = (platform or "android").lower()
    if plat not in ("android", "ios"):
        plat = "android"

    no_update = {
        "enabled": False,
        "updateAvailable": False,
        "forceUpdate": False,
        "latestVersion": None,
        "minVersion": None,
        "storeUrl": None,
        "message": None,
    }

    if not supabase:
        return no_update

    try:
        res = (
            supabase.table("app_version_policy")
            .select("latest_version,min_version,store_url,enabled,message")
            .eq("platform", plat)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return no_update
        row = rows[0]

        if not row.get("enabled", False):
            return {**no_update, "enabled": False}

        latest = row.get("latest_version")
        minimum = row.get("min_version")
        store_url = row.get("store_url")

        update_available = bool(version) and _semver_lt(version, latest)
        force_update = bool(version) and _semver_lt(version, minimum)

        return {
            "enabled": True,
            "updateAvailable": update_available,
            "forceUpdate": force_update,
            "latestVersion": latest,
            "minVersion": minimum,
            "storeUrl": store_url,
            "message": row.get("message"),
        }
    except Exception as e:  # fail open — never block the app on a config read
        logger.warning("app-version policy lookup failed (%s): %s", plat, e)
        return no_update


@api_router.get("/builder-config")
async def get_builder_config(wallet_address: Optional[str] = None):
    """Get builder configuration for trades.

    If *wallet_address* is provided and the user has a rewards tier discount,
    the returned ``fee`` is reduced accordingly (but never below 0).
    """
    base_fee = BUILDER_FEE
    discount = 0
    if wallet_address and supabase:
        try:
            discount = await get_fee_discount_tenths(supabase, wallet_address)
        except Exception:
            pass  # non-critical
    effective_fee = max(0, base_fee - discount)
    return {
        "address": BUILDER_ADDRESS,
        "fee": effective_fee,
        "base_fee": base_fee,
        "discount": discount,
    }


# --------------------------------------------------------------------------- #
# Rewards & Referral endpoints
# --------------------------------------------------------------------------- #

@api_router.get("/rewards/profile")
async def rewards_profile_endpoint(
    wallet_address: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Get the full rewards profile for a user (points, tier, milestones, etc.)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    wallet = wallet_address.lower()
    await _assert_caller_owns_wallet(auth_user, wallet)
    try:
        profile = await get_rewards_profile(supabase, wallet)
        if "cash_kyc" not in (profile.achievements or []):
            try:
                link_res = await asyncio.to_thread(
                    lambda: supabase.table("ur_links")
                    .select("ur_id")
                    .ilike("evm_address", wallet)
                    .limit(1)
                    .execute()
                )
                rows = link_res.data or []
                if rows and rows[0].get("ur_id") is not None:
                    await _reconcile_cash_kyc_if_live(int(rows[0]["ur_id"]))
                    profile = await get_rewards_profile(supabase, wallet)
            except Exception:
                logger.debug(
                    "Cash KYC reconcile on rewards profile failed for %s",
                    wallet[:10], exc_info=True,
                )
        return profile.dict()
    except Exception as e:
        logger.error("Failed to get rewards profile for %s: %s", wallet[:10], e)
        raise HTTPException(status_code=500, detail="Failed to load rewards profile")


@api_router.post("/rewards/apply-referral")
async def apply_referral_endpoint(
    req: ApplyReferralRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Referee applies a referral code."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    await _assert_caller_owns_wallet(auth_user, req.wallet_address)
    try:
        result = await apply_referral_code(supabase, req.wallet_address, req.referral_code)
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Unknown error"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Apply referral failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to apply referral code")


@api_router.get("/rewards/referrals")
async def rewards_referrals_endpoint(
    wallet_address: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Get list of referred users."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    wallet = wallet_address.lower()
    await _assert_caller_owns_wallet(auth_user, wallet)
    try:
        refs = await get_referrals(supabase, wallet)
        return {"referrals": refs}
    except Exception as e:
        logger.error("Failed to get referrals for %s: %s", wallet[:10], e)
        raise HTTPException(status_code=500, detail="Failed to load referrals")


@api_router.get("/rewards/history")
async def rewards_history_endpoint(
    wallet_address: str,
    limit: int = 50,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Get point transaction history."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    wallet = wallet_address.lower()
    await _assert_caller_owns_wallet(auth_user, wallet)
    try:
        history = await get_point_history(supabase, wallet, limit)
        return {"history": history}
    except Exception as e:
        logger.error("Failed to get point history for %s: %s", wallet[:10], e)
        raise HTTPException(status_code=500, detail="Failed to load point history")


@api_router.get("/rewards/leaderboard")
async def rewards_leaderboard_endpoint(
    limit: int = 20,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Get top users by points."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    try:
        board = await get_leaderboard(supabase, limit)
        return {"leaderboard": board}
    except Exception as e:
        logger.error("Failed to get leaderboard: %s", e)
        raise HTTPException(status_code=500, detail="Failed to load leaderboard")


@api_router.get("/rewards/achievements")
async def rewards_achievements_list():
    """Get all available achievements + volume milestones + tier info."""
    return {
        "achievements": {
            k: {"id": k, **v} for k, v in ACHIEVEMENTS.items()
        },
        "volume_milestones": VOLUME_MILESTONES,
        "cash_volume_milestones": CASH_VOLUME_MILESTONES,
        "tiers": TIERS,
    }


class SimulateCashRewardRequest(BaseModel):
    kind: str            # "kyc" | "deposit" | "card_spend"
    amount_usd: float = 100.0


# TODO(prod): DEV-ONLY cash-rewards simulator. It is gated on
# ENABLE_UR_TEST_WALLET_IMPORT (your existing UR test toggle), so it AUTO-
# DISABLES in production the moment that flag is off. If you ever need UR test
# import ON but this simulator OFF, swap the gate below for a dedicated flag
# (e.g. ENABLE_REWARDS_SIM). Remove this endpoint entirely before GA if desired.
@api_router.post("/rewards/dev/simulate-cash", include_in_schema=False)
async def rewards_dev_simulate_cash(
    req: SimulateCashRewardRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Simulate a UR banking webhook for the LOGGED-IN test user so cash rewards
    can be exercised without UR actually firing a webhook. Credits the user's
    linked URID via the exact same code paths as the real webhook hooks."""
    if not privy_import.is_ur_test_wallet_import_enabled():
        raise HTTPException(
            status_code=403,
            detail="Disabled. Set ENABLE_UR_TEST_WALLET_IMPORT=1 to use the rewards simulator.",
        )
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")

    link = await asyncio.to_thread(
        ur_db.get_link_by_privy_user, supabase, auth_user.user_id
    )
    if not link or link.get("ur_id") is None:
        raise HTTPException(status_code=400, detail="No URID linked to this user")
    ur_id = int(link["ur_id"])

    kind = (req.kind or "").strip().lower()
    if kind == "kyc":
        await _award_cash_kyc(ur_id)
    elif kind in ("deposit", "card_spend"):
        # Unique key per call so repeated sims each credit (real txs dedupe on
        # txHash). Lets you click "deposit $X" N times to cross milestones.
        await _award_cash_reward(
            ur_id=ur_id, amount_str=str(req.amount_usd), currency="USD",
            tx_hash="", kind=kind, fallback_key=f"sim:{uuid.uuid4().hex}",
        )
    else:
        raise HTTPException(
            status_code=400, detail="kind must be 'kyc', 'deposit', or 'card_spend'",
        )

    wallet = await _ur_reward_wallet_for_urid(ur_id)
    profile = await get_rewards_profile(supabase, wallet) if wallet else None
    return {
        "ok": True, "ur_id": ur_id, "reward_wallet": wallet, "kind": kind,
        "amount_usd": req.amount_usd if kind != "kyc" else None,
        "profile": profile.dict() if profile else None,
    }


class ReportTradeRequest(BaseModel):
    wallet_address: str


# HL `userFillsByTime` costs weight 20+ per call.  Backend shares a single
# IP with a 1200 weight/min budget, so we cap syncs to once per 60s per
# wallet to leave headroom for trading / market-data calls.
_REWARDS_SYNC_MIN_INTERVAL_S = 60  # At most once per 60 seconds per user
_VOLUME_WM_MASTER = "master"
_MAX_REWARD_DEDICATED_SUBS = 10


def _sum_fill_notional(fills: Any) -> Tuple[float, int]:
    """(notional_usd, latest_fill_ms) from HL userFills rows."""
    verified = 0.0
    latest = 0
    if not isinstance(fills, list):
        return 0.0, 0
    for fill in fills:
        try:
            px = float(fill.get("px", 0))
            sz = abs(float(fill.get("sz", 0)))
            fill_ts = int(fill.get("time", 0))
            verified += px * sz
            if fill_ts > latest:
                latest = fill_ts
        except (TypeError, ValueError):
            continue
    return verified, latest


def _volume_sync_watermarks(profile: Dict[str, Any]) -> Dict[str, int]:
    raw = profile.get("volume_sync_watermarks") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            raw = {}
    out: Dict[str, int] = {}
    if isinstance(raw, dict):
        for key, val in raw.items():
            try:
                out[str(key).lower()] = int(val)
            except (TypeError, ValueError):
                continue
    if _VOLUME_WM_MASTER not in out:
        try:
            out[_VOLUME_WM_MASTER] = int(profile.get("last_volume_sync_at") or 0)
        except (TypeError, ValueError):
            out[_VOLUME_WM_MASTER] = 0
    return out


async def _verified_dedicated_subs_for_master(master: str) -> List[str]:
    """Dedicated AI subs that HL says belong to ``master``.

    Intersect our DB (this master's dedicated agents) with HL ``subAccounts``.
    Fail closed on either lookup — never credit a client-supplied or
    unowned address (volume-stealing / watermark games).
    """
    master_l = (master or "").lower()
    if not master_l.startswith("0x") or len(master_l) != 42:
        return []
    owned: set[str] = set()
    try:
        import ai_agents as _ai_agents_mod

        entries = await _ai_agents_mod.list_hl_sub_accounts(master_l, testnet=False)
        for entry in entries:
            addr = str(entry.get("subAccountUser") or "").lower()
            if addr.startswith("0x") and len(addr) == 42 and addr != master_l:
                owned.add(addr)
    except Exception as e:
        logger.warning(
            "Rewards sync: HL subAccounts lookup failed for %s: %s",
            master_l[:10],
            e,
        )
        return []
    if not owned or not supabase:
        return []
    try:
        res = await asyncio.to_thread(
            lambda: (
                supabase.table("ai_agents")
                .select("hl_master_address, hl_subaccount_address, trading_env")
                .eq("mode", "dedicated")
                .ilike("hl_master_address", master_l)
                .execute()
            )
        )
    except Exception as e:
        logger.warning("Rewards sync: dedicated agent lookup failed: %s", e)
        return []

    verified: List[str] = []
    seen: set[str] = set()
    for row in res.data or []:
        if str(row.get("trading_env") or "mainnet") == "demo":
            continue
        if str(row.get("hl_master_address") or "").lower() != master_l:
            continue
        sub = str(row.get("hl_subaccount_address") or "").lower()
        if sub not in owned or sub in seen:
            continue
        seen.add(sub)
        verified.append(sub)
        if len(verified) >= _MAX_REWARD_DEDICATED_SUBS:
            break
    return verified


async def _run_trade_volume_sync(wallet: str) -> Dict[str, Any]:
    """Perform a single Hyperliquid trade-volume sync for ``wallet``.

    Fetches verified fills from Hyperliquid (master + HL-owned Dedicated
    subs), sums the volume delta, persists per-address watermarks, and
    awards rewards. Never trusts any frontend-reported numbers or
    unowned sub addresses.

    Returns the same payload shape the endpoint used to return so the
    worker can reuse the logic.
    """
    profile = await ensure_rewards_profile(supabase, wallet)
    watermarks = _volume_sync_watermarks(profile)
    last_sync_ts = watermarks.get(_VOLUME_WM_MASTER, 0) or 0

    now_ms = int(time.time() * 1000)
    if last_sync_ts > 0 and (now_ms - int(last_sync_ts)) < _REWARDS_SYNC_MIN_INTERVAL_S * 1000:
        return {"volume_updated": 0, "new_achievements": [], "points_earned": 0, "skipped": "rate_limited"}

    verified_volume = 0.0
    next_watermarks = dict(watermarks)

    try:
        start_ms = int(last_sync_ts) if last_sync_ts > 0 else 0
        hl_fills = await fetch_hyperliquid("userFillsByTime", {
            "user": wallet,
            "startTime": start_ms,
        }) or []
    except Exception as e:
        logger.warning("Failed to fetch HL fills for rewards sync %s: %s", wallet[:10], e)
        return {"volume_updated": 0, "new_achievements": [], "points_earned": 0, "skipped": "hl_fetch_error"}

    master_vol, master_latest = _sum_fill_notional(hl_fills)
    verified_volume += master_vol
    if master_latest > last_sync_ts:
        next_watermarks[_VOLUME_WM_MASTER] = master_latest + 1

    for sub in await _verified_dedicated_subs_for_master(wallet):
        sub_start = int(next_watermarks.get(sub, 0) or 0)
        try:
            sub_fills = await fetch_hyperliquid("userFillsByTime", {
                "user": sub,
                "startTime": sub_start,
            }) or []
        except Exception as e:
            logger.warning(
                "Rewards sync: dedicated sub fills failed %s: %s",
                sub[:10],
                e,
            )
            continue
        sub_vol, sub_latest = _sum_fill_notional(sub_fills)
        verified_volume += sub_vol
        if sub_latest > sub_start:
            next_watermarks[sub] = sub_latest + 1

    if verified_volume <= 0:
        return {"volume_updated": 0, "new_achievements": [], "points_earned": 0}

    master_cursor = int(next_watermarks.get(_VOLUME_WM_MASTER, last_sync_ts) or last_sync_ts)
    await asyncio.to_thread(lambda: supabase.table("user_rewards").update({
        "last_volume_sync_at": master_cursor,
        "volume_sync_watermarks": next_watermarks,
    }).eq("wallet_address", wallet).execute())

    return await on_trade_completed(supabase, wallet, verified_volume)


@api_router.post("/rewards/report-trade")
async def rewards_report_trade_endpoint(
    req: ReportTradeRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Enqueue an HL trade-volume sync for rewards tracking.

    Called by the frontend after a successful Hyperliquid order.
    The heavy work (Hyperliquid ``userFillsByTime`` + award logic) is
    deferred to the backend alert-worker loop so this endpoint is a
    single Supabase upsert — keeping the shared Hyperliquid IP rate-
    limit budget safe even when many users trade at once.

    All existing frontend call sites already treat the response as
    fire-and-forget (``.catch(() => {})``) and only read the returned
    shape to surface counters that are re-fetched from ``/rewards/profile``,
    so returning ``{queued: true, ...zeros}`` is backward compatible.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")

    wallet = req.wallet_address.lower()
    await _assert_caller_owns_wallet(auth_user, wallet)

    try:
        await asyncio.to_thread(lambda: supabase.table("pending_trade_syncs").upsert(
            {
                "wallet_address": wallet,
                "enqueued_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="wallet_address",
        ).execute())
    except Exception as e:
        logger.warning("Failed to enqueue trade sync for %s: %s", wallet[:10], e)

    return {
        "volume_updated": 0,
        "new_achievements": [],
        "points_earned": 0,
        "queued": True,
    }


# ── Worker: drain the trade-sync queue ───────────────────────────────── #
# Hyperliquid enforces a global ~1200 weight/min rate limit per IP, and
# userFillsByTime has weight 20. We cap this drain at a conservative
# share of that budget so other REST fetches (metadata, clearinghouse
# fallbacks, etc.) retain headroom.
_TRADE_SYNC_BATCH_SIZE = 15          # up to 15 wallets processed per cycle
_TRADE_SYNC_MAX_ATTEMPTS = 5         # drop a row after repeated HL errors


async def _drain_trade_sync_queue() -> None:
    """Pop up to ``_TRADE_SYNC_BATCH_SIZE`` oldest wallets and run a
    volume sync for each. Called from the alert-worker loop on the
    leader replica only (so multiple replicas never duplicate work).
    """
    if not supabase:
        return

    try:
        res = await asyncio.to_thread(lambda: (
            supabase.table("pending_trade_syncs")
            .select("wallet_address, attempts")
            .order("enqueued_at", desc=False)
            .limit(_TRADE_SYNC_BATCH_SIZE)
            .execute()
        ))
    except Exception as e:
        logger.warning("Trade-sync drain: failed to read queue: %s", e)
        return

    rows = res.data or []
    if not rows:
        return

    logger.info("Trade-sync drain: processing %d wallet(s)", len(rows))

    for row in rows:
        wallet = (row.get("wallet_address") or "").lower()
        attempts = int(row.get("attempts") or 0)
        if not wallet:
            continue

        try:
            await _run_trade_volume_sync(wallet)
            # Success (or harmless skip) — remove from queue.
            await asyncio.to_thread(lambda w=wallet: supabase.table(
                "pending_trade_syncs"
            ).delete().eq("wallet_address", w).execute())
        except Exception as e:
            new_attempts = attempts + 1
            if new_attempts >= _TRADE_SYNC_MAX_ATTEMPTS:
                logger.error(
                    "Trade-sync drain: dropping %s after %d attempts: %s",
                    wallet[:10], new_attempts, e,
                )
                try:
                    await asyncio.to_thread(lambda w=wallet: supabase.table(
                        "pending_trade_syncs"
                    ).delete().eq("wallet_address", w).execute())
                except Exception:
                    pass
            else:
                logger.warning(
                    "Trade-sync drain: %s attempt %d failed: %s",
                    wallet[:10], new_attempts, e,
                )
                try:
                    await asyncio.to_thread(lambda w=wallet, n=new_attempts, err=str(e)[:500]: supabase.table(
                        "pending_trade_syncs"
                    ).update({
                        "attempts": n,
                        "last_error": err,
                    }).eq("wallet_address", w).execute())
                except Exception:
                    pass


@api_router.post("/bridge2/deposit-with-permit")
async def bridge2_deposit_with_permit(
    req: Bridge2PermitDepositRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Gasless Bridge2 deposit using a USDC permit signature.

    The user signs an EIP-2612 Permit off-chain; the backend relayer submits
    `batchedDepositWithPermit` and pays Arbitrum gas.
    See: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
    
    Requires authentication via Privy access token.
    """
    logger.info(f"Bridge2 deposit request from Privy user: {auth_user.user_id}, wallet: {req.user}")
    await _assert_caller_owns_wallet(auth_user, req.user)
    # Ensure user has a rewards profile (creates one on first deposit)
    if supabase:
        asyncio.ensure_future(
            ensure_rewards_profile(supabase, req.user)
        )
    try:
        tx_hash = await asyncio.to_thread(_bridge2_batched_deposit_with_permit_sync, req)
        return {"ok": True, "txHash": tx_hash}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except ContractLogicError as e:
        # On-chain revert (e.g. invalid permit signature/nonce/deadline).
        logger.exception("Bridge2 permit deposit reverted")
        raise HTTPException(status_code=400, detail=f"Bridge2 revert: {str(e)}")
    except Exception as e:
        # Common cases: insufficient relayer ETH, RPC issues, bad tx params.
        logger.exception("Bridge2 permit deposit failed")
        # Safe to surface the error string; it won't include private keys.
        raise HTTPException(status_code=500, detail=f"Bridge2 permit deposit failed: {str(e)}")


@api_router.get("/wallet/relayer-address")
async def get_relayer_address(user: Optional[str] = None):
    """Return the relayer address (spender) the client should sign its permit for.

    With multiple relayers configured, the caller MUST pass ?user=<wallet_address>
    so the server can return the deterministically-assigned relayer for that
    user. The mapping is stable (SHA-256 of the lowercased checksum address),
    so every request for the same user always returns the same relayer as
    long as the relayer pool is unchanged.

    For backwards compatibility, if only one relayer is configured, the `user`
    parameter is optional.
    """
    if not _RELAYER_ADDRESSES:
        raise HTTPException(status_code=501, detail="Relayer not configured")

    if user:
        try:
            relayer_addr, _ = select_relayer_for_user(user)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {
            "relayer": relayer_addr,
            "userAddress": Web3.to_checksum_address(user),
            "poolSize": len(_RELAYER_ADDRESSES),
        }

    if len(_RELAYER_ADDRESSES) == 1:
        return {"relayer": _RELAYER_ADDRESSES[0], "poolSize": 1}

    raise HTTPException(
        status_code=400,
        detail=(
            "Multiple relayers configured. Pass ?user=<wallet_address> to receive "
            "your assigned relayer."
        ),
    )


@api_router.post("/wallet/transfer-with-permit")
async def wallet_transfer_with_permit(
    req: WalletTransferRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Gasless USDC transfer from wallet to external address using permit signature.

    The user signs an EIP-2612 Permit off-chain approving the relayer;
    the backend relayer executes permit + transferFrom and pays Arbitrum gas.
    
    Requires authentication via Privy access token.
    """
    logger.info(f"Wallet transfer request from Privy user: {auth_user.user_id}, wallet: {req.user}, to: {req.destination}")
    await _assert_caller_owns_wallet(auth_user, req.user)
    try:
        tx_hash = await asyncio.to_thread(_wallet_transfer_with_permit_sync, req)
        return {"ok": True, "txHash": tx_hash}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except ContractLogicError as e:
        logger.exception("Wallet transfer reverted")
        raise HTTPException(status_code=400, detail=f"Transfer revert: {str(e)}")
    except Exception as e:
        logger.exception("Wallet transfer failed")
        raise HTTPException(status_code=500, detail=f"Wallet transfer failed: {str(e)}")


@api_router.get("/wallet/transfer-limit")
async def get_transfer_limit_status(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
    wallet_address: str = None,
):
    """
    Get the user's current transfer rate limit status.
    Returns remaining transfers and reset time.
    """
    if not wallet_address:
        raise HTTPException(status_code=400, detail="wallet_address query param required")
    
    if not supabase:
        # If Supabase not configured, return unlimited
        return {
            "max": TRANSFER_RATE_LIMIT_MAX,
            "used": 0,
            "remaining": TRANSFER_RATE_LIMIT_MAX,
            "resetInSeconds": None,
            "windowHours": TRANSFER_RATE_LIMIT_WINDOW_SECONDS // 3600,
        }
    
    user_key = wallet_address.lower()
    current_time = datetime.utcnow()
    cutoff_time = current_time - timedelta(seconds=TRANSFER_RATE_LIMIT_WINDOW_SECONDS)
    
    try:
        result = await asyncio.to_thread(lambda: supabase.table('transfer_rate_limits').select('transferred_at').eq(
            'user_address', user_key
        ).gte('transferred_at', cutoff_time.isoformat()).order('transferred_at', desc=False).execute())
        
        recent_transfers = result.data if result.data else []
        used_count = len(recent_transfers)
        remaining = max(0, TRANSFER_RATE_LIMIT_MAX - used_count)
        
        # Calculate reset time (when oldest transfer expires from window)
        reset_in_seconds = None
        if recent_transfers:
            oldest = datetime.fromisoformat(recent_transfers[0]['transferred_at'].replace('Z', '+00:00'))
            reset_time = oldest + timedelta(seconds=TRANSFER_RATE_LIMIT_WINDOW_SECONDS)
            reset_in_seconds = max(0, int((reset_time - datetime.now(oldest.tzinfo)).total_seconds()))
        
        return {
            "max": TRANSFER_RATE_LIMIT_MAX,
            "used": used_count,
            "remaining": remaining,
            "resetInSeconds": reset_in_seconds,
            "windowHours": TRANSFER_RATE_LIMIT_WINDOW_SECONDS // 3600,
        }
    except Exception as e:
        logger.error(f"Failed to get transfer limit status: {e}", exc_info=True)
        # On error, return default (allow transfers)
        return {
            "max": TRANSFER_RATE_LIMIT_MAX,
            "used": 0,
            "remaining": TRANSFER_RATE_LIMIT_MAX,
            "resetInSeconds": None,
            "windowHours": TRANSFER_RATE_LIMIT_WINDOW_SECONDS // 3600,
        }


@api_router.get("/dexes")
async def get_perp_dexes():
    """Get all available perpetual DEXes including HIP-3"""
    data = await fetch_hyperliquid("perpDexs")
    # Filter out null entries and return DEX info
    dexes = [d for d in data if d is not None]
    return {"dexes": dexes, "hip3_dexes": HIP3_DEXES}


@api_router.get("/assets")
async def get_hip3_assets():
    """Get all HIP-3 RWA assets with current prices"""
    assets = []
    
    # Fetch from each known HIP-3 DEX
    for dex_name in HIP3_DEXES:
        try:
            data = await _get_meta_and_asset_ctxs(dex=dex_name)
            
            if not data or len(data) < 2:
                logger.warning(f"Invalid data structure from {dex_name}")
                continue
            
            meta = data[0]
            asset_ctxs = data[1]
            universe = meta.get("universe", [])
            
            for i, asset in enumerate(universe):
                coin_name = asset.get("name", "")
                # Extract the symbol (remove dex prefix like "xyz:" / "io:")
                symbol = coin_name.split(":")[-1] if ":" in coin_name else coin_name
                
                # Get asset context (price data)
                ctx = asset_ctxs[i] if i < len(asset_ctxs) else {}
                
                display_key, meta_info = _lookup_hip3_metadata(symbol, dex_name)
                display_symbol = display_key or symbol
                
                # Skip assets that are not in ASSET_METADATA for this dex
                if meta_info is None:
                    continue
                
                # Use displayName if available (for CL -> OIL, USDJPYUSDC -> JPY, etc.)
                if meta_info.get("displayName"):
                    display_symbol = meta_info.get("displayName")
                
                # Calculate 24h change
                mark_px = ctx.get("markPx")
                prev_day_px = ctx.get("prevDayPx")
                change_24h = None
                
                if mark_px and prev_day_px:
                    try:
                        current = float(mark_px)
                        previous = float(prev_day_px)
                        if previous > 0:
                            change_24h = ((current - previous) / previous) * 100
                    except (ValueError, ZeroDivisionError):
                        pass
                
                asset_info = AssetInfo(
                    coin=coin_name,
                    name=meta_info["name"],
                    symbol=display_symbol,
                    category=meta_info["category"],
                    maxLeverage=asset.get("maxLeverage", 1),
                    szDecimals=asset.get("szDecimals", 2),
                    markPx=mark_px,
                    prevDayPx=prev_day_px,
                    dayNtlVlm=ctx.get("dayNtlVlm"),
                    openInterest=ctx.get("openInterest"),
                    funding=ctx.get("funding"),
                    change24h=change_24h,
                    isHip3=True,
                    isPreIpo=bool(meta_info.get("isPreIpo")),
                    dex=dex_name,
                    growthMode=_normalize_growth_mode(asset.get("growthMode")),
                    deployerFeeScale=_normalize_deployer_fee_scale(asset.get("deployerFeeScale")),
                    **_pre_ipo_catalog_fields(meta_info),
                )
                assets.append(asset_info)
                
        except Exception as e:
            logger.error(f"Error fetching {dex_name} assets: {e}")
            continue
    
    # ── Append non-crypto spot-only assets (e.g. GOLDSPOT in commodity) ──
    if _NON_CRYPTO_SPOT_ONLY:
        try:
            spot_data = await _get_spot_meta_and_asset_ctxs()
            if spot_data and isinstance(spot_data, list) and len(spot_data) >= 2:
                spot_meta_data = spot_data[0]
                spot_ctxs = spot_data[1] or []
                spot_universe = spot_meta_data.get("universe", [])
                spot_tokens = spot_meta_data.get("tokens", [])

                for so_coin in _NON_CRYPTO_SPOT_ONLY:
                    spot_name = _resolve_spot_coin(_get_hl_base_coin(so_coin), spot_universe, spot_tokens)
                    if not spot_name:
                        continue
                    ctx = next(
                        (c for c in spot_ctxs if str(c.get("coin", "")).upper() == spot_name.upper()),
                        {},
                    )
                    if not ctx:
                        idx = next(
                            (j for j, u in enumerate(spot_universe) if u.get("name") == spot_name),
                            None,
                        )
                        if idx is not None and idx < len(spot_ctxs):
                            ctx = spot_ctxs[idx]

                    spot_entry = next((u for u in spot_universe if u.get("name") == spot_name), {})
                    so_meta_info = ASSET_METADATA.get(so_coin, {"name": so_coin, "symbol": so_coin, "category": "commodity"})
                    mark_px = ctx.get("markPx")
                    prev_day_px = ctx.get("prevDayPx")
                    change_24h = None
                    if mark_px and prev_day_px:
                        try:
                            current = float(mark_px)
                            previous = float(prev_day_px)
                            if previous > 0:
                                change_24h = ((current - previous) / previous) * 100
                        except (ValueError, ZeroDivisionError):
                            pass

                    assets.append(AssetInfo(
                        coin=so_coin,
                        name=so_meta_info["name"],
                        symbol=so_meta_info.get("displayName", so_meta_info["symbol"]),
                        category=so_meta_info["category"],
                        maxLeverage=1,
                        szDecimals=spot_entry.get("szDecimals", 2),
                        markPx=mark_px,
                        prevDayPx=prev_day_px,
                        dayNtlVlm=ctx.get("dayNtlVlm"),
                        openInterest=None,
                        funding=None,
                        change24h=change_24h,
                        isHip3=False,
                        isSpotOnly=True,
                        hasSpot=True,
                        spotSymbol=spot_name,
                    ))
        except Exception as e:
            logger.warning(f"Failed to fetch non-crypto spot-only assets for /assets: {e}")

    return {"assets": [a.dict() for a in assets], "count": len(assets)}


@api_router.get("/assets/{coin}")
async def get_asset_detail(coin: str):
    """Get detailed information for a specific asset"""

    # ── Spot-only assets (no perp market) ─────────────────────────────
    if coin in SPOT_ONLY_COINS:
        try:
            spot_data = await _get_spot_meta_and_asset_ctxs()
            if not spot_data or not isinstance(spot_data, list) or len(spot_data) < 2:
                raise HTTPException(status_code=404, detail="Spot asset not found")

            spot_meta = spot_data[0]
            spot_ctxs = spot_data[1] or []
            spot_universe = spot_meta.get("universe", [])
            spot_tokens = spot_meta.get("tokens", [])

            spot_name = _resolve_spot_coin(_get_hl_base_coin(coin), spot_universe, spot_tokens)
            if not spot_name:
                raise HTTPException(status_code=404, detail="Spot asset not found")

            ctx = next(
                (c for c in spot_ctxs if str(c.get("coin", "")).upper() == spot_name.upper()),
                {},
            )
            if not ctx:
                idx = next(
                    (i for i, u in enumerate(spot_universe) if u.get("name") == spot_name),
                    None,
                )
                if idx is not None and idx < len(spot_ctxs):
                    ctx = spot_ctxs[idx]

            entry = next((u for u in spot_universe if u.get("name") == spot_name), {})
            meta_info = (
                CRYPTO_METADATA.get(coin)
                or ASSET_METADATA.get(coin)
                or {"name": coin, "symbol": coin, "category": "crypto"}
            )

            mark_px = ctx.get("markPx")
            prev_day_px = ctx.get("prevDayPx")
            change_24h = None
            if mark_px and prev_day_px:
                try:
                    current = float(mark_px)
                    previous = float(prev_day_px)
                    if previous > 0:
                        change_24h = ((current - previous) / previous) * 100
                except (ValueError, ZeroDivisionError):
                    pass

            return {
                "coin": coin,
                "name": meta_info["name"],
                "symbol": meta_info.get("displayName", meta_info["symbol"]),
                "category": meta_info.get("category", "crypto"),
                "maxLeverage": 1,
                "szDecimals": entry.get("szDecimals", 2),
                "markPx": mark_px,
                "prevDayPx": prev_day_px,
                "dayNtlVlm": ctx.get("dayNtlVlm"),
                "openInterest": None,
                "funding": None,
                "oraclePx": None,
                "midPx": ctx.get("midPx"),
                "impactPxs": ctx.get("impactPxs"),
                "change24h": change_24h,
                "isHip3": False,
                "isSpotOnly": True,
                "hasSpot": True,
                "spotSymbol": spot_name,
            }

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error fetching spot-only asset {coin}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # If this is a main-exchange asset (crypto/forex), do NOT force a HIP-3 dex prefix.
    # These assets are returned by `metaAndAssetCtxs` without a `dex` parameter.
    if coin in CRYPTO_COINS or coin in FOREX_COINS:
        try:
            data = await _get_meta_and_asset_ctxs(dex=None)

            if not data or len(data) < 2:
                raise HTTPException(status_code=404, detail="Asset not found")

            meta = data[0]
            asset_ctxs = data[1]
            universe = meta.get("universe", [])

            resolved = _resolve_main_coin(coin, universe)
            if not resolved:
                raise HTTPException(status_code=404, detail="Asset not found")

            for i, asset in enumerate(universe):
                if asset.get("name") == resolved:
                    ctx = asset_ctxs[i] if i < len(asset_ctxs) else {}

                    if coin in CRYPTO_COINS:
                        meta_info = CRYPTO_METADATA.get(coin, {"name": coin, "symbol": coin, "category": "crypto"})
                        category = "crypto"
                    else:
                        meta_info = FOREX_METADATA.get(coin, {"name": coin, "symbol": coin, "category": "forex"})
                        category = "forex"

                    mark_px = ctx.get("markPx")
                    prev_day_px = ctx.get("prevDayPx")
                    change_24h = None

                    if mark_px and prev_day_px:
                        try:
                            current = float(mark_px)
                            previous = float(prev_day_px)
                            if previous > 0:
                                change_24h = ((current - previous) / previous) * 100
                        except (ValueError, ZeroDivisionError):
                            pass

                    # Check if this perp asset also has a spot market
                    has_spot = False
                    resolved_spot_name = None
                    if category == "crypto":
                        try:
                            _spot_d = await _get_spot_meta_and_asset_ctxs()
                            if _spot_d and isinstance(_spot_d, list) and len(_spot_d) >= 2:
                                _s_m = _spot_d[0]
                                resolved_spot_name = _resolve_spot_coin(coin, _s_m.get("universe", []), _s_m.get("tokens", []))
                                if resolved_spot_name:
                                    has_spot = True
                        except Exception:
                            pass

                    result = {
                        "coin": coin,
                        "name": meta_info["name"],
                        "symbol": meta_info["symbol"],
                        "category": category,
                        "maxLeverage": asset.get("maxLeverage", 50),
                        "szDecimals": asset.get("szDecimals", 4 if category == "crypto" else 0),
                        "markPx": mark_px,
                        "prevDayPx": prev_day_px,
                        "dayNtlVlm": ctx.get("dayNtlVlm"),
                        "openInterest": ctx.get("openInterest"),
                        "funding": ctx.get("funding"),
                        "oraclePx": ctx.get("oraclePx"),
                        "midPx": ctx.get("midPx"),
                        "impactPxs": ctx.get("impactPxs"),
                        "change24h": change_24h,
                        "isHip3": False,
                    }
                    if has_spot:
                        result["hasSpot"] = True
                        result["spotSymbol"] = resolved_spot_name
                    return result

            raise HTTPException(status_code=404, detail="Asset not found")

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error fetching asset {coin}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # Check if coin is a display symbol (e.g., "NDX100") that needs to be resolved to actual coin name
    original_coin = coin
    if coin not in CRYPTO_COINS and coin not in FOREX_COINS and ":" not in coin:
        coin = _prefix_catalog_hip3_coin(coin)
    
    # Determine if this is a HIP-3 asset by checking prefix
    dex_name = ""
    if ":" in coin:
        dex_name = coin.split(":")[0]
    else:
        coin = _prefix_catalog_hip3_coin(coin)
        dex_name = coin.split(":")[0] if ":" in coin else (HIP3_DEXES[0] if HIP3_DEXES else "xyz")
    
    try:
        data = await _get_meta_and_asset_ctxs(dex=dex_name)
        
        if not data or len(data) < 2:
            raise HTTPException(status_code=404, detail="Asset not found")
        
        meta = data[0]
        asset_ctxs = data[1]
        universe = meta.get("universe", [])
        
        for i, asset in enumerate(universe):
            if asset.get("name") == coin:
                ctx = asset_ctxs[i] if i < len(asset_ctxs) else {}
                symbol = coin.split(":")[-1]
                
                display_key, meta_info = _lookup_hip3_metadata(symbol, dex_name)
                display_symbol = display_key or symbol
                
                if meta_info is None:
                    continue
                
                # Use displayName if available (for XYZ100 -> NDX100, CL -> OIL, etc.)
                if meta_info.get("displayName"):
                    display_symbol = meta_info["displayName"]
                
                mark_px = ctx.get("markPx")
                prev_day_px = ctx.get("prevDayPx")
                change_24h = None
                
                if mark_px and prev_day_px:
                    try:
                        current = float(mark_px)
                        previous = float(prev_day_px)
                        if previous > 0:
                            change_24h = ((current - previous) / previous) * 100
                    except (ValueError, ZeroDivisionError):
                        pass
                
                # For stocks, try to get earnings date from Alpha Vantage cache
                next_earnings = None
                if meta_info["category"] == "stock":
                    next_earnings = _get_cached_earnings_date(display_symbol)
                
                return {
                    "coin": coin,
                    "name": meta_info["name"],
                    "symbol": display_symbol,
                    "category": meta_info["category"],
                    "maxLeverage": asset.get("maxLeverage", 1),
                    "szDecimals": asset.get("szDecimals", 2),
                    "markPx": mark_px,
                    "prevDayPx": prev_day_px,
                    "dayNtlVlm": ctx.get("dayNtlVlm"),
                    "openInterest": ctx.get("openInterest"),
                    "funding": ctx.get("funding"),
                    "oraclePx": ctx.get("oraclePx"),
                    "midPx": ctx.get("midPx"),
                    "impactPxs": ctx.get("impactPxs"),
                    "change24h": change_24h,
                    "isHip3": True,
                    "isPreIpo": bool(meta_info.get("isPreIpo")),
                    "dex": dex_name,
                    "marginMode": asset.get("marginMode"),
                    "growthMode": _normalize_growth_mode(asset.get("growthMode")),
                    "deployerFeeScale": _normalize_deployer_fee_scale(asset.get("deployerFeeScale")),
                    "nextEarnings": next_earnings,
                    **_pre_ipo_catalog_fields(meta_info),
                }
        
        raise HTTPException(status_code=404, detail="Asset not found")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching asset {coin}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _pick_next_earnings_date(rows: List[Dict[str, Any]], symbol: str) -> Optional[str]:
    if not rows:
        return None
    today = datetime.utcnow().date()
    candidates = []
    for row in rows:
        if str(row.get("symbol", "")).upper() != symbol:
            continue
        date_str = row.get("reportDate") or row.get("report_date") or row.get("report_date_utc")
        if not date_str:
            continue
        try:
            report_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        if report_date >= today:
            candidates.append(report_date)
    if not candidates:
        return None
    return min(candidates).isoformat()


def _get_cached_earnings_date(symbol: str) -> Optional[str]:
    """
    Get next earnings date.  Priority:
      1. In-memory persistent cache (_earnings_mem_cache) — fast, survives daily key rotation.
      2. Supabase earnings_cache table — survives server restarts.
      3. Original _alpha_cache (same-day fallback).
    Returns an ISO date string or None.
    """
    import time as _time
    sym = symbol.upper()
    today_iso = datetime.utcnow().date().isoformat()

    # --- 1. In-memory persistent cache ---
    mem = _earnings_mem_cache.get(sym)
    if mem:
        date_str, fetched_ts = mem
        if (_time.time() - fetched_ts) < _EARNINGS_MEM_TTL:
            # Only return if the date is still in the future (or today)
            if date_str and date_str >= today_iso:
                return date_str
            # Date already passed — treat as stale, fall through
        # TTL expired — fall through

    # --- 2. Supabase persistent cache ---
    if supabase:
        try:
            row = (
                supabase.table("earnings_cache")
                .select("next_earnings_date, fetched_at")
                .eq("symbol", sym)
                .maybe_single()
                .execute()
            )
            if row.data:
                db_date = row.data.get("next_earnings_date")  # "YYYY-MM-DD" or None
                if db_date and db_date >= today_iso:
                    # Populate mem cache so subsequent calls are fast
                    _earnings_mem_cache[sym] = (db_date, _time.time())
                    return db_date
        except Exception as e:
            logger.warning("earnings_cache Supabase read failed for %s: %s", sym, e)

    # --- 3. Legacy same-day _alpha_cache fallback ---
    cache_key = json.dumps(
        {"__date": today_iso, "function": "EARNINGS_CALENDAR", "symbol": sym, "datatype": "csv"},
        sort_keys=True,
    )
    cached = _alpha_cache.get(cache_key)
    if cached:
        result = _pick_next_earnings_date(cached, sym)
        if result:
            _earnings_mem_cache[sym] = (result, _time.time())
        return result

    return None


# COMMENTED OUT - Uses 4 API calls per request, eating into free tier limit
# @api_router.get("/alpha/stock-info/{symbol}")
# async def get_alpha_stock_info(symbol: str):
#     """Get lightweight fundamentals and next earnings date for a stock symbol."""
#     symbol = symbol.upper()
#     overview_task = fetch_alpha_vantage_json({"function": "OVERVIEW", "symbol": symbol})
#     balance_task = fetch_alpha_vantage_json({"function": "BALANCE_SHEET", "symbol": symbol})
#     cash_task = fetch_alpha_vantage_json({"function": "CASH_FLOW", "symbol": symbol})
#
#     overview, balance_sheet, cash_flow = await asyncio.gather(
#         overview_task, balance_task, cash_task
#     )
#
#     next_earnings_date = None
#     try:
#         earnings_rows = await fetch_alpha_vantage_csv({"function": "EARNINGS_CALENDAR", "symbol": symbol})
#         next_earnings_date = _pick_next_earnings_date(earnings_rows, symbol)
#     except HTTPException:
#         # Earnings calendar is best-effort; don't fail the entire request.
#         next_earnings_date = None
#
#     latest_balance = _pick_latest_report(balance_sheet.get("annualReports") or [])
#     latest_cash = _pick_latest_report(cash_flow.get("annualReports") or [])
#
#     return {
#         "symbol": symbol,
#         "overview": overview,
#         "latestBalanceSheet": latest_balance,
#         "latestCashFlow": latest_cash,
#         "nextEarningsDate": next_earnings_date,
#     }

_LANG_NAMES = {
    "en": "English", "ar": "Arabic", "es": "Spanish", "fr": "French",
    "id": "Indonesian", "ja": "Japanese", "ko": "Korean", "pt": "Portuguese",
    "ru": "Russian", "tr": "Turkish", "zh": "Chinese",
}

try:
    _NY_TZ = ZoneInfo("America/New_York")
    _NY_TZ_LABEL = "ET"
except Exception:
    _NY_TZ = timezone.utc
    _NY_TZ_LABEL = "UTC"
    logging.getLogger(__name__).warning(
        "tzdata missing America/New_York; Ask AI clock falling back to UTC weekdays"
    )
_US_REG_OPEN_MIN = 9 * 60 + 30
_US_REG_CLOSE_MIN = 16 * 60
_US_PRE_OPEN_MIN = 4 * 60
_US_AH_END_MIN = 20 * 60


def _weekday_on_or_before(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _previous_weekday(d: date) -> date:
    return _weekday_on_or_before(d - timedelta(days=1))


def _fmt_named_date(d: date) -> str:
    return datetime(d.year, d.month, d.day).strftime("%A, %B %d, %Y")


def _gemini_clock_context() -> Dict[str, Any]:
    """UTC + America/New_York clock so Ask AI cannot guess weekdays or cash sessions."""
    now_utc = datetime.now(timezone.utc)
    now_et = now_utc.astimezone(_NY_TZ)
    et_date = now_et.date()
    minutes = now_et.hour * 60 + now_et.minute
    wd = now_et.weekday()  # Mon=0 … Sun=6

    if wd >= 5:
        cash_phase = "weekend (US cash equities closed — no regular, pre-market, or after-hours session)"
        last_cash_close = _weekday_on_or_before(et_date)
    elif minutes < _US_PRE_OPEN_MIN:
        cash_phase = "US overnight / before pre-market"
        last_cash_close = _previous_weekday(et_date)
    elif minutes < _US_REG_OPEN_MIN:
        cash_phase = "US pre-market (regular cash session not open yet)"
        last_cash_close = _previous_weekday(et_date)
    elif minutes < _US_REG_CLOSE_MIN:
        cash_phase = "US regular cash session (open)"
        last_cash_close = _previous_weekday(et_date)
    elif minutes < _US_AH_END_MIN:
        cash_phase = "US after-hours (regular cash session already closed)"
        last_cash_close = et_date
    else:
        cash_phase = "US overnight (regular and after-hours finished)"
        last_cash_close = et_date

    xyz_external = True
    if wd == 5 or (wd == 4 and minutes >= _US_AH_END_MIN) or (wd == 6 and minutes < _US_AH_END_MIN):
        xyz_external = False

    nearby = []
    for offset in range(0, 4):
        day = et_date - timedelta(days=offset)
        nearby.append(_fmt_named_date(day))

    return {
        "now_et": now_et,
        "utc_stamp": now_utc.strftime("%A, %B %d, %Y %H:%M UTC"),
        "et_stamp": now_et.strftime(f"%A, %B %d, %Y %H:%M {_NY_TZ_LABEL}"),
        "cash_phase": cash_phase,
        "last_cash_close_label": _fmt_named_date(last_cash_close),
        "nearby_et_dates": nearby,
        "xyz_external": xyz_external,
    }


# Ask AI ticker collisions — Google Search often resolves these to a different issuer.
_GEMINI_ISSUER_HINTS: Dict[str, str] = {
    "ANTH": (
        "ANTH on this venue is Anthropic PBC, the American AI lab that builds Claude "
        "(founded by Dario Amodei). Search 'Anthropic AI', 'Anthropic Claude', "
        "'Anthropic valuation', 'Anthropic funding'. Do not analyze Anthera "
        "Pharmaceuticals, Anthracite, or any other listed/OTC name that uses ANTH."
    ),
}


def _asset_meta_for_symbol(symbol: str) -> Optional[Dict[str, Any]]:
    """Catalog row for a display/HL symbol (ASSET_METADATA key, symbol, or displayName)."""
    s = (symbol or "").upper()
    if not s:
        return None
    meta = ASSET_METADATA.get(s)
    if meta:
        return meta
    for row in ASSET_METADATA.values():
        if str(row.get("displayName", "")).upper() == s or str(row.get("symbol", "")).upper() == s:
            return row
    return None


def _gemini_instrument_context(symbol: str) -> Dict[str, Any]:
    """Company name + pre-IPO disambiguation so Search grounding does not pick a namesake ticker."""
    meta = _asset_meta_for_symbol(symbol)
    name = str((meta or {}).get("name") or symbol).strip() or symbol
    label = symbol if name.upper() == symbol.upper() else f"{symbol} ({name})"
    is_pre_ipo = bool((meta or {}).get("isPreIpo"))
    dex = _hip3_meta_dex(meta) if meta else ""
    lines = [
        f"- You are analyzing {label}. Google Search must target that issuer/asset. "
        "If a hit is a different company that merely shares a ticker or abbreviation, discard it."
    ]
    if is_pre_ipo:
        dex_bit = f" on the {dex} DEX" if dex else ""
        lines.append(
            f"- {symbol} is a Hyperliquid HIP-3 pre-IPO perpetual{dex_bit} for the private "
            f"company {name}. It is not a listed US cash equity. Do not use NYSE/Nasdaq/OTC "
            f"quotes, options flow, or SEC filings for ticker {symbol} — those belong to another issuer."
        )
    hint = _GEMINI_ISSUER_HINTS.get(symbol.upper())
    if hint:
        lines.append(f"- {hint}")
    return {
        "label": label,
        "name": name,
        "is_pre_ipo": is_pre_ipo,
        "identity_rules": "\n    ".join(lines),
    }


def _build_gemini_market_prompt(symbol: str, category: str, lang: str = "en") -> str:
    """
    Constructs a targeted prompt for Scalp/Swing verdicts using Google Search.
    """
    clock = _gemini_clock_context()
    nearby = clock["nearby_et_dates"]
    last_cash = clock["last_cash_close_label"]
    xyz_mode = "external (underlying-linked)" if clock["xyz_external"] else "internal / weekend pricing"
    ident = _gemini_instrument_context(symbol)
    subject = ident["label"]

    stock_session_rules = ""
    if category in ("stock", "index"):
        stock_session_rules = f"""
    US CASH SESSION CLOCK (America/New_York — do not guess weekdays):
    - Right now: {clock["et_stamp"]}. Cash session state: {clock["cash_phase"]}.
    - Nearby calendar dates (ET): {", ".join(nearby)}. Use these weekdays exactly. Never relabel a date (e.g. do not call a Sunday "Friday").
    - Most recent completed US regular cash session (09:30–16:00 ET, Mon–Fri only): {last_cash}. Saturday and Sunday have no NYSE/Nasdaq regular close.
    - Pre-market (~04:00–09:30 ET) and after-hours (~16:00–20:00 ET) exist on weekdays around that regular session — not on Saturday/Sunday.
    - HIP-3 equity perps (NVDA, AAPL, …) can still print when cash is shut. External hours are Sun 20:00 ET → Fri 20:00 ET; current perp pricing mode: {xyz_mode}. That is not US cash pre-market or a Friday close.
    - For "last close" / "Friday close" language, cite {last_cash}, not a weekend calendar date.
    """

    # BASE SYSTEM INSTRUCTION - Focus shifted to bias and timeframe
    base_instruction = f"""
    Today is {clock["utc_stamp"]} / {clock["et_stamp"]}. You are an elite Multi-Asset Proprietary Trader.
    Your GOAL: Provide a high-conviction directional bias (Long/Short/Neutral) for {subject} based on live Google Search data.
    
    DATA FRESHNESS RULE (CRITICAL):
    - Always try to find data for today first.
    - If today's US cash print is unavailable (weekend, holiday, or session not open yet), fall back to the most recent completed regular cash session: {last_cash}. Do NOT treat a Saturday or Sunday as a trading day, and do not invent a weekday for a date.
    - Nearby ET dates with weekdays: {", ".join(nearby)}.
    - For crypto: data is 24/7, so there should always be recent data.
    - Clearly state which date and which session (regular / pre-market / after-hours / HIP-3 external) the data is from.
    {stock_session_rules}

    TIME PERIODS: 
    - Scalp: 15m to 4h outlook.
    - Swing: 1d to 7d outlook.

    STRICT RULES:
    - No preamble. Start your response directly with the ## header. Do not say "Okay," "I will," or "Searching for."
    - USE GOOGLE SEARCH TOOL for real-time live analysis, no simulation of data since you are focused on very recent data.
    - Focus on the last 24-48 hours for Scalps and 7 days for Swings.
    - Be decisive. Avoid "it could go both ways" unless the data is perfectly neutral.
    - Do not hallucinate. If search fails for all dates, state "Data Gap".
    INSTRUMENT IDENTITY:
    {ident["identity_rules"]}
    """

    # CATEGORY SPECIFIC METRICS - Updated for "Verdict" logic
    if category == "crypto":
        metrics = """
        1. Momentum: 1h/4h RSI, Volume profile, and funding rate trend (Rising/Falling).
        2. Liquidations/OI: Map out where the "pain" is (Liquidation clusters above/below).
        3. Whale Flow: Recent large exchange net flows and Coinbase Premium.
        4. Macro: BTC/ETH correlation strength and DXY impact.
        """
    
    elif category == "stock" and ident["is_pre_ipo"]:
        metrics = """
        1. Private-company news for the named issuer: funding, valuation marks, secondaries, product launches.
        2. HIP-3 perp price vs operator bounds / market-cap quote convention — not a listed cash last print.
        3. Sector context only; never substitute a different listed ticker that shares this symbol.
        4. Catalysts: company-specific headlines (not options/dark-pool prints for a listed namesake).
        """

    elif category == "stock":
        metrics = """
        1. Price Action: Regular-session move vs HIP-3 perp; mention pre-market/after-hours only if the clock above says those windows are active. Relative strength vs SPY/QQQ.
        2. Flow: Unusual Options Activity (sweeps/blocks) and Dark Pool levels.
        3. Volatility: IV Rank vs realized vol – is the move "priced in"?
        4. Catalysts: Upcoming earnings, Fed speakers, or sector-specific news.
        """
    
    elif category == "commodity":
        metrics = """
        1. Yield/DXY Context: Correlation with 10Y yields and US Dollar strength.
        2. Supply/Demand: Weekly inventory (EIA/API for Oil, COMEX/LME for metals).
        3. Positioning: COT Report changes (Commercials vs Speculators).
        4. Geopolitical: Recent headlines impacting supply chains.
        """
    
    elif category == "forex":
        metrics = """
        1. Yield Spreads: Current spread between {symbol} constituent bond yields.
        2. Central Bank: Recent "Hawk/Dove" shifts in rhetoric (Fed, ECB, BOJ).
        3. Liquidity: Major upcoming option expiries and "barrier" levels.
        4. Data Impact: Surprise factor of the most recent CPI/NFP/PMI prints.
        """

    elif category == "index":
        metrics = """
        1. Breadth: Advance/Decline ratio, percentage of components above 50/200 DMA.
        2. Sector Rotation: Which sectors are leading/lagging in the last 24-48h.
        3. Macro Catalysts: Fed rate expectations, upcoming CPI/NFP, earnings season impact.
        4. Volatility: VIX trend, put/call ratio, and gamma exposure levels.
        """
        
    else:
        metrics = "Analyze immediate momentum, volume trends, and news catalysts."

    prompt = f"""
    {base_instruction}
    
    Analyze {subject} based on:
    {metrics}
    
    Output Format (STRICT):
    {subject} Market Verdict (as of [date of most recent data used])

    1. Executive Verdict
    - **Scalp Bias (15m-4h):** [BULLISH / BEARISH / NEUTRAL]
    - **Swing Bias (1d-7d):** [BULLISH / BEARISH / NEUTRAL]

    2. Supporting Evidence
    - [Bullet points summarizing Search results with dates/timestamps]

    3. Risk Warning
    - [Specific upcoming event or data point that could flip the bias]
    """

    if lang != "en":
        lang_name = _LANG_NAMES.get(lang, lang)
        prompt += f"\n\n    IMPORTANT: Write the ENTIRE response in {lang_name}. All headers, labels, and analysis text must be in {lang_name}."
    
    return prompt

def _gemini_generate_sync(symbol: str, category: str, lang: str = "en") -> str:
    """
    Synchronous Gemini API call with Google Search grounding.
    Runs in a thread pool to avoid blocking the event loop.
    Retries up to 3 times with exponential backoff on 429 rate-limit errors.
    """
    from google import genai
    from google.genai import types
    
    client = _get_gemini_client()
    if not client:
        raise RuntimeError("Gemini client not initialized")
    
    prompt = _build_gemini_market_prompt(symbol, category, lang)
    
    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL_ID,
                contents=prompt,
                config=types.GenerateContentConfig(
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                    temperature=0.3,
                    safety_settings=[
                        types.SafetySetting(
                            category="HARM_CATEGORY_DANGEROUS_CONTENT",
                            threshold="BLOCK_ONLY_HIGH",
                        ),
                        types.SafetySetting(
                            category="HARM_CATEGORY_HARASSMENT",
                            threshold="BLOCK_ONLY_HIGH",
                        ),
                        types.SafetySetting(
                            category="HARM_CATEGORY_HATE_SPEECH",
                            threshold="BLOCK_ONLY_HIGH",
                        ),
                        types.SafetySetting(
                            category="HARM_CATEGORY_SEXUALLY_EXPLICIT",
                            threshold="BLOCK_ONLY_HIGH",
                        ),
                    ],
                )
            )
            return response.text
        except Exception as e:
            is_rate_limit = "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e)
            if is_rate_limit and attempt < max_retries:
                wait = 2 ** attempt * 5  # 5s, 10s, 20s
                logger.warning(f"Gemini 429 rate limit for {symbol}, retrying in {wait}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            logger.error(f"Gemini API error: {e}", exc_info=True)
            raise


@api_router.get("/gemini/analysis/{symbol}")
async def get_gemini_analysis(
    symbol: str,
    category: Optional[str] = None,
    lang: Optional[str] = None,
    _auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Get Gemini AI market structure analysis for a symbol.
    Uses Google Search grounding for real-time web data.
    Requires Privy authentication.
    """
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not configured")
    
    symbol = symbol.upper()
    meta = _asset_meta_for_symbol(symbol)
    
    # Determine category if not provided
    if not category:
        if symbol in CRYPTO_COINS:
            category = "crypto"
        elif meta:
            category = meta.get("category", "stock")
        elif symbol in FOREX_METADATA:
            category = "forex"
        else:
            category = "stock"  # default for HIP-3 assets
    
    effective_lang = (lang or "en").lower().strip()
    issuer_name = str((meta or {}).get("name") or symbol)

    # Check cache first (shared across all users, 4-hour TTL)
    et_day = datetime.now(timezone.utc).astimezone(_NY_TZ).date().isoformat()
    cache_key = f"{symbol}:{issuer_name}:{category}:{effective_lang}:{et_day}"
    cached = None
    is_cache_fresh = False
    
    async with _gemini_cache_lock:
        cached = _gemini_cache.get(cache_key)
        if cached:
            cached_age = time.time() - cached.get("timestamp", 0)
            is_cache_fresh = cached_age < GEMINI_CACHE_TTL_SECONDS
            if is_cache_fresh:
                logger.info(f"Gemini cache hit for {symbol} (age: {int(cached_age)}s)")
                return cached["data"]
            else:
                logger.info(f"Gemini cache stale for {symbol} (age: {int(cached_age)}s), will try to refresh")
    
    # Cache miss or stale - try to fetch fresh data
    logger.info(f"Fetching Gemini analysis with Google Search for {symbol} ({category})")
    
    try:
        # Run synchronous Gemini call in thread pool
        content = await asyncio.to_thread(_gemini_generate_sync, symbol, category, effective_lang)
        
        if not content or not content.strip() or len(content.strip()) < 50:
            logger.warning("Gemini returned insufficient content for %s (%d chars): %s",
                           symbol, len(content or ""), (content or "")[:100])
            if cached:
                logger.warning(f"Using stale cache for {symbol}")
                return cached["data"]
            raise HTTPException(status_code=502, detail="Gemini API returned empty response")
        
        result = {
            "symbol": symbol,
            "category": category,
            "analysis": content,
            "search_grounded": True,
        }
        
        # Store in cache (shared across all users)
        async with _gemini_cache_lock:
            _gemini_cache[cache_key] = {
                "data": result,
                "timestamp": time.time(),
            }
            logger.info("Gemini analysis cached for %s (%d chars)", symbol, len(content))
        
        return result
        
    except HTTPException:
        # Re-raise HTTP exceptions (like our 502 above)
        raise
    except Exception as e:
        # API failed - return stale cache if available (stale-while-revalidate)
        if cached:
            logger.warning(f"Gemini API failed ({e}), returning stale cache for {symbol}")
            return cached["data"]
        
        logger.error(f"Gemini API exception (no cache): {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Gemini analysis failed: {str(e)}")


# COMMENTED OUT - Uses 4 API calls, eating into free tier limit
# @api_router.get("/alpha/macro")
# async def get_alpha_macro():
#     """Get a minimal macro snapshot (GDP, CPI, inflation, unemployment)."""
#     gdp_task = fetch_alpha_vantage_json({"function": "REAL_GDP", "interval": "quarterly"})
#     cpi_task = fetch_alpha_vantage_json({"function": "CPI", "interval": "monthly"})
#     inflation_task = fetch_alpha_vantage_json({"function": "INFLATION"})
#     # Alpha Vantage uses "UNEMPLOYMENT_RATE" not "UNEMPLOYMENT"
#     unemployment_task = fetch_alpha_vantage_json({"function": "UNEMPLOYMENT_RATE"})
#
#     gdp, cpi, inflation, unemployment = await asyncio.gather(
#         gdp_task, cpi_task, inflation_task, unemployment_task
#     )
#
#     return {
#         "gdp": _pick_latest_series_point(gdp),
#         "cpi": _pick_latest_series_point(cpi),
#         "inflation": _pick_latest_series_point(inflation),
#         "unemployment": _pick_latest_series_point(unemployment),
#     }


def _get_known_stock_symbols() -> List[str]:
    symbols = []
    for symbol, meta in ASSET_METADATA.items():
        if meta.get("category") == "stock":
            symbols.append(symbol)
    symbols.sort()
    return symbols


async def _warmup_earnings_only(targets: List[str]):
    """
    Background worker to warm ONLY earnings calendar cache.
    
    Rate limit math (Alpha Vantage FREE tier):
    - Free tier: 5 calls/minute, 25 calls/day (NOT 500!)
    - Per symbol: 1 call (EARNINGS_CALENDAR only)
    - Total: 24 symbols × 1 = 24 calls/day ✅ (under 25 limit)
    - Per-minute: 12 seconds between calls = 5 calls/minute ✅
    
    This is the RECOMMENDED warmup for free tier users who only need earnings dates.
    Results are persisted to Supabase so they survive server restarts and daily cache rotation.
    """
    import time as _time
    warmed = []
    failed = []
    
    for i, symbol in enumerate(targets, 1):
        try:
            logger.info(f"Fetching earnings for {symbol} ({i}/{len(targets)})...")
            rows = await fetch_alpha_vantage_csv({"function": "EARNINGS_CALENDAR", "symbol": symbol}, min_interval_seconds=12.0)
            warmed.append(symbol)

            # Persist parsed date to Supabase + in-memory cache
            next_date = _pick_next_earnings_date(rows, symbol)
            logger.info(f"  Alpha Vantage returned {len(rows)} rows for {symbol}, parsed next_date={next_date}")

            if supabase:
                try:
                    if next_date is not None:
                        # We got a valid date from the API — upsert it
                        _earnings_mem_cache[symbol] = (next_date, _time.time())
                        await asyncio.to_thread(lambda: supabase.table("earnings_cache").upsert(
                            {
                                "symbol": symbol,
                                "next_earnings_date": next_date,
                                "fetched_at": datetime.now(timezone.utc).isoformat(),
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                            },
                            on_conflict="symbol",
                        ).execute())
                    else:
                        # API returned no future date — check if existing
                        # DB value is still in the future (preserve it) or
                        # has already passed (clear it to None).
                        today_iso = datetime.utcnow().date().isoformat()
                        existing = await asyncio.to_thread(lambda: (
                            supabase.table("earnings_cache")
                            .select("next_earnings_date")
                            .eq("symbol", symbol)
                            .maybe_single()
                            .execute()
                        ))
                        existing_date = existing.data.get("next_earnings_date") if existing.data else None
                        if existing_date and existing_date >= today_iso:
                            # Existing date is still in the future — keep it
                            logger.info(f"  Keeping existing future earnings date for {symbol}: {existing_date} (API had no future date)")
                            _earnings_mem_cache[symbol] = (existing_date, _time.time())
                        else:
                            # Existing date is in the past or doesn't exist
                            # — clear it so frontend can show "TBA"
                            if existing_date:
                                logger.info(f"  Clearing past earnings date for {symbol}: {existing_date} < {today_iso}")
                            else:
                                logger.info(f"  No existing date for {symbol} either, storing None")
                            _earnings_mem_cache[symbol] = (None, _time.time())
                            await asyncio.to_thread(lambda: supabase.table("earnings_cache").upsert(
                                {
                                    "symbol": symbol,
                                    "next_earnings_date": None,
                                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                                    "updated_at": datetime.now(timezone.utc).isoformat(),
                                },
                                on_conflict="symbol",
                            ).execute())
                except Exception as db_err:
                    logger.warning(f"earnings_cache upsert failed for {symbol}: {db_err}")
            else:
                _earnings_mem_cache[symbol] = (next_date, _time.time())

            logger.info(f"✓ Earnings cached for {symbol}: next={next_date} ({len(warmed)}/{len(targets)} succeeded)")
        except HTTPException as e:
            error_msg = str(e.detail) if hasattr(e, 'detail') else str(e)
            logger.error(f"✗ Earnings fetch failed for {symbol}: {error_msg}")
            failed.append({"symbol": symbol, "error": error_msg})
            # If rate limited, stop entirely - we've hit the 25/day limit
            if "rate limit" in error_msg.lower() or "sparingly" in error_msg.lower() or "25 requests per day" in error_msg.lower():
                logger.error(f"Rate limit hit after {len(warmed)} symbols. Free tier is 25 calls/day.")
                break
        except Exception as e:
            error_msg = str(e)
            logger.error(f"✗ Earnings exception for {symbol}: {error_msg}", exc_info=True)
            failed.append({"symbol": symbol, "error": error_msg})

    logger.info(f"Earnings warmup complete: {len(warmed)}/{len(targets)} symbols succeeded, {len(failed)} failed, {len(warmed)} total API calls")
    if failed:
        logger.warning(f"Failed symbols: {[f['symbol'] for f in failed]}")


# COMMENTED OUT - Heavy warmup that uses 4 API calls per symbol (requires premium tier)
# async def _warmup_alpha_cache_worker(targets: List[str]):
#     """
#     Background worker to warm Alpha Vantage cache (FULL data - requires premium API key).
#     
#     ⚠️ WARNING: This fetches 4 endpoints per symbol!
#     - Free tier: 25 calls/day - can only do ~6 symbols
#     - Premium tier: 500+ calls/day - can do all symbols
#     
#     For FREE tier, use /alpha/warmup-earnings instead (1 call per symbol).
#     """
#     warmed = []
#     failed = []
#     
#     try:
#         logger.info("Warming macro indicators (shared, fetched once)...")
#         await fetch_alpha_vantage_json({"function": "REAL_GDP", "interval": "quarterly"}, min_interval_seconds=12.0)
#         await fetch_alpha_vantage_json({"function": "CPI", "interval": "monthly"}, min_interval_seconds=12.0)
#         await fetch_alpha_vantage_json({"function": "INFLATION"}, min_interval_seconds=12.0)
#         await fetch_alpha_vantage_json({"function": "UNEMPLOYMENT_RATE"}, min_interval_seconds=12.0)
#         logger.info("✓ Warmed macro cache (4 calls)")
#     except HTTPException as e:
#         error_msg = str(e.detail) if hasattr(e, 'detail') else str(e)
#         logger.error(f"✗ Alpha warmup macro failed: {error_msg}")
#     except Exception as e:
#         logger.error(f"✗ Alpha warmup macro exception: {str(e)}", exc_info=True)
#     
#     for i, symbol in enumerate(targets, 1):
#         try:
#             logger.info(f"Warming {symbol} ({i}/{len(targets)}) - 4 calls per symbol...")
#             await fetch_alpha_vantage_json({"function": "OVERVIEW", "symbol": symbol}, min_interval_seconds=12.0)
#             await fetch_alpha_vantage_json({"function": "BALANCE_SHEET", "symbol": symbol}, min_interval_seconds=12.0)
#             await fetch_alpha_vantage_json({"function": "CASH_FLOW", "symbol": symbol}, min_interval_seconds=12.0)
#             await fetch_alpha_vantage_csv({"function": "EARNINGS_CALENDAR", "symbol": symbol}, min_interval_seconds=12.0)
#             warmed.append(symbol)
#             logger.info(f"✓ Warmed cache for {symbol} ({len(warmed)}/{len(targets)} succeeded)")
#         except HTTPException as e:
#             error_msg = str(e.detail) if hasattr(e, 'detail') else str(e)
#             logger.error(f"✗ Alpha warmup failed for {symbol}: {error_msg}")
#             failed.append({"symbol": symbol, "error": error_msg})
#             if "rate limit" in error_msg.lower() or "sparingly" in error_msg.lower() or "25 requests per day" in error_msg.lower():
#                 logger.warning(f"Rate limit detected, waiting 60s before continuing...")
#                 await asyncio.sleep(60)
#         except Exception as e:
#             error_msg = str(e)
#             logger.error(f"✗ Alpha warmup exception for {symbol}: {error_msg}", exc_info=True)
#             failed.append({"symbol": symbol, "error": error_msg})
#
#     total_calls = len(warmed) * 4 + 4
#     logger.info(f"Warmup complete: {len(warmed)}/{len(targets)} symbols succeeded, {len(failed)} failed, {total_calls} total API calls")
#     if failed:
#         logger.warning(f"Failed symbols: {[f['symbol'] for f in failed]}")


@api_router.get("/alpha/warmup-earnings")
@api_router.post("/alpha/warmup-earnings")
async def warmup_earnings_cache(request: Request, symbols: Optional[str] = None):
    """
    Warm ONLY earnings calendar cache for stock symbols.
    
    ✅ RECOMMENDED for FREE tier Alpha Vantage API (25 calls/day limit).
    - 24 symbols × 1 call = 24 calls/day (under 25 limit)
    
    Returns immediately and processes in background.
    Point your daily cron job to this endpoint instead of /alpha/warmup.
    """
    if ALPHA_WARMUP_SECRET:
        auth = ""
        try:
            auth = request.headers.get("authorization", "")
        except Exception:
            auth = ""
        secret = ""
        try:
            secret = request.query_params.get("secret", "")
        except Exception:
            secret = ""
        token = auth.split("Bearer ")[-1] if "Bearer " in auth else ""
        if secret != ALPHA_WARMUP_SECRET and token != ALPHA_WARMUP_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")
    
    if symbols:
        targets = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    else:
        targets = _get_known_stock_symbols()

    # Start background task and return immediately
    asyncio.create_task(_warmup_earnings_only(targets))
    return {
        "ok": True, 
        "message": "Earnings warmup started in background (1 call per symbol)",
        "symbols_count": len(targets),
        "estimated_calls": len(targets),
        "free_tier_limit": 25,
    }


# COMMENTED OUT - Old heavy warmup endpoint (requires premium tier)
# @api_router.get("/alpha/warmup")
# @api_router.post("/alpha/warmup")
# async def warmup_alpha_cache(request: Request, symbols: Optional[str] = None):
#     """
#     Warm FULL Alpha Vantage cache for stock symbols.
#     
#     ⚠️ WARNING: Requires PREMIUM API key (500+ calls/day).
#     - 24 symbols × 4 calls + 4 macro = 100 calls/day
#     - FREE tier (25 calls/day) will only complete ~6 symbols!
#     
#     For FREE tier, use /alpha/warmup-earnings instead.
#     """
#     if ALPHA_WARMUP_SECRET:
#         auth = ""
#         try:
#             auth = request.headers.get("authorization", "")
#         except Exception:
#             auth = ""
#         secret = ""
#         try:
#             secret = request.query_params.get("secret", "")
#         except Exception:
#             secret = ""
#         token = auth.split("Bearer ")[-1] if "Bearer " in auth else ""
#         if secret != ALPHA_WARMUP_SECRET and token != ALPHA_WARMUP_SECRET:
#             raise HTTPException(status_code=401, detail="Unauthorized")
#     if symbols:
#         targets = [s.strip().upper() for s in symbols.split(",") if s.strip()]
#     else:
#         targets = _get_known_stock_symbols()
#
#     asyncio.create_task(_warmup_alpha_cache_worker(targets))
#     return {"ok": True, "message": "Warmup started in background", "symbols_count": len(targets)}


@api_router.get("/candles/{coin}")
async def get_candles(
    coin: str,
    interval: str = "1h",
    limit: int = 100,
    startTime: int | None = None,
    endTime: int | None = None,
):
    """Get candlestick data for an asset"""
    valid_intervals = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]
    if interval not in valid_intervals:
        raise HTTPException(status_code=400, detail=f"Invalid interval. Valid: {valid_intervals}")
    
    requested_coin = coin

    # Spot-only assets: resolve to the spot pair name for the candle API
    if coin in SPOT_ONLY_COINS:
        spot_data = await _get_spot_meta_and_asset_ctxs()
        if not spot_data or not isinstance(spot_data, list) or len(spot_data) < 2:
            raise HTTPException(status_code=404, detail="Spot asset not found")
        spot_meta = spot_data[0]
        spot_name = _resolve_spot_coin(
            _get_hl_base_coin(requested_coin), spot_meta.get("universe", []), spot_meta.get("tokens", [])
        )
        if not spot_name:
            raise HTTPException(status_code=404, detail="Spot asset not found")
        coin = spot_name
    elif coin.startswith("@") or "/USDC" in coin.upper():
        # HL spot-pair symbols come in as either the @N short form (e.g. @107)
        # or the full pair (e.g. HYPE/USDC). HL accepts both directly — DO NOT
        # auto-prefix with a HIP-3 dex, which would turn them into xyz:@107
        # and break the lookup. Leave coin as-is.
        pass
    elif ":" not in coin and coin not in CRYPTO_COINS and coin not in FOREX_COINS:
        # Auto-prefix from catalog dex (ANTH → io:ANTH). Unlisted tickers stay xyz: for back-compat.
        coin = _prefix_catalog_hip3_coin(coin)
    elif coin in CRYPTO_COINS or coin in FOREX_COINS:
        # Resolve to actual main-exchange universe name (case-insensitive)
        meta_data = await _get_meta_and_asset_ctxs(dex=None)
        if not meta_data or len(meta_data) < 2:
            raise HTTPException(status_code=404, detail="Asset not found")
        universe = meta_data[0].get("universe", [])
        resolved = _resolve_main_coin(coin, universe)
        if not resolved:
            raise HTTPException(status_code=404, detail="Asset not found")
        coin = resolved

    coin = _resolve_hl_candle_coin(coin)

    import time
    if interval == "1M":
        limit = min(limit, 120)
    now_ms = int(time.time() * 1000)
    MAX_LOOKBACK_MS = 5 * 365 * 86_400_000  # 5 years
    interval_ms = {
        "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000,
        "30m": 1800000, "1h": 3600000, "2h": 7200000, "4h": 14400000,
        "8h": 28800000, "12h": 43200000, "1d": 86400000, "3d": 259200000, "1w": 604800000, "1M": 2592000000
    }
    interval_ms_value = interval_ms.get(interval, 3600000)
    end_time = endTime if endTime is not None else now_ms
    if startTime is not None:
        start_time = startTime
    else:
        start_time = end_time - (interval_ms_value * limit)
    start_time = max(start_time, now_ms - MAX_LOOKBACK_MS)
    if start_time >= end_time:
        raise HTTPException(status_code=400, detail="startTime must be less than endTime")
    
    async def fetch_snapshot(target_coin: str):
        payload = {
            "type": "candleSnapshot",
            "req": {
                "coin": target_coin,
                "interval": interval,
                "startTime": start_time,
                "endTime": end_time
            }
        }
        response = await http_client.post(HYPERLIQUID_API_URL, json=payload)
        try:
            data = response.json()
        except Exception:
            data = None
        return response.status_code, data

    try:
        status, data = await fetch_snapshot(coin)
        if status != 200 or not isinstance(data, list):
            # Fallback: try the originally requested coin if resolution returned a different name
            if requested_coin != coin:
                status2, data2 = await fetch_snapshot(requested_coin)
                if status2 == 200 and isinstance(data2, list):
                    data = data2
                    coin = requested_coin
            if not isinstance(data, list):
                detail = "Invalid candle data from Hyperliquid"
                if isinstance(data, dict) and data.get("error"):
                    detail = f"Invalid candle data from Hyperliquid: {data.get('error')}"
                raise HTTPException(status_code=502, detail=detail)

        candles = []
        for candle in data:
            candles.append({
                "t": candle.get("t"),
                "o": candle.get("o"),
                "h": candle.get("h"),
                "l": candle.get("l"),
                "c": candle.get("c"),
                "v": candle.get("v"),
                "n": candle.get("n"),
            })

        return {"candles": candles, "coin": coin, "interval": interval}

    except Exception as e:
        logger.error(f"Error fetching candles for {coin}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/prices")
async def get_all_prices(dex: Optional[str] = None):
    """Get current mid prices for all assets (optional HIP-3 dex)."""
    try:
        params = {"dex": dex} if dex else None
        data = await fetch_hyperliquid("allMids", params)
        return {"prices": data}
    except Exception as e:
        logger.error(f"Error fetching prices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/crypto-assets")
async def get_crypto_assets():
    """Get crypto perpetual assets (non-HIP-3)"""
    try:
        # Get main Hyperliquid perp data (no dex parameter = main exchange) — cached
        data = await _get_meta_and_asset_ctxs(dex=None)
        
        if not data or len(data) < 2:
            logger.warning(
                "/crypto-assets: metaAndAssetCtxs missing or malformed for main dex "
                "(len=%s); returning empty list — clients should retry",
                len(data) if isinstance(data, list) else "n/a",
            )
            return {"assets": [], "count": 0}
        
        meta = data[0]
        asset_ctxs = data[1]
        universe = meta.get("universe", [])
        
        # Pre-compute which perp coins also have a spot market
        spot_coins_set: set = set()
        try:
            spot_data_for_has = await _get_spot_meta_and_asset_ctxs()
            if spot_data_for_has and isinstance(spot_data_for_has, list) and len(spot_data_for_has) >= 2:
                s_meta = spot_data_for_has[0]
                s_universe = s_meta.get("universe", [])
                s_tokens = s_meta.get("tokens", [])
                for cname in CRYPTO_COINS:
                    if CRYPTO_METADATA.get(cname, {}).get("isSpotOnly"):
                        continue
                    if _resolve_spot_coin(cname, s_universe, s_tokens):
                        spot_coins_set.add(cname)
        except Exception:
            pass

        assets = []
        for i, asset in enumerate(universe):
            coin_name = asset.get("name", "")
            
            # Only include our selected crypto coins
            if coin_name not in CRYPTO_COINS:
                continue
            # Skip spot-only coins here — they are appended below from the spot universe
            if coin_name in SPOT_ONLY_COINS:
                continue
            
            ctx = asset_ctxs[i] if i < len(asset_ctxs) else {}
            meta_info = CRYPTO_METADATA.get(coin_name, {
                "name": coin_name,
                "symbol": coin_name,
                "category": "crypto"
            })
            
            mark_px = ctx.get("markPx")
            prev_day_px = ctx.get("prevDayPx")
            change_24h = None
            
            if mark_px and prev_day_px:
                try:
                    current = float(mark_px)
                    previous = float(prev_day_px)
                    if previous > 0:
                        change_24h = ((current - previous) / previous) * 100
                except (ValueError, ZeroDivisionError):
                    pass

            entry = {
                "coin": coin_name,
                "name": meta_info["name"],
                "symbol": meta_info["symbol"],
                "category": "crypto",
                "maxLeverage": asset.get("maxLeverage", 50),
                "szDecimals": asset.get("szDecimals", 4),
                "markPx": mark_px,
                "prevDayPx": prev_day_px,
                "dayNtlVlm": ctx.get("dayNtlVlm"),
                "openInterest": ctx.get("openInterest"),
                "funding": ctx.get("funding"),
                "change24h": change_24h,
                "isHip3": False,
            }
            if coin_name in spot_coins_set:
                entry["hasSpot"] = True
            assets.append(entry)

        # ── Append crypto spot-only coins from the spot universe ─────────
        if _CRYPTO_SPOT_ONLY:
            try:
                spot_data = await _get_spot_meta_and_asset_ctxs()
                if spot_data and isinstance(spot_data, list) and len(spot_data) >= 2:
                    spot_meta = spot_data[0]
                    spot_ctxs = spot_data[1] or []
                    spot_universe = spot_meta.get("universe", [])
                    spot_tokens = spot_meta.get("tokens", [])

                    for so_coin in _CRYPTO_SPOT_ONLY:
                        spot_name = _resolve_spot_coin(_get_hl_base_coin(so_coin), spot_universe, spot_tokens)
                        if not spot_name:
                            continue
                        ctx = next(
                            (c for c in spot_ctxs if str(c.get("coin", "")).upper() == spot_name.upper()),
                            {},
                        )
                        if not ctx:
                            idx = next(
                                (i for i, u in enumerate(spot_universe) if u.get("name") == spot_name),
                                None,
                            )
                            if idx is not None and idx < len(spot_ctxs):
                                ctx = spot_ctxs[idx]

                        spot_entry = next((u for u in spot_universe if u.get("name") == spot_name), {})
                        so_meta = CRYPTO_METADATA.get(so_coin, {"name": so_coin, "symbol": so_coin, "category": "crypto"})
                        mark_px = ctx.get("markPx")
                        prev_day_px = ctx.get("prevDayPx")
                        change_24h = None
                        if mark_px and prev_day_px:
                            try:
                                current = float(mark_px)
                                previous = float(prev_day_px)
                                if previous > 0:
                                    change_24h = ((current - previous) / previous) * 100
                            except (ValueError, ZeroDivisionError):
                                pass

                        assets.append({
                            "coin": so_coin,
                            "name": so_meta["name"],
                            "symbol": so_meta["symbol"],
                            "category": "crypto",
                            "maxLeverage": 1,
                            "szDecimals": spot_entry.get("szDecimals", 2),
                            "markPx": mark_px,
                            "prevDayPx": prev_day_px,
                            "dayNtlVlm": ctx.get("dayNtlVlm"),
                            "openInterest": None,
                            "funding": None,
                            "change24h": change_24h,
                            "isHip3": False,
                            "isSpotOnly": True,
                            "hasSpot": True,
                            "spotSymbol": spot_name,
                        })
            except Exception as e:
                logger.warning(f"Failed to fetch spot-only assets for /crypto-assets: {e}")

        return {"assets": assets, "count": len(assets)}
        
    except Exception as e:
        logger.error(f"Error fetching crypto assets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Crypto Metadata (circulating supply, market cap, whitepaper, etc.) ──

_crypto_meta_mem_cache: Dict[str, dict] = {}
_crypto_meta_cache_ts: float = 0
_CRYPTO_META_CACHE_TTL = 300  # 5 min in-memory TTL

@api_router.get("/crypto-metadata/{symbol}")
async def get_crypto_metadata(symbol: str):
    """Return crypto metadata (description, supply, whitepaper) for a symbol."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")
    sym = symbol.upper()
    now = __import__("time").time()
    global _crypto_meta_cache_ts

    # Refresh full cache if stale
    if now - _crypto_meta_cache_ts > _CRYPTO_META_CACHE_TTL or not _crypto_meta_mem_cache:
        try:
            rows = await asyncio.to_thread(lambda: supabase.table("crypto_metadata").select("*").execute())
            _crypto_meta_mem_cache.clear()
            for r in (rows.data or []):
                _crypto_meta_mem_cache[r["symbol"]] = r
            _crypto_meta_cache_ts = now
        except Exception as e:
            logger.error("Failed to fetch crypto_metadata: %s", e)

    row = _crypto_meta_mem_cache.get(sym)
    if not row:
        raise HTTPException(status_code=404, detail="Metadata not found")
    return row


@api_router.get("/crypto-metadata")
async def get_all_crypto_metadata():
    """Return all crypto metadata rows (lightweight, public)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")
    now = __import__("time").time()
    global _crypto_meta_cache_ts
    if now - _crypto_meta_cache_ts > _CRYPTO_META_CACHE_TTL or not _crypto_meta_mem_cache:
        try:
            rows = await asyncio.to_thread(lambda: supabase.table("crypto_metadata").select("*").execute())
            _crypto_meta_mem_cache.clear()
            for r in (rows.data or []):
                _crypto_meta_mem_cache[r["symbol"]] = r
            _crypto_meta_cache_ts = now
        except Exception as e:
            logger.error("Failed to fetch crypto_metadata: %s", e)
    return {"items": list(_crypto_meta_mem_cache.values())}


async def _sync_coingecko_supply():
    """Fetch circulating supply from CoinGecko for all crypto assets and update Supabase.
    Called once on startup, then every 24 hours.  Free-tier friendly: 1 batch call."""
    if not supabase:
        return
    try:
        rows = await asyncio.to_thread(lambda: supabase.table("crypto_metadata").select("symbol, coingecko_id").execute())
        id_map: Dict[str, str] = {}
        for r in (rows.data or []):
            cg_id = r.get("coingecko_id")
            if cg_id:
                id_map[cg_id] = r["symbol"]
        if not id_map:
            return

        ids_param = ",".join(id_map.keys())
        url = f"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids={ids_param}&per_page=250&page=1"
        resp = await http_client.get(url, timeout=30.0)
        if resp.status_code == 429:
            logger.warning("CoinGecko rate-limited during supply sync, will retry next cycle")
            return
        resp.raise_for_status()
        data = resp.json()

        now_iso = datetime.utcnow().isoformat()
        updated = 0
        for coin in data:
            cg_id = coin.get("id")
            sym = id_map.get(cg_id)
            if not sym:
                continue
            circ = coin.get("circulating_supply")
            if circ is not None:
                circ = int(circ)
            try:
                await asyncio.to_thread(lambda: supabase.table("crypto_metadata").update({
                    "circulating_supply": circ,
                    "supply_updated_at": now_iso,
                    "updated_at": now_iso,
                }).eq("symbol", sym).execute())
                updated += 1
            except Exception as e:
                logger.warning("Failed to update supply for %s: %s", sym, e)
        logger.info("CoinGecko supply sync complete: updated %d/%d symbols", updated, len(id_map))
    except Exception as e:
        logger.error("CoinGecko supply sync failed: %s", e)


async def _coingecko_supply_loop():
    """Background loop: sync supply once on start, then every 24 hours.

    Only one replica runs a given cycle — the leadership lease TTL
    (20 h) is set slightly shorter than the 24 h sleep so the next
    cycle always starts with the lease expired and any replica can
    claim it, but within a cycle the losing replicas short-circuit.
    """
    await asyncio.sleep(5)  # let app finish starting
    while True:
        try:
            is_leader = await asyncio.to_thread(
                _try_claim_leadership, "coingecko_supply", 20 * 3600
            )
            if is_leader:
                await _sync_coingecko_supply()
            else:
                logger.debug("CoinGecko supply: another replica holds the lease this cycle")
        except Exception as e:
            logger.error("CoinGecko supply loop error: %s", e)
        await asyncio.sleep(86400)  # 24 hours


# ── Stock Fundamentals (Finnhub: mcap, P/E, EPS, revenue, margins — all TTM) ──
#
# Finnhub's free tier covers US-listed stocks only. Samsung (Korean Exchange,
# no US CS ticker) stays excluded. SK Hynix trades as Nasdaq ADS SKHY and is
# synced like other US equities. Lumentum (LITE) and Moderna (MRNA) are
# Nasdaq — sync normally.
#
# Pre-IPO perpetuals (isPreIpo in ASSET_METADATA) are synthetic HIP-3 contracts
# and must not be synced from Finnhub. Manual stock_fundamentals rows
# (especially description) are still readable via GET. SPCX was pre-IPO but
# is now live on Nasdaq (June 2026); keep isPreIpo off ASSET_METADATA so it
# syncs again.
# The SPCX ticker was recycled — Finnhub may lag or briefly return the old
# issuer; _FINNHUB_PROFILE_NAME_GUARDS rejects mismatched profile names.
# SKHY is a US Nasdaq ADS — Finnhub can sync it. SMSN remains KR-only.
_FINNHUB_UNSUPPORTED: frozenset = frozenset({"SMSN"})
_FINNHUB_PRE_IPO: frozenset = frozenset(
    k for k, v in ASSET_METADATA.items() if v.get("isPreIpo")
)
_FINNHUB_SKIPPED_STOCKS: frozenset = _FINNHUB_UNSUPPORTED | _FINNHUB_PRE_IPO
# Lowercase substrings that must appear in Finnhub profile2 `name` for the sym.
_FINNHUB_PROFILE_NAME_GUARDS: Dict[str, tuple] = {
    "SPCX": ("space exploration", "spacex"),
    "CXMT": ("ChangXin Technology", "ChangXin Technology, Inc."),
    "UNITREE": ("unitree",),
    "BOT": ("Robostrategy", "Robostrategy, Inc.", "RoboStrategy Inc.", "Robo Strategy"),
    "SKHY": ("sk hynix", "skhynix", "hynix"),
}
# Suppress 52-week range for this many days after IPO — Finnhub often still
# carries the prior issuer's range on recycled tickers (SPCX pre-SpaceX).
_FINNHUB_RECENT_IPO_DAYS = 365
# Hyperliquid display symbol → Finnhub API ticker (DB rows stay keyed by HL sym).
_FINNHUB_SYMBOL_MAP: Dict[str, str] = {
    "PURRDAT": "PURR",
}


def _finnhub_api_symbol(hl_sym: str) -> str:
    """Map a Hyperliquid stock symbol to the Finnhub query ticker."""
    s = hl_sym.upper()
    return _FINNHUB_SYMBOL_MAP.get(s, s)


def _empty_stock_fundamentals_row(sym: str) -> dict:
    return {
        "symbol": sym,
        "description": None,
        "sector": None,
        "industry": None,
        "mkt_cap": None,
        "pe_ratio": None,
        "eps": None,
        "revenue": None,
        "net_income": None,
        "gross_profit": None,
        "operating_income": None,
        "ebitda": None,
        "profit_margin": None,
        "free_cash_flow": None,
        "week52_high": None,
        "week52_low": None,
        "outstanding_shares": None,
        "shares_updated_at": None,
        "fetched_at": None,
    }


def _finnhub_profile_name_ok(sym: str, profile: dict) -> bool:
    guard = _FINNHUB_PROFILE_NAME_GUARDS.get(sym)
    if not guard:
        return True
    name = (profile.get("name") or profile.get("companyName") or "").lower()
    if not name:
        return False
    return any(token in name for token in guard)


async def _fetch_finnhub_profile2(hl_sym: str) -> dict:
    if not FINNHUB_API_KEY:
        return {}
    fh_sym = _finnhub_api_symbol(hl_sym)
    url = f"{FINNHUB_BASE_URL}/stock/profile2?symbol={fh_sym}&token={FINNHUB_API_KEY}"
    await _finnhub_rate_gate()
    resp = await http_client.get(url, timeout=20.0)
    if resp.status_code != 200:
        logger.warning(
            "Finnhub profile2 %d for %s (fh=%s): %s",
            resp.status_code, hl_sym, fh_sym, resp.text[:200],
        )
        return {}
    return resp.json() or {}


def _finnhub_ipo_age_days(profile: dict) -> Optional[int]:
    ipo_raw = profile.get("ipo")
    if not ipo_raw:
        return None
    try:
        ipo_date = datetime.fromisoformat(str(ipo_raw)[:10]).date()
        return (datetime.utcnow().date() - ipo_date).days
    except ValueError:
        return None


def _finnhub_stale_recycled_metrics(
    hl_sym: str,
    profile: dict,
    week52_high: Optional[float],
    mkt_cap: Optional[int],
) -> bool:
    """True when Finnhub /stock/metric likely reflects a prior issuer on this ticker."""
    ipo_age = _finnhub_ipo_age_days(profile) if profile else None
    if ipo_age is not None and 0 <= ipo_age <= _FINNHUB_RECENT_IPO_DAYS:
        return True

    prof_mcap = _finnhub_mkt_cap_from_profile(profile) if profile else None
    cap = mkt_cap if mkt_cap is not None else prof_mcap
    if (
        cap is not None
        and cap >= 10_000_000_000
        and week52_high is not None
        and week52_high < 100
    ):
        return True

    if hl_sym in _FINNHUB_PROFILE_NAME_GUARDS and week52_high is not None and week52_high < 100:
        return True

    return False


def _finnhub_mkt_cap_from_profile(profile: dict) -> Optional[int]:
    """Finnhub profile2 marketCapitalization is in millions USD — same ×1e6 as /stock/metric."""
    prof_mcap_mm = profile.get("marketCapitalization")
    if prof_mcap_mm is None:
        return None
    return int(float(prof_mcap_mm) * 1_000_000)


def _finnhub_sanitize_recycled_metrics(
    hl_sym: str,
    profile: dict,
    mkt_cap: Optional[int],
    pe_ratio: Optional[float],
    eps: Optional[float],
    profit_margin: Optional[float],
    week52_high: Optional[float],
    week52_low: Optional[float],
) -> Tuple[Optional[int], Optional[float], Optional[float], Optional[float], Optional[float], Optional[float]]:
    """Drop stale TTM / 52W from recycled tickers.

    Does NOT alter the normal mkt_cap path (metric ×1e6). When metrics are
    stale, discard the metric mkt_cap and fall back to profile2 ×1e6 only.
    """
    if not _finnhub_stale_recycled_metrics(hl_sym, profile, week52_high, mkt_cap):
        return mkt_cap, pe_ratio, eps, profit_margin, week52_high, week52_low

    logger.info(
        "Finnhub %s: suppressing stale recycled-ticker TTM/52W (mkt_cap → profile fallback)",
        hl_sym,
    )
    resolved_mcap = _finnhub_mkt_cap_from_profile(profile) if profile else None
    return resolved_mcap, None, None, None, None, None


def _finnhub_row_has_stale_recycled_metrics(row: dict) -> bool:
    """Detect bad stored rows (e.g. SPCX pre-IPO bleed) without a live profile."""
    hl_sym = str(row.get("symbol") or "").upper()
    if hl_sym not in _FINNHUB_PROFILE_NAME_GUARDS:
        return False
    wh = row.get("week52_high")
    if wh is not None and float(wh) < 100:
        return True
    # TTM margin without mkt_cap on a guarded recycled ticker = old issuer data.
    if row.get("profit_margin") is not None and row.get("mkt_cap") is None:
        return True
    return False


def _sanitize_fundamentals_row_for_read(row: dict) -> dict:
    """Strip known-bad TTM/52W fields already stored (until next sync).

    mkt_cap is intentionally left alone — it uses the dedicated ×1e6 path
    (metric or profile2 fallback) and is not part of the stale TTM/52W set.
    """
    if not _finnhub_row_has_stale_recycled_metrics(row):
        return row
    return {
        **row,
        "pe_ratio": None,
        "eps": None,
        "profit_margin": None,
        "week52_high": None,
        "week52_low": None,
    }


def _finnhub_sync_stock_symbols() -> list[str]:
    return [
        k for k, v in ASSET_METADATA.items()
        if v.get("category") == "stock" and k not in _FINNHUB_SKIPPED_STOCKS
    ]


_stock_fund_mem_cache: Dict[str, dict] = {}
_stock_fund_cache_ts: float = 0
_STOCK_FUND_CACHE_TTL = 300  # 5 min in-memory TTL


@api_router.get("/stock-fundamentals/{symbol}")
async def get_stock_fundamentals(symbol: str):
    """Return cached stock fundamentals for a symbol.

    Always returns 200 for known stock tickers — missing Finnhub fields are
    null so the client can show TBA placeholders instead of treating 404 as
    "we don't track fundamentals".

    Pre-IPO tickers are skipped by the Finnhub sync, but manual rows
    (especially `description`) are still served when present.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")
    sym = symbol.upper()
    now = __import__("time").time()
    global _stock_fund_cache_ts
    if now - _stock_fund_cache_ts > _STOCK_FUND_CACHE_TTL or not _stock_fund_mem_cache:
        try:
            rows = await asyncio.to_thread(lambda: supabase.table("stock_fundamentals").select("*").execute())
            _stock_fund_mem_cache.clear()
            for r in (rows.data or []):
                _stock_fund_mem_cache[r["symbol"]] = r
            _stock_fund_cache_ts = now
        except Exception as e:
            logger.error("Failed to fetch stock_fundamentals: %s", e)
    row = _stock_fund_mem_cache.get(sym)
    if not row:
        return _empty_stock_fundamentals_row(sym)
    return _sanitize_fundamentals_row_for_read(row)


_asset_desc_cache: dict = {}
_asset_desc_cache_ts: float = 0
_ASSET_DESC_CACHE_TTL = 600  # 10 min


@api_router.get("/asset-description/{symbol}")
async def get_asset_description(symbol: str, lang: str = "en"):
    """Return localized description for an asset, falling back to English."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")
    sym = symbol.upper()
    lang = lang.lower()[:5]
    now = __import__("time").time()
    global _asset_desc_cache_ts
    if now - _asset_desc_cache_ts > _ASSET_DESC_CACHE_TTL or not _asset_desc_cache:
        try:
            rows = await asyncio.to_thread(lambda: supabase.table("asset_descriptions").select("symbol,lang,description").execute())
            _asset_desc_cache.clear()
            for r in (rows.data or []):
                _asset_desc_cache[(r["symbol"], r["lang"])] = r["description"]
            _asset_desc_cache_ts = now
        except Exception as e:
            logger.error("Failed to fetch asset_descriptions: %s", e)
    desc = _asset_desc_cache.get((sym, lang)) or _asset_desc_cache.get((sym, "en"))
    if not desc:
        raise HTTPException(status_code=404, detail="Description not found")
    return {"symbol": sym, "lang": lang, "description": desc}


def _safe_round(val, digits=2) -> Optional[float]:
    if val is None:
        return None
    try:
        return round(float(val), digits)
    except (ValueError, TypeError):
        return None


# ── Stock fundamentals daily sync (1 Finnhub /stock/metric call per stock) ──
#
# /stock/financials (IC / CF quarterly statements) is a paid-tier endpoint
# on Finnhub, so absolute-dollar TTM figures (revenue, net_income, ebitda,
# free_cash_flow, gross_profit, operating_income) cannot be populated from
# the free plan. Those columns in stock_fundamentals are intentionally left
# untouched by this sync.
#
# Everything we CAN get comes from the free /stock/metric (a.k.a.
# "company-basic-financials") endpoint in a single request per stock:
#   - marketCapitalization   → mkt_cap  (returned in millions USD, multiplied ×1e6)
#   - peTTM / epsTTM         → pe_ratio / eps
#   - netProfitMarginTTM     → profit_margin
#   - 52WeekHigh / 52WeekLow → week52_high / week52_low
#
# Budget: ~72 US stocks × 1 call/day ≈ 72 calls/day — trivial vs Finnhub's
# free 60 calls/min (86,400/day) limit.
_finnhub_sync_running = False


async def _do_finnhub_sync():
    """Run one full pass of the daily Finnhub sync."""
    if not supabase or not FINNHUB_API_KEY:
        logger.warning(
            "Finnhub sync skipped: supabase=%s, FINNHUB_API_KEY=%s",
            bool(supabase), bool(FINNHUB_API_KEY),
        )
        return
    # Pre-IPO tickers stay out of Finnhub sync (`_FINNHUB_SKIPPED_STOCKS`) but
    # manual stock_fundamentals rows (e.g. English description) are kept.
    stock_symbols = _finnhub_sync_stock_symbols()
    now_iso = datetime.utcnow().isoformat()
    updated = 0
    manual_shares: Dict[str, int] = {}
    try:
        shares_res = await asyncio.to_thread(
            lambda: supabase.table("stock_fundamentals")
            .select("symbol,outstanding_shares")
            .not_.is_("outstanding_shares", "null")
            .execute()
        )
        for r in (shares_res.data or []):
            if r.get("outstanding_shares") is not None:
                manual_shares[str(r["symbol"]).upper()] = int(r["outstanding_shares"])
    except Exception as e:
        logger.warning("Finnhub sync: could not load manual outstanding_shares: %s", e)
    for sym in stock_symbols:
        try:
            fh_sym = _finnhub_api_symbol(sym)
            profile: dict = {}
            needs_profile = sym in _FINNHUB_PROFILE_NAME_GUARDS or fh_sym != sym
            if needs_profile:
                profile = await _fetch_finnhub_profile2(sym)
            if sym in _FINNHUB_PROFILE_NAME_GUARDS:
                if not profile:
                    logger.warning("Finnhub profile2 empty for guarded ticker %s — skipping sync", sym)
                    continue
                if not _finnhub_profile_name_ok(sym, profile):
                    got = profile.get("name") or profile.get("companyName") or "?"
                    logger.warning(
                        "Finnhub profile name mismatch for %s (fh=%s, got %r) — stale recycled ticker, skipping",
                        sym, fh_sym, got,
                    )
                    continue

            metric_url = (
                f"{FINNHUB_BASE_URL}/stock/metric?symbol={fh_sym}&metric=all&token={FINNHUB_API_KEY}"
            )
            await _finnhub_rate_gate()
            m_resp = await http_client.get(metric_url, timeout=20.0)
            if m_resp.status_code == 429:
                logger.warning("Finnhub rate-limited at %s, pausing 60s", sym)
                await asyncio.sleep(60)
                await _finnhub_rate_gate()
                m_resp = await http_client.get(metric_url, timeout=20.0)
                if m_resp.status_code != 200:
                    logger.warning("Finnhub still rate-limited for %s, stopping sync", sym)
                    break
            if m_resp.status_code != 200:
                logger.warning("Finnhub metric %d for %s: %s", m_resp.status_code, sym, m_resp.text[:200])
                continue
            metric = (m_resp.json() or {}).get("metric") or {}
            if not metric:
                logger.warning("Finnhub metric empty for %s", sym)
                continue

            mkt_cap_mm = metric.get("marketCapitalization")
            mkt_cap = int(float(mkt_cap_mm) * 1_000_000) if mkt_cap_mm is not None else None
            pe_ratio = _safe_round(
                metric.get("peTTM")
                or metric.get("peBasicExclExtraTTM")
                or metric.get("peExclExtraTTM")
            )
            eps = _safe_round(
                metric.get("epsTTM")
                or metric.get("epsBasicExclExtraItemsTTM")
                or metric.get("epsInclExtraItemsTTM")
            )
            profit_margin = _safe_round(
                metric.get("netProfitMarginTTM")
                or metric.get("netProfitMarginAnnual")
            )
            # Finnhub returns these as "52WeekHigh" / "52WeekLow" (camelCase
            # prefixed by the number). Use bracket access because the leading
            # digit means they aren't valid Python identifiers.
            week52_high = _safe_round(metric.get("52WeekHigh"), digits=4)
            week52_low = _safe_round(metric.get("52WeekLow"), digits=4)
            mkt_cap, pe_ratio, eps, profit_margin, week52_high, week52_low = (
                _finnhub_sanitize_recycled_metrics(
                    sym, profile, mkt_cap, pe_ratio, eps, profit_margin, week52_high, week52_low
                )
            )

            if (
                mkt_cap is None and pe_ratio is None and eps is None
                and profit_margin is None and week52_high is None and week52_low is None
            ):
                if sym in _FINNHUB_PROFILE_NAME_GUARDS and profile:
                    prof_mcap = _finnhub_mkt_cap_from_profile(profile)
                    row = {
                        "symbol": sym,
                        "industry": profile.get("finnhubIndustry"),
                        "pe_ratio": None,
                        "eps": None,
                        "profit_margin": None,
                        "week52_high": None,
                        "week52_low": None,
                        "fetched_at": now_iso,
                        "updated_at": now_iso,
                    }
                    if sym not in manual_shares:
                        row["mkt_cap"] = prof_mcap
                    await asyncio.to_thread(
                        lambda r=row: supabase.table("stock_fundamentals")
                        .upsert(r, on_conflict="symbol")
                        .execute()
                    )
                    updated += 1
                    logger.info(
                        "Finnhub metric all-null for %s but profile matched — upserted placeholder",
                        sym,
                    )
                else:
                    logger.warning("Finnhub metric all-null for %s, skipping upsert", sym)
                continue
            if mkt_cap is not None and mkt_cap < 1_000_000:
                logger.warning("Finnhub %s suspicious mkt_cap=%s — check unit conversion", sym, mkt_cap)

            # Payload intentionally omits revenue / net_income / gross_profit /
            # operating_income / ebitda / free_cash_flow / outstanding_shares:
            # manual or alternate sources — upsert must not blank them out.
            row = {
                "symbol": sym,
                "pe_ratio": pe_ratio,
                "eps": eps,
                "profit_margin": profit_margin,
                "week52_high": week52_high,
                "week52_low": week52_low,
                "fetched_at": now_iso,
                "updated_at": now_iso,
            }
            if sym not in manual_shares:
                row["mkt_cap"] = mkt_cap
            if profile.get("finnhubIndustry"):
                row["industry"] = profile.get("finnhubIndustry")
            await asyncio.to_thread(
                lambda: supabase.table("stock_fundamentals").upsert(row, on_conflict="symbol").execute()
            )
            updated += 1
            await asyncio.sleep(1.2)
        except Exception as e:
            logger.warning("Finnhub sync failed for %s: %s", sym, e)
    logger.info("Finnhub stock fundamentals sync complete: %d/%d", updated, len(stock_symbols))


async def _sync_finnhub_fundamentals():
    """Single-flight wrapper around _do_finnhub_sync."""
    global _finnhub_sync_running
    if _finnhub_sync_running:
        logger.info("Finnhub sync already in progress, skipping")
        return
    _finnhub_sync_running = True
    try:
        await _do_finnhub_sync()
    finally:
        _finnhub_sync_running = False


@api_router.post("/stock-fundamentals/sync")
async def trigger_finnhub_sync(request: Request):
    """Manual trigger for the Finnhub stock fundamentals sync."""
    _assert_internal_sync_authorized(request)
    if _finnhub_sync_running:
        return {"status": "sync already running"}
    asyncio.create_task(_sync_finnhub_fundamentals())
    return {"status": "sync started"}


async def _finnhub_fundamentals_daily_loop():
    """Background loop: sync stock fundamentals once on start, then daily.

    Leader-gated with a 20h lease (shorter than the 24h sleep) so the
    next cycle always starts with the lease expired and exactly one
    replica per day runs the sync.
    """
    await asyncio.sleep(10)
    while True:
        try:
            is_leader = await asyncio.to_thread(
                _try_claim_leadership, "finnhub_fundamentals_daily", 20 * 3600
            )
            if is_leader:
                await _sync_finnhub_fundamentals()
            else:
                logger.debug("Finnhub fundamentals: another replica holds the lease this cycle")
        except Exception as e:
            logger.error("Finnhub fundamentals loop error: %s", e)
        await asyncio.sleep(86400)  # 24 hours


# ── Weekly absolute-dollar fundamentals via SEC as-reported filings ──
#
# /stock/financials-reported IS on the free tier (unlike /stock/financials,
# which is paid-only). The tradeoff: it ships raw XBRL data straight from
# the 10-K / 10-Q filing in Finnhub's parsed form, so each line item looks
# like {concept, unit, label, value} with concept names following the
# SEC US-GAAP taxonomy (e.g. "us-gaap_NetIncomeLoss"). We read `freq=annual`
# and use the most recent 10-K filing — annual filings update only once a
# year per company, so weekly polling is overkill but cheap (21 calls/week).
#
# Non-US ADRs that file 20-F reports use either us-gaap_* (same concepts)
# or ifrs-full_* (different). We try both taxonomies for each field and
# silently skip companies where neither matches — rather than guessing.

# Priority-ordered concept lists. First match wins.
_FR_CONCEPTS: Dict[str, tuple] = {
    "revenue": (
        "us-gaap_Revenues",
        "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax",
        "us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax",
        "us-gaap_SalesRevenueNet",
        "us-gaap_SalesRevenueGoodsNet",
        "ifrs-full_Revenue",
    ),
    "net_income": (
        "us-gaap_NetIncomeLoss",
        "us-gaap_NetIncomeLossAvailableToCommonStockholdersBasic",
        "us-gaap_ProfitLoss",
        "ifrs-full_ProfitLoss",
    ),
    "gross_profit": (
        "us-gaap_GrossProfit",
        "ifrs-full_GrossProfit",
    ),
    # Cost-of-revenue concepts, used only as a fallback to DERIVE gross_profit
    # as (revenue − cost_of_revenue) when the issuer doesn't report GrossProfit
    # directly (common for platforms/services: GOOGL, AMZN, META, NFLX, etc.).
    "cost_of_revenue": (
        "us-gaap_CostOfRevenue",
        "us-gaap_CostOfGoodsAndServicesSold",
        "us-gaap_CostOfGoodsSold",
        "us-gaap_CostOfServices",
    ),
    "operating_income": (
        "us-gaap_OperatingIncomeLoss",
        "us-gaap_OperatingIncomeLossAttributableToParent",
        "ifrs-full_ProfitLossFromOperatingActivities",
    ),
    "op_cash": (
        "us-gaap_NetCashProvidedByUsedInOperatingActivities",
        "us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        "ifrs-full_CashFlowsFromUsedInOperatingActivities",
    ),
    "capex": (
        "us-gaap_PaymentsToAcquirePropertyPlantAndEquipment",
        "us-gaap_PaymentsToAcquireProductiveAssets",
        "ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
    ),
    # Combined D&A concepts — preferred because they're one number already.
    "dep_amort": (
        "us-gaap_DepreciationDepletionAndAmortization",
        "us-gaap_DepreciationAndAmortization",
        "us-gaap_DepreciationAmortizationAndAccretionNet",
        "us-gaap_DepreciationAmortizationAndDepletion",
        "ifrs-full_DepreciationAndAmortisationExpense",
    ),
    # Split D&A — fallback when the issuer reports depreciation and
    # amortization as separate line items (e.g. TSLA). We sum whichever
    # ones are present.
    "depreciation_only": (
        "us-gaap_Depreciation",
        "us-gaap_DepreciationNonproduction",
    ),
    "amortization_only": (
        "us-gaap_AmortizationOfIntangibleAssets",
        "us-gaap_AdjustmentForAmortization",
    ),
}

# Skip filings older than this when pulling the "latest" annual report.
# Catches cases like BABA where Finnhub's only 10-K is pre-IPO-era (FY2011)
# because the issuer later switched to 20-F under a different CIK.
_FR_MAX_FILING_AGE_YEARS = 3


def _extract_concept(report_section: list, concepts: tuple) -> Optional[float]:
    """Find a concept in a report section, honoring the priority order.

    We scan the whole section once to collect any value whose concept is
    in our candidate list, then pick by the caller's priority order.
    This lets the first-listed concept win even if it appears later in
    the filing than a lower-priority fallback.
    """
    if not isinstance(report_section, list):
        return None
    found: Dict[str, float] = {}
    for item in report_section:
        if not isinstance(item, dict):
            continue
        c = item.get("concept")
        if not c or c in found or c not in concepts:
            continue
        val = item.get("value")
        if val is None:
            continue
        try:
            found[c] = float(val)
        except (ValueError, TypeError):
            continue
    for c in concepts:
        if c in found:
            return found[c]
    return None


_finnhub_reported_running = False


async def _do_finnhub_reported_sync():
    """Populate absolute-dollar columns from the latest annual SEC filing."""
    if not supabase or not FINNHUB_API_KEY:
        logger.warning(
            "Finnhub reported sync skipped: supabase=%s, FINNHUB_API_KEY=%s",
            bool(supabase), bool(FINNHUB_API_KEY),
        )
        return
    stock_symbols = _finnhub_sync_stock_symbols()
    now_iso = datetime.utcnow().isoformat()
    updated = 0
    for sym in stock_symbols:
        try:
            fh_sym = _finnhub_api_symbol(sym)
            url = (
                f"{FINNHUB_BASE_URL}/stock/financials-reported"
                f"?symbol={fh_sym}&freq=annual&token={FINNHUB_API_KEY}"
            )
            await _finnhub_rate_gate()
            resp = await http_client.get(url, timeout=30.0)
            if resp.status_code == 429:
                logger.warning("Finnhub reported rate-limited at %s, pausing 60s", sym)
                await asyncio.sleep(60)
                await _finnhub_rate_gate()
                resp = await http_client.get(url, timeout=30.0)
                if resp.status_code != 200:
                    logger.warning("Finnhub reported still rate-limited for %s, stopping sync", sym)
                    break
            if resp.status_code != 200:
                logger.warning("Finnhub reported %d for %s: %s", resp.status_code, sym, resp.text[:200])
                continue
            data = (resp.json() or {}).get("data") or []
            if not data:
                logger.warning("Finnhub reported no filings for %s (likely non-US / no SEC coverage)", sym)
                continue

            # data[0] is the most-recent annual filing (10-K or 20-F).
            latest = data[0]

            # Freshness guard — Finnhub occasionally returns a very old
            # pre-switch 10-K for issuers that now file 20-F (e.g. BABA's
            # latest annual there is FY2011). Parsing such a filing against
            # the current US-GAAP taxonomy yields zero matches and the
            # data wouldn't be usable anyway, so bail out early.
            end_date_raw = (latest.get("endDate") or "")[:10]
            if end_date_raw:
                try:
                    age_years = (
                        datetime.utcnow() - datetime.fromisoformat(end_date_raw)
                    ).days / 365.0
                    if age_years > _FR_MAX_FILING_AGE_YEARS:
                        logger.warning(
                            "Finnhub reported %s: skipping stale filing (fy=%s, age=%.1fy)",
                            sym, latest.get("year"), age_years,
                        )
                        continue
                except ValueError:
                    pass

            report = latest.get("report") or {}
            ic = report.get("ic") or []
            cf = report.get("cf") or []

            revenue = _extract_concept(ic, _FR_CONCEPTS["revenue"])
            net_income = _extract_concept(ic, _FR_CONCEPTS["net_income"])
            gross_profit = _extract_concept(ic, _FR_CONCEPTS["gross_profit"])
            operating_income = _extract_concept(ic, _FR_CONCEPTS["operating_income"])
            op_cash = _extract_concept(cf, _FR_CONCEPTS["op_cash"])
            capex = _extract_concept(cf, _FR_CONCEPTS["capex"])

            # D&A: prefer a combined concept; if unavailable, sum the split
            # depreciation + amortization line items (common in filings that
            # break the two apart in the cash-flow statement).
            dep_amort = _extract_concept(cf, _FR_CONCEPTS["dep_amort"])
            if dep_amort is None:
                dep = _extract_concept(cf, _FR_CONCEPTS["depreciation_only"])
                amort = _extract_concept(cf, _FR_CONCEPTS["amortization_only"])
                if dep is not None or amort is not None:
                    dep_amort = (dep or 0.0) + (amort or 0.0)

            # Derive gross_profit from revenue − cost_of_revenue when the
            # issuer doesn't report the GrossProfit concept directly
            # (services/platforms: GOOGL, AMZN, META, NFLX, ORCL, COIN, CRCL).
            if gross_profit is None and revenue is not None:
                cost_of_rev = _extract_concept(ic, _FR_CONCEPTS["cost_of_revenue"])
                if cost_of_rev is not None:
                    gross_profit = revenue - abs(cost_of_rev)

            # FCF = operating cash flow − |capex|. Capex is typically a
            # negative outflow in filings; abs() makes us direction-
            # agnostic across issuer conventions.
            free_cash_flow = None
            if op_cash is not None:
                free_cash_flow = op_cash - abs(capex) if capex is not None else op_cash

            # EBITDA ≈ operating income + D&A. If the filing doesn't break
            # out D&A we still emit operating_income alone — EBITDA stays null.
            ebitda = None
            if operating_income is not None and dep_amort is not None:
                ebitda = operating_income + dep_amort

            # Build upsert payload with only the columns we actually got
            # a value for — we never want to blank out an existing cell
            # with NULL just because this particular filing didn't break
            # out that specific line item.
            row: Dict[str, Any] = {"symbol": sym, "updated_at": now_iso}
            if revenue is not None:
                row["revenue"] = int(revenue)
            if net_income is not None:
                row["net_income"] = int(net_income)
            if gross_profit is not None:
                row["gross_profit"] = int(gross_profit)
            if operating_income is not None:
                row["operating_income"] = int(operating_income)
            if free_cash_flow is not None:
                row["free_cash_flow"] = int(free_cash_flow)
            if ebitda is not None:
                row["ebitda"] = int(ebitda)

            if len(row) <= 2:  # only symbol + updated_at
                logger.warning(
                    "Finnhub reported %s: no concepts matched (form=%s, fy=%s) — check taxonomy",
                    sym, latest.get("form"), latest.get("year"),
                )
                continue

            fiscal_label = f"{latest.get('form', '?')} FY{latest.get('year', '?')}"
            logger.info(
                "Finnhub reported %s (%s) → %d fields: %s",
                sym, fiscal_label, len(row) - 2,
                [k for k in row if k not in ("symbol", "updated_at")],
            )
            await asyncio.to_thread(
                lambda: supabase.table("stock_fundamentals").upsert(row, on_conflict="symbol").execute()
            )
            updated += 1
            await asyncio.sleep(1.5)
        except Exception as e:
            logger.warning("Finnhub reported sync failed for %s: %s", sym, e)
    logger.info("Finnhub reported annual sync complete: %d/%d", updated, len(stock_symbols))


async def _sync_finnhub_reported():
    """Single-flight wrapper around _do_finnhub_reported_sync."""
    global _finnhub_reported_running
    if _finnhub_reported_running:
        logger.info("Finnhub reported sync already in progress, skipping")
        return
    _finnhub_reported_running = True
    try:
        await _do_finnhub_reported_sync()
    finally:
        _finnhub_reported_running = False


@api_router.post("/stock-fundamentals/sync-reported")
async def trigger_finnhub_reported_sync(request: Request):
    """Manual trigger for the SEC-filings-based annual fundamentals sync."""
    _assert_internal_sync_authorized(request)
    if _finnhub_reported_running:
        return {"status": "reported sync already running"}
    asyncio.create_task(_sync_finnhub_reported())
    return {"status": "reported sync started"}


async def _finnhub_reported_weekly_loop():
    """Background loop: pull SEC as-reported annual filings once a week.

    Annuals are filed once per year per company, but we poll weekly so
    new 10-K filings show up within ~7 days of being filed. Leader-gated
    with a 6-day lease so exactly one replica runs it per cycle.
    """
    await asyncio.sleep(45)  # stagger behind the daily loop and CoinGecko
    while True:
        try:
            is_leader = await asyncio.to_thread(
                _try_claim_leadership, "finnhub_reported_weekly", 6 * 86400
            )
            if is_leader:
                await _sync_finnhub_reported()
            else:
                logger.debug("Finnhub reported: another replica holds the lease this cycle")
        except Exception as e:
            logger.error("Finnhub reported loop error: %s", e)
        await asyncio.sleep(604800)  # 7 days


@api_router.get("/forex-assets")
async def get_forex_assets():
    """Get forex perpetual assets (EUR, JPY, GBP)"""
    try:
        # Get main Hyperliquid perp data (no dex parameter = main exchange) — cached
        data = await _get_meta_and_asset_ctxs(dex=None)
        
        if not data or len(data) < 2:
            return {"assets": [], "count": 0}
        
        meta = data[0]
        asset_ctxs = data[1]
        universe = meta.get("universe", [])
        
        assets = []
        for i, asset in enumerate(universe):
            coin_name = asset.get("name", "")
            
            # Only include forex coins
            if coin_name not in FOREX_COINS:
                continue
            
            ctx = asset_ctxs[i] if i < len(asset_ctxs) else {}
            meta_info = FOREX_METADATA.get(coin_name, {
                "name": coin_name,
                "symbol": coin_name,
                "category": "forex"
            })
            
            mark_px = ctx.get("markPx")
            prev_day_px = ctx.get("prevDayPx")
            change_24h = None
            
            if mark_px and prev_day_px:
                try:
                    current = float(mark_px)
                    previous = float(prev_day_px)
                    if previous > 0:
                        change_24h = ((current - previous) / previous) * 100
                except (ValueError, ZeroDivisionError):
                    pass
            
            assets.append({
                "coin": coin_name,
                "name": meta_info["name"],
                "symbol": meta_info["symbol"],
                "category": "forex",
                "maxLeverage": asset.get("maxLeverage", 50),
                "szDecimals": asset.get("szDecimals", 0),
                "markPx": mark_px,
                "prevDayPx": prev_day_px,
                "dayNtlVlm": ctx.get("dayNtlVlm"),
                "openInterest": ctx.get("openInterest"),
                "funding": ctx.get("funding"),
                "change24h": change_24h,
                "isHip3": False
            })
        
        return {"assets": assets, "count": len(assets)}
        
    except Exception as e:
        logger.error(f"Error fetching forex assets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Push Notifications & Price Alerts Endpoints
# ============================================================================

@api_router.post("/push/register-token")
async def register_push_token(
    req: RegisterPushTokenRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Register or update an Expo push token for the authenticated user.
    Called when user logs in or grants notification permissions.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        # Clean up ALL old tokens for this user on the same platform.
        # Android/FCM rotates push tokens frequently; keeping stale tokens
        # causes failed deliveries every notification cycle.
        if req.platform:
            try:
                await asyncio.to_thread(lambda: supabase.table("push_tokens").delete().eq(
                    "user_id", auth_user.user_id
                ).eq(
                    "platform", req.platform
                ).neq(
                    "push_token", req.push_token
                ).execute())
            except Exception as cleanup_err:
                logger.warning(f"Failed to cleanup old {req.platform} tokens: {cleanup_err}")
        elif req.device_id:
            # Fallback: clean by device_id if platform not provided
            try:
                await asyncio.to_thread(lambda: supabase.table("push_tokens").delete().eq(
                    "user_id", auth_user.user_id
                ).eq(
                    "device_id", req.device_id
                ).neq(
                    "push_token", req.push_token
                ).execute())
            except Exception as cleanup_err:
                logger.warning(f"Failed to cleanup old tokens for device {req.device_id}: {cleanup_err}")
        
        # Normalize wallet address if provided
        wallet_addr = None
        if req.wallet_address:
            try:
                wallet_addr = Web3.to_checksum_address(req.wallet_address).lower()
            except Exception:
                wallet_addr = req.wallet_address.strip().lower() if req.wallet_address else None
            if wallet_addr:
                await _assert_caller_owns_wallet(auth_user, wallet_addr)
        
        # Upsert the token (update if exists, insert if new)
        upsert_data: Dict[str, Any] = {
            "user_id": auth_user.user_id,
            "push_token": req.push_token,
            "device_id": req.device_id,
            "platform": req.platform,
        }
        if wallet_addr:
            upsert_data["wallet_address"] = wallet_addr
        await asyncio.to_thread(lambda: supabase.table("push_tokens").upsert(
            upsert_data, on_conflict="user_id,push_token"
        ).execute())
        
        # Seed prefs only when missing. Never flip push_enabled here —
        # login / token refresh must not undo a Profile opt-out. The
        # Profile toggle PATCHes push_enabled before it registers a token.
        try:
            existing_prefs = await asyncio.to_thread(
                lambda: supabase.table("user_notification_preferences")
                .select("user_id")
                .eq("user_id", auth_user.user_id)
                .limit(1)
                .execute()
            )
            if not existing_prefs.data:
                await asyncio.to_thread(
                    lambda: supabase.table("user_notification_preferences")
                    .insert({
                        "user_id": auth_user.user_id,
                        "push_enabled": True,
                        "system_alerts_enabled": True,
                    })
                    .execute()
                )
        except Exception as pref_err:
            logger.warning(f"Failed to create default preferences (non-critical): {pref_err}")
        
        logger.info(f"Push token registered for user {auth_user.user_id[:20]}...")
        return {"success": True, "message": "Push token registered"}
    
    except Exception as e:
        logger.error(f"Failed to register push token: {e}")
        raise HTTPException(status_code=500, detail="Failed to register push token")


@api_router.delete("/push/unregister-token")
async def unregister_push_token(
    push_token: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Unregister a push token (e.g., on logout or when disabling notifications).
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        await asyncio.to_thread(lambda: supabase.table("push_tokens").delete().eq(
            "user_id", auth_user.user_id
        ).eq(
            "push_token", push_token
        ).execute())
        
        logger.info(f"Push token unregistered for user {auth_user.user_id[:20]}...")
        return {"success": True, "message": "Push token unregistered"}
    
    except Exception as e:
        logger.error(f"Failed to unregister push token: {e}")
        raise HTTPException(status_code=500, detail="Failed to unregister push token")


async def _validate_and_resolve_symbol(symbol: str) -> tuple[str, float | None]:
    """
    Validate a symbol exists and resolve HIP-3 format.
    Returns (resolved_symbol, current_price) or raises HTTPException if invalid.
    
    - Crypto (BTC, ETH, SOL, etc.) -> Main exchange (HIP-2), no suffix
    - Everything else -> HIP-3 `{COIN}:{dex}` storage (e.g. GOLD:xyz, ANTH:io)
    """
    raw = symbol.strip()
    preferred_dex: str | None = None
    base = raw
    if ":" in raw:
        left, right = raw.split(":", 1)
        if is_hip3_dex_name(left):
            preferred_dex = left.lower()
            base = right
        elif is_hip3_dex_name(right):
            preferred_dex = right.lower()
            base = left
        else:
            base = left
    symbol = base.upper().strip()
    
    try:
        # First, check main exchange (crypto only - HIP-2) — cached
        data = await _get_meta_and_asset_ctxs(dex=None)
        
        if data and len(data) >= 2:
            meta = data[0]
            asset_ctxs = data[1]
            universe = meta.get("universe", [])
            
            for i, asset in enumerate(universe):
                coin = asset.get("name", "")
                if coin.upper() == symbol:
                    # Found on main exchange (crypto)
                    mark_px = asset_ctxs[i].get("markPx") if i < len(asset_ctxs) else None
                    price = float(mark_px) if mark_px else None
                    return symbol, price
        
        # Not on main exchange, check HIP-3 dexes — preferred dex first (io:ANTH).
        search_dexes: list[str] = []
        if preferred_dex:
            search_dexes.append(preferred_dex)
        for hip3_dex in HIP3_DEXES:
            if hip3_dex not in search_dexes:
                search_dexes.append(hip3_dex)
        for hip3_dex in search_dexes:
            hip3_data = await _get_meta_and_asset_ctxs(dex=hip3_dex)
            
            if hip3_data and len(hip3_data) >= 2:
                hip3_meta = hip3_data[0]
                hip3_ctxs = hip3_data[1]
                hip3_universe = hip3_meta.get("universe", [])
                
                for i, asset in enumerate(hip3_universe):
                    coin = asset.get("name", "")
                    # HIP-3 assets come back as "xyz:GOLD" format - extract base symbol
                    coin_base = coin.split(":")[-1] if ":" in coin else coin
                    if coin_base.upper() == symbol:
                        # Allowlist only — skip unlisted HIP-3 names (e.g. io:SNDK).
                        _catalog_key, catalog_meta = _lookup_hip3_metadata(coin_base, hip3_dex)
                        if catalog_meta is None:
                            continue
                        # Found on HIP-3 (stocks/forex/commodities)
                        # Store as SYMBOL:dex format (e.g., GOLD:xyz, ANTH:io)
                        full_symbol = f"{coin_base}:{hip3_dex}"
                        mark_px = hip3_ctxs[i].get("markPx") if i < len(hip3_ctxs) else None
                        price = float(mark_px) if mark_px else None
                        return full_symbol, price
        
        # Symbol not found anywhere
        raise HTTPException(
            status_code=400, 
            detail=f"Symbol '{symbol}' not found. Please use a valid trading symbol (e.g., BTC, ETH, AAPL, GOLD)."
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Failed to validate symbol {symbol}: {e}")
        # If validation fails, allow the symbol through (don't block user)
        return symbol, None


@api_router.post("/alerts")
async def create_price_alert(
    req: CreatePriceAlertRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Create a new price alert for the authenticated user.
    Automatically validates symbols and converts HIP-3 format (e.g., AAPL -> AAPL:Trade.XYZ).
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        # Validate and resolve symbol (auto-converts HIP-3)
        resolved_symbol, current_price = await _validate_and_resolve_symbol(req.symbol)
        
        # Check if user has too many active alerts (limit to 3 per user)
        existing = await asyncio.to_thread(lambda: supabase.table("price_alerts").select("id", count="exact").eq(
            "user_id", auth_user.user_id
        ).eq(
            "is_active", True
        ).eq(
            "is_triggered", False
        ).execute())
        
        if existing.count and existing.count >= 5:
            raise HTTPException(status_code=400, detail="Maximum 5 active alerts. Delete or disable an existing alert first.")
        
        result = await asyncio.to_thread(lambda: supabase.table("price_alerts").insert({
            "user_id": auth_user.user_id,
            "symbol": resolved_symbol,  # Use resolved symbol (with :Trade.XYZ if HIP-3)
            "target_price": req.target_price,
            "condition": req.condition,
            "note": req.note,
            "is_active": True,
            "is_triggered": False,
        }).execute())
        
        if result.data:
            logger.info(f"Price alert created: {resolved_symbol} {req.condition} {req.target_price}")
            return {
                "success": True, 
                "alert": result.data[0],
                "current_price": current_price,  # Return current price for UX
            }
        
        raise HTTPException(status_code=500, detail="Failed to create alert")
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create price alert: {e}")
        raise HTTPException(status_code=500, detail="Failed to create price alert")


@api_router.get("/alerts")
async def get_user_alerts(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
    active_only: bool = False,
):
    """
    Get all price alerts for the authenticated user.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        query = supabase.table("price_alerts").select("*").eq(
            "user_id", auth_user.user_id
        ).order("created_at", desc=True)
        
        if active_only:
            query = query.eq("is_active", True).eq("is_triggered", False)
        
        result = await asyncio.to_thread(lambda: query.execute())
        return {"alerts": result.data or []}
    
    except Exception as e:
        logger.error(f"Failed to fetch alerts: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch alerts")


@api_router.patch("/alerts/{alert_id}")
async def update_price_alert(
    alert_id: str,
    req: UpdatePriceAlertRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Update an existing price alert.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        # Build update dict with only provided fields
        update_data = {}
        if req.is_active is not None:
            update_data["is_active"] = req.is_active
        if req.target_price is not None:
            update_data["target_price"] = req.target_price
        if req.condition is not None:
            update_data["condition"] = req.condition
        if req.note is not None:
            update_data["note"] = req.note
        
        if not update_data:
            raise HTTPException(status_code=400, detail="No fields to update")
        
        # Re-activating an alert should reset triggered status
        if req.is_active is True:
            update_data["is_triggered"] = False
            update_data["triggered_at"] = None
            update_data["triggered_price"] = None
        
        result = await asyncio.to_thread(lambda: supabase.table("price_alerts").update(update_data).eq(
            "id", alert_id
        ).eq(
            "user_id", auth_user.user_id  # Ensure user owns the alert
        ).execute())
        
        if result.data:
            return {"success": True, "alert": result.data[0]}
        
        raise HTTPException(status_code=404, detail="Alert not found")
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update alert: {e}")
        raise HTTPException(status_code=500, detail="Failed to update alert")


@api_router.delete("/alerts/{alert_id}")
async def delete_price_alert(
    alert_id: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Delete a price alert.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        result = await asyncio.to_thread(lambda: supabase.table("price_alerts").delete().eq(
            "id", alert_id
        ).eq(
            "user_id", auth_user.user_id  # Ensure user owns the alert
        ).execute())
        
        if result.data:
            return {"success": True, "message": "Alert deleted"}
        
        raise HTTPException(status_code=404, detail="Alert not found")
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete alert: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete alert")


@api_router.get("/alerts/history")
async def get_alert_history(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
    limit: int = 50,
):
    """
    Get triggered alert history for the authenticated user.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        result = await asyncio.to_thread(lambda: supabase.table("alert_history").select("*").eq(
            "user_id", auth_user.user_id
        ).order("triggered_at", desc=True).limit(limit).execute())
        
        return {"history": result.data or []}
    
    except Exception as e:
        logger.error(f"Failed to fetch alert history: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch alert history")


@api_router.get("/notifications/preferences")
async def get_notification_preferences(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Get notification preferences for the authenticated user.
    Returns defaults if no preferences have been set.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        result = await asyncio.to_thread(lambda: supabase.table("user_notification_preferences").select("*").eq(
            "user_id", auth_user.user_id
        ).execute())
        
        if result.data and len(result.data) > 0:
            return {"preferences": result.data[0]}
        
        # Return defaults if no preferences set
        return {
            "preferences": {
                "user_id": auth_user.user_id,
                "push_enabled": True,  # Master Expo push (Profile toggle)
                "system_alerts_enabled": True,  # Default enabled
                # UR banking push categories (inbox rows are always written;
                # these gate the PUSH only). Default on.
                "ur_transaction_alerts_enabled": True,
                "ur_card_alerts_enabled": True,
                "ur_kyc_alerts_enabled": True,
            }
        }
    
    except Exception as e:
        logger.error(f"Failed to fetch notification preferences: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch preferences")


class UpdateNotificationPreferencesRequest(BaseModel):
    push_enabled: Optional[bool] = None
    system_alerts_enabled: Optional[bool] = None
    ur_transaction_alerts_enabled: Optional[bool] = None
    ur_card_alerts_enabled: Optional[bool] = None
    ur_kyc_alerts_enabled: Optional[bool] = None


@api_router.patch("/notifications/preferences")
async def update_notification_preferences(
    req: UpdateNotificationPreferencesRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """
    Update notification preferences for the authenticated user.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    
    try:
        # Build update dict
        update_data = {"user_id": auth_user.user_id}
        if req.push_enabled is not None:
            update_data["push_enabled"] = req.push_enabled
        if req.system_alerts_enabled is not None:
            update_data["system_alerts_enabled"] = req.system_alerts_enabled
        if req.ur_transaction_alerts_enabled is not None:
            update_data["ur_transaction_alerts_enabled"] = req.ur_transaction_alerts_enabled
        if req.ur_card_alerts_enabled is not None:
            update_data["ur_card_alerts_enabled"] = req.ur_card_alerts_enabled
        if req.ur_kyc_alerts_enabled is not None:
            update_data["ur_kyc_alerts_enabled"] = req.ur_kyc_alerts_enabled
        
        # Upsert (create if doesn't exist, update if exists)
        result = await asyncio.to_thread(lambda: supabase.table("user_notification_preferences").upsert(
            update_data,
            on_conflict="user_id"
        ).execute())

        # Master off → drop every device token so leftover devices go quiet.
        if req.push_enabled is False:
            try:
                await asyncio.to_thread(
                    lambda: supabase.table("push_tokens")
                    .delete()
                    .eq("user_id", auth_user.user_id)
                    .execute()
                )
            except Exception as wipe_err:
                logger.warning(f"Failed to clear push tokens after opt-out: {wipe_err}")
        
        if result.data:
            return {"success": True, "preferences": result.data[0]}
        
        return {"success": True, "preferences": update_data}
    
    except Exception as e:
        logger.error(f"Failed to update notification preferences: {e}")
        raise HTTPException(status_code=500, detail="Failed to update preferences")


# ---------------------------------------------------------------------------
# Banking notification inbox (the bell feed on the Bank dashboard).
#
# Rows are produced server-side from UR webhooks (KYC outcome → system;
# pay-in / card spend / outgoing → transaction) into `ur_notifications`,
# scoped by Privy user_id. These endpoints are the read/mark-read surface for
# the in-app bell + notifications page.
# ---------------------------------------------------------------------------


def _serialize_notification(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "category": row.get("category"),
        "type": row.get("type"),
        "title": row.get("title"),
        "body": row.get("body"),
        "data": row.get("data") or {},
        "read": row.get("read_at") is not None,
        "createdAt": row.get("created_at"),
    }


@api_router.get("/notifications/feed")
async def get_notifications_feed(
    category: Optional[str] = None,
    limit: int = 50,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """List the authenticated user's banking notifications (most recent first)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Notifications not configured")
    cat = category if category in ur_db.NOTIF_CATEGORIES else None
    limit = max(1, min(int(limit or 50), 100))
    try:
        rows = await asyncio.to_thread(
            ur_db.list_notifications,
            supabase, user_id=auth_user.user_id, limit=limit, category=cat,
        )
        unread = await asyncio.to_thread(
            ur_db.count_unread_notifications, supabase, user_id=auth_user.user_id,
        )
    except Exception as e:
        logger.error(f"Failed to fetch notifications feed: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch notifications")
    return {
        "notifications": [_serialize_notification(r) for r in rows],
        "unreadCount": int(unread),
    }


@api_router.get("/notifications/unread-count")
async def get_notifications_unread_count(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Unread count for the bell badge."""
    if not supabase:
        return {"unreadCount": 0}
    try:
        unread = await asyncio.to_thread(
            ur_db.count_unread_notifications, supabase, user_id=auth_user.user_id,
        )
    except Exception as e:
        logger.error(f"Failed to count unread notifications: {e}")
        return {"unreadCount": 0}
    return {"unreadCount": int(unread)}


@api_router.post("/notifications/{notification_id}/read")
async def mark_notification_read_endpoint(
    notification_id: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Mark a single notification read (ownership-scoped)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Notifications not configured")
    try:
        await asyncio.to_thread(
            ur_db.mark_notification_read,
            supabase, user_id=auth_user.user_id, notification_id=notification_id,
        )
        unread = await asyncio.to_thread(
            ur_db.count_unread_notifications, supabase, user_id=auth_user.user_id,
        )
    except Exception as e:
        logger.error(f"Failed to mark notification read: {e}")
        raise HTTPException(status_code=500, detail="Failed to mark read")
    return {"success": True, "unreadCount": int(unread)}


@api_router.post("/notifications/read-all")
async def mark_all_notifications_read_endpoint(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Mark all of the user's notifications read (the 'duster' action)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Notifications not configured")
    try:
        touched = await asyncio.to_thread(
            ur_db.mark_all_notifications_read, supabase, user_id=auth_user.user_id,
        )
    except Exception as e:
        logger.error(f"Failed to mark all notifications read: {e}")
        raise HTTPException(status_code=500, detail="Failed to mark all read")
    return {"success": True, "marked": int(touched), "unreadCount": 0}


# ============================================================================
# Onboarding Guide
# ============================================================================

async def _upsert_user_onboarding(privy_user_id: str, fields: Dict[str, Any]) -> None:
    """Upsert ``user_onboarding``, enriching with Privy email when available."""
    payload: Dict[str, Any] = {"user_id": privy_user_id, **fields}
    email = await asyncio.to_thread(privy_import.fetch_privy_user_email, privy_user_id)
    if email:
        payload["email"] = email
    await asyncio.to_thread(
        lambda: supabase.table("user_onboarding")
        .upsert(payload, on_conflict="user_id")
        .execute()
    )


@api_router.get("/onboarding/status")
async def get_onboarding_status(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        result = await asyncio.to_thread(lambda: supabase.table("user_onboarding").select("guide_completed").eq(
            "user_id", auth_user.user_id
        ).execute())

        if result.data and len(result.data) > 0:
            return {"guide_completed": result.data[0]["guide_completed"]}

        return {"guide_completed": False}

    except Exception as e:
        logger.error(f"Failed to fetch onboarding status: {e}")
        return {"guide_completed": False}


@api_router.get("/onboarding/account-info")
async def get_onboarding_account_info(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return account metadata stored in user_onboarding (e.g. first-seen created_at)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        result = await asyncio.to_thread(lambda: supabase.table("user_onboarding").select("created_at").eq(
            "user_id", auth_user.user_id
        ).execute())

        if result.data and len(result.data) > 0:
            return {"created_at": result.data[0].get("created_at")}

        return {"created_at": None}

    except Exception as e:
        logger.error(f"Failed to fetch onboarding account info: {e}")
        return {"created_at": None}


@api_router.post("/onboarding/complete")
async def complete_onboarding(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        await _upsert_user_onboarding(
            auth_user.user_id,
            {
                "guide_completed": True,
                "completed_at": datetime.utcnow().isoformat(),
            },
        )

        return {"success": True}

    except Exception as e:
        logger.error(f"Failed to complete onboarding: {e}")
        raise HTTPException(status_code=500, detail="Failed to update onboarding status")


@api_router.get("/onboarding/asset-status")
async def get_asset_onboarding_status(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        result = await asyncio.to_thread(lambda: supabase.table("user_onboarding").select("asset_guide_completed").eq(
            "user_id", auth_user.user_id
        ).execute())

        if result.data and len(result.data) > 0:
            return {"asset_guide_completed": result.data[0].get("asset_guide_completed", False)}

        return {"asset_guide_completed": False}

    except Exception as e:
        logger.error(f"Failed to fetch asset onboarding status: {e}")
        return {"asset_guide_completed": False}


@api_router.post("/onboarding/complete-asset")
async def complete_asset_onboarding(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        await _upsert_user_onboarding(
            auth_user.user_id,
            {"asset_guide_completed": True},
        )

        return {"success": True}

    except Exception as e:
        logger.error(f"Failed to complete asset onboarding: {e}")
        raise HTTPException(status_code=500, detail="Failed to update asset onboarding status")


@api_router.get("/onboarding/interests")
async def get_onboarding_interests(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return all bank/card waitlist flags for the signed-in user."""
    empty = {
        "bank_interest": False,
        "bank_region_interest": False,
        "bank_region_interest_country": None,
        "card_interest": False,
    }
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        result = await asyncio.to_thread(lambda: supabase.table("user_onboarding").select(
            "bank_interest, bank_region_interest, bank_region_interest_country, card_interest"
        ).eq("user_id", auth_user.user_id).execute())

        if result.data and len(result.data) > 0:
            row = result.data[0]
            return {
                "bank_interest": bool(row.get("bank_interest")),
                "bank_region_interest": bool(row.get("bank_region_interest")),
                "bank_region_interest_country": row.get("bank_region_interest_country"),
                "card_interest": bool(row.get("card_interest")),
            }

        return empty

    except Exception as e:
        logger.error(f"Failed to fetch onboarding interests: {e}")
        return empty


@api_router.post("/bank/interest")
async def register_bank_interest(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Waitlist for the whole bank / cash / card service launch."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        await _upsert_user_onboarding(
            auth_user.user_id,
            {
                "bank_interest": True,
                "bank_interest_at": datetime.utcnow().isoformat(),
            },
        )

        return {"success": True}

    except Exception as e:
        logger.error(f"Failed to register bank interest: {e}")
        raise HTTPException(status_code=500, detail="Failed to register bank interest")


class BankRegionInterestRequest(BaseModel):
    country_code: str


@api_router.post("/bank/region-interest")
async def register_bank_region_interest(
    body: BankRegionInterestRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Waitlist for bank service in a specific unsupported country."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    code = (body.country_code or "").strip().upper()
    if len(code) != 2 or not code.isalpha():
        raise HTTPException(status_code=400, detail="country_code must be a 2-letter ISO code")

    try:
        await _upsert_user_onboarding(
            auth_user.user_id,
            {
                "bank_region_interest": True,
                "bank_region_interest_country": code,
                "bank_region_interest_at": datetime.utcnow().isoformat(),
            },
        )

        return {"success": True, "country_code": code}

    except Exception as e:
        logger.error(f"Failed to register bank region interest: {e}")
        raise HTTPException(status_code=500, detail="Failed to register bank region interest")


@api_router.get("/card/interest")
async def get_card_interest(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        result = await asyncio.to_thread(lambda: supabase.table("user_onboarding").select(
            "card_interest"
        ).eq("user_id", auth_user.user_id).execute())

        if result.data and len(result.data) > 0:
            return {"card_interest": bool(result.data[0].get("card_interest"))}

        return {"card_interest": False}

    except Exception as e:
        logger.error(f"Failed to fetch card interest: {e}")
        return {"card_interest": False}


@api_router.post("/card/interest")
async def register_card_interest(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        await _upsert_user_onboarding(
            auth_user.user_id,
            {
                "card_interest": True,
                "card_interest_at": datetime.utcnow().isoformat(),
            },
        )

        return {"success": True}

    except Exception as e:
        logger.error(f"Failed to register card interest: {e}")
        raise HTTPException(status_code=500, detail="Failed to register card interest")


# ============================================================================
# Demo Trading Mode (HL testnet)
# ============================================================================

def _demo_status_payload_from_row(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Shape a demo_funding row (or None) into the public /demo/status payload.

    Uses local module helper rather than constructing DemoStatusResponse here
    so callers from the cleanup loop (where we don't have HTTP context) can
    log the same shape.
    """
    if not row:
        return {
            "claimed": False,
            "status": None,
            "claimed_at": None,
            "sent_at": None,
            "tx_hash": None,
            "amount_usdc": None,
            "grant_amount_usdc": DEMO_GRANT_AMOUNT_USDC,
        }
    # Treat 'failed' as not-yet-claimed from the user's perspective so the UI
    # surfaces a retry CTA. The DB row stays for auditability but doesn't
    # block re-attempts (cleanup task plus the claim flow handle re-creation).
    status = row.get("status")
    claimed = status == "sent"
    return {
        "claimed": claimed,
        "status": status,
        "claimed_at": row.get("claimed_at"),
        "sent_at": row.get("sent_at"),
        "tx_hash": row.get("tx_hash"),
        "amount_usdc": float(row.get("amount_usdc") or 0) if claimed else None,
        "grant_amount_usdc": DEMO_GRANT_AMOUNT_USDC,
    }


def _fetch_demo_funding_row(privy_user_id: str) -> Optional[Dict[str, Any]]:
    """Single-row lookup. Returns None if no row exists. Lives outside async
    context (called via asyncio.to_thread) so the same helper works from both
    the request handler and the cleanup loop."""
    if not supabase:
        return None
    res = supabase.table("demo_funding").select("*").eq(
        "privy_user_id", privy_user_id
    ).limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None


def _fetch_demo_funding_by_device(device_id: str) -> Optional[Dict[str, Any]]:
    if not supabase or not device_id:
        return None
    res = supabase.table("demo_funding").select("*").eq(
        "device_id", device_id
    ).limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None


def _claim_demo_funds_sync(
    privy_user_id: str,
    wallet_address: str,
    device_id: Optional[str],
) -> Dict[str, Any]:
    """The full critical section for granting demo USDC, designed to be safe
    across the 4-replica deployment.

    Concurrency model:
      • ONE master agent on testnet → all signing serialised on the
        `demo_master:hl_testnet` lock id (Supabase relayer_lock table).
      • Per-user one-shot enforced via SELECT-then-INSERT under the same
        lock — no two replicas can race past the existence check because
        only one holds the lock at a time.
      • Per-device one-shot enforced via the same SELECT-under-lock plus a
        partial UNIQUE index as a defence-in-depth backstop (device_id is a
        soft sybil signal, not a primary key, so we surface a friendly error
        instead of letting the DB error bubble up).
      • If usdSend fails after we've inserted the 'pending' row, we mark the
        row 'failed' so the user can re-attempt. If the replica crashes in
        between, _demo_claim_cleanup_loop sweeps the stale 'pending' row
        after 2min so the user isn't permanently locked out.

    Returns a dict matching the DemoStatusResponse-ish shape, plus an
    `outcome` field: 'granted' | 'already_claimed' | 'device_taken'
    | 'pending_in_flight'.
    """
    if not demo_mode_enabled():
        raise RuntimeError("Demo mode not configured on this deployment")

    wallet_checksummed = Web3.to_checksum_address(wallet_address)
    master_addr = HL_TESTNET_MASTER_ADDRESS or ""

    if not _acquire_demo_master_lock(timeout_seconds=20.0):
        raise RuntimeError("Server busy — please try again in a moment.")

    try:
        # 1. Has this user ever claimed?
        existing = _fetch_demo_funding_row(privy_user_id)
        if existing:
            status = existing.get("status")
            if status == "sent":
                # Idempotent: same answer to a repeat tap. UI can show
                # "you already have $X" without an error toast.
                payload = _demo_status_payload_from_row(existing)
                payload["outcome"] = "already_claimed"
                return payload
            if status == "pending":
                # Another in-flight claim. Should be rare given we hold the
                # master lock, but possible if the previous replica crashed
                # mid-flow and the cleanup hasn't swept yet (< 2min window).
                payload = _demo_status_payload_from_row(existing)
                payload["outcome"] = "pending_in_flight"
                return payload
            # status == 'failed' → fall through to retry: delete the old row
            # so we can re-INSERT cleanly with a fresh claimed_at.
            supabase.table("demo_funding").delete().eq(
                "privy_user_id", privy_user_id
            ).execute()

        # 2. Device-level dedup. Skipped if the client didn't send a
        # device_id (older app builds) — we still let them claim, the
        # privy_user_id PK is the primary defense.
        if device_id:
            device_row = _fetch_demo_funding_by_device(device_id)
            if device_row:
                # A different Privy identity already claimed on this device.
                # Don't reveal which — just refuse.
                payload = _demo_status_payload_from_row(None)
                payload["outcome"] = "device_taken"
                return payload

        # 3. Insert pending row. Doing this BEFORE the network call means a
        # crash between insert and usdSend leaves an auditable trail, and
        # the cleanup task picks it up after 2min. The usdSend itself is
        # idempotent on the master nonce (HL rejects same-nonce replays)
        # so there's no risk of double-spending if we somehow retry.
        insert_row = {
            "privy_user_id": privy_user_id,
            "wallet_address": wallet_checksummed,
            "device_id": device_id,
            "amount_usdc": DEMO_GRANT_AMOUNT_USDC,
            "master_account": master_addr,
            "status": "pending",
        }
        try:
            supabase.table("demo_funding").insert(insert_row).execute()
        except Exception as ins_exc:
            # Race: another replica wrote between our SELECT and INSERT.
            # Re-fetch — if user row exists treat as already_claimed/in_flight,
            # if device_id constraint violated treat as device_taken.
            msg = str(ins_exc).lower()
            if "device_id" in msg or "demo_funding_device_idx" in msg:
                payload = _demo_status_payload_from_row(None)
                payload["outcome"] = "device_taken"
                return payload
            re_existing = _fetch_demo_funding_row(privy_user_id)
            if re_existing:
                payload = _demo_status_payload_from_row(re_existing)
                payload["outcome"] = (
                    "already_claimed" if re_existing.get("status") == "sent"
                    else "pending_in_flight"
                )
                return payload
            raise

        # 4. Sign and submit usdSend. If this throws, mark the row failed
        # so the user can retry on next tap.
        # Gross up by HL's flat transfer fee so the recipient nets exactly
        # the advertised grant. The DB row + UI continue to display the NET
        # grant — the fee gross-up is an implementation detail.
        wire_amount = DEMO_GRANT_AMOUNT_USDC + DEMO_TRANSFER_FEE_USDC
        try:
            audit_id = _hl_testnet_usd_send(wallet_checksummed, wire_amount)
        except Exception as send_exc:
            err_msg = (str(send_exc) or "unknown")[:500]
            logger.error("[demo] usdSend failed for user=%s wallet=%s: %s",
                         privy_user_id[:16], wallet_checksummed, err_msg)
            try:
                supabase.table("demo_funding").update({
                    "status": "failed",
                    "error_message": err_msg,
                }).eq("privy_user_id", privy_user_id).execute()
            except Exception as upd_exc:
                logger.warning("[demo] failed to mark row failed: %s", upd_exc)
            raise

        # 5. Success — flip to sent and return the post-update row.
        sent_at_iso = datetime.utcnow().isoformat()
        try:
            supabase.table("demo_funding").update({
                "status": "sent",
                "tx_hash": audit_id,
                "sent_at": sent_at_iso,
            }).eq("privy_user_id", privy_user_id).execute()
        except Exception as upd_exc:
            # The transfer landed but the DB write failed — log loudly so
            # support can reconcile manually. The user will see an error but
            # actually got their funds; on next /demo/status the row is
            # still 'pending' and the cleanup task will eventually mark it
            # failed. Edge case, won't repeat in normal ops.
            logger.error("[demo] DB update after successful usdSend failed: %s", upd_exc)
            raise

        final_row = _fetch_demo_funding_row(privy_user_id)
        payload = _demo_status_payload_from_row(final_row)
        payload["outcome"] = "granted"
        return payload

    finally:
        _release_demo_master_lock()


@api_router.post("/demo/claim-funds")
async def demo_claim_funds_endpoint(
    req: DemoClaimFundsRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not demo_mode_enabled():
        raise HTTPException(status_code=503, detail="Demo mode not configured")
    if not Web3.is_address(req.wallet_address):
        raise HTTPException(status_code=400, detail="Invalid wallet_address")

    await _assert_caller_owns_wallet(auth_user, req.wallet_address)

    try:
        result = await asyncio.to_thread(
            _claim_demo_funds_sync,
            auth_user.user_id,
            req.wallet_address,
            (req.device_id or None),
        )
    except RuntimeError as exc:
        # "Server busy" lock contention or known-shape runtime failures.
        msg = str(exc)
        if "Server busy" in msg:
            raise HTTPException(status_code=503, detail=msg)
        raise HTTPException(status_code=502, detail=f"Demo grant failed: {msg}")
    except Exception as exc:
        logger.exception("[demo] unexpected error in claim-funds")
        raise HTTPException(status_code=500, detail=f"Internal error: {exc}")

    outcome = result.pop("outcome", None)

    if outcome == "device_taken":
        # 409 Conflict — distinct from auth failures. Frontend can show
        # a "this device has already claimed" message.
        raise HTTPException(
            status_code=409,
            detail="This device has already claimed demo funds.",
        )

    if outcome == "pending_in_flight":
        # 409 with a distinct payload so frontend can show "still processing"
        # and retry after a short delay.
        return JSONResponse(
            status_code=202,
            content={"ok": False, "reason": "pending_in_flight", **result},
        )

    # 'granted' OR 'already_claimed' — both are idempotent successes.
    return {"ok": True, "outcome": outcome or "granted", **result}


@api_router.get("/demo/status")
async def demo_status_endpoint(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
) -> DemoStatusResponse:
    if not supabase:
        # Without Supabase we can't tell if the user claimed — fail closed
        # so the UI shows "claim available" rather than silently letting
        # them double-claim once Supabase comes back.
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        row = await asyncio.to_thread(_fetch_demo_funding_row, auth_user.user_id)
    except Exception as e:
        logger.error("[demo] /demo/status fetch failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch demo status")

    payload = _demo_status_payload_from_row(row)
    return DemoStatusResponse(**payload)


def _sweep_stuck_demo_claims_sync() -> int:
    """Mark `pending` rows older than 2 minutes as `failed`.

    Master lock TTL is 60s, so anything still pending after 2min implies the
    replica that started the claim crashed (or got OOM-killed mid-request)
    before completing usdSend. Stuck rows would otherwise permanently block
    the user from retrying.

    Returns the number of rows swept (for logging)."""
    if not supabase:
        return 0
    cutoff = (datetime.utcnow() - timedelta(minutes=2)).isoformat()
    try:
        res = supabase.table("demo_funding").update({
            "status": "failed",
            "error_message": "timeout — replica crashed mid-claim before usdSend confirmation",
        }).eq("status", "pending").lt("claimed_at", cutoff).execute()
        swept = len(res.data or [])
        if swept:
            logger.info("[demo] cleanup swept %d stuck pending claim(s)", swept)
        return swept
    except Exception as exc:
        logger.warning("[demo] cleanup sweep error: %s", exc)
        return 0


async def _demo_claim_cleanup_loop():
    """Leader-gated cleanup loop. Runs only on the replica that holds the
    `demo_claim_cleanup` task leadership lease, so 4 replicas don't all sweep
    in parallel. 60s sleep between cycles, 120s leadership TTL — exactly
    matches the existing alert-worker pattern."""
    logger.info("Demo claim cleanup loop started (replica %s)", _REPLICA_ID[:8])
    while True:
        try:
            is_leader = await asyncio.to_thread(
                _try_claim_leadership, "demo_claim_cleanup", 120
            )
            if is_leader:
                await asyncio.to_thread(_sweep_stuck_demo_claims_sync)
            else:
                logger.debug("Demo cleanup: another replica holds the lease this cycle")
        except Exception as exc:
            logger.exception("Demo cleanup loop error: %s", exc)
        await asyncio.sleep(60)


_demo_cleanup_task: Optional[asyncio.Task] = None


def start_demo_cleanup_worker():
    """Start the demo claim cleanup background task. Idempotent — second
    call is a no-op."""
    global _demo_cleanup_task
    if not supabase:
        logger.info("Demo cleanup worker not started: Supabase not configured")
        return
    if not demo_mode_enabled():
        logger.info("Demo cleanup worker not started: demo mode disabled")
        return
    if _demo_cleanup_task is not None:
        return
    _demo_cleanup_task = asyncio.create_task(_demo_claim_cleanup_loop())
    logger.info("Demo cleanup worker task created (replica %s)", _REPLICA_ID[:8])


def stop_demo_cleanup_worker():
    global _demo_cleanup_task
    if _demo_cleanup_task:
        _demo_cleanup_task.cancel()
        _demo_cleanup_task = None


# ============================================================================
# Price Alert Background Worker
# ============================================================================

async def _fetch_current_prices(symbols: List[str]) -> Dict[str, float]:
    """
    Fetch current prices for a list of symbols from Hyperliquid.
    Returns a dict of symbol -> current price.
    
    Handles both formats:
    - Simple symbols (BTC, GOLD) - checks main exchange first, then HIP-3
    - Full format (AAPL:xyz, ANTH:io, io:ANTH) - checks that HIP-3 dex
    """
    prices = {}
    
    # Normalize symbols: extract base symbol for lookup
    # "AAPL:xyz" / "io:ANTH" -> base ticker + dex name
    # "BTC" -> base="BTC", dex=None
    symbol_map: Dict[str, tuple[str, Optional[str]]] = {}
    for s in symbols:
        if ":" in s:
            dex, base = split_hip3_coin(s)
            symbol_map[s] = (base, dex)
        else:
            symbol_map[s] = (s, None)
    
    try:
        # 1. Fetch main exchange meta and asset contexts (crypto) — cached
        data = await _get_meta_and_asset_ctxs(dex=None)
        
        if data and len(data) >= 2:
            meta = data[0]
            asset_ctxs = data[1]
            universe = meta.get("universe", [])
            
            for i, asset in enumerate(universe):
                coin = asset.get("name", "")
                # Check if this coin matches any of our requested symbols
                for orig_symbol, (base, dex) in symbol_map.items():
                    if coin.upper() == base.upper() and dex is None and i < len(asset_ctxs):
                        ctx = asset_ctxs[i]
                        mark_px = ctx.get("markPx")
                        if mark_px:
                            try:
                                prices[orig_symbol] = float(mark_px)
                            except (ValueError, TypeError):
                                pass
        
        # 2. Fetch HIP-3 prices
        # Group symbols by their target dex, or check all HIP3_DEXES for symbols without explicit dex
        dex_symbols: Dict[str, List[str]] = {}
        symbols_without_dex = []
        
        for orig_symbol, (base, dex) in symbol_map.items():
            if orig_symbol in prices:
                # Already found on main exchange
                continue
            if dex:
                # Has explicit dex
                if dex not in dex_symbols:
                    dex_symbols[dex] = []
                dex_symbols[dex].append(orig_symbol)
            else:
                # No explicit dex - need to check all HIP-3 dexes
                symbols_without_dex.append(orig_symbol)
        
        # Add all HIP-3 dexes for symbols without explicit dex
        for hip3_dex in HIP3_DEXES:
            if symbols_without_dex:
                if hip3_dex not in dex_symbols:
                    dex_symbols[hip3_dex] = []
                dex_symbols[hip3_dex].extend(symbols_without_dex)
        
        for dex, dex_syms in dex_symbols.items():
            try:
                hip3_data = await _get_meta_and_asset_ctxs(dex=dex)
                
                if hip3_data and len(hip3_data) >= 2:
                    hip3_meta = hip3_data[0]
                    hip3_ctxs = hip3_data[1]
                    hip3_universe = hip3_meta.get("universe", [])
                    
                    for i, asset in enumerate(hip3_universe):
                        coin = asset.get("name", "")
                        # HIP-3 assets come back as "xyz:GOLD" - extract base symbol
                        coin_base = coin.split(":")[-1] if ":" in coin else coin
                        
                        for orig_symbol in dex_syms:
                            if orig_symbol in prices:
                                continue
                            base, _ = symbol_map[orig_symbol]
                            
                            # Match if base symbol matches (compare extracted base vs requested base)
                            if coin_base.upper() == base.upper() and i < len(hip3_ctxs):
                                ctx = hip3_ctxs[i]
                                mark_px = ctx.get("markPx")
                                if mark_px:
                                    try:
                                        prices[orig_symbol] = float(mark_px)
                                    except (ValueError, TypeError):
                                        pass
            except Exception as e:
                logger.warning(f"Failed to fetch HIP-3 prices for {dex}: {e}")
    
    except Exception as e:
        logger.error(f"Failed to fetch prices for alerts: {e}")
    
    return prices


def _send_push_notification(push_token: str, title: str, body: str, data: Optional[Dict] = None) -> bool:
    """
    Send a push notification via Expo's push service.
    Returns True if successful, False otherwise.
    """
    try:
        response = push_client.publish(
            PushMessage(
                to=push_token,
                title=title,
                body=body,
                data=data or {},
                sound="default",
                badge=1,
            )
        )
        
        # Check for errors
        if response.status == "ok":
            return True
        else:
            logger.warning(f"Push notification failed: {response.message}")
            return False
    
    except DeviceNotRegisteredError:
        # Token is invalid, should be removed
        logger.info(f"Device not registered, removing token: {push_token[:20]}...")
        if supabase:
            try:
                supabase.table("push_tokens").delete().eq("push_token", push_token).execute()
            except Exception:
                pass
        return False
    
    except PushServerError as e:
        logger.error(f"Push server error: {e}")
        return False
    
    except Exception as e:
        logger.error(f"Failed to send push notification: {e}")
        return False


def _alert_display_symbol(symbol: str) -> str:
    """Coin shown in alert push title/body. Leaves stored/matching symbols unchanged."""
    return hip3_display_symbol(symbol)


async def _check_and_trigger_alerts():
    """
    Background task that checks prices and triggers alerts.
    """
    if not supabase:
        return
    
    try:
        # Get all active, non-triggered alerts
        result = await asyncio.to_thread(lambda: supabase.table("price_alerts").select(
            "id, user_id, symbol, target_price, condition, note"
        ).eq(
            "is_active", True
        ).eq(
            "is_triggered", False
        ).execute())
        
        alerts = result.data or []
        if not alerts:
            return
        
        # Get unique symbols
        symbols = list(set(a["symbol"] for a in alerts))
        
        # Fetch current prices
        prices = await _fetch_current_prices(symbols)
        
        if not prices:
            return
        
        # Check each alert
        triggered_alerts = []
        for alert in alerts:
            symbol = alert["symbol"]
            current_price = prices.get(symbol)
            
            if current_price is None:
                continue
            
            target_price = float(alert["target_price"])
            condition = alert["condition"]
            
            # Check if alert should trigger
            should_trigger = False
            if condition == "above" and current_price >= target_price:
                should_trigger = True
            elif condition == "below" and current_price <= target_price:
                should_trigger = True
            
            if should_trigger:
                triggered_alerts.append({
                    **alert,
                    "triggered_price": current_price,
                })
        
        # Process triggered alerts
        for alert in triggered_alerts:
            try:
                # Update alert as triggered
                await asyncio.to_thread(lambda: supabase.table("price_alerts").update({
                    "is_triggered": True,
                    "triggered_at": datetime.utcnow().isoformat(),
                    "triggered_price": alert["triggered_price"],
                }).eq("id", alert["id"]).execute())
                
                # Add to history
                await asyncio.to_thread(lambda: supabase.table("alert_history").insert({
                    "user_id": alert["user_id"],
                    "symbol": alert["symbol"],
                    "target_price": alert["target_price"],
                    "triggered_price": alert["triggered_price"],
                    "condition": alert["condition"],
                    "note": alert.get("note"),
                }).execute())
                
                # Get user's push tokens
                tokens_result = await asyncio.to_thread(lambda: supabase.table("push_tokens").select("push_token").eq(
                    "user_id", alert["user_id"]
                ).execute())
                
                push_tokens = [t["push_token"] for t in (tokens_result.data or [])]
                
                logger.info(f"Alert {alert['id']}: Found {len(push_tokens)} push tokens for user {alert['user_id'][:20]}...")
                
                if not push_tokens:
                    logger.warning(f"Alert {alert['id']}: No push tokens found for user, skipping notification")
                    continue

                try:
                    pref_row = await asyncio.to_thread(
                        lambda: supabase.table("user_notification_preferences")
                        .select("push_enabled")
                        .eq("user_id", alert["user_id"])
                        .limit(1)
                        .execute()
                    )
                    if pref_row.data and pref_row.data[0].get("push_enabled") is False:
                        logger.info(f"Alert {alert['id']}: user muted master push, skipping")
                        continue
                except Exception as pref_err:
                    logger.warning(f"Alert {alert['id']}: push pref check failed: {pref_err}")
                
                # Format notification
                symbol = alert["symbol"]
                display_symbol = _alert_display_symbol(symbol)
                target = alert["target_price"]
                current = alert["triggered_price"]
                condition_text = "above" if alert["condition"] == "above" else "below"
                
                def _fmt_price(p: float) -> str:
                    """Human-readable price: $70,090.12 or $0.004231 — never scientific notation."""
                    if p >= 1:
                        return f"{p:,.2f}"
                    else:
                        return f"{p:.6f}".rstrip("0").rstrip(".")
                
                title = f"🔔 {display_symbol} Alert Triggered!"
                body = f"{display_symbol} is now ${_fmt_price(current)} ({condition_text} ${_fmt_price(target)})"
                if alert.get("note"):
                    body += f"\n{alert['note']}"
                
                # Send to all user's devices
                sent_count = 0
                failed_count = 0
                for token in push_tokens:
                    success = await asyncio.to_thread(
                        _send_push_notification,
                        token,
                        title,
                        body,
                        {"symbol": symbol, "price": current, "alert_id": alert["id"]},
                    )
                    if success:
                        sent_count += 1
                    else:
                        failed_count += 1
                
                logger.info(f"Alert triggered: {symbol} {alert['condition']} {target} (current: {current}) - sent: {sent_count}, failed: {failed_count}")
            
            except Exception as e:
                logger.error(f"Failed to process triggered alert {alert['id']}: {e}")
    
    except Exception as e:
        logger.error(f"Error in alert check cycle: {e}")


async def _check_and_send_system_alerts():
    """
    Check for round-number level crossings and send system-wide alerts.
    
    Examples:
    - BTC at 87500 → level 87k. Price hits 88001 → level 88k → "BTC above $88,000" 🔔
    - BTC at 88500 → level 88k. Price drops to 87999 → level 87k → "BTC below $88,000" 🔔
    - GOLD at 2950 → level 2900. Price hits 3001 → level 3000 → "GOLD above $3,000" 🔔
    """
    global _system_alert_last_levels
    
    if not supabase:
        return
    
    try:
        # Fetch current prices for system alert symbols
        symbols = list(SYSTEM_ALERT_LEVELS.keys())
        prices = await _fetch_current_prices(symbols)
        
        if not prices:
            logger.warning("System alerts: no prices fetched for BTC/GOLD")
            return
        
        # Log prices every cycle to confirm system is working
        price_str = ", ".join(f"{s}=${p:,.0f}" for s, p in prices.items())
        logger.info(f"System alerts check: {price_str}")
        
        for symbol, level_increment in SYSTEM_ALERT_LEVELS.items():
            current_price = prices.get(symbol)
            if current_price is None:
                continue
            
            # Calculate current level (floor to nearest increment)
            # e.g., BTC 88001 with increment 1000 → level 88 (representing $88,000)
            current_level = int(current_price // level_increment)
            
            # Initialize last level if not set
            if symbol not in _system_alert_last_levels:
                # Try to load from database
                try:
                    snapshot = await asyncio.to_thread(lambda: supabase.table("system_alert_price_snapshots").select("*").eq(
                        "symbol", symbol
                    ).execute())
                    
                    if snapshot.data and len(snapshot.data) > 0:
                        # Load saved level, or calculate from baseline_price
                        saved_baseline = float(snapshot.data[0]["baseline_price"])
                        loaded_level = int(saved_baseline // level_increment)
                        _system_alert_last_levels[symbol] = loaded_level
                        logger.info(f"System alerts loaded: {symbol} baseline=${saved_baseline:,.0f} → level={loaded_level}, current_level={current_level}")
                        
                        # DON'T continue here - check for level change immediately
                        # This fixes the bug where we'd miss a level cross that happened while server was down
                    else:
                        # Initialize with current level
                        _system_alert_last_levels[symbol] = current_level
                        await asyncio.to_thread(lambda: supabase.table("system_alert_price_snapshots").upsert({
                            "symbol": symbol,
                            "baseline_price": current_level * level_increment,  # Store the level price
                        }, on_conflict="symbol").execute())
                        logger.info(f"System alerts initialized: {symbol} at level ${current_level * level_increment:,.0f}")
                        continue  # Only continue if this is brand new init
                except Exception as e:
                    logger.warning(f"Failed to load level for {symbol}: {e}")
                    _system_alert_last_levels[symbol] = current_level
                    continue
            
            last_level = _system_alert_last_levels[symbol]
            
            logger.info(f"System alerts {symbol}: price=${current_price:,.0f}, current_level={current_level}, last_level={last_level}")
            
            # Check if level changed (crossed a round number)
            if current_level == last_level:
                continue
            
            logger.info(f"System alert LEVEL CHANGE detected: {symbol} level {last_level} → {current_level}")
            
            # Level crossed! Determine direction
            direction = "up" if current_level > last_level else "down"
            
            # The crossed level is the boundary we just passed
            # Going up: we crossed INTO current_level (e.g., 87k → 88k, crossed 88k)
            # Going down: we crossed OUT OF last_level (e.g., 88k → 87k, crossed below 88k)
            crossed_level = current_level if direction == "up" else last_level
            crossed_price = crossed_level * level_increment
            
            # HYSTERESIS CHECK: Ensure price is sufficiently past the threshold
            # This prevents rapid alerts when price oscillates around a level
            hysteresis_pct = SYSTEM_ALERT_HYSTERESIS.get(symbol, 0.001)
            buffer_amount = crossed_price * hysteresis_pct
            
            if direction == "up":
                # Price must be at least buffer_amount ABOVE the crossed level
                min_trigger_price = crossed_price + buffer_amount
                if current_price < min_trigger_price:
                    logger.info(f"System alert {symbol}: hysteresis check failed (up) - price ${current_price:,.0f} < ${min_trigger_price:,.0f}")
                    # Don't update level yet - wait for price to commit to the direction
                    continue
            else:
                # Price must be at least buffer_amount BELOW the crossed level
                max_trigger_price = crossed_price - buffer_amount
                if current_price > max_trigger_price:
                    logger.info(f"System alert {symbol}: hysteresis check failed (down) - price ${current_price:,.0f} > ${max_trigger_price:,.0f}")
                    # Don't update level yet - wait for price to commit to the direction
                    continue
            
            # Use level-based cooldown (not direction-based) to prevent up/down oscillation spam
            alert_type = f"level_{direction}_{int(crossed_price)}"
            
            # Check cooldown for ANY alert on this level (up or down)
            try:
                cooldown_time = datetime.utcnow() - timedelta(minutes=SYSTEM_ALERT_COOLDOWN_MINUTES)
                recent_alerts = await asyncio.to_thread(lambda: supabase.table("system_alerts_log").select("id").eq(
                    "symbol", symbol
                ).eq(
                    "move_amount", crossed_price  # move_amount stores the crossed level price
                ).gte(
                    "sent_at", cooldown_time.isoformat()
                ).execute())
                
                if recent_alerts.data and len(recent_alerts.data) > 0:
                    # Still in cooldown for this level (any direction)
                    logger.info(f"System alert {symbol}: level ${crossed_price:,.0f} in cooldown ({len(recent_alerts.data)} recent alerts)")
                    _system_alert_last_levels[symbol] = current_level
                    continue
            except Exception as e:
                logger.warning(f"Failed to check cooldown for {symbol}: {e}")
            
            # Get all users with system alerts enabled (default is enabled)
            try:
                # Get all push tokens
                tokens_result = await asyncio.to_thread(lambda: supabase.table("push_tokens").select(
                    "user_id, push_token"
                ).execute())
                
                # Filter out users who muted system alerts or the master push switch
                if tokens_result.data:
                    disabled_users = await asyncio.to_thread(lambda: supabase.table("user_notification_preferences").select(
                        "user_id, system_alerts_enabled, push_enabled"
                    ).execute())
                    
                    disabled_user_ids = set(
                        u["user_id"]
                        for u in (disabled_users.data or [])
                        if u.get("system_alerts_enabled") is False
                        or u.get("push_enabled") is False
                    )
                    tokens_result.data = [
                        t for t in tokens_result.data 
                        if t["user_id"] not in disabled_user_ids
                    ]
                
                push_tokens = [t["push_token"] for t in (tokens_result.data or [])]
                logger.info(f"System alert {symbol}: found {len(push_tokens)} push tokens to notify")
                
            except Exception as e:
                logger.warning(f"Failed to get system alert tokens: {e}")
                push_tokens = []
            
            # Update tracked level even if no users to notify
            _system_alert_last_levels[symbol] = current_level
            
            if not push_tokens:
                # Still update database to persist the level change
                try:
                    await asyncio.to_thread(lambda: supabase.table("system_alert_price_snapshots").upsert({
                        "symbol": symbol,
                        "baseline_price": current_level * level_increment,
                        "last_alert_price": current_price,
                    }, on_conflict="symbol").execute())
                    logger.info(f"System alert level updated (no tokens): {symbol} level {last_level} → {current_level}")
                except Exception as e:
                    logger.warning(f"Failed to update level for {symbol}: {e}")
                continue
            
            # Format notification
            emoji = "📈" if direction == "up" else "📉"
            direction_text = "above" if direction == "up" else "below"
            
            # Format the crossed level nicely (e.g., "$88,000" or "$3,000")
            if crossed_price >= 1000:
                level_str = f"${crossed_price:,.0f}"
            else:
                level_str = f"${crossed_price:.0f}"
            
            title = f"{emoji} {symbol} {direction_text} {level_str}"
            body = f"{symbol} moved {direction_text} {level_str} (now ${current_price:,.2f})"
            
            # Send to all opted-in users
            sent_count = 0
            for token in push_tokens:
                success = await asyncio.to_thread(
                    _send_push_notification,
                    token,
                    title,
                    body,
                    {"symbol": symbol, "price": current_price, "level": crossed_price, "type": "system_alert"},
                )
                if success:
                    sent_count += 1
            
            # Log the system alert
            try:
                await asyncio.to_thread(lambda: supabase.table("system_alerts_log").insert({
                    "symbol": symbol,
                    "alert_type": alert_type,
                    "from_price": last_level * level_increment,
                    "to_price": current_price,
                    "move_amount": crossed_price,  # Store the crossed level
                    "threshold": level_increment,
                    "users_notified": sent_count,
                }).execute())
            except Exception as e:
                logger.warning(f"Failed to log system alert: {e}")
            
            # Update database with new level
            try:
                await asyncio.to_thread(lambda: supabase.table("system_alert_price_snapshots").upsert({
                    "symbol": symbol,
                    "baseline_price": current_level * level_increment,
                    "last_alert_price": current_price,
                }, on_conflict="symbol").execute())
            except Exception as e:
                logger.warning(f"Failed to update level for {symbol}: {e}")
            
            logger.info(f"System alert sent: {symbol} {direction_text} {level_str} (now ${current_price:,.2f}, notified {sent_count} users)")
    
    except Exception as e:
        logger.error(f"Error in system alert check: {e}")


# ============================================================================
# USDC Deposit Notification Poller
# ============================================================================

# Arbitrum USDC ERC-20 Transfer event topic: Transfer(address,address,uint256)
_USDC_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# Poll every N alert cycles (e.g. every 2nd cycle = ~60s at 30s interval)
_DEPOSIT_POLL_CYCLE_INTERVAL = 2
_deposit_poll_counter = 0
# Minimum USDC amount to trigger a deposit notification (ignore dust/rebates)
_MIN_DEPOSIT_NOTIFY_USDC = 0.5  # $0.5


async def _check_deposit_notifications():
    """
    Poll Arbitrum for incoming USDC transfers to user embedded wallets.
    Sends a push notification when a deposit is detected.
    """
    global _deposit_poll_counter
    _deposit_poll_counter += 1
    if _deposit_poll_counter % _DEPOSIT_POLL_CYCLE_INTERVAL != 0:
        return  # Skip this cycle

    if not supabase or not ARBITRUM_RPC_URL:
        return

    try:
        # 1. Get all wallet addresses that have push tokens registered
        tokens_result = await asyncio.to_thread(lambda: supabase.table("push_tokens").select(
            "user_id, push_token, wallet_address"
        ).not_.is_("wallet_address", "null").execute())

        if not tokens_result.data:
            return  # No wallets to monitor

        # Build wallet → push_tokens mapping
        wallet_to_tokens: Dict[str, List[Dict[str, str]]] = {}
        for row in tokens_result.data:
            w = row["wallet_address"].lower()
            if w not in wallet_to_tokens:
                wallet_to_tokens[w] = []
            wallet_to_tokens[w].append({
                "user_id": row["user_id"],
                "push_token": row["push_token"],
            })

        if not wallet_to_tokens:
            return

        # 2. Get cursor (last scanned block)
        cursor_result = await asyncio.to_thread(lambda: supabase.table("deposit_scan_cursor").select("last_block").eq(
            "id", "singleton"
        ).execute())
        last_block = 0
        if cursor_result.data and len(cursor_result.data) > 0:
            last_block = int(cursor_result.data[0]["last_block"])

        # 3. Get latest block from Arbitrum RPC
        async with httpx.AsyncClient(timeout=10.0) as rpc_client:
            resp = await rpc_client.post(ARBITRUM_RPC_URL, json={
                "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []
            })
            rpc_data = resp.json()
            latest_block = int(rpc_data["result"], 16)

        # First run: start from ~500 blocks ago (~2 min on Arbitrum) to avoid scanning all history
        if last_block == 0:
            last_block = max(0, latest_block - 500)

        # Don't scan if we're already up-to-date
        if latest_block <= last_block:
            return

        # Cap scan range to 2000 blocks per cycle to avoid huge RPC responses
        from_block = last_block + 1
        to_block = min(latest_block, from_block + 2000)

        from_hex = hex(from_block)
        to_hex = hex(to_block)

        # 4. Query eth_getLogs for ALL USDC Transfer events in the block range
        #    We don't filter by recipient — we'll match in memory against known wallets.
        async with httpx.AsyncClient(timeout=15.0) as rpc_client:
            resp = await rpc_client.post(ARBITRUM_RPC_URL, json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "eth_getLogs",
                "params": [{
                    "address": ARBITRUM_USDC_ADDRESS,
                    "topics": [_USDC_TRANSFER_TOPIC],
                    "fromBlock": from_hex,
                    "toBlock": to_hex,
                }]
            })
            logs_data = resp.json()

        logs = logs_data.get("result", [])
        if not isinstance(logs, list):
            logger.warning("Deposit poller: unexpected eth_getLogs response")
            # Still update cursor to avoid re-scanning
            await asyncio.to_thread(lambda: supabase.table("deposit_scan_cursor").update({
                "last_block": to_block,
                "updated_at": datetime.utcnow().isoformat(),
            }).eq("id", "singleton").execute())
            return

        # 5. Classify each Transfer event for our wallets. One chain event can
        #    produce up to TWO notifications when both ends are watched app
        #    wallets (P2P): sender gets out_*, recipient gets in_ext. Directions:
        #      • `in_ext`       — USDC arrived at a watched wallet (external
        #                         deposit, HL trade→wallet landing, bank cash-out,
        #                         or another Hypertrade user). "Deposit Received".
        #      • `out_bridge2`  — user moved USDC from wallet to HL Bridge2.
        #                         "Trade balance funded" push.
        #      • `out_ext`      — user sent USDC from wallet to any other
        #                         address. Generic "USDC Sent" push.
        #    Same-address self-transfers only notify as outgoing (no in_ext).
        bridge2_addr = BRIDGE2_ADDRESS.lower() if BRIDGE2_ADDRESS else None
        events_to_notify: List[Dict[str, Any]] = []
        for log in logs:
            try:
                topics = log.get("topics", [])
                if len(topics) < 3:
                    continue
                # topics[1] = from, topics[2] = to (both padded to 32 bytes)
                sender = ("0x" + topics[1][26:]).lower()
                recipient = ("0x" + topics[2][26:]).lower()

                data_str = log.get("data", "0x0")
                amount_raw = int(data_str, 16)
                amount_usdc = amount_raw / 1e6
                if amount_usdc < _MIN_DEPOSIT_NOTIFY_USDC:
                    continue  # Skip dust / zero amounts
                tx_hash = log.get("transactionHash", "")
                if not tx_hash:
                    continue

                wallet_is_recipient = recipient in wallet_to_tokens
                wallet_is_sender = sender in wallet_to_tokens
                is_self_transfer = sender == recipient

                if wallet_is_sender:
                    if bridge2_addr and recipient == bridge2_addr:
                        direction = "out_bridge2"
                    else:
                        direction = "out_ext"
                    events_to_notify.append({
                        "tx_hash": tx_hash,
                        "wallet_address": sender,
                        "amount_usdc": amount_usdc,
                        "direction": direction,
                        "counterparty": recipient,
                    })

                # Recipient deposit push — including P2P between two watched
                # wallets. Skip self-transfers so we don't double-notify.
                if wallet_is_recipient and not is_self_transfer:
                    events_to_notify.append({
                        "tx_hash": tx_hash,
                        "wallet_address": recipient,
                        "amount_usdc": amount_usdc,
                        "direction": "in_ext",
                        "counterparty": sender,
                    })
            except Exception:
                continue

        # 6. Dedup and send notifications. `deposit_notifications_log` has a
        # unique (tx_hash, wallet_address) constraint, so encode the direction
        # into the stored tx_hash key to allow multiple rows per real tx_hash
        # (e.g. a self-send could match twice). This avoids a schema change.
        for evt in events_to_notify:
            tx_hash = evt["tx_hash"]
            wallet = evt["wallet_address"]
            amount = evt["amount_usdc"]
            direction = evt["direction"]
            counterparty = evt["counterparty"]
            dedup_key = f"{tx_hash}:{direction}"

            try:
                existing = await asyncio.to_thread(lambda: supabase.table("deposit_notifications_log").select("id").eq(
                    "tx_hash", dedup_key
                ).eq(
                    "wallet_address", wallet
                ).execute())
                if existing.data and len(existing.data) > 0:
                    continue  # Already notified
            except Exception:
                pass

            tokens_for_wallet = wallet_to_tokens.get(wallet, [])
            if not tokens_for_wallet:
                continue
            sent_count = 0

            # Format amount nicely
            if amount >= 1:
                amount_str = f"${amount:,.2f}"
            else:
                amount_str = f"${amount:.6f}"

            if direction == "in_ext":
                title = "💰 Deposit Received"
                body = f"{amount_str} USDC deposited to your wallet"
                push_type = "deposit_received"
            elif direction == "out_bridge2":
                title = "📈 Trade balance funded"
                body = f"{amount_str} USDC sent to your trade balance"
                push_type = "trade_balance_funded"
            else:  # out_ext
                # Truncate destination for privacy + readability (standard
                # wallet-UX pattern: 0xABCD…1234).
                cp_short = f"{counterparty[:6]}…{counterparty[-4:]}" if counterparty else ""
                title = "↗️ USDC Sent"
                body = (
                    f"{amount_str} USDC sent to {cp_short}" if cp_short
                    else f"{amount_str} USDC sent"
                )
                push_type = "wallet_usdc_sent"

            for token_info in tokens_for_wallet:
                success = await asyncio.to_thread(
                    _send_push_notification,
                    token_info["push_token"],
                    title,
                    body,
                    {
                        "type": push_type,
                        "amount_usdc": str(amount),
                        "tx_hash": tx_hash,
                        "direction": direction,
                        "counterparty": counterparty,
                    },
                )
                if success:
                    sent_count += 1

            try:
                await asyncio.to_thread(lambda: supabase.table("deposit_notifications_log").insert({
                    "tx_hash": dedup_key,
                    "wallet_address": wallet,
                    "amount_usdc": amount,
                }).execute())
            except Exception as e:
                if "unique" not in str(e).lower() and "duplicate" not in str(e).lower():
                    logger.warning(f"Failed to log transfer notification: {e}")

            if sent_count > 0:
                logger.info(
                    f"Transfer notification ({direction}) sent: {amount_str} USDC for {wallet[:10]}… "
                    f"(tx={tx_hash[:16]}…, {sent_count} device(s))"
                )

        # 7. Update cursor
        await asyncio.to_thread(lambda: supabase.table("deposit_scan_cursor").update({
            "last_block": to_block,
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", "singleton").execute())

        if events_to_notify:
            logger.info(
                f"Transfer poller: scanned blocks {from_block}–{to_block}, found {len(events_to_notify)} event(s) "
                f"across known wallets"
            )

    except Exception as e:
        logger.error(f"Error in transfer notification check: {e}")


async def _periodic_earnings_null_rewarm():
    """
    Re-warm earnings dates for symbols stuck at NULL.
    Runs at most once every _EARNINGS_NULL_REWARM_INTERVAL seconds.
    Queries Supabase for symbols with NULL next_earnings_date whose
    fetched_at is older than 12 hours, then re-fetches from Alpha Vantage.
    """
    global _last_earnings_null_rewarm
    import time as _time

    now = _time.time()
    if now - _last_earnings_null_rewarm < _EARNINGS_NULL_REWARM_INTERVAL:
        return  # Too soon since last re-warm

    _last_earnings_null_rewarm = now

    if not supabase:
        return

    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()
        rows = await asyncio.to_thread(lambda: (
            supabase.table("earnings_cache")
            .select("symbol, next_earnings_date, fetched_at")
            .is_("next_earnings_date", "null")
            .lt("fetched_at", cutoff)
            .execute()
        ))
        null_symbols = [r["symbol"] for r in (rows.data or []) if r.get("symbol")]
        if null_symbols:
            logger.info("Periodic earnings re-warm: %d symbols with NULL dates older than 12h: %s", len(null_symbols), null_symbols)
            asyncio.create_task(_warmup_earnings_only(null_symbols))
        else:
            logger.debug("Periodic earnings re-warm: no NULL-date symbols to retry")
    except Exception as e:
        logger.warning("Periodic earnings re-warm check failed: %s", e)


def _try_claim_leadership(
    task_name: str = "alert_worker",
    ttl_seconds: int = _LEADER_TTL_SECONDS,
) -> bool:
    """Attempt to claim or renew leadership for a background task via Supabase.

    Returns True if this replica is the current leader for *task_name*.

    For the hot alert loop we keep the default short TTL (~45s) so a
    crashed leader is replaced quickly. For rarely-fired jobs like daily
    CoinGecko supply or weekly Finnhub fundamentals we pass a TTL just
    shorter than the job interval — the winning replica holds the lease
    across the whole cycle so other replicas short-circuit when they
    wake up, turning N redundant syncs into exactly one.
    """
    if not supabase:
        return True  # dev mode — single process
    try:
        res = supabase.rpc("try_claim_leadership", {
            "p_task": task_name,
            "p_holder_id": _REPLICA_ID,
            "p_ttl_seconds": ttl_seconds,
        }).execute()
        return res.data is True
    except Exception as exc:
        logger.warning("Leadership claim failed for %s (will skip this cycle): %s", task_name, exc)
        return False


async def _alert_worker_loop():
    """Main loop for the alert background worker.

    Each iteration starts by trying to claim leadership.  Only the leader
    replica executes the actual work; all others just sleep and re-try
    on the next cycle.  This guarantees that deposit scanning, price
    alert notifications, and system alerts are never duplicated across
    replicas.
    """
    logger.info("Alert worker loop started (replica %s)", _REPLICA_ID[:8])

    _sig_cleanup_counter = 0
    while True:
        is_leader = await asyncio.to_thread(_try_claim_leadership)
        if is_leader:
            try:
                await _check_and_trigger_alerts()
                await _check_and_send_system_alerts()
                await _check_deposit_notifications()
                await _periodic_earnings_null_rewarm()
                await _drain_trade_sync_queue()

                # Purge expired rows every ~60 cycles (~30 min)
                _sig_cleanup_counter += 1
                if _sig_cleanup_counter >= 60:
                    _sig_cleanup_counter = 0
                    try:
                        await asyncio.to_thread(lambda: supabase.table("used_signatures").delete().lt(
                            "used_at", (datetime.utcnow() - timedelta(hours=2)).isoformat()
                        ).execute())
                    except Exception as ce:
                        logger.debug("Signature cleanup error: %s", ce)
            except Exception as e:
                logger.error("Alert worker error: %s", e)
        else:
            logger.debug("Not leader this cycle — skipping worker tasks")

        await asyncio.sleep(ALERT_CHECK_INTERVAL_SECONDS)


def start_alert_worker():
    """Start the alert background worker task."""
    global _alert_worker_task
    if not supabase:
        logger.warning("Cannot start alert worker: Supabase not configured")
        return
    if _alert_worker_task is not None:
        logger.info("Alert worker already running")
        return
    _alert_worker_task = asyncio.create_task(_alert_worker_loop())
    logger.info("Alert worker task created (replica %s)", _REPLICA_ID[:8])


def stop_alert_worker():
    """Cancel the alert background worker task."""
    global _alert_worker_task
    if _alert_worker_task:
        _alert_worker_task.cancel()
        _alert_worker_task = None
    logger.info("Alert worker stopped")


# Start background workers on app startup
@app.on_event("startup")
async def startup_event():
    """Called when the FastAPI app starts."""
    logger.info("Replica %s starting up", _REPLICA_ID[:8])
    start_alert_worker()
    start_demo_cleanup_worker()
    # Pre-load earnings cache from Supabase so it's available immediately
    # Also collect symbols with stale (past) dates for automatic re-warmup
    stale_symbols: List[str] = []
    if supabase:
        try:
            import time as _time
            today_iso = datetime.utcnow().date().isoformat()
            rows = await asyncio.to_thread(lambda: (
                supabase.table("earnings_cache")
                .select("symbol, next_earnings_date, fetched_at")
                .execute()
            ))
            loaded = 0
            _EARNINGS_NULL_RETRY_HOURS = 12  # Retry NULL dates after this many hours
            for row in (rows.data or []):
                sym = row.get("symbol")
                dt = row.get("next_earnings_date")
                if sym:
                    if dt is not None and dt < today_iso:
                        # Date is in the past — mark for re-warmup
                        stale_symbols.append(sym)
                    elif dt is None:
                        # No date available — retry if fetched long enough ago
                        fetched_at_str = row.get("fetched_at")
                        should_retry = True  # Default to retry if no fetched_at
                        if fetched_at_str:
                            try:
                                fetched_at = datetime.fromisoformat(fetched_at_str.replace("Z", "+00:00"))
                                hours_since = (datetime.now(timezone.utc) - fetched_at).total_seconds() / 3600
                                should_retry = hours_since >= _EARNINGS_NULL_RETRY_HOURS
                            except Exception:
                                pass
                        if should_retry:
                            stale_symbols.append(sym)
                        else:
                            # Recently fetched NULL — cache as-is, don't re-fetch yet
                            _earnings_mem_cache[sym] = (None, _time.time())
                            loaded += 1
                    else:
                        # dt >= today_iso — valid future date
                        _earnings_mem_cache[sym] = (dt, _time.time())
                        loaded += 1
            logger.info("Loaded %d earnings dates from Supabase into memory", loaded)
            if stale_symbols:
                # Leader-gate the warmup so only ONE replica calls Alpha Vantage.
                # Free tier is 25 calls/day and the warmup uses up to 24 symbols,
                # so a simultaneous N-replica cold boot would blow the quota N×.
                # 1h lease is plenty — the warmup finishes in a few minutes and
                # every replica short-circuits on its next startup via the memory
                # preload above (Supabase now has fresh data).
                is_warmup_leader = await asyncio.to_thread(
                    _try_claim_leadership, "earnings_warmup_startup", 3600
                )
                if is_warmup_leader:
                    logger.info("Found %d symbols with stale/null earnings dates, scheduling re-warmup (leader): %s", len(stale_symbols), stale_symbols)
                    asyncio.create_task(_warmup_earnings_only(stale_symbols))
                else:
                    logger.info("Found %d stale earnings symbols — another replica holds the warmup lease, skipping", len(stale_symbols))
        except Exception as e:
            logger.warning("Failed to pre-load earnings_cache from Supabase: %s", e)

    # Start CoinGecko circulating-supply sync (once on startup, then every 24h)
    asyncio.create_task(_coingecko_supply_loop())

    # Start Finnhub stock fundamentals sync (once on startup, then every 24h)
    asyncio.create_task(_finnhub_fundamentals_daily_loop())

    # Start Finnhub SEC as-reported annual fundamentals sync (weekly)
    asyncio.create_task(_finnhub_reported_weekly_loop())

    # Start Finnhub per-ticker stocks-news sync (every 30 minutes, leader-only)
    asyncio.create_task(_finnhub_company_news_loop())

    # Pre-warm the market-news in-process cache so the very first user
    # request doesn't pay the Finnhub + Gemini latency. After this one-shot
    # warmup, the TTL + stale-while-revalidate flow keeps things fresh.
    asyncio.create_task(_market_news_warmup_loop())

@app.on_event("shutdown")
async def shutdown_event():
    """Called when the FastAPI app shuts down."""
    stop_alert_worker()
    stop_demo_cleanup_worker()
# Include the router in the main app
# ---------------------------------------------------------------------------
# Geo-fence: block users from restricted regions (US)
# API lookup (ipapi.co HTTPS) with 24 h per-IP cache.
# Enforced via both a /geo-check endpoint (frontend screen) AND
# middleware (prevents direct API bypass).
# ---------------------------------------------------------------------------
import ipaddress as _ipaddress

_APPLE_REVIEW_BYPASS = os.getenv("APPLE_REVIEW_BYPASS", "").lower() == "true"

_geo_cache: Dict[str, Tuple[str, float]] = {}  # ip -> (country_code, epoch)
_GEO_CACHE_TTL = 86_400 
_GEO_BLOCKED_COUNTRIES = {
    "US",  # United States
    "UK",  # United Kingdom
    "KP",  # North Korea
    "IR",  # Iran
    "CU",  # Cuba
    "RU",  # Russia (includes Crimea, Donetsk, Luhansk in most geo-IP databases)
}
# Paths that must remain accessible regardless of geo (health, geo-check itself)
_GEO_EXEMPT_PATHS = {"/api/geo-check", "/api/health", "/health", "/", "/docs", "/openapi.json"}


def _is_private_ip(ip: str) -> bool:
    """Return True for loopback / private / link-local addresses."""
    try:
        return _ipaddress.ip_address(ip).is_private
    except (ValueError, TypeError):
        return False


def _get_client_ip(request: Request) -> str:
    """Extract real client IP from proxy headers (Railway / Cloudflare / nginx)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "0.0.0.0"


async def _lookup_country(ip: str) -> Optional[str]:
    """Return ISO 3166-1 alpha-2 country code for *ip*, or None on failure."""
    import time as _time

    # Never look up private/local IPs
    if _is_private_ip(ip):
        return None

    cached = _geo_cache.get(ip)
    if cached:
        code, ts = cached
        if (_time.time() - ts) < _GEO_CACHE_TTL:
            return code

    try:
        resp = await http_client.get(
            f"https://ipapi.co/{ip}/json/",
            timeout=3.0,
        )
        data = resp.json()
        if not data.get("error"):
            code = data.get("country_code", "")
            _geo_cache[ip] = (code, _time.time())
            return code
    except Exception as exc:
        logger.warning(f"Geo lookup failed for {ip}: {exc}")

    return None


# ---------------------------------------------------------------------------
# Forex display-currency rates  (ExchangeRate-API, cached 24 h in Supabase)
# ---------------------------------------------------------------------------
async def _fetch_and_upsert_forex_rates(*, force: bool = False) -> Dict[str, Any]:
    """Return USD-based rates. When ``force`` is False, reuse Supabase cache <24 h old."""
    if not FOREXRATE_KEY:
        raise HTTPException(status_code=503, detail="Forex rate service not configured")

    if not force:
        row = await asyncio.to_thread(
            lambda: supabase.table("forex_rates_cache").select("*")
            .eq("base_currency", "USD").maybe_single().execute()
        )
        cached = row.data if row else None
        if cached and cached.get("rates"):
            updated_at = datetime.fromisoformat(cached["updated_at"].replace("Z", "+00:00"))
            age_hours = (datetime.now(timezone.utc) - updated_at).total_seconds() / 3600
            if age_hours < 24:
                return {
                    "base": "USD",
                    "rates": _normalize_forex_rates(cached["rates"]),
                    "updated_at": cached["updated_at"],
                }

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{FOREXRATE_BASE_URL}/{FOREXRATE_KEY}/latest/USD")
        resp.raise_for_status()
        data = resp.json()

    if data.get("result") != "success":
        raise HTTPException(status_code=502, detail="ExchangeRate-API returned error")

    all_rates = data.get("conversion_rates", {})
    filtered = {code: all_rates[code] for code in FOREXRATE_SUPPORTED if code in all_rates}
    if "CNH" not in filtered and "CNY" in all_rates:
        filtered["CNH"] = all_rates["CNY"]
    filtered["USD"] = 1.0
    filtered = _normalize_forex_rates(filtered)

    now_iso = datetime.now(timezone.utc).isoformat()
    await asyncio.to_thread(
        lambda: supabase.table("forex_rates_cache").upsert({
            "base_currency": "USD",
            "rates": filtered,
            "updated_at": now_iso,
        }).execute()
    )
    return {"base": "USD", "rates": filtered, "updated_at": now_iso}


@api_router.get("/forex/rates")
async def get_forex_rates():
    """Return USD-based exchange rates for supported display currencies.

    Reads from a Supabase cache table (`forex_rates_cache`).  If the cached row
    is older than 24 hours the endpoint fetches fresh rates from ExchangeRate-API,
    upserts them into Supabase, and returns the new rates.  This keeps external
    API usage to ~1 request / day regardless of backend replica count.
    """
    try:
        return await _fetch_and_upsert_forex_rates(force=False)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Forex rates fetch failed: {exc}")
        # Attempt to return stale cache on error
        try:
            row = await asyncio.to_thread(
                lambda: supabase.table("forex_rates_cache").select("*")
                .eq("base_currency", "USD").maybe_single().execute()
            )
            if row and row.data and row.data.get("rates"):
                return {
                    "base": "USD",
                    "rates": _normalize_forex_rates(row.data["rates"]),
                    "updated_at": row.data["updated_at"],
                }
        except Exception:
            pass
        raise HTTPException(status_code=502, detail="Failed to fetch forex rates")


@api_router.post("/forex/rates/refresh")
async def refresh_forex_rates(request: Request):
    """Bypass the 24 h Supabase cache and fetch fresh display-currency rates.

    Gated by ``INTERNAL_SYNC_SECRET`` (or ``ALPHA_WARMUP_SECRET``). Pass via
    ``Authorization: Bearer <secret>`` or ``?secret=<secret>``.
    """
    _assert_internal_sync_authorized(request)
    try:
        result = await _fetch_and_upsert_forex_rates(force=True)
        return {"ok": True, **result}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Forex rates refresh failed: {exc}")
        raise HTTPException(status_code=502, detail="Failed to refresh forex rates")


@api_router.get("/geo-check")
async def geo_check(request: Request):
    """Return whether the caller's region is allowed."""
    if _APPLE_REVIEW_BYPASS:
        return {"allowed": True, "country": None}
    ip = _get_client_ip(request)
    country = await _lookup_country(ip)
    blocked = country in _GEO_BLOCKED_COUNTRIES if country else False
    return {"allowed": not blocked, "country": country}


# ---------------------------------------------------------------------------
# Market news (Finnhub /news + /company-news)
# ---------------------------------------------------------------------------
# Finnhub's market-news endpoint accepts four categories: general/forex/
# crypto/merger. We add a fifth synthetic category — `stocks` — populated
# by a periodic per-ticker /company-news sync over the symbols we actually
# list. Finnhub free-tier limit is 60 req/min; the global `_finnhub_rate_gate`
# guarantees we never exceed that across all loops & endpoints combined.
#
# Budget summary (numbers per process; all gated globally):
#   - /news (general, crypto, forex, merger): 4 calls every 10 min per replica
#     → 24/hr/replica = 0.4/min/replica steady-state.
#   - /company-news (~24 US tickers): leader-only, 30-min cycle, paced
#     ~1.5s/call → ~48 calls/hr → 0.8/min averaged, ~40/min in-cycle.
#   - Daily fundamentals sync: ~24 calls/day, paced 1.2s/call.
#   - Weekly reported sync: ~24 calls/week, paced 1.5s/call.
# Even in a worst-case overlap of all four, the rate gate caps us at 50/min.
_NEWS_CATEGORIES_UPSTREAM: frozenset = frozenset({"general", "crypto"})
_NEWS_CATEGORIES_ALLOWED: frozenset = _NEWS_CATEGORIES_UPSTREAM | {"stocks"}

# 30-minute in-process TTL for the upstream market-news categories.
# Matches the stocks-news refresh cadence and keeps translation churn low
# — financial headlines don't materially go stale inside a 30-min window.
# Coalesced by a per-category lock so a thundering herd after expiry
# triggers exactly one upstream request.
_NEWS_CACHE_TTL_SECONDS = 1800
_news_cache: Dict[str, Tuple[List[dict], float]] = {}
_news_locks: Dict[str, asyncio.Lock] = {c: asyncio.Lock() for c in _NEWS_CATEGORIES_UPSTREAM}

# How many headlines to translate per category. Matches the UI's
# `MAX_NEWS_PER_CATEGORY = 10` in news.tsx so we never spend tokens on
# items that can't be displayed.
_NEWS_TRANSLATE_TOP_N = 10
# Locales we translate into. English skipped because Finnhub returns English.
_NEWS_TARGET_LOCALES: Tuple[str, ...] = (
    "es", "fr", "pt", "ar", "ja", "ru", "tr", "zh", "ko", "id",
)


# ── Gemini-powered headline translation ──────────────────────────────────────
# We translate ONLY the first N (typically 10) headlines per category, in a
# single batched call to gemini-2.5-flash with structured JSON output and
# thinking disabled. Each item is translated exactly once in its lifetime:
# subsequent cache refreshes re-use the prior translations by item id and
# only call Gemini for genuinely new headlines.
#
# Budget on Gemini AI Studio free tier (250 RPD / 250k TPM):
#   - ~3 calls/day for the leader-gated stocks sync (every 30 min, mostly
#     warm cache so only carries over).
#   - ~30-80 calls/day across all replicas for market-news cache misses
#     where the top-10 actually changed.
# Total well under the 250 RPD limit; thinking-off keeps tokens-per-call low.
_NEWS_TRANSLATE_TIMEOUT = 30.0       # hard timeout per Gemini call (seconds)
_NEWS_TRANSLATE_BATCH_LIMIT = 10      # never send more than this many items per call


def _build_translation_prompt(headlines: List[Tuple[int, str]]) -> str:
    """Build a strict JSON-output prompt for batched headline translation.

    *headlines* is a list of (index, english_text) pairs. The model is told
    to return one object per index with one key per target locale code.
    Tickers, percentages, $ amounts, ALL-CAPS company tags are preserved
    verbatim — that's the most common failure mode for financial news.
    """
    items_json = json.dumps(
        [{"i": idx, "text": text} for idx, text in headlines],
        ensure_ascii=False,
    )
    locales_csv = ", ".join(_NEWS_TARGET_LOCALES)
    return (
        "You are a professional financial-news translator. Translate ONLY the "
        "headlines below from English into EACH of the target languages.\n\n"
        "RULES (critical):\n"
        "- Preserve ticker symbols verbatim: AAPL, $AAPL, BTC, TSLA, etc.\n"
        "- Preserve numerical figures and units exactly: %, $1.2B, Q2 FY2026, 10x.\n"
        "- Keep brand/company names in their commonly used localized form; "
        "transliterate ONLY when natural for the target language.\n"
        "- Use natural idiomatic phrasing — do NOT translate word-for-word.\n"
        "- Output STRICT JSON only. No commentary, no markdown fences.\n\n"
        f"TARGET LOCALE CODES (use these EXACT keys): {locales_csv}\n\n"
        "OUTPUT SCHEMA:\n"
        '{ "items": [ { "i": <int>, "es": "...", "fr": "...", "pt": "...", '
        '"ar": "...", "ja": "...", "ru": "...", "tr": "...", "zh": "...", '
        '"ko": "...", "id": "..." }, ... ] }\n\n'
        "Return one item per input headline, same order, same `i` value.\n\n"
        f"INPUT HEADLINES:\n{items_json}"
    )


def _translate_headlines_sync(headlines: List[Tuple[int, str]]) -> Dict[int, Dict[str, str]]:
    """Blocking Gemini call that returns {index: {locale: translation}}.

    Returns an empty dict on any failure — callers must treat translation
    as best-effort and fall back to English in the UI.
    """
    if not headlines:
        return {}
    client = _get_gemini_client()
    if not client:
        logger.debug("News translation skipped: Gemini client not configured")
        return {}

    from google.genai import types as _gtypes

    prompt = _build_translation_prompt(headlines)
    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL_ID,
            contents=prompt,
            config=_gtypes.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.2,
                # Disable Gemini 2.5's reasoning step — translation is pure
                # transduction, so thinking-tokens are pure waste here.
                thinking_config=_gtypes.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception as exc:
        logger.warning("News translation Gemini call failed: %s", exc)
        return {}

    raw = (getattr(response, "text", None) or "").strip()
    if not raw:
        logger.warning("News translation returned empty response")
        return {}
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError) as exc:
        logger.warning("News translation JSON parse failed: %s | raw=%s", exc, raw[:200])
        return {}

    out: Dict[int, Dict[str, str]] = {}
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return out
    for entry in items:
        if not isinstance(entry, dict):
            continue
        try:
            idx = int(entry.get("i"))
        except (TypeError, ValueError):
            continue
        translations: Dict[str, str] = {}
        for loc in _NEWS_TARGET_LOCALES:
            val = entry.get(loc)
            if isinstance(val, str) and val.strip():
                translations[loc] = val.strip()
        if translations:
            out[idx] = translations
    return out


async def _attach_translations_top_n(
    items: List[dict],
    prior: Dict[Any, Dict[str, str]],
    *,
    skip_gemini: bool = False,
) -> None:
    """In-place: ensure the first N items carry a `translations` dict.

    *prior* maps item-id → previous translations dict, used to skip work
    for items that were already translated in an earlier cache cycle.
    Items beyond top-N are left without a translations field — the UI
    only renders top-N anyway.

    When *skip_gemini* is True, only carry over prior translations; any
    new headlines stay English until a background job runs Gemini.
    """
    if not items:
        return

    top = items[:_NEWS_TRANSLATE_TOP_N]
    need: List[Tuple[int, str]] = []  # (index_into_top, english_headline)
    for idx, item in enumerate(top):
        carried = prior.get(item.get("id")) if item.get("id") is not None else None
        if carried and isinstance(carried, dict) and any(carried.values()):
            item["translations"] = carried
            continue
        item.setdefault("translations", {})
        if item.get("headline"):
            need.append((idx, item["headline"]))

    if not need or skip_gemini:
        return

    try:
        translated = await asyncio.wait_for(
            asyncio.to_thread(
                _translate_headlines_sync, need[:_NEWS_TRANSLATE_BATCH_LIMIT]
            ),
            timeout=_NEWS_TRANSLATE_TIMEOUT,
        )
    except asyncio.TimeoutError:
        logger.warning("News translation timed out after %ss", _NEWS_TRANSLATE_TIMEOUT)
        return
    except Exception as exc:
        logger.warning("News translation thread error: %s", exc)
        return

    for idx, _english in need:
        if idx in translated:
            top[idx]["translations"] = translated[idx]


def _index_translations(items: List[dict]) -> Dict[Any, Dict[str, str]]:
    """Build {id: translations} for fast carry-over on the next refresh."""
    out: Dict[Any, Dict[str, str]] = {}
    for item in items or []:
        iid = item.get("id")
        tr = item.get("translations")
        if iid is not None and isinstance(tr, dict) and tr:
            out[iid] = tr
    return out


def _resolve_news_locale(
    locale: Optional[str] = None,
    accept_language: Optional[str] = None,
) -> str:
    """Normalize client locale to a base code (``en``, ``es``, …)."""
    raw = (locale or "").strip().lower()
    if not raw and accept_language:
        first = accept_language.split(",")[0].strip().split(";")[0].strip().lower()
        raw = first
    if not raw:
        return "en"
    base = raw.split("-")[0]
    if base == "en" or base in _NEWS_TARGET_LOCALES:
        return base
    return "en"


def _locale_wants_sync_translation(locale_base: str) -> bool:
    """Non-English clients block on Gemini during pull / cold fetch."""
    return locale_base != "en"


async def _translate_market_news_cache_background(cat: str) -> None:
    """Fill in missing translations on the current in-process cache row."""
    lock = _news_locks.get(cat)
    if lock is None:
        return
    try:
        async with lock:
            cached = _news_cache.get(cat)
            if not cached:
                return
            items, fetched_at = cached
            prior = _index_translations(items)
            await _attach_translations_top_n(items, prior)
            _news_cache[cat] = (items, fetched_at)
    except Exception as exc:
        logger.warning("Background news translation for %s failed: %s", cat, exc)


async def _fetch_and_cache_market_news(
    cat: str,
    *,
    wait_for_translation: bool,
) -> Tuple[List[dict], float]:
    """Fetch Finnhub for *cat*, update in-process cache, return (items, fetched_at)."""
    import time as _time

    async with _news_locks[cat]:
        cached = _news_cache.get(cat)
        try:
            items = await _fetch_finnhub_market_news(cat)
            prior_translations = _index_translations(cached[0] if cached else [])
            await _attach_translations_top_n(
                items,
                prior_translations,
                skip_gemini=not wait_for_translation,
            )
            fetched_at = _time.time()
            _news_cache[cat] = (items, fetched_at)
            if not wait_for_translation:
                asyncio.create_task(_translate_market_news_cache_background(cat))
            return items, fetched_at
        except HTTPException:
            if cached:
                return cached
            raise


def _normalize_news_item(raw: dict) -> dict:
    """Whittle Finnhub's payload down to the fields the client renders."""
    try:
        ts = int(raw.get("datetime") or 0)
    except (TypeError, ValueError):
        ts = 0
    return {
        "id": raw.get("id"),
        "headline": (raw.get("headline") or "").strip(),
        "summary": (raw.get("summary") or "").strip(),
        "source": (raw.get("source") or "").strip(),
        "url": (raw.get("url") or "").strip(),
        "image": (raw.get("image") or "").strip(),
        "datetime": ts,
        "related": (raw.get("related") or "").strip(),
        "category": (raw.get("category") or "").strip(),
    }


async def _fetch_finnhub_market_news(category: str) -> List[dict]:
    """Fetch & normalize fresh market news for *category* from Finnhub."""
    if not FINNHUB_API_KEY:
        raise HTTPException(status_code=503, detail="News provider not configured")
    if http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not ready")

    url = f"{FINNHUB_BASE_URL}/news?category={category}&token={FINNHUB_API_KEY}"
    await _finnhub_rate_gate()
    try:
        resp = await http_client.get(url, timeout=15.0)
    except httpx.HTTPError as exc:
        logger.warning("Finnhub /news %s network error: %s", category, exc)
        raise HTTPException(status_code=502, detail="Failed to reach news provider")

    if resp.status_code == 429:
        logger.warning("Finnhub /news rate-limited for %s", category)
        raise HTTPException(status_code=429, detail="News provider rate-limited")
    if resp.status_code != 200:
        logger.warning("Finnhub /news %s -> %d: %s", category, resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail="News provider error")

    try:
        payload = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Bad news payload")
    if not isinstance(payload, list):
        return []

    cleaned: List[dict] = []
    seen_ids: set = set()
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        item = _normalize_news_item(raw)
        # Drop items missing the essentials so the UI doesn't render empty cards
        if not item["headline"] or not item["url"]:
            continue
        # Finnhub sometimes returns duplicate IDs across mirrored sources
        if item["id"] is not None and item["id"] in seen_ids:
            continue
        if item["id"] is not None:
            seen_ids.add(item["id"])
        cleaned.append(item)

    cleaned.sort(key=lambda c: c["datetime"], reverse=True)
    return cleaned


# ── Stocks news via /company-news (per-ticker, leader-gated) ─────────────────
# Aggregates the most recent /company-news headlines for every US-listed
# stock in ASSET_METADATA into a single shared cache row in Supabase. One
# replica refreshes; all replicas serve from the cache. With ~24 tickers
# at 1.5s pacing each cycle takes ~36s of wall time and consumes ~24 Finnhub
# calls — every 30 min that's 48/hr, or 0.8 calls/min averaged.
#
# Lookback is intentionally short (~36h) because /company-news for a single
# mega-cap ticker over a 7-day window can return 100+ stories — the bulk
# is noise. We then keep only the top 2 most-recent per ticker so a single
# popular name (e.g. AAPL, TSLA) can't crowd out the aggregate feed.
_STOCKS_NEWS_LOOKBACK_HOURS = 36     # window passed to /company-news (from/to)
_STOCKS_NEWS_PER_TICKER = 1          # newest 1 story per ticker — keeps the
                                     # aggregate diverse and avoids one noisy
                                     # name (AAPL/TSLA) crowding the feed.
_STOCKS_NEWS_KEEP_TOTAL = 40         # cap aggregate row size before persisting
_STOCKS_NEWS_PACE_SECONDS = 1.5      # gap between per-ticker upstream calls
_STOCKS_NEWS_SYNC_INTERVAL = 30 * 60   # 30-min refresh cadence (relaxed)
_STOCKS_NEWS_LEASE_SECONDS = 25 * 60   # leader lease (< interval)
_STOCKS_NEWS_LOCAL_TTL = 60          # in-process cache before re-reading Supabase
_STOCKS_NEWS_STARTUP_DELAY = 30      # short cold-start delay so we don't wait 30 min for first batch

_stocks_news_cache: Tuple[List[dict], float, float] = ([], 0.0, 0.0)
# (items, monotonic_read_ts, wall_fetched_at)
_stocks_news_read_lock = asyncio.Lock()
_finnhub_company_news_running = False


async def _do_finnhub_company_news_sync() -> None:
    """Refresh the per-ticker stocks news aggregate and persist to Supabase."""
    if not supabase or not FINNHUB_API_KEY or http_client is None:
        logger.warning(
            "Company-news sync skipped: supabase=%s, FINNHUB_API_KEY=%s, http_client=%s",
            bool(supabase), bool(FINNHUB_API_KEY), bool(http_client),
        )
        return

    stock_symbols = _finnhub_sync_stock_symbols()
    if not stock_symbols:
        return

    # Finnhub /company-news accepts date strings (YYYY-MM-DD); we widen the
    # window by 1 day on the `from` side so we never miss yesterday's late
    # stories when called near UTC midnight, then filter by datetime in code.
    now_utc = datetime.now(timezone.utc)
    cutoff_ts = int((now_utc - timedelta(hours=_STOCKS_NEWS_LOOKBACK_HOURS)).timestamp())
    from_date = (now_utc.date() - timedelta(days=2)).isoformat()
    to_date = now_utc.date().isoformat()

    logger.info(
        "Company-news sync starting: %d tickers, window=%s..%s, per_ticker=%d",
        len(stock_symbols), from_date, to_date, _STOCKS_NEWS_PER_TICKER,
    )

    aggregated: Dict[Any, dict] = {}  # id -> item; dedups across tickers
    fallback_id_seq = 0
    fetched_tickers = 0

    for sym in stock_symbols:
        fh_sym = _finnhub_api_symbol(sym)
        url = (
            f"{FINNHUB_BASE_URL}/company-news"
            f"?symbol={fh_sym}&from={from_date}&to={to_date}&token={FINNHUB_API_KEY}"
        )
        try:
            await _finnhub_rate_gate()
            resp = await http_client.get(url, timeout=15.0)
        except httpx.HTTPError as exc:
            logger.warning("Company-news network error %s: %s", sym, exc)
            await asyncio.sleep(_STOCKS_NEWS_PACE_SECONDS)
            continue

        if resp.status_code == 429:
            logger.warning("Company-news rate-limited at %s — sleeping 60s and stopping cycle", sym)
            await asyncio.sleep(60)
            break
        if resp.status_code != 200:
            logger.warning("Company-news %s -> %d: %s", sym, resp.status_code, resp.text[:200])
            await asyncio.sleep(_STOCKS_NEWS_PACE_SECONDS)
            continue

        try:
            payload = resp.json() or []
        except Exception:
            payload = []
        if not isinstance(payload, list):
            payload = []

        # Most-recent first, filter to the rolling lookback window, then cap
        # per-ticker so a noisy name (e.g. TSLA) doesn't dominate.
        ticker_items: List[dict] = []
        for raw in payload:
            if not isinstance(raw, dict):
                continue
            item = _normalize_news_item(raw)
            if not item["headline"] or not item["url"]:
                continue
            if item["datetime"] and item["datetime"] < cutoff_ts:
                continue  # outside the rolling lookback window
            if not item["related"]:
                item["related"] = sym  # ensure ticker is always visible
            ticker_items.append(item)
        ticker_items.sort(key=lambda c: c["datetime"], reverse=True)
        ticker_items = ticker_items[:_STOCKS_NEWS_PER_TICKER]

        for item in ticker_items:
            iid = item.get("id")
            if not isinstance(iid, int):
                fallback_id_seq -= 1
                iid = fallback_id_seq
            if iid not in aggregated:
                aggregated[iid] = item

        fetched_tickers += 1
        await asyncio.sleep(_STOCKS_NEWS_PACE_SECONDS)

    merged = list(aggregated.values())
    merged.sort(key=lambda c: c["datetime"], reverse=True)
    merged = merged[:_STOCKS_NEWS_KEEP_TOTAL]

    if not merged:
        logger.warning("Company-news sync produced 0 stories (fetched %d/%d tickers)",
                       fetched_tickers, len(stock_symbols))
        return

    # Carry over translations from the previously-persisted row so items
    # whose `id` already appeared in a prior cycle don't get re-translated.
    # We only call Gemini for genuinely new ids in the top-N slot.
    prior_translations: Dict[Any, Dict[str, str]] = {}
    try:
        prior_row = await asyncio.to_thread(
            lambda: supabase.table("news_cache")
                .select("items")
                .eq("key", "stocks")
                .maybe_single()
                .execute()
        )
        prior_items = (prior_row.data or {}).get("items") if prior_row else None
        if isinstance(prior_items, list):
            prior_translations = _index_translations(prior_items)
    except Exception as exc:
        logger.warning("Company-news: failed to read prior translations: %s", exc)

    await _attach_translations_top_n(merged, prior_translations)

    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        await asyncio.to_thread(
            lambda: supabase.table("news_cache").upsert(
                {"key": "stocks", "items": merged, "updated_at": now_iso},
                on_conflict="key",
            ).execute()
        )
        # Refresh in-process cache immediately so this replica serves the new
        # data without a Supabase round-trip on the next request.
        global _stocks_news_cache
        import time as _t
        _stocks_news_cache = (merged, _t.monotonic(), _t.time())
        logger.info(
            "Company-news sync: %d unique stories from %d/%d tickers",
            len(merged), fetched_tickers, len(stock_symbols),
        )
    except Exception as exc:
        logger.error("Failed to persist company-news cache: %s", exc)


async def _sync_finnhub_company_news() -> None:
    """Single-flight wrapper around _do_finnhub_company_news_sync."""
    global _finnhub_company_news_running
    if _finnhub_company_news_running:
        logger.info("Company-news sync already in progress, skipping")
        return
    _finnhub_company_news_running = True
    try:
        await _do_finnhub_company_news_sync()
    finally:
        _finnhub_company_news_running = False


@api_router.post("/news/sync-stocks")
async def trigger_finnhub_company_news_sync(request: Request):
    """Manual trigger for the per-ticker stocks-news sync."""
    _assert_internal_sync_authorized(request)
    if _finnhub_company_news_running:
        return {"status": "sync already running"}
    asyncio.create_task(_sync_finnhub_company_news())
    return {"status": "sync started"}


async def _finnhub_company_news_loop() -> None:
    """Leader-gated 30-min loop refreshing the per-ticker stocks-news cache."""
    # Stagger behind the daily-fundamentals (10s) and weekly-reported (45s)
    # startup delays so cold-start doesn't burst three loops at once.
    logger.info(
        "Company-news loop scheduled (first cycle in %ds, then every %ds)",
        _STOCKS_NEWS_STARTUP_DELAY, _STOCKS_NEWS_SYNC_INTERVAL,
    )
    await asyncio.sleep(_STOCKS_NEWS_STARTUP_DELAY)
    while True:
        try:
            is_leader = await asyncio.to_thread(
                _try_claim_leadership, "finnhub_company_news_30m", _STOCKS_NEWS_LEASE_SECONDS
            )
            if is_leader:
                logger.info("Company-news: leader, running sync")
                await _sync_finnhub_company_news()
            else:
                logger.info("Company-news: another replica holds the lease, skipping cycle")
        except Exception as exc:
            logger.exception("Company-news loop error: %s", exc)
        await asyncio.sleep(_STOCKS_NEWS_SYNC_INTERVAL)


async def _load_stocks_news_from_supabase() -> Tuple[List[dict], float]:
    """Return (items, wall-clock fetched_at) for `stocks`, cached 60s in-process."""
    global _stocks_news_cache
    import time as _t
    items, last_read, fetched_at = _stocks_news_cache
    now = _t.monotonic()
    if items and (now - last_read) < _STOCKS_NEWS_LOCAL_TTL:
        return items, fetched_at
    if not supabase:
        return items or [], fetched_at

    async with _stocks_news_read_lock:
        items, last_read, fetched_at = _stocks_news_cache
        now = _t.monotonic()
        if items and (now - last_read) < _STOCKS_NEWS_LOCAL_TTL:
            return items, fetched_at
        try:
            row = await asyncio.to_thread(
                lambda: supabase.table("news_cache").select("items,updated_at").eq("key", "stocks").maybe_single().execute()
            )
            data = row.data if row else None
            fetched_items = (data or {}).get("items") or []
            updated_at_raw = (data or {}).get("updated_at")
            if isinstance(fetched_items, list):
                try:
                    fetched_at = (
                        datetime.fromisoformat(str(updated_at_raw).replace("Z", "+00:00")).timestamp()
                        if updated_at_raw else _t.time()
                    )
                except (TypeError, ValueError):
                    fetched_at = _t.time()
                _stocks_news_cache = (fetched_items, now, fetched_at)
                return fetched_items, fetched_at
        except Exception as exc:
            logger.warning("Failed to read stocks news_cache from Supabase: %s", exc)
    return items or [], fetched_at


@api_router.get("/news")
async def get_market_news(
    category: str = "general",
    limit: int = 10,
    refresh: int = Query(
        0,
        description="If 1, bypass per-replica in-process TTL: re-fetch upstream "
        "immediately (pull-to-refresh). Stocks only re-reads Supabase / clears local read cache.",
    ),
    locale: Optional[str] = Query(
        None,
        description="Client UI locale (e.g. en, es). English skips blocking Gemini on refresh; "
        "other locales wait for translation of new headlines.",
    ),
    accept_language: Optional[str] = Header(None, alias="Accept-Language"),
):
    """Return latest Finnhub headlines for *category*, capped at *limit*.

    Categories:
      - ``general`` / ``crypto`` → Finnhub `/news`, cached in-process with TTL.
      - ``stocks`` → aggregated per-ticker `/company-news` in Supabase.

    ``refresh=1`` is for explicit user refresh: for ``general``/``crypto`` it
    always hits Finnhub on this replica (still rate-gated). English clients
    get fresh headlines immediately and translations run in the background;
    non-English clients block on Gemini only for headlines that lack cached
    translations.
    """
    cat = (category or "general").strip().lower()
    effective_locale = _resolve_news_locale(locale, accept_language)
    wait_for_translation = _locale_wants_sync_translation(effective_locale)
    if cat not in _NEWS_CATEGORIES_ALLOWED:
        raise HTTPException(
            status_code=400,
            detail=f"category must be one of {sorted(_NEWS_CATEGORIES_ALLOWED)}",
        )
    try:
        limit_int = max(1, min(int(limit), 30))
    except (TypeError, ValueError):
        limit_int = 10

    force_refresh = refresh not in (0, None, False, "")

    if cat == "stocks":
        if force_refresh:
            global _stocks_news_cache
            _stocks_news_cache = ([], 0.0, 0.0)
        items, fetched_at = await _load_stocks_news_from_supabase()
        sliced = items[:limit_int]
        return {
            "category": "stocks",
            "count": len(sliced),
            "items": sliced,
            "fetched_at": fetched_at,
            "ttl_seconds": _STOCKS_NEWS_SYNC_INTERVAL,
        }

    import time as _time

    if force_refresh:
        items, fetched_at = await _fetch_and_cache_market_news(
            cat, wait_for_translation=wait_for_translation
        )
        sliced = items[:limit_int]
        return {
            "category": cat,
            "count": len(sliced),
            "items": sliced,
            "fetched_at": fetched_at,
            "ttl_seconds": _NEWS_CACHE_TTL_SECONDS,
        }

    now = _time.time()
    cached = _news_cache.get(cat)

    if cached:
        items, fetched_at = cached
        age = now - fetched_at
        if age < _NEWS_CACHE_TTL_SECONDS:
            # Fresh hit — return immediately.
            pass
        else:
            # Stale-while-revalidate: serve the stale data instantly and
            # kick off a background refresh so the next caller gets fresh
            # data without anyone ever waiting on Finnhub + Gemini.
            asyncio.create_task(_refresh_market_news_in_background(cat))
    else:
        # First-ever request for this category — we must wait for upstream.
        async with _news_locks[cat]:
            cached = _news_cache.get(cat)
            now = _time.time()
            if cached and (now - cached[1]) < _NEWS_CACHE_TTL_SECONDS:
                items, fetched_at = cached
            else:
                try:
                    items, fetched_at = await _fetch_and_cache_market_news(
                        cat, wait_for_translation=wait_for_translation
                    )
                except HTTPException:
                    if cached:
                        items, fetched_at = cached
                    else:
                        raise

    sliced = items[:limit_int]
    return {
        "category": cat,
        "count": len(sliced),
        "items": sliced,
        "fetched_at": fetched_at,
        "ttl_seconds": _NEWS_CACHE_TTL_SECONDS,
    }


async def _refresh_market_news_in_background(cat: str) -> None:
    """Single-flight stale-while-revalidate refresh for *cat*.

    Called from the foreground handler when the cache is stale; the
    foreground handler has already returned the stale data, so this
    function never blocks any user request. Failures are logged and
    swallowed — we keep the stale cache rather than evicting it.
    """
    lock = _news_locks.get(cat)
    if lock is None:
        return
    # `acquire(blocking=False)` semantics: skip if a refresh is already
    # in flight from another concurrent caller. Avoids fan-out from many
    # users simultaneously hitting a stale cache.
    if lock.locked():
        return
    async with lock:
        import time as _time
        cached = _news_cache.get(cat)
        # Recheck — another waiter may have refreshed while we queued.
        if cached and (_time.time() - cached[1]) < _NEWS_CACHE_TTL_SECONDS:
            return
        try:
            items = await _fetch_finnhub_market_news(cat)
            prior_translations = _index_translations(cached[0] if cached else [])
            await _attach_translations_top_n(items, prior_translations, skip_gemini=False)
            _news_cache[cat] = (items, _time.time())
        except HTTPException as exc:
            logger.warning("Background news refresh for %s failed: %s", cat, exc.detail)
        except Exception as exc:
            logger.warning("Background news refresh for %s crashed: %s", cat, exc)


async def _market_news_warmup_loop() -> None:
    """At startup, warm the in-process market-news cache so the very first
    user request hits a populated cache. Then sleeps forever — the TTL +
    stale-while-revalidate flow takes over after that."""
    # Tiny delay so we don't compete with critical startup work.
    await asyncio.sleep(20)
    for cat in _NEWS_CATEGORIES_UPSTREAM:
        try:
            items = await _fetch_finnhub_market_news(cat)
            await _attach_translations_top_n(items, {}, skip_gemini=True)
            import time as _t
            _news_cache[cat] = (items, _t.time())
            asyncio.create_task(_translate_market_news_cache_background(cat))
            logger.info("Market-news warmup: %s -> %d items cached", cat, len(items))
        except Exception as exc:
            logger.warning("Market-news warmup for %s failed: %s", cat, exc)
        await asyncio.sleep(2.0)  # gentle pace through the rate-gate


# --------------------------------------------------------------------------- #
# UR (Fiat24) integration routes
#
# Read-only proxies that forward the authenticated Privy user's request to
# UR-OPEN-API, scoping every call through the (privy_user_id -> ur_id)
# binding in the `ur_links` table so a client can never read someone else's
# URID.
#
# All Partner-auth signing is handled in `ur_api.py`. All DB glue lives in
# `ur_db.py`. This block only wires them to FastAPI under `/api/ur/*`.
#
# Endpoints used today are the current testnet `/v1/*` paths (`/v1/profile`,
# `/v1/balance`, `/v1/transactions`). The Managed Custody spec moves these
# under `/api/fma/v1/*` with header-based user identity — when UR's testnet
# adopts that path, the helpers in `ur_api.py` flip there and this layer is
# unchanged.
# --------------------------------------------------------------------------- #


class _UrLinkRequest(BaseModel):
    ur_id: Optional[int] = None


async def _fetch_urid_owner_address(ur_id: int) -> Optional[str]:
    """Live on-chain owner (`evmAddress`) for a URID from UR's profile API."""
    try:
        resp = await ur_api.partner_call_async("/v1/profile", {"urId": int(ur_id)})
        owner = (resp.get("data") or {}).get("evmAddress")
        return str(owner).strip() if owner else None
    except ur_api.URError:
        return None


async def _privy_user_owns_eth_address(
    privy_user_id: str, evm_address: str
) -> Optional[bool]:
    """Return True/False for ownership, or None if Privy lookup failed."""
    if not (os.getenv("PRIVY_APP_SECRET", "") or "").strip():
        return None
    try:
        return await asyncio.to_thread(
            privy_import.user_owns_eth_address, privy_user_id, evm_address
        )
    except privy_import.PrivyImportError:
        return None


async def _is_ur_link_stale(link: Dict[str, Any]) -> bool:
    """True when the linked Privy user no longer owns this URID on-chain."""
    privy_user_id = link.get("privy_user_id")
    if not privy_user_id:
        return True
    owner = await _fetch_urid_owner_address(int(link["ur_id"]))
    if not owner:
        return False
    owns = await _privy_user_owns_eth_address(str(privy_user_id), owner)
    if owns is None:
        return False
    return not owns


async def _validate_and_refresh_caller_link(
    auth_user: PrivyAuthUser, link: Dict[str, Any]
) -> Dict[str, Any]:
    """Reconcile link.evm_address with UR profile and drop stale bindings.

    After an on-chain URID transfer the old holder must not retain partner-
    signed read access via a stale ``ur_links`` row.
    """
    ur_id = int(link["ur_id"])
    owner = await _fetch_urid_owner_address(ur_id)
    if not owner:
        raise HTTPException(
            status_code=409,
            detail="Cannot verify UR account ownership. Re-link your account.",
        )

    is_qa = (
        privy_import.is_ur_test_wallet_import_enabled()
        and privy_import.is_ur_test_privy_user(auth_user.user_id)
    )
    if not is_qa and (os.getenv("PRIVY_APP_SECRET", "") or "").strip():
        owns = await _privy_user_owns_eth_address(auth_user.user_id, owner)
        if owns is None:
            raise HTTPException(
                status_code=502,
                detail="Could not verify wallet ownership. Please try again.",
            )
        if not owns:
            if supabase:
                await asyncio.to_thread(
                    ur_db.delete_link_by_privy_user, supabase, auth_user.user_id
                )
            logger.warning(
                "Dropped stale UR link: user %s no longer owns URID %s (owner %s)",
                auth_user.user_id,
                ur_id,
                owner,
            )
            raise HTTPException(
                status_code=403,
                detail="Your UR account ownership has changed. Please link your account again.",
            )
    elif not is_qa:
        logger.warning(
            "PRIVY_APP_SECRET not set — skipping UR link ownership revalidation for %s",
            auth_user.user_id,
        )

    if not _addr_eq(link.get("evm_address"), owner) and supabase:
        await asyncio.to_thread(
            ur_db.update_link_evm_address, supabase, auth_user.user_id, owner
        )
        link = {**link, "evm_address": owner}
    return link


async def _resolve_caller_link(auth_user: PrivyAuthUser) -> Dict[str, Any]:
    """Return the URID link row for the calling Privy user, or 404."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    link = await asyncio.to_thread(
        ur_db.get_link_by_privy_user, supabase, auth_user.user_id
    )
    if not link:
        raise HTTPException(
            status_code=404,
            detail="No UR account linked to this user. Complete UR onboarding first.",
        )
    return await _validate_and_refresh_caller_link(auth_user, link)


async def _resolve_caller_urid(auth_user: PrivyAuthUser) -> int:
    """Look up the URID linked to the calling Privy user, or 404."""
    link = await _resolve_caller_link(auth_user)
    return int(link["ur_id"])


async def _assert_caller_owns_wallet(
    auth_user: PrivyAuthUser, wallet_address: str
) -> None:
    """Defense-in-depth: relayer endpoints must only act on the caller's wallets.

    Skipped when ``PRIVY_APP_SECRET`` is unset (local dev without Privy server
    credentials). Production always has the secret configured.
    """
    if not wallet_address or not Web3.is_address(wallet_address):
        raise HTTPException(status_code=400, detail="Invalid wallet address")
    if not (os.getenv("PRIVY_APP_SECRET", "") or "").strip():
        logger.warning(
            "PRIVY_APP_SECRET not set — skipping wallet ownership check for %s",
            auth_user.user_id,
        )
        return
    try:
        owns = await asyncio.to_thread(
            privy_import.user_owns_eth_address, auth_user.user_id, wallet_address
        )
    except privy_import.PrivyImportError as exc:
        logger.warning(
            "Privy wallet ownership check failed for %s: %s",
            auth_user.user_id,
            exc,
        )
        raise HTTPException(
            status_code=502,
            detail="Could not verify wallet ownership. Please try again.",
        )
    if not owns:
        logger.warning(
            "Blocked relayer call: wallet %s is not owned by caller %s",
            wallet_address,
            auth_user.user_id,
        )
        raise HTTPException(
            status_code=403,
            detail="This wallet does not belong to your account.",
        )


def _addr_eq(a: Optional[str], b: Optional[str]) -> bool:
    """Checksum-insensitive EVM address equality."""
    try:
        return Web3.to_checksum_address(a) == Web3.to_checksum_address(b)
    except Exception:  # noqa: BLE001 — fall back to plain lowercase compare
        return bool(a) and bool(b) and a.strip().lower() == b.strip().lower()


async def _assert_user_address_is_urid_owner(
    *, link: Dict[str, Any], ur_id: int, user_address: str
) -> None:
    """Defense-in-depth for the gasless relayer: the EOA we ask the relayer to
    broadcast for MUST be the wallet that owns this caller's URID — never an
    arbitrary address. Without this a caller could point the gas-sponsoring
    relayer at a third party's EOA or burn relayer gas on junk addresses.
    """
    if not user_address or not Web3.is_address(user_address):
        raise HTTPException(status_code=400, detail="Invalid user_address")
    owner = await _fetch_urid_owner_address(int(ur_id))
    if not owner:
        raise HTTPException(
            status_code=409,
            detail="Cannot verify the wallet that owns this URID. Re-link your account.",
        )
    if not _addr_eq(owner, user_address):
        raise HTTPException(
            status_code=403,
            detail="user_address does not match the wallet that owns this URID.",
        )


def _assert_quote_not_expired(quote_expires_at: Optional[str]) -> None:
    """Reject execute calls that carry an expired UR quote timestamp."""
    if not quote_expires_at:
        return
    raw = str(quote_expires_at).strip()
    if not raw:
        return
    try:
        expires = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid quote_expires_at")
    now = datetime.now(expires.tzinfo) if expires.tzinfo else datetime.utcnow()
    if expires < now:
        raise HTTPException(status_code=400, detail="Quote has expired — request a new quote")


TRANSFER_RECIPIENT_BINDING_TTL_SECONDS = 1800


def _transfer_recipient_binding_secret() -> str:
    return (
        os.getenv("TRANSFER_BINDING_SECRET", "").strip()
        or os.getenv("PRIVY_APP_SECRET", "").strip()
        or (INTERNAL_SYNC_SECRET or "").strip()
    )


def _transfer_binding_amount_raw(amount: str) -> str:
    return str(_to_token_units(amount, 2))


def _issue_transfer_recipient_binding(
    *,
    privy_user_id: str,
    to_account_id: str,
    currency: str,
    amount: str,
    owner_address: str,
) -> Optional[str]:
    """HMAC token binding permit-info → execute for P2P recipient + amount."""
    secret = _transfer_recipient_binding_secret()
    if not secret:
        return None
    amount_raw = _transfer_binding_amount_raw(amount)
    exp = int(time.time()) + TRANSFER_RECIPIENT_BINDING_TTL_SECONDS
    payload = {
        "u": privy_user_id,
        "r": str(to_account_id),
        "c": str(currency).upper().strip(),
        "a": amount_raw,
        "o": Web3.to_checksum_address(owner_address).lower(),
        "e": exp,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"{body}.{sig}"


def _assert_transfer_recipient_binding(
    *,
    binding: Optional[str],
    privy_user_id: str,
    to_account_id: str,
    currency: str,
    amount: str,
    owner_address: str,
) -> None:
    """Reject P2P execute when recipient/currency/amount drift from permit-info.

    Fail-CLOSED when no HMAC secret is configured: skipping this check would
    let a client swap ``to_account_id`` after permit-info (EIP-2612 permit
    does not bind the P2P recipient). Production must set PRIVY_APP_SECRET
    (or TRANSFER_BINDING_SECRET).
    """
    secret = _transfer_recipient_binding_secret()
    if not secret:
        logger.error(
            "No binding secret configured — refusing P2P transfer (fail-closed)"
        )
        raise HTTPException(
            status_code=503,
            detail="Transfer security is not configured. Please try again later.",
        )
    if not binding or not str(binding).strip():
        raise HTTPException(
            status_code=400,
            detail="recipient_binding required — refresh permit and retry",
        )
    token = str(binding).strip()
    try:
        body_b64, sig = token.rsplit(".", 1)
        pad = "=" * (-len(body_b64) % 4)
        raw = base64.urlsafe_b64decode((body_b64 + pad).encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.warning("Invalid recipient_binding: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid recipient_binding")
    expected_sig = hmac.new(
        secret.encode("utf-8"), raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected_sig, sig):
        raise HTTPException(status_code=403, detail="Invalid recipient_binding signature")
    if int(payload.get("e") or 0) < int(time.time()):
        raise HTTPException(
            status_code=400,
            detail="Transfer permit expired — request a new permit and retry",
        )
    amount_raw = _transfer_binding_amount_raw(amount)
    owner = Web3.to_checksum_address(owner_address).lower()
    if (
        payload.get("u") != privy_user_id
        or str(payload.get("r")) != str(to_account_id)
        or (payload.get("c") or "").upper() != str(currency).upper().strip()
        or str(payload.get("a")) != amount_raw
        or (payload.get("o") or "").lower() != owner
    ):
        raise HTTPException(
            status_code=403,
            detail="Transfer recipient or amount does not match the signed permit setup",
        )


async def _assert_owner_matches_linked_urid(
    link: Dict[str, Any], owner_address: str
) -> None:
    """Permit-info helpers must read nonces for the linked URID owner only."""
    if not owner_address or not Web3.is_address(owner_address):
        raise HTTPException(status_code=400, detail="Invalid owner_address")
    expected = link.get("evm_address") or await _fetch_urid_owner_address(int(link["ur_id"]))
    if not expected or not _addr_eq(expected, owner_address):
        raise HTTPException(
            status_code=403,
            detail="owner_address does not match the wallet that owns this UR account.",
        )


async def _recover_full_auth_signer_safe(
    auth: "_UrExtAuth",
) -> Optional[str]:
    """Recover Full-Auth signer EOA, or None if the signature is unreadable."""
    try:
        return await asyncio.to_thread(
            ur_onramp_permit.recover_full_auth_signer,
            business_hash=str(auth.hash),
            deadline=int(auth.deadline),
            sign=str(auth.sign),
        )
    except Exception as exc:
        logger.warning("Full-Auth recovery failed: %s", exc)
        return None


async def _log_card_full_auth_context(
    *,
    op: str,
    auth_user: PrivyAuthUser,
    ur_id: int,
    network: int,
    auth: "_UrExtAuth",
    link: Optional[Dict[str, Any]] = None,
) -> None:
    """Dev-facing diagnostics for card Full-Auth mismatches (signer vs URID owner)."""
    signer = await _recover_full_auth_signer_safe(auth)
    owner = None
    if link:
        owner = link.get("evm_address")
    if not owner:
        owner = await _fetch_urid_owner_address(int(ur_id))
    match = bool(signer and owner and _addr_eq(signer, owner))
    logger.warning(
        "[UR card %s] privy=%s urid=%s network=%s hash=%r deadline=%s "
        "signer=%s owner=%s match=%s",
        op,
        (auth_user.user_id or "")[:24],
        ur_id,
        network,
        auth.hash,
        auth.deadline,
        signer,
        (str(owner).lower() if owner else None),
        match,
    )


async def _assert_ur_ext_auth_binds_caller(
    auth_user: PrivyAuthUser, link: Dict[str, Any], auth: "_UrExtAuth"
) -> None:
    """Verify Full-Auth was signed by the linked URID owner (Privy session)."""
    if int(auth.deadline) < int(time.time()):
        raise HTTPException(status_code=400, detail="Full-Auth signature expired")
    signer = await _recover_full_auth_signer_safe(auth)
    if not signer:
        raise HTTPException(status_code=400, detail="Invalid Full-Auth signature")
    owner = link.get("evm_address") or await _fetch_urid_owner_address(int(link["ur_id"]))
    if not owner or not _addr_eq(signer, owner):
        raise HTTPException(
            status_code=403,
            detail="Full-Auth signer does not own this UR account.",
        )
    await _assert_caller_owns_wallet(auth_user, signer)


def _assert_internal_sync_authorized(request: Request) -> None:
    """Gate manual cache-sync POST endpoints behind a shared secret in prod."""
    is_prod = os.getenv("ENVIRONMENT", "production").strip().lower() == "production"
    secret = (INTERNAL_SYNC_SECRET or "").strip()
    if not secret:
        if is_prod or ur_api.UR_ENV == "mainnet":
            raise HTTPException(status_code=503, detail="Sync endpoint not configured")
        return
    auth = request.headers.get("authorization", "") or ""
    qsecret = request.query_params.get("secret", "") or ""
    token = auth.split("Bearer ")[-1] if "Bearer " in auth else ""
    if qsecret != secret and token != secret:
        raise HTTPException(status_code=401, detail="Unauthorized")


# Anti-griefing rate limit for the gasless relayer dispatch. Each job is one
# relayer broadcast we pay gas for, so we cap job creation per user per window.
# Env-tunable; set max<=0 to disable.
def _ur_job_rl_config() -> tuple[int, int]:
    try:
        max_jobs = int(os.getenv("UR_JOB_RATE_LIMIT_MAX", "20"))
    except (TypeError, ValueError):
        max_jobs = 20
    try:
        window = int(os.getenv("UR_JOB_RATE_LIMIT_WINDOW_SEC", "900"))
    except (TypeError, ValueError):
        window = 900
    return max_jobs, max(1, window)


async def _enforce_ur_job_rate_limit(privy_user_id: str) -> None:
    """Reject when a user has created too many relayer jobs in the window.

    Fail-CLOSED on a DB hiccup: these callers sponsor real L2 gas, so if we
    cannot verify the limit we must not wave the dispatch through — otherwise a
    transient DB degradation (or one induced by an attacker hammering reads)
    would let an automated client bypass the cap and drain the relayer. A genuine
    outage blocks legitimate dispatch too, but the job insert needs the DB
    anyway, so this costs no real availability."""
    max_jobs, window = _ur_job_rl_config()
    if not supabase or max_jobs <= 0:
        return
    cutoff = (datetime.utcnow() - timedelta(seconds=window)).isoformat()
    try:
        recent = await asyncio.to_thread(
            ur_db.count_recent_jobs,
            supabase,
            privy_user_id=privy_user_id,
            since_iso=cutoff,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("UR job rate-limit check failed — blocking (fail-closed)")
        raise HTTPException(
            status_code=503,
            detail="Service temporarily unavailable, please try again shortly.",
        ) from exc
    if recent >= max_jobs:
        raise HTTPException(
            status_code=429,
            detail="Too many banking operations in a short period. Please try again shortly.",
        )


# Deposit statuses where the source (Arbitrum) tx has NOT yet been confirmed
# on-chain. The 7702 Ambire batch is signed client-side against the EOA's live
# Ambire `nonce()`, which only increments once the source tx mines — NOT when
# LayerZero finishes crediting on Mantle. Two deposits signed inside that few-
# second window reuse the same nonce; the later one reverts on-chain and burns
# relayer gas for nothing. Once the source tx confirms, top-ups during the
# multi-minute LayerZero tail are perfectly safe.
_DEPOSIT_PRE_SOURCE_STATUSES = {
    ur_db.JOB_STATUS_CREATED,
    ur_db.JOB_STATUS_QUOTING,
    ur_db.JOB_STATUS_AWAITING_USER_SIG,
    ur_db.JOB_STATUS_SUBMITTED,
}

# A pre-broadcast job (user opened the sheet, then abandoned signing) would
# otherwise block new deposits forever. Release the guard for such jobs after
# this many seconds — comfortably longer than the source-confirm window but
# short enough that an abandoned attempt never locks the user out.
_DEPOSIT_INFLIGHT_STALE_SEC = 90


async def _assert_no_inflight_deposit(privy_user_id: str) -> None:
    """Reject a new Add Money while a prior deposit's source tx is unconfirmed.

    Tight window only: we block exactly while the previous deposit could still
    cause an Ambire-nonce collision (source tx not yet mined). The instant the
    source receipt confirms we let the user deposit again, even though the
    LayerZero credit may still be minutes away.

    Best-effort / fail-open: a read hiccup here must not hard-block deposits.
    Funds are never at risk regardless (a colliding batch reverts atomically);
    this guard only spares relayer gas and a confusing "stuck" second deposit,
    and `_enforce_ur_job_rate_limit` already fails closed on DB outages.
    """
    if not supabase:
        return
    try:
        jobs = await asyncio.to_thread(
            ur_db.list_user_jobs,
            supabase,
            privy_user_id=privy_user_id,
            limit=20,
            only_pending=True,
        )
    except Exception:  # noqa: BLE001
        logger.warning("in-flight deposit check failed — allowing", exc_info=True)
        return

    now = datetime.now(timezone.utc)
    for job in jobs or []:
        if job.get("kind") != ur_db.JOB_KIND_DEPOSIT:
            continue
        status = job.get("status")
        if status not in _DEPOSIT_PRE_SOURCE_STATUSES:
            continue

        if status == ur_db.JOB_STATUS_SUBMITTED:
            # Try to advance via the source receipt. If it mined (->
            # source_confirmed) or reverted (-> failed) the nonce is settled
            # and a new deposit is safe; only an unmined source tx blocks.
            advanced = await asyncio.to_thread(
                _reconcile_deposit_from_source_receipt, job
            )
            if advanced is not None:
                continue
            raise HTTPException(
                status_code=409,
                detail=(
                    "A deposit is still confirming on-chain. Please wait a few "
                    "seconds for it to settle, then try again."
                ),
            )

        # Pre-broadcast (created / quoting / awaiting_user_sig): block briefly
        # so an abandoned signing attempt can't lock the user out.
        created_raw = job.get("created_at")
        try:
            created_at = (
                datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
                if created_raw
                else None
            )
        except (TypeError, ValueError):
            created_at = None
        if (
            created_at is not None
            and (now - created_at).total_seconds() > _DEPOSIT_INFLIGHT_STALE_SEC
        ):
            continue
        raise HTTPException(
            status_code=409,
            detail=(
                "A deposit is still being prepared. Please wait a few seconds, "
                "then try again."
            ),
        )


@api_router.get("/ur/link", tags=["ur"])
async def ur_link_get(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return the caller's UR link (Privy DID -> URID), or 404 if unlinked."""
    link = await _resolve_caller_link(auth_user)
    return {
        "ur_id": int(link["ur_id"]),
        "evm_address": link.get("evm_address"),
        "source": link.get("source"),
        "created_at": link.get("created_at"),
    }


@api_router.post("/ur/link", tags=["ur"])
async def ur_link_set(
    req: Optional[_UrLinkRequest] = Body(default=None),
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Manually bind the caller's Privy account to a URID.

    Production note: the canonical path for creating this link is the UR
    mint flow (server-side, during onboarding). This endpoint exists for
    development and admin use; in prod it's gated by either of:

      - `UR_ALLOW_MANUAL_LINK=1` (explicit admin opt-in), or
      - `ENABLE_UR_TEST_WALLET_IMPORT=1` (UR test-wallet dev mode, in
        which case the body may be omitted and `UR_TEST_URID` is used).

    The URID is validated against UR's API before we persist — if UR
    rejects the read, we refuse the link.
    """
    manual_allowed = os.getenv("UR_ALLOW_MANUAL_LINK", "").strip() == "1"
    test_import_enabled = privy_import.is_ur_test_wallet_import_enabled()
    if not manual_allowed and not test_import_enabled:
        raise HTTPException(
            status_code=403,
            detail=(
                "Manual UR linking is disabled. Set UR_ALLOW_MANUAL_LINK=1 "
                "(or ENABLE_UR_TEST_WALLET_IMPORT=1 for dev) to enable."
            ),
        )
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")

    # Resolve URID: explicit body wins; otherwise fall back to UR_TEST_URID
    # (dev convenience so the frontend can call this with no body).
    ur_id = req.ur_id if req and req.ur_id is not None else None
    if ur_id is None:
        if not privy_import.is_ur_test_privy_user(auth_user.user_id):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Auto-link to UR_TEST_URID is restricted to the configured QA Privy user."
                ),
            )
        # Per-user: each configured test identity auto-links to ITS OWN URID
        # (UR_TEST_URID for slot 1, UR_TEST_URID_<n> for the others).
        test_urid = (privy_import.get_ur_test_urid(auth_user.user_id) or "").strip()
        if not test_urid:
            raise HTTPException(
                status_code=400,
                detail="Missing ur_id in body and no UR_TEST_URID configured for this user.",
            )
        try:
            ur_id = int(test_urid)
        except ValueError:
            raise HTTPException(
                status_code=500,
                detail=f"UR_TEST_URID is not a valid integer: {test_urid!r}",
            )

    try:
        resp = await ur_api.partner_call_async("/v1/profile", {"urId": int(ur_id)})
    except ur_api.URError as exc:
        logger.warning("UR rejected manual link for URID %s: %s", ur_id, exc)
        raise HTTPException(status_code=400, detail=f"UR rejected URID: {exc}")

    profile = resp.get("data") or {}
    evm_address = profile.get("evmAddress")

    # OWNERSHIP PROOF. Outside the QA test-import path, the caller must actually
    # own this URID: its on-chain owner (`evmAddress`) must be one of the
    # caller's Privy wallets. Without this gate a user could bind an unclaimed
    # URID they don't own and then read its balance / IBAN / KYC / transaction
    # history through our partner-signed reads (which are scoped only by this
    # link). We fail CLOSED if the Privy lookup is inconclusive.
    is_qa_test_user = test_import_enabled and privy_import.is_ur_test_privy_user(
        auth_user.user_id
    )
    if not is_qa_test_user:
        if not evm_address:
            raise HTTPException(
                status_code=400,
                detail="UR did not return an owner address for this URID; cannot verify ownership.",
            )
        try:
            owns = await asyncio.to_thread(
                privy_import.user_owns_eth_address, auth_user.user_id, evm_address
            )
        except Exception as exc:  # noqa: BLE001 — fail closed on lookup failure
            logger.warning(
                "Privy ownership check failed for %s (URID %s): %s",
                auth_user.user_id, ur_id, exc,
            )
            raise HTTPException(
                status_code=502,
                detail="Could not verify wallet ownership with Privy. Please try again.",
            )
        if not owns:
            logger.warning(
                "Blocked UR link: URID %s owner %s is not a wallet of caller %s",
                ur_id, evm_address, auth_user.user_id,
            )
            raise HTTPException(
                status_code=403,
                detail="This URID is owned by a different wallet. You can only link a URID your own wallet owns.",
            )

    try:
        link = await asyncio.to_thread(
            ur_db.upsert_link,
            supabase,
            privy_user_id=auth_user.user_id,
            ur_id=int(ur_id),
            evm_address=evm_address,
            source="manual",
        )
    except ur_db.URLinkConflict:
        existing = await asyncio.to_thread(
            ur_db.get_link_by_ur_id, supabase, int(ur_id)
        )
        if existing and await _is_ur_link_stale(existing):
            await asyncio.to_thread(
                ur_db.delete_link_by_privy_user,
                supabase,
                str(existing["privy_user_id"]),
            )
            link = await asyncio.to_thread(
                ur_db.upsert_link,
                supabase,
                privy_user_id=auth_user.user_id,
                ur_id=int(ur_id),
                evm_address=evm_address,
                source="manual",
            )
        else:
            raise HTTPException(
                status_code=409,
                detail=f"URID {ur_id} is already linked to another user.",
            )

    return {
        "ur_id": int(link["ur_id"]),
        "evm_address": link.get("evm_address"),
        "source": link.get("source"),
    }


# Friendly copy shown when UR's API gateway is down (e.g. an Envoy
# "no healthy upstream" 503 while UR redeploys their testnet backend). We
# surface this as a clean 503 so the app can show a soft "retry shortly"
# banner instead of treating it like a hard/auth failure.
_UR_UPSTREAM_DOWN_DETAIL = "Banking upgrade underway, retry shortly"


def _ur_upstream_is_down(exc: "ur_api.URError") -> bool:
    """True when a URError looks like a UR-side gateway/upstream outage
    (proxy 5xx, "no healthy upstream") rather than a real application error
    (bad partner key, region gate, expired deadline, …)."""
    if getattr(exc, "http_status", None) in (502, 503, 504):
        return True
    blob = f"{getattr(exc, 'body', '') or ''} {exc}".lower()
    return "no healthy upstream" in blob or "service unavailable" in blob


def _raise_ur_read_error(exc: "ur_api.URError", label: str):
    """Map a UR read failure to the right HTTP status: a clean 503 (retry
    shortly) for upstream outages, else a 502 carrying UR's code + message."""
    if _ur_upstream_is_down(exc):
        raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
    raise HTTPException(
        status_code=502,
        detail=f"{label} (code={getattr(exc, 'ur_code', None)}): {exc}",
    )


def _normalize_payout_contact_row(
    raw: Dict[str, Any],
    currency_hint: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Map UR profile contact rows (`id`, `bank`, grouped by currency) to the
    flat shape the frontend expects (`contactId`, `bankName`, …)."""
    if not isinstance(raw, dict):
        return None
    contact_id = str(raw.get("contactId") or raw.get("id") or "").strip()
    if not contact_id:
        return None
    full_account = str(raw.get("fullAccount") or "").strip()
    account_raw = str(raw.get("account") or "").strip()
    masked = "•" in account_raw or "*" in account_raw
    payout_source = full_account or ("" if masked else account_raw)
    account = "".join(payout_source.split()).upper() if payout_source else "".join(account_raw.split()).upper()
    bank_name = str(raw.get("bankName") or raw.get("bank") or "").strip()
    bic = str(raw.get("bic") or raw.get("BIC") or "").strip()
    row: Dict[str, Any] = {
        "contactId": contact_id,
        "name": str(raw.get("name") or "").strip() or None,
        "account": account or None,
        "fullAccount": full_account or None,
        "bankName": bank_name or None,
        "bic": bic or None,
        "country": str(raw.get("country") or "").strip() or None,
        "currency": currency_hint or str(raw.get("currency") or "").strip() or None,
    }
    if raw.get("bank"):
        row["bank"] = str(raw.get("bank")).strip()
    return {k: v for k, v in row.items() if v is not None}


def _normalize_payout_contacts(raw: Any) -> list:
    """Flatten UR profile ``contacts`` (array or EUR/CHF/USD map) for clients."""
    if not raw:
        return []
    if isinstance(raw, list):
        out: list = []
        for item in raw:
            row = _normalize_payout_contact_row(item) if isinstance(item, dict) else None
            if row:
                out.append(row)
        return out
    if isinstance(raw, dict):
        out = []
        for currency, items in raw.items():
            if not isinstance(items, list):
                continue
            for item in items:
                row = _normalize_payout_contact_row(item, currency_hint=str(currency))
                if row:
                    out.append(row)
        return out
    return []


async def _mirror_ur_kyc_fields(
    *,
    privy_user_id: Optional[str] = None,
    ur_id: Optional[int] = None,
    chain_status: Any = None,
    kyc_current_step: Any = None,
) -> None:
    """Best-effort write of UR KYC enums onto ``ur_links`` for analytics.

    Never raises into the request path — mirror failure must not break
    profile/KYC reads or change any authorization decision.
    """
    if not supabase:
        return
    try:
        await asyncio.to_thread(
            ur_db.update_link_kyc_mirror,
            supabase,
            privy_user_id=privy_user_id,
            ur_id=ur_id,
            chain_status=chain_status,
            kyc_current_step=kyc_current_step,
        )
    except Exception:
        logger.debug(
            "ur_links KYC mirror failed (ur_id=%s privy=%s)",
            ur_id,
            privy_user_id,
            exc_info=True,
        )


@api_router.get("/ur/profile", tags=["ur"])
async def ur_profile_endpoint(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Fetch the caller's UR profile (identity, IBANs, KYC, limits)."""
    ur_id = await _resolve_caller_urid(auth_user)
    try:
        resp = await ur_api.partner_call_async("/v1/profile", {"urId": ur_id})
    except ur_api.URError as exc:
        logger.warning("UR /v1/profile failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR profile fetch failed")
    data = resp.get("data") or {}
    if isinstance(data, dict) and "contacts" in data:
        data = {**data, "contacts": _normalize_payout_contacts(data.get("contacts"))}
    if isinstance(data, dict):
        await _mirror_ur_kyc_fields(
            privy_user_id=auth_user.user_id,
            ur_id=ur_id,
            chain_status=data.get("chainStatus"),
            kyc_current_step=data.get("kycCurrentStep"),
        )
        await _reconcile_cash_kyc_if_live(ur_id, data.get("chainStatus"))
    return {"ur_id": ur_id, "data": data}


@api_router.get("/ur/balance", tags=["ur"])
async def ur_balance_endpoint(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Fetch the caller's UR fiat + crypto balances."""
    ur_id = await _resolve_caller_urid(auth_user)
    try:
        resp = await ur_api.partner_call_async("/v1/balance", {"urId": ur_id})
    except ur_api.URError as exc:
        logger.warning("UR /v1/balance failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR balance fetch failed")
    return {"ur_id": ur_id, "data": resp.get("data", {})}


@api_router.get("/ur/transactions", tags=["ur"])
async def ur_transactions_endpoint(
    page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
    reconcile: bool = Query(True),
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Fetch the caller's recent UR transactions.

    ``reconcile`` controls whether we perform on-chain receipt reads to
    advance stuck local jobs (Convert/withdraw rows that sit at ``submitted``
    until their source receipt is confirmed). On-chain reads add seconds to
    the response, so the cold-start fast path passes ``reconcile=false`` for
    snappy first paint; pull-to-refresh and "See all" pass ``true`` to heal
    any pending rows.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    try:
        resp = await ur_api.partner_call_async(
            "/v1/transactions",
            {"urId": ur_id, "pageSize": int(page_size)},
        )
    except ur_api.URError as exc:
        logger.warning("UR /v1/transactions failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR transactions fetch failed")

    data = resp.get("data")
    if isinstance(data, list) and supabase:
        # Fetch our local job records ONCE and feed every pipeline stage.
        # We combine two queries:
        #   1. recent-N jobs  — needed by the merge stage to synthesise rows
        #      for our jobs UR's indexer hasn't surfaced yet (pending/just-done).
        #   2. hash-targeted  — jobs whose source_tx_hash matches a row in THIS
        #      UR page. A bare recent-N window can miss the job behind an older
        #      (deep-paginated) transaction, or get crowded out by a graveyard
        #      of failed jobs — which would let UR's malformed amount pass
        #      straight to the UI (e.g. a $100 cash-out rendering as $1). The
        #      targeted lookup guarantees enrichment always finds its job.
        page_hashes = [
            t.get("txHash") for t in data
            if isinstance(t, dict) and t.get("txHash")
        ]
        try:
            recent_jobs, targeted_jobs = await asyncio.gather(
                asyncio.to_thread(
                    ur_db.list_user_jobs,
                    supabase,
                    privy_user_id=auth_user.user_id,
                    limit=100,
                ),
                asyncio.to_thread(
                    ur_db.list_jobs_by_source_tx_hashes,
                    supabase,
                    privy_user_id=auth_user.user_id,
                    tx_hashes=page_hashes,
                ),
            )
        except Exception:
            logger.exception("ur_transactions: job fetch failed")
            recent_jobs, targeted_jobs = [], []
        # Union, de-duped by job id (targeted wins ties — identical row anyway).
        jobs_by_id: Dict[str, Dict[str, Any]] = {}
        for j in [*recent_jobs, *targeted_jobs]:
            jid = j.get("id")
            if jid is not None:
                jobs_by_id[jid] = j
        jobs = list(jobs_by_id.values())

        data = await asyncio.to_thread(
            _enrich_frx_transactions_from_jobs,
            data,
            supabase,
            auth_user.user_id,
            jobs,
        )
        data = await asyncio.to_thread(
            _enrich_withdraw_transactions_from_jobs,
            data,
            jobs,
        )
        data = await asyncio.to_thread(
            _enrich_deposit_transactions_from_jobs,
            data,
            jobs,
        )
        # Merge in completed jobs UR's indexer hasn't surfaced yet. On
        # testnet (and occasionally mainnet) UR's `/v1/transactions`
        # crawler can lag the source-chain receipt by minutes, leaving
        # the user staring at a transactions tab that doesn't yet show
        # their just-completed deposit / convert. We synthesise rows
        # from our own job records to bridge that gap. Always returns a
        # merged list with our rows on top (newest-first).
        data = await asyncio.to_thread(
            _merge_local_jobs_into_transactions,
            data,
            supabase,
            auth_user.user_id,
            jobs,
            reconcile,
        )
        # Label P2P rows last so both UR-indexed and locally-synthesised
        # transfer rows pick up the saved-recipient name.
        data = await asyncio.to_thread(
            _enrich_transfer_transactions_from_jobs,
            data,
            supabase,
            auth_user.user_id,
            jobs,
        )

    # Bank payouts read as completed once relayed on-chain (settlement to the
    # external bank is downstream and not user-actionable). No-ops on non-lists.
    data = _normalize_bank_payout_status(data)

    return {"ur_id": ur_id, "data": data if data is not None else {}}


def _sanitize_orphan_frx_row(tx: Dict[str, Any]) -> Dict[str, Any]:
    """Make an FRX row UI-safe when we have no local job to rewrite it.

    UR's indexer sometimes emits an FX debit as ``direction=IN`` with a
    negative amount (and source-currency token fields), which the frontend
    renders as a green credit of a negative number. We can't reconstruct the
    matched (-source,+target) pair without our job, but we can at least make
    the row internally consistent: a negative amount means money left the
    account, so force ``OUT``. Leaves well-formed rows untouched.
    """
    amount_raw = str(tx.get("amount") or "").strip()
    direction = str(tx.get("direction") or "").strip().upper()
    is_negative = amount_raw.startswith("-")
    if is_negative and direction == "IN":
        tx["direction"] = "OUT"
    return tx


def _enrich_frx_transactions_from_jobs(
    txs: list,
    sb,
    privy_user_id: str,
    jobs: Optional[list] = None,
) -> list:
    """Canonicalise FX rows using our own job records.

    UR's `/v1/transactions` indexer is inconsistent for FRX rows produced by
    direct on-chain swaps (e.g. our External Mode Convert via
    Fiat24CryptoRelay). Observed in the wild:

      - direction may be `IN` (UR labels the row from the destination-side
        perspective) but `currency`/`token` still carry the SOURCE currency
        — rendering as "Received USD from USD" with a `-40` amount and
        credit-coloured accent.
      - `outputAmount` / `outputToken` / `inputToken` are often missing.

    Our backend always has authoritative source/target currency + amount
    in the matching FX job row. So whenever we have a matching job we
    REWRITE the UR row into a canonical OUT (debit) leg pointing at the
    source side. The frontend's `expandUrTransactionsForDisplay` then
    deterministically synthesises the IN credit leg from the same row.
    """
    if not txs:
        return txs

    if jobs is None:
        jobs = ur_db.list_user_jobs(sb, privy_user_id=privy_user_id, limit=100)
    fx_by_hash: dict[str, dict] = {}
    for job in jobs:
        if job.get("kind") != ur_db.JOB_KIND_FX:
            continue
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        if tx_hash:
            fx_by_hash[tx_hash] = job

    enriched: list = []
    for raw in txs:
        if not isinstance(raw, dict):
            enriched.append(raw)
            continue
        tx = dict(raw)
        if (tx.get("type") or "").upper() != "FRX":
            enriched.append(tx)
            continue

        job = fx_by_hash.get((tx.get("txHash") or "").strip().lower())
        if not job:
            # No local job to canonicalise against — e.g. an FX executed
            # outside the app (native Fiat24CryptoRelay call), or our pod
            # crashed between broadcast and job persistence. UR's raw FRX row
            # can be UI-hostile (direction=IN on a negative/source-currency
            # debit → "Received USD from USD: -40", which breaks the credit/
            # debit colouring). Defensively coerce an obviously-malformed row
            # into a safe single OUT debit leg rather than trusting it.
            enriched.append(_sanitize_orphan_frx_row(tx))
            continue

        target_ccy = (job.get("target_currency") or "").upper().replace("24", "")
        source_ccy = (job.get("source_token") or "").upper().replace("24", "")
        source_amount = job.get("source_amount")
        target_amount = job.get("target_amount")

        if source_ccy and target_ccy and source_ccy != target_ccy:
            # Force the row into a canonical debit-leg shape so the frontend's
            # deterministic `expandUrTransactionsForDisplay` can fan it out
            # into a matched (-source, +target) pair with correct labels,
            # colours, and amounts.
            tx["direction"] = "OUT"
            tx["currency"] = source_ccy
            tx["token"] = source_ccy
            tx["inputToken"] = source_ccy
            tx["outputToken"] = target_ccy
            if source_amount is not None:
                # Drop UR's potentially-malformed amount and use ours.
                amount_str = str(source_amount)
                # Strip any leading sign that may have leaked in from the DB
                # column to keep the signed-display normaliser happy.
                amount_str = amount_str.lstrip("+-")
                tx["amount"] = f"-{amount_str}"
                tx["inputAmount"] = amount_str
            if target_amount is not None:
                tx["outputAmount"] = str(target_amount).lstrip("+-")

        enriched.append(tx)
    return enriched


def _enrich_withdraw_transactions_from_jobs(
    txs: list,
    jobs: Optional[list] = None,
) -> list:
    """Rewrite CTF (cash → crypto) OUT rows using our withdraw job record.

    UR's indexer often returns a bare integer amount (e.g. ``-100`` for a
    $100 cash-out) that the app's amount formatter mis-reads as $1.00, and
    leaves the row ``pending`` long after the Mantle burn tx has mined. Our
    job row has the human ``source_amount`` and reconciled status.
    """
    if not txs or not jobs:
        return txs

    withdraw_by_hash: Dict[str, Dict[str, Any]] = {}
    for job in jobs:
        if (job.get("kind") or "").lower() != ur_db.JOB_KIND_WITHDRAW:
            continue
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        if tx_hash:
            withdraw_by_hash[tx_hash] = job

    if not withdraw_by_hash:
        return txs

    enriched: list = []
    for raw in txs:
        if not isinstance(raw, dict):
            enriched.append(raw)
            continue
        tx = dict(raw)
        if (tx.get("type") or "").upper() != "CTF":
            enriched.append(tx)
            continue

        job = withdraw_by_hash.get((tx.get("txHash") or "").strip().lower())
        if not job:
            enriched.append(tx)
            continue

        tx["direction"] = "OUT"
        tx["listingTitle"] = "Cash to crypto"
        source_ccy = (job.get("source_token") or "").upper().replace("24", "")
        amount_str = str(job.get("source_amount") or "0").lstrip("+-")
        if source_ccy:
            tx["currency"] = source_ccy
            tx["token"] = source_ccy
            tx["inputToken"] = source_ccy
        tx["amount"] = f"-{amount_str}"
        tx["inputAmount"] = amount_str

        job_status = (job.get("status") or "").lower()
        if job_status == ur_db.JOB_STATUS_COMPLETED:
            tx["status"] = "completed"
        elif job_status == ur_db.JOB_STATUS_FAILED:
            tx["status"] = "failed"
        elif job_status in (ur_db.JOB_STATUS_SUBMITTED, ur_db.JOB_STATUS_CREATED):
            tx["status"] = "pending"

        enriched.append(tx)
    return enriched


def _enrich_deposit_transactions_from_jobs(
    txs: list,
    jobs: Optional[list] = None,
) -> list:
    """Rewrite CTU (Add Money) IN rows using our deposit job status.

    UR's indexer often marks the row complete once the source-chain tx is
    seen, before LayerZero delivers the fiat credit on Mantle.
    """
    if not txs or not jobs:
        return txs

    deposit_jobs = [
        j for j in jobs
        if (j.get("kind") or "").lower() == ur_db.JOB_KIND_DEPOSIT
    ]
    if not deposit_jobs:
        return txs

    enriched: list = []
    for raw in txs:
        if not isinstance(raw, dict):
            enriched.append(raw)
            continue
        tx = dict(raw)
        if (tx.get("type") or "").upper() != "CTU":
            enriched.append(tx)
            continue
        if (tx.get("direction") or "").upper() != "IN":
            enriched.append(tx)
            continue

        job = None
        tx_hash = (tx.get("txHash") or "").strip().lower()
        for j in deposit_jobs:
            src = (j.get("source_tx_hash") or "").strip().lower()
            if src and tx_hash and src == tx_hash:
                job = j
                break
        if not job:
            for j in deposit_jobs:
                if _ur_tx_matches_job(tx, j):
                    job = j
                    break
        if not job:
            enriched.append(tx)
            continue

        job_status = (job.get("status") or "").lower()
        if job_status == ur_db.JOB_STATUS_COMPLETED:
            tx["status"] = "completed"
        elif job_status == ur_db.JOB_STATUS_FAILED:
            tx["status"] = "failed"
        else:
            tx["status"] = "pending"

        # UR's indexer can surface the gross source amount while the job is
        # still pending. Rewrite to the credited fiat we stored at execute.
        job_target = job.get("target_amount")
        if job_target is not None:
            try:
                credited = float(str(job_target).lstrip("+-"))
                if credited > 0:
                    credited_str = f"{credited:.2f}"
                    tx["amount"] = f"+{credited_str}"
                    tx["outputAmount"] = credited_str
            except (TypeError, ValueError):
                pass
        source_token = (job.get("source_token") or "").upper()
        if source_token and job.get("source_amount") is not None:
            token_decimals = {"USDC": 6, "USDT": 6, "ETH": 18}.get(source_token, 6)
            try:
                raw = int(str(job["source_amount"]).lstrip("+-").split(".")[0])
                tx["inputToken"] = source_token
                tx["token"] = source_token
                tx["inputAmount"] = f"{raw / (10 ** token_decimals):.2f}"
            except (TypeError, ValueError):
                pass

        enriched.append(tx)
    return enriched


def _enrich_transfer_transactions_from_jobs(
    txs: list,
    sb,
    privy_user_id: str,
    jobs: Optional[list] = None,
) -> list:
    """Attach saved-recipient labels to P2P (HyperTrade user transfer) rows.

    UR's indexer labels a peer transfer "Account 5448769923". When the viewer
    saved that counterparty in their address book we surface the label instead,
    so history reads "Sent to 'Mom'". The counterparty URID is taken from our
    own transfer job (authoritative recipient) when the row hash matches one of
    ours, else from the row's structured field / free-text. We blank UR's raw
    title/subtitle on P2P rows so the frontend formats them consistently from
    type + direction + counterparty. Best-effort: never raises into the request.
    """
    if not isinstance(txs, list) or not txs:
        return txs
    if not any(isinstance(t, dict) and (t.get("type") or "").upper() == "P2P" for t in txs):
        return txs

    try:
        recipients = ur_db.list_p2p_recipients(sb, privy_user_id=privy_user_id, limit=100)
    except Exception:  # noqa: BLE001
        recipients = []
    label_by_urid: Dict[int, str] = {}
    for r in recipients:
        rid = str(r.get("recipient_ur_id") or "").strip()
        lbl = (r.get("label") or "").strip()
        if rid.isdigit() and lbl:
            label_by_urid[int(rid)] = lbl

    transfer_to_by_hash: Dict[str, str] = {}
    for job in (jobs or []):
        if (job.get("kind") or "").lower() != ur_db.JOB_KIND_TRANSFER:
            continue
        h = (job.get("source_tx_hash") or "").strip().lower()
        to_acct = str(job.get("quote_id") or "").strip()
        if h and to_acct.isdigit():
            transfer_to_by_hash[h] = to_acct

    enriched: list = []
    for raw in txs:
        if not isinstance(raw, dict) or (raw.get("type") or "").upper() != "P2P":
            enriched.append(raw)
            continue
        tx = dict(raw)
        h = (tx.get("txHash") or "").strip().lower()
        counterparty = transfer_to_by_hash.get(h) or str(tx.get("counterpartyUrId") or "").strip()
        if not counterparty.isdigit():
            scraped = _first_account_id_in(
                tx.get("subtitle"), tx.get("title"), tx.get("listingTitle")
            )
            counterparty = str(scraped) if scraped else ""
        if counterparty.isdigit():
            tx["counterpartyUrId"] = counterparty
            lbl = label_by_urid.get(int(counterparty))
            if lbl:
                tx["counterpartyName"] = lbl
        # Hand display formatting to the frontend (i18n "Sent to / Received
        # from {name}") instead of UR's raw "Account 5448769923".
        tx["listingTitle"] = ""
        tx["title"] = ""
        tx["subtitle"] = ""
        enriched.append(tx)
    return enriched


def _normalize_bank_payout_status(txs: list) -> list:
    """Show bank payouts (type ``POU``) as completed once relayed on-chain.

    A bank payout's on-chain relay (``permitAndClientPayout``) debits the user
    and is irreversible from their side the moment it mines — UR returns the
    ``txHash`` only after relaying. UR's indexer can then keep the row
    ``pending`` for as long as the downstream bank settlement takes (days),
    which we don't control and which isn't user-actionable. So a POU row that
    has on-chain proof and isn't explicitly failed reads as completed. Genuine
    failures (``failed``/``rejected``/``error``) are preserved.
    """
    if not isinstance(txs, list) or not txs:
        return txs
    _bad = {"failed", "rejected", "error", "cancelled", "declined", "reversed"}
    out: list = []
    for raw in txs:
        if not isinstance(raw, dict) or (raw.get("type") or "").upper() != "POU":
            out.append(raw)
            continue
        status = (raw.get("status") or "").strip().lower()
        tx_hash = (raw.get("txHash") or raw.get("hash") or "").strip()
        if tx_hash and status not in _bad and status != "completed":
            raw = {**raw, "status": "completed"}
        out.append(raw)
    return out


def _parse_job_iso_ts(value: Any) -> int:
    """Parse a job timestamp column to unix seconds (0 on failure)."""
    if value is None:
        return 0
    try:
        if isinstance(value, str):
            from datetime import datetime

            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
        if hasattr(value, "timestamp"):
            return int(value.timestamp())
    except Exception:
        return 0
    return 0


# Only synthesise withdraw rows for in-flight jobs or ones the user just
# submitted — NOT stale `submitted` rows we reconciled days later (those
# would ghost-appear as duplicate "Crypto received" lines).
_WITHDRAW_SYNTH_MAX_AGE_SEC = 45 * 60


def _should_synthesise_withdraw_job(job: Dict[str, Any]) -> bool:
    status = (job.get("status") or "").lower()
    if status not in ur_db.JOB_TERMINAL_STATUSES:
        return True
    created_ts = _parse_job_iso_ts(job.get("created_at"))
    if not created_ts:
        return False
    import time

    return (time.time() - created_ts) <= _WITHDRAW_SYNTH_MAX_AGE_SEC


def _chain_explorer_tx_url(chain_id: Optional[int], tx_hash: str) -> str:
    """Return a best-effort block-explorer URL for a tx hash. Empty string
    on unknown chain — caller treats that as 'no link'."""
    cid = int(chain_id) if chain_id else 0
    if cid == 421614:
        return f"https://sepolia.arbiscan.io/tx/{tx_hash}"
    if cid == 42161:
        return f"https://arbiscan.io/tx/{tx_hash}"
    if cid == 5003:
        return f"https://sepolia.mantlescan.xyz/tx/{tx_hash}"
    if cid == 5000:
        return f"https://mantlescan.xyz/tx/{tx_hash}"
    if cid == 1:
        return f"https://etherscan.io/tx/{tx_hash}"
    return ""


def _job_to_synthetic_tx(job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Project a deposit/FX job row into the shape of a UR `/v1/transactions`
    row so the frontend can render it without any special-casing.

    Used to bridge UR's indexer lag — once UR catches up its own row will
    have the same `txHash` and the merge dedup step drops ours.
    """
    kind = (job.get("kind") or "").lower()
    tx_hash = (job.get("source_tx_hash") or "").strip()
    if not tx_hash:
        return None
    status_raw = (job.get("status") or "").lower()
    if status_raw == "completed":
        status = "completed"
    elif status_raw == "failed":
        status = "failed"
    else:
        status = "pending"

    chain_id = job.get("source_chain_id")
    target_chain_id = job.get("target_chain_id") or chain_id
    target_ccy = (job.get("target_currency") or "").upper().replace("24", "")
    source_ccy = (job.get("source_token") or "").upper().replace("24", "")
    source_amount = job.get("source_amount")
    target_amount = job.get("target_amount")

    # Pick a representative timestamp — prefer completed_at, fall back to
    # updated_at, then created_at. Convert ISO/aware to unix seconds.
    ts = _parse_job_iso_ts(
        job.get("completed_at") or job.get("updated_at") or job.get("created_at")
    )

    base: Dict[str, Any] = {
        "urId": str(job.get("ur_id") or ""),
        "txHash": tx_hash,
        "txHashUrl": _chain_explorer_tx_url(int(target_chain_id) if target_chain_id else 0, tx_hash),
        "timestamp": ts,
        "status": status,
        "chainId": f"eip155:{target_chain_id}" if target_chain_id else "",
        "image": "",
        "txIdIcon": "",
        "listingTitle": "",
        "title": "",
        "subtitle": "",
    }

    if kind == ur_db.JOB_KIND_DEPOSIT:
        # `source_amount` is stored in RAW token units (e.g. "5000000" for
        # 5 USDC). `target_amount` is the human-decimal amount credited to
        # the user's fiat wallet after fees (e.g. "4.98" for a 5 USDC
        # deposit with a $0.02 settlement fee). The Transactions row should
        # show the credited fiat while `inputAmount` keeps the gross source.
        source_token = (job.get("source_token") or "USDC").upper()
        token_decimals = {"USDC": 6, "USDT": 6, "ETH": 18}.get(source_token, 6)
        try:
            raw = int(str(source_amount or "0").lstrip("+-").split(".")[0])
            human = raw / (10 ** token_decimals)
            input_amount_str = f"{human:.2f}"
        except Exception:
            input_amount_str = "0.00"
        credited_str = input_amount_str
        if target_amount is not None:
            try:
                credited = float(str(target_amount).lstrip("+-"))
                if credited > 0:
                    credited_str = f"{credited:.2f}"
            except (TypeError, ValueError):
                pass
        return {
            **base,
            "type": "CTU",
            "direction": "IN",
            # `currency` is the credited fiat (drives amount + icon).
            "currency": target_ccy or "USD",
            # `token` / `inputToken` are the source crypto for subtitles.
            "token": source_token,
            "amount": f"+{credited_str}",
            "inputToken": source_token,
            "inputAmount": input_amount_str,
            "outputAmount": credited_str,
        }

    if kind == ur_db.JOB_KIND_FX:
        if not (source_ccy and target_ccy and source_ccy != target_ccy):
            return None
        amount_str = str(source_amount or "0").lstrip("+-")
        out_amount = str(target_amount or "0").lstrip("+-") if target_amount else None
        row: Dict[str, Any] = {
            **base,
            "type": "FRX",
            "direction": "OUT",
            "currency": source_ccy,
            "token": source_ccy,
            "amount": f"-{amount_str}",
            "inputToken": source_ccy,
            "inputAmount": amount_str,
            "outputToken": target_ccy,
        }
        if out_amount is not None:
            row["outputAmount"] = out_amount
        return row

    if kind == ur_db.JOB_KIND_WITHDRAW:
        source_ccy = (job.get("source_token") or "").upper().replace("24", "")
        amount_str = str(source_amount or "0").lstrip("+-")
        try:
            human = float(amount_str)
            amount_fmt = f"{human:.2f}" if "." not in amount_str else amount_str
        except Exception:
            amount_fmt = amount_str
        row: Dict[str, Any] = {
            **base,
            "type": "CTF",
            "direction": "OUT",
            "listingTitle": "Cash to crypto",
            "currency": source_ccy or "USD",
            "token": source_ccy or "USD",
            "amount": f"-{amount_fmt}",
            "inputToken": source_ccy or "USD",
            "inputAmount": amount_fmt,
        }
        target_token = (job.get("target_currency") or "USDC").upper()
        if target_amount:
            row["outputToken"] = target_token
            row["outputAmount"] = str(target_amount).lstrip("+-")
        return row

    if kind == ur_db.JOB_KIND_TRANSFER:
        ccy = source_ccy or target_ccy or "USD"
        amount_str = str(source_amount or "0").lstrip("+-")
        try:
            human = float(amount_str)
            amount_fmt = f"{human:.2f}" if "." not in amount_str else amount_str
        except Exception:
            amount_fmt = amount_str
        row = {
            **base,
            "type": "P2P",
            "direction": "OUT",
            "currency": ccy,
            "token": ccy,
            "amount": f"-{amount_fmt}",
            "inputToken": ccy,
            "inputAmount": amount_fmt,
        }
        # quote_id carries the recipient URID for transfer jobs (see
        # ur_transfer_execute). _enrich_transfer_transactions_from_jobs turns
        # this into the saved label for display.
        to_acct = str(job.get("quote_id") or "").strip()
        if to_acct.isdigit():
            row["counterpartyUrId"] = to_acct
        return row

    return None


def _ur_tx_matches_job(tx: Dict[str, Any], job: Dict[str, Any]) -> bool:
    """Fuzzy match a UR transactions row against one of our jobs.

    Cross-chain deposits (USDC -> USD24 via LayerZero) emit the burn tx
    on the source chain and the mint tx on the destination chain. UR's
    `/v1/transactions` indexes the DESTINATION tx, but our job row only
    stores the SOURCE tx hash — so a naive `txHash` dedup misses matches
    for deposit rows.

    We work around it with a tight fuzzy match:
      * Same kind (CTU↔deposit, FRX↔fx)
      * Same currency / token semantics
      * inputAmount within rounding tolerance
      * timestamp within ±15 min of the job's completed_at / updated_at
    Returns True on match → caller skips synthesising ours.
    """
    kind = (job.get("kind") or "").lower()
    tx_type = (tx.get("type") or "").upper()
    if kind == ur_db.JOB_KIND_DEPOSIT and tx_type != "CTU":
        return False
    if kind == ur_db.JOB_KIND_FX and tx_type != "FRX":
        return False
    if kind == ur_db.JOB_KIND_WITHDRAW and tx_type != "CTF":
        return False

    # Compare humanised input amounts.
    raw_amt = str(job.get("source_amount") or "0").lstrip("+-").split(".")[0]
    if kind == ur_db.JOB_KIND_DEPOSIT:
        decimals = 6  # USDC; extend with token map when adding ETH/USDT sources.
        try:
            job_amt = int(raw_amt) / (10 ** decimals)
        except Exception:
            job_amt = 0.0
    else:
        try:
            job_amt = float(str(job.get("source_amount") or "0").lstrip("+-"))
        except Exception:
            job_amt = 0.0
    tx_amt_raw = (
        tx.get("inputAmount")
        or tx.get("amount")
        or "0"
    )
    try:
        tx_amt = abs(float(str(tx_amt_raw).lstrip("+-")))
    except Exception:
        return False
    if abs(tx_amt - job_amt) > 0.02:  # ¢ rounding tolerance
        return False

    # Compare currencies. For deposits the destination currency in UR's
    # row is `currency`; for FX the source currency.
    target_ccy = (job.get("target_currency") or "").upper().replace("24", "")
    source_ccy = (job.get("source_token") or "").upper().replace("24", "")
    tx_ccy = (tx.get("currency") or "").upper().replace("24", "")
    if kind == ur_db.JOB_KIND_DEPOSIT and target_ccy and tx_ccy and target_ccy != tx_ccy:
        return False
    if kind == ur_db.JOB_KIND_FX and source_ccy and tx_ccy and source_ccy != tx_ccy:
        return False
    if kind == ur_db.JOB_KIND_WITHDRAW and source_ccy and tx_ccy and source_ccy != tx_ccy:
        return False

    # Time window check (±15 min). Cheap insurance against unrelated rows.
    tx_ts = int(tx.get("timestamp") or 0)
    job_ts = _parse_job_iso_ts(
        job.get("completed_at") or job.get("updated_at") or job.get("created_at")
    )
    if tx_ts and job_ts and abs(tx_ts - job_ts) > 15 * 60:
        return False

    return True


def _merge_local_jobs_into_transactions(
    txs: list,
    sb,
    privy_user_id: str,
    jobs: Optional[list] = None,
    reconcile: bool = True,
) -> list:
    """Prepend completed/pending local jobs that UR's indexer hasn't surfaced.

    Why this exists: UR's `/v1/transactions` indexer is eventually-consistent
    against the source chain — on testnet (and during traffic spikes on
    mainnet) it can lag the receipt by minutes. The user's just-completed
    deposit/convert disappears from history during that window, which
    feels broken even though everything is fine on-chain.

    Dedup strategy:
      * Index existing UR rows by `txHash` so same-chain matches (FX)
        never duplicate.
      * For cross-chain matches (deposit: Arb source hash vs Mantle
        destination hash) use the fuzzy matcher `_ur_tx_matches_job`.
      * Sort the merged result by timestamp DESC so the new rows land at
        the top.
    """
    if not isinstance(txs, list):
        return txs
    existing_hashes = {
        (t.get("txHash") or "").strip().lower()
        for t in txs
        if isinstance(t, dict)
    }
    existing_hashes.discard("")

    if jobs is None:
        try:
            jobs = ur_db.list_user_jobs(sb, privy_user_id=privy_user_id, limit=50)
        except Exception:
            logger.exception("merge_local_jobs: list_user_jobs failed")
            return txs

    # Cap how many non-terminal jobs we reconcile on-chain per call. Each
    # reconcile does a source-chain receipt read (seconds on a cold RPC),
    # so even on the reconcile=true path we only heal the most recent few.
    # `jobs` is newest-first, so the freshest pending rows get priority.
    _RECONCILE_BUDGET = 5
    reconciled_count = 0

    # Cross-chain dedup must be 1:1. `_ur_tx_matches_job` is fuzzy (amount +
    # currency + time window, since the source/destination hashes differ), so a
    # single UR destination row would otherwise match EVERY same-amount in-flight
    # deposit. With two concurrent "+10 USD" deposits that meant one UR row
    # shadowed both jobs -> only one row rendered, and as UR's eventually-
    # consistent indexer surfaced/dropped that row between polls the second row
    # flickered in and out. We consume each UR row at most once so N jobs always
    # map to N rows (UR row where matched, synthesised otherwise).
    consumed_tx_indices: set = set()

    synthesised: list = []
    for job in jobs:
        kind = (job.get("kind") or "").lower()
        if kind not in {
            ur_db.JOB_KIND_DEPOSIT,
            ur_db.JOB_KIND_FX,
            ur_db.JOB_KIND_WITHDRAW,
            ur_db.JOB_KIND_TRANSFER,
        }:
            continue
        if kind == ur_db.JOB_KIND_WITHDRAW and not _should_synthesise_withdraw_job(job):
            continue
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        if not tx_hash or tx_hash in existing_hashes:
            continue
        # ─── Self-healing: reconcile non-terminal jobs inline ──────────
        # The ConvertBottomSheet (and DigitalDepositBottomSheet) confirm
        # success by polling the on-chain receipt directly, NOT by hitting
        # `/ur/jobs/{job_id}`. As a result kind=fx jobs (which have no
        # UR webhook and no destination-chain hop) sit at `submitted`
        # forever — `completed_at = NULL`, status renders as "pending"
        # in the Transactions tab even though the swap settled on-chain
        # seconds after broadcast. Same exposure (smaller, since UR
        # webhooks usually fire) applies to kind=deposit.
        #
        # Reconciling here means EVERY load of `/ur/transactions` (which
        # includes pull-to-refresh and app cold-start) opportunistically
        # advances any stuck job by reading the source receipt. Once the
        # receipt is mined, status flips to `completed` and the synthesised
        # row renders correctly. If the receipt isn't there yet, we leave
        # the row at pending and let the next refresh try again.
        if (
            reconcile
            and reconciled_count < _RECONCILE_BUDGET
            and job.get("status") not in ur_db.JOB_TERMINAL_STATUSES
        ):
            reconciled_count += 1
            try:
                advanced = _reconcile_job_from_source_receipt(job)
                if advanced:
                    job = advanced
                if (
                    kind == ur_db.JOB_KIND_DEPOSIT
                    and job.get("status") not in ur_db.JOB_TERMINAL_STATUSES
                ):
                    lz_advanced = _reconcile_deposit_from_layerzero(job)
                    if lz_advanced:
                        job = lz_advanced
            except Exception:  # noqa: BLE001
                # Reconciler failures are non-fatal — we just render the
                # job at its current (pending) status this round.
                logger.exception(
                    "merge_local_jobs: reconcile failed for job %s",
                    job.get("id"),
                )
        # Fuzzy check against existing rows so we don't duplicate UR's
        # destination-chain row with our source-chain row. Bind 1:1 — once a
        # UR row is claimed by a job it can't shadow a second same-amount job.
        matched = False
        for idx, t in enumerate(txs):
            if idx in consumed_tx_indices or not isinstance(t, dict):
                continue
            if _ur_tx_matches_job(t, job):
                consumed_tx_indices.add(idx)
                matched = True
                break
        if matched:
            continue
        row = _job_to_synthetic_tx(job)
        if row is not None:
            synthesised.append(row)
            existing_hashes.add(tx_hash)

    if not synthesised:
        return txs

    merged = synthesised + list(txs)
    merged.sort(
        key=lambda r: int(r.get("timestamp") or 0) if isinstance(r, dict) else 0,
        reverse=True,
    )
    return merged


class _UrStatementRequest(BaseModel):
    from_timestamp: int
    to_timestamp: int
    currencies: Optional[List[str]] = None
    direction: Literal["ALL", "IN", "OUT"] = "ALL"
    scope: Literal["ALL", "CASH", "CARD"] = "ALL"
    user_email: Optional[str] = None


def _pipeline_ur_transactions_for_statement(
    txs: list,
    *,
    privy_user_id: str,
) -> list:
    """Apply the same normalisation as `/ur/transactions` before statement export."""
    if not isinstance(txs, list):
        return []
    data = list(txs)
    if supabase:
        data = _enrich_frx_transactions_from_jobs(data, supabase, privy_user_id)
        data = _merge_local_jobs_into_transactions(data, supabase, privy_user_id)
        data = _enrich_transfer_transactions_from_jobs(data, supabase, privy_user_id)
    data = _normalize_bank_payout_status(data)
    return data


async def _build_statement_payload(
    *,
    ur_id: int,
    privy_user_id: str,
    req: _UrStatementRequest,
) -> Dict[str, Any]:
    try:
        ur_statement.validate_statement_range(req.from_timestamp, req.to_timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        raw = await ur_statement.fetch_transactions_in_range(
            ur_id,
            from_ts=req.from_timestamp,
            to_ts=req.to_timestamp,
        )
    except ur_api.URError as exc:
        logger.warning("UR statement fetch failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR transactions fetch failed")

    normalised = _pipeline_ur_transactions_for_statement(raw, privy_user_id=privy_user_id)
    txs = ur_statement.prepare_statement_transactions(
        normalised,
        from_ts=req.from_timestamp,
        to_ts=req.to_timestamp,
        currencies=req.currencies,
        direction=req.direction,
        scope=req.scope,
    )
    summary = ur_statement.compute_statement_summary(txs)
    generated_at = datetime.now(timezone.utc)
    state_id = ur_statement.make_state_id(ur_id, generated_at)
    return {
        "ur_id": ur_id,
        "state_id": state_id,
        "period": {
            "from_timestamp": req.from_timestamp,
            "to_timestamp": req.to_timestamp,
        },
        "filters": {
            "currencies": req.currencies or [],
            "direction": req.direction,
            "scope": req.scope,
        },
        "summary": summary,
        "transactions": txs,
        "generated_at": generated_at.isoformat(),
    }


@api_router.post("/ur/statement/preview", tags=["ur"])
async def ur_statement_preview(
    req: _UrStatementRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Preview statement totals and tx count for a date range (no PDF)."""
    ur_id = await _resolve_caller_urid(auth_user)
    payload = await _build_statement_payload(
        ur_id=ur_id,
        privy_user_id=auth_user.user_id,
        req=req,
    )
    # Omit full tx rows from preview — UI only needs summary + count.
    return {
        "ur_id": payload["ur_id"],
        "state_id": payload["state_id"],
        "period": payload["period"],
        "filters": payload["filters"],
        "summary": payload["summary"],
        "generated_at": payload["generated_at"],
    }


@api_router.post("/ur/statement/export", tags=["ur"])
async def ur_statement_export(
    req: _UrStatementRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Generate a PDF account statement and return it for download/share."""
    ur_id = await _resolve_caller_urid(auth_user)
    payload = await _build_statement_payload(
        ur_id=ur_id,
        privy_user_id=auth_user.user_id,
        req=req,
    )
    generated_at = datetime.fromisoformat(payload["generated_at"])
    try:
        pdf_bytes = await asyncio.to_thread(
            ur_statement.render_statement_pdf,
            ur_id=ur_id,
            transactions=payload["transactions"],
            summary=payload["summary"],
            from_ts=req.from_timestamp,
            to_ts=req.to_timestamp,
            currencies=req.currencies,
            direction=req.direction,
            scope=req.scope,
            user_email=req.user_email,
            generated_at=generated_at,
        )
    except Exception as exc:
        logger.exception("Statement PDF render failed for ur_id=%s", ur_id)
        raise HTTPException(status_code=500, detail="Statement PDF generation failed") from exc

    filename = f"HyperTrade-Statement-{payload['state_id']}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Dev-only: import UR test signer wallet into caller's Privy user
# --------------------------------------------------------------------------- #


@api_router.get("/dev/ur-test-wallet", tags=["dev"])
async def dev_ur_test_wallet_info(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return whether UR test-wallet import is enabled and the expected address.

    The address is resolved PER authenticated user so each configured test
    identity (device) gets its own URID-owner address — the frontend force-
    resolves its signing wallet to exactly this value.
    """
    enabled = privy_import.is_ur_test_wallet_import_enabled()
    address = privy_import.get_ur_test_wallet_address(auth_user.user_id)
    return {
        "enabled": enabled,
        "address": address,
        "ur_env": ur_api.UR_ENV,
    }


@api_router.post("/dev/import-ur-test-wallet", tags=["dev"])
async def dev_import_ur_test_wallet(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Import the configured UR test-wallet key into the authenticated Privy user.

    Resolves to (in priority order):
      1. ``UR_TEST_OWNER_PRIVKEY_*`` — the URID owner (External Wallet Access mode)
      2. ``UR_API_SIGNER_PRIVKEY_*`` — fallback for legacy testnet setups

    Gated by ``ENABLE_UR_TEST_WALLET_IMPORT=1`` and ``PRIVY_APP_SECRET``. The
    private key never leaves the server — this is for UR integration testing only.
    """
    if not privy_import.is_ur_test_wallet_import_enabled():
        raise HTTPException(
            status_code=403,
            detail="UR test wallet import is disabled. Set ENABLE_UR_TEST_WALLET_IMPORT=1.",
        )
    try:
        result = await asyncio.to_thread(
            privy_import.import_ur_test_wallet_for_user,
            privy_user_id=auth_user.user_id,
        )
    except privy_import.PrivyImportError as exc:
        logger.warning("UR test wallet import failed for %s: %s", auth_user.user_id, exc)
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "privy_user_id": auth_user.user_id,
        **result,
    }


# --------------------------------------------------------------------------- #
# UR deposit / withdraw / jobs (Phase 1 — Managed Custody)
#
# Design notes:
#
# - Quote endpoints proxy UR's REST quote APIs. The exact paths are
#   placeholders pending UR's Managed Custody spec; once confirmed we
#   only need to flip the constants below.
# - Execute endpoints persist a job (atomic, idempotent via
#   `(privy_user_id, idempotency_key)`) then dispatch through
#   `ur_relayer.dispatch_*_job`. The dispatcher is currently a stub raising
#   `URRelayerError("waiting on UR")` — this is fine. The persisted job
#   row + clean error response let the frontend exercise the full UX path.
# - GET /api/ur/jobs and /api/ur/jobs/{id} are reads; status transitions
#   happen elsewhere (executor + webhook handler) so concurrent replicas
#   stay safe.
# - The webhook handler below is extended to match `transaction` events to
#   open jobs by `source_tx_hash` and complete them atomically.
# --------------------------------------------------------------------------- #


# Quote endpoint paths — flip when UR confirms the Managed Custody spec.
# TODO(ur-managed-custody): confirm these names. Today they mirror the
# Delegated/V4 OpenAPI paths.
_UR_QUOTE_DEPOSIT_PATH = "/v1/deposit/quote"
# Withdraw uses UR's "onramp" endpoint family (USD24 -> USDC). The helpers
# live in ur_api.get_onramp_quote_async / submit_onramp_async, so no path
# constant needed here.


class _UrDepositQuoteRequest(BaseModel):
    source_chain_id: int
    source_token: str
    source_amount: str
    target_currency: str


class _UrPermit(BaseModel):
    owner: str
    spender: str
    value: str
    deadline: int
    v: int
    r: str
    s: str


class _UrDepositExecuteRequest(BaseModel):
    quote_id: Optional[str] = None
    idempotency_key: str
    source_chain_id: int
    source_token: str
    source_amount: str
    target_currency: str
    target_amount: Optional[str] = None
    quote_expires_at: Optional[str] = None
    permit: _UrPermit


class _UrExtAuth(BaseModel):
    """Frontend-signed External-Mode Full-Auth header values.

    The URID-owning wallet (Privy) produces ``sign`` =
    personalSign("I agree to access my profile. " + keccak256(hash+deadline)).
    The backend forwards these verbatim to UR; it never signs them itself.
    A single signed set is valid for any call until ``deadline`` (so the
    frontend can sign once and reuse across config/quote/submit).
    """
    hash: str
    deadline: int
    sign: str


class _UrWithdrawQuoteRequest(BaseModel):
    """Cash-out quote input (USD24/EUR24/CHF24 -> USDC on dest chain).

    External Wallet Access Mode: the user signs Full-Auth headers (`auth`)
    which we forward to UR's `/api/v1/quote/onramp`. Decimal-string amounts
    (e.g. "5.00") in the user-facing fiat currency; the server converts to
    2-dp smallest-unit before calling UR.
    """
    auth: _UrExtAuth
    source_currency: str            # "USD" / "EUR" / "CHF"
    source_amount: str              # "5.00" (decimal string)
    dest_chain_id: int              # 5003 (Mantle Sepolia) testnet / 42161 (Arb One) ...
    # Destination token defaults to USDC on the chosen chain. Future: allow
    # any aggregator-supported token (ETH, WBTC, etc.) by passing an address.
    dest_token: str = "USDC"
    # The URID-owning EOA (Privy wallet). Used to read the EIP-2612 permit
    # nonce so the quote response can hand the frontend everything it needs
    # to sign typed data without extra RPC reads.
    auth_owner_address: Optional[str] = None


class _UrWithdrawExecuteRequest(BaseModel):
    """Cash-out submit input (External Wallet Access Mode, gasless permit).

    The user signs (a) Full-Auth headers (`auth`) and (b) an EIP-2612 permit
    over the fiat token authorising the BufferPool spender. The `dst_*`
    fields come straight from the matching quote so UR can bind the submit
    to its cached quote. UR validates the permit and pays the gas.
    """
    auth: _UrExtAuth
    quote_id: str
    idempotency_key: str
    source_currency: str
    source_amount: str
    dest_chain_id: int
    dest_token: str = "USDC"
    target_amount: Optional[str] = None
    quote_expires_at: Optional[str] = None
    # Captured from the matching quote's `result.best.*`.
    dst_aggregator: str
    dst_token_out: str
    dst_swap_calldata: str
    dst_min_amount_out: str
    # EIP-2612 permit signed by the user's wallet (fiat token -> BufferPool).
    permit_deadline: int
    permit_v: int
    permit_r: str
    permit_s: str


# ─── Cash pay-out ("Send") — External Wallet Access §6 ──────────────────────


class _UrPayoutVerifyReferenceRequest(BaseModel):
    """Validate a free-text payment reference (Full-Auth)."""
    auth: _UrExtAuth
    reference: str


class _UrPayoutCreditor(BaseModel):
    """Recipient (creditor) details. Latin characters only per UR."""
    name: str
    street: Optional[str] = None
    city: Optional[str] = None
    zip: Optional[str] = None
    country: str            # ISO-2 (e.g. "CH")


class _UrPayoutVerifyContactRequest(BaseModel):
    """Validate the full recipient + bank payload (Full-Auth).

    Returns ``clientPayoutRefParams`` = {contactId, purposeId, refId}, the
    three params required to submit the payout.
    """
    auth: _UrExtAuth
    account: str            # IBAN or local account number
    bankName: str
    bic: Optional[str] = None
    purpose: int            # payment-purpose `value`
    reference: str
    creditor: _UrPayoutCreditor


class _UrPayoutPermitInfoRequest(BaseModel):
    """Resolve the EIP-2612 permit scaffold for a payout (no funds move).

    Mirrors the `permit` block of /ur/withdraw/quote: token + spender +
    value + on-chain EIP-712 domain (name/version/nonce) so the frontend can
    sign typed data without extra RPC reads.
    """
    auth: _UrExtAuth
    currency: str           # "USD" / "EUR" / "CHF"
    amount: str             # decimal string ("250.00")
    owner_address: str      # URID-owning EOA — read permit nonce for it


class _UrPayoutExecuteRequest(BaseModel):
    """Submit a bank payout (External Wallet Access, gasless permit).

    The user has signed (a) Full-Auth headers and (b) an EIP-2612 permit over
    the fiat token authorising UR's payout spender. We forward both to UR's
    `/api/v1/payout-with-permit`; UR validates the permit, executes
    `clientPayout()` and pays the gas.
    """
    auth: _UrExtAuth
    idempotency_key: str
    currency: str
    amount: str             # decimal string ("250.00")
    contact_id: str
    purpose_id: Any
    ref: str
    # EIP-2612 permit (fiat token -> payout spender).
    permit_amount: str      # decimal string; defaults to `amount` if omitted client-side
    permit_deadline: int
    permit_v: int
    permit_r: str
    permit_s: str
    # Optional human-readable echo persisted for the tx list / receipts.
    metadata: Optional[Dict[str, Any]] = None


class _UrTransferPermitInfoRequest(BaseModel):
    """Resolve the EIP-2612 permit scaffold for a URID-to-URID transfer."""
    auth: _UrExtAuth
    currency: str           # "USD" / "EUR" / "CHF"
    amount: str             # decimal string ("0.10")
    owner_address: str      # URID-owning EOA — read permit nonce for it
    to_account_id: str      # recipient URID — bound into recipient_binding


class _UrTransferExecuteRequest(BaseModel):
    """Submit a URID-to-URID fiat transfer (External Wallet Access, gasless permit)."""
    auth: _UrExtAuth
    idempotency_key: str
    currency: str
    amount: str             # decimal string ("0.10")
    to_account_id: str      # recipient URID (not EVM address)
    recipient_binding: Optional[str] = None  # from permit-info; required when binding secret set
    permit_amount: str
    permit_deadline: int
    permit_v: int
    permit_r: str
    permit_s: str


class _UrTransferRecipientSaveRequest(BaseModel):
    recipient_ur_id: str
    label: str


# ─── KYC (Sumsub) — self-serve via wallet Full-Auth ─────────────────────────


class _UrKycStatusRequest(BaseModel):
    """Read the account + KYC flow state (Full-Auth)."""
    auth: _UrExtAuth


class _UrSumsubTokenRequest(BaseModel):
    """Mint a Sumsub SDK access token to run/continue KYC.

    The token is minted via the PARTNER by-network endpoint (server-signed),
    and the URID is resolved server-side from the authenticated Privy caller —
    so no wallet Full-Auth is required here. ``auth`` is accepted but optional
    for backward-compat with older clients; it is intentionally ignored.
    """
    auth: Optional[_UrExtAuth] = None
    level_name: Optional[str] = None


def _serialise_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """Strip internal fields and normalise types for the API response."""
    return {
        "id": job.get("id"),
        "kind": job.get("kind"),
        "status": job.get("status"),
        "source_chain_id": job.get("source_chain_id"),
        "source_token": job.get("source_token"),
        "source_amount": job.get("source_amount"),
        "target_chain_id": job.get("target_chain_id"),
        "target_currency": job.get("target_currency"),
        "target_amount": job.get("target_amount"),
        "quote_id": job.get("quote_id"),
        "quote_expires_at": job.get("quote_expires_at"),
        "source_tx_hash": job.get("source_tx_hash"),
        "dest_tx_hash": job.get("dest_tx_hash"),
        "ur_event_id": job.get("ur_event_id"),
        "error_code": job.get("error_code"),
        "error_message": job.get("error_message"),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "completed_at": job.get("completed_at"),
    }


@api_router.get("/ur/deposit/currencies", tags=["ur"])
async def ur_deposit_currencies(
    source_chain_id: Optional[int] = None,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),  # noqa: ARG001
):
    """Return which fiat targets are viable for USDC Add Money on this network.

    Probed on-chain (not per-URID): source-chain deposit gateway + Ambire
    delegate + USDC, and destination Mantle OFT bytecode for each currency.
    Mainnet automatically picks up EUR/CHF/etc once UR's Mantle tokens are
    live — no mobile release needed.
    """
    src = int(source_chain_id or ur_chain.canonical_arbitrum_chain())
    return await asyncio.to_thread(ur_chain.list_digital_deposit_targets, src)


@api_router.post("/ur/deposit/quote", tags=["ur"])
async def ur_deposit_quote(
    req: _UrDepositQuoteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Get a UR quote for USDC -> URID-fiat (Add money flow).

    KYC-gated: only Live (chainStatus == 5) users may quote, mirroring UR's
    own restriction on deposits.

    UR's actual parameter shape (empirically confirmed against QA, May 2026):
        {
            urId,           # integer URID
            fromChainId,    # eip155 chainId (e.g. 421614 for Arb Sepolia)
            fromToken,      # "USDC" or ERC-20 address
            amount,         # RAW units string, e.g. "5000000" for 5 USDC
            toToken,        # ISO currency, e.g. "USD"
        }

    Response shape (subset we forward to the client):
        data.quoteId                    # echo back when executing
        data.outputAmount               # human "4.98" — what user receives
        data.outputAmountBeforeFee      # human "5.00"
        data.feeAmountViaUsdc           # raw USDC fee, e.g. "19400"
        data.totalFee                   # human "0.02"
        data.exchangeRate               # "1" for USDC -> USD
        data.chainId                    # destination chain (e.g. "eip155:5003")
        data.best.{aggregator,to,swapCalldata,minUsdcAmount,deadline}
                                        # empty when source IS USDC
                                        # populated for non-USDC sources

    The frontend converts `source_amount` (human "5") to raw units locally
    because we don't want decimals math drift between client/server; if it
    arrives as raw already (digit-only string > 6 chars) we pass through.
    """
    ur_id = await _resolve_caller_urid(auth_user)

    raw_amount_str = str(req.source_amount).strip()
    if not raw_amount_str:
        raise HTTPException(status_code=400, detail="source_amount required")
    # The Add-money frontend always sends a HUMAN USDC amount ("100", "10",
    # "5.25") — never raw base units (see DigitalDepositBottomSheet, which
    # posts `amount.trim()`). Scale to USDC's 6-dp base units here, flooring so
    # we never quote/permit more than the user typed.
    #
    # WARNING — do NOT reintroduce a "scale only if small" heuristic. The old
    # `if raw_amount < 100` branch passed any whole number >= 100 through as
    # raw base units (e.g. "100" -> 100 units = 0.0001 USDC), tripping UR's
    # 5-USDC floor with code 20003 "amount must be at least 5 usdc" while
    # "10"/"50" worked. Keep the scaling unconditional.
    from decimal import Decimal as _Dec, InvalidOperation as _InvOp, ROUND_DOWN as _RD
    try:
        human_usdc = _Dec(raw_amount_str)
    except (_InvOp, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid source_amount: {exc}")
    if human_usdc <= 0:
        raise HTTPException(status_code=400, detail="source_amount must be positive")
    raw_amount = int((human_usdc * (_Dec(10) ** 6)).to_integral_value(rounding=_RD))
    if raw_amount <= 0:
        raise HTTPException(status_code=400, detail="source_amount too small")

    try:
        resp = await ur_api.partner_call_async(
            _UR_QUOTE_DEPOSIT_PATH,
            {
                "urId": ur_id,
                "fromChainId": int(req.source_chain_id),
                "fromToken": req.source_token,
                "amount": str(raw_amount),
                "toToken": req.target_currency,
            },
        )
    except ur_api.URError as exc:
        logger.warning("UR deposit quote failed for %s: %s", ur_id, exc)
        raise HTTPException(
            status_code=503,
            detail=f"UR deposit quote unavailable: {exc}",
        )

    data = resp.get("data") or {}

    # ─── LayerZero native-fee handling (real-quote primary, cap fallback) ─
    # UR's testnet quote returns `feeAmountViaNativeToken` ≈ 0.03 ETH for
    # a deposit whose real LayerZero V2 fee is ~0.0001 ETH (303× over,
    # forensically verified via `ur_probe_addmoney_tx.py`). LayerZero
    # refunds the unused fee to `msg.sender` — which under EIP-7702 is
    # the USER'S EOA, not the relayer that originally paid. Every
    # over-funded deposit therefore silently transfers ETH from the
    # relayer to the user.
    #
    # Step 1 mitigation: `_cap_lz_native_fee` clamps UR's quote at a
    # per-chain ceiling (0.0005 ETH on Arb Sepolia, ~5× actual). Bounds
    # the bleed but doesn't eliminate it.
    #
    # Step 2 fix (this block): `_compute_real_lz_fee` calls LZ V2
    # Endpoint.quote() directly with the same MessagingParams that
    # Fiat24CryptoDeposit would emit (verified against the reference tx
    # to within 4×10⁻¹⁵ ETH of the actually-paid fee). Add a small
    # headroom buffer (default 20%) for block-to-block gas-oracle drift
    # and forward THAT instead of UR's bloated number. Steady-state
    # bleed → pennies of dust per deposit.
    #
    # If the real-quote path errors for any reason (RPC down, options
    # changed upstream, chain config gap) we fall through to the cap so
    # we never break the deposit flow.
    real_fee_wei = _compute_real_lz_fee(
        source_chain_id=int(req.source_chain_id),
        target_currency=req.target_currency,
        source_token_address=ur_chain.get_usdc(int(req.source_chain_id)),
        raw_amount=int(raw_amount),
        # Recipient is content-invariant for LZ fee pricing (LZ V2 prices
        # by message size + executor options + destination gas oracle,
        # not by message content). Use the deposit gateway itself as a
        # deterministic 20-byte placeholder so we don't have to look up
        # the user's EOA — would add an extra round-trip per quote.
        recipient=ur_chain.get_deposit_gateway(int(req.source_chain_id)),
    )
    if real_fee_wei is not None:
        data["feeAmountViaNativeToken"] = str(real_fee_wei)
        # Track that the real-quote path engaged. Useful for ops dashboards
        # so we can confirm production is on the cheap path and detect any
        # regression that silently kicks us back to the cap.
        data["_lz_fee_source"] = "real_quote_with_headroom"
    else:
        capped = _cap_lz_native_fee(int(req.source_chain_id), data)
        if capped is not None:
            data["feeAmountViaNativeToken"] = capped
            data["_lz_fee_source"] = "legacy_cap"

    # Bundle every contract address the frontend needs to build the 7702
    # batch in one round-trip. This avoids a second /api/ur/deposit/7702/info
    # call right before submitting the batch, and keeps all chain-specific
    # config server-side (we can rotate Ambire delegates / Fiat24 deploys
    # without re-shipping the mobile binary).
    addresses: Dict[str, Optional[str]] = {}
    try:
        addresses["ambire_7702_delegate"] = ur_chain.get_ambire_7702_delegate(
            int(req.source_chain_id)
        )
    except ValueError:
        addresses["ambire_7702_delegate"] = None
    try:
        addresses["deposit_contract"] = ur_chain.get_deposit_gateway(
            int(req.source_chain_id)
        )
    except ValueError:
        addresses["deposit_contract"] = None
    try:
        # Live read of the deposit contract's `usdc()` — authoritative, so a
        # UR re-point can never silently desync the client and revert deposits.
        addresses["usdc"] = await asyncio.to_thread(
            ur_chain.read_deposit_usdc, int(req.source_chain_id)
        )
    except ValueError:
        addresses["usdc"] = None
    try:
        addresses["output_token"] = ur_chain.resolve_deposit_output_token(
            int(req.source_chain_id), req.target_currency
        )
    except ValueError:
        # Frontend will see null and surface "currency not supported on
        # this network" rather than failing the whole request.
        addresses["output_token"] = None

    return {
        "ur_id": ur_id,
        "raw_source_amount": str(raw_amount),
        "data": data,
        "addresses": addresses,
        "designator_prefix": ur_chain.EIP7702_DESIGNATOR_PREFIX,
    }


# DEPRECATED: legacy gasless permit deposit — removed from service.
# The mobile app uses POST /ur/deposit/execute-7702 exclusively (verified:
# no frontend or script callers of /ur/deposit/execute). Kept below as a
# reference in case UR re-enables the old relayer path.
#
# @api_router.post("/ur/deposit/execute", tags=["ur"])
# async def ur_deposit_execute(
#     req: _UrDepositExecuteRequest,
#     auth_user: PrivyAuthUser = Depends(verify_privy_token),
# ):
#     ...


# --------------------------------------------------------------------------- #
# Path F — EIP-7702 + Ambire delegate + depositTokenViaAggregator
#
# The user signs:
#   1. A 7702 authorization (only the FIRST time on this chain — Privy's
#      `useSign7702Authorization`). Subsequent deposits skip this.
#   2. The Ambire `execute(calls, signature)` body. `calls` is built on the
#      frontend from the quote response (typically [USDC.approve(deposit,
#      amount), depositTokenViaAggregator(...)]).
#
# We just package these into a type-4 tx, sign with the relayer key, and
# broadcast. The user never sees ETH.
# --------------------------------------------------------------------------- #


class _Ur7702Call(BaseModel):
    """One entry in the AmbireAccount.execute calls array.

    `value` is a decimal string because some calls may move ETH and we
    need bigint precision; the relayer converts to int.
    """
    to: str
    value: str = "0"
    data: str


class _Ur7702Authorization(BaseModel):
    """Privy-style EIP-7702 authorization tuple.

    Mirrors the response shape of `eth_sign7702Authorization` so the
    frontend can pass it through verbatim.
    """
    chain_id: int
    address: str   # the contract the EOA is delegating to (Ambire 7702)
    nonce: int
    y_parity: int
    r: str
    s: str


class _Ur7702DepositExecuteRequest(BaseModel):
    idempotency_key: str
    source_chain_id: int
    source_token: str           # e.g. "USDC" (informational; calls carry the real address)
    source_amount: str          # raw decimal string for UI display + job persistence
    target_currency: str        # "USD" / "EUR" / ...
    target_amount: Optional[str] = None
    quote_id: Optional[str] = None
    quote_expires_at: Optional[str] = None
    user_address: str           # the EOA being delegated (Privy embedded wallet)
    calls: List[_Ur7702Call]
    batch_signature: str        # user's signature over the calls per Ambire's scheme
    authorization: Optional[_Ur7702Authorization] = None  # omit if EOA already delegated


# Per-chain ceiling on the LayerZero native fee we'll forward in a
# Path-F deposit, in WEI.
#
# Background: UR's testnet quote returns `feeAmountViaNativeToken` ≈
# 0.03 ETH (~$50) for a deposit whose real LayerZero V2 fee is ~0.0001
# ETH (303× over, forensically verified via `ur_probe_addmoney_tx.py`
# against `0x70e8d5d9cc49204f346015ca20f06be33bb66dfd17181d2599f010dd53159d5c`).
# LayerZero refunds the unused portion to `msg.sender` — which, under
# EIP-7702 SetCode, is the user's EOA, so every over-funded deposit
# silently transfers ETH from the relayer to the user.
#
# Step 1 mitigation (this file): cap the forwarded fee at 0.0005 ETH on
# Arb Sepolia. That's ~5× the observed actual fee (0.0000989… ETH) —
# tight enough that even worst-case bleed-per-deposit is ~$0.66, but
# loose enough to absorb a 5× spike in Mantle Sepolia gas without
# tripping reverts. Tune via env (`UR_LZ_FEE_CAP_<CHAIN_ID>_WEI=0` =
# disabled, pass UR's quote through unchanged).
#
# Step 2 (separate change in this same file): replace this cap with an
# exact LZ-Endpoint-derived quote so there is no bleed in steady state.
# See `_compute_real_lz_fee` below.
_LZ_FEE_CAPS_WEI: Dict[int, int] = {
    # Arb Sepolia → Mantle Sepolia. Real fee = ~0.0000989899 ETH (sum
    # of ExecutorFeePaid + DVNFeePaid in the reference receipt). Cap at
    # 5e14 wei = 0.0005 ETH (~5× safety margin).
    421614: 500_000_000_000_000,
    # Arb One → Mantle mainnet — start at the same tight cap; we'll
    # retune once we have mainnet receipts to forensically compare
    # against (mainnet LZ fees scale with destination-chain gas, which
    # tends to be cheaper than Sepolia in practice).
    42161: 500_000_000_000_000,
}

# Last-resort ceiling when a chain has no table/env cap (unknown chain, or
# real LZ quote failed and we would otherwise forward UR's bloated fee).
# 0.001 ETH — 2× the configured Arb caps. Explicit
# ``UR_LZ_FEE_CAP_<CHAIN_ID>_WEI=0`` still disables clamping for that chain.
_LZ_FEE_HARD_CEILING_WEI = 1_000_000_000_000_000


# Default safety headroom (basis points) applied to the real LZ Endpoint
# quote before we forward `feeAmountViaNativeToken` to the frontend. 2000
# bps = 20% — absorbs block-to-block gas-oracle drift on Mantle Sepolia
# without leaking meaningfully more ETH than necessary. Tune via env:
#   UR_LZ_FEE_HEADROOM_BPS=1500 (=15%)
# A value of 0 disables headroom (use the raw quote — risky during gas spikes).
_LZ_FEE_HEADROOM_BPS_DEFAULT = 1000


def _lz_fee_headroom_bps() -> int:
    raw = os.getenv("UR_LZ_FEE_HEADROOM_BPS")
    if not raw:
        return _LZ_FEE_HEADROOM_BPS_DEFAULT
    try:
        n = int(raw)
        return max(0, n)
    except ValueError:
        return _LZ_FEE_HEADROOM_BPS_DEFAULT


def _lz_real_quote_enabled() -> bool:
    """Master switch for the real LZ Endpoint quote path.

    Set ``UR_LZ_REAL_QUOTE_ENABLED=0`` to fall straight to the legacy
    ``_cap_lz_native_fee`` path. Useful if LZ ever rolls out an Endpoint
    contract change that breaks our message-shape reconstruction.
    """
    raw = (os.getenv("UR_LZ_REAL_QUOTE_ENABLED") or "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    return True


def _compute_real_lz_fee(
    *,
    source_chain_id: int,
    target_currency: str,
    source_token_address: str,
    raw_amount: int,
    recipient: str,
) -> Optional[int]:
    """Return the LZ V2 native fee (wei) for an Add Money deposit, with
    headroom applied. Falls back to ``None`` if any chain config is
    missing or the on-chain call fails — caller should then fall back
    to ``_cap_lz_native_fee`` to preserve the legacy safety bound.
    """
    if not _lz_real_quote_enabled():
        return None
    try:
        dest_chain_id = ur_chain.canonical_mantle_chain()
        output_token = ur_chain.get_fiat_token(dest_chain_id, target_currency)
        raw_fee = ur_chain.read_deposit_lz_native_fee(
            source_chain_id=int(source_chain_id),
            dest_chain_id=int(dest_chain_id),
            recipient=recipient,
            input_token=source_token_address,
            output_token=output_token,
            amount_raw=int(raw_amount),
            amount_out_minimum_raw=int(raw_amount),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Real LZ fee quote failed (source_chain=%s, target_ccy=%s): %s — "
            "falling back to legacy cap",
            source_chain_id, target_currency, exc,
        )
        return None
    if raw_fee <= 0:
        logger.warning(
            "Real LZ fee quote returned non-positive (%s) — falling back to cap",
            raw_fee,
        )
        return None
    bps = _lz_fee_headroom_bps()
    headroom_wei = (raw_fee * bps) // 10_000
    with_headroom = raw_fee + headroom_wei
    logger.info(
        "LZ real quote: %s wei (≈%.10f ETH) + %d bps headroom = %s wei "
        "(≈%.10f ETH) for chain %s",
        raw_fee, raw_fee / 1e18, bps, with_headroom, with_headroom / 1e18,
        source_chain_id,
    )
    return with_headroom


def _cap_lz_native_fee(
    chain_id: int, quote_data: Dict[str, Any]
) -> Optional[str]:
    """Apply the per-chain LayerZero fee cap to a UR quote payload.

    Returns the (possibly clamped) `feeAmountViaNativeToken` value as a
    decimal string, or `None` if no clamping was applied (fee already under
    cap, or clamping explicitly disabled via env ``=0``). Logs when the
    cap actually triggers so operators can monitor relayer cost.

    Unknown chains without a table/env cap use ``_LZ_FEE_HARD_CEILING_WEI``
    so a real-quote RPC failure never forwards UR's uncapped bloated fee.
    """
    raw = quote_data.get("feeAmountViaNativeToken")
    if raw in (None, "", 0, "0"):
        return None

    # Env-level override takes precedence over the table default —
    # lets us tune in production without a redeploy.
    env_override = os.getenv(f"UR_LZ_FEE_CAP_{chain_id}_WEI")
    if env_override is not None and str(env_override).strip() != "":
        try:
            cap = int(str(env_override).strip())
        except ValueError:
            cap = _LZ_FEE_CAPS_WEI.get(chain_id, _LZ_FEE_HARD_CEILING_WEI)
        if cap <= 0:
            # Explicit disable for this chain — pass UR quote unchanged.
            return None
    else:
        cap = _LZ_FEE_CAPS_WEI.get(chain_id, _LZ_FEE_HARD_CEILING_WEI)

    try:
        ur_fee = int(str(raw))
    except (TypeError, ValueError):
        return None

    if ur_fee <= cap:
        return None

    logger.info(
        "LZ native-fee cap engaged for chain %s: UR quoted %s wei "
        "(≈%.6f ETH), forwarding %s wei (≈%.6f ETH, %.1fx over actual)",
        chain_id, ur_fee, ur_fee / 1e18, cap, cap / 1e18, ur_fee / (cap or 1),
    )
    return str(cap)


def _effective_deposit_target_amount(
    *,
    source_token: str,
    source_amount_raw: str,
    target_currency: str,
    quote_target_amount: Optional[str],
) -> Optional[str]:
    """Compute the *actually credited* target amount for a deposit.

    UR's `/v1/partner/quote/deposit` returns an `outputAmount` that
    assumes the aggregator path (`depositTokenViaAggregator`) which
    deducts a UR market-maker fee — e.g. for a 30 USDC deposit to USD
    it returns "29.80". But our frontend always calls the direct
    `depositTokenViaUsdc` path which has **no** on-chain fee:

      USDC -> USD24: settles 1:1 (proven by the explorer trace —
        25 USDC in, 25 USD24 out, `SentDepositedTokenViaUsd` event).

      USDC -> EUR24 / CHF24 / other: the deposit gateway converts the
        USDC's USD-equivalent into the target token using Fiat24's
        on-chain `getExchangeRate × getSpread`, mirroring what
        `Fiat24CryptoRelay.moneyExchangeExactIn` does for direct FX
        swaps on Mantle. UR's quote outputAmount also reflects this
        rate but applies an additional off-chain MM spread that
        doesn't actually happen for Path-F deposits.

    For both cases we want Supabase to show the value that ACTUALLY
    hit the user's wallet on Mantle, not UR's pre-fee estimate. We
    fall back to UR's value as a safety net if the on-chain read
    fails (e.g. relay paused, RPC outage).
    """
    src = (source_token or "").upper()
    tgt = (target_currency or "").upper()
    if src != "USDC":
        # Other source tokens go through depositTokenViaAggregator
        # which DOES deduct a fee; UR's quote is accurate there.
        return quote_target_amount

    try:
        raw_usdc = int(str(source_amount_raw or "0").lstrip("+-").split(".")[0])
    except (TypeError, ValueError):
        return quote_target_amount
    if raw_usdc <= 0:
        return quote_target_amount

    # USDC -> USD24 USED to settle 1:1, but UR now skims a settlement fee on
    # the Mantle mint (verified on-chain 2026-06-15: 5 USDC -> 4.97 USD24,
    # 0.02 to UR's fee receiver). The credited figure is therefore the quote's
    # `outputAmountBeforeFee`, which the client forwards as `target_amount`.
    # Trust it when present (positive); fall back to the legacy 1:1 number only
    # if the client didn't send one, so older clients still record something.
    if tgt == "USD":
        if quote_target_amount:
            try:
                if float(str(quote_target_amount).lstrip("+-")) > 0:
                    return quote_target_amount
            except (TypeError, ValueError):
                pass
        human = raw_usdc / (10 ** 6)
        return f"{human:.2f}"

    # Non-USD target: read the live Fiat24 rate from Mantle's relay
    # contract and apply it to the USD24-equivalent of the USDC input.
    # The deposit gateway uses the SAME oracle internally (UR's
    # reference deposits confirm this), so the answer here matches
    # what the destination chain will mint.
    try:
        mantle_chain = ur_chain.canonical_mantle_chain()
        usd24_addr = ur_chain.get_fiat_token(mantle_chain, "USD24")
        target_addr = ur_chain.get_fiat_token(mantle_chain, tgt)
        # USDC (6 dp) -> raw USD24 units (2 dp): divide by 1e4.
        raw_usd24 = raw_usdc // (10 ** 4)
        quote = ur_chain.read_fx_quote(
            mantle_chain,
            input_token=usd24_addr,
            output_token=target_addr,
            input_amount_raw=raw_usd24,
        )
        out_raw = int(quote.get("output_amount_raw") or 0)
        if out_raw <= 0:
            return quote_target_amount
        # All Fiat24 fiat tokens use 2 dp.
        human = out_raw / (10 ** 2)
        return f"{human:.2f}"
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to compute on-chain effective deposit target for "
            "%s->%s amount=%s: %s — falling back to UR quote",
            src, tgt, raw_usdc, exc,
        )
        return quote_target_amount


@api_router.post("/ur/deposit/execute-7702", tags=["ur"])
async def ur_deposit_execute_7702(
    req: _Ur7702DepositExecuteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Submit a USDC -> URID-fiat deposit via EIP-7702 + Ambire batched execute.

    This is the *primary* deposit path under Managed Custody. The user
    pays no gas (we sponsor via the UR relayer pool). See
    `ur_relayer.dispatch_7702_deposit_job` for the on-chain envelope.

    Idempotent on `(privy_user_id, idempotency_key)` — a retried request
    short-circuits to the existing job row without a second broadcast.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    if not req.calls:
        raise HTTPException(status_code=400, detail="`calls` must contain at least one call")
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    # The relayer pays gas to broadcast for `user_address`; bind it to the
    # URID owner so we never sponsor a tx for an arbitrary EOA, and rate-limit
    # job creation to bound relayer gas griefing.
    await _assert_user_address_is_urid_owner(
        link=link, ur_id=ur_id, user_address=req.user_address
    )
    await _assert_caller_owns_wallet(auth_user, req.user_address)
    _assert_quote_not_expired(req.quote_expires_at)
    await _enforce_ur_job_rate_limit(auth_user.user_id)
    # Refuse a second deposit while a prior one's source tx is still
    # unconfirmed — both would sign the same Ambire nonce and the later
    # broadcast would revert, burning relayer gas. Clears the instant the
    # source receipt confirms (LayerZero tail does not block new top-ups).
    await _assert_no_inflight_deposit(auth_user.user_id)

    # Override UR's pre-fee quote outputAmount with the actual on-chain
    # credit for the direct deposit path (currently the only path).
    # See `_effective_deposit_target_amount` for the rationale.
    effective_target_amount = _effective_deposit_target_amount(
        source_token=req.source_token,
        source_amount_raw=req.source_amount,
        target_currency=req.target_currency,
        quote_target_amount=req.target_amount,
    )

    job = await asyncio.to_thread(
        ur_db.create_job,
        supabase,
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        kind=ur_db.JOB_KIND_DEPOSIT,
        source_chain_id=int(req.source_chain_id),
        source_token=req.source_token,
        source_amount=str(req.source_amount),
        target_chain_id=ur_chain.canonical_mantle_chain(),
        target_currency=req.target_currency,
        target_amount=str(effective_target_amount) if effective_target_amount else None,
        quote_id=req.quote_id,
        quote_expires_at=req.quote_expires_at,
        idempotency_key=req.idempotency_key,
    )

    if job.get("_idempotent_hit"):
        return {"job": _serialise_job(job), "idempotent": True}

    transitioned = await asyncio.to_thread(
        ur_db.transition_status_atomic,
        supabase,
        job_id=job["id"],
        expected_status=ur_db.JOB_STATUS_CREATED,
        new_status=ur_db.JOB_STATUS_AWAITING_USER_SIG,
    )
    if not transitioned:
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {"job": _serialise_job(latest or job)}

    # Pass the authorization through verbatim — relayer revalidates shape.
    authorization_payload: Optional[Dict[str, Any]] = None
    if req.authorization is not None:
        authorization_payload = {
            "chain_id": int(req.authorization.chain_id),
            "address": req.authorization.address,
            "nonce": int(req.authorization.nonce),
            "y_parity": int(req.authorization.y_parity),
            "r": req.authorization.r,
            "s": req.authorization.s,
        }

    calls_payload: List[Dict[str, Any]] = [
        {"to": c.to, "value": c.value, "data": c.data} for c in req.calls
    ]

    try:
        result = await asyncio.to_thread(
            ur_relayer.dispatch_7702_deposit_job,
            supabase,
            job_id=job["id"],
            user_evm_address=req.user_address,
            ur_id=ur_id,
            source_chain_id=int(req.source_chain_id),
            calls=calls_payload,
            user_signature=req.batch_signature,
            authorization=authorization_payload,
        )
    except ur_relayer.URRelayerError as exc:
        await asyncio.to_thread(
            ur_db.fail_job,
            supabase,
            job_id=job["id"],
            error_code="relayer_unavailable",
            error_message=str(exc),
        )
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {
            "job": _serialise_job(latest or job),
            "dispatch_error": str(exc),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("UR 7702 deposit dispatch crashed for job %s", job["id"])
        await asyncio.to_thread(
            ur_db.fail_job,
            supabase,
            job_id=job["id"],
            error_code="dispatch_crashed",
            error_message=str(exc),
        )
        raise HTTPException(status_code=500, detail="7702 deposit dispatch failed")

    latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
    return {
        "job": _serialise_job(latest or job),
        "tx_hash": result.get("tx_hash"),
        "relayer_address": result.get("relayer_address"),
        "via": result.get("via"),
    }


@api_router.get("/ur/deposit/7702/info", tags=["ur"])
async def ur_deposit_7702_info(
    chain_id: int,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),  # noqa: ARG001
):
    """Return the contract addresses the frontend needs to build a 7702 batch.

    Keeps addresses out of the mobile binary so we can change Ambire /
    deposit gateway deployments without a re-release. Auth-gated to avoid
    unnecessary exposure even though everything is public on-chain.
    """
    try:
        ambire = ur_chain.get_ambire_7702_delegate(int(chain_id))
        deposit = ur_chain.get_deposit_gateway(int(chain_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # LIVE read of the gateway's `usdc()` — authoritative, kept in lock-step with
    # the deposit quote (which also reads live). UR re-points this token on
    # testnet, so returning a hardcoded map here would let the client show an
    # "Available" balance for a token the gateway won't accept — the deposit
    # then reverts on `transferFrom`. `read_deposit_usdc` falls back to the
    # static map internally only if the on-chain read fails.
    try:
        usdc = await asyncio.to_thread(ur_chain.read_deposit_usdc, int(chain_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {
        "chain_id": int(chain_id),
        "ambire_7702_delegate": ambire,
        "deposit_contract": deposit,
        "usdc": usdc,
        "designator_prefix": ur_chain.EIP7702_DESIGNATOR_PREFIX,
    }


def _currency_code_for(currency: str) -> int:
    """Map ISO currency code -> UR's on-chain currency enum.

    TODO(ur-managed-custody): confirm the enum mapping. These are
    placeholder values matching UR's docs ordering (USD=1, EUR=2, ...).
    The handler tolerates whatever UR returns — this just keeps the
    type system happy until then.
    """
    code = (currency or "").upper().replace("24", "")
    return {
        "USD": 1,
        "EUR": 2,
        "CHF": 3,
        "GBP": 4,
        "CNH": 5,
        "SGD": 6,
        "JPY": 7,
        "HKD": 8,
    }.get(code, 0)


def _validate_withdraw_dest_chain(dest_chain_id: int) -> None:
    """Reject withdraw destinations UR's onramp doesn't support.

    Per UR (May 2026): on testnet, UR's onramp (fiat -> USDC cash-out)
    ONLY supports Mantle Sepolia (5003) as the destination chain — there
    are no testnet BufferPool deployments on Arbitrum/Base/etc. On mainnet
    we allow the chains where UR has a live BufferPool + a USDC address we
    know about.

    Raising here (rather than letting UR reject the quote with an opaque
    error) gives the user a precise, actionable message and stops the
    frontend from offering a chain that can never settle.
    """
    if ur_chain.is_testnet_env():
        allowed = {ur_chain.CHAIN_MANTLE_SEPOLIA}
    else:
        # Mainnet: chains with both a BufferPool and a configured USDC.
        allowed = {
            cid
            for cid in _BUFFER_POOL_KEYS()
            if cid in ur_chain._USDC  # noqa: SLF001 — module-internal map
        }
    if int(dest_chain_id) not in allowed:
        allowed_str = ", ".join(str(c) for c in sorted(allowed)) or "(none configured)"
        env_label = "testnet" if ur_chain.is_testnet_env() else "mainnet"
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cash-out to chain {dest_chain_id} is not supported on "
                f"{env_label}. UR's onramp currently supports: {allowed_str}."
            ),
        )


def _BUFFER_POOL_KEYS() -> set:
    """Chain ids with a known BufferPool deployment (mainnet today)."""
    return set(ur_chain._BUFFER_POOL.keys())  # noqa: SLF001


async def _resolve_onramp_spender(
    *, auth: "_UrExtAuth", ur_id: int, network: int, chain_caip2: str,
) -> str:
    """Resolve the BufferPool contract (EIP-2612 permit spender) for `network`.

    Reads UR's chain-configs with the user's Full-Auth headers and returns
    the `bufferPoolContract` for the matching chain. This is the spender the
    user must authorise in their permit; signing for any other address makes
    UR reject the submit.
    """
    # Wrap the UR call so an upstream failure (most commonly an expired/
    # rejected Full-Auth signature, but also a UR API hiccup) surfaces as a
    # readable 503 instead of bubbling up as a bare 500 "Internal Server
    # Error". This block runs BEFORE the quote handler's own try/except, so
    # without this guard any chain-config error masks the real reason.
    try:
        cfg = await ur_api.ext_chain_configs_async(
            urid=ur_id, network=network,
            auth_hash=auth.hash, auth_deadline=auth.deadline, auth_sign=auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("onramp spender chain-config failed for %s: %s", ur_id, exc)
        raise HTTPException(
            status_code=503, detail=f"UR chain-config unavailable: {exc}"
        )
    except Exception as exc:  # noqa: BLE001 — never leak a bare 500
        logger.exception("onramp spender chain-config crashed for %s", ur_id)
        raise HTTPException(
            status_code=503, detail=f"UR chain-config error: {exc}"
        )
    chains = (cfg.get("result") or {}).get("chains") or []
    for ch in chains:
        if str(ch.get("chainIdentifier", "")).lower() == chain_caip2.lower():
            spender = ch.get("bufferPoolContract")
            if spender:
                return str(spender)
    raise HTTPException(
        status_code=503,
        detail=f"UR chain-config has no bufferPoolContract for {chain_caip2}",
    )


# Documented "Spender Contract" that pulls fiat via approve/permit on the
# token contract (UR Smart Contracts → Card). The payout permit authorises
# the same family of spender; UR confirmed the payout uses an approve/permit
# to a UR-side contract before calling `clientPayout()` on the token. We make
# it overridable via env and resolvable from chain-config so we never have to
# ship an app/code change if UR moves it.
_PAYOUT_SPENDER_DEFAULTS = {
    "testnet": "0x25d66C564532258eD9cdBB6215E260AFf41d8bae",
    "mainnet": "0xb9d38DDE25f67D57af5b91C254F869F90d483d05",
}


async def _resolve_payout_spender(
    *, auth: "_UrExtAuth", ur_id: int, network: int, chain_caip2: str,
) -> str:
    """Resolve the EIP-2612 permit spender for a bank payout.

    Resolution order (first hit wins), so the only runtime unknown — the exact
    UR payout spender on this env — is correctable without a release:
      1. ``UR_PAYOUT_SPENDER_{TESTNET,MAINNET}`` env override.
      2. UR chain-config for the chain, trying payout-ish keys then the card
         spender, then the bufferPool as a last resort.
      3. The documented card "Spender Contract" default for the env.
    """
    env_suffix = "TESTNET" if ur_chain.is_testnet_env() else "MAINNET"
    override = (os.getenv(f"UR_PAYOUT_SPENDER_{env_suffix}", "") or "").strip()
    if override:
        return override

    try:
        cfg = await ur_api.ext_chain_configs_async(
            urid=ur_id, network=network,
            auth_hash=auth.hash, auth_deadline=auth.deadline, auth_sign=auth.sign,
        )
        chains = (cfg.get("result") or {}).get("chains") or []
        for ch in chains:
            if str(ch.get("chainIdentifier", "")).lower() != chain_caip2.lower():
                continue
            for key in (
                "payoutContract", "clientPayoutContract", "payoutSpender",
                "cardSpenderContract", "spenderContract",
            ):
                val = ch.get(key)
                if val:
                    return str(val)
            break
    except Exception as exc:  # noqa: BLE001 — fall through to the default
        logger.warning("payout spender chain-config lookup failed: %s", exc)

    default = _PAYOUT_SPENDER_DEFAULTS["testnet" if ur_chain.is_testnet_env() else "mainnet"]
    logger.info("payout spender: falling back to documented card spender %s", default)
    return default


# ===========================================================================
# WITHDRAW (cash-out) — STATUS / WHERE WE LEFT OFF  (2026-05-29)
# ===========================================================================
# The External Wallet Access on-ramp is FULLY WIRED end-to-end and proven
# correct from two origins (local dev + Railway backend IP):
#   config (/api/v3/config/chain-configs) -> quote (/api/v1/quote/onramp)
#   -> EIP-2612 permit (domain validated vs on-chain DOMAIN_SEPARATOR)
#   -> submit (/api/v1/onramp-with-permit).  Permit accepted, quote clean,
#   needLiveness=false, spender = BufferPool 0x9291…5DAB.
#
# >>> RESOLVED 2026-06-01: the region blocker is LIFTED. UR cleared the
#     region flag on QA URID 5448769923 and the FULL chain now succeeds —
#     ur_probe_onramp_external.py submits onramp-with-permit cleanly and
#     settles on-chain (e.g. Mantle tx 0xe411e8fc…346a559). The earlier
#     retCode=10000 "Convert is unavailable in your region" no longer fires.
#     NOTE: /api/v1/onramp-limit returns HTTP 204 (empty body) on QA, so its
#     `regionLocked`/`maxAmounts` signals aren't readable there — but the
#     successful submit is proof the URID is no longer region-locked.
#
# >>> RESOLVED 2026-06-01: withdraw bottom sheet hung on "Finalising
#     withdrawal…" for ~minutes. Root cause was OURS, not chain speed: the
#     lazy job reconciler (_reconcile_job_from_source_receipt) only handled
#     kind=deposit + kind=fx, so withdraw/payout rows sat in `submitted`
#     forever (no testnet webhook to flip them). The client polled to its 60s
#     cap then force-showed success. Fixed via
#     _reconcile_onramp_from_source_receipt (handles withdraw + payout): each
#     poll reads the Mantle source-tx receipt and flips submitted->completed
#     (or ->failed on revert) the moment it mines.
#
# Diagnostics: ur_probe_onramp_external.py (CLI) + /ur/withdraw/_selftest
# (gated by UR_ENABLE_ONRAMP_SELFTEST). Shared signing: ur_onramp_permit.py.
#
# UPDATE 2026-05-31: saw a bare HTTP 500 (not the 10000 region msg) on
# /ur/withdraw/quote from the app. Root cause was an UNGUARDED upstream call:
# _resolve_onramp_spender() hit UR chain-configs BEFORE the handler's
# try/except, so a rejected/expired Full-Auth sig (or UR hiccup) surfaced as
# "Internal Server Error" with no detail. Hardened _resolve_onramp_spender to
# return a readable 503 instead. RESOLVED 2026-06-01: re-tested with a fresh
# Full-Auth signature — quote + submit both clean now that the region flag is
# lifted, so the 500 was indeed the unguarded upstream call, not our logic.
#
# UPDATE 2026-06-01: non-USD quote (EUR/CHF -> USDC) hung past the client's 30s
# axios timeout -> opaque "Network Error". UR's testnet has no on-ramp route for
# those, so the quote engine stalls. Hardened the quote call to fail fast
# (UR_WITHDRAW_QUOTE_TIMEOUT_SECONDS, def 18s) and return a readable 504. This
# is a UR testnet-route gap, not our bug — mainnet (Arbitrum) is the real path.
#
# TODO(ur-mainnet-switch): withdraw/on-ramp is already mainnet-ready — the
# Arbitrum-mainnet BufferPool (0xAACe017F0a6Bb9890E449d5b27fbcA9C440b81e9),
# native USDC, and LayerZero config are all wired in ur_chain.py. To flip on:
#   1. UR_ENV=mainnet  (switches chain ids, BufferPool, USDC, LZ everywhere)
#   2. UR_API_SIGNER_PRIVKEY_MAINNET + UR_RELAYER_PRIVKEYS_MAINNET
#   3. (Add Money only) UR_DEPOSIT_GATEWAY_ARB_MAINNET +
#      UR_AMBIRE_7702_DELEGATE_ARB_MAINNET
# Webhook signer auto-accepts both Sepolia + Mainnet UR addresses already.
# The testnet region/route block then becomes moot (real users cash out to
# Arbitrum mainnet USDC, which is HL-compatible — single-chain UX).
# ===========================================================================


@api_router.get("/ur/withdraw/info", tags=["ur"])
async def ur_withdraw_info(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Surface cash-out config the frontend needs: the Mantle chain where
    fiat lives (Full-Auth `network` + permit chain), and the supported
    destination chains/USDC addresses.

    Lets the app switch destination chains (testnet Mantle Sepolia → prod
    Arbitrum) without a mobile re-release.
    """
    mantle = ur_chain.canonical_mantle_chain()
    if ur_chain.is_testnet_env():
        allowed = [ur_chain.CHAIN_MANTLE_SEPOLIA]
    else:
        allowed = sorted(
            cid for cid in _BUFFER_POOL_KEYS() if cid in ur_chain._USDC  # noqa: SLF001
        )
    _CHAIN_NAMES = {
        5003: "Mantle Sepolia", 5000: "Mantle",
        421614: "Arbitrum Sepolia", 42161: "Arbitrum One",
        84532: "Base Sepolia", 8453: "Base",
    }
    dest_chains = []
    for cid in allowed:
        try:
            usdc = ur_chain.get_usdc(int(cid))
        except ValueError:
            usdc = None
        dest_chains.append({
            "chain_id": int(cid),
            "name": _CHAIN_NAMES.get(int(cid), f"Chain {cid}"),
            "usdc": usdc,
        })
    return {
        "supported": bool(dest_chains),
        "mantle_chain_id": mantle,
        "dest_chains": dest_chains,
        "default_dest_chain_id": dest_chains[0]["chain_id"] if dest_chains else None,
        "dest_token": "USDC",
    }


@api_router.post("/ur/withdraw/quote", tags=["ur"])
async def ur_withdraw_quote(
    req: _UrWithdrawQuoteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Get a UR cash-out quote for URID-fiat -> USDC (External Wallet Access).

    Hits UR's External-Mode `/api/v1/quote/onramp` with the user's forwarded
    Full-Auth headers. We also resolve the BufferPool spender so the frontend
    can build the EIP-2612 permit, and echo `best.*` back for the execute call.
    """
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    await _assert_ur_ext_auth_binds_caller(auth_user, link, req.auth)
    if req.auth_owner_address:
        await _assert_owner_matches_linked_urid(link, req.auth_owner_address)
    _validate_withdraw_dest_chain(int(req.dest_chain_id))

    src_chain = ur_chain.canonical_mantle_chain()  # UR's home chain for fiat
    src_caip2 = f"eip155:{src_chain}"
    dst_caip2 = f"eip155:{int(req.dest_chain_id)}"

    # Resolve the source fiat token (lives on Mantle) and destination token.
    try:
        from_token_addr = ur_chain.get_fiat_token(src_chain, req.source_currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=400, detail=f"Unsupported source_currency {req.source_currency!r}: {exc}"
        )
    if req.dest_token.upper() == "USDC":
        try:
            to_token_addr = ur_chain.get_usdc(int(req.dest_chain_id))
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail=f"USDC not configured for chain {req.dest_chain_id}: {exc}"
            )
    elif req.dest_token.startswith("0x") and len(req.dest_token) == 42:
        to_token_addr = req.dest_token
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dest_token {req.dest_token!r}. Pass 'USDC' or a 0x address.",
        )

    # External Mode onramp `amount` is in 2-dp SMALLEST units ("500" == $5.00).
    try:
        onramp_amount = str(_to_token_units(req.source_amount, 2))
        if int(onramp_amount) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid source_amount: {exc}")

    spender = await _resolve_onramp_spender(
        auth=req.auth, ur_id=ur_id, network=src_chain, chain_caip2=src_caip2,
    )

    # Fail fast below the client's 30s axios timeout. UR's quote engine stalls
    # (no quick rejection) on unsupported cash-out routes — notably non-USD
    # fiat → USDC on testnet — so without a shorter timeout the CLIENT aborts
    # first and the user only sees an opaque "Network Error". Env-tunable.
    try:
        quote_timeout = max(5.0, float(os.getenv("UR_WITHDRAW_QUOTE_TIMEOUT_SECONDS", "18")))
    except (TypeError, ValueError):
        quote_timeout = 18.0
    try:
        resp = await ur_api.ext_quote_onramp_async(
            urid=ur_id, network=src_chain,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            src_chain_id_caip2=src_caip2,
            dst_chain_id_caip2=dst_caip2,
            from_token=from_token_addr,
            to_token=to_token_addr,
            amount_raw=onramp_amount,
            timeout=quote_timeout,
        )
    except ur_api.URError as exc:
        logger.warning("UR withdraw quote failed for %s: %s", ur_id, exc)
        if _ur_upstream_is_down(exc):
            raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
        raise HTTPException(
            status_code=503,
            detail=f"UR withdraw quote unavailable: {exc}",
        )
    except httpx.TimeoutException:
        # UR hung past our fail-fast window — almost always an unsupported
        # cash-out route (e.g. EUR/CHF → USDC on testnet). Return a readable
        # 504 so the app shows a real reason instead of "Network Error".
        logger.warning(
            "UR withdraw quote timed out for %s (%s -> USDC) after %.0fs",
            ur_id, req.source_currency, quote_timeout,
        )
        raise HTTPException(
            status_code=504,
            detail=(
                f"Couldn't get a {req.source_currency} cash-out quote in time. "
                "This currency may not be available to withdraw yet — try USD, "
                "or retry shortly."
            ),
        )
    except httpx.HTTPError as exc:
        logger.warning("UR withdraw quote transport error for %s: %s", ur_id, exc)
        raise HTTPException(
            status_code=502, detail=f"UR withdraw quote network error: {exc}"
        )

    result = resp.get("result", {}) or {}

    # Read the EIP-712 permit domain + nonce so the frontend can sign typed
    # data directly (no extra RPC round-trips, and we validate the domain
    # separator against the token on-chain before handing it over).
    import ur_onramp_permit
    try:
        domain = await asyncio.to_thread(
            ur_onramp_permit.read_permit_domain,
            chain_id=src_chain, token_addr=from_token_addr, owner=req.auth_owner_address,
        ) if getattr(req, "auth_owner_address", None) else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("permit domain read failed for %s: %s", from_token_addr, exc)
        domain = None

    # How long the frontend should treat this quote as fresh before auto-
    # refreshing on the review screen. UR onramp quotes are short-lived
    # (testnet "Quote expired" fires fast), so default to 30s and refresh a
    # few seconds early. Tunable without an app release via env.
    try:
        quote_ttl_seconds = max(10, int(os.getenv("UR_WITHDRAW_QUOTE_TTL_SECONDS", "30")))
    except (TypeError, ValueError):
        quote_ttl_seconds = 30

    return {
        "ur_id": ur_id,
        "raw_source_amount": onramp_amount,
        "result": result,
        "quote_ttl_seconds": quote_ttl_seconds,
        "addresses": {
            "src_chain_id_caip2": src_caip2,
            "dst_chain_id_caip2": dst_caip2,
            "from_token": from_token_addr,
            "dest_token": to_token_addr,
        },
        # Everything the frontend needs to build + sign the EIP-2612 permit.
        "permit": {
            "token": from_token_addr,         # owner signs over the fiat token
            "spender": spender,               # BufferPool contract
            "value": onramp_amount,           # >= amountIn (use exact)
            "chain_id": src_chain,
            "name": (domain or {}).get("name"),
            "version": (domain or {}).get("version"),
            "nonce": (domain or {}).get("nonce"),
        },
    }


@api_router.post("/ur/withdraw/execute", tags=["ur"])
async def ur_withdraw_execute(
    req: _UrWithdrawExecuteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Submit a URID-fiat -> USDC withdrawal (External Wallet Access, gasless).

    The user has signed (a) Full-Auth headers and (b) an EIP-2612 permit over
    the fiat token. We forward both to UR's `/api/v1/onramp-with-permit`; UR
    validates the permit, executes `permitOnramp()` and pays the gas.

    Our role:
      1. Persist a `withdraw` job for idempotency / status tracking.
      2. POST `/api/v1/onramp-with-permit` with the permit + captured quote.
      3. Record the source (Mantle) tx hash from UR's response.
      4. Let the webhook / lazy reconciler advance to `completed`.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    await _assert_ur_ext_auth_binds_caller(auth_user, link, req.auth)
    _assert_quote_not_expired(req.quote_expires_at)
    _validate_withdraw_dest_chain(int(req.dest_chain_id))

    src_chain = ur_chain.canonical_mantle_chain()
    src_caip2 = f"eip155:{src_chain}"
    dst_caip2 = f"eip155:{int(req.dest_chain_id)}"

    # External Mode onramp expects 2-dp smallest units ("500" == $5.00).
    # Normalise up front so an invalid input fails BEFORE we create a job row.
    # Must match the value used at quote time (and the permit value).
    try:
        onramp_amount = str(_to_token_units(req.source_amount, 2))
        if int(onramp_amount) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid source_amount: {exc}")

    # Resolve the source fiat token address (tokenIn) for the permit/submit.
    try:
        token_in_addr = ur_chain.get_fiat_token(src_chain, req.source_currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=400, detail=f"Unsupported source_currency {req.source_currency!r}: {exc}"
        )

    job = await asyncio.to_thread(
        ur_db.create_job,
        supabase,
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        kind=ur_db.JOB_KIND_WITHDRAW,
        source_chain_id=src_chain,
        source_token=req.source_currency,
        source_amount=str(req.source_amount),
        target_chain_id=int(req.dest_chain_id),
        target_currency=req.dest_token,
        target_amount=str(req.target_amount) if req.target_amount else None,
        quote_id=req.quote_id,
        quote_expires_at=req.quote_expires_at,
        idempotency_key=req.idempotency_key,
    )
    if job.get("_idempotent_hit"):
        return {"job": _serialise_job(job), "idempotent": True}

    # created -> submitted on success (UR holds the user permit; no relayer).
    try:
        resp = await ur_api.ext_submit_onramp_with_permit_async(
            urid=ur_id, network=src_chain,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            quote_id=req.quote_id,
            chain_id_caip2=src_caip2,
            token_in=token_in_addr,
            amount_in_raw=onramp_amount,
            dst_chain_id_caip2=dst_caip2,
            dst_aggregator=req.dst_aggregator,
            dst_token_out=req.dst_token_out,
            dst_swap_calldata=req.dst_swap_calldata,
            dst_min_amount_out=req.dst_min_amount_out,
            permit_deadline=req.permit_deadline,
            permit_v=req.permit_v,
            permit_r=req.permit_r,
            permit_s=req.permit_s,
        )
    except ur_api.URError as exc:
        logger.warning("UR withdraw submit failed for job %s: %s", job["id"], exc)
        await asyncio.to_thread(
            ur_db.fail_job,
            supabase,
            job_id=job["id"],
            error_code="ur_submit_failed",
            error_message=str(exc),
        )
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {
            "job": _serialise_job(latest or job),
            "dispatch_error": str(exc),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("UR withdraw submit crashed for job %s", job["id"])
        await asyncio.to_thread(
            ur_db.fail_job,
            supabase,
            job_id=job["id"],
            error_code="dispatch_crashed",
            error_message=str(exc),
        )
        raise HTTPException(status_code=500, detail="Withdraw submit failed")

    # UR returns `result.txHash` = the Mantle-side burn tx. Atomically flip
    # `created -> submitted` and attach the tx hash in a single update so a
    # webhook arriving concurrently can't double-advance the row.
    tx_hash = ((resp.get("result") or {}).get("txHash") or "").strip().lower()
    if tx_hash and not tx_hash.startswith("0x"):
        tx_hash = "0x" + tx_hash
    extra: Dict[str, Any] = {}
    if tx_hash:
        extra["source_tx_hash"] = tx_hash
    advanced = await asyncio.to_thread(
        ur_db.transition_status_atomic,
        supabase,
        job_id=job["id"],
        expected_status=ur_db.JOB_STATUS_CREATED,
        new_status=ur_db.JOB_STATUS_SUBMITTED,
        extra=extra or None,
    )
    if not advanced:
        logger.warning(
            "withdraw job %s submitted to UR but FSM not advanced (unexpected state)",
            job["id"],
        )

    latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
    return {
        "job": _serialise_job(latest or job),
        "tx_hash": tx_hash or None,
        "via": "ur_onramp_with_permit",
    }


@api_router.post("/ur/withdraw/_selftest", tags=["ur"])
async def ur_withdraw_selftest(
    request: Request,
    amount: str = "500",
    currency: str = "USD",
    dry_run: bool = True,
):
    """DIAGNOSTIC ONLY — run the full External-Mode on-ramp chain server-side.

    Purpose: confirm whether UR's "Convert is unavailable in your region"
    block is IP-based. Our local CLI probe reaches UR's region gate from the
    developer's IP; this endpoint runs the IDENTICAL chain (config -> quote ->
    EIP-2612 permit -> onramp-with-permit) from the BACKEND's IP (Railway), so
    we can tell whether the gate keys off the request origin or the URID.

    Hard-gated: inert (404) unless ``UR_ENABLE_ONRAMP_SELFTEST=1`` AND the
    caller presents ``X-Selftest-Secret`` matching ``UR_ONRAMP_SELFTEST_SECRET``.
    Uses the server-held testnet key ``UR_TEST_OWNER_PRIVKEY_TESTNET`` and
    ``UR_TEST_URID``. Remove once the region question is settled.
    """
    if os.getenv("UR_ENABLE_ONRAMP_SELFTEST", "") != "1":
        raise HTTPException(status_code=404, detail="Not found")
    expected = (os.getenv("UR_ONRAMP_SELFTEST_SECRET", "") or "").strip()
    presented = (request.headers.get("X-Selftest-Secret", "") or "").strip()
    if not expected or presented != expected:
        raise HTTPException(status_code=403, detail="Bad or missing selftest secret")

    import ur_onramp_permit

    env_suffix = "TESTNET" if ur_chain.is_testnet_env() else "MAINNET"
    owner_pk = (
        os.getenv(f"UR_TEST_OWNER_PRIVKEY_{env_suffix}")
        or os.getenv(f"UR_API_SIGNER_PRIVKEY_{env_suffix}")
        or ""
    ).strip()
    urid_str = (os.getenv("UR_TEST_URID", "") or "").strip()
    if not owner_pk or not urid_str.isdigit():
        raise HTTPException(
            status_code=503,
            detail=f"selftest needs UR_TEST_OWNER_PRIVKEY_{env_suffix} + UR_TEST_URID",
        )
    from eth_account import Account as _Account

    ur_id = int(urid_str)
    owner_addr = _Account.from_key(owner_pk).address
    network = ur_chain.canonical_mantle_chain()
    caip = f"eip155:{network}"
    fiat_addr = ur_chain.get_fiat_token(network, currency)
    usdc_addr = ur_chain.get_usdc(network)
    amount_raw = str(_to_token_units(amount, 2))

    trace: Dict[str, Any] = {
        "origin": "railway-backend",
        "urid": ur_id,
        "owner": owner_addr,
        "network": network,
        "amount_raw": amount_raw,
        "currency": currency,
        "fiat_token": fiat_addr,
        "usdc": usdc_addr,
        "dry_run": dry_run,
    }

    auth = ur_onramp_permit.build_full_auth(owner_pk)
    try:
        cfg = await ur_api.ext_chain_configs_async(
            urid=ur_id, network=network,
            auth_hash=auth["hash"], auth_deadline=auth["deadline"], auth_sign=auth["sign"],
        )
        spender = None
        for ch in (cfg.get("result") or {}).get("chains") or []:
            if str(ch.get("chainIdentifier", "")).lower() == caip.lower():
                spender = ch.get("bufferPoolContract")
                break
        trace["spender"] = spender
        if not spender:
            trace["error"] = "no bufferPoolContract in config"
            return trace

        quote = await ur_api.ext_quote_onramp_async(
            urid=ur_id, network=network,
            auth_hash=auth["hash"], auth_deadline=auth["deadline"], auth_sign=auth["sign"],
            src_chain_id_caip2=caip, dst_chain_id_caip2=caip,
            from_token=fiat_addr, to_token=usdc_addr, amount_raw=amount_raw,
        )
        qr = quote.get("result", {}) or {}
        best = qr.get("best", {}) or {}
        trace["quote"] = {
            "quoteId": qr.get("quoteId"),
            "outputAmount": qr.get("outputAmount"),
            "needLiveness": qr.get("needLiveness"),
            "minAmountOut": best.get("minAmountOut"),
        }
        if dry_run:
            trace["result"] = "DRY-RUN OK (quote reached; no permit/submit)"
            return trace
        if qr.get("needLiveness"):
            trace["result"] = "BLOCKED: needLiveness=true (cannot self-serve in selftest)"
            return trace

        permit_deadline = int(time.time()) + 1800
        sig = ur_onramp_permit.build_permit(
            chain_id=network, token_addr=fiat_addr, owner_pk=owner_pk,
            owner_addr=owner_addr, spender=spender, value=int(amount_raw),
            deadline=permit_deadline,
        )
        trace["permit"] = {"nonce": sig["nonce"], "domain_ok": sig["domain_ok"], "v": sig["v"]}

        submit = await ur_api.ext_submit_onramp_with_permit_async(
            urid=ur_id, network=network,
            auth_hash=auth["hash"], auth_deadline=auth["deadline"], auth_sign=auth["sign"],
            quote_id=qr.get("quoteId"), chain_id_caip2=caip,
            token_in=fiat_addr, amount_in_raw=amount_raw, dst_chain_id_caip2=caip,
            dst_aggregator=best.get("to"), dst_token_out=usdc_addr,
            dst_swap_calldata=best.get("swapCalldata", "0x"),
            dst_min_amount_out=str(best.get("minAmountOut") or "0"),
            permit_deadline=permit_deadline, permit_v=sig["v"],
            permit_r=sig["r"], permit_s=sig["s"],
        )
        trace["result"] = "SUBMIT OK"
        trace["txHash"] = (submit.get("result") or {}).get("txHash")
        return trace
    except ur_api.URError as exc:
        trace["error"] = str(exc)
        trace["ur_code"] = exc.ur_code
        return trace


# ===========================================================================
# WITHDRAW (onramp) LIVENESS + RETRY — External Wallet Access §5.1.3–§5.1.8
# ===========================================================================
# Two mainnet-readiness flows on top of the cash-out (onramp) path:
#
#   Liveness (§5.1.3/5.1.4): when a withdraw quote returns needLiveness=true
#   (larger mainnet amounts), the user must pass a Sumsub liveness check before
#   onramp-with-permit is accepted. token -> run Sumsub SDK -> poll status.
#
#   Retry (§5.1.6/5.1.7/5.1.8): recovery for a cash-out whose DESTINATION swap
#   failed after the fiat side debited (funds stranded as USDC on dst chain).
#   pending (detect) -> quote scene=swap_retry -> swap-with-permit | cancel.
#
# MAINNET-ONLY per UR (cross-chain onramp + liveness are mainnet). On testnet
# small same-chain amounts never trigger liveness and pending-retry is empty.
# ===========================================================================


def _pending_retry_tx_hash(raw: Dict[str, Any]) -> str:
    """Best-effort original onramp tx hash from a pending-retry record.

    UR's docs say ``originalTxHash``; QA has been observed returning snake_case
    or alternate keys. We accept every variant so cancel/recover never 422.
    """
    for key in (
        "originalTxHash", "original_tx_hash",
        "txHash", "tx_hash",
        "mantleTxHash", "onrampTxHash",
    ):
        val = raw.get(key)
        if isinstance(val, str) and val.strip().startswith("0x"):
            return val.strip().lower()
    return ""


def _normalize_pending_retry_record(
    raw: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Canonicalize UR's pending-retry ``result`` for the mobile client.

    Always exposes camelCase keys the TypeScript ``UrPendingRetry`` expects.
    """
    if not raw or not isinstance(raw, dict):
        return None
    out = dict(raw)
    tx_hash = _pending_retry_tx_hash(raw)
    if tx_hash:
        out["originalTxHash"] = tx_hash
    chain = raw.get("chainId") or raw.get("chain_id")
    if chain is not None:
        out["chainId"] = str(chain)
    from_tok = raw.get("fromToken") or raw.get("from_token")
    if from_tok:
        out["fromToken"] = str(from_tok)
    to_tok = raw.get("toToken") or raw.get("to_token")
    if to_tok:
        out["toToken"] = str(to_tok)
    amt = raw.get("amount")
    if amt is not None:
        out["amount"] = str(amt)
    return out


async def _resolve_pending_retry_tx_hash(
    *,
    ur_id: int,
    auth: _UrExtAuth,
    hint: Optional[str] = None,
) -> str:
    """Return the original onramp tx hash for a pending retry record."""
    tx_hash = (hint or "").strip().lower()
    if tx_hash.startswith("0x"):
        return tx_hash
    network = ur_chain.canonical_mantle_chain()
    try:
        pend = await ur_api.ext_onramp_pending_retry_async(
            urid=ur_id, network=network,
            auth_hash=auth.hash, auth_deadline=auth.deadline, auth_sign=auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR pending-retry (tx-hash lookup) failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR pending-retry lookup failed")
    normalized = _normalize_pending_retry_record(pend.get("result"))
    tx_hash = _pending_retry_tx_hash(normalized or {})
    if not tx_hash.startswith("0x"):
        raise HTTPException(
            status_code=400,
            detail="No pending retry transaction hash found",
        )
    return tx_hash


class _UrExtAuthOnlyRequest(BaseModel):
    """Bare Full-Auth body (no extra params)."""
    auth: _UrExtAuth


@api_router.post("/ur/withdraw/liveness/token", tags=["ur"])
async def ur_withdraw_liveness_token(
    req: _UrExtAuthOnlyRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Mint a Sumsub liveness token (UR `GET /api/v2/get-liveness-token`, §5.1.3).

    Call only when a withdraw quote returned ``needLiveness=true``. Returns
    {vendor, access_token, user_id} to initialise the Sumsub SDK on the client.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_get_liveness_token_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR liveness token failed for %s: %s", ur_id, exc)
        if _ur_upstream_is_down(exc):
            raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
        _raise_ur_read_error(exc, "UR liveness token failed")
    return {"ur_id": ur_id, "result": resp.get("result", {}) or {}}


@api_router.post("/ur/withdraw/liveness/status", tags=["ur"])
async def ur_withdraw_liveness_status(
    req: _UrExtAuthOnlyRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Poll onramp liveness status (UR `GET /api/v2/check-liveness-result`, §5.1.4).

    Returns {liveness_result: pass|pending|rejected, liveness_locked, …}.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_check_liveness_result_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR liveness status failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR liveness status failed")
    return {"ur_id": ur_id, "result": resp.get("result", {}) or {}}


@api_router.post("/ur/withdraw/retry/pending", tags=["ur"])
async def ur_withdraw_retry_pending(
    req: _UrExtAuthOnlyRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Detect a stranded cash-out (UR `GET /api/v1/onramp/pending-retry`, §5.1.6).

    `result` is null when nothing is stuck, else the failed-swap record
    {originalTxHash, chainId, fromToken(USDC), toToken, amount, failedAt} that
    feeds a retry quote (scene=swap_retry) + swap-with-permit.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_onramp_pending_retry_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR pending-retry check failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR pending-retry check failed")
    return {
        "ur_id": ur_id,
        "result": _normalize_pending_retry_record(resp.get("result")),
    }


class _UrWithdrawRetryCancelRequest(BaseModel):
    """Abandon a retry-eligible stranded cash-out (Full-Auth).

    ``original_tx_hash`` is optional — when omitted we re-read pending-retry and
    pull the hash server-side so a client field-name mismatch can't 422.
    """
    auth: _UrExtAuth
    original_tx_hash: Optional[str] = None


@api_router.post("/ur/withdraw/retry/cancel", tags=["ur"])
async def ur_withdraw_retry_cancel(
    req: _UrWithdrawRetryCancelRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Cancel a pending retry (UR `POST /api/v1/onramp/retry/cancel`, §5.1.8)."""
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    tx_hash = await _resolve_pending_retry_tx_hash(
        ur_id=ur_id, auth=req.auth, hint=req.original_tx_hash,
    )
    try:
        resp = await ur_api.ext_onramp_retry_cancel_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            original_tx_hash=tx_hash,
        )
    except ur_api.URError as exc:
        logger.warning("UR retry cancel failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR retry cancel failed")
    return {"ur_id": ur_id, "ok": True, "result": resp.get("result")}


class _UrWithdrawRetryQuoteRequest(BaseModel):
    """Re-quote the failed destination swap of a stranded cash-out (Full-Auth)."""
    auth: _UrExtAuth
    chain_id: int                  # dst chain from the pending-retry record
    from_token: str                # USDC on the dst chain (pending-retry.fromToken)
    to_token: str                  # desired output token (pending-retry.toToken)
    amount: str                    # stranded USDC amount, smallest units (pending-retry.amount)
    owner_address: Optional[str] = None   # URID-owner EOA (permit owner / nonce read)
    slippage_bps: int = 50


@api_router.post("/ur/withdraw/retry/quote", tags=["ur"])
async def ur_withdraw_retry_quote(
    req: _UrWithdrawRetryQuoteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Re-quote a failed dst swap (UR `POST /api/v1/quote/onramp` scene=swap_retry, §5.1.7).

    Returns UR's quote `result` (quoteId + best.* aggregator/swapCalldata/
    minAmountOut) plus a ready-to-sign `permit` block (token = stranded USDC on
    the dst chain, spender, value, EIP-712 domain) so the client signs exactly
    like the main withdraw and submits via `/ur/withdraw/retry/submit`.

    The permit `spender` is the dst-chain Onramp (BufferPool) contract, read
    from UR's authoritative `chain-configs` (`bufferPoolContract`) — the SAME
    source the working main withdraw uses, not a guess. Per UR's docs the
    aggregator router (`best.allowanceTarget`) is the swap target the BufferPool
    calls, NOT the permit spender, so we never sign to it.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    caip2 = f"eip155:{int(req.chain_id)}"
    try:
        resp = await ur_api.ext_quote_onramp_async(
            urid=ur_id, network=ur_chain.canonical_mantle_chain(),
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            src_chain_id_caip2=caip2, dst_chain_id_caip2=caip2,
            from_token=req.from_token, to_token=req.to_token,
            amount_raw=str(req.amount), slippage_bps=int(req.slippage_bps),
            scene="swap_retry",
        )
    except ur_api.URError as exc:
        logger.warning("UR retry quote failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR retry quote failed")
    result = resp.get("result", {}) or {}

    # Build a permit block (symmetry with /ur/withdraw/quote). Spender comes from
    # the authoritative chain-configs lookup for the dst chain — identical to the
    # main onramp path — so the client signs to UR's BufferPool, never the
    # aggregator. `permit` stays null if owner/spender/domain can't be resolved.
    permit_block: Optional[Dict[str, Any]] = None
    if req.owner_address:
        spender: Optional[str] = None
        try:
            spender = await _resolve_onramp_spender(
                auth=req.auth, ur_id=ur_id, network=int(req.chain_id), chain_caip2=caip2,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("retry permit spender resolve failed: %s", exc)
            spender = None
        if spender:
            import ur_onramp_permit
            try:
                domain = await asyncio.to_thread(
                    ur_onramp_permit.read_permit_domain,
                    chain_id=int(req.chain_id), token_addr=req.from_token,
                    owner=req.owner_address,
                )
                permit_block = {
                    "token": req.from_token,
                    "spender": spender,
                    "value": str(req.amount),
                    "chain_id": int(req.chain_id),
                    "name": (domain or {}).get("name"),
                    "version": (domain or {}).get("version"),
                    "nonce": (domain or {}).get("nonce"),
                }
            except Exception as exc:  # noqa: BLE001
                logger.warning("retry permit domain read failed: %s", exc)
                permit_block = None
    return {"ur_id": ur_id, "result": result, "permit": permit_block}


class _UrWithdrawRetrySubmitRequest(BaseModel):
    """Re-submit a failed dst swap with a fresh permit (Full-Auth, gasless)."""
    auth: _UrExtAuth
    quote_id: str
    chain_id: int
    original_tx_hash: Optional[str] = None
    usdc_amount: str               # stranded USDC, smallest units
    token_out: str
    min_amount_out: str
    aggregator: str
    swap_calldata: str
    permit_deadline: int
    permit_v: int
    permit_r: str
    permit_s: str


@api_router.post("/ur/withdraw/retry/submit", tags=["ur"])
async def ur_withdraw_retry_submit(
    req: _UrWithdrawRetrySubmitRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Re-execute a failed dst swap (UR `POST /api/v1/onramp-swap-with-permit`, §5.1.7)."""
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    tx_hash = await _resolve_pending_retry_tx_hash(
        ur_id=ur_id, auth=req.auth, hint=req.original_tx_hash,
    )
    try:
        resp = await ur_api.ext_onramp_swap_with_permit_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            quote_id=req.quote_id, chain_id_caip2=f"eip155:{int(req.chain_id)}",
            original_tx_hash=tx_hash, usdc_amount_raw=str(req.usdc_amount),
            token_out=req.token_out, min_amount_out=str(req.min_amount_out),
            aggregator=req.aggregator, swap_calldata=req.swap_calldata,
            permit_deadline=req.permit_deadline, permit_v=req.permit_v,
            permit_r=req.permit_r, permit_s=req.permit_s,
        )
    except ur_api.URError as exc:
        logger.warning("UR retry submit failed for %s: %s", ur_id, exc)
        if _ur_upstream_is_down(exc):
            raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
        raise HTTPException(status_code=502, detail=f"UR retry submit failed: {exc}")
    result = resp.get("result", {}) or {}
    return {"ur_id": ur_id, "result": result, "tx_hash": result.get("txHash")}


# ===========================================================================
# CASH PAY-OUT ("Send") — External Wallet Access §6
# ===========================================================================
# Move a fiat balance out to an external bank account. Same gasless shape as
# the on-ramp/withdraw: the user signs (a) Full-Auth headers and (b) an
# EIP-2612 permit over the fiat token; UR validates + executes clientPayout()
# and pays gas. Recipient setup is a mix of No-Auth reads (banks, cities,
# purposes, fees) and Full-Auth verifies (verify-reference, verify-contact).
#
# Shared blockers with Withdraw on testnet: (1) the account's rolling 30-day
# CHF limit must have headroom (all outgoing fiat counts), and (2) the same
# UR region/account gate may apply at submit. We surface UR's error verbatim
# (the frontend maps it to a clean message) rather than masking it.
# ===========================================================================


# Official Fiat24 "Money Remittance Fees" (C2C payout) limits, as signed in the
# provider contract — 2-dp smallest-unit strings. Used to enrich the live
# fees endpoint, which doesn't reliably return a per-currency MAX. The live
# endpoint still wins for any field it does return; this is the fallback.
_PAYOUT_LIMIT_FALLBACK: Dict[str, Dict[str, str]] = {
    "EUR": {"min": "100", "max": "10776700", "fee": "0"},       # €1 / €107,767 / free
    "CHF": {"min": "100", "max": "10000000", "fee": "0"},       # CHF 1 / 100,000 / free
    "USD": {"min": "10000", "max": "10000000", "fee": "5000"},  # $100 / 100,000 / $50
}


@api_router.get("/ur/payout/config", tags=["ur"])
async def ur_payout_config(auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    """Per-currency payout fee + min/max, and the Mantle chain fiat lives on."""
    await _resolve_caller_urid(auth_user)
    mantle = ur_chain.canonical_mantle_chain()
    try:
        fees_resp = await ur_api.ext_payout_fees_async()
    except ur_api.URError as exc:
        logger.warning("UR payout fees failed: %s", exc)
        raise HTTPException(status_code=503, detail=f"UR payout fees unavailable: {exc}")
    fees = fees_resp.get("result") or {}
    currencies = []
    for code, meta in (fees.items() if isinstance(fees, dict) else []):
        meta = meta or {}
        code_u = str(code).upper()
        fb = _PAYOUT_LIMIT_FALLBACK.get(code_u, {})
        try:
            token = ur_chain.get_fiat_token(mantle, code_u)
        except Exception:  # noqa: BLE001
            token = meta.get("tokenAddress")
        # All amounts are 2-dp smallest-unit strings ("5000" == 50.00). Prefer
        # the live endpoint; fall back to the signed contract limits.
        currencies.append({
            "currency": code_u,
            "token_address": meta.get("tokenAddress") or token,
            "fee": str(meta.get("fee", fb.get("fee", "0"))),
            "min_payout": str(meta.get("minimalPayoutAmount", fb.get("min", "0"))),
            "max_payout": str(
                meta.get("maximalPayoutAmount")
                or meta.get("maxAmount")
                or fb.get("max", "0")
            ),
        })
    return {"mantle_chain_id": mantle, "currencies": currencies}


@api_router.get("/ur/payout/banks", tags=["ur"])
async def ur_payout_banks(auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    """Supported banks + country metadata (incl. `ibanMetadata`)."""
    try:
        resp = await ur_api.ext_payout_banks_async()
    except ur_api.URError as exc:
        raise HTTPException(status_code=503, detail=f"UR banks unavailable: {exc}")
    return {"result": resp.get("result") or []}


@api_router.get("/ur/payout/banks/iban/{iban}", tags=["ur"])
async def ur_payout_bank_by_iban(
    iban: str, auth_user: PrivyAuthUser = Depends(verify_privy_token)
):
    """Resolve bank details from an IBAN.

    UR returns retCode=10009 for unknown/placeholder IBANs (e.g. the §6.2.2
    sandbox example). Treat that as "no match" so the client can collect bank
    name manually instead of surfacing a hard 400.
    """
    try:
        resp = await ur_api.ext_payout_bank_by_iban_async(iban)
    except ur_api.URError as exc:
        msg = str(exc).lower()
        if exc.ur_code == 10009 or "invalid iban" in msg:
            return {"result": None}
        raise HTTPException(status_code=400, detail=f"IBAN lookup failed: {exc}")
    return {"result": resp.get("result") or None}


@api_router.get("/ur/payout/country-cities", tags=["ur"])
async def ur_payout_country_cities(
    auth_user: PrivyAuthUser = Depends(verify_privy_token)
):
    """Supported recipient country/city combinations."""
    try:
        resp = await ur_api.ext_payout_country_cities_async()
    except ur_api.URError as exc:
        raise HTTPException(status_code=503, detail=f"UR country-cities unavailable: {exc}")
    return {"result": resp.get("result") or []}


@api_router.get("/ur/payout/payment-purposes", tags=["ur"])
async def ur_payout_payment_purposes(
    auth_user: PrivyAuthUser = Depends(verify_privy_token)
):
    """Compliance payment-purpose list."""
    try:
        resp = await ur_api.ext_payout_payment_purposes_async()
    except ur_api.URError as exc:
        raise HTTPException(status_code=503, detail=f"UR payment-purposes unavailable: {exc}")
    return {"result": (resp.get("result") or {})}


@api_router.post("/ur/payout/verify-reference", tags=["ur"])
async def ur_payout_verify_reference(
    req: _UrPayoutVerifyReferenceRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Validate a payment reference → {purposeId, refId} (Full-Auth)."""
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_payout_verify_reference_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            reference=req.reference,
        )
    except ur_api.URError as exc:
        raise HTTPException(status_code=400, detail=f"verify-reference failed: {exc}")
    return {"result": resp.get("result") or {}}


@api_router.post("/ur/payout/contacts", tags=["ur"])
async def ur_payout_contacts(
    req: _UrExtAuthOnlyRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """List saved bank-payout beneficiaries (UR ``GET /api/v2/br`` → ``contacts``).

    Partner ``POST /v1/profile`` does not include payout contacts; they only
    live on the wallet-signed banking profile. Returns a flat, normalized list
    for Send / bank-transfer recipient pickers.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_br_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR payout /br contacts failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR payout contacts fetch failed")
    result = resp.get("result") or {}
    contacts_raw = result.get("contacts") if isinstance(result, dict) else None
    return {
        "ur_id": ur_id,
        "contacts": _normalize_payout_contacts(contacts_raw),
    }


@api_router.post("/ur/payout/verify-contact", tags=["ur"])
async def ur_payout_verify_contact(
    req: _UrPayoutVerifyContactRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Validate recipient + bank payload → {contactId, purposeId, refId}."""
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    account_raw = (req.account or "").strip()
    account_clean = "".join(account_raw.split()).upper()
    bank_name = (req.bankName or "").strip()
    if not account_clean:
        raise HTTPException(status_code=400, detail="account is required")
    if not bank_name:
        raise HTTPException(status_code=400, detail="bankName is required")
    # UR docs show spaced IBANs in verify-contact; wire the grouped form when applicable.
    account_wire = account_raw
    if len(account_clean) >= 15 and account_clean[:2].isalpha():
        account_wire = " ".join(account_clean[i:i + 4] for i in range(0, len(account_clean), 4))
    contact = {
        "account": account_wire,
        "bankName": bank_name,
        "bic": (req.bic or "").strip() or None,
        "purpose": req.purpose,
        "reference": req.reference,
        "creditor": req.creditor.model_dump(exclude_none=True),
    }
    contact = {k: v for k, v in contact.items() if v is not None}
    try:
        resp = await ur_api.ext_payout_verify_contact_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            contact=contact,
        )
    except ur_api.URError as exc:
        logger.warning(
            "UR verify-contact failed urid=%s contact_keys=%s err=%s body=%s",
            ur_id, list(contact.keys()), exc, getattr(exc, "body", None),
        )
        raise HTTPException(status_code=400, detail=f"verify-contact failed: {exc}")
    result = resp.get("result") or {}
    logger.info("UR verify-contact raw result urid=%s result=%s", ur_id, result)
    # Normalise ref params — UR may nest or flatten {contactId, purposeId, refId}.
    params = result.get("clientPayoutRefParams")
    contact_id = None
    if isinstance(params, dict):
        contact_id = params.get("contactId") or params.get("id")
    if not contact_id:
        flat_id = result.get("contactId") or result.get("id")
        if flat_id:
            contact_id = flat_id
            result = {
                **result,
                "clientPayoutRefParams": {
                    "contactId": flat_id,
                    "purposeId": result.get("purposeId", result.get("purpose")),
                    "refId": result.get("refId") or result.get("ref"),
                },
            }
    # UR can return retCode=0 (success) yet an empty contact when it cannot
    # resolve the bank/IBAN, or when the sender account is not yet KYC-approved
    # (testnet accounts must be manually moved to `Live`). Surface the exact
    # outbound payload + UR's reply so this is a forwardable diagnostic instead
    # of a vague "couldn't verify".
    if not contact_id:
        sent = {
            "account": account_wire,
            "bankName": bank_name,
            "bic": contact.get("bic"),
            "purpose": req.purpose,
            "reference": req.reference,
            "creditorCountry": req.creditor.country,
            "creditorCity": req.creditor.city,
        }
        logger.warning(
            "UR verify-contact empty contact urid=%s sent=%s result=%s",
            ur_id, sent, result,
        )
        raise HTTPException(
            status_code=422,
            detail=(
                "UR accepted the request (retCode=0) but returned no contactId. "
                "Likely the bank/IBAN is not resolvable in UR's registry, or this "
                "account is not yet KYC-approved (testnet accounts must be moved to "
                f"Live by UR). Sent: {sent}. UR result: {result}"
            ),
        )
    return {"result": result}


@api_router.post("/ur/payout/permit-info", tags=["ur"])
async def ur_payout_permit_info(
    req: _UrPayoutPermitInfoRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Resolve the EIP-2612 permit scaffold for a payout (no funds move).

    Returns token + spender + value + on-chain EIP-712 domain so the frontend
    signs typed data without extra RPC reads — identical shape to the
    withdraw quote's `permit` block.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    link = await _resolve_caller_link(auth_user)
    await _assert_owner_matches_linked_urid(link, req.owner_address)
    network = ur_chain.canonical_mantle_chain()
    caip = f"eip155:{network}"
    try:
        token_addr = ur_chain.get_fiat_token(network, req.currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported currency {req.currency!r}: {exc}")
    try:
        value_raw = str(_to_token_units(req.amount, 2))
        if int(value_raw) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}")

    spender = await _resolve_payout_spender(
        auth=req.auth, ur_id=ur_id, network=network, chain_caip2=caip,
    )

    import ur_onramp_permit
    try:
        domain = await asyncio.to_thread(
            ur_onramp_permit.read_permit_domain,
            chain_id=network, token_addr=token_addr, owner=req.owner_address,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("payout permit domain read failed for %s: %s", token_addr, exc)
        domain = None

    return {
        "ur_id": ur_id,
        "permit": {
            "token": token_addr,
            "spender": spender,
            "value": value_raw,
            "chain_id": network,
            "name": (domain or {}).get("name"),
            "version": (domain or {}).get("version"),
            "nonce": (domain or {}).get("nonce"),
        },
    }


@api_router.post("/ur/payout/execute", tags=["ur"])
async def ur_payout_execute(
    req: _UrPayoutExecuteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Submit a bank payout (External Wallet Access, gasless permit).

    Persists a `payout` job, forwards the permit to UR's
    `/api/v1/payout-with-permit`, records the on-chain tx hash, and lets the
    webhook / lazy reconciler advance the job to `completed`.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    await _assert_ur_ext_auth_binds_caller(auth_user, link, req.auth)
    network = ur_chain.canonical_mantle_chain()

    try:
        token_addr = ur_chain.get_fiat_token(network, req.currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported currency {req.currency!r}: {exc}")
    # TODO(ur-fee): we forward the client's permit_amount verbatim. Today the
    # frontend sends permit_amount == amount (fee assumed DEDUCTED from the
    # sent amount, per UR's doc example). If UR confirms the fee is charged ON
    # TOP, the client should sign permit_amount = amount + fee — no backend
    # change needed, but revisit this comment when that's settled (USD = $50).
    try:
        amount_raw = str(_to_token_units(req.amount, 2))
        permit_amount_raw = str(_to_token_units(req.permit_amount or req.amount, 2))
        if int(amount_raw) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}")

    job = await asyncio.to_thread(
        ur_db.create_job,
        supabase,
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        kind=ur_db.JOB_KIND_PAYOUT,
        source_chain_id=network,
        source_token=req.currency,
        source_amount=str(req.amount),
        target_chain_id=None,
        target_currency=req.currency,
        target_amount=str(req.amount),
        quote_id=str(req.ref) if req.ref else None,
        idempotency_key=req.idempotency_key,
    )
    if job.get("_idempotent_hit"):
        return {"job": _serialise_job(job), "idempotent": True}

    try:
        resp = await ur_api.ext_submit_payout_with_permit_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            amount_raw=amount_raw,
            permit_amount_raw=permit_amount_raw,
            permit_deadline=req.permit_deadline,
            permit_v=req.permit_v,
            permit_r=req.permit_r,
            permit_s=req.permit_s,
            contact_id=req.contact_id,
            token_address=token_addr,
            purpose_id=str(req.purpose_id),
            ref=req.ref,
            metadata=req.metadata,
        )
    except ur_api.URError as exc:
        logger.warning("UR payout submit failed for job %s: %s", job["id"], exc)
        await asyncio.to_thread(
            ur_db.fail_job, supabase, job_id=job["id"],
            error_code="ur_submit_failed", error_message=str(exc),
        )
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {"job": _serialise_job(latest or job), "dispatch_error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("UR payout submit crashed for job %s", job["id"])
        await asyncio.to_thread(
            ur_db.fail_job, supabase, job_id=job["id"],
            error_code="dispatch_crashed", error_message=str(exc),
        )
        raise HTTPException(status_code=500, detail="Payout submit failed")

    tx_hash = ((resp.get("result") or {}).get("txHash") or "").strip().lower()
    if tx_hash and not tx_hash.startswith("0x"):
        tx_hash = "0x" + tx_hash
    extra: Dict[str, Any] = {}
    if tx_hash:
        extra["source_tx_hash"] = tx_hash
    await asyncio.to_thread(
        ur_db.transition_status_atomic,
        supabase,
        job_id=job["id"],
        expected_status=ur_db.JOB_STATUS_CREATED,
        new_status=ur_db.JOB_STATUS_SUBMITTED,
        extra=extra or None,
    )
    latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
    return {
        "job": _serialise_job(latest or job),
        "tx_hash": tx_hash or None,
        "via": "ur_payout_with_permit",
    }


@api_router.post("/ur/transfer/permit-info", tags=["ur"])
async def ur_transfer_permit_info(
    req: _UrTransferPermitInfoRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Resolve the EIP-2612 permit scaffold for a URID-to-URID transfer.

    Unlike payout/on-ramp, the permit ``spender`` is the fiat token contract
    itself (authorising ``transferByAccountId``), not BufferPool or the payout
    relayer.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    link = await _resolve_caller_link(auth_user)
    await _assert_owner_matches_linked_urid(link, req.owner_address)
    to_account_id = str(req.to_account_id or "").strip()
    if not to_account_id.isdigit():
        raise HTTPException(status_code=400, detail="to_account_id must be a numeric URID")
    if int(to_account_id) == int(ur_id):
        raise HTTPException(status_code=400, detail="Cannot transfer to your own Account ID")
    network = ur_chain.canonical_mantle_chain()
    try:
        token_addr = ur_chain.get_fiat_token(network, req.currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported currency {req.currency!r}: {exc}")
    try:
        value_raw = str(_to_token_units(req.amount, 2))
        if int(value_raw) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}")

    import ur_onramp_permit
    try:
        domain = await asyncio.to_thread(
            ur_onramp_permit.read_permit_domain,
            chain_id=network, token_addr=token_addr, owner=req.owner_address,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("transfer permit domain read failed for %s: %s", token_addr, exc)
        domain = None

    return {
        "ur_id": ur_id,
        "recipient_binding": _issue_transfer_recipient_binding(
            privy_user_id=auth_user.user_id,
            to_account_id=to_account_id,
            currency=req.currency,
            amount=req.amount,
            owner_address=req.owner_address,
        ),
        "permit": {
            "token": token_addr,
            "spender": token_addr,
            "value": value_raw,
            "chain_id": network,
            "name": (domain or {}).get("name"),
            "version": (domain or {}).get("version"),
            "nonce": (domain or {}).get("nonce"),
        },
    }


@api_router.post("/ur/transfer/execute", tags=["ur"])
async def ur_transfer_execute(
    req: _UrTransferExecuteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Submit a URID-to-URID fiat transfer (External Wallet Access, gasless permit).

    Persists a ``transfer`` job, forwards the permit to UR's
    ``/api/v1/transfer-with-permit``, records the on-chain tx hash, and lets
    the webhook / lazy reconciler advance the job to ``completed``.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    await _assert_ur_ext_auth_binds_caller(auth_user, link, req.auth)
    network = ur_chain.canonical_mantle_chain()

    to_account_id = str(req.to_account_id or "").strip()
    if not to_account_id.isdigit():
        raise HTTPException(status_code=400, detail="to_account_id must be a numeric URID")
    if int(to_account_id) == int(ur_id):
        raise HTTPException(status_code=400, detail="Cannot transfer to your own Account ID")

    owner_address = link.get("evm_address") or await _fetch_urid_owner_address(ur_id)
    if not owner_address:
        raise HTTPException(
            status_code=409,
            detail="Cannot verify UR account owner. Re-link your account.",
        )
    _assert_transfer_recipient_binding(
        binding=req.recipient_binding,
        privy_user_id=auth_user.user_id,
        to_account_id=to_account_id,
        currency=req.currency,
        amount=req.amount,
        owner_address=owner_address,
    )

    try:
        token_addr = ur_chain.get_fiat_token(network, req.currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported currency {req.currency!r}: {exc}")
    try:
        amount_raw = str(_to_token_units(req.amount, 2))
        permit_amount_raw = str(_to_token_units(req.permit_amount or req.amount, 2))
        if int(amount_raw) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}")

    job = await asyncio.to_thread(
        ur_db.create_job,
        supabase,
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        kind=ur_db.JOB_KIND_TRANSFER,
        source_chain_id=network,
        source_token=req.currency,
        source_amount=str(req.amount),
        target_chain_id=None,
        target_currency=req.currency,
        target_amount=str(req.amount),
        quote_id=to_account_id,
        idempotency_key=req.idempotency_key,
    )
    if job.get("_idempotent_hit"):
        return {"job": _serialise_job(job), "idempotent": True}

    try:
        resp = await ur_api.ext_submit_transfer_with_permit_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            to_account_id=to_account_id,
            token_address=token_addr,
            amount_raw=amount_raw,
            permit_amount_raw=permit_amount_raw,
            permit_deadline=req.permit_deadline,
            permit_v=req.permit_v,
            permit_r=req.permit_r,
            permit_s=req.permit_s,
        )
    except ur_api.URError as exc:
        logger.warning("UR transfer submit failed for job %s: %s", job["id"], exc)
        await asyncio.to_thread(
            ur_db.fail_job, supabase, job_id=job["id"],
            error_code="ur_submit_failed", error_message=str(exc),
        )
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {"job": _serialise_job(latest or job), "dispatch_error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("UR transfer submit crashed for job %s", job["id"])
        await asyncio.to_thread(
            ur_db.fail_job, supabase, job_id=job["id"],
            error_code="dispatch_crashed", error_message=str(exc),
        )
        raise HTTPException(status_code=500, detail="Transfer submit failed")

    tx_hash = ((resp.get("result") or {}).get("txHash") or "").strip().lower()
    if tx_hash and not tx_hash.startswith("0x"):
        tx_hash = "0x" + tx_hash
    extra: Dict[str, Any] = {}
    if tx_hash:
        extra["source_tx_hash"] = tx_hash
    await asyncio.to_thread(
        ur_db.transition_status_atomic,
        supabase,
        job_id=job["id"],
        expected_status=ur_db.JOB_STATUS_CREATED,
        new_status=ur_db.JOB_STATUS_SUBMITTED,
        extra=extra or None,
    )
    latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
    try:
        await asyncio.to_thread(
            ur_db.touch_p2p_recipient,
            supabase,
            privy_user_id=auth_user.user_id,
            recipient_ur_id=int(to_account_id),
        )
    except Exception:  # noqa: BLE001
        pass  # saved-recipient bookkeeping is best-effort
    return {
        "job": _serialise_job(latest or job),
        "tx_hash": tx_hash or None,
        "via": "ur_transfer_with_permit",
    }


def _serialise_p2p_recipient(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(row.get("id") or ""),
        "recipient_ur_id": int(row.get("recipient_ur_id") or 0),
        "label": row.get("label") or "",
        "created_at": row.get("created_at"),
        "last_used_at": row.get("last_used_at"),
    }


@api_router.get("/ur/transfer/recipients", tags=["ur"])
async def ur_transfer_recipients_list(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """List saved HyperTrade P2P recipients for the caller."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    rows = await asyncio.to_thread(
        ur_db.list_p2p_recipients,
        supabase,
        privy_user_id=auth_user.user_id,
    )
    return {"recipients": [_serialise_p2p_recipient(r) for r in rows]}


@api_router.post("/ur/transfer/recipients", tags=["ur"])
async def ur_transfer_recipients_save(
    req: _UrTransferRecipientSaveRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Create or update a saved P2P recipient (label + URID).

    Upsert on (privy_user_id, recipient_ur_id) is safe under concurrent
    replicas — Postgres resolves the race via the unique index.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    ur_id = await _resolve_caller_urid(auth_user)
    recipient_raw = str(req.recipient_ur_id or "").strip()
    if not recipient_raw.isdigit():
        raise HTTPException(status_code=400, detail="recipient_ur_id must be a numeric Account ID")
    recipient_ur_id = int(recipient_raw)
    if recipient_ur_id == int(ur_id):
        raise HTTPException(status_code=400, detail="Cannot save your own Account ID")
    label = (req.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    if len(label) > 64:
        raise HTTPException(status_code=400, detail="label must be at most 64 characters")
    try:
        row = await asyncio.to_thread(
            ur_db.upsert_p2p_recipient,
            supabase,
            privy_user_id=auth_user.user_id,
            recipient_ur_id=recipient_ur_id,
            label=label,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"recipient": _serialise_p2p_recipient(row)}


@api_router.delete("/ur/transfer/recipients/{recipient_id}", tags=["ur"])
async def ur_transfer_recipients_delete(
    recipient_id: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Remove one saved P2P recipient owned by the caller."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    removed = await asyncio.to_thread(
        ur_db.delete_p2p_recipient,
        supabase,
        privy_user_id=auth_user.user_id,
        recipient_id=recipient_id,
    )
    if not removed:
        raise HTTPException(status_code=404, detail="Recipient not found")
    return {"ok": True}


# ===========================================================================
# MINT (URID) — lazy, idempotent URID provisioning at banking/KYC entry
# ===========================================================================
# A URID (Fiat24Account NFT) must EXIST on-chain before KYC can start —
# `/v1/create-access-token-by-network` requires a `tokenId` whose on-chain
# `walletProvider(tokenId)` matches our partner id; it does NOT auto-mint.
#
# All our users sign up via Privy. We mint lazily the first time a user enters
# the banking/KYC flow (not at signup — avoids an on-chain NFT + UR user record
# for accounts that never bank). Flow:
#
#   1. POST /ur/mint/prepare  → resolves idempotency (existing link / on-chain
#      NFT for the EOA) OR returns the exact EIP-191 message to sign.
#   2. Client signs that message SILENTLY with the Privy embedded EOA.
#   3. POST /ur/mint          → verifies the signature recovers to the EOA +
#      Privy owns it, calls partner-signed `/v1/mint/nft`, persists the link.
#
# Mint signature spec (UR): baseMessage = hash + deadline (string concat);
# finalMessage = "I agree to access my profile. " + keccak256(baseMessage).hex.
# ===========================================================================

# Deadline window for the mint signature (UR caps this at 300s). We hand the
# client a fresh ~4-minute window; submit re-validates freshness.
_UR_MINT_DEADLINE_WINDOW_SECONDS = 240
# Accept a submitted deadline this far in the future at most (defends against a
# client minting a far-future-dated signature it could replay later).
_UR_MINT_DEADLINE_MAX_SKEW_SECONDS = 360
_UR_MINT_MESSAGE_PREFIX = "I agree to access my profile. "


def _build_mint_message(hash_seed: str, deadline: int) -> str:
    """Reconstruct UR's mint finalMessage from (hash, deadline).

    Must byte-match `ur_mint_test_urid._build_user_signature` and UR's own
    server-side reconstruction, else the recovered signer won't match.
    """
    base_message = f"{hash_seed}{deadline}"
    intermediate_hash_hex = Web3.to_hex(Web3.keccak(text=base_message))
    return f"{_UR_MINT_MESSAGE_PREFIX}{intermediate_hash_hex}"


async def _persist_urid_link(
    *, privy_user_id: str, ur_id: int, evm_address: str, source: str
) -> Dict[str, Any]:
    """Upsert the (privy_user -> URID) link, mapping conflicts to a clean 409."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    try:
        return await asyncio.to_thread(
            ur_db.upsert_link,
            supabase,
            privy_user_id=privy_user_id,
            ur_id=int(ur_id),
            evm_address=evm_address,
            source=source,
        )
    except ur_db.URLinkConflict:
        raise HTTPException(
            status_code=409,
            detail="This UR account is already linked to a different user.",
        )


class _UrMintPrepareRequest(BaseModel):
    """Kick off (or short-circuit) a URID mint for the caller's Privy EOA."""
    evm_address: str


class _UrMintSubmitRequest(BaseModel):
    """Finalize a URID mint with the user's EIP-191 signature."""
    evm_address: str
    email: str
    signature: str
    hash: str
    deadline: int


@api_router.post("/ur/mint/prepare", tags=["ur"])
async def ur_mint_prepare(
    req: _UrMintPrepareRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Resolve idempotency and, if a mint is actually needed, return the
    EIP-191 message the client must sign with its Privy embedded wallet.

    Returns ``{already_minted: true, ur_id}`` when the caller already has a
    URID (linked OR on-chain), so the client skips signing entirely.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")

    # 1. Already linked? Nothing to mint.
    link = await asyncio.to_thread(
        ur_db.get_link_by_privy_user, supabase, auth_user.user_id
    )
    if link and link.get("ur_id") is not None:
        return {"already_minted": True, "ur_id": int(link["ur_id"])}

    evm_address = (req.evm_address or "").strip()
    if not Web3.is_address(evm_address):
        raise HTTPException(status_code=400, detail="Invalid evm_address")
    evm_address = Web3.to_checksum_address(evm_address)

    # Ownership gate: the EOA we mint to must belong to the caller's Privy
    # account. Fail closed on an explicit negative; tolerate None (lookup
    # unavailable / dev without PRIVY_APP_SECRET) — UR still verifies the user
    # signature, which only the EOA owner can produce.
    owns = await _privy_user_owns_eth_address(auth_user.user_id, evm_address)
    if owns is False:
        raise HTTPException(
            status_code=403,
            detail="This wallet does not belong to your account.",
        )

    # 2. On-chain pre-check (UR requires this before mint): does the EOA
    # already own a URID? If so, adopt it instead of minting a duplicate.
    chain = ur_chain.canonical_mantle_chain()
    existing_urid = await asyncio.to_thread(
        ur_chain.read_urid_for_address, chain, evm_address
    )
    if existing_urid:
        await _persist_urid_link(
            privy_user_id=auth_user.user_id,
            ur_id=int(existing_urid),
            evm_address=evm_address,
            source="import",
        )
        return {"already_minted": True, "ur_id": int(existing_urid)}

    # 3. Build the signing payload. `hash` is a unique seed; `deadline` bounds
    # the signature's validity. Both are echoed back verbatim on submit.
    now = int(time.time())
    deadline = now + _UR_MINT_DEADLINE_WINDOW_SECONDS
    hash_seed = f"hypertrade-mint-{evm_address.lower()}-{now}-{secrets.token_hex(4)}"
    return {
        "already_minted": False,
        "evm_address": evm_address,
        "email_required": True,
        "hash": hash_seed,
        "deadline": deadline,
        "message": _build_mint_message(hash_seed, deadline),
    }


@api_router.post("/ur/mint", tags=["ur"])
async def ur_mint_submit(
    req: _UrMintSubmitRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Mint the URID using the user's wallet signature, then persist the link.

    Idempotent: re-checks the link + on-chain ownership before minting and
    treats UR's `10005 Duplicate Mint` as "already minted".
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")

    # Idempotency: minted between prepare and submit?
    link = await asyncio.to_thread(
        ur_db.get_link_by_privy_user, supabase, auth_user.user_id
    )
    if link and link.get("ur_id") is not None:
        return {"already_minted": True, "ur_id": int(link["ur_id"])}

    evm_address = (req.evm_address or "").strip()
    if not Web3.is_address(evm_address):
        raise HTTPException(status_code=400, detail="Invalid evm_address")
    evm_address = Web3.to_checksum_address(evm_address)

    email = (req.email or "").strip()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required to mint")

    # Deadline must be fresh (not expired, not absurdly far out).
    now = int(time.time())
    if req.deadline <= now:
        raise HTTPException(status_code=400, detail="Mint request expired — try again")
    if req.deadline > now + _UR_MINT_DEADLINE_MAX_SKEW_SECONDS:
        raise HTTPException(status_code=400, detail="Mint deadline is too far in the future")

    # Verify the EIP-191 signature recovers to the EOA being minted (defense in
    # depth — UR validates this too, but we fail fast on a mismatch).
    from eth_account import Account as _Account
    from eth_account.messages import encode_defunct as _encode_defunct

    message = _build_mint_message(req.hash, req.deadline)
    try:
        recovered = _Account.recover_message(
            _encode_defunct(text=message), signature=req.signature
        )
    except Exception as exc:  # noqa: BLE001 — malformed signature
        raise HTTPException(status_code=400, detail=f"Invalid signature: {exc}")
    if not _addr_eq(recovered, evm_address):
        raise HTTPException(
            status_code=400,
            detail="Signature does not match the wallet being minted.",
        )

    # Ownership gate (same policy as prepare).
    owns = await _privy_user_owns_eth_address(auth_user.user_id, evm_address)
    if owns is False:
        raise HTTPException(
            status_code=403,
            detail="This wallet does not belong to your account.",
        )

    chain = ur_chain.canonical_mantle_chain()

    # Re-run the on-chain pre-check; adopt an existing URID rather than mint.
    existing_urid = await asyncio.to_thread(
        ur_chain.read_urid_for_address, chain, evm_address
    )
    if existing_urid:
        await _persist_urid_link(
            privy_user_id=auth_user.user_id,
            ur_id=int(existing_urid),
            evm_address=evm_address,
            source="import",
        )
        return {"already_minted": True, "ur_id": int(existing_urid)}

    # Partner-signed mint.
    try:
        resp = await ur_api.mint_urid_async(
            email=email,
            evm_address=evm_address,
            signature=req.signature,
            hash_seed=req.hash,
            deadline=req.deadline,
        )
    except ur_api.URError as exc:
        # Duplicate mint — the EOA already owns a URID (race or stale check).
        if getattr(exc, "ur_code", None) == 10005:
            adopted = await asyncio.to_thread(
                ur_chain.read_urid_for_address, chain, evm_address
            )
            if adopted:
                await _persist_urid_link(
                    privy_user_id=auth_user.user_id,
                    ur_id=int(adopted),
                    evm_address=evm_address,
                    source="import",
                )
                return {"already_minted": True, "ur_id": int(adopted)}
        logger.warning("UR mint failed for %s: %s", auth_user.user_id, exc)
        if _ur_upstream_is_down(exc):
            raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
        raise HTTPException(status_code=502, detail=f"Mint failed: {exc}")

    data = resp.get("data") or {}
    token_id = data.get("tokenId")
    tx_hash = data.get("txHash")
    if not token_id:
        logger.error("UR mint returned no tokenId for %s: %s", auth_user.user_id, resp)
        raise HTTPException(status_code=502, detail="UR did not return a tokenId")

    await _persist_urid_link(
        privy_user_id=auth_user.user_id,
        ur_id=int(token_id),
        evm_address=evm_address,
        source="mint",
    )
    return {"already_minted": False, "ur_id": int(token_id), "tx_hash": tx_hash}


# ===========================================================================
# KYC (Sumsub) — self-serve identity verification via wallet Full-Auth
# ===========================================================================
# Proven 2026-05-31: UR's Client-side KYC endpoints accept the SAME wallet
# Full-Auth headers we already sign (NOT the partner Nacos whitelist that
# `/v1/create-access-token-by-network` requires). So we can launch/continue
# Sumsub KYC from our app with just the user's signature.
#
# NOTE: the actual NFC identity scan only works in the Sumsub *mobile* SDK
# (not web). The token issues only once UR has created a KYC flow for the URID
# (a freshly minted test URID returns "user kyc flow not found").
# ===========================================================================


@api_router.post("/ur/kyc/status", tags=["ur"])
async def ur_kyc_status(
    req: _UrKycStatusRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return the user's account + KYC flow state for gating the UI."""
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_account_status_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR account-status failed for %s: %s", ur_id, exc)
        raise HTTPException(status_code=503, detail=f"KYC status unavailable: {exc}")
    result = resp.get("result")
    if not isinstance(result, dict):
        result = {}
    kyc_flow = result.get("kycFlow") or {}
    sumsub = result.get("sumsubKycInfo") or {}
    review_answer = sumsub.get("reviewAnswer")
    review_reject_type = sumsub.get("reviewRejectType") or ""

    # account-status carries reviewAnswer/reviewRejectType but NOT the granular
    # reject labels (e.g. "BAD_PROOF_OF_ADDRESS"). Only the partner
    # /v1/sumsub-status-by-network exposes those, so on a RED result we make a
    # best-effort partner read to tell the user exactly what to fix. Failure
    # here must never break the gate read — we just omit the labels.
    reject_labels: List[str] = []
    level_name: Optional[str] = None
    if str(review_answer or "").upper() == "RED":
        try:
            ss = await asyncio.to_thread(ur_api.get_kyc_status, ur_id, str(network))
            ss_data = ss.get("data") if isinstance(ss.get("data"), dict) else {}
            labels = ss_data.get("rejectLabels")
            if isinstance(labels, list):
                reject_labels = [str(x) for x in labels if x]
            level_name = ss_data.get("levelName")
            if not review_reject_type:
                review_reject_type = ss_data.get("reviewRejectType") or ""
        except Exception as exc:  # noqa: BLE001 — labels are best-effort
            logger.info("UR sumsub reject-labels lookup failed for %s: %s", ur_id, exc)

    # Analytics mirror only — does not affect this response or any KYC gate.
    await _mirror_ur_kyc_fields(
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        chain_status=result.get("status"),
        kyc_current_step=kyc_flow.get("currentStep"),
    )
    return {
        "ur_id": ur_id,
        "status": result.get("status"),
        "status_str": result.get("statusStr"),
        "kyc_step": kyc_flow.get("currentStep"),
        "kyc_step_str": kyc_flow.get("currentStepStr"),
        "kyc_action_types": kyc_flow.get("currentStepActionTypes") or [],
        "kyc_fail_reason": kyc_flow.get("failReason") or "",
        "sumsub": {
            "user_id": sumsub.get("userId"),
            "completed": sumsub.get("latestKycHasCompleted"),
            "review_status": sumsub.get("reviewStatus"),
            "review_answer": review_answer,
            # "RETRY" (user can resubmit) vs "FINAL" (permanent rejection).
            "review_reject_type": review_reject_type,
            # Granular reasons + Sumsub level, when the review came back RED.
            "reject_labels": reject_labels,
            "level_name": level_name,
        },
        "crs_info": result.get("crsInfo"),
    }


@api_router.post("/ur/kyc/sumsub-token", tags=["ur"])
async def ur_kyc_sumsub_token(
    req: _UrSumsubTokenRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Mint a Sumsub SDK access token (``act-…``) to run/continue KYC.

    Uses the PARTNER bootstrap endpoint ``/v1/create-access-token-by-network``
    (server-signed, {tokenId, network}). The wallet-full-auth variant
    ``/api/v1/sumsub/create-access-token`` was the original wiring but it
    requires a PRE-EXISTING KYC flow and returns retCode=10000 'user kyc flow
    not found for urId' for a fresh URID — so it can't bootstrap a first-time
    user. The by-network partner endpoint creates/mints directly (proven for
    QA URID 5448769923), so the client no longer needs to pre-sign Full-Auth
    just to start KYC.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_sumsub_token_by_network_async(urid=ur_id, network=network)
    except ur_api.URError as exc:
        logger.warning("UR sumsub token (by-network) failed for %s: %s", ur_id, exc)
        raise HTTPException(status_code=409, detail=f"Sumsub token unavailable: {exc}")
    # Partner envelope: {code, message, data:{token,...}}. Accept `result` too
    # in case a gateway normalises it.
    data = resp.get("data")
    if not isinstance(data, dict):
        data = resp.get("result") if isinstance(resp.get("result"), dict) else {}
    token = data.get("token") or data.get("accessToken")
    if not token:
        raise HTTPException(status_code=502, detail="UR returned no Sumsub token")
    return {"ur_id": ur_id, "token": token, "user_id": data.get("userId")}


class _UrFormASubmitRequest(BaseModel):
    """Submit a signed Form A (KYC step 3 → Review). Full-Auth + signed text."""
    auth: _UrExtAuth
    # The exact kycSelfDec text returned by /ur/kyc/form-a (unmodified).
    text: str
    # EIP-191 personal_sign of `text` by the URID-owning wallet (65-byte hex).
    signature: str


@api_router.post("/ur/kyc/form-a", tags=["ur"])
async def ur_kyc_form_a(
    req: _UrKycStatusRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Fetch the Form A declaration text the user must sign (KYC step 3).

    Only meaningful once Sumsub is GREEN and ``kyc_step == 3`` (SignFormA).
    Returns the exact ``text`` to personal_sign — the frontend must submit it
    back byte-for-byte via ``/ur/kyc/form-a/submit``.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_kyc_form_a_info_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR form-a-info failed for %s: %s", ur_id, exc)
        raise HTTPException(status_code=409, detail=f"Form A unavailable: {exc}")
    result = resp.get("result")
    if not isinstance(result, dict):
        result = {}
    text = result.get("kycSelfDec") or ""
    if not text:
        raise HTTPException(status_code=502, detail="UR returned no Form A text")
    return {"ur_id": ur_id, "text": text}


@api_router.post("/ur/kyc/form-a/submit", tags=["ur"])
async def ur_kyc_form_a_submit(
    req: _UrFormASubmitRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Submit the signed Form A — the final KYC action (step 3 → Review).

    On success UR advances the flow to step 4 (Review); Tourist→Live still
    arrives asynchronously via the ``kyc_status`` webhook. We do NOT mark the
    user Live here.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    if not req.text or not req.signature:
        raise HTTPException(status_code=400, detail="Form A text and signature are required")

    # Independent audit: recover the signer from (text, signature) ourselves and
    # confirm it is the URID-owning wallet. This is our OWN cryptographic proof
    # the correct user signed — separate from UR's acceptance — and gives a
    # permanent log line to answer "did this user really sign?" after the fact.
    signer = ur_api.recover_personal_sign(req.text, req.signature)
    owner: Optional[str] = None
    if supabase:
        try:
            link = await asyncio.to_thread(ur_db.get_link_by_ur_id, supabase, int(ur_id))
            owner = (link or {}).get("evm_address")
        except Exception:
            owner = None
    if signer and owner and signer.lower() == str(owner).lower():
        logger.info("UR form-a signer VERIFIED for URID %s: %s", ur_id, signer)
    elif signer:
        logger.warning(
            "UR form-a signer MISMATCH for URID %s: recovered=%s expected_owner=%s",
            ur_id, signer, owner,
        )
    else:
        logger.warning("UR form-a signature unrecoverable for URID %s", ur_id)

    try:
        await ur_api.ext_kyc_submit_form_a_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            kyc_self_dec=req.text, kyc_self_dec_sign=req.signature,
        )
    except ur_api.URError as exc:
        logger.warning("UR submit-form-a failed for %s: %s", ur_id, exc)
        raise HTTPException(status_code=409, detail=f"Form A submission failed: {exc}")
    logger.info("UR submit-form-a OK for URID %s (signer=%s)", ur_id, signer)
    return {"ur_id": ur_id, "submitted": True}


# ===========================================================================
# CARD (External Wallet Access §3.1) — debit card on the user's UR fiat balance
# ===========================================================================
# Card spend ALWAYS settles on Mantle against the user's UR fiat balance
# (USD24/EUR24/CHF24), so every call here uses `network = canonical Mantle
# chain` and the EIP-2612 permit is signed over a Mantle fiat token. In
# Fiat-Only Card Mode (debitCard="MSTD") UR runs the swipe authorization
# on-chain against that balance; the partner is NOT in the auth path — we
# just (a) surface eligibility/status and (b) forward the user's signed
# `/api/v1/token-permit` so UR's card contract can debit the fiat token on swipe.
#
# Endpoints are POST + `{auth}` body (mirrors the KYC/withdraw pattern): the
# frontend signs Full-Auth once and we forward it as headers, calling UR's
# GET or POST under the hood. All are KYC-gated UR-side (they 404 from Fiat24
# until the URID is Live) — wired now so they work the moment KYC lands.
#
# Spender = UR's on-chain card-auth contract on Mantle (Marqeta settlement).
# Testnet 0x25d66C564532258eD9cdBB6215E260AFf41d8bae (confirmed active, proxy
# impl upgraded 2026-05-12). Resolved dynamically from chain-config with an
# env override + ur_chain fallback so a UR redeploy never needs an app push.
# ---------------------------------------------------------------------------


class _UrCardAuthRequest(BaseModel):
    """Read card eligibility / status (Full-Auth)."""
    auth: _UrExtAuth


class _UrCardPermitPrepareRequest(BaseModel):
    """Build the EIP-2612 permit the user must sign to enable card spend."""
    auth: _UrExtAuth
    currency: str                 # "USD" / "EUR" / "CHF" (the fiat the card debits)
    amount: str                   # decimal major-units string, e.g. "100.00"
    owner_address: str            # URID-owner EOA (permit owner / signer)


class _UrCardPermitSubmitRequest(BaseModel):
    """Forward the user's signed EIP-2612 permit to UR (`/api/v1/token-permit`)."""
    auth: _UrExtAuth
    currency: str
    permit: _UrPermit             # owner, spender, value, deadline, v, r, s
                                  # (owner/spender used for local checks; UR body
                                  # only gets address + amount + permit* fields)


_CARD_SPENDER_DEFAULTS = {
    "testnet": "0x25d66C564532258eD9cdBB6215E260AFf41d8bae",
    "mainnet": "0xb9d38DDE25f67D57af5b91C254F869F90d483d05",
}


async def _resolve_card_spender(
    *, auth: "_UrExtAuth", ur_id: int, network: int, chain_caip2: str,
) -> str:
    """Resolve the on-chain card-auth spender (EIP-2612 permit target).

    Resolution order (first hit wins) so a UR contract move never needs a
    release:
      1. ``UR_CARD_SPENDER_{TESTNET,MAINNET}`` env override.
      2. UR chain-config card-ish keys for this chain.
      3. ur_chain's documented CardAuthSpender for the env.
    """
    env_suffix = "TESTNET" if ur_chain.is_testnet_env() else "MAINNET"
    override = (os.getenv(f"UR_CARD_SPENDER_{env_suffix}", "") or "").strip()
    if override:
        return override
    try:
        cfg = await ur_api.ext_chain_configs_async(
            urid=ur_id, network=network,
            auth_hash=auth.hash, auth_deadline=auth.deadline, auth_sign=auth.sign,
        )
        for ch in ((cfg.get("result") or {}).get("chains") or []):
            if str(ch.get("chainIdentifier", "")).lower() != chain_caip2.lower():
                continue
            for key in (
                "cardSpenderContract", "cardAuthContract", "marqetaSpender",
                "cardContract", "spenderContract",
            ):
                val = ch.get(key)
                if val:
                    return str(val)
            break
    except Exception as exc:  # noqa: BLE001 — fall through to the default
        logger.warning("card spender chain-config lookup failed: %s", exc)
    try:
        return ur_chain.get_card_auth_spender(network)
    except Exception:  # noqa: BLE001
        return _CARD_SPENDER_DEFAULTS["testnet" if ur_chain.is_testnet_env() else "mainnet"]


@api_router.post("/ur/card/eligibility", tags=["ur"])
async def ur_card_eligibility(
    req: _UrCardAuthRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Banking profile + card eligibility (UR `/api/v2/br`).

    Surfaces `debitCard` brand (MSTD=Fiat-Only, MSTC=Crypto-Backed),
    `isCardEligible`, existing `cards[]`, `cardActivation` fee, and `limits`.
    Also returns `permit_targets` (Mantle network + card spender + fiat token
    addresses) so the client can prep the spend permit without extra calls.
    404s from Fiat24 until the URID is KYC-Live.
    """
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    network = ur_chain.canonical_mantle_chain()
    chain_caip2 = f"eip155:{network}"
    await _log_card_full_auth_context(
        op="eligibility",
        auth_user=auth_user,
        ur_id=ur_id,
        network=network,
        auth=req.auth,
        link=link,
    )
    try:
        resp = await ur_api.ext_br_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR card /br failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR card eligibility fetch failed")

    spender = await _resolve_card_spender(
        auth=req.auth, ur_id=ur_id, network=network, chain_caip2=chain_caip2,
    )
    tokens: Dict[str, Optional[str]] = {}
    for ccy in ("USD", "EUR", "CHF", "CNH", "GBP", "JPY", "SGD", "HKD"):
        try:
            tokens[ccy] = ur_chain.get_fiat_token(network, ccy)
        except (ValueError, KeyError):
            tokens[ccy] = None
    return {
        "ur_id": ur_id,
        "result": resp.get("result", {}) or {},
        "permit_targets": {
            "network": network,
            "chain_id_caip2": chain_caip2,
            "card_spender": spender,
            "fiat_tokens": tokens,
        },
    }


@api_router.post("/ur/card/status", tags=["ur"])
async def ur_card_status(
    req: _UrCardAuthRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Full card metadata + ``cardToken`` (UR `/api/v2/card`).

    The `cardToken` initialises the secure fiat24card.js view that reveals
    PAN/CVV. 404s until a card has been issued for the URID.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_card_get_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR card /card failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR card status fetch failed")
    # The Fiat24 forwarding base returns the card object UNWRAPPED (top-level
    # masked/cardHolder/tokenId/limits/…), not under a `result` envelope. Prefer
    # `result`/`data` when present, else strip the {retCode,retMsg,timeNow}
    # envelope keys and return the card body as-is.
    _envelope = {"retCode", "retMsg", "timeNow", "code", "message", "result", "data"}
    result = resp.get("result")
    if not isinstance(result, dict) or not result:
        data = resp.get("data")
        if isinstance(data, dict) and data:
            result = data
        else:
            result = {k: v for k, v in resp.items() if k not in _envelope}
    return {"ur_id": ur_id, "result": result}


@api_router.post("/ur/card/create", tags=["ur"])
async def ur_card_create(
    req: _UrCardAuthRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Issue a new virtual card (UR `POST /api/v2/card`, spec §3.1.2).

    UR-side preconditions: URID is KYC-Live, `isCardEligible=true`, no existing
    card, and the UR fiat balance covers `cardActivation.{amount,currency}`
    (read these from `/ur/card/eligibility` first). The request body is empty —
    UR debits the activation fee from that balance. Until those hold UR returns
    the Fiat24 gate error (mapped to a read error here).

    NOTE: Card APIs are MAINNET-ONLY per UR — on testnet this returns the gate
    error even for a Live URID. Wired now so it works the moment we go mainnet.
    """
    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    network = ur_chain.canonical_mantle_chain()
    await _log_card_full_auth_context(
        op="create",
        auth_user=auth_user,
        ur_id=ur_id,
        network=network,
        auth=req.auth,
        link=link,
    )
    try:
        resp = await ur_api.ext_card_create_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
        )
    except ur_api.URError as exc:
        logger.warning("UR card create failed for %s: %s", ur_id, exc)
        if _ur_upstream_is_down(exc):
            raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
        _raise_ur_read_error(exc, "UR card creation failed")
    return {"ur_id": ur_id, "result": resp.get("result", {}) or {}}


@api_router.post("/ur/card/permit/prepare", tags=["ur"])
async def ur_card_permit_prepare(
    req: _UrCardPermitPrepareRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return the EIP-2612 permit block the user signs to enable card spend.

    Resolves the Mantle fiat token for `currency`, the card-auth spender, the
    permit `value` (2-dp smallest units), and reads the token's EIP-712 domain
    + nonce on-chain — everything the wallet needs to sign typed data. The
    signed result is then POSTed to `/ur/card/permit`.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    chain_caip2 = f"eip155:{network}"
    try:
        token_addr = ur_chain.get_fiat_token(network, req.currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported currency {req.currency!r}: {exc}")
    try:
        value = str(_to_token_units(req.amount, 2))
        if int(value) <= 0:
            raise ValueError("amount must be positive")
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}")

    spender = await _resolve_card_spender(
        auth=req.auth, ur_id=ur_id, network=network, chain_caip2=chain_caip2,
    )
    import ur_onramp_permit
    try:
        domain = await asyncio.to_thread(
            ur_onramp_permit.read_permit_domain,
            chain_id=network, token_addr=token_addr, owner=req.owner_address,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("card permit domain read failed for %s: %s", token_addr, exc)
        raise HTTPException(status_code=502, detail=f"Could not read permit domain: {exc}")

    return {
        "ur_id": ur_id,
        "permit": {
            "token": token_addr,
            "spender": spender,
            "value": value,
            "chain_id": network,
            "name": (domain or {}).get("name"),
            "version": (domain or {}).get("version"),
            "nonce": (domain or {}).get("nonce"),
        },
    }


@api_router.post("/ur/card/permit", tags=["ur"])
async def ur_card_permit_submit(
    req: _UrCardPermitSubmitRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Forward the user's signed EIP-2612 permit to UR (`/api/v1/token-permit`).

    UR records (and may relay) the approval so its card contract can debit the
    Mantle fiat token on each swipe — no on-chain `approve` from the user.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        token_addr = ur_chain.get_fiat_token(network, req.currency)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported currency {req.currency!r}: {exc}")
    # permit.value is the EIP-2612 signed amount (2-dp smallest units). Docs
    # require both `amount` and `permitAmount`; for card spend enable they
    # match (same convention as payout-with-permit).
    value = str(req.permit.value)
    try:
        resp = await ur_api.ext_permit_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            token_address=token_addr,
            amount=value,
            permit_amount=value,
            permit_deadline=req.permit.deadline,
            v=req.permit.v, r=req.permit.r, s=req.permit.s,
        )
    except ur_api.URError as exc:
        # retCode=10011 "exists Allowance" = already permitted for this
        # owner/spender. Idempotent success — do not 502 or the client will
        # re-sign / re-submit and hit UR rate limits (10016).
        msg = str(exc).lower()
        if getattr(exc, "ur_code", None) == 10011 or "exists allowance" in msg:
            logger.info(
                "UR card /token-permit already allowed for %s (%s)", ur_id, req.currency,
            )
            return {
                "ur_id": ur_id,
                "result": {"status": 200, "already": True},
                "tx_hash": None,
                "already": True,
            }
        # Rate-limit: stop the client from treating this like a hard outage and
        # immediately retrying (which made View spam UR).
        if getattr(exc, "ur_code", None) == 10016 or "too frequent" in msg:
            logger.info("UR card /token-permit rate-limited for %s", ur_id)
            raise HTTPException(
                status_code=429,
                detail="UR card permit rate-limited. Try again later.",
            )
        logger.warning("UR card /token-permit failed for %s: %s", ur_id, exc)
        if _ur_upstream_is_down(exc):
            raise HTTPException(status_code=503, detail=_UR_UPSTREAM_DOWN_DETAIL)
        raise HTTPException(status_code=502, detail=f"UR card permit failed: {exc}")
    result = resp.get("result", {}) or {}
    return {"ur_id": ur_id, "result": result, "tx_hash": result.get("txHash")}


class _UrCardFreezeRequest(BaseModel):
    """Freeze / unfreeze an issued card (Full-Auth)."""
    auth: _UrExtAuth
    card_token_id: str
    frozen: bool


# UR card-status codes (POST /api/v2/card-status). 0 = freeze/block, 1 =
# unfreeze/active per UR's helper docs.
# TODO(ur-card): confirm the exact status enum with UR once a Live card exists
# (some Fiat24 docs use 2=blocked); override via env if it differs.
_UR_CARD_STATUS_FROZEN = int(os.getenv("UR_CARD_STATUS_FROZEN", "0"))
_UR_CARD_STATUS_ACTIVE = int(os.getenv("UR_CARD_STATUS_ACTIVE", "1"))


@api_router.post("/ur/card/freeze", tags=["ur"])
async def ur_card_freeze(
    req: _UrCardFreezeRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Freeze or unfreeze an issued card (UR `/api/v2/card-status`).

    Requires a provisioned `card_token_id` (from `/ur/card/status`), so this
    only works once the URID is KYC-Live and a card exists; otherwise UR
    returns the same Fiat24 404 the other card endpoints do.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    status_code = _UR_CARD_STATUS_FROZEN if req.frozen else _UR_CARD_STATUS_ACTIVE
    try:
        resp = await ur_api.ext_card_status_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            card_token_id=req.card_token_id, status=status_code,
        )
    except ur_api.URError as exc:
        logger.warning("UR card /card-status failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR card freeze/unfreeze failed")
    return {
        "ur_id": ur_id,
        "frozen": req.frozen,
        "status": status_code,
        "result": resp.get("result", {}) or {},
    }


class _UrCardCurrencyRequest(BaseModel):
    """Set the card's default transaction/settlement currency (Full-Auth)."""
    auth: _UrExtAuth
    # Stable card externalId from GET /api/v2/card (§3.1.5), NOT cardTokenId / URID.
    card_external_id: str
    currency: str                 # one of the card's supported `currencies`


@api_router.post("/ur/card/currency", tags=["ur"])
async def ur_card_currency(
    req: _UrCardCurrencyRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Set the card's default transaction currency (UR `POST /api/v2/card-currency`, §3.1.5).

    `card_external_id` is ``result.externalId`` from `/ur/card/status` (not the
    URID and not `cardTokenId`); `currency` must be one of the card's supported
    `currencies`.
    """
    ur_id = await _resolve_caller_urid(auth_user)
    network = ur_chain.canonical_mantle_chain()
    try:
        resp = await ur_api.ext_card_currency_async(
            urid=ur_id, network=network,
            auth_hash=req.auth.hash, auth_deadline=req.auth.deadline, auth_sign=req.auth.sign,
            card_external_id=req.card_external_id, currency=req.currency,
        )
    except ur_api.URError as exc:
        logger.warning("UR card /card-currency failed for %s: %s", ur_id, exc)
        _raise_ur_read_error(exc, "UR card currency update failed")
    return {
        "ur_id": ur_id,
        "currency": req.currency.upper(),
        "result": resp.get("result", {}) or {},
    }


# ---------------------------------------------------------------------------
# UR webhooks — inbound event receiver (KYC outcome + incoming bank transfer)
#
# Canonical docs: https://docs.ur.app/developer-resources/webhook
# Delivery is at-least-once (~20 attempts / ~48h, jittered backoff). Signatures:
#   V1 (legacy): EIP-191 over raw body → X-Api-Signature
#   V2 (recommended): EIP-191 over "{ts}.{request_id}.{body}" → X-Api-Signature-V2
# We accept either (V2 preferred). Dedupe prefers X-Webhook-Request-Id, else a
# legacy body-hash event_id. Fan-out runs in the background; we ack HTTP 2xx fast.
#
# Events we act on:
#   • kyc_status            {tokenId, status: Pending|Pass|Rejected|ManualReview|Error}
#     (standard external-wallet account KYC — webhook catalog §6.2)
#   • fma.account.result    activated/rejected → Pass/Rejected
#     Used for FMA and for shared-token + External Wallet (§7):
#     https://docs.ur.app/concepts/kyc-and-compliance
#   • transaction / transaction_v2  money movement (pay-in / card / job heal)
# Recorded but not pushed: allowance, sumsub_kyc_result (intermediate).
# Live backfill: /ur/profile chainStatus=5 → same KYC Pass notify (deduped).
#
# Callback URL: POST {API_BASE}/api/webhooks/ur (HTTPS).
# ---------------------------------------------------------------------------

# UR server signing addresses (lowercased). Override via UR_WEBHOOK_SIGNERS
# (comma-separated). By default only the signer for the active UR_ENV is
# accepted — never both testnet and mainnet on the same deploy.
_UR_WEBHOOK_SIGNERS_DEFAULT = {
    "0x4d2aa3f43de8f8be746e315d291b804a4abd3939",  # Sepolia / testnet
    "0xee28dead5f114c8405be3be1144d59a4110b7f79",  # Mainnet
}


def _ur_webhook_allowed_signers() -> set:
    raw = (os.getenv("UR_WEBHOOK_SIGNERS", "") or "").strip()
    if raw:
        return {a.strip().lower() for a in raw.split(",") if a.strip()}
    return {ur_api.UR_SERVER_ADDRESS.lower()}


def _verify_ur_webhook_sig(raw_body: bytes, signature: Optional[str]) -> Optional[str]:
    """V1 (legacy): EIP-191 over the raw JSON body bytes."""
    import ur_webhook_crypto

    return ur_webhook_crypto.verify_webhook_sig_v1(
        raw_body, signature, allowed_signers=_ur_webhook_allowed_signers(),
    )


def _verify_ur_webhook_request(
    raw_body: bytes, headers: Any,
) -> Optional[str]:
    """Accept V2 signature when present, else fall back to V1."""
    import ur_webhook_crypto

    return ur_webhook_crypto.verify_webhook_request(
        raw_body, headers, allowed_signers=_ur_webhook_allowed_signers(),
    )


def _ur_webhook_event_id(
    *,
    request_id: Optional[str],
    event_type: str,
    data: Dict[str, Any],
    timestamp: int,
) -> str:
    """Prefer UR's ``X-Webhook-Request-Id``; else legacy body-hash event_id."""
    import ur_webhook_crypto

    return ur_webhook_crypto.webhook_event_id(
        request_id=request_id,
        event_type=event_type,
        data=data,
        timestamp=timestamp,
        compute_legacy=ur_db.compute_event_id,
    )


async def _ur_user_id_for_urid(ur_id: int) -> Optional[str]:
    """Resolve URID -> linked Privy user id (did:privy:...), or None."""
    if not supabase:
        return None
    link = await asyncio.to_thread(ur_db.get_link_by_ur_id, supabase, int(ur_id))
    return (link or {}).get("privy_user_id")


async def _ur_push_tokens_for_urid(ur_id: int) -> List[str]:
    """Resolve URID -> linked Privy user -> their Expo push tokens."""
    uid = await _ur_user_id_for_urid(ur_id)
    if not uid:
        return []
    res = await asyncio.to_thread(
        lambda: supabase.table("push_tokens").select("push_token").eq("user_id", uid).execute()
    )
    return [r["push_token"] for r in (res.data or []) if r.get("push_token")]


async def _ur_push_pref_enabled(ur_id: int, pref_column: str) -> bool:
    """Whether the user behind `ur_id` wants PUSH for this UR alert category.

    Gates only the push send — the in-app inbox row is always written so the
    bell/history stays complete even when a category is muted. Fail-OPEN
    (default True) on missing prefs row / unlinked URID / lookup error so a
    pref glitch never silently swallows an alert. `pref_column` is one of
    ur_transaction_alerts_enabled / ur_card_alerts_enabled / ur_kyc_alerts_enabled.
    """
    if not supabase:
        return True
    uid = await _ur_user_id_for_urid(ur_id)
    if not uid:
        return True
    try:
        res = await asyncio.to_thread(
            lambda: supabase.table("user_notification_preferences")
            .select(f"{pref_column},push_enabled").eq("user_id", uid).limit(1).execute()
        )
        rows = res.data or []
        if not rows:
            return True  # no prefs row yet → defaults on
        if rows[0].get("push_enabled") is False:
            return False
        val = rows[0].get(pref_column)
        return True if val is None else bool(val)
    except Exception:
        return True


async def _record_ur_notification(
    *,
    ur_id: int,
    category: str,
    ntype: str,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    dedupe_key: Optional[str] = None,
    user_id: Optional[str] = None,
) -> bool:
    """Persist one row into the in-app banking inbox (ur_notifications).

    Best-effort: a failure here must never break the webhook 200 path, so we
    log and move on. `user_id` may be passed to skip the URID->user lookup.
    Returns True when a new row was inserted, False on dedupe hit / skip.
    """
    if not supabase:
        return False
    try:
        uid = user_id or await _ur_user_id_for_urid(ur_id)
        if not uid:
            return False
        inserted = await asyncio.to_thread(
            lambda: ur_db.insert_notification(
                supabase,
                user_id=uid,
                ur_id=int(ur_id),
                category=category,
                ntype=ntype,
                title=title,
                body=body,
                data=data or {},
                dedupe_key=dedupe_key,
            )
        )
        return inserted is not None
    except Exception:  # pragma: no cover - inbox is best-effort
        logger.exception("Failed to record UR notification (type=%s urid=%s)", ntype, ur_id)
        return False


def _fmt_fiat_currency(currency: str) -> str:
    """UR fiat tokens are suffixed `24` (USD24, EUR24, CHF24…). Drop it for UX."""
    c = (currency or "").upper()
    return c[:-2] if c.endswith("24") and len(c) > 2 else c


def _fmt_job_amount(raw_amount: Any) -> str:
    """Format a job's decimal amount to 2dp for inbox copy, or "" if unusable."""
    if raw_amount is None:
        return ""
    try:
        return f"{float(str(raw_amount)):.2f}"
    except (TypeError, ValueError):
        return ""


# ───────────────────────── Cash (banking) rewards bridge ────────────────────
# UR banking actions (KYC, deposits, bank pay-ins, card spend) earn rewards that
# feed the SAME total_points pool as trading (shared tier/fee-discount perks) but
# are tracked on a separate "cash" volume + achievement track. The reward wallet
# is the verified URID-owner EOA bound at link time (same lowercase-EOA keyspace
# as trading rewards).


async def _ur_reward_wallet_for_urid(ur_id: int) -> Optional[str]:
    """Resolve a URID → reward wallet (lowercase URID-owner EOA), or None."""
    if not supabase:
        return None
    try:
        link = await asyncio.to_thread(ur_db.get_link_by_ur_id, supabase, int(ur_id))
    except Exception:
        return None
    if not link:
        return None
    addr = link.get("evm_address")
    if isinstance(addr, str) and addr.startswith("0x"):
        return addr.lower()
    uid = link.get("privy_user_id")
    if uid:
        try:
            res = await asyncio.to_thread(
                lambda: supabase.table("push_tokens")
                .select("wallet_address, updated_at")
                .eq("user_id", uid)
                .order("updated_at", desc=True)
                .execute()
            )
            for row in (res.data or []):
                push_addr = row.get("wallet_address")
                if isinstance(push_addr, str) and push_addr.startswith("0x"):
                    return push_addr.lower()
        except Exception:
            pass
    return None


async def _cash_amount_to_usd(amount_str: str, currency: str) -> Optional[float]:
    """Best-effort fiat→USD via the cached forex table. USD passes through.
    Returns None for unparseable / non-positive amounts. Falls back to the raw
    amount when no rate is available (milestone tracking tolerates small drift)."""
    try:
        amt = float(str(amount_str).strip().lstrip("+").lstrip("-"))
    except (TypeError, ValueError):
        return None
    if amt <= 0:
        return None
    cur = (currency or "").upper().strip()
    if not cur or cur in ("USD", "USDC", "USDT"):
        return amt
    if not supabase:
        return amt
    try:
        row = await asyncio.to_thread(
            lambda: supabase.table("forex_rates_cache").select("rates")
            .eq("base_currency", "USD").maybe_single().execute()
        )
        rates = (row.data or {}).get("rates") if row else None
        rate = float(rates[cur]) if rates and rates.get(cur) else None
        if rate and rate > 0:
            return amt / rate  # forex rates are units-of-CUR per 1 USD
    except Exception:
        pass
    return amt


async def _award_cash_reward(
    *, ur_id: int, amount_str: str, currency: str, tx_hash: str,
    kind: str, fallback_key: str,
) -> None:
    """Resolve wallet + USD value and credit a cash reward (idempotent)."""
    wallet = await _ur_reward_wallet_for_urid(ur_id)
    if not wallet:
        logger.info("Cash reward skipped: no linked reward wallet for URID %s", ur_id)
        return
    usd = await _cash_amount_to_usd(amount_str, currency)
    if not usd or usd <= 0:
        return
    event_key = f"tx:{tx_hash}:{kind}" if tx_hash else f"{fallback_key}:{kind}"
    try:
        await on_cash_activity(supabase, wallet, usd, kind, event_key)
    except Exception:
        logger.exception("on_cash_activity failed for URID %s (%s)", ur_id, kind)


async def _award_cash_kyc(ur_id: int) -> None:
    """Grant the one-time 'Verified' cash achievement on KYC approval."""
    wallet = await _ur_reward_wallet_for_urid(ur_id)
    if not wallet:
        logger.info("Cash KYC reward skipped: no linked reward wallet for URID %s", ur_id)
        return
    try:
        await on_cash_kyc_completed(supabase, wallet)
    except Exception:
        logger.exception("on_cash_kyc_completed failed for URID %s", ur_id)


async def _reconcile_cash_kyc_if_live(
    ur_id: int, chain_status: Optional[int] = None,
) -> None:
    """Backfill Verified reward + KYC Pass notify when Live but webhook was missed.

    Safe to call on every /ur/profile: inbox/push are deduped on
    ``kyc:{urid}:Pass``; cash reward grant is idempotent.
    """
    if chain_status is None:
        try:
            resp = await ur_api.partner_call_async("/v1/profile", {"urId": int(ur_id)})
            data = resp.get("data") if isinstance(resp, dict) else {}
            chain_status = data.get("chainStatus") if isinstance(data, dict) else None
        except Exception:
            logger.debug(
                "Cash KYC reconcile: profile fetch failed for URID %s", ur_id, exc_info=True,
            )
            return
    try:
        if int(chain_status) != 5:
            return
    except (TypeError, ValueError):
        return
    await _notify_ur_kyc({"tokenId": str(int(ur_id)), "status": "Pass"})


async def _notify_ur_kyc(data: Dict[str, Any]) -> None:
    """Fan out final KYC outcome (inbox + push + Verified reward).

    Shared by ``kyc_status`` webhooks, ``fma.account.result`` mapping, and
    Live profile backfill. Push only fires when a *new* inbox row is inserted
    so profile polls / retries do not re-spam devices.
    """
    raw_id = data.get("tokenId", data.get("urId"))
    status = str(data.get("status") or "").strip()
    try:
        ur_id = int(str(raw_id))
    except (TypeError, ValueError):
        return
    mapping = {
        "Pass": ("✅ Verification approved",
                 "Your identity check passed — your account is ready to use."),
        "Rejected": ("Verification declined",
                     "We couldn't verify your identity. Open the app to see next steps."),
        "ManualReview": ("Verification under review",
                         "Your identity check needs a manual review — we'll let you know once it's done."),
    }
    entry = mapping.get(status)
    if not entry:
        return  # Pending / Error → no push (transient, not actionable)
    title, body = entry
    # In-app inbox (system category) — dedupe on (urid, status) so a retried
    # webhook / Live backfill doesn't stack duplicate rows.
    is_new = await _record_ur_notification(
        ur_id=ur_id,
        category=ur_db.NOTIF_CATEGORY_SYSTEM,
        ntype="kyc_status",
        title=title,
        body=body,
        data={"status": status},
        dedupe_key=f"kyc:{ur_id}:{status}",
    )
    # Reward: identity verified (idempotent — safe on webhook retries).
    if status == "Pass":
        await _award_cash_kyc(ur_id)
    if not is_new:
        return  # already notified (webhook retry / Live backfill / FMA+kyc overlap)
    if not await _ur_push_pref_enabled(ur_id, "ur_kyc_alerts_enabled"):
        return  # inbox row recorded above; user muted verification pushes
    tokens = await _ur_push_tokens_for_urid(ur_id)
    for tok in tokens:
        await asyncio.to_thread(
            _send_push_notification, tok, title, body,
            {"type": "ur_kyc_status", "status": status, "ur_id": str(ur_id)},
        )
    if tokens:
        logger.info("UR kyc_status push (%s) sent to %d device(s) for URID %s",
                    status, len(tokens), ur_id)


async def _notify_ur_kyc_from_fma_account(data: Dict[str, Any]) -> None:
    """Map ``fma.account.result`` → shared KYC notify.

    Fired for FMA partners and for shared-token + External Wallet (same event
    names; see UR Shared-Token KYC Reuse §7). ``activated`` / ``rejected`` map
    to Pass / Rejected with the same dedupe keys as ``kyc_status``.
    """
    import ur_webhook_crypto

    mapped = ur_webhook_crypto.map_fma_account_status(data.get("status"))
    if not mapped:
        return
    await _notify_ur_kyc({
        "tokenId": data.get("urId", data.get("tokenId")),
        "urId": data.get("urId", data.get("tokenId")),
        "status": mapped,
    })


# Window (seconds) within which repeated same-merchant card spends are treated
# as one purchase's authorize→increment legs and collapsed to a single alert.
_CARD_SPEND_WINDOW_SEC = 600


async def _notify_ur_transaction(data: Dict[str, Any]) -> None:
    """Fan out a `transaction` webhook to push + the in-app inbox.

    UR pushes this event when a user's transaction is confirmed on-chain, with
    the `TransactionData` shape (docs.ur.app: Webhooks + OpenAPIs). Relevant
    fields: `type` (P2P/FRX/CTU/CRD/CDP/CWD/CTF), `direction` (IN/OUT),
    `amount` (signed string), `currency` (USD24…), `txHash`, `status`
    (pending/completed/rejected/unknown), plus `title`/`subtitle` (merchant)
    and `mcc` for card.

    Classification (banking scope):
      • Pay-in (money arriving from an external bank, type CDP / bank fields):
        push + inbox.
      • Card spend (type CRD): inbox only by default — UR confirms card txs ARE
        delivered here (authorize/increment/reverse each fire on-chain). Push
        is gated behind UR_CARD_PUSH_ENABLED so we can flip it on instantly.
      • Other outgoing money moves (withdraw/payout/transfer-out): inbox
        history; the in-progress UX already covers them live.

    Wallet-side USDC moves are covered by the on-chain poller and not here.
    """
    raw_id = data.get("urId", data.get("tokenId"))
    try:
        ur_id = int(str(raw_id))
    except (TypeError, ValueError):
        return
    tx_type = str(data.get("type") or "").upper()
    direction = str(data.get("direction") or "").upper()
    status = str(data.get("status") or "").lower()
    # Per the documented enum, only `rejected`/`unknown` are non-actionable;
    # `pending` (e.g. a card authorization hold) and `completed` both surface.
    if status in ("rejected", "unknown", "failed", "cancelled", "declined"):
        return

    currency = _fmt_fiat_currency(str(data.get("currency") or ""))
    amount = str(data.get("amount") or "").strip().lstrip("+").lstrip("-")
    tx_hash = str(data.get("txHash") or data.get("hash") or "").strip().lower()
    # Stable dedupe key: tx hash when present, else a content hash so retried
    # deliveries collapse to one inbox row.
    dedupe = (
        f"tx:{tx_hash}" if tx_hash
        else f"txn:{ur_id}:{tx_type}:{direction}:{amount}:{currency}"
    )

    has_bank = bool(data.get("bankAccount") or data.get("reference"))
    is_payin = direction == "IN" and (tx_type == "CDP" or has_bank)
    is_card = tx_type == "CRD"
    # A card row is a refund/reversal when money flows back in. UR labels it
    # title="Refund" / listingTitle="Refund (Card Spending)" with direction IN.
    is_card_refund = is_card and (
        direction == "IN"
        or str(data.get("title") or "").strip().lower() == "refund"
    )

    # ── HyperTrade user transfer (URID → URID P2P) ───────────────────────
    # Handle before pay-in/card so the inbound leg lands in the inbox (the v1
    # path has no generic IN branch and would otherwise drop it) and never
    # earns a deposit reward.
    if _is_p2p_tx_type(tx_type):
        await _notify_ur_transaction_p2p(
            ur_id=ur_id, data=data, details={}, direction=direction,
            amount=amount, currency=currency, tx_type=tx_type, status=status,
            tx_hash=tx_hash, dedupe=dedupe,
            tx_meta={"txHash": tx_hash} if tx_hash else {},
        )
        return

    if is_payin:
        title = "💰 Money received"
        body = (f"{amount} {currency} landed in your account".strip()
                if amount else "A bank transfer landed in your account")
        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="payin", title=title, body=body, dedupe_key=dedupe,
            data={"amount": amount, "currency": currency,
                  "reference": str(data.get("reference") or "")},
        )
        # Reward: bank pay-in (settled). Award before the push-pref early return
        # so muting pushes never costs a user their points.
        if status != "pending":
            await _award_cash_reward(
                ur_id=ur_id, amount_str=amount, currency=currency,
                tx_hash=tx_hash, kind="deposit", fallback_key=dedupe,
            )
        if not await _ur_push_pref_enabled(ur_id, "ur_transaction_alerts_enabled"):
            return  # inbox recorded; user muted transaction pushes
        tokens = await _ur_push_tokens_for_urid(ur_id)
        for tok in tokens:
            await asyncio.to_thread(
                _send_push_notification, tok, title, body,
                {
                    "type": "ur_payin",
                    "amount": amount,
                    "currency": currency,
                    "reference": str(data.get("reference") or ""),
                    "ur_id": str(ur_id),
                },
            )
        if tokens:
            logger.info("UR pay-in push sent to %d device(s) for URID %s (%s %s)",
                        len(tokens), ur_id, amount, currency)
        return

    if is_card:
        # Merchant + location live in `title` / `subtitle` (e.g. "Alipay" /
        # "Singapore"); `mcc` is the merchant category code.
        merchant = str(data.get("title") or "").strip()
        location = str(data.get("subtitle") or "").strip()
        mcc = data.get("mcc")

        if is_card_refund:
            # Refunds/reversals always get their own row (keyed on txHash so a
            # retried webhook collapses, but distinct from the spend).
            title = "Card refund"
            body = (f"{amount} {currency} refunded".strip()
                    if amount else "A card refund landed in your account")
            ntype = "card_refund"
            card_dedupe = f"tx:{tx_hash}" if tx_hash else dedupe
        else:
            # A single purchase emits authorize → increment(s) on-chain, each a
            # separate row with no correlation key. We can't tell them apart by
            # field, so we fold same-merchant spends that land in the same short
            # window into ONE alert: the authorize wins, increments collapse via
            # the unique (user, dedupe_key) index. The Card tab still shows every
            # on-chain leg — only the notification is de-duplicated.
            try:
                ts = int(data.get("timestamp") or 0)
            except (TypeError, ValueError):
                ts = 0
            bucket = ts // _CARD_SPEND_WINDOW_SEC
            card_dedupe = f"cardspend:{ur_id}:{merchant}:{mcc}:{bucket}"
            title = merchant or "Card payment"
            body = (f"{amount} {currency}".strip()
                    + (f" · {location}" if location else "")).strip()
            if not body:
                body = "Card payment"
            ntype = "card_spend"

        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype=ntype, title=title, body=body, dedupe_key=card_dedupe,
            data={"amount": amount, "currency": currency, "merchant": merchant,
                  "location": location, "txType": tx_type, "mcc": mcc,
                  "status": status},
        )
        # Reward: settled card spend only (skip refunds + un-settled auth holds).
        if not is_card_refund and status == "completed":
            await _award_cash_reward(
                ur_id=ur_id, amount_str=amount, currency=currency,
                tx_hash=tx_hash, kind="card_spend", fallback_key=card_dedupe,
            )
        # Card push is opt-in (default off) until we've watched real card-tx
        # webhook volume; the inbox row above always lands. Flip on with
        # UR_CARD_PUSH_ENABLED=1 — no code change needed.
        if (
            os.getenv("UR_CARD_PUSH_ENABLED", "0").strip() == "1"
            and await _ur_push_pref_enabled(ur_id, "ur_card_alerts_enabled")
        ):
            tokens = await _ur_push_tokens_for_urid(ur_id)
            for tok in tokens:
                await asyncio.to_thread(
                    _send_push_notification, tok, title, body,
                    {"type": f"ur_{ntype}", "amount": amount,
                     "currency": currency, "ur_id": str(ur_id)},
                )
        logger.info("UR card-tx inbox (%s) for URID %s (%s %s status=%s)",
                    ntype, ur_id, amount, currency, status or "-")
        return

    # Outgoing money move (withdraw / payout / transfer-out) — inbox history.
    if direction == "OUT" and amount:
        title = "Money sent"
        body = f"{amount} {currency} left your account".strip()
        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="payment_out", title=title, body=body, dedupe_key=dedupe,
            data={"amount": amount, "currency": currency, "txType": tx_type},
        )


# UR migrated the transaction webhook to `transaction_v2`, with a NEW schema
# (verified live 2026-06-03, URID 5448769923, an Add Money credit):
#   { "event": "transaction_v2", "timestamp": <unix s>,
#     "data": { "type": "CRYPTO_DEPOSIT", "urId": "…", "amount": "50.00",
#               "currency": "usd", "status": "CONFIRMED", "direction": "IN",
#               "txHash": "0x…", "chainId": "eip155:421614",
#               "detailsJson": "{…balance,bankTxHash,fromTxHash,inputToken…}" } }
# Key differences vs the legacy `transaction` (TransactionData) shape:
#   • `type` is a verbose enum (CRYPTO_DEPOSIT, …) not 3-letter codes (CDP/CRD…)
#   • `status` is UPPERCASE (CONFIRMED/PENDING/…) not pending/completed
#   • `currency` is lowercase ISO ("usd") not "USD24"
#   • merchant / bank / source-chain details are inside the `detailsJson` string
# Statuses we treat as terminal-bad (drop) and not-yet-settled (wait for the
# follow-up CONFIRMED rather than double-notifying):
# Status enum per UR's canonical transaction status table (Managed Custody §12.1;
# shared by the transaction/transaction_v2 webhook). Terminal-bad → drop;
# not-yet-settled → wait for the follow-up CONFIRMED rather than double-notifying.
# We keep a few legacy/defensive aliases (CANCELLED/DECLINED/PROCESSING/…) so a
# schema tweak on UR's side never slips an un-handled status through.
_TXN_V2_DEAD_STATUSES = {
    "REJECTED", "FAILED", "DROPPED", "PENDING_DROP",
    "CANCELLED", "DECLINED", "ERROR", "REVERSED",
}
_TXN_V2_PENDING_STATUSES = {
    "PENDING", "INIT", "UNKNOWN",
    "PROCESSING", "CREATED", "SUBMITTED", "INITIATED", "WAITING",
}


def _is_card_tx_type(tx_type: str) -> bool:
    """True if a UR transaction `type` is a card event.

    UR labels card authorizations `MARQETA_AUTHORIZE` (Marqeta is their card
    processor) in the verbose enum, and `CRD` in the legacy 3-letter codes.
    Match all spellings so a card swipe never falls through to the generic
    money-moved branch and gets mislabeled "Money sent".
    """
    t = (tx_type or "").upper()
    return "CARD" in t or "MARQETA" in t or t == "CRD"


def _txn_v2_details(data: Dict[str, Any]) -> Dict[str, Any]:
    """Parse the `detailsJson` blob (a JSON string, occasionally already a dict)
    carrying the per-type extras (FX input/output legs, deposit source token,
    bank tx hashes, …). Returns {} on anything malformed."""
    raw = data.get("detailsJson")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _is_p2p_tx_type(tx_type: str) -> bool:
    """True if a UR transaction `type` is a URID-to-URID HyperTrade transfer.

    UR's legacy 3-letter code is ``P2P``. The verbose ``transaction_v2`` enum
    for peer transfers isn't pinned across environments yet, so we also match a
    few defensive spellings (PEER_*, *ACCOUNT_TRANSFER, TRANSFER_BY_ACCOUNT)
    while explicitly excluding card / FX / deposit types so a swap or top-up is
    never mis-classified as a transfer.
    """
    t = (tx_type or "").upper()
    if not t or _is_card_tx_type(t):
        return False
    if any(k in t for k in ("FX", "EXCHANGE", "CONVERT", "SWAP", "DEPOSIT")):
        return False
    return t == "P2P" or any(
        h in t for h in ("PEER", "ACCOUNT_TRANSFER", "TRANSFER_BY_ACCOUNT")
    )


def _first_account_id_in(*candidates: Any) -> Optional[int]:
    """Pull the first 5+ digit run out of any of the given strings (no regex).

    UR embeds the counterparty URID inside free-text fields like
    ``"Account 5448769923"`` or ``"#5448769923"`` on peer-transfer rows; this
    scrapes it as a last resort when no structured field carries it.
    """
    for cand in candidates:
        s = str(cand or "")
        run = ""
        for ch in s:
            if ch.isdigit():
                run += ch
                continue
            if len(run) >= 5:
                try:
                    return int(run)
                except ValueError:
                    pass
            run = ""
        if len(run) >= 5:
            try:
                return int(run)
            except ValueError:
                pass
    return None


def _extract_p2p_counterparty(
    data: Dict[str, Any], details: Dict[str, Any], direction: str,
) -> Optional[int]:
    """Best-effort parse of the *other* URID in a P2P webhook.

    ``OUT`` → the recipient we paid; ``IN`` → the sender. UR's peer-transfer
    payload shape isn't fixed across environments, so we probe the documented-ish
    keys in both the top-level data and the parsed ``detailsJson``, then fall
    back to the numeric URID embedded in ``title`` / ``subtitle``.
    """
    if (direction or "").upper() == "OUT":
        primary = ("toAccountId", "toUrId", "toUrid", "toId",
                   "recipientId", "recipientUrId", "recipientAccountId")
    else:
        primary = ("fromAccountId", "fromUrId", "fromUrid", "fromId",
                   "senderId", "senderUrId", "senderAccountId")
    generic = ("counterpartyId", "counterpartyUrId", "counterparty",
               "peerId", "peerAccountId", "peerUrId")
    for src in (data, details):
        if not isinstance(src, dict):
            continue
        for key in (*primary, *generic):
            val = src.get(key)
            if val is None:
                continue
            try:
                num = int(str(val).strip())
            except (TypeError, ValueError):
                continue
            if num > 0:
                return num
    return _first_account_id_in(data.get("subtitle"), data.get("title"))


async def _resolve_p2p_counterparty(
    *,
    ur_id: int,
    data: Dict[str, Any],
    details: Dict[str, Any],
    direction: str,
    tx_hash: str,
    user_id: Optional[str] = None,
) -> Tuple[Optional[int], Optional[str]]:
    """Resolve (counterparty_urid, saved_label) for a P2P webhook, best-effort.

    For an ``OUT`` leg we first trust our own ``transfer`` job (matched by the
    source tx hash) which authoritatively recorded the recipient URID; only if
    that misses do we parse the webhook. The label is whatever the *viewer*
    saved that counterparty as in their address book (``ur_p2p_recipients``),
    so the inbox / history reads "Sent to 'Mom'" rather than a bare Account ID.
    """
    counterparty: Optional[int] = None
    uid = user_id
    if (direction or "").upper() == "OUT" and tx_hash and supabase:
        try:
            job = await asyncio.to_thread(ur_db.find_job_by_source_tx, supabase, tx_hash)
        except Exception:  # noqa: BLE001
            job = None
        if job and (job.get("kind") or "").lower() == ur_db.JOB_KIND_TRANSFER:
            try:
                counterparty = int(str(job.get("quote_id") or "").strip())
            except (TypeError, ValueError):
                counterparty = None
            uid = uid or job.get("privy_user_id")
    if counterparty is None:
        counterparty = _extract_p2p_counterparty(data, details, direction)
    if counterparty is not None and counterparty == int(ur_id):
        counterparty = None  # never label the viewer as their own counterparty

    label: Optional[str] = None
    if counterparty is not None and supabase:
        if not uid:
            uid = await _ur_user_id_for_urid(ur_id)
        if uid:
            try:
                label = await asyncio.to_thread(
                    ur_db.get_p2p_recipient_label, supabase,
                    privy_user_id=uid, recipient_ur_id=counterparty,
                )
            except Exception:  # noqa: BLE001
                label = None
    return counterparty, label


def _p2p_party_display(counterparty: Optional[int], label: Optional[str]) -> str:
    """Human label for a peer-transfer counterparty in push/inbox copy."""
    if label:
        return label
    if counterparty:
        return f"Account {counterparty}"
    return "a HyperTrade user"


async def _notify_ur_transaction_p2p(
    *,
    ur_id: int,
    data: Dict[str, Any],
    details: Dict[str, Any],
    direction: str,
    amount: str,
    currency: str,
    tx_type: str,
    status: str,
    tx_hash: str,
    dedupe: str,
    tx_meta: Dict[str, Any],
) -> None:
    """Fan a URID-to-URID transfer out to the inbox + push (both legs).

    A peer transfer fires on BOTH accounts — ``OUT`` on the sender and ``IN``
    on the recipient. The recipient never initiated it in-app, so a push is
    genuinely useful there; the sender gets a confirmation row. Crucially this
    is classified BEFORE the generic inbound branch so we never award a deposit
    reward on the inbound leg (it's an internal move between two app users, not
    new external funding).
    """
    counterparty, label = await _resolve_p2p_counterparty(
        ur_id=ur_id, data=data, details=details,
        direction=direction, tx_hash=tx_hash,
    )
    who = _p2p_party_display(counterparty, label)
    if (direction or "").upper() == "IN":
        title = "💰 Money received"
        body = (f"Received {amount} {currency} from {who}".strip()
                if amount else f"{who} sent you money")
        ntype = "transfer_in"
    else:
        title = "Money sent"
        body = (f"Sent {amount} {currency} to {who}".strip()
                if amount else f"You sent money to {who}")
        ntype = "transfer_out"

    is_new = await _record_ur_notification(
        ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
        ntype=ntype, title=title, body=body, dedupe_key=dedupe,
        data={"amount": amount, "currency": currency, "txType": tx_type,
              "status": status, "counterpartyUrId": counterparty,
              "counterpartyLabel": label or "", **tx_meta},
    )
    # Sender initiated the transfer in-app — inbox history is enough. Only the
    # recipient (IN leg) gets a device push since they didn't trigger the flow.
    if (direction or "").upper() != "IN":
        logger.info(
            "UR %s inbox only (no push) URID %s (%s %s -> %s)",
            ntype, ur_id, amount, currency, counterparty or "-",
        )
        return
    if not is_new:
        return  # fallback or a retried webhook already recorded + pushed
    if not await _ur_push_pref_enabled(ur_id, "ur_transaction_alerts_enabled"):
        logger.info("UR %s inbox (push muted) URID %s (%s %s)",
                    ntype, ur_id, amount, currency)
        return
    tokens = await _ur_push_tokens_for_urid(ur_id)
    for tok in tokens:
        await asyncio.to_thread(
            _send_push_notification, tok, title, body,
            {"type": f"ur_{ntype}", "amount": amount, "currency": currency,
             "ur_id": str(ur_id), "counterpartyUrId": str(counterparty or ""),
             "counterpartyLabel": label or ""},
        )
    logger.info("UR %s push/inbox to %d device(s) URID %s (%s %s -> %s)",
                ntype, len(tokens), ur_id, amount, currency, counterparty or "-")


async def _notify_ur_transaction_v2(data: Dict[str, Any]) -> None:
    """Fan out a `transaction_v2` webhook to push + the in-app inbox.

    Classification mirrors `_notify_ur_transaction` but reads the v2 schema:
      • Money arriving (IN): Add Money credit (CRYPTO_DEPOSIT) or a bank pay-in
        → push + inbox. This is also the authoritative "your cross-chain
        deposit credit landed" signal (LayerZero can lag minutes on testnet).
      • Card spend/refund (type contains CARD): inbox; push gated by
        UR_CARD_PUSH_ENABLED.
      • Outgoing (OUT): inbox history (the in-app flow already covers it live).

    Unknown `type` strings fall back to a generic IN/OUT classification so we
    never silently drop a money movement again.
    """
    raw_id = data.get("urId", data.get("tokenId"))
    try:
        ur_id = int(str(raw_id))
    except (TypeError, ValueError):
        return

    tx_type = str(data.get("type") or "").upper()
    direction = str(data.get("direction") or "").upper()
    status = str(data.get("status") or "").upper()
    if status in _TXN_V2_DEAD_STATUSES:
        return

    currency = _fmt_fiat_currency(str(data.get("currency") or ""))
    amount = str(data.get("amount") or "").strip().lstrip("+").lstrip("-")
    tx_hash = str(data.get("txHash") or data.get("hash") or "").strip().lower()
    dedupe = (
        f"tx:{tx_hash}" if tx_hash
        else f"txnv2:{ur_id}:{tx_type}:{direction}:{amount}:{currency}"
    )
    push_base = {"amount": amount, "currency": currency, "ur_id": str(ur_id)}
    # On-chain pointer for the inbox "view on explorer" affordance. chainId
    # arrives CAIP-2 style ("eip155:5003"); keep just the numeric part.
    chain_num = (str(data.get("chainId") or "").split(":")[-1] or "").strip()
    tx_meta = {"txHash": tx_hash, "chainId": chain_num}

    # Fiat bank pay-in: someone funded the user's UR IBAN via a bank transfer
    # (SEPA / wire / ACH). UR has no single canonical `type` for this across
    # environments, so detect it broadly — bank-settlement fields inside
    # detailsJson OR a fiat/bank hint in the type string. We've only observed
    # CRYPTO_DEPOSIT "Add Money" credits live so far, so this guarantees a real
    # bank credit still lands on the "Money received" push with clean copy.
    _v2_details = _txn_v2_details(data)
    is_bank_payin = direction == "IN" and (
        any(_v2_details.get(k) for k in
            ("bankTxHash", "bankAccount", "bankReference", "iban", "reference"))
        or any(h in tx_type for h in ("PAYIN", "SEPA", "WIRE", "ACH", "FIAT", "BANK"))
        or ("DEPOSIT" in tx_type and "CRYPTO" not in tx_type)
    )

    # ── Card spend / refund ──────────────────────────────────────────────
    if _is_card_tx_type(tx_type):
        if direction == "IN":
            title = "Card refund"
            body = (f"{amount} {currency} refunded".strip()
                    if amount else "A card refund landed in your account")
            ntype = "card_refund"
        else:
            title = "Card payment"
            body = f"{amount} {currency}".strip() if amount else "Card payment"
            ntype = "card_spend"
        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype=ntype, title=title, body=body, dedupe_key=dedupe,
            data={"amount": amount, "currency": currency, "txType": tx_type,
                  "status": status, **tx_meta},
        )
        # Reward: settled card spend only (skip refunds + un-settled holds). The
        # cash_reward_events PK collapses any v1/v2 duplicate for the same tx.
        if direction != "IN" and status == "CONFIRMED":
            await _award_cash_reward(
                ur_id=ur_id, amount_str=amount, currency=currency,
                tx_hash=tx_hash, kind="card_spend", fallback_key=dedupe,
            )
        if (
            os.getenv("UR_CARD_PUSH_ENABLED", "0").strip() == "1"
            and await _ur_push_pref_enabled(ur_id, "ur_card_alerts_enabled")
        ):
            for tok in await _ur_push_tokens_for_urid(ur_id):
                await asyncio.to_thread(_send_push_notification, tok, title, body,
                                        {"type": f"ur_{ntype}", **push_base})
        logger.info("UR v2 card-tx inbox (%s) URID %s (%s %s status=%s)",
                    ntype, ur_id, amount, currency, status or "-")
        return

    # ── Outgoing money move (withdraw / bank payout) — inbox only ────────
    # Plain outgoing payouts/withdrawals are user-initiated and never push, so
    # fire the "Money sent" inbox row on the FIRST webhook even while PENDING.
    # Bank-settlement timing is out of our control (UR can hold a payout
    # PENDING for days), and the txHash dedupe collapses any later CONFIRMED
    # into the same row. Excludes P2P / FX, which have their own branches.
    if (
        direction == "OUT"
        and amount
        and not _is_p2p_tx_type(tx_type)
        and not any(k in tx_type for k in ("FX", "EXCHANGE", "CONVERT", "SWAP"))
    ):
        title = "Money sent"
        body = f"{amount} {currency} left your account".strip()
        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="payment_out", title=title, body=body, dedupe_key=dedupe,
            data={"amount": amount, "currency": currency, "txType": tx_type,
                  "status": status, **tx_meta},
        )
        logger.info("UR v2 outgoing inbox URID %s (%s %s status=%s)",
                    ur_id, amount, currency, status or "-")
        return

    # Non-card money moves: wait for settlement before notifying so a
    # PENDING→CONFIRMED pair doesn't double-fire (txHash dedupe collapses the
    # inbox row, but pushes are not deduped).
    if status in _TXN_V2_PENDING_STATUSES:
        return

    # ── Currency conversion (FX) ─────────────────────────────────────────
    # FX_EXCHANGE arrives as direction=IN with the *input* leg on the top-level
    # amount/currency (e.g. "60.00 usd"), so the generic IN branch would mislabel
    # it "Money received". The real swap (input→output) is inside detailsJson.
    # It's an internal move between the user's own currencies and is already
    # shown live in the in-app convert flow, so we record an accurate inbox row
    # but do NOT push (avoid redundant noise for a self-initiated action).
    if any(k in tx_type for k in ("FX", "EXCHANGE", "CONVERT", "SWAP")):
        details = _txn_v2_details(data)
        in_amt = str(details.get("inputAmount") or amount or "").strip()
        in_cur = _fmt_fiat_currency(str(details.get("inputCurrency") or currency or ""))
        out_amt = str(details.get("outputAmount") or "").strip()
        out_cur = _fmt_fiat_currency(str(details.get("outputCurrency") or ""))
        if in_amt and out_amt:
            body = f"{in_amt} {in_cur} → {out_amt} {out_cur}".strip()
        elif out_amt:
            body = f"Converted to {out_amt} {out_cur}".strip()
        else:
            body = "Currency conversion completed"
        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="conversion", title="Converted", body=body, dedupe_key=dedupe,
            data={"inputAmount": in_amt, "inputCurrency": in_cur,
                  "outputAmount": out_amt, "outputCurrency": out_cur,
                  "txType": tx_type, "status": status, **tx_meta},
        )
        logger.info("UR v2 conversion inbox URID %s (%s %s -> %s %s)",
                    ur_id, in_amt, in_cur, out_amt, out_cur)
        return

    # ── HyperTrade user transfer (URID → URID P2P) ───────────────────────
    # Classified before the generic IN/OUT branches so the inbound leg never
    # earns a deposit reward (it's an internal move) and both sides get a
    # labelled "Sent to / Received from <name>" alert.
    if _is_p2p_tx_type(tx_type):
        await _notify_ur_transaction_p2p(
            ur_id=ur_id, data=data, details=_v2_details, direction=direction,
            amount=amount, currency=currency, tx_type=tx_type, status=status,
            tx_hash=tx_hash, dedupe=dedupe, tx_meta=tx_meta,
        )
        return

    # ── Money arriving (Add Money credit / bank pay-in / generic IN) ─────
    if direction == "IN":
        is_crypto_deposit = "DEPOSIT" in tx_type and "CRYPTO" in tx_type
        if is_crypto_deposit:
            title = "💰 Money added"
            body = (f"{amount} {currency} added to your account".strip()
                    if amount else "Your deposit has been credited")
            ntype = "deposit"
        elif is_bank_payin:
            title = "💰 Money received"
            body = (f"{amount} {currency} landed in your account".strip()
                    if amount else "A bank transfer landed in your account")
            ntype = "payin"
        else:
            title = "💰 Money received"
            body = (f"{amount} {currency} landed in your account".strip()
                    if amount else "Money landed in your account")
            ntype = "payin"
        await _record_ur_notification(
            ur_id=ur_id, category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype=ntype, title=title, body=body, dedupe_key=dedupe,
            data={"amount": amount, "currency": currency, "txType": tx_type,
                  "status": status, **tx_meta},
        )
        # Reward: settled inflow (crypto deposit or bank pay-in). Pending/dead
        # statuses already returned above, so we're past settlement here.
        await _award_cash_reward(
            ur_id=ur_id, amount_str=amount, currency=currency,
            tx_hash=tx_hash, kind="deposit", fallback_key=dedupe,
        )
        if not await _ur_push_pref_enabled(ur_id, "ur_transaction_alerts_enabled"):
            return  # inbox recorded; user muted transaction pushes
        tokens = await _ur_push_tokens_for_urid(ur_id)
        for tok in tokens:
            await asyncio.to_thread(_send_push_notification, tok, title, body,
                                    {"type": f"ur_{ntype}", **push_base})
        logger.info("UR v2 %s push/inbox to %d device(s) URID %s (%s %s)",
                    ntype, len(tokens), ur_id, amount, currency)
        return
    # Outgoing money moves are handled before the settlement gate above.


async def _heal_job_from_webhook(data: Dict[str, Any]) -> None:
    """Settle a stuck local job the instant its source-chain webhook confirms.

    kind=fx (and occasionally deposit) jobs have no destination-chain hop, so
    historically they sat at `submitted` until a lazy on-chain reconcile swept
    them — sometimes hours later — leaving a stray "pending" row in the
    Transactions tab. UR now emits a `transaction_v2` (CONFIRMED) carrying the
    source tx hash, so we match it to the open job and flip it to completed
    immediately. Best-effort: any miss falls back to the lazy reconciler.
    """
    if not supabase:
        return
    status = str(data.get("status") or "").upper()
    # Only settle on a terminal-good signal; ignore pending/dead webhooks.
    if not status or status in _TXN_V2_DEAD_STATUSES or status in _TXN_V2_PENDING_STATUSES:
        return
    tx_hash = str(data.get("txHash") or data.get("hash") or "").strip().lower()
    if not tx_hash:
        return
    try:
        job = await asyncio.to_thread(ur_db.find_job_by_source_tx, supabase, tx_hash)
    except Exception:
        logger.exception("UR webhook job-heal lookup failed for %s", tx_hash)
        return
    if not job or job.get("status") in ur_db.JOB_TERMINAL_STATUSES:
        return
    try:
        healed = await asyncio.to_thread(
            ur_db.transition_status_atomic,
            supabase,
            job_id=job["id"],
            expected_status=job["status"],
            new_status=ur_db.JOB_STATUS_COMPLETED,
        )
        if healed:
            logger.info("UR webhook healed job %s (%s) submitted -> completed via %s",
                        job.get("id"), job.get("kind"), tx_hash)
    except Exception:
        logger.exception("UR webhook job-heal failed for %s", tx_hash)


async def _process_ur_webhook(event_type: str, data: Dict[str, Any], event_id: str) -> None:
    """Background fan-out + terminal status flip for a deduped webhook."""
    try:
        if event_type == "kyc_status":
            await _notify_ur_kyc(data)
        elif event_type == "fma.account.result":
            await _notify_ur_kyc_from_fma_account(data)
        elif event_type == "transaction":
            await _notify_ur_transaction(data)
        elif event_type == "transaction_v2":
            await _notify_ur_transaction_v2(data)
        # Settle any stuck local job this confirmation refers to (fx/deposit).
        if event_type in ("transaction", "transaction_v2"):
            await _heal_job_from_webhook(data)
        if supabase:
            await asyncio.to_thread(
                ur_db.mark_webhook_processed, supabase, event_id, status="processed"
            )
    except Exception as exc:  # pragma: no cover - best-effort notifier
        logger.exception("UR webhook processing failed for %s", event_id)
        if supabase:
            try:
                await asyncio.to_thread(
                    ur_db.mark_webhook_processed, supabase, event_id,
                    status="failed", error_message=str(exc)[:500],
                )
            except Exception:
                pass


@api_router.post("/webhooks/ur", tags=["ur"], include_in_schema=False)
async def ur_webhook_receiver(request: Request, background_tasks: BackgroundTasks):
    """Inbound UR webhook: verify signature → dedupe → notify (background)."""
    return await _handle_ur_webhook_inbound(request, background_tasks)


async def _handle_ur_webhook_inbound(
    request: Request, background_tasks: BackgroundTasks
) -> Dict[str, Any]:
    """Shared handler for POST /webhooks/ur (canonical) and /ur/webhook (alias)."""
    raw = await request.body()
    req_id_hdr = (
        request.headers.get("X-Webhook-Request-Id")
        or request.headers.get("x-webhook-request-id")
    )
    sig_v2 = (
        request.headers.get("X-Api-Signature-V2")
        or request.headers.get("x-api-signature-v2")
    )
    sig_v1 = (
        request.headers.get("X-Api-Signature")
        or request.headers.get("x-api-signature")
    )
    # Persist whichever signature we accepted (prefer V2 for audit).
    sig_stored = sig_v2 or sig_v1

    # V2 preferred, V1 fallback. Disable only for local testing via
    # UR_WEBHOOK_VERIFY=0.
    signer = _verify_ur_webhook_request(raw, request.headers)
    if os.getenv("UR_WEBHOOK_VERIFY", "1").strip() != "0" and not signer:
        raise HTTPException(status_code=401, detail="invalid webhook signature")

    try:
        payload = json.loads((raw or b"").decode("utf-8") or "{}")
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid payload")

    event_type = str(payload.get("event") or "").strip()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    timestamp = int(payload.get("timestamp") or 0)
    if not event_type:
        return {"ok": True, "ignored": "no event"}

    # Pull identity/dedupe hints for the row.
    ur_id_row: Optional[int] = None
    rid = data.get("urId", data.get("tokenId"))
    try:
        ur_id_row = int(str(rid)) if rid is not None else None
    except (TypeError, ValueError):
        ur_id_row = None
    tx_hash_row = (str(data.get("txHash") or "").strip().lower() or None)

    if not supabase:
        raise HTTPException(status_code=503, detail="database unavailable")

    # Idempotency: prefer X-Webhook-Request-Id (docs §7); else legacy hash.
    event_id = _ur_webhook_event_id(
        request_id=req_id_hdr,
        event_type=event_type,
        data=data,
        timestamp=timestamp,
    )
    try:
        is_new = await asyncio.to_thread(
            ur_db.record_webhook_event, supabase,
            event_id=event_id, event_type=event_type, payload=payload,
            signature=sig_stored, ur_id=ur_id_row, tx_hash=tx_hash_row,
        )
    except Exception:
        logger.exception("UR webhook persist failed (%s)", event_id)
        raise HTTPException(status_code=500, detail="webhook persistence failed")
    if not is_new:
        return {"ok": True, "dedup": True}

    if event_type in (
        "kyc_status",
        "fma.account.result",
        "transaction",
        "transaction_v2",
    ):
        background_tasks.add_task(_process_ur_webhook, event_type, data, event_id)
    else:
        # Recorded-but-not-pushed events (allowance, sumsub_kyc_result) close out.
        background_tasks.add_task(
            lambda: ur_db.mark_webhook_processed(supabase, event_id, status="skipped")
        )
    return {"ok": True}


def _to_token_units(amount: str, decimals: int) -> int:
    """Convert a decimal-string amount into raw integer units, no float drift."""
    from decimal import Decimal as _D
    return int((_D(str(amount)) * (_D(10) ** int(decimals))).to_integral_value())


# NOTE: the old `_normalize_onramp_amount` (major-currency-units) helper was
# removed when we switched the cash-out from UR's Managed-Custody REST onramp
# (major units) to the External Wallet Access `/api/v1/onramp-with-permit`
# flow, which takes 2-dp SMALLEST units. The withdraw endpoints now use
# `_to_token_units(amount, 2)` directly.


# ---------------------------------------------------------------------------
# FX (Convert) — direct on-chain via Fiat24CryptoRelay (EXTERNAL WALLET ACCESS)
#
# We are in External Wallet Access mode. Confirmed empirically 2026-05-28:
#
#   ownerOf(URID 5448769923)                = user's Privy EOA 0xFA029dAB...
#   USD24.balanceOf(user EOA)               = 1010.00 USD24
#   (no UR-vault custody — the user's own wallet holds the fiat balance)
#
# Implications for the FX flow:
#   1. /api/fma/v1/* (Managed Custody) endpoints are the WRONG family for us.
#      UR's earlier note "if u start as managed custody mode then is eligible
#      to use fma prefixed endpoint" is conditional — we don't qualify, and
#      the "user turnkey address not set" error is UR's API politely telling
#      us to sign the action ourselves.
#   2. The right primitive is the on-chain Fiat24CryptoRelay contract on
#      Mantle (mainnet 0x9F88…, sepolia 0x2C2E…). It exposes:
#         moneyExchangeExactIn(inputToken, outputToken, inputAmount, minOut)
#      which debits/credits `_msgSender()` — i.e. the USER must be the caller.
#   3. Backend role here is reduced to:
#         /ur/fx/info   : surface contract addresses + token addresses + min amt
#         /ur/fx/quote  : read live exchange rate + spread + fee on-chain
#         /ur/fx/record : persist the user's already-broadcast tx for job history
#      All signing + broadcast happens client-side via the Privy embedded wallet
#      on Mantle. No Turnkey, no partner role, no FMA REST.
#
# Why not 7702 (yet)?
#   We use 7702 for Add Money on Arb Sepolia (which has known Pectra/7702
#   support + a confirmed Ambire delegate). Mantle Sepolia 7702 status is
#   uncertain, and the user already has MNT capability for gas — direct
#   user-signed call is the safest validation path. 7702 on Mantle can be a
#   follow-up optimisation once UR confirms a delegate address there.
#
# Future migration to Managed Custody: if/when UR moves us to MC, the
# vault would hold fiat balances and FX would route through the Turnkey-
# signed /api/fma/v1/fx-exchange path. We've left ur_api.{get,submit}_fx_async
# in place (marked DEPRECATED) so the cutover is a one-import change.
# ---------------------------------------------------------------------------


class _UrFxQuoteRequest(BaseModel):
    """FX quote input. ``from_currency`` and ``to_currency`` are ISO codes
    (e.g. "USD", "EUR"). ``input_amount`` is a decimal string in whole fiat
    units ("10" = 10 USD24). Server converts to raw 2-decimal units."""

    from_currency: str
    to_currency: str
    input_amount: str


class _UrFxRecordRequest(BaseModel):
    """Persist an FX swap that the client has already broadcast on Mantle.

    Frontend submits BOTH the approve and the swap calldata via the Privy
    embedded wallet (two user signatures, two confirmations). On completion
    it calls this endpoint so we can attach the tx hash to a job row for
    history + future reconciliation against UR transaction webhooks.
    """

    idempotency_key: str
    from_currency: str
    to_currency: str
    amount: str                       # decimal string of the FROM currency
    expected_output_amount: str       # decimal string of the TO currency
    swap_tx_hash: str                 # 0x... — the moneyExchangeExactIn tx
    approve_tx_hash: Optional[str] = None  # optional; first-time/unlimited approve
    exchange_rate: Optional[str] = None    # decimal string, for telemetry only


def _fiat_to_raw_units(amount: str) -> int:
    """Decimal-string fiat amount (USD24 has 2 decimals) -> raw int units.

    Floors so we never over-debit the user. UR's fiat tokens reject anything
    other than 2-decimal precision at the contract level.
    """
    from decimal import Decimal as _D
    quant = _D("0.01")
    floored = (_D(str(amount)).quantize(quant, rounding="ROUND_DOWN"))
    return int(floored * (_D(10) ** ur_chain.FIAT_TOKEN_DECIMALS))


@api_router.get("/ur/fx/info", tags=["ur"])
async def ur_fx_info(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return everything the frontend needs to construct the two on-chain
    txs (approve + moneyExchangeExactIn) without hardcoding addresses.

    Read-only; doesn't even consume the URID. Returns Mantle as the canonical
    FX chain plus the relay address + all configured fiat token addresses.
    """
    chain = ur_chain.canonical_mantle_chain()
    tokens: Dict[str, str] = {}
    # Surface every fiat token that is BOTH deployed on this chain AND marked
    # valid by the relay (so the client can render the picker without making
    # a separate call per currency).
    candidates = ["USD24", "EUR24", "CHF24", "GBP24", "CNH24", "SGD24", "JPY24", "HKD24"]
    for sym in candidates:
        try:
            addr = ur_chain.get_fiat_token(chain, sym)
        except ValueError:
            continue
        try:
            valid = await asyncio.to_thread(
                ur_chain.read_fx_token_validity, chain, addr
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ur_fx_info: validXXX24Tokens(%s) failed: %s", sym, exc)
            valid = False
        if valid:
            tokens[sym] = addr

    relay = ur_chain.get_relay_contract(chain)

    # Probe a single quote (1 USD24 -> EUR24) just to surface live params
    # (paused, marketClosed, minUsdRaw, feeBps) without a second round-trip.
    try:
        usd_addr = ur_chain.get_fiat_token(chain, "USD24")
        sample = await asyncio.to_thread(
            ur_chain.read_fx_quote,
            chain,
            input_token=usd_addr,
            output_token=tokens.get("EUR24", usd_addr),
            input_amount_raw=100,  # 1.00 USD24
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("ur_fx_info: sample quote failed: %s", exc)
        sample = {}

    # Surface the Ambire 7702 delegate so the frontend can build SetCode
    # authorizations + check delegation status. Missing = chain not wired
    # for gasless FX yet (the frontend should fall back to user-gas or
    # show a "coming soon" state).
    try:
        ambire_delegate = ur_chain.get_ambire_7702_delegate(chain)
    except ValueError:
        ambire_delegate = None

    return {
        "chain_id": chain,
        "relay_address": relay,
        "fiat_tokens": tokens,           # { "USD24": "0x...", "EUR24": "0x...", ... }
        "decimals": ur_chain.FIAT_TOKEN_DECIMALS,
        "min_usd_raw": sample.get("min_usd_raw"),
        "fee_bps": sample.get("fee_bps"),
        "market_closed": sample.get("market_closed"),
        "paused": sample.get("paused"),
        # Gasless-via-7702 prerequisites. Both fields are mandatory for
        # the relayer flow; if either is null the frontend MUST disable
        # Convert and surface a clear "not available on this chain"
        # message rather than silently broadcasting user-gas tx.
        "ambire_7702_delegate": ambire_delegate,
        "designator_prefix": ur_chain.EIP7702_DESIGNATOR_PREFIX,
    }


@api_router.post("/ur/fx/quote", tags=["ur"])
async def ur_fx_quote(
    req: _UrFxQuoteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Read a live FX quote directly from Fiat24CryptoRelay on Mantle.

    Mirrors the contract's own arithmetic so the displayed output equals what
    the on-chain swap will actually pay out (to the wei). No partner auth,
    no FMA REST — pure ``eth_call`` against the relay proxy.
    """
    # Caller URID isn't strictly required for an on-chain read, but keep the
    # auth gate so unauthenticated clients can't farm our backend RPC quota.
    await _resolve_caller_urid(auth_user)

    src = req.from_currency.upper()
    dst = req.to_currency.upper()
    if src == dst:
        raise HTTPException(status_code=400, detail="from_currency and to_currency must differ")
    try:
        raw_in = _fiat_to_raw_units(req.input_amount)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid input_amount: {exc}")
    if raw_in <= 0:
        raise HTTPException(status_code=400, detail="input_amount must be positive")

    chain = ur_chain.canonical_mantle_chain()
    try:
        in_addr = ur_chain.get_fiat_token(chain, src)
        out_addr = ur_chain.get_fiat_token(chain, dst)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        q = await asyncio.to_thread(
            ur_chain.read_fx_quote,
            chain,
            input_token=in_addr,
            output_token=out_addr,
            input_amount_raw=raw_in,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("ur_fx_quote: on-chain read failed")
        raise HTTPException(status_code=503, detail=f"On-chain quote unavailable: {exc}")

    if q.get("paused"):
        raise HTTPException(status_code=503, detail="FX relay is paused on-chain")

    # Pre-flight the minimum the contract will accept. Surface a clear 400
    # so the UI can render a friendly "minimum 4 USD" hint without waiting
    # for the on-chain revert.
    if q["usd_amount_raw"] < q["min_usd_raw"]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Amount below minimum: ${q['usd_amount_raw']/100:.2f} USD24 "
                f"equivalent < ${q['min_usd_raw']/100:.2f} USD24 minimum"
            ),
        )

    dec = ur_chain.FIAT_TOKEN_DECIMALS
    return {
        "chain_id": chain,
        "data": {
            "fromCurrency": src,
            "toCurrency": dst,
            "inputAmount": f"{q['input_amount_raw'] / (10**dec):.{dec}f}",
            "outputAmount": f"{q['output_amount_raw'] / (10**dec):.{dec}f}",
            "exchangeRate": f"{q['effective_rate_raw'] / 10000:.6f}",
            "spread": f"{q['spread_raw'] / 10000:.4f}",
            "rawSpreadBps": 10000 - q["spread_raw"],   # informational
            "feeBps": q["fee_bps"],
            "minUsdAmount": f"{q['min_usd_raw'] / 100:.2f}",
            "marketClosed": q["market_closed"],
        },
        # Echo raw integer values too — the client uses these directly as
        # contract arguments without any FP math.
        "raw": {
            "inputAmount": str(q["input_amount_raw"]),
            "outputAmount": str(q["output_amount_raw"]),
            "exchangeRate": str(q["exchange_rate_raw"]),
            "spread": str(q["spread_raw"]),
            "effectiveRate": str(q["effective_rate_raw"]),
            "minUsd": str(q["min_usd_raw"]),
        },
        "addresses": {
            "relay": ur_chain.get_relay_contract(chain),
            "input_token": in_addr,
            "output_token": out_addr,
        },
    }


# Short TTL cache for on-chain FX→USD reads. Rates are not user-specific;
# caching cuts Mantle RPC load during balance polling without affecting
# balance amounts (those come from UR's balance API, not this endpoint).
_fx_usd_rates_cache: Dict[str, Tuple[float, Dict[str, float]]] = {}
_FX_USD_RATES_CACHE_TTL_SEC = 60.0
_fx_usd_rates_cache_lock = asyncio.Lock()


def _fx_usd_rates_cache_key(chain_id: int, codes: List[str]) -> str:
    normalized = sorted({c.strip().upper() for c in codes if c.strip()})
    return f"{chain_id}:{','.join(normalized)}"


@api_router.get("/ur/fx/usd-rates", tags=["ur"])
async def ur_fx_usd_rates(
    currencies: str = Query(..., description="Comma-separated ISO codes, e.g. 'USD,EUR,CHF'"),
    chain_id: Optional[int] = Query(None, description="Defaults to canonical Mantle chain"),
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Return the USD-equivalent rate of each requested currency.

    Source of truth is ``Fiat24CryptoRelay.getExchangeRate`` on Mantle —
    the same contract that executes Convert swaps. Using these rates for
    the dashboard total guarantees the displayed USD estimate matches
    what an actual on-chain redemption would settle at (modulo a small
    bid/ask spread), instead of naively treating 1 EUR as 1 USD.

    The endpoint is auth-gated. Responses are cached briefly (per chain +
    currency set) to avoid hammering Mantle RPC on balance polls.
    """
    await _resolve_caller_urid(auth_user)
    chain = int(chain_id) if chain_id else ur_chain.canonical_mantle_chain()
    codes = [c.strip() for c in (currencies or "").split(",") if c.strip()]
    if not codes:
        raise HTTPException(status_code=400, detail="`currencies` must not be empty")

    cache_key = _fx_usd_rates_cache_key(chain, codes)
    now = time.monotonic()
    cached = _fx_usd_rates_cache.get(cache_key)
    if cached is not None and (now - cached[0]) < _FX_USD_RATES_CACHE_TTL_SEC:
        return {"chain_id": chain, "rates": cached[1]}

    async with _fx_usd_rates_cache_lock:
        cached = _fx_usd_rates_cache.get(cache_key)
        now = time.monotonic()
        if cached is not None and (now - cached[0]) < _FX_USD_RATES_CACHE_TTL_SEC:
            return {"chain_id": chain, "rates": cached[1]}
        try:
            rates = await asyncio.to_thread(ur_chain.read_fx_usd_rates, chain, codes)
        except Exception as exc:
            logger.warning("ur_fx_usd_rates: read failed: %s", exc)
            raise HTTPException(status_code=503, detail=f"On-chain rate read failed: {exc}")
        _fx_usd_rates_cache[cache_key] = (time.monotonic(), rates)

    return {
        "chain_id": chain,
        "rates": rates,
    }


@api_router.post("/ur/fx/record", tags=["ur"])
async def ur_fx_record(
    req: _UrFxRecordRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Persist a user-broadcast FX swap into the jobs table.

    Frontend has already submitted the on-chain swap via Privy. This endpoint
    just records it so it shows up in transaction history alongside deposits
    and (eventually) withdrawals, and so we have a stable id for retry /
    receipt-polling. No on-chain work happens here.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    ur_id = await _resolve_caller_urid(auth_user)

    src = req.from_currency.upper()
    dst = req.to_currency.upper()
    if src == dst:
        raise HTTPException(status_code=400, detail="from_currency and to_currency must differ")
    tx_hash = (req.swap_tx_hash or "").strip().lower()
    if not tx_hash.startswith("0x") or len(tx_hash) != 66:
        raise HTTPException(status_code=400, detail="swap_tx_hash must be a 0x-prefixed 66-char hash")

    mantle_chain = ur_chain.canonical_mantle_chain()
    job = await asyncio.to_thread(
        ur_db.create_job,
        supabase,
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        kind=ur_db.JOB_KIND_FX,
        source_chain_id=mantle_chain,
        source_token=src,
        source_amount=str(req.amount),
        target_chain_id=mantle_chain,
        target_currency=dst,
        target_amount=str(req.expected_output_amount),
        idempotency_key=req.idempotency_key,
    )
    if job.get("_idempotent_hit"):
        # Idempotent retry — frontend already got this job once.
        return {"job": _serialise_job(job), "idempotent": True}

    # Atomically attach the tx hash + advance to `submitted`. The eventual
    # webhook / lazy receipt reconciler will move it to `completed` once the
    # Mantle tx confirms.
    await asyncio.to_thread(
        ur_db.transition_status_atomic,
        supabase,
        job_id=job["id"],
        expected_status=ur_db.JOB_STATUS_CREATED,
        new_status=ur_db.JOB_STATUS_SUBMITTED,
        extra={"source_tx_hash": tx_hash},
    )

    latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
    return {
        "job": _serialise_job(latest or job),
        "tx_hash": tx_hash,
        "via": "user_signed_on_chain",
    }


# --------------------------------------------------------------------------- #
# /ur/fx/execute-7702 — gasless Convert via EIP-7702 + Ambire batched execute
#
# Architecture mirror of /ur/deposit/execute-7702 (see ~line 8418). The same
# Ambire delegate pattern, the same `dispatch_7702_batch_job` dispatcher, the
# same FSM transitions — only the `calls` payload differs (FX uses
# [fromToken.approve(relay, amount), relay.moneyExchangeExactIn(...)] vs.
# Add Money's [usdc.approve, deposit.depositTokenViaUsdc]).
#
# The frontend has already:
#   1. (Conditional) Signed an EIP-7702 SetCode authorization pointing the
#      EOA at the Mantle Sepolia Ambire delegate (0x65a1…6dab — deployed by
#      us, see `backend/deploy_ambire_mantle.py`).
#   2. Built the calls array — encoded via viem's `encodeFunctionData`.
#   3. Signed `computeAmbireBatchHash(eoa, chainId, nonce, calls)` via
#      Privy's `secp256k1_sign` with v normalised to 27/28.
#
# The relayer (UR_RELAYER_PRIVKEY_TESTNET, funded with ~2.88 MNT after the
# delegate deploy) pays gas in MNT.
# --------------------------------------------------------------------------- #


class _UrFx7702ExecuteRequest(BaseModel):
    """Request body for `POST /ur/fx/execute-7702`."""

    idempotency_key: str
    source_chain_id: int            # must be Mantle Sepolia (5003) for now
    from_currency: str              # "USD" / "EUR" / "CHF" / ...
    to_currency: str
    source_amount: str              # human decimal, e.g. "20.00"
    target_amount: Optional[str] = None  # expected output, decimal
    user_address: str               # the EOA being delegated
    calls: List[_Ur7702Call]        # [approve, moneyExchangeExactIn]
    batch_signature: str            # 65-byte hex over Ambire batch hash
    authorization: Optional[_Ur7702Authorization] = None  # omit if delegated
    quote_expires_at: Optional[str] = None  # optional; FX quote is client-held today


@api_router.post("/ur/fx/execute-7702", tags=["ur"])
async def ur_fx_execute_7702(
    req: _UrFx7702ExecuteRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Sponsor a gasless Convert via the UR relayer pool.

    Idempotent on `(privy_user_id, idempotency_key)` — a retried request
    short-circuits to the existing job row without re-broadcasting.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    if not req.calls:
        raise HTTPException(
            status_code=400,
            detail="`calls` must contain at least one entry (approve + swap)",
        )
    src = req.from_currency.upper()
    dst = req.to_currency.upper()
    if src == dst:
        raise HTTPException(
            status_code=400,
            detail="from_currency and to_currency must differ",
        )

    # Only Mantle Sepolia is wired for gasless FX today. Mainnet needs its
    # own Ambire delegate deploy + funded relayer pool. Hard reject so the
    # frontend never silently broadcasts a user-gas fallback when the relayer
    # path isn't viable.
    canonical_mantle = ur_chain.canonical_mantle_chain()
    if int(req.source_chain_id) != canonical_mantle:
        raise HTTPException(
            status_code=400,
            detail=(
                f"FX 7702 is currently only available on chain "
                f"{canonical_mantle}; got {req.source_chain_id}"
            ),
        )

    link = await _resolve_caller_link(auth_user)
    ur_id = int(link["ur_id"])
    # Same relayer-safety gates as the deposit path: bind the sponsored EOA to
    # the URID owner and rate-limit job creation.
    await _assert_user_address_is_urid_owner(
        link=link, ur_id=ur_id, user_address=req.user_address
    )
    await _assert_caller_owns_wallet(auth_user, req.user_address)
    _assert_quote_not_expired(req.quote_expires_at)
    await _enforce_ur_job_rate_limit(auth_user.user_id)

    job = await asyncio.to_thread(
        ur_db.create_job,
        supabase,
        privy_user_id=auth_user.user_id,
        ur_id=ur_id,
        kind=ur_db.JOB_KIND_FX,
        source_chain_id=int(req.source_chain_id),
        source_token=src,
        source_amount=str(req.source_amount),
        target_chain_id=int(req.source_chain_id),  # FX is in-chain
        target_currency=dst,
        target_amount=str(req.target_amount) if req.target_amount else None,
        idempotency_key=req.idempotency_key,
    )

    if job.get("_idempotent_hit"):
        return {"job": _serialise_job(job), "idempotent": True}

    transitioned = await asyncio.to_thread(
        ur_db.transition_status_atomic,
        supabase,
        job_id=job["id"],
        expected_status=ur_db.JOB_STATUS_CREATED,
        new_status=ur_db.JOB_STATUS_AWAITING_USER_SIG,
    )
    if not transitioned:
        # Another replica picked it up between our INSERT and UPDATE. Bail
        # without re-dispatching; the original dispatcher owns it now.
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {"job": _serialise_job(latest or job)}

    authorization_payload: Optional[Dict[str, Any]] = None
    if req.authorization is not None:
        authorization_payload = {
            "chain_id": int(req.authorization.chain_id),
            "address": req.authorization.address,
            "nonce": int(req.authorization.nonce),
            "y_parity": int(req.authorization.y_parity),
            "r": req.authorization.r,
            "s": req.authorization.s,
        }

    calls_payload: List[Dict[str, Any]] = [
        {"to": c.to, "value": c.value, "data": c.data} for c in req.calls
    ]

    try:
        result = await asyncio.to_thread(
            ur_relayer.dispatch_7702_batch_job,
            supabase,
            job_id=job["id"],
            user_evm_address=req.user_address,
            ur_id=ur_id,
            source_chain_id=int(req.source_chain_id),
            calls=calls_payload,
            user_signature=req.batch_signature,
            authorization=authorization_payload,
            # FX is cheap: approve (~55k) + moneyExchangeExactIn (~250k).
            # 750k gives 2x headroom without overspending. The relayer's
            # MNT balance covers ~10k swaps at current gas price even
            # without refills.
            gas_limit=750_000,
        )
    except ur_relayer.URRelayerError as exc:
        await asyncio.to_thread(
            ur_db.fail_job,
            supabase,
            job_id=job["id"],
            error_code="relayer_unavailable",
            error_message=str(exc),
        )
        latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
        return {
            "job": _serialise_job(latest or job),
            "dispatch_error": str(exc),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("UR 7702 FX dispatch crashed for job %s", job["id"])
        await asyncio.to_thread(
            ur_db.fail_job,
            supabase,
            job_id=job["id"],
            error_code="dispatch_crashed",
            error_message=str(exc),
        )
        raise HTTPException(status_code=500, detail="7702 FX dispatch failed")

    latest = await asyncio.to_thread(ur_db.get_job, supabase, job["id"])
    return {
        "job": _serialise_job(latest or job),
        "tx_hash": result.get("tx_hash"),
        "relayer_address": result.get("relayer_address"),
        "via": result.get("via"),
    }


@api_router.get("/ur/jobs", tags=["ur"])
async def ur_jobs_list(
    only_pending: bool = Query(False, alias="onlyPending"),
    limit: int = Query(25, ge=1, le=100),
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """List the caller's deposit + withdraw jobs (newest first)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    rows = await asyncio.to_thread(
        ur_db.list_user_jobs,
        supabase,
        privy_user_id=auth_user.user_id,
        limit=int(limit),
        only_pending=bool(only_pending),
    )
    return {"jobs": [_serialise_job(r) for r in rows]}


# ---------------------------------------------------------------------------
# LayerZero bridge delivery status (Add Money USDC -> USD24 cross-chain hop)
# ---------------------------------------------------------------------------
#
# Why this exists: a deposit's SOURCE tx (Arbitrum) succeeding does NOT mean the
# user was credited — the USD24 only mints once LayerZero delivers + executes
# the message on Mantle. On testnet that executor can lag minutes→hours. The app
# shows a "+X USD incoming" pill after the source tx; without a real delivery
# signal that pill used to drop on a blind timer, making a still-in-flight
# deposit look lost. This endpoint reports the actual LayerZero delivery state
# for a source tx so the pill can persist until the credit truly lands (or a
# genuine failure is observed). Funds are never lost — a verified LZ message is
# stored and eventually executed — so the only states we surface are:
#   inflight   — sent/verified/committing, credit pending (keep the pill up)
#   delivered  — executed on the destination (credit landed or imminent)
#   failed     — destination execution reverted (rare; needs a manual retry)
#   unknown    — not yet indexed by LayerZeroScan (treat as inflight client-side)
_LZ_TESTNET_CHAIN_IDS = frozenset({421614, 11155111, 5003, 80002, 84532, 11155420})


def _lz_scan_bases(source_chain_id: int) -> tuple[str, str]:
    """Return (api_base, ui_base) for LayerZeroScan, testnet vs mainnet."""
    env = (os.getenv("UR_ENV", "") or "").strip().lower()
    is_testnet = env == "testnet" or int(source_chain_id) in _LZ_TESTNET_CHAIN_IDS
    if is_testnet:
        return ("https://scan-testnet.layerzero-api.com", "https://testnet.layerzeroscan.com")
    return ("https://scan.layerzero-api.com", "https://layerzeroscan.com")


def _normalise_lz_status(message: Dict[str, Any]) -> str:
    """Collapse LayerZeroScan's message record into our 4-state enum."""
    name = str(((message.get("status") or {}).get("name")) or "").upper()
    dest = str(((message.get("destination") or {}).get("status")) or "").upper()
    if name == "DELIVERED" or dest == "SUCCEEDED":
        return "delivered"
    if "FAILED" in name or dest == "FAILED":
        return "failed"
    return "inflight"


def _source_tx_reverted(tx_hash: str, chain_id: int) -> Optional[bool]:
    """Return True if the source tx reverted, False if it succeeded, None if
    it isn't mined yet / can't be read.

    LayerZeroScan only ever indexes a message when the source tx SUCCEEDS (the
    `lzSend` fired). A reverted source tx therefore produces no LZ message —
    indistinguishable from "not yet indexed" — so the bridge-status endpoint
    would sit at `unknown` (fail-open) forever and the client's "incoming"
    banner would hang until its multi-hour safety cap. Reading the source
    receipt lets us turn that ambiguous `unknown` into a definitive `failed`.
    """
    h = (tx_hash or "").strip().lower()
    if not h.startswith("0x") or len(h) != 66:
        return None
    try:
        w3 = ur_chain.make_web3(int(chain_id))
        receipt = w3.eth.get_transaction_receipt(h)
    except TransactionNotFound:
        return None  # still pending in the mempool
    except Exception as exc:  # noqa: BLE001
        logger.info("source receipt read failed (tx=%s): %s", h, exc)
        return None
    receipt_status = getattr(receipt, "status", None)
    if receipt_status is None and isinstance(receipt, dict):
        receipt_status = receipt.get("status")
    if receipt_status is None:
        return None
    return int(receipt_status) == 0


def _lookup_lz_delivery_status(tx_hash: str, chain_id: int) -> str:
    """Best-effort LayerZero delivery state for a source-chain deposit tx."""
    h = (tx_hash or "").strip().lower()
    if not h.startswith("0x") or len(h) != 66:
        return "unknown"
    api_base, _ = _lz_scan_bases(int(chain_id))
    url = f"{api_base}/v1/messages/tx/{h}"
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(url)
        if resp.status_code == 404:
            return "unknown"
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.info("LZ delivery lookup failed (tx=%s): %s", h, exc)
        return "unknown"

    messages = payload.get("data") if isinstance(payload, dict) else None
    if not messages:
        return "unknown"
    msg = messages[0] if isinstance(messages, list) else messages
    return _normalise_lz_status(msg if isinstance(msg, dict) else {})


def _emit_deposit_credit_inbox_fallback(job: Dict[str, Any]) -> None:
    """Record a "Money added" inbox row for a deposit we settled OURSELVES.

    "Money added" notifications normally come from UR's `transaction_v2`
    webhook. On testnet (and rarely mainnet) that webhook can be late or never
    arrive — verified 2026-06-15: deposit job feffc273 credited 4.97 USD24 on
    Mantle, our LZ reconcile flipped it to `completed`, yet UR sent no webhook,
    so the user got no bell/inbox notification.

    This fallback fires the instant OUR reconcile proves delivery, so the inbox
    row never depends solely on UR's webhook. It is fully idempotent with the
    webhook because both key on the SOURCE tx hash (`tx:{source_tx_hash}` — the
    exact value UR puts in the webhook `txHash` for a CRYPTO_DEPOSIT): whichever
    path fires first inserts the row, the other is swallowed by the unique
    (user_id, dedupe_key) index. Inbox-only by design — no push — since pushes
    aren't deduped and the webhook (when it does arrive) owns the push.

    Best-effort: any failure is logged and never breaks reconciliation.
    """
    if not supabase:
        return
    try:
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        if not tx_hash:
            return
        link = ur_db.get_link_by_ur_id(supabase, int(job.get("ur_id")))
        uid = (link or {}).get("privy_user_id")
        if not uid:
            return
        currency = _fmt_fiat_currency(str(job.get("target_currency") or "")) or "USD"
        raw_amt = job.get("target_amount")
        amount = ""
        if raw_amt is not None:
            try:
                amount = f"{float(str(raw_amt)):.2f}"
            except (TypeError, ValueError):
                amount = ""
        body = (
            f"{amount} {currency} added to your account".strip()
            if amount else "Your deposit has been credited"
        )
        ur_db.insert_notification(
            supabase,
            user_id=uid,
            ur_id=int(job.get("ur_id")),
            category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="deposit",
            title="💰 Money added",
            body=body,
            data={
                "amount": amount,
                "currency": currency,
                "txType": "CRYPTO_DEPOSIT",
                "status": "CONFIRMED",
                "txHash": tx_hash,
                "chainId": str(job.get("source_chain_id") or ""),
                "via": "lz_reconcile",
            },
            dedupe_key=f"tx:{tx_hash}",
        )
    except Exception:  # noqa: BLE001 — inbox fallback is best-effort
        logger.exception(
            "deposit credit inbox fallback failed for job %s", job.get("id")
        )


def _emit_fx_credit_inbox_fallback(job: Dict[str, Any]) -> None:
    """Record a "Converted" inbox row for an FX swap we settled OURSELVES.

    On-chain Convert (External Wallet Access via Fiat24CryptoRelay on Mantle)
    has NO LayerZero hop and NO UR webhook for the swap event, so the inbox
    would otherwise never get a conversion row. We fire it the instant our own
    receipt reconcile proves the swap mined.

    Inbox-only BY DESIGN — Convert is a self-initiated, in-app action, so it
    must never push to the device (matches the `transaction_v2` FX branch,
    which also records-but-never-pushes). Idempotent with UR's (rare) v2 FX
    webhook via the shared `tx:{source_hash}` dedupe key + matching
    `conversion` type: whichever path inserts first wins, the other is a no-op.

    Best-effort: any failure is logged and never breaks reconciliation.
    """
    if not supabase:
        return
    try:
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        link = ur_db.get_link_by_ur_id(supabase, int(job.get("ur_id")))
        uid = (link or {}).get("privy_user_id")
        if not uid:
            return
        from_ccy = _fmt_fiat_currency(str(job.get("source_token") or ""))
        to_ccy = _fmt_fiat_currency(str(job.get("target_currency") or ""))
        in_amt = _fmt_job_amount(job.get("source_amount"))
        out_amt = _fmt_job_amount(job.get("target_amount"))
        if in_amt and from_ccy and out_amt and to_ccy:
            body = f"{in_amt} {from_ccy} → {out_amt} {to_ccy}"
        elif out_amt and to_ccy:
            body = f"Converted to {out_amt} {to_ccy}"
        else:
            body = "Currency conversion completed"
        ur_db.insert_notification(
            supabase,
            user_id=uid,
            ur_id=int(job.get("ur_id")),
            category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="conversion",
            title="Converted",
            body=body,
            data={
                "inputAmount": in_amt,
                "inputCurrency": from_ccy,
                "outputAmount": out_amt,
                "outputCurrency": to_ccy,
                "txType": "FRX",
                "status": "CONFIRMED",
                "txHash": tx_hash,
                "chainId": str(job.get("source_chain_id") or ""),
                "via": "fx_reconcile",
            },
            dedupe_key=(f"tx:{tx_hash}" if tx_hash else f"fxjob:{job.get('id')}"),
        )
    except Exception:  # noqa: BLE001 — inbox fallback is best-effort
        logger.exception(
            "fx credit inbox fallback failed for job %s", job.get("id")
        )


def _emit_transfer_inbox_fallback(job: Dict[str, Any]) -> None:
    """Record the SENDER's "Money sent" inbox row for a URID→URID transfer.

    On testnet UR's transaction webhook is often late or missing. This
    guarantees the sender's inbox row when our receipt reconcile proves the
    transfer mined. Inbox-only — senders initiated the flow in-app and do
    not need a device push (see ``_notify_ur_transaction_p2p`` OUT leg and
    ``_notify_transfer_recipient_from_job`` for the recipient path).

    Fully idempotent with the webhook: same ``(user_id, tx:{source_hash})``
    dedupe key and ``transfer_out`` type.

    Best-effort: any failure is logged and never breaks reconciliation.
    """
    if not supabase:
        return
    try:
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        ur_id = int(job.get("ur_id"))
        link = ur_db.get_link_by_ur_id(supabase, ur_id)
        uid = (link or {}).get("privy_user_id")
        if not uid:
            return
        currency = _fmt_fiat_currency(
            str(job.get("target_currency") or job.get("source_token") or "")
        )
        raw_amt = (
            job.get("target_amount")
            if job.get("target_amount") is not None
            else job.get("source_amount")
        )
        amount = _fmt_job_amount(raw_amt)
        # The recipient URID is stored in `quote_id` at transfer-execute time.
        counterparty: Optional[int] = None
        try:
            counterparty = int(str(job.get("quote_id") or "").strip())
        except (TypeError, ValueError):
            counterparty = None
        label: Optional[str] = None
        if counterparty is not None:
            try:
                label = ur_db.get_p2p_recipient_label(
                    supabase, privy_user_id=uid, recipient_ur_id=counterparty,
                )
            except Exception:  # noqa: BLE001
                label = None
        who = _p2p_party_display(counterparty, label)
        body = (
            f"Sent {amount} {currency} to {who}".strip()
            if amount else f"You sent money to {who}"
        )
        ur_db.insert_notification(
            supabase,
            user_id=uid,
            ur_id=ur_id,
            category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="transfer_out",
            title="Money sent",
            body=body,
            data={
                "amount": amount,
                "currency": currency,
                "txType": "P2P",
                "status": "CONFIRMED",
                "counterpartyUrId": counterparty,
                "counterpartyLabel": label or "",
                "txHash": tx_hash,
                "chainId": str(job.get("source_chain_id") or ""),
                "via": "transfer_reconcile",
            },
            dedupe_key=(f"tx:{tx_hash}" if tx_hash else f"transferjob:{job.get('id')}"),
        )
    except Exception:  # noqa: BLE001 — inbox fallback is best-effort
        logger.exception(
            "transfer inbox fallback failed for job %s", job.get("id")
        )


def _emit_cash_out_inbox_fallback(job: Dict[str, Any]) -> None:
    """Record a "Money sent" inbox row for withdraw (digital assets) or payout.

    Covers:
      • ``withdraw`` — USD24/EUR24/… → USDC to the user's wallet (Withdraw
        bottom sheet / "Digital assets" in the withdraw chooser).
      • ``payout``   — fiat → external bank (Send bottom sheet / "Bank
        transfer" in the withdraw chooser).

    UR's outgoing webhook is often missing on testnet; without this fallback
    the user sees nothing in the bank bell after a successful cash-out.
    Inbox-only (no push) — same policy as the webhook OUT branch.

    Idempotent via ``tx:{source_hash}`` + ``payment_out`` type.
    """
    if not supabase:
        return
    kind = (job.get("kind") or "").lower()
    if kind not in (ur_db.JOB_KIND_WITHDRAW, ur_db.JOB_KIND_PAYOUT):
        return
    try:
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        ur_id = int(job.get("ur_id"))
        link = ur_db.get_link_by_ur_id(supabase, ur_id)
        uid = (link or {}).get("privy_user_id")
        if not uid:
            return
        from_ccy = _fmt_fiat_currency(str(job.get("source_token") or ""))
        amount = _fmt_job_amount(job.get("source_amount"))
        if kind == ur_db.JOB_KIND_WITHDRAW:
            usdc_amt = _fmt_job_amount(job.get("target_amount"))
            if amount and from_ccy and usdc_amt:
                body = f"{amount} {from_ccy} → {usdc_amt} USDC to your wallet"
            elif amount and from_ccy:
                body = f"{amount} {from_ccy} sent to your wallet as USDC"
            else:
                body = "Cash sent to your wallet as USDC"
            tx_type = "CTF"
        else:
            if amount and from_ccy:
                body = f"{amount} {from_ccy} sent to your bank account"
            else:
                body = "Money sent to your bank account"
            tx_type = "CWD"
        ur_db.insert_notification(
            supabase,
            user_id=uid,
            ur_id=ur_id,
            category=ur_db.NOTIF_CATEGORY_TRANSACTION,
            ntype="payment_out",
            title="Money sent",
            body=body.strip(),
            data={
                "amount": amount,
                "currency": from_ccy,
                "txType": tx_type,
                "status": "CONFIRMED",
                "txHash": tx_hash,
                "chainId": str(job.get("source_chain_id") or ""),
                "destChainId": str(job.get("target_chain_id") or ""),
                "via": f"{kind}_reconcile",
            },
            dedupe_key=(f"tx:{tx_hash}" if tx_hash else f"{kind}job:{job.get('id')}"),
        )
    except Exception:  # noqa: BLE001 — inbox fallback is best-effort
        logger.exception(
            "cash-out inbox fallback failed for job %s", job.get("id")
        )


async def _notify_transfer_recipient_from_job(job: Dict[str, Any]) -> None:
    """Inbox + push for the RECIPIENT when a P2P transfer job completes locally.

    UR's transaction webhook normally fans out both legs (IN + OUT), but on
    testnet it is often late or missing — the sender still gets an inbox row
    from ``_emit_transfer_inbox_fallback``, while the recipient got nothing.
    This path guarantees the recipient sees "Money received" + a device push.

    Idempotent: shares the webhook's ``tx:{source_hash}`` dedupe key on the
    recipient's user_id. Push fires only when we actually insert a new inbox
    row (first caller wins — webhook or this fallback).
    """
    if not supabase:
        return
    try:
        tx_hash = (job.get("source_tx_hash") or "").strip().lower()
        sender_urid = int(job.get("ur_id"))
        try:
            recipient_urid = int(str(job.get("quote_id") or "").strip())
        except (TypeError, ValueError):
            return
        if recipient_urid == sender_urid:
            return
        recipient_link = await asyncio.to_thread(
            ur_db.get_link_by_ur_id, supabase, recipient_urid,
        )
        recipient_uid = (recipient_link or {}).get("privy_user_id")
        if not recipient_uid:
            logger.info(
                "P2P recipient notify skipped — URID %s not linked in app",
                recipient_urid,
            )
            return
        currency = _fmt_fiat_currency(
            str(job.get("target_currency") or job.get("source_token") or "")
        )
        raw_amt = (
            job.get("target_amount")
            if job.get("target_amount") is not None
            else job.get("source_amount")
        )
        amount = _fmt_job_amount(raw_amt)
        label: Optional[str] = None
        try:
            label = await asyncio.to_thread(
                ur_db.get_p2p_recipient_label,
                supabase,
                privy_user_id=recipient_uid,
                recipient_ur_id=sender_urid,
            )
        except Exception:  # noqa: BLE001
            label = None
        who = _p2p_party_display(sender_urid, label)
        title = "💰 Money received"
        body = (
            f"Received {amount} {currency} from {who}".strip()
            if amount else f"{who} sent you money"
        )
        inserted = await asyncio.to_thread(
            lambda: ur_db.insert_notification(
                supabase,
                user_id=recipient_uid,
                ur_id=recipient_urid,
                category=ur_db.NOTIF_CATEGORY_TRANSACTION,
                ntype="transfer_in",
                title=title,
                body=body,
                data={
                    "amount": amount,
                    "currency": currency,
                    "txType": "P2P",
                    "status": "CONFIRMED",
                    "counterpartyUrId": sender_urid,
                    "counterpartyLabel": label or "",
                    "txHash": tx_hash,
                    "chainId": str(job.get("source_chain_id") or ""),
                    "via": "transfer_reconcile",
                },
                dedupe_key=(
                    f"tx:{tx_hash}" if tx_hash else f"transferin:{job.get('id')}"
                ),
            )
        )
        if not inserted:
            return  # webhook (or a prior poll) already recorded this row
        if not await _ur_push_pref_enabled(
            recipient_urid, "ur_transaction_alerts_enabled",
        ):
            logger.info(
                "P2P transfer_in inbox (push muted) URID %s (%s %s from %s)",
                recipient_urid, amount, currency, sender_urid,
            )
            return
        tokens = await _ur_push_tokens_for_urid(recipient_urid)
        for tok in tokens:
            await asyncio.to_thread(
                _send_push_notification, tok, title, body,
                {
                    "type": "ur_transfer_in",
                    "amount": amount,
                    "currency": currency,
                    "ur_id": str(recipient_urid),
                    "counterpartyUrId": str(sender_urid),
                    "counterpartyLabel": label or "",
                },
            )
        logger.info(
            "P2P transfer_in push/inbox to %d device(s) URID %s (%s %s from %s)",
            len(tokens), recipient_urid, amount, currency, sender_urid,
        )
    except Exception:  # noqa: BLE001 — recipient notify is best-effort
        logger.exception(
            "transfer recipient notify failed for job %s", job.get("id")
        )


def _reconcile_deposit_from_layerzero(
    job: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Advance a deposit job once LayerZero reports destination delivery."""
    if not supabase:
        return None
    if job.get("kind") != ur_db.JOB_KIND_DEPOSIT:
        return None
    status = job.get("status")
    if status not in {
        ur_db.JOB_STATUS_SUBMITTED,
        ur_db.JOB_STATUS_SOURCE_CONFIRMED,
        ur_db.JOB_STATUS_BRIDGED,
    }:
        return None
    tx_hash = (job.get("source_tx_hash") or "").strip().lower()
    chain_id = job.get("source_chain_id")
    if not tx_hash or not chain_id:
        return None

    lz = _lookup_lz_delivery_status(tx_hash, int(chain_id))
    if lz == "failed":
        extra = {
            "error_code": "lz_failed",
            "error_message": "LayerZero destination delivery failed.",
        }
        for src_status in (
            ur_db.JOB_STATUS_SUBMITTED,
            ur_db.JOB_STATUS_SOURCE_CONFIRMED,
            ur_db.JOB_STATUS_BRIDGED,
        ):
            try:
                advanced = ur_db.transition_status_atomic(
                    supabase,
                    job_id=job["id"],
                    expected_status=src_status,
                    new_status=ur_db.JOB_STATUS_FAILED,
                    extra=extra,
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "UR job %s LZ reconcile: transition %s->failed failed",
                    job.get("id"), src_status,
                )
                return None
            if advanced:
                return advanced
        return None

    if lz != "delivered":
        return None

    for src_status in (
        ur_db.JOB_STATUS_SUBMITTED,
        ur_db.JOB_STATUS_SOURCE_CONFIRMED,
        ur_db.JOB_STATUS_BRIDGED,
    ):
        try:
            advanced = ur_db.transition_status_atomic(
                supabase,
                job_id=job["id"],
                expected_status=src_status,
                new_status=ur_db.JOB_STATUS_COMPLETED,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "UR job %s LZ reconcile: transition %s->completed failed",
                job.get("id"), src_status,
            )
            return None
        if advanced:
            logger.info(
                "UR job %s LZ reconcile: %s -> completed (tx=%s)",
                job["id"], src_status, tx_hash,
            )
            # We just proved delivery ourselves — guarantee the "Money added"
            # inbox row even if UR's webhook never fires (idempotent via the
            # shared tx:{source_hash} dedupe key).
            _emit_deposit_credit_inbox_fallback(advanced)
            return advanced
    return None


@api_router.get("/ur/deposit/bridge-status", tags=["ur"])
async def ur_deposit_bridge_status(
    tx_hash: str = Query(..., alias="txHash", description="Source-chain deposit tx hash"),
    chain_id: int = Query(..., alias="chainId", description="Source chain id (e.g. 421614)"),
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Report LayerZero delivery status for an Add Money source tx.

    Best-effort + fail-open: if LayerZeroScan is unreachable or hasn't indexed
    the tx yet we return ``unknown`` (HTTP 200), so the client keeps the
    "incoming" pill alive rather than dropping it on a transient error.
    """
    h = (tx_hash or "").strip().lower()
    if not h.startswith("0x") or len(h) != 66:
        raise HTTPException(status_code=400, detail="Invalid txHash")

    api_base, ui_base = _lz_scan_bases(int(chain_id))
    scan_url = f"{ui_base}/tx/{h}"
    url = f"{api_base}/v1/messages/tx/{h}"

    # Step 1: ask LayerZeroScan. A real message means the source tx succeeded
    # and the bridge is in-flight / delivered / (rarely) failed downstream.
    status = "unknown"
    guid: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url)
        if resp.status_code != 404:
            resp.raise_for_status()
            payload = resp.json()
            messages = payload.get("data") if isinstance(payload, dict) else None
            if messages:
                msg = messages[0] if isinstance(messages, list) else messages
                status = _normalise_lz_status(msg if isinstance(msg, dict) else {})
                guid = msg.get("guid") if isinstance(msg, dict) else None
    except Exception as exc:  # noqa: BLE001 — fail-open to "unknown"
        logger.info("LZ bridge-status lookup failed (tx=%s): %s", h, exc)

    # Step 2: no LZ message yet ('unknown'). That's ambiguous — either the tx
    # is still indexing, or the SOURCE tx reverted (so no message will ever
    # exist). Read the source receipt to disambiguate; a reverted source tx
    # becomes a definitive 'failed' so the client drops the "incoming" banner
    # immediately instead of hanging until its safety cap.
    if status == "unknown":
        reverted = await asyncio.to_thread(_source_tx_reverted, h, int(chain_id))
        if reverted is True:
            return {"status": "failed", "scanUrl": scan_url, "guid": guid}

    return {"status": status, "scanUrl": scan_url, "guid": guid}


def _reconcile_deposit_from_source_receipt(
    job: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Best-effort: advance a `submitted` deposit job by reading the source
    chain receipt.

    Background: status transitions normally come from UR's webhook firing a
    `transaction` event after their indexer sees our source tx. In practice
    that webhook can be late or — on testnet without a registered URL — never
    arrive. Without this reconciler the mobile UI sits at "Waiting for
    confirmation" indefinitely even though the on-chain deposit succeeded.

    Logic:
      * Only runs while the job is still `submitted` (source tx broadcast).
      * Fetch the source-chain receipt.
      * Receipt missing -> tx still pending in the mempool; leave the job as-is.
      * Receipt status == 0 -> source tx reverted; flip job to `failed`.
      * Receipt status == 1 -> source tx succeeded on the origin chain.
        Mark as `source_confirmed` — NOT `completed`. The fiat credit on
        Mantle arrives later via LayerZero; `_reconcile_deposit_from_layerzero`
        (and/or UR's webhook) advances the job to `completed` once delivery
        lands so the Transactions tab stays at Pending until then.

    All RPC and DB calls are best-effort: any exception is logged and the job
    is returned unchanged so the frontend simply polls again.
    """
    if not supabase:
        return None
    if job.get("status") != ur_db.JOB_STATUS_SUBMITTED:
        return None
    if job.get("kind") != ur_db.JOB_KIND_DEPOSIT:
        return None
    tx_hash = (job.get("source_tx_hash") or "").strip().lower()
    if not tx_hash or not tx_hash.startswith("0x"):
        return None
    src_chain_id = job.get("source_chain_id")
    if not src_chain_id:
        return None

    try:
        w3 = ur_chain.make_web3(int(src_chain_id))
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        return None  # not mined yet — keep polling
    except Exception:  # noqa: BLE001
        logger.exception(
            "UR job %s lazy reconcile: receipt fetch failed (tx=%s)",
            job.get("id"), tx_hash,
        )
        return None

    receipt_status = getattr(receipt, "status", None)
    if receipt_status is None and isinstance(receipt, dict):
        receipt_status = receipt.get("status")
    if receipt_status is None:
        return None

    is_success = int(receipt_status) == 1
    new_status = (
        ur_db.JOB_STATUS_SOURCE_CONFIRMED if is_success else ur_db.JOB_STATUS_FAILED
    )
    extra: Dict[str, Any] = {}
    if not is_success:
        extra["error_code"] = "tx_reverted"
        extra["error_message"] = "Source-chain deposit transaction reverted."

    try:
        advanced = ur_db.transition_status_atomic(
            supabase,
            job_id=job["id"],
            expected_status=ur_db.JOB_STATUS_SUBMITTED,
            new_status=new_status,
            extra=extra,
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "UR job %s lazy reconcile: transition submitted->%s failed",
            job.get("id"), new_status,
        )
        return None
    if advanced:
        logger.info(
            "UR job %s lazy reconcile: submitted -> %s (receipt_status=%s, tx=%s)",
            job["id"], new_status, receipt_status, tx_hash,
        )
        return advanced
    return None


def _reconcile_fx_from_source_receipt(
    job: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Best-effort: advance a `submitted` FX job by reading the source receipt.

    Mirror of `_reconcile_deposit_from_source_receipt` for kind=fx jobs.
    On-chain FX (External Mode Convert via `Fiat24CryptoRelay` on Mantle)
    is purely in-chain — there's no LayerZero hop and no UR webhook for
    the swap event. So nothing was ever transitioning kind=fx rows from
    `submitted` → `completed`; they sat with `completed_at = NULL`
    forever even when the on-chain swap succeeded immediately.

    Logic mirrors the deposit version:
      * Receipt status == 1  → mark `completed` (atomic transition sets
        `completed_at = now()` via `transition_status_atomic`).
      * Receipt status == 0  → mark `failed` with `tx_reverted` code.
      * Receipt not yet mined → leave the job alone; client polls again.

    Any exception is logged and the job is returned unchanged so the
    client can keep polling.
    """
    if not supabase:
        return None
    if job.get("status") != ur_db.JOB_STATUS_SUBMITTED:
        return None
    if job.get("kind") != ur_db.JOB_KIND_FX:
        return None
    tx_hash = (job.get("source_tx_hash") or "").strip().lower()
    if not tx_hash or not tx_hash.startswith("0x"):
        return None
    src_chain_id = job.get("source_chain_id")
    if not src_chain_id:
        return None

    try:
        w3 = ur_chain.make_web3(int(src_chain_id))
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        return None
    except Exception:  # noqa: BLE001
        logger.exception(
            "UR FX job %s reconcile: receipt fetch failed (tx=%s)",
            job.get("id"), tx_hash,
        )
        return None

    receipt_status = getattr(receipt, "status", None)
    if receipt_status is None and isinstance(receipt, dict):
        receipt_status = receipt.get("status")
    if receipt_status is None:
        return None

    is_success = int(receipt_status) == 1
    new_status = (
        ur_db.JOB_STATUS_COMPLETED if is_success else ur_db.JOB_STATUS_FAILED
    )
    extra: Dict[str, Any] = {}
    if not is_success:
        extra["error_code"] = "tx_reverted"
        extra["error_message"] = "On-chain FX swap reverted."

    try:
        advanced = ur_db.transition_status_atomic(
            supabase,
            job_id=job["id"],
            expected_status=ur_db.JOB_STATUS_SUBMITTED,
            new_status=new_status,
            extra=extra,
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "UR FX job %s reconcile: transition submitted->%s failed",
            job.get("id"), new_status,
        )
        return None
    if advanced:
        logger.info(
            "UR FX job %s reconcile: submitted -> %s (receipt_status=%s, tx=%s)",
            job["id"], new_status, receipt_status, tx_hash,
        )
        if is_success:
            # On-chain Convert has no UR webhook — guarantee the "Converted"
            # inbox row ourselves the instant the swap mines. Inbox-only (no
            # device push); idempotent via the tx:{hash} dedupe key.
            _emit_fx_credit_inbox_fallback(advanced)
    return advanced


def _reconcile_onramp_from_source_receipt(
    job: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Best-effort: advance a `submitted` withdraw/payout job by reading the
    Mantle source receipt.

    Withdraw (USD24 -> USDC cash-out) and payout (USD24 -> bank) both submit a
    single Mantle-side tx via UR's `onramp-with-permit` / `payout-with-permit`,
    and UR returns that tx hash as `source_tx_hash`. Exactly like kind=fx,
    there is NO LayerZero hop we track and NO reliable webhook on testnet, so
    without this reconciler the row sat in `submitted` forever and the bottom
    sheet hung on "Finalising withdrawal…" until the client's poll cap forced a
    success fallback (~60s). We flip the row the moment the source tx mines:

      * Receipt status == 1  → `completed` (UR credits the destination USDC /
        books the bank payout shortly after the Mantle tx; the success screen's
        balance refresh reconciles it).
      * Receipt status == 0  → `failed` (tx_reverted).
      * Not yet mined         → leave as-is; the client polls again.
    """
    if not supabase:
        return None
    if job.get("status") != ur_db.JOB_STATUS_SUBMITTED:
        return None
    if job.get("kind") not in (ur_db.JOB_KIND_WITHDRAW, ur_db.JOB_KIND_PAYOUT, ur_db.JOB_KIND_TRANSFER):
        return None
    tx_hash = (job.get("source_tx_hash") or "").strip().lower()
    if not tx_hash or not tx_hash.startswith("0x"):
        return None
    src_chain_id = job.get("source_chain_id")
    if not src_chain_id:
        return None

    try:
        w3 = ur_chain.make_web3(int(src_chain_id))
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        return None
    except Exception:  # noqa: BLE001
        logger.exception(
            "UR %s job %s reconcile: receipt fetch failed (tx=%s)",
            job.get("kind"), job.get("id"), tx_hash,
        )
        return None

    receipt_status = getattr(receipt, "status", None)
    if receipt_status is None and isinstance(receipt, dict):
        receipt_status = receipt.get("status")
    if receipt_status is None:
        return None

    is_success = int(receipt_status) == 1
    new_status = (
        ur_db.JOB_STATUS_COMPLETED if is_success else ur_db.JOB_STATUS_FAILED
    )
    extra: Dict[str, Any] = {}
    if not is_success:
        extra["error_code"] = "tx_reverted"
        extra["error_message"] = "Source-chain cash-out transaction reverted."

    try:
        advanced = ur_db.transition_status_atomic(
            supabase,
            job_id=job["id"],
            expected_status=ur_db.JOB_STATUS_SUBMITTED,
            new_status=new_status,
            extra=extra,
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "UR %s job %s reconcile: transition submitted->%s failed",
            job.get("kind"), job.get("id"), new_status,
        )
        return None
    if advanced:
        logger.info(
            "UR %s job %s reconcile: submitted -> %s (receipt_status=%s, tx=%s)",
            job.get("kind"), job["id"], new_status, receipt_status, tx_hash,
        )
        if is_success:
            kind_lower = (advanced.get("kind") or "").lower()
            if kind_lower == ur_db.JOB_KIND_TRANSFER:
                # P2P inbox row + push normally arrive via UR's webhook (which keeps
                # owning the push). Guarantee the sender's inbox row even if that
                # webhook is late/missing — idempotent with it via tx:{hash} +
                # transfer_out type. Inbox-only here; no duplicate push.
                _emit_transfer_inbox_fallback(advanced)
            elif kind_lower in (ur_db.JOB_KIND_WITHDRAW, ur_db.JOB_KIND_PAYOUT):
                _emit_cash_out_inbox_fallback(advanced)
    return advanced


def _reconcile_job_from_source_receipt(
    job: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Dispatcher: route to the kind-specific reconciler."""
    kind = (job.get("kind") or "").lower()
    if kind == ur_db.JOB_KIND_DEPOSIT:
        return _reconcile_deposit_from_source_receipt(job)
    if kind == ur_db.JOB_KIND_FX:
        return _reconcile_fx_from_source_receipt(job)
    if kind in (ur_db.JOB_KIND_WITHDRAW, ur_db.JOB_KIND_PAYOUT, ur_db.JOB_KIND_TRANSFER):
        return _reconcile_onramp_from_source_receipt(job)
    return None


@api_router.get("/ur/jobs/{job_id}", tags=["ur"])
async def ur_jobs_get(
    job_id: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Poll a single job. 404 if the caller doesn't own it."""
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not available")
    row = await asyncio.to_thread(
        ur_db.get_user_job,
        supabase,
        privy_user_id=auth_user.user_id,
        job_id=job_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row.get("status") not in ur_db.JOB_TERMINAL_STATUSES:
        try:
            advanced = await asyncio.to_thread(
                _reconcile_job_from_source_receipt, row
            )
        except Exception:  # noqa: BLE001
            logger.exception("UR job %s lazy reconcile crashed", job_id)
            advanced = None
        if advanced:
            row = advanced
            if (
                (advanced.get("kind") or "").lower() == ur_db.JOB_KIND_TRANSFER
                and advanced.get("status") == ur_db.JOB_STATUS_COMPLETED
            ):
                try:
                    await _notify_transfer_recipient_from_job(advanced)
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "UR job %s recipient notify crashed", job_id,
                    )
        if (
            (row.get("kind") or "").lower() == ur_db.JOB_KIND_DEPOSIT
            and row.get("status") not in ur_db.JOB_TERMINAL_STATUSES
        ):
            try:
                lz_advanced = await asyncio.to_thread(
                    _reconcile_deposit_from_layerzero, row
                )
            except Exception:  # noqa: BLE001
                logger.exception("UR job %s LZ reconcile crashed", job_id)
                lz_advanced = None
            if lz_advanced:
                row = lz_advanced
    return {"job": _serialise_job(row)}


@api_router.post("/ur/webhook", tags=["ur"], include_in_schema=False)
async def ur_webhook_legacy_receiver(
    request: Request, background_tasks: BackgroundTasks
):
    """Deprecated alias — forwards to canonical POST /api/webhooks/ur."""
    return await _handle_ur_webhook_inbound(request, background_tasks)


# =============================================================================
# AI TRADING AGENTS — control plane (docs/AI_AGENTS.md)
#
# Ownership model: every route is scoped by the verified Privy JWT user_id.
# Creation verifies the master address belongs to the caller (Privy linked
# accounts, fail closed). Activation verifies on Hyperliquid itself that the
# user actually signed `approveAgent` — a DB write alone can never arm an
# agent. Agent keys are generated server-side, AES-GCM encrypted immediately
# (same envelope as the Node worker), and never returned to any client.
# =============================================================================

import ai_agents as ai_agents_mod


def _agent_public_view(row: Dict[str, Any]) -> Dict[str, Any]:
    """Strip ciphertexts — no key material ever leaves the backend."""
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "mode": row.get("mode"),
        "status": row.get("status"),
        "dryRun": row.get("dry_run"),
        "hlMasterAddress": row.get("hl_master_address"),
        "hlAgentAddress": row.get("hl_agent_address"),
        "hlAgentName": ai_agents_mod.agent_hl_name(str(row.get("id"))),
        "hlSubaccountAddress": row.get("hl_subaccount_address"),
        "config": row.get("config"),
        "tradingEnv": row.get("trading_env"),
        "hasCoinglassKey": bool(row.get("coinglass_key_ciphertext")),
        "modelKeyProviders": sorted((row.get("model_keys_ciphertext") or {}).keys()),
        "createdAt": row.get("created_at"),
        "lastRunAt": row.get("last_run_at"),
        # Worker-written degraded hint only — never overloads status.
        "health": row.get("health") or {},
    }


def _get_owned_agent(agent_id: str, user_id: str) -> Dict[str, Any]:
    """Fetch an agent row iff it belongs to `user_id`; 404 otherwise.

    Ownership filter happens in the QUERY (not post-hoc) so a foreign agent id
    is indistinguishable from a missing one.
    """
    res = (
        supabase.table("ai_agents")
        .select("*")
        .eq("id", agent_id)
        .eq("privy_user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Agent not found")
    return rows[0]


def _count_product_agent_slots(user_id: str, mode: str) -> int:
    """Product slots held in one mode's pool (stop/pause keep; revoke frees).

    Dedicated drafts count (HL sub booked at Create). Shared drafts do not.
    """
    want = ai_agents_mod.normalize_agent_mode(mode)
    res = (
        supabase.table("ai_agents")
        .select("id, status, mode")
        .eq("privy_user_id", user_id)
        .execute()
    )
    return sum(
        1
        for r in (res.data or [])
        if ai_agents_mod.counts_toward_product_slot(r.get("status"), r.get("mode"))
        and ai_agents_mod.normalize_agent_mode(r.get("mode")) == want
    )


def _assert_product_agent_slots_available(
    *,
    user_id: str,
    mode: str,
) -> int:
    """Raise 409 when that mode's product-slot pool is full. Returns the max."""
    slot_max = ai_agents_mod.product_slot_max_for_mode(mode)
    used = _count_product_agent_slots(user_id, mode)
    dedicated = ai_agents_mod.normalize_agent_mode(mode) == "dedicated"
    kind = "Dedicated" if dedicated else "Shared"
    if used >= slot_max:
        how = (
            "Delete a draft or revoke a stopped agent to free a slot"
            if dedicated
            else "Revoke a stopped agent to free a slot"
        )
        raise HTTPException(
            status_code=409,
            detail=(
                f"{kind} agent slots full ({used}/{slot_max}). "
                f"{how} — stopping alone keeps the slot taken."
            ),
        )
    return slot_max


def _slim_ai_decision_for_client(row: Dict[str, Any]) -> Dict[str, Any]:
    """Drop heavy LLM prompt/response blobs the UI never renders.

    List + Reasoning modal only need `decision` (action, short reasoning text,
    conviction, …). Historical rows still store full prompts in
    `reasoning.prompt` (~9KB); strip those on read so a 3-row page stays small.
    Keep `reasoning.response` only when `decision` has no usable reasoning body
    (e.g. opening_invalid).
    """
    out = dict(row)
    reasoning = out.get("reasoning")
    if not isinstance(reasoning, dict):
        return out
    slim = {k: v for k, v in reasoning.items() if k != "prompt"}
    dec = out.get("decision") if isinstance(out.get("decision"), dict) else {}
    body = ""
    if isinstance(dec, dict):
        for key in ("reasoning", "reason"):
            val = dec.get(key)
            if isinstance(val, str) and val.strip():
                body = val.strip()
                break
        if not body:
            nested = dec.get("decisionBody")
            if isinstance(nested, dict):
                for key in ("reasoning", "reason"):
                    val = nested.get(key)
                    if isinstance(val, str) and val.strip():
                        body = val.strip()
                        break
    if body:
        slim.pop("response", None)
    out["reasoning"] = slim or None
    return out


async def _adopt_stale_open_positions(row: Dict[str, Any]) -> int:
    """Mark tracked OPEN rows CLOSED_BY_USER when HL no longer has that position.

    Stopped agents never run the worker reconcile loop, so a manual close can
    leave stale OPEN rows that wrongly block revoke/delete.

    Same-side live exposure is always kept OPEN here. The worker uses fill/
    cloid identity (and only then entry proximity) to detect foreign reopens
    after a flatten — this control-plane path must NOT drop tracking just
    because avg entry drifted on add/DCA (3% entry_tol falsely orphaned
    pyramids). A same-side manual reopen may briefly keep a stale OPEN row
    until the user flattens again (revoke/delete stay blocked — correct).
    Returns how many OPEN rows remain after adoption.
    """
    agent_id = str(row["id"])
    open_res = (
        supabase.table("ai_agent_positions")
        .select("id, symbol, direction, entry_price, size_usd")
        .eq("agent_id", agent_id)
        .eq("status", "OPEN")
        .execute()
    )
    open_rows = open_res.data or []
    if not open_rows:
        return 0

    trading_addr = row.get("hl_subaccount_address") or row["hl_master_address"]
    # HIP-3 rows live on their own dex clearinghouse — derive the dexes from
    # the tracked symbols (e.g. "XYZ:TSLA" → "xyz") or they read as closed.
    hip3_dexes = sorted(
        {
            str(p.get("symbol") or "").split(":", 1)[0].lower()
            for p in open_rows
            if ":" in str(p.get("symbol") or "")
        }
    )
    try:
        live = await ai_agents_mod.get_hl_open_perp_positions(
            trading_addr,
            testnet=(row.get("trading_env") == "demo"),
            dexes=hip3_dexes,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"[ai-agents] stale-open HL check failed for {agent_id}: {e}"
        )
        # Fail closed — keep treating DB OPEN as blocking.
        return len(open_rows)

    # symbol → {direction, entry_price}
    live_by_sym: Dict[str, Dict[str, Any]] = {}
    for p in live:
        sym = str(p.get("symbol") or "").upper()
        if sym:
            live_by_sym[sym] = p

    now = datetime.now(timezone.utc).isoformat()
    remaining = 0
    for pos in open_rows:
        sym = str(pos.get("symbol") or "").upper()
        direction = pos.get("direction")
        live_p = live_by_sym.get(sym)
        # Same side still live → keep tracking (add/DCA / price avg drift OK).
        # Flat or flipped → adopt closed.
        still_ours = bool(live_p and live_p.get("direction") == direction)
        if still_ours:
            remaining += 1
            continue
        supabase.table("ai_agent_positions").update(
            {
                "status": "CLOSED_BY_USER",
                "close_reason": "adopted_on_revoke",
                "closed_at": now,
            }
        ).eq("id", pos["id"]).eq("agent_id", agent_id).execute()
    return remaining


def _assert_copilot_symbols_available(
    *,
    user_id: str,
    mode: str,
    master_address: str,
    trading_env: str,
    symbols: List[str],
    exclude_agent_id: Optional[str] = None,
) -> None:
    """Block overlapping symbols across copilots on the same master wallet.

    Dedicated agents use isolated sub-accounts and may share symbols.
    """
    if mode != "copilot":
        return
    res = (
        supabase.table("ai_agents")
        .select("id,name,mode,status,config,hl_master_address,trading_env")
        .eq("privy_user_id", user_id)
        .execute()
    )
    peers = [
        r
        for r in (res.data or [])
        if not exclude_agent_id or str(r.get("id")) != str(exclude_agent_id)
    ]
    conflict = ai_agents_mod.find_copilot_symbol_conflict(
        peer_rows=peers,
        symbols=symbols,
        master_address=master_address,
        trading_env=trading_env or "mainnet",
    )
    if conflict:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{conflict['symbol']} is already on \"{conflict['peer_name']}\". "
                "Copilot agents on the same wallet can't share symbols — "
                "remove it from the other agent, or use Dedicated mode."
            ),
        )


class CreateAiAgentRequest(BaseModel):
    name: Optional[str] = None
    hlMasterAddress: str
    config: Dict[str, Any]
    coinglassApiKey: Optional[str] = None
    modelApiKeys: Optional[Dict[str, str]] = None  # provider -> key
    tradingEnv: str = "mainnet"
    # Dedicated mode: agent trades an HL sub-account instead of the shared
    # master balance. The sub-account is created + funded client-side (master
    # signs both L1 actions); we verify ownership on HL before accepting it.
    mode: str = "copilot"
    hlSubaccountAddress: Optional[str] = None


class PatchAiAgentRequest(BaseModel):
    """Name anytime (non-revoked). Config / CoinGlass key only while status=draft."""
    name: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    coinglassApiKey: Optional[str] = None


@api_router.patch("/ai-agents/{agent_id}")
async def patch_ai_agent(
    agent_id: str,
    body: PatchAiAgentRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Patch display name and/or draft settings.

    Active/stopped agents may only rename. Full config edits are draft-only —
    they never ran a cycle. Dedicated funding (`max_capital_usd`) is locked once
    the sub-account was funded at create time.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    row = _get_owned_agent(agent_id, auth_user.user_id)
    if row["status"] == "revoked":
        raise HTTPException(status_code=409, detail="Cannot edit a revoked agent")

    updates: Dict[str, Any] = {"updated_at": datetime.now(timezone.utc).isoformat()}
    touching_settings = body.config is not None or (
        body.coinglassApiKey is not None and bool(str(body.coinglassApiKey).strip())
    )
    if touching_settings and row["status"] != "draft":
        raise HTTPException(
            status_code=409,
            detail="Only draft agents can change trading settings. Stop and recreate, or edit while still a draft.",
        )

    if body.name is not None:
        try:
            updates["name"] = ai_agents_mod.normalize_agent_display_name(body.name)
        except ai_agents_mod.AiAgentError as e:
            raise HTTPException(status_code=400, detail=str(e))

    if body.config is not None:
        try:
            clean_config = ai_agents_mod.validate_agent_config(
                body.config or {}, mode=row.get("mode") or "copilot"
            )
        except ai_agents_mod.AiAgentError as e:
            raise HTTPException(status_code=400, detail=str(e))
        # Dedicated: funding already transferred at create — keep original cap.
        if row.get("mode") == "dedicated":
            prev_cap = (row.get("config") or {}).get("max_capital_usd")
            prev_lev = float(
                (clean_config.get("leverage_cap")
                 or (row.get("config") or {}).get("leverage_cap")
                 or 1)
            )
            if prev_cap is not None:
                clean_config["max_capital_usd"] = float(prev_cap)
                if clean_config.get("max_position_usd") is not None:
                    notional_ceiling = float(prev_cap) * max(1.0, prev_lev)
                    if clean_config["max_position_usd"] > notional_ceiling:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                "Max per position cannot exceed funding × leverage "
                                f"(${notional_ceiling:g} notional)"
                            ),
                        )
        _assert_copilot_symbols_available(
            user_id=auth_user.user_id,
            mode=row.get("mode") or "copilot",
            master_address=row.get("hl_master_address") or "",
            trading_env=row.get("trading_env") or "mainnet",
            symbols=clean_config.get("symbols") or [],
            exclude_agent_id=agent_id,
        )
        updates["config"] = clean_config

    if body.coinglassApiKey is not None and str(body.coinglassApiKey).strip():
        raw_key = str(body.coinglassApiKey).strip()
        try:
            await ai_agents_mod.verify_coinglass_api_key(raw_key)
            updates["coinglass_key_ciphertext"] = ai_agents_mod.encrypt_secret(raw_key)
        except ai_agents_mod.AiAgentError as e:
            raise HTTPException(status_code=400, detail=str(e))

    if len(updates) <= 1:
        raise HTTPException(status_code=400, detail="No changes provided")

    res = (
        supabase.table("ai_agents")
        .update(updates)
        .eq("id", agent_id)
        .eq("privy_user_id", auth_user.user_id)
        .execute()
    )
    updated = (res.data or [None])[0] or {**row, **updates}
    return {"agent": _agent_public_view(updated)}


@api_router.post("/ai-agents")
async def create_ai_agent(
    body: CreateAiAgentRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Create a draft agent. Returns the agent address for the user to approve
    on HL (`approveAgent` ceremony); activation is a separate verified step."""
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")

    master = (body.hlMasterAddress or "").strip()
    if not master.lower().startswith("0x") or len(master) != 42:
        raise HTTPException(status_code=400, detail="Invalid master address")

    # Ownership: the master address MUST be a wallet linked to this Privy user
    # (embedded EOA or SIWE-linked external wallet). Fail closed on lookup errors.
    try:
        owns = await asyncio.to_thread(
            privy_import.user_owns_eth_address, auth_user.user_id, master
        )
    except Exception as e:  # noqa: BLE001
        logger.error(f"[ai-agents] Privy ownership lookup failed: {e}")
        raise HTTPException(status_code=503, detail="Could not verify wallet ownership")
    if not owns:
        raise HTTPException(
            status_code=403,
            detail="Master address is not linked to your account",
        )

    if body.tradingEnv not in ("mainnet", "demo"):
        raise HTTPException(status_code=400, detail="Invalid tradingEnv")
    # Demo/testnet agents are not runnable in V1 (no testnet worker spend).
    # App demo mode may still CREATE mainnet drafts — omit tradingEnv or use mainnet.
    if body.tradingEnv == "demo":
        raise HTTPException(
            status_code=400,
            detail="AI agents cannot be created for demo/testnet. Switch to live trading, then create.",
        )

    if body.mode not in ("copilot", "dedicated"):
        raise HTTPException(status_code=400, detail="Invalid mode")

    # Dedicated (HL sub-account) — fund/reclaim via sendAsset spot↔spot under
    # unifiedAccount (see scripts/hl-unified-subaccount-probe.mjs). Keep in sync
    # with frontend DEDICATED_MODE_ENABLED.
    AI_AGENT_DEDICATED_ENABLED = True
    if body.mode == "dedicated" and not AI_AGENT_DEDICATED_ENABLED:
        raise HTTPException(
            status_code=400,
            detail="Dedicated mode is temporarily unavailable. Create the agent in Shared mode.",
        )

    subaccount: Optional[str] = None
    if body.mode == "dedicated":
        subaccount = (body.hlSubaccountAddress or "").strip()
        if not subaccount.lower().startswith("0x") or len(subaccount) != 42:
            raise HTTPException(
                status_code=400,
                detail="Dedicated mode requires a valid sub-account address",
            )
        # Verify ON HL that the sub-account belongs to this master (fail closed):
        # otherwise a caller could point an agent at an arbitrary account.
        try:
            owns_sub = await ai_agents_mod.subaccount_belongs_to_master(
                master_address=master,
                subaccount_address=subaccount,
                testnet=(body.tradingEnv == "demo"),
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"[ai-agents] subaccount ownership lookup failed: {e}")
            raise HTTPException(status_code=503, detail="Could not verify sub-account ownership")
        if not owns_sub:
            raise HTTPException(
                status_code=403,
                detail="Sub-account does not belong to the master address",
            )

    raw_coinglass = (body.coinglassApiKey or "").strip()
    # Global-cache mode: house CoinGlass key serves all agents — personal key
    # optional (still stored if supplied, so a BYOK revert keeps working).
    if not raw_coinglass and not ai_agents_mod.COINGLASS_GLOBAL_MODE:
        raise HTTPException(status_code=400, detail="CoinGlass API key is required")

    try:
        if raw_coinglass:
            await ai_agents_mod.verify_coinglass_api_key(raw_coinglass)
        clean_config = ai_agents_mod.validate_agent_config(
            body.config or {}, mode=body.mode
        )
        keypair = ai_agents_mod.generate_agent_keypair()
        key_ciphertext = ai_agents_mod.encrypt_secret(keypair["private_key"])
        coinglass_ct = (
            ai_agents_mod.encrypt_secret(raw_coinglass) if raw_coinglass else None
        )
        model_cts = {
            provider: ai_agents_mod.encrypt_secret(key.strip())
            for provider, key in (body.modelApiKeys or {}).items()
            if provider in ai_agents_mod.ALLOWED_MODEL_PROVIDERS and key and key.strip()
        } or None
    except ai_agents_mod.AiAgentError as e:
        raise HTTPException(status_code=400, detail=str(e))

    _assert_copilot_symbols_available(
        user_id=auth_user.user_id,
        mode=body.mode,
        master_address=master,
        trading_env=body.tradingEnv,
        symbols=clean_config.get("symbols") or [],
    )

    # Per-mode product slots (Shared 2 / Dedicated 10, independent). Shared
    # drafts do not consume a slot; Dedicated drafts do (HL sub at Create).
    _assert_product_agent_slots_available(
        user_id=auth_user.user_id,
        mode=body.mode,
    )

    try:
        display_name = ai_agents_mod.normalize_agent_display_name(
            body.name, default="AI Agent"
        )
    except ai_agents_mod.AiAgentError as e:
        raise HTTPException(status_code=400, detail=str(e))

    insert = {
        "privy_user_id": auth_user.user_id,
        "name": display_name,
        "mode": body.mode,
        "status": "draft",
        "dry_run": False,  # live by default; shadow toggle is __DEV__-only in the app
        "hl_master_address": master,
        "hl_agent_address": keypair["address"],
        "hl_agent_key_ciphertext": key_ciphertext,
        "hl_subaccount_address": subaccount,
        "config": clean_config,
        "coinglass_key_ciphertext": coinglass_ct,
        "model_keys_ciphertext": model_cts,
        "trading_env": body.tradingEnv,
    }
    res = supabase.table("ai_agents").insert(insert).execute()
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=500, detail="Failed to create agent")
    return {"agent": _agent_public_view(row)}


@api_router.get("/ai-agents")
async def list_ai_agents(auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    res = (
        supabase.table("ai_agents")
        .select("*")
        .eq("privy_user_id", auth_user.user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return {
        "agents": [_agent_public_view(r) for r in (res.data or [])],
        # App uses this to hide the CoinGlass-key step in the create wizard.
        "coinglassGlobalMode": ai_agents_mod.COINGLASS_GLOBAL_MODE,
    }


@api_router.post("/ai-agents/{agent_id}/activate")
async def activate_ai_agent(
    agent_id: str,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Activate after the user signed `approveAgent`. Verified ON HYPERLIQUID —
    the agent address must be a live approved agent of the master."""
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    row = _get_owned_agent(agent_id, auth_user.user_id)
    # Idempotent: wallet return / retries often re-POST after a successful activate.
    if row["status"] == "active":
        return {"agent": _agent_public_view(row)}
    if row["status"] not in ("draft", "paused", "stopped"):
        raise HTTPException(status_code=409, detail=f"Cannot activate from status {row['status']}")

    # Demo/testnet rows must never go live (house LLM / CoinGlass). Create stays
    # allowed for UX; activate is the spend gate.
    if (row.get("trading_env") or "mainnet") == "demo":
        raise HTTPException(
            status_code=403,
            detail="AI agents cannot be activated in demo mode. Switch to live trading to activate.",
        )

    # Fast-path UX check only — the real caps are enforced atomically at the
    # end via activate_ai_agent_under_cap (advisory lock + count + update).
    active_res = (
        supabase.table("ai_agents")
        .select("id", count="exact")
        .eq("privy_user_id", auth_user.user_id)
        .eq("status", "active")
        .execute()
    )
    active_count = active_res.count or 0
    if active_count >= ai_agents_mod.MAX_ACTIVE_AGENTS_PER_USER:
        raise HTTPException(
            status_code=409,
            detail=f"You can have at most {ai_agents_mod.MAX_ACTIVE_AGENTS_PER_USER} active agents. Stop one first.",
        )

    # Shared draft → live consumes a slot. Dedicated draft already holds one
    # (HL sub created at Create); resume already holds one either mode.
    mode = row.get("mode") or "copilot"
    product_slot_max = ai_agents_mod.product_slot_max_for_mode(mode)
    if (
        row["status"] == "draft"
        and ai_agents_mod.normalize_agent_mode(mode) != "dedicated"
    ):
        product_slot_max = _assert_product_agent_slots_available(
            user_id=auth_user.user_id,
            mode=mode,
        )

    _assert_copilot_symbols_available(
        user_id=auth_user.user_id,
        mode=row.get("mode") or "copilot",
        master_address=row.get("hl_master_address") or "",
        trading_env=row.get("trading_env") or "mainnet",
        symbols=((row.get("config") or {}).get("symbols") or []),
        exclude_agent_id=agent_id,
    )

    # Balance gate BEFORE approveAgent. Draft/paused/stopped all hit this
    # same floor — otherwise the client signs extraAgents, then 409s here
    # and the next tap is "Extra agent already used".
    trading_addr = row.get("hl_subaccount_address") or row["hl_master_address"]
    try:
        account_value = await ai_agents_mod.get_hl_account_value(
            trading_addr, testnet=(row.get("trading_env") == "demo")
        )
    except Exception as e:  # noqa: BLE001
        logger.error(f"[ai-agents] activation balance check failed: {e}")
        raise HTTPException(status_code=503, detail="Could not verify Hyperliquid balance")
    if account_value < ai_agents_mod.MIN_HL_BALANCE_USD:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This account needs at least ${ai_agents_mod.MIN_HL_BALANCE_USD:.0f} "
                f"on Hyperliquid to run an agent (found ${account_value:.2f}). "
                "Deposit first, then activate."
            ),
        )

    try:
        approved = await ai_agents_mod.is_agent_approved_on_hl(
            master_address=row["hl_master_address"],
            agent_address=row["hl_agent_address"],
            testnet=(row.get("trading_env") == "demo"),
        )
    except ai_agents_mod.AiAgentError as e:
        logger.warning(f"[ai-agents] activate HL approval check failed: {e}")
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logger.error(f"[ai-agents] activate HL approval check failed: {e}")
        raise HTTPException(
            status_code=503,
            detail="Could not verify Hyperliquid agent approval. Try again in a moment.",
        )
    if not approved:
        raise HTTPException(
            status_code=409,
            detail="Agent is not approved on Hyperliquid yet. Sign the approval and retry.",
        )

    # BYOK mode only: fail closed on missing/invalid CoinGlass — otherwise a
    # junk key can ride another agent's market-data cache into house-paid LLM
    # calls. In global mode the house key entitles everyone; skip entirely.
    if not ai_agents_mod.COINGLASS_GLOBAL_MODE:
        cg_ct = row.get("coinglass_key_ciphertext")
        if not cg_ct:
            raise HTTPException(
                status_code=409,
                detail="Add a valid CoinGlass API key before activating this agent.",
            )
        try:
            await ai_agents_mod.verify_coinglass_api_key(
                ai_agents_mod.decrypt_secret(cg_ct)
            )
        except ai_agents_mod.AiAgentError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except Exception as e:  # noqa: BLE001
            logger.error(f"[ai-agents] activate CoinGlass check failed: {e}")
            raise HTTPException(
                status_code=503,
                detail="Could not verify CoinGlass API key. Try again in a moment.",
            )

    # Atomic activate: advisory lock per user → recount → status flip.
    # Closes the TOCTOU window between the early count above and this write.
    try:
        cap_res = supabase.rpc(
            "activate_ai_agent_under_cap",
            {
                "p_agent_id": agent_id,
                "p_privy_user_id": auth_user.user_id,
                "p_max_active": ai_agents_mod.MAX_ACTIVE_AGENTS_PER_USER,
                "p_max_product_slots": product_slot_max,
            },
        ).execute()
    except Exception as e:  # noqa: BLE001
        logger.error(f"[ai-agents] activate_ai_agent_under_cap failed: {e}")
        raise HTTPException(
            status_code=503,
            detail="Could not activate agent. Try again in a moment.",
        )
    raw = cap_res.data
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:  # noqa: BLE001
            raw = None
    payload = raw if isinstance(raw, dict) else None
    if not payload or not payload.get("ok"):
        err = (payload or {}).get("error")
        if err == "cap":
            raise HTTPException(
                status_code=409,
                detail=(
                    f"You can have at most {ai_agents_mod.MAX_ACTIVE_AGENTS_PER_USER} "
                    "active agents. Stop one first."
                ),
            )
        if err == "slots":
            used = (payload or {}).get("used")
            mx = (payload or {}).get("max") or product_slot_max
            kind = (
                "Dedicated"
                if (payload or {}).get("mode") == "dedicated"
                else "Shared"
            )
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{kind} agent slots full ({used}/{mx}). "
                    "Revoke a stopped agent to free a slot — stopping alone keeps the slot taken."
                    if used is not None
                    else (
                        f"{kind} agent slots full ({mx} max). "
                        "Revoke a stopped agent to free a slot — stopping alone keeps the slot taken."
                    )
                ),
            )
        if err == "bad_status":
            raise HTTPException(
                status_code=409,
                detail=f"Cannot activate from status {(payload or {}).get('status')}",
            )
        if err == "not_found":
            raise HTTPException(status_code=404, detail="Agent not found")
        raise HTTPException(status_code=503, detail="Could not activate agent")
    activated = payload.get("agent") or {**row, "status": "active"}
    return {"agent": _agent_public_view(activated)}


class AgentStatusRequest(BaseModel):
    dryRun: Optional[bool] = None


@api_router.post("/ai-agents/{agent_id}/pause")
async def pause_ai_agent(agent_id: str, auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    row = _get_owned_agent(agent_id, auth_user.user_id)
    if row["status"] != "active":
        raise HTTPException(status_code=409, detail="Agent is not active")
    supabase.table("ai_agents").update({"status": "paused"}).eq("id", agent_id).eq(
        "privy_user_id", auth_user.user_id
    ).execute()
    return {"ok": True}


@api_router.post("/ai-agents/{agent_id}/stop")
async def stop_ai_agent(agent_id: str, auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    """Stop = worker never runs it again until re-activated. Open positions are
    left for the user to manage (they own the account)."""
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    _get_owned_agent(agent_id, auth_user.user_id)
    supabase.table("ai_agents").update({"status": "stopped"}).eq("id", agent_id).eq(
        "privy_user_id", auth_user.user_id
    ).execute()
    return {"ok": True}


@api_router.post("/ai-agents/{agent_id}/revoke")
async def revoke_ai_agent(agent_id: str, auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    """Permanently retire an agent. The client first deauthorizes the key on HL
    (approveAgent with the same name + a discarded throwaway address, which
    replaces our key). We mark revoked regardless — that alone stops the worker
    — and report whether the old key still looks approved on HL so the UI can
    tell the user to finish the signature if it failed.

    Refuses while tracked OPEN positions exist — same guard as delete. Revoke
    removes trading authority, so leaving live agent exposure unmanaged is worse
    than a soft delete of the DB row.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    row = _get_owned_agent(agent_id, auth_user.user_id)

    remaining_open = await _adopt_stale_open_positions(row)
    if remaining_open > 0:
        raise HTTPException(
            status_code=409,
            detail="This agent still has open positions. Close them first, then revoke.",
        )

    still_approved: Optional[bool] = None
    try:
        still_approved = await ai_agents_mod.is_agent_approved_on_hl(
            master_address=row["hl_master_address"],
            agent_address=row["hl_agent_address"],
            testnet=(row.get("trading_env") == "demo"),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[ai-agents] revoke HL check failed (non-fatal): {e}")

    supabase.table("ai_agents").update(
        {"status": "revoked", "updated_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", agent_id).eq("privy_user_id", auth_user.user_id).execute()
    return {"ok": True, "stillApprovedOnHl": still_approved}


@api_router.delete("/ai-agents/{agent_id}")
async def delete_ai_agent(agent_id: str, auth_user: PrivyAuthUser = Depends(verify_privy_token)):
    """Permanently delete an agent record (cascades positions/decisions/runs).

    Guards:
      • Must not be active — Stop it first (a running agent shouldn't vanish
        mid-cycle).
      • Must have no OPEN tracked positions — the user closes those (or lets
        the agent exit them) before deleting, so a delete never orphans live
        exposure the agent was managing.
    Note: deletion is record-only for the DB row. Dedicated USDC lives on the
    HL sub-account (still owned by the master) — we refuse delete while that
    balance is ≥ $1 so funds aren't "lost" with the draft. The app reclaims
    withdrawable USDC to the master before calling delete. Non-draft agents
    that are still approved on HL must be revoked first (frees the named-agent
    slot); otherwise deleting the row would orphan a slot the user can't see.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    row = _get_owned_agent(agent_id, auth_user.user_id)
    if row["status"] == "active":
        raise HTTPException(status_code=409, detail="Stop the agent before deleting it.")

    remaining_open = await _adopt_stale_open_positions(row)
    if remaining_open > 0:
        raise HTTPException(
            status_code=409,
            detail="This agent still has open positions. Close them first, then delete.",
        )

    # Drafts were never approved on HL. Already-revoked rows already went
    # through the free-slot ceremony — don't block delete on stale HL state.
    # Stopped/paused/etc. must free the named agent slot before the DB row
    # disappears (or the user can get stuck at the volume-gated agent limit).
    if row.get("status") not in ("draft", "revoked"):
        try:
            still_approved = await ai_agents_mod.is_agent_approved_on_hl(
                master_address=row["hl_master_address"],
                agent_address=row["hl_agent_address"],
                testnet=(row.get("trading_env") == "demo"),
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"[ai-agents] delete approval check failed: {e}")
            raise HTTPException(
                status_code=503,
                detail="Could not verify trading permission before delete",
            )
        if still_approved:
            raise HTTPException(
                status_code=409,
                detail="Revoke this agent's trading permission before deleting it.",
            )

    # Dedicated funds live on the HL sub-account (still owned by the master).
    if row.get("mode") == "dedicated" and row.get("hl_subaccount_address"):
        try:
            account_value = await ai_agents_mod.get_hl_account_value(
                row["hl_subaccount_address"],
                testnet=(row.get("trading_env") == "demo"),
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"[ai-agents] delete balance check failed: {e}")
            raise HTTPException(
                status_code=503,
                detail="Could not verify dedicated account balance before delete",
            )
        if account_value >= 1.0:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This agent's dedicated account still holds ${account_value:.2f}. "
                    "Transfer the funds back to your main balance first, then delete."
                ),
            )

    supabase.table("ai_agents").delete().eq("id", agent_id).eq(
        "privy_user_id", auth_user.user_id
    ).execute()
    return {"ok": True}


@api_router.post("/ai-agents/{agent_id}/dry-run")
async def set_ai_agent_dry_run(
    agent_id: str,
    body: AgentStatusRequest,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Toggle shadow mode (decisions logged, no orders).

    Production stays live-only: enabling dry_run requires
    AI_AGENT_ALLOW_SHADOW_TOGGLE=1 (local/dev backends). Turning shadow off
    is always allowed.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    if body.dryRun is None:
        raise HTTPException(status_code=400, detail="dryRun is required")
    if bool(body.dryRun) and os.getenv("AI_AGENT_ALLOW_SHADOW_TOGGLE", "").strip() != "1":
        raise HTTPException(
            status_code=403,
            detail="Shadow mode is disabled in this environment",
        )
    _get_owned_agent(agent_id, auth_user.user_id)
    supabase.table("ai_agents").update({"dry_run": bool(body.dryRun)}).eq("id", agent_id).eq(
        "privy_user_id", auth_user.user_id
    ).execute()
    return {"ok": True}


@api_router.get("/ai-agents/stats")
async def list_ai_agent_stats(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """Per-agent performance aggregates from tracked positions (service-role DB).
    Dedicated agents may overlay HL portfolio all-time stats client-side."""
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    agents_res = (
        supabase.table("ai_agents")
        .select("id")
        .eq("privy_user_id", auth_user.user_id)
        .execute()
    )
    agent_ids = [str(a["id"]) for a in (agents_res.data or [])]
    if not agent_ids:
        return {"stats": {}}

    pos_res = (
        supabase.table("ai_agent_positions")
        .select("agent_id, status, size_usd, realized_pnl")
        .in_("agent_id", agent_ids)
        .execute()
    )
    stats: Dict[str, Dict[str, Any]] = {
        aid: {
            "openPositions": 0,
            "realizedPnlUsd": 0.0,
            "volumeUsd": 0.0,
            "closedPositions": 0,
            "winningCloses": 0,
            "winRatePct": None,
            "decisionCount": 0,
        }
        for aid in agent_ids
    }
    for row in pos_res.data or []:
        aid = str(row.get("agent_id"))
        bucket = stats.get(aid)
        if not bucket:
            continue
        try:
            bucket["volumeUsd"] += float(row.get("size_usd") or 0)
        except (TypeError, ValueError):
            pass
        status = row.get("status")
        if status == "OPEN":
            bucket["openPositions"] += 1
        rpnl = row.get("realized_pnl")
        if rpnl is not None:
            try:
                rpnl_f = float(rpnl)
                bucket["realizedPnlUsd"] += rpnl_f
                if status in ("CLOSED", "CLOSED_BY_USER"):
                    bucket["closedPositions"] += 1
                    if rpnl_f > 0:
                        bucket["winningCloses"] += 1
            except (TypeError, ValueError):
                pass
        elif status in ("CLOSED", "CLOSED_BY_USER"):
            # Closed without recorded PnL still counts toward sample size.
            bucket["closedPositions"] += 1

    # Total decisions (incl. flat / skipped) — proves the agent is running even
    # when live positions stay 0. Head-only counts — never download decision rows.
    try:
        for aid in agent_ids:
            bucket = stats.get(aid)
            if bucket is None:
                continue
            cnt_res = (
                supabase.table("ai_agent_decisions")
                .select("id", count="exact", head=True)
                .eq("agent_id", aid)
                .execute()
            )
            bucket["decisionCount"] = int(cnt_res.count or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[ai-agents] decisionCount aggregate failed: {e}")

    for bucket in stats.values():
        closed = int(bucket["closedPositions"])
        if closed > 0:
            bucket["winRatePct"] = round(
                100.0 * int(bucket["winningCloses"]) / closed, 1
            )
    return {"stats": stats}


@api_router.get("/ai-agents/positions")
async def list_all_ai_agent_positions(
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    """All OPEN agent-tracked positions across the caller's agents (active,
    paused, or stopped). Powers the bot badge + Reasoning button in the
    portfolio position list, and live open-count on the AI agents screen.
    Stopped is included so manual closes can be HL-checked before revoke."""
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    agents_res = (
        supabase.table("ai_agents")
        .select(
            "id, name, mode, status, trading_env, hl_master_address, hl_subaccount_address"
        )
        .eq("privy_user_id", auth_user.user_id)
        .in_("status", ["active", "paused", "stopped"])
        .execute()
    )
    agents = {str(a["id"]): a for a in (agents_res.data or [])}
    if not agents:
        return {"positions": []}
    # Drop OPEN rows that no longer match live HL (manual close) so the
    # portfolio bot badge does not wait for the next hourly worker cycle.
    # Parallel — each agent hits HL once; sequential N agents = N RTT lag.
    adopt_results = await asyncio.gather(
        *[_adopt_stale_open_positions(agent) for agent in agents.values()],
        return_exceptions=True,
    )
    for agent, result in zip(agents.values(), adopt_results):
        if isinstance(result, Exception):
            logger.warning(
                f"[ai-agents] positions adopt failed for {agent.get('id')}: {result}"
            )
    pos_res = (
        supabase.table("ai_agent_positions")
        .select("id, agent_id, symbol, dex, direction, entry_price, size_usd, leverage, conviction, opened_at")
        .in_("agent_id", list(agents.keys()))
        .eq("status", "OPEN")
        .execute()
    )
    out = []
    for p in pos_res.data or []:
        agent = agents.get(str(p["agent_id"]))
        if not agent:
            continue
        out.append({
            "agentId": p["agent_id"],
            "agentName": agent["name"],
            "agentMode": agent["mode"],
            "tradingEnv": agent["trading_env"],
            "symbol": p["symbol"],
            "direction": p["direction"],
            "entryPrice": p["entry_price"],
            "sizeUsd": p["size_usd"],
            "leverage": p["leverage"],
            "conviction": p["conviction"],
            "openedAt": p["opened_at"],
        })
    return {"positions": out}


@api_router.get("/ai-agents/{agent_id}/decisions")
async def list_ai_agent_decisions(
    agent_id: str,
    limit: int = 50,
    offset: int = 0,
    symbol: Optional[str] = None,
    kind: Optional[str] = None,  # 'opening' | 'monitor' — prefix filter on type
    since: Optional[str] = None,  # ISO timestamp — scope to current position lifecycle
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    _get_owned_agent(agent_id, auth_user.user_id)
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    q = (
        supabase.table("ai_agent_decisions")
        .select("id, symbol, type, decision, reasoning, provider, model, created_at")
        .eq("agent_id", agent_id)
    )
    if symbol:
        q = q.eq("symbol", symbol.strip().upper())
    if kind in ("opening", "monitor"):
        q = q.like("type", f"{kind}%")
    if since and str(since).strip():
        # Portfolio reasoning modal passes the open position's openedAt so
        # monitors from a prior ZEC long don't mix into a new short, etc.
        q = q.gte("created_at", str(since).strip())
    res = q.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    rows = [_slim_ai_decision_for_client(r) for r in (res.data or [])]
    return {"decisions": rows, "hasMore": len(rows) == limit, "offset": offset}


@api_router.get("/ai-agents/{agent_id}/runs")
async def list_ai_agent_runs(
    agent_id: str,
    limit: int = 100,
    auth_user: PrivyAuthUser = Depends(verify_privy_token),
):
    if not supabase:
        raise HTTPException(status_code=503, detail="AI agents not configured")
    _get_owned_agent(agent_id, auth_user.user_id)
    limit = max(1, min(int(limit or 100), 500))
    res = (
        supabase.table("ai_agent_runs")
        .select("id, started_at, finished_at, status, error, equity_snapshot")
        .eq("agent_id", agent_id)
        .order("started_at", desc=True)
        .limit(limit)
        .execute()
    )
    return {"runs": res.data or []}


# ── Public AI agent showcase (read-only, allowlisted) ───────────────────────
import ai_agent_showcase as ai_agent_showcase_mod


@api_router.get("/showcase/agents")
async def showcase_agents():
    """Public roster + focus payloads for house showcase agents.

    Chart series = Hyperliquid portfolio pnlHistory indexed as 1000 + PnL.
    Includes maxCapitalUsd (shared notional ceiling). Cached ~28s.
    Set SHOWCASE_AGENT_IDS on the backend.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Showcase unavailable")
    return await ai_agent_showcase_mod.build_showcase_payload(
        supabase=supabase,
        fetch_hl=fetch_hyperliquid,
    )


app.include_router(api_router)

# ---------------------------------------------------------------------------
# Geo-fence middleware — enforces block on ALL API routes so users cannot
# bypass the frontend check by calling the API directly.
# Runs *after* CORS (added below) so preflight OPTIONS still work.
# Fail-open: if lookup fails (None), allow the request through.
# ---------------------------------------------------------------------------
@app.middleware("http")
async def geo_block_middleware(request: Request, call_next):
    if _APPLE_REVIEW_BYPASS:
        return await call_next(request)

    path = request.url.path
    # Skip exempt paths and non-API routes
    if (
        path in _GEO_EXEMPT_PATHS
        or path.startswith("/api/showcase")
        or not path.startswith("/api/")
    ):
        return await call_next(request)

    ip = _get_client_ip(request)
    country = await _lookup_country(ip)

    if country in _GEO_BLOCKED_COUNTRIES:
        return JSONResponse(
            status_code=451,  # Unavailable For Legal Reasons
            content={"detail": "This service is not available in your region."},
        )

    return await call_next(request)


# CORS: Restrict to known origins (mobile apps bypass CORS entirely)
ALLOWED_ORIGINS = [
    "https://hypertrade.exchange",
    "https://www.hypertrade.exchange",
    "https://app.hypertrade.exchange",
    # Public AI agents showcase (Vercel)
    "https://ai.hypertrade.exchange",
    # Showcase local / static hosts
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]

# In development, also allow localhost
if os.getenv("ENVIRONMENT", "production") != "production":
    ALLOWED_ORIGINS.extend([
        "http://localhost:3000",
        "http://localhost:8081",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8081",
    ])

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
