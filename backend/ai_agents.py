"""AI trading agents — control-plane helpers (see docs/AI_AGENTS.md).

The FastAPI routes in server.py stay thin; everything agent-specific lives
here: Node-compatible AES-GCM envelope crypto, agent keypair generation, and
the Hyperliquid `extraAgents` approval check used to activate an agent.

SECURITY: every route caller is scoped by verified Privy JWT `user_id`;
creation additionally verifies the master address belongs to that user via
`privy_import.user_owns_eth_address` (fail closed). Agent private keys are
generated here, encrypted immediately, and the plaintext never leaves the
process or gets logged.
"""
from __future__ import annotations

import asyncio
import base64
import os
from typing import Any, Dict, List, Optional

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_account import Account

HL_MAINNET_INFO = "https://api.hyperliquid.xyz/info"
HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info"
COINGLASS_BASE = "https://open-api-v4.coinglass.com"

# HL caps agent names at 16 chars — "htai-" + 8 uuid chars = 13. (The longer
# "hypertrade-ai-" prefix hit 22 chars and HL rejected the approval signature.)
AGENT_NAME_PREFIX = "htai"

# Same key as the Node worker (`AGENT_KMS_KEY`, 32-byte hex).
_AGENT_KMS_KEY_HEX = os.getenv("AGENT_KMS_KEY", "").strip()

# Global-cache mode: the house CoinGlass Standard key serves market data for
# ALL agents (worker reads the same env), so users no longer supply personal
# CoinGlass keys — create/activate stop requiring them and the app hides the
# field. Keep unset to revert to BYOK. Mirror this env on backend AND worker.
COINGLASS_GLOBAL_MODE = os.getenv("COINGLASS_GLOBAL_MODE", "").strip() == "1"

# TEMPORARY testing default — see validate_agent_config. Flip to False to
# restore the user-facing standard/aggressive choice.
FORCE_AGGRESSIVE_RISK_PROFILE = True

_IV_LEN = 12
_TAG_LEN = 16


class AiAgentError(Exception):
    """Domain error — routes map this to HTTP 400/409."""


def _kms_key() -> bytes:
    if not _AGENT_KMS_KEY_HEX:
        raise AiAgentError("AGENT_KMS_KEY is not configured on the server")
    key = bytes.fromhex(_AGENT_KMS_KEY_HEX)
    if len(key) != 32:
        raise AiAgentError("AGENT_KMS_KEY must be 32 bytes of hex")
    return key


async def verify_coinglass_api_key(api_key: str) -> None:
    """Probe CoinGlass with the user's key so junk/empty keys can't activate
    agents that would otherwise freeload another agent's market-data cache
    and burn house LLM credits."""
    key = (api_key or "").strip()
    if len(key) < 8:
        raise AiAgentError("A valid CoinGlass API key is required")
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            res = await client.get(
                f"{COINGLASS_BASE}/api/futures/price/history",
                params={
                    "exchange": "Binance",
                    "symbol": "BTCUSDT",
                    "interval": "4h",
                    "limit": "1",
                },
                headers={"CG-API-KEY": key, "accept": "application/json"},
            )
    except Exception as e:  # noqa: BLE001
        raise AiAgentError(f"Could not verify CoinGlass API key: {e}") from e
    if res.status_code in (401, 403):
        raise AiAgentError("CoinGlass API key was rejected")
    if res.status_code != 200:
        raise AiAgentError(
            f"Could not verify CoinGlass API key (HTTP {res.status_code})"
        )
    try:
        body = res.json()
    except Exception as e:  # noqa: BLE001
        raise AiAgentError("Could not verify CoinGlass API key") from e
    if str(body.get("code", "")) != "0":
        raise AiAgentError(
            f"CoinGlass API key was rejected ({body.get('msg') or body.get('code') or 'invalid'})"
        )


def encrypt_secret(plaintext: str) -> str:
    """AES-256-GCM, ciphertext layout iv||tag||data (base64).

    MUST stay byte-compatible with workers/ai-agent/src/lib/crypto.ts:
    Python's AESGCM appends the tag to the END of its output, so we move it
    between the IV and the data to match Node's createCipheriv layout.
    """
    iv = os.urandom(_IV_LEN)
    sealed = AESGCM(_kms_key()).encrypt(iv, plaintext.encode("utf-8"), None)
    data, tag = sealed[:-_TAG_LEN], sealed[-_TAG_LEN:]
    return base64.b64encode(iv + tag + data).decode()


def decrypt_secret(ciphertext_b64: str) -> str:
    raw = base64.b64decode(ciphertext_b64)
    if len(raw) < _IV_LEN + _TAG_LEN + 1:
        raise AiAgentError("Ciphertext too short")
    iv, tag, data = raw[:_IV_LEN], raw[_IV_LEN:_IV_LEN + _TAG_LEN], raw[_IV_LEN + _TAG_LEN:]
    plaintext = AESGCM(_kms_key()).decrypt(iv, data + tag, None)
    return plaintext.decode("utf-8")


def generate_agent_keypair() -> Dict[str, str]:
    """Fresh EOA for a new agent. Plaintext key is returned ONLY so the caller
    can encrypt it in the same expression — never persist or log it.

    NOTE: hexbytes >= 1.0 returns `key.hex()` WITHOUT the 0x prefix; viem on
    the worker side requires it. Normalize explicitly so the stored plaintext
    is always 0x-prefixed regardless of installed hexbytes version.
    """
    acct = Account.create()
    key_hex = acct.key.hex()
    if not key_hex.startswith("0x"):
        key_hex = "0x" + key_hex
    return {"address": acct.address, "private_key": key_hex}


def agent_hl_name(agent_row_id: str) -> str:
    """Deterministic named-agent label shown in HL's UI (`approveAgent` name).

    HL requires names matching ^[a-zA-Z0-9_-]+$ and users may hold multiple
    named agents; the row-id suffix keeps ours unique per agent instance.
    """
    return f"{AGENT_NAME_PREFIX}-{agent_row_id[:8]}"


async def fetch_hl_extra_agents(
    master_address: str, *, testnet: bool = False
) -> List[Dict[str, Any]]:
    """HL info `extraAgents`: the named agent wallets approved by `master`."""
    url = HL_TESTNET_INFO if testnet else HL_MAINNET_INFO
    last_err: Optional[Exception] = None
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Brief retry — HL info occasionally 429s under bursty app traffic.
        for attempt in range(3):
            try:
                res = await client.post(
                    url, json={"type": "extraAgents", "user": master_address}
                )
                if res.status_code == 429:
                    last_err = httpx.HTTPStatusError(
                        "HL rate limited", request=res.request, response=res
                    )
                    await asyncio.sleep(0.4 * (attempt + 1))
                    continue
                res.raise_for_status()
                data = res.json()
                return data if isinstance(data, list) else []
            except httpx.HTTPError as e:
                last_err = e
                await asyncio.sleep(0.4 * (attempt + 1))
    raise AiAgentError(
        f"Could not verify Hyperliquid agent approval ({last_err})"
    )


async def list_hl_sub_accounts(
    master_address: str, *, testnet: bool = False
) -> List[Dict[str, Any]]:
    """HL info `subAccounts` for `master_address` (empty list if none)."""
    url = HL_TESTNET_INFO if testnet else HL_MAINNET_INFO
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(
            url, json={"type": "subAccounts", "user": master_address}
        )
        res.raise_for_status()
        data = res.json()
    return data if isinstance(data, list) else []


async def subaccount_belongs_to_master(
    *, master_address: str, subaccount_address: str, testnet: bool = False
) -> bool:
    """True iff `subaccount_address` is one of `master_address`'s HL
    sub-accounts. Activation/creation gate for Dedicated-mode agents so a
    caller can never point an agent at an account they don't control."""
    data = await list_hl_sub_accounts(master_address, testnet=testnet)
    target = subaccount_address.lower()
    for entry in data:
        if str(entry.get("subAccountUser", "")).lower() == target:
            return True
    return False


async def get_user_lifetime_volume_usd(
    user_address: str, *, testnet: bool = False
) -> float:
    """Qualifying HL volume for Dedicated unlock (matches app getUserLifetimeVolumeUsd).

    Prefer `referral.cumVlm` (fee-tier contribution; HIP-3 growth mode ~10%).
    Fall back to portfolio allTime.vlm when referral is unavailable.
    """
    url = HL_TESTNET_INFO if testnet else HL_MAINNET_INFO
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            res = await client.post(
                url, json={"type": "referral", "user": user_address}
            )
            if res.status_code == 200:
                referral = res.json()
                if isinstance(referral, dict):
                    cum = _safe_float(referral.get("cumVlm"), default=-1.0)
                    if cum >= 0:
                        return cum
        except httpx.HTTPError:
            pass
        res = await client.post(
            url, json={"type": "portfolio", "user": user_address}
        )
        res.raise_for_status()
        data = res.json()
    if not isinstance(data, list):
        return 0.0
    for entry in data:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2 and entry[0] == "allTime":
            bucket = entry[1] if isinstance(entry[1], dict) else {}
            return _safe_float(bucket.get("vlm"))
    return 0.0


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _spot_usdc_total(spot_state: Any) -> float:
    """USDC spot balance including holds (matches frontend computeSpotUsdcOnlyUsd).

    In unified / portfolio-margin mode this *is* the shared collateral pool —
    margin locked in open perps (incl. HIP-3) shows up as `hold`, so `total`
    still reflects real account equity even when main perp accountValue is 0.
    """
    if not isinstance(spot_state, dict):
        return 0.0
    total = 0.0
    for bal in spot_state.get("balances") or []:
        if not isinstance(bal, dict):
            continue
        coin = str(bal.get("coin") or "").upper()
        token_idx = bal.get("token")
        if coin != "USDC" and token_idx != 0:
            continue
        v = _safe_float(bal.get("total"))
        if v > 0:
            total += v
    return total


async def get_hl_account_value(address: str, *, testnet: bool = False) -> float:
    """Tradable equity (USD) for `address` used as the activation anti-abuse gate.

    Must match how the app reports trade balance:
      • unifiedAccount / portfolioMargin → spot USDC total (pooled collateral;
        main `clearinghouseState.accountValue` is often 0 even with open HIP-3
        positions and real funds).
      • standard / other → main perp accountValue + spot USDC.

    An agent may only go live if this is ≥ MIN_HL_BALANCE_USD so users can't
    farm free (house-paid) AI decisions on empty accounts.
    """
    url = HL_TESTNET_INFO if testnet else HL_MAINNET_INFO
    async with httpx.AsyncClient(timeout=10.0) as client:
        perp_res, spot_res, abs_res = await asyncio.gather(
            client.post(url, json={"type": "clearinghouseState", "user": address}),
            client.post(url, json={"type": "spotClearinghouseState", "user": address}),
            client.post(url, json={"type": "userAbstraction", "user": address}),
            return_exceptions=True,
        )

    # return_exceptions=True only catches transport failures. HTTP 429/5xx still
    # yield Response objects — raise_for_status must be try/except'd so one bad
    # leg doesn't abort the whole gather and skip the pooled fallback below.
    perp_ok = False
    perp_av = 0.0
    if not isinstance(perp_res, BaseException):
        try:
            perp_res.raise_for_status()
            perp_data = perp_res.json() or {}
            perp_av = _safe_float(
                ((perp_data.get("marginSummary") or {}).get("accountValue"))
            )
            perp_ok = True
        except Exception:  # noqa: BLE001
            perp_av = 0.0

    spot_ok = False
    spot_usdc = 0.0
    if not isinstance(spot_res, BaseException):
        try:
            spot_res.raise_for_status()
            spot_usdc = _spot_usdc_total(spot_res.json())
            spot_ok = True
        except Exception:  # noqa: BLE001
            spot_usdc = 0.0

    abstraction = ""
    if not isinstance(abs_res, BaseException):
        try:
            abs_res.raise_for_status()
            raw = abs_res.json()
            # HL returns a bare string ("unifiedAccount") or occasionally an object.
            if isinstance(raw, str):
                abstraction = raw
            elif isinstance(raw, dict):
                abstraction = str(
                    raw.get("abstraction") or raw.get("userAbstraction") or ""
                )
        except Exception:  # noqa: BLE001
            abstraction = ""

    if not perp_ok and not spot_ok:
        # Total lookup failure — don't pretend the account is empty (that would
        # false-reject funded users with a $5 deposit message).
        raise AiAgentError("Could not read Hyperliquid account balance")

    pooled = abstraction in ("unifiedAccount", "portfolioMargin")
    if pooled:
        # Spot USDC (incl. holds) is the unified pool. Fall back to perp AV if
        # spot lookup failed so we don't false-reject funded accounts.
        return spot_usdc if spot_usdc > 0 else perp_av
    return perp_av + spot_usdc


async def is_agent_approved_on_hl(
    *, master_address: str, agent_address: str, testnet: bool = False
) -> bool:
    """True iff `agent_address` is currently an approved, unexpired agent of
    `master_address` on HL. This is the activation gate: a DB row alone never
    flips an agent to active."""
    import time

    agents = await fetch_hl_extra_agents(master_address, testnet=testnet)
    now_ms = time.time() * 1000
    target = agent_address.lower()
    for entry in agents:
        addr = str(entry.get("address", "")).lower()
        valid_until = float(entry.get("validUntil", 0) or 0)
        if addr == target and valid_until > now_ms:
            return True
    return False


async def get_hl_open_perp_positions(
    address: str, *, testnet: bool = False, dexes: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Live perps with non-zero size — main dex plus any HIP-3 `dexes`.

    HIP-3 positions (e.g. xyz:TSLA) live on their OWN dex clearinghouse and
    are INVISIBLE to the plain main-dex query — callers tracking HIP-3 rows
    MUST pass the dexes those symbols live on, or live positions get falsely
    adopted as closed (happened live 2026-07-20: agent's fresh xyz:TSLA open
    was marked CLOSED_BY_USER 29s after fill).

    Returns ``{symbol, direction, entry_price, szi, size_usd}``.
    """
    url = HL_TESTNET_INFO if testnet else HL_MAINNET_INFO
    out: List[Dict[str, Any]] = []
    queries: List[Dict[str, Any]] = [{"type": "clearinghouseState", "user": address}]
    for dex in dexes or []:
        d = str(dex or "").strip().lower()
        if d:
            queries.append({"type": "clearinghouseState", "user": address, "dex": d})
    async with httpx.AsyncClient(timeout=10.0) as client:
        for body in queries:
            res = await client.post(url, json=body)
            res.raise_for_status()
            data = res.json() or {}
            for ap in data.get("assetPositions") or []:
                pos = ap.get("position") if isinstance(ap, dict) else None
                if not isinstance(pos, dict):
                    continue
                szi = _safe_float(pos.get("szi"))
                if abs(szi) < 1e-12:
                    continue
                coin = str(pos.get("coin") or "").upper()
                if not coin:
                    continue
                entry = _safe_float(pos.get("entryPx"))
                out.append(
                    {
                        "symbol": coin,
                        "direction": "LONG" if szi > 0 else "SHORT",
                        "entry_price": entry,
                        "szi": szi,
                        "size_usd": abs(szi) * entry if entry > 0 else 0.0,
                    }
                )
    return out


# ── Config validation (LLM/user input is untrusted) ────────────────────────

# V1 model catalog — house API keys live on the WORKER service env
# (OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY,
# ANTHROPIC_API_KEY). The backend only validates choices; it never calls LLMs.
MODEL_REGISTRY: Dict[str, List[str]] = {
    # 3.7 is the house default; 3.6 kept so existing agent configs still validate.
    # Worker routes 3.6 / 3.5 → gemini-3.7-flash.
    "gemini": ["gemini-3.7-flash", "gemini-3.6-flash"],
    # 4.5 is the house default; 4.3 kept so existing agent configs still validate.
    # Worker routes 4.3 → grok-4.5.
    "xai": ["grok-4.5", "grok-4.3"],
    # Terra is the house OpenAI pick; 5.4 kept so existing agent configs still validate.
    # Worker routes 5.4 → gpt-5.6-terra (do not use bare gpt-5.6 — that aliases to Sol).
    "openai": ["gpt-5.6-terra", "gpt-5.4"],
    # Flash is the house DeepSeek pick (API id `deepseek-v4-flash`).
    # Pro aliases kept so existing agent configs still validate; worker routes them to flash.
    "deepseek": [
        "deepseek-v4-flash",
        "DeepSeek-V4-Flash",
        "deepseek-v4-pro",
        "DeepSeek-V4-Pro",
    ],
    # Opus 5 is the house Claude pick; 4.8 kept so older configs still validate.
    "claude": ["claude-opus-5", "claude-opus-4-8"],
}
ALLOWED_MODEL_PROVIDERS = set(MODEL_REGISTRY.keys())
# HIP-3 builder dexes agents may trade. Protocol is `{dex}:{COIN}` for any
# deployer. Tickers still must be in ASSET_METADATA for that dex (so io:SNDK
# cannot steal xyz:SNDK) and not excluded / pre-IPO.
SUPPORTED_HIP3_DEXES = {"xyz", "io"}
# HIP-3 coin parts agents may NOT manage — no meaningful CoinGlass/options/
# underlier stack (or deferred categories). Keep in sync with
# `AI_AGENT_HIP3_EXCLUDED_COINS` in `frontend/src/lib/aiAgentHip3Exclude.ts`.
# DRAM + EWY intentionally kept (real US ETFs with options).
# GOLD + SILVER kept (Massive GLD/SLV proxy options + DXY/EMA metals stack).
AI_AGENT_HIP3_EXCLUDED_COINS = frozenset({
    "PURRDAT",
    "SMSN",
    "BOT",
    "CXMT",
    "UNITREE",
    "ANTH",  # EntropyIO pre-IPO — no listed options underlier
    "EUR",
    "JPY",
    "PLATINUM",
    "PALLADIUM",
    "COPPER",
    "CL",
    "BZ",
    "BRENTOIL",
    "NATGAS",
    "URNM",
    "GOLDSPOT",
    "XYZ100",
    "SP500",
})
# 1 symbol per agent: opening/monitor decisions are per-symbol with NO
# portfolio-level coordination — multi-symbol budget contention is first-come
# (not conviction-ranked) and correlated exposure is invisible. Direction +
# mandate are also per-agent, so per-asset strategy is the honest unit.
# Existing multi-symbol agents are grandfathered (validation only runs on
# create/edit). Keep in sync with AI_AGENT_LIMITS.maxSymbols in the app.
# TODO(portfolio-brain): raise this once a portfolio-level pass exists
# (conviction budget across assets, correlation awareness, opportunity cost).
MAX_SYMBOLS_PER_AGENT = 1
# HL's highest asset max-leverage is 50x (lowest 1x); the adapter additionally
# clamps per-asset to the meta maxLeverage so 50x on a 25x asset trades at 25x.
MAX_LEVERAGE_CAP = 50
MIN_CAPITAL_USD = 100
MAX_CAPITAL_USD = 10_000_000
MIN_POSITION_USD = 20
# Anti-abuse: an agent may only ACTIVATE if the account it will trade holds at
# least this much. Aligned with MIN_CAPITAL_USD so a $100 paper budget cannot
# go live on a dust wallet and burn house LLM credits every cycle. (HL's
# deposit floor is ~$5; we require real headroom.)
MIN_HL_BALANCE_USD = 100.0
# Hard ceiling on concurrently *active* agents (status=active). Allows a full
# Shared (2) + Dedicated (10) fleet to run at once. Product slot caps below are
# separate (stop/pause still hold a product slot in their mode's pool).
MAX_ACTIVE_AGENTS_PER_USER = 12
# Separate product-slot pools (counted per mode):
# - Shared/copilot: 2 — HL ~3 named agents minus device `HyperTrade`.
#   Drafts do not count (named-agent approval happens at activate).
# - Dedicated: 10 — HL base sub-account limit after volume unlock.
#   Drafts count (createSubAccount + fund runs at Create).
MAX_AGENT_SLOTS_SHARED = 2
MAX_AGENT_SLOTS_DEDICATED = 10
# - Resident (BuilderPad): one HD 2 balance per login, so one resident agent
#   at a time across every app. A second project would share margin and
#   liquidation. Drafts count. Revoke frees the slot. Dedicated sub-accounts
#   (mobile, ~$100k volume) stay a later option — not this path.
MAX_AGENT_SLOTS_RESIDENT = 1
AGENT_MODES = ("copilot", "dedicated", "resident")
# Backend flag for the resident product (web console checks its own VITE flag).
BUILDERPAD_RESIDENTS_ENABLED = os.getenv("BUILDERPAD_RESIDENTS_ENABLED", "").strip() == "1"
# HL protocol gate for creating sub-accounts (~$100k qualifying volume).
DEDICATED_MIN_VOLUME_USD = 100_000.0
MAX_AGENT_DISPLAY_NAME_LEN = 64


def counts_toward_product_slot(
    status: Optional[str], mode: Optional[str] = None
) -> bool:
    """Whether this row occupies a product slot in its mode's pool.

    Stop/pause keep the slot. Revoke frees the product slot.
    Shared drafts do not count (HL named-agent booked at activate).
    Dedicated drafts count (HL sub-account created at Create).
    Resident drafts count (one HD 2 resident per login, including a draft).
    """
    st = status or ""
    if st == "revoked":
        return False
    if st == "draft":
        return normalize_agent_mode(mode) in ("dedicated", "resident")
    return True


def normalize_agent_mode(mode: Optional[str]) -> str:
    m = mode or ""
    if m == "dedicated":
        return "dedicated"
    if m == "resident":
        return "resident"
    return "copilot"


def product_slot_max_for_mode(mode: Optional[str]) -> int:
    """Per-mode product cap: Shared 2, Dedicated 10, Resident 1 (independent pools)."""
    normalized = normalize_agent_mode(mode)
    if normalized == "dedicated":
        return MAX_AGENT_SLOTS_DEDICATED
    if normalized == "resident":
        return MAX_AGENT_SLOTS_RESIDENT
    return MAX_AGENT_SLOTS_SHARED


def mode_label(mode: Optional[str]) -> str:
    """User-facing pool name for slot errors."""
    normalized = normalize_agent_mode(mode)
    if normalized == "dedicated":
        return "Dedicated"
    if normalized == "resident":
        return "Resident"
    return "Shared"


def normalize_agent_display_name(
    name: Optional[str], *, default: Optional[str] = None
) -> str:
    """Strip + enforce display-name length. Rejects oversize names (no silent truncate)."""
    raw = (name or "").strip()
    if not raw:
        if default is not None:
            return default
        raise AiAgentError("Name is required")
    if len(raw) > MAX_AGENT_DISPLAY_NAME_LEN:
        raise AiAgentError(
            f"Name must be at most {MAX_AGENT_DISPLAY_NAME_LEN} characters"
        )
    return raw


def _hip3_catalog_row(coin: str) -> tuple[str | None, bool]:
    """Return `(catalog_dex, is_pre_ipo)` for a HIP-3 coin part.

    Late-imports `ASSET_METADATA` to avoid a module-load cycle with server.py.
    Missing row → `(None, False)` so unlisted `io:SNDK` cannot sneak through.
    """
    try:
        from server import ASSET_METADATA  # type: ignore
    except Exception:
        return None, False
    coin_u = (coin or "").upper()
    if not coin_u:
        return None, False
    meta = ASSET_METADATA.get(coin_u)
    if meta is None:
        for key, row in ASSET_METADATA.items():
            api_sym = str((row or {}).get("symbol") or key)
            if api_sym.upper() == coin_u or str(key).upper() == coin_u:
                meta = row
                break
    if not meta:
        return None, False
    dex = str(meta.get("dex") or "xyz").lower()
    return dex, bool(meta.get("isPreIpo"))


def validate_agent_config(
    config: Dict[str, Any], *, mode: str = "copilot"
) -> Dict[str, Any]:
    """Sanitize the user-supplied agent config; raises AiAgentError.

    ``max_capital_usd`` is always a notional ceiling (copilot and dedicated).
    Dedicated sub funding is a client-side USDC transfer — not this field.
    """
    if mode not in AGENT_MODES:
        raise AiAgentError("mode must be 'copilot', 'dedicated' or 'resident'")
    symbols = config.get("symbols")
    if not isinstance(symbols, list) or not symbols:
        raise AiAgentError("config.symbols must be a non-empty list")
    if len(symbols) > MAX_SYMBOLS_PER_AGENT:
        raise AiAgentError(
            "AI agents trade one asset each — create a separate agent per symbol"
            if MAX_SYMBOLS_PER_AGENT == 1
            else f"At most {MAX_SYMBOLS_PER_AGENT} symbols per agent"
        )
    clean_symbols: List[str] = []
    for s in symbols:
        if not isinstance(s, str) or not s.strip():
            raise AiAgentError("config.symbols entries must be strings")
        sym = s.strip()
        if ":" in sym:
            # HIP-3 builder-dex symbols (stocks/commodities/etc). Unified
            # accounts trade these from spot USDC with the agent key — proven
            # by the xyz spike; no sendAsset funding involved. Canonical form
            # `xyz:TSLA` (dex lowercase, coin uppercase).
            dex, _, coin = sym.partition(":")
            dex = dex.strip().lower()
            coin = coin.strip().upper()
            if dex not in SUPPORTED_HIP3_DEXES:
                raise AiAgentError(f"HIP-3 dex not supported: {dex}")
            if not coin.isalnum():
                raise AiAgentError(f"Invalid symbol: {sym}")
            catalog_dex, is_pre_ipo = _hip3_catalog_row(coin)
            if catalog_dex is None:
                raise AiAgentError(f"{coin} is not in the HyperTrade catalog")
            if catalog_dex != dex:
                raise AiAgentError(
                    f"{coin} is listed on {catalog_dex}, not {dex}"
                )
            if is_pre_ipo or coin in AI_AGENT_HIP3_EXCLUDED_COINS:
                raise AiAgentError(
                    f"{coin} is not available for AI agents "
                    "(insufficient market data for autonomous trading)"
                )
            clean_symbols.append(f"{dex}:{coin}")
            continue
        sym = sym.upper()
        if not sym.isalnum():
            raise AiAgentError(f"Invalid symbol: {sym}")
        clean_symbols.append(sym)

    models = config.get("models") or {}

    def _validated_model(entry: Dict[str, Any], label: str) -> Dict[str, str]:
        provider = entry.get("provider")
        if provider not in ALLOWED_MODEL_PROVIDERS:
            raise AiAgentError(f"{label}.provider must be one of {sorted(ALLOWED_MODEL_PROVIDERS)}")
        model = entry.get("model")
        if not isinstance(model, str) or model.strip() not in MODEL_REGISTRY[provider]:
            raise AiAgentError(
                f"{label}.model must be one of {MODEL_REGISTRY[provider]} for provider {provider}"
            )
        return {"provider": provider, "model": model.strip()}

    opening_raw = models.get("opening") or {}
    opening = _validated_model(opening_raw, "models.opening")

    def _optional_model(key: str) -> Optional[Dict[str, str]]:
        entry = models.get(key)
        if not entry:
            return None
        return _validated_model(entry, f"models.{key}")

    max_capital = config.get("max_capital_usd")
    if not isinstance(max_capital, (int, float)) or not (
        MIN_CAPITAL_USD <= max_capital <= MAX_CAPITAL_USD
    ):
        raise AiAgentError(
            f"config.max_capital_usd must be between {MIN_CAPITAL_USD} and {MAX_CAPITAL_USD}"
        )

    leverage_cap = config.get("leverage_cap", 10)
    if not isinstance(leverage_cap, (int, float)) or not (1 <= leverage_cap <= MAX_LEVERAGE_CAP):
        raise AiAgentError(f"config.leverage_cap must be between 1 and {MAX_LEVERAGE_CAP}")

    margin_mode = config.get("margin_mode", "cross")
    if margin_mode not in ("cross", "isolated"):
        raise AiAgentError("config.margin_mode must be 'cross' or 'isolated'")

    # Entry appetite. 'aggressive' lowers the worker's conviction gates and
    # softens sideline guidance — size bands / stops / monitor risk management
    # are identical across profiles (more positions, never bigger ones).
    risk_profile = config.get("risk_profile", "standard")
    if risk_profile not in ("standard", "aggressive"):
        raise AiAgentError("config.risk_profile must be 'standard' or 'aggressive'")
    # TEMPORARY (testing-phase data collection, 2026-07): every created/edited
    # agent runs aggressive and the app hides the selector, so decision data
    # accumulates faster. Flip to False to restore user choice — standard-
    # profile code paths in the worker/prompts are fully intact.
    if FORCE_AGGRESSIVE_RISK_PROFILE:
        risk_profile = "aggressive"

    # Trading horizon: scalper (hours) | swing (days) | investor (weeks/month+,
    # hourly opens + 4h monitors by default; wider geometry / EMA-heavy).
    horizon = config.get("horizon", "scalper")
    if horizon not in ("scalper", "swing", "investor"):
        raise AiAgentError("config.horizon must be 'scalper', 'swing', or 'investor'")

    # Direction constraint (what the agent MAY do) + mandate (what success
    # means). Defaults keep existing agents/behavior: free form + active.
    direction = config.get("direction", "long_short")
    if direction not in ("long_short", "long_only", "short_only"):
        raise AiAgentError(
            "config.direction must be 'long_short', 'long_only', or 'short_only'"
        )
    mandate = config.get("mandate", "active")
    if mandate not in ("active", "accumulate"):
        raise AiAgentError("config.mandate must be 'active' or 'accumulate'")
    # Accumulate = build a position patiently in ONE direction (long: buy
    # weakness; short: sell strength). Free-form has no side to accumulate.
    if mandate == "accumulate" and direction == "long_short":
        raise AiAgentError(
            "config.mandate 'accumulate' requires direction 'long_only' or 'short_only'"
        )

    # Optional per-position clamp within the notional ceiling.
    notional_ceiling = float(max_capital)
    max_position = config.get("max_position_usd")
    if max_position is not None:
        if not isinstance(max_position, (int, float)) or max_position < MIN_POSITION_USD:
            raise AiAgentError(
                f"config.max_position_usd must be at least {MIN_POSITION_USD}"
            )
        if max_position > notional_ceiling:
            raise AiAgentError(
                "config.max_position_usd cannot exceed notional budget "
                f"(${notional_ceiling:g} max total notional)"
            )

    return {
        "symbols": clean_symbols,
        "models": {
            "opening": opening,
            **({"monitor_win": m} if (m := _optional_model("monitor_win")) else {}),
            **({"monitor_loss": m} if (m := _optional_model("monitor_loss")) else {}),
        },
        "max_capital_usd": float(max_capital),
        **({"max_position_usd": float(max_position)} if max_position is not None else {}),
        "leverage_cap": float(leverage_cap),
        "margin_mode": margin_mode,
        "risk_profile": risk_profile,
        "horizon": horizon,
        "direction": direction,
        "mandate": mandate,
    }


def find_copilot_symbol_conflict(
    *,
    peer_rows: List[Dict[str, Any]],
    symbols: List[str],
    master_address: str,
    trading_env: str,
) -> Optional[Dict[str, str]]:
    """Copilots (and residents) on the same master+env share one HL wallet —
    symbols must be unique across draft/active/paused peers (models don't
    matter). Dedicated agents keep separate sub-accounts and are ignored here.
    A copilot on HD 0 and a resident on HD 2 never collide (different master).

    Returns ``{symbol, peer_name, peer_id}`` or ``None``.
    """
    want = {str(s).strip().upper() for s in symbols if s}
    if not want:
        return None
    master = (master_address or "").strip().lower()
    for row in peer_rows:
        if (row.get("mode") or "") not in ("copilot", "resident"):
            continue
        if (row.get("hl_master_address") or "").strip().lower() != master:
            continue
        if (row.get("trading_env") or "mainnet") != trading_env:
            continue
        if row.get("status") not in ("draft", "active", "paused"):
            continue
        peer_syms = (row.get("config") or {}).get("symbols") or []
        for s in peer_syms:
            su = str(s).strip().upper()
            if su in want:
                return {
                    "symbol": su,
                    "peer_name": (row.get("name") or "another agent").strip() or "another agent",
                    "peer_id": str(row.get("id") or ""),
                }
    return None
