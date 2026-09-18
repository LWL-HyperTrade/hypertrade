"""PONS v2 ONLY.

Canonical docs: https://docs.ponsfamily.com/v2
Do NOT follow https://docs.ponsfamily.com/ — that is v1 (Uniswap v3,
WETH-only, no bonding curve, factory 0xA5aAb3… / locker shares).

Pons v2 (Robinhood Chain) helpers for the BuilderPad coin chapter.

Read-only. The backend never signs Pons transactions — HD 0 in the browser
does. This module:

  * lists quote assets a create flow may offer: ETH plus the tokenised stocks
    Robinhood publishes at https://api.robinhood.com/rhj/assets (the registry
    docs.robinhood.com/chain/contracts loads), filtered by our curated symbol
    list and then live-checked against the Pons factory exactly as the docs
    say (`approvedPairTokens` + `pairTokenEconomics`, skip if either is off).
    The approved list is process-global until `PONS_QUOTE_SYMBOLS` (or the
    factory / USDG address) changes — `?refresh=true` rebuilds it;
  * verifies a launch a creator reports, by reading `getLaunchedToken` and
    checking `exists` and that `deployer` is the creator's trade wallet.

Sources: https://docs.ponsfamily.com/v2 (Contracts, Choosing a quote asset,
Reading the launch record). Chain RPC default = viem `robinhood`.
"""
from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

import httpx
from web3 import Web3

logger = logging.getLogger(__name__)

ROBINHOOD_CHAIN_ID = 4663
ROBINHOOD_RPC_URL = (
    os.getenv("ROBINHOOD_RPC_URL") or "https://rpc.mainnet.chain.robinhood.com"
).strip()

# BuilderPad's own Pons v2 fork (Robinhood Chain) — `BuilderPad*` contracts,
# stack v2 deployed 2026-09-14. Same ABI as official Pons v2; different
# economics. Source of truth: contracts/pons-v2/deployments/4663.json and
# docs/PONS_FORK.md §4. Must match web/src/lib/pons/chain.ts `PONS`.
# Not this stack: official Pons v2 factory 0x7eD598Bc…, and our superseded v1
# stack (factory 0x1ef3bAD2…). Launches there do not exist here.
PONS_FACTORY = Web3.to_checksum_address("0x519580283eAEabF01d5Db061862d180c4596e709")
PONS_FEE_ESCROW = Web3.to_checksum_address("0x2F97d17Aba64bA843EFccAd5479ff8d35Be097d2")
PONS_LAUNCH_AND_BUY = Web3.to_checksum_address("0x9824953E1b8aA71Da182356776f54949eb8774CC")
NATIVE_QUOTE = "0x0000000000000000000000000000000000000000"

# Robinhood asset registry (what docs.robinhood.com/chain/contracts renders).
ROBINHOOD_ASSETS_URL = "https://api.robinhood.com/rhj/assets"
# Stable non-stock quote from the same docs page.
ROBINHOOD_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"

# Curated candidates. Edit this list (add/remove a ticker) to rebuild the
# process-wide quote cache on the next request — factory reads do not run on
# a timer. Only assets Pons has approved on-chain ever reach the wizard.
PONS_QUOTE_SYMBOLS: List[str] = [
    "NVDA",
    "TSLA",
    "AAPL",
    "MSFT",
    "AMZN",
    "GOOGL",
    "META",
    "SPY",
    "HOOD",
    "COIN",
    "MSTR",
    "AMD",
    "NFLX",
    "PLTR",
    "GME",
    "AMC",
    "SPCX",
]

_QUOTE_WORKERS = 8

# JSON ABI for the reads we need — types per the docs' parseAbi strings.
_FACTORY_ABI: List[Dict[str, Any]] = [
    {
        "type": "function",
        "name": "approvedPairTokens",
        "stateMutability": "view",
        "inputs": [{"name": "pairToken", "type": "address"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "pairTokenEconomics",
        "stateMutability": "view",
        "inputs": [{"name": "pairToken", "type": "address"}],
        "outputs": [
            {"name": "phantomQuote", "type": "uint256"},
            {"name": "graduationThreshold", "type": "uint256"},
            {"name": "decimals", "type": "uint8"},
        ],
    },
    {
        "type": "function",
        "name": "getLaunchedToken",
        "stateMutability": "view",
        "inputs": [{"name": "token", "type": "address"}],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "token", "type": "address"},
                    {"name": "curve", "type": "address"},
                    {"name": "deployer", "type": "address"},
                    {"name": "creatorFeeRecipient", "type": "address"},
                    {"name": "pairToken", "type": "address"},
                    {"name": "graduationThreshold", "type": "uint256"},
                    {"name": "poolFee", "type": "uint24"},
                    {"name": "tickSpacing", "type": "int24"},
                    {"name": "creatorTaxBps", "type": "uint16"},
                    {"name": "buybackEnabled", "type": "bool"},
                    {"name": "phase", "type": "uint8"},
                    {"name": "sweptQuote", "type": "uint256"},
                    {"name": "sweptTokens", "type": "uint256"},
                    {"name": "sweptAt", "type": "uint256"},
                    {"name": "exists", "type": "bool"},
                ],
            }
        ],
    },
]


class PonsError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


_w3_lock = threading.Lock()
_w3: Optional[Web3] = None


def make_web3() -> Web3:
    global _w3
    with _w3_lock:
        if _w3 is not None:
            return _w3
        w3 = Web3(Web3.HTTPProvider(ROBINHOOD_RPC_URL, request_kwargs={"timeout": 15}))
        cid = w3.eth.chain_id
        if cid != ROBINHOOD_CHAIN_ID:
            raise PonsError(
                f"Robinhood RPC returned chain {cid}, expected {ROBINHOOD_CHAIN_ID}", 503
            )
        _w3 = w3
        return w3


def _factory(w3: Web3):
    return w3.eth.contract(address=PONS_FACTORY, abi=_FACTORY_ABI)


# --------------------------------------------------------------------------- #
# Robinhood registry — only fetched when the quote list is rebuilt
# --------------------------------------------------------------------------- #

def fetch_registry() -> List[Dict[str, Any]]:
    """Active Robinhood stock tokens deployed on chain 4663."""
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(ROBINHOOD_ASSETS_URL, headers={"accept": "application/json"})
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("robinhood registry fetch failed: %s", exc)
        return []
    out: List[Dict[str, Any]] = []
    for row in data.get("assets") or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("status") or "") != "ASSET_STATUS_ACTIVE":
            continue
        addr = None
        for dep in row.get("deployments") or []:
            if isinstance(dep, dict) and int(dep.get("chainId") or 0) == ROBINHOOD_CHAIN_ID:
                addr = dep.get("contractAddress")
                break
        if not addr:
            continue
        out.append(
            {
                "symbol": str(row.get("tokenSymbol") or "").upper(),
                "name": str(row.get("tokenName") or ""),
                "address": Web3.to_checksum_address(addr),
                "decimals": int(row.get("tokenDecimals") or 18),
                "logo_url": str(row.get("logoUrl") or ""),
            }
        )
    return out


def candidate_quote_tokens() -> List[Dict[str, Any]]:
    by_symbol = {a["symbol"]: a for a in fetch_registry()}
    out: List[Dict[str, Any]] = []
    for sym in PONS_QUOTE_SYMBOLS:
        row = by_symbol.get(sym.upper())
        if row:
            out.append(row)
    out.append(
        {
            "symbol": "USDG",
            "name": "USDG",
            "address": Web3.to_checksum_address(ROBINHOOD_USDG),
            "decimals": None,
            "logo_url": "",
        }
    )
    return out


# --------------------------------------------------------------------------- #
# Pons factory reads — process-global until curated assets / factory change
# --------------------------------------------------------------------------- #

_quotes_lock = threading.Lock()
_quotes_cache: Dict[str, Any] = {"key": None, "quotes": None}


def _quotes_identity() -> Tuple[str, str, Tuple[str, ...]]:
    """Bumps when we add/remove a ticker or move factory / USDG — not on a timer."""
    return (
        PONS_FACTORY,
        ROBINHOOD_USDG,
        tuple(s.upper() for s in PONS_QUOTE_SYMBOLS),
    )


def _native_eth_quote() -> Dict[str, Any]:
    return {
        "pair_token": NATIVE_QUOTE,
        "symbol": "ETH",
        "name": "Ether",
        "decimals": 18,
        "logo_url": "",
        "native": True,
    }


def _read_candidate(factory, cand: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        approved = factory.functions.approvedPairTokens(cand["address"]).call()
        phantom, threshold, decimals = factory.functions.pairTokenEconomics(cand["address"]).call()
    except Exception as exc:  # noqa: BLE001
        logger.info("pons quote read failed for %s: %s", cand["symbol"], exc)
        return None
    if not approved or int(phantom) == 0 or int(threshold) == 0:
        return None
    return {
        "pair_token": cand["address"],
        "symbol": cand["symbol"],
        "name": cand["name"],
        "decimals": int(decimals),
        "logo_url": cand["logo_url"],
        "native": False,
        "graduation_threshold": str(threshold),
    }


def _build_quote_assets() -> List[Dict[str, Any]]:
    quotes: List[Dict[str, Any]] = [_native_eth_quote()]
    candidates = candidate_quote_tokens()
    w3 = make_web3()
    factory = _factory(w3)
    found: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=_QUOTE_WORKERS) as pool:
        futs = {pool.submit(_read_candidate, factory, cand): cand["symbol"] for cand in candidates}
        for fut in as_completed(futs):
            row = fut.result()
            if row:
                found[row["symbol"].upper()] = row
    for cand in candidates:
        row = found.get(str(cand["symbol"]).upper())
        if row:
            quotes.append(row)
    return quotes


def quote_assets(force: bool = False) -> List[Dict[str, Any]]:
    """ETH plus every curated candidate the Pons factory currently approves.

    Cached for the life of the process. Rebuilds only when `PONS_QUOTE_SYMBOLS`
    / factory / USDG change, or `force` (`GET …/pons/quotes?refresh=true`).
    A failed RPC rebuild is not stored, so the next request retries.
    """
    key = _quotes_identity()
    with _quotes_lock:
        cached = _quotes_cache["quotes"]
        if not force and cached is not None and _quotes_cache["key"] == key:
            return list(cached)
        try:
            quotes = _build_quote_assets()
        except Exception as exc:  # noqa: BLE001
            logger.warning("pons quote list: RPC unavailable, ETH only: %s", exc)
            if cached is not None and _quotes_cache["key"] == key:
                return list(cached)
            return [_native_eth_quote()]
        _quotes_cache["key"] = key
        _quotes_cache["quotes"] = quotes
        logger.info("pons quote list rebuilt (%s assets)", len(quotes))
        return list(quotes)


def warmup_quote_assets() -> None:
    """Fill the process cache at boot so the wizard is not the first RPC pass."""
    try:
        quote_assets()
    except Exception as exc:  # noqa: BLE001
        logger.warning("pons quote warmup failed: %s", exc)


def verify_launch(token: str, owner_wallet: str) -> Dict[str, Any]:
    """Read the factory record for `token` and prove the creator launched it.

    Fails closed: RPC trouble → 503, missing record or wrong deployer → 400.
    """
    if not Web3.is_address(token):
        raise PonsError("Invalid token address")
    if not owner_wallet or not Web3.is_address(owner_wallet):
        raise PonsError(
            "This app has no trade wallet on file. Reload the page so your wallet is ready, then retry — "
            "the token is already on-chain and will attach."
        )
    try:
        w3 = make_web3()
        rec = _factory(w3).functions.getLaunchedToken(Web3.to_checksum_address(token)).call()
    except PonsError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("pons verify_launch RPC failed: %s", exc)
        raise PonsError("Could not verify the launch on Robinhood Chain — try again", 503)

    (
        rec_token,
        curve,
        deployer,
        creator_fee_recipient,
        pair_token,
        _threshold,
        _pool_fee,
        _tick,
        creator_tax_bps,
        buyback_enabled,
        phase,
        _sq,
        _st,
        _sa,
        exists,
    ) = rec
    if not exists:
        raise PonsError("Pons factory has no launch record for that token")
    if str(deployer).lower() != owner_wallet.lower():
        raise PonsError("That token was not launched by this app's trade wallet")
    return {
        "token": Web3.to_checksum_address(rec_token),
        "curve": Web3.to_checksum_address(curve),
        "pair_token": Web3.to_checksum_address(pair_token),
        "creator_fee_recipient": Web3.to_checksum_address(creator_fee_recipient),
        "creator_tax_bps": int(creator_tax_bps),
        "buyback_enabled": bool(buyback_enabled),
        "phase": int(phase),
    }
