"""
Public read-only AI-agent showcase payloads.

Allowlist: SHOWCASE_AGENT_IDS=uuid,uuid,... (empty/unset → no agents).
No auth. No ciphertexts / private keys. Cached ~28s to avoid HL weight burn.
"""
from __future__ import annotations

import asyncio
import math
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Awaitable, Set, Tuple

# Slightly under the client poll (30s) so most refreshes hit a warm cache
# and concurrent visitors share one HL/Supabase rebuild.
SHOWCASE_CACHE_TTL_SEC = 28.0
BASELINE_USD = 1000.0
# Agent cloids start with ASCII "HTAI" — same as frontend/src/lib/aiAgentCloid.ts
_HTAI_CLOID_PREFIX = "0x48544149"
_SHOWCASE_FILL_LIMIT = 40
# Always probe these HIP-3 dexs so a listed xyz:* / io:* on an agent surfaces
# (mirrors backend/ai_agents.py SUPPORTED_HIP3_DEXES).
_SHOWCASE_HIP3_DEXES = ("xyz", "io")

# Skips we surface in Recent decisions (loss pause, risk gates, data outages,
# manual-open sideline, paused/stopped). Omit noisy per-cycle skips like
# peer_symbol / no_new_bar that would drown the feed — but DO show
# no_data/no_price and user_conflict so visitors aren't left wondering why
# an hourly slot vanished.
_SHOWCASE_SKIP_TYPES = frozenset(
    {
        "skipped_cooldown",
        "skipped_monitor_window",
        "skipped_earnings_window",
        "skipped_trend_filter",
        "skipped_budget",
        "skipped_margin",
        "skipped_thin_book",
        "skipped_direction_mandate",
        "skipped_no_data",
        "skipped_no_price",
        "skipped_user_conflict",
        "skipped_stopped",
        "skipped_paused",
    }
)

_FetchHl = Callable[..., Awaitable[Any]]

# Process-local cache + lock. Fine for a single ASGI worker (typical Railway
# deploy). Multi-worker / multi-replica would N-duplicate HL rebuilds — move
# to Redis (or similar) before scaling that way.
_cache: Dict[str, Any] = {"ts": 0.0, "payload": None}
_refresh_lock = asyncio.Lock()


def _showcase_decision_visible(dtype: str) -> bool:
    if not dtype.startswith("skipped"):
        return True
    return dtype in _SHOWCASE_SKIP_TYPES


def showcase_agent_ids() -> List[str]:
    """Allowlist from SHOWCASE_AGENT_IDS (comma-separated UUIDs).

    Empty / unset → no agents (useful while preparing a new lineup).
    """
    raw = (os.getenv("SHOWCASE_AGENT_IDS") or "").strip()
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


# HL portfolio returns every window in ONE response — pick densest that still
# covers agent create (no extra GETs). Shorter windows sample ~15m; allTime
# gets coarser as the wallet ages.
_PERIOD_ALIASES: Dict[str, Tuple[str, ...]] = {
    "day": ("day", "perpDay"),
    "week": ("week", "perpWeek"),
    "month": ("month", "perpMonth"),
    "allTime": ("allTime", "perpAllTime"),
}
# (period, max age of since_ms relative to now). None = always ok.
_PERIOD_MAX_AGE_MS: Tuple[Tuple[str, Optional[int]], ...] = (
    ("day", 24 * 60 * 60 * 1000),
    ("week", 7 * 24 * 60 * 60 * 1000),
    ("month", 30 * 24 * 60 * 60 * 1000),
    ("allTime", None),
)


def _parse_period_entry(portfolio: Any, period: str) -> Optional[Dict[str, Any]]:
    if portfolio is None:
        return None
    aliases = _PERIOD_ALIASES.get(period, (period,))
    if isinstance(portfolio, dict):
        for key in aliases:
            if key in portfolio and isinstance(portfolio[key], dict):
                return portfolio[key]
        nested = portfolio.get("portfolio") or portfolio.get("perp") or portfolio.get("summary")
        if isinstance(nested, dict):
            for key in aliases:
                if isinstance(nested.get(key), dict):
                    return nested[key]
        return None
    if isinstance(portfolio, list):
        alias_set = set(aliases)
        for entry in portfolio:
            if (
                isinstance(entry, (list, tuple))
                and len(entry) >= 2
                and entry[0] in alias_set
            ):
                return entry[1] if isinstance(entry[1], dict) else None
    return None


def _portfolio_entry_for_agent(
    portfolio: Any,
    *,
    since_ms: Optional[int],
) -> Optional[Dict[str, Any]]:
    """Shortest HL window that still covers agent create → denser curve, 0 extra calls."""
    now_ms = int(time.time() * 1000)
    # 2h slack so a "day" window isn't dropped right at the 24h boundary.
    slack_ms = 2 * 60 * 60 * 1000
    for period, max_age in _PERIOD_MAX_AGE_MS:
        if max_age is not None and since_ms is not None and since_ms > 0:
            if since_ms < now_ms - max_age - slack_ms:
                continue
        entry = _parse_period_entry(portfolio, period)
        hist = entry.get("pnlHistory") if isinstance(entry, dict) else None
        if isinstance(hist, list) and len(hist) >= 2:
            return entry
    return _parse_period_entry(portfolio, "allTime") or _parse_period_entry(
        portfolio, "month"
    )


def _ts_to_ms(t: int) -> int:
    """HL portfolio timestamps are usually ms; tolerate seconds."""
    return t * 1000 if t < 1_000_000_000_000 else t


def indexed_equity_from_pnl_history(
    entry: Optional[Dict[str, Any]],
    *,
    since_ms: Optional[int] = None,
) -> List[Dict[str, float]]:
    """HL pnlHistory → [{t, indexed}] where indexed = 1000 + PnL since baseline.

    When ``since_ms`` is set (agent created_at), rebase so the chart shows
    performance from that moment — not the wallet's full historical curve.
    Anchor = last cumulative PnL at/before since_ms (else first point on/after).
    """
    if not entry:
        return []
    hist = entry.get("pnlHistory")
    if not isinstance(hist, list):
        return []
    raw: List[Tuple[int, float]] = []
    for row in hist:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        try:
            t = int(row[0])
            pnl = float(row[1])
        except (TypeError, ValueError):
            continue
        if not (t > 0 and abs(pnl) < 1e12):
            continue
        raw.append((t, pnl))
    if not raw:
        return []

    anchor = 0.0
    if since_ms is not None and since_ms > 0:
        prior = [pnl for (t, pnl) in raw if _ts_to_ms(t) <= since_ms]
        if prior:
            anchor = prior[-1]
        else:
            # No history before create — start flat at the first post-create point.
            after = [pnl for (t, pnl) in raw if _ts_to_ms(t) >= since_ms]
            anchor = after[0] if after else raw[0][1]
        raw = [(t, pnl) for (t, pnl) in raw if _ts_to_ms(t) >= since_ms]
        if not raw:
            return []

    out: List[Dict[str, float]] = [
        {"t": t, "indexed": round(BASELINE_USD + (pnl - anchor), 2)} for t, pnl in raw
    ]
    # Synthetic start at agent create so the line opens on the $1k baseline
    # even when the first HL sample lands a bit later.
    if since_ms is not None and since_ms > 0:
        first_t = out[0]["t"]
        first_ms = _ts_to_ms(first_t)
        if first_ms > since_ms + 60_000:
            # Match HL unit (ms vs sec) for the synthetic point.
            synth_t = since_ms if first_t >= 1_000_000_000_000 else since_ms // 1000
            out.insert(0, {"t": synth_t, "indexed": BASELINE_USD})

    # Downsample for chart payload size (keep endpoints + evenly spaced middles).
    # ceil so e.g. 241..399 points actually thin (floor //200 stays 1 until 400).
    if len(out) > 240:
        step = max(1, math.ceil(len(out) / 200))
        trimmed = out[::step]
        if trimmed[-1]["t"] != out[-1]["t"]:
            trimmed.append(out[-1])
        out = trimmed
    return out


def _normalize_house_model(provider: str, model: str) -> str:
    """Map legacy catalog ids → current house wire names (mirror worker executor).

    Showcase agents may still store older picks (gpt-5.4, grok-4.3, …) while
    the worker routes those onto the live catalog at call time — surface the
    live name so badges match the app.
    """
    p = (provider or "").strip().lower()
    key = (model or "").strip()
    kl = key.lower()
    if not p and key:
        if "gpt" in kl or kl.startswith("o1") or kl.startswith("o3"):
            p = "openai"
        elif "deepseek" in kl:
            p = "deepseek"
        elif "grok" in kl:
            p = "xai"
        elif "gemini" in kl:
            p = "gemini"
        elif "claude" in kl:
            p = "claude"

    if p == "openai":
        aliases = {
            "gpt-5.6-terra": "gpt-5.6-terra",
            "gpt-5.6-Terra": "gpt-5.6-terra",
            "gpt-5.4": "gpt-5.6-terra",
            "gpt-5.4-mini": "gpt-5.6-terra",
        }
        return aliases.get(key, "gpt-5.6-terra")
    if p == "deepseek":
        aliases = {
            "deepseek-v4-flash": "deepseek-v4-flash",
            "DeepSeek-V4-Flash": "deepseek-v4-flash",
            "DeepSeek-V4-Flash-0731": "deepseek-v4-flash",
            "deepseek-v4-pro": "deepseek-v4-flash",
            "DeepSeek-V4-Pro": "deepseek-v4-flash",
        }
        return aliases.get(key, "deepseek-v4-flash")
    if p == "xai":
        aliases = {
            "grok-4.5": "grok-4.5",
            "grok-4.3": "grok-4.5",
        }
        return aliases.get(key, "grok-4.5")
    if p == "gemini":
        aliases = {
            "gemini-3.7-flash": "gemini-3.7-flash",
            "gemini-3.6-flash": "gemini-3.7-flash",
            "gemini-3.5-flash": "gemini-3.7-flash",
            "gemini-3.5-flash-preview": "gemini-3.7-flash",
        }
        return aliases.get(key, "gemini-3.7-flash")
    if p == "claude":
        aliases = {
            "claude-opus-5": "claude-opus-5",
            "claude-opus-4-8": "claude-opus-5",
            "claude-opus-4.8": "claude-opus-5",
        }
        return aliases.get(key, key if key.startswith("claude-") else "claude-opus-5")
    return key


def _model_label(config: Dict[str, Any]) -> str:
    opening = ((config or {}).get("models") or {}).get("opening") or {}
    model = str(opening.get("model") or "").strip()
    provider = str(opening.get("provider") or "").strip()
    if model or provider:
        return _normalize_house_model(provider, model) or provider or "—"
    return "—"


def _extract_tpsl(order: Dict[str, Any]) -> Optional[str]:
    """HL frontendOpenOrders often omits top-level tpsl — dig nested/typed fields."""
    candidates: List[Any] = [
        order.get("tpsl"),
        order.get("orderType"),
        (order.get("t") or {}).get("trigger", {}).get("tpsl")
        if isinstance(order.get("t"), dict)
        else None,
    ]
    ot = order.get("orderType")
    if isinstance(ot, dict):
        trig = ot.get("trigger")
        if isinstance(trig, dict):
            candidates.append(trig.get("tpsl"))
    for c in candidates:
        if isinstance(c, str):
            low = c.strip().lower()
            if low in ("tp", "sl"):
                return low
            if "take" in low:
                return "tp"
            if "stop" in low:
                return "sl"
    return None


def _infer_tpsl_from_position(
    *,
    trigger_px: Optional[float],
    pos: Optional[Dict[str, Any]],
) -> Optional[str]:
    """Match trigger to DB SL/TP only.

    Do NOT infer from trigger vs entry — a trailing stop moved into profit
    (LONG SL above entry) would be mislabeled as take-profit.
    """
    if trigger_px is None or not pos:
        return None
    sl = float(pos["stop_loss"]) if _is_num(pos.get("stop_loss")) else None
    tp = float(pos["take_profit"]) if _is_num(pos.get("take_profit")) else None

    def _near(a: float, b: float) -> bool:
        return abs(a - b) <= max(1e-6, abs(b) * 0.0015)

    if sl is not None and _near(trigger_px, sl):
        return "sl"
    if tp is not None and _near(trigger_px, tp):
        return "tp"
    return None


def _flatten_hl_order(order: Dict[str, Any]) -> Dict[str, Any]:
    """frontendOpenOrders is usually flat; some payloads nest fields under order/o."""
    inner = order.get("order") if isinstance(order.get("order"), dict) else None
    if inner is None and isinstance(order.get("o"), dict):
        inner = order["o"]
    if not inner:
        return order
    merged = {**inner, **order}
    for key in (
        "coin",
        "side",
        "limitPx",
        "sz",
        "size",
        "triggerPx",
        "isTrigger",
        "reduceOnly",
        "tpsl",
        "orderType",
        "t",
    ):
        if merged.get(key) is None and inner.get(key) is not None:
            merged[key] = inner[key]
    return merged


def _created_ms(row: Dict[str, Any]) -> Optional[int]:
    created_raw = row.get("created_at")
    if not (isinstance(created_raw, str) and created_raw.strip()):
        return None
    try:
        s = created_raw.strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _is_ai_cloid(raw: Any) -> bool:
    s = str(raw or "").strip().lower()
    return s.startswith(_HTAI_CLOID_PREFIX)


def _merge_hl_fill_lists(*lists: Any) -> List[Dict[str, Any]]:
    seen: Set[Any] = set()
    out: List[Dict[str, Any]] = []
    for lst in lists:
        if not isinstance(lst, list):
            continue
        for f in lst:
            if not isinstance(f, dict):
                continue
            tid = f.get("tid") or f.get("hash")
            key = (
                tid
                if tid is not None
                else (f.get("time"), f.get("coin"), f.get("oid"), f.get("sz"), f.get("px"))
            )
            if key in seen:
                continue
            seen.add(key)
            out.append(f)
    return out


def _fills_to_closed_rows(
    fills: List[Dict[str, Any]],
    *,
    since_ms: Optional[int],
    limit: int = _SHOWCASE_FILL_LIMIT,
) -> List[Dict[str, Any]]:
    """HL userFills → showcase Completed rows (AI + manual, same book as Portfolio)."""
    rows: List[Dict[str, Any]] = []
    for f in fills:
        coin = str(f.get("coin") or "").strip()
        if not coin or coin.startswith("@"):
            continue
        t_raw = f.get("time") if f.get("time") is not None else f.get("timestamp")
        t_ms: Optional[int] = None
        if _is_num(t_raw):
            t_ms = _ts_to_ms(int(float(t_raw)))
        if since_ms and t_ms is not None and t_ms < since_ms:
            continue
        side_raw = str(f.get("side") or "").upper()
        is_buy = side_raw in ("B", "BUY")
        px = float(f["px"]) if _is_num(f.get("px")) else (
            float(f["price"]) if _is_num(f.get("price")) else None
        )
        sz = float(f["sz"]) if _is_num(f.get("sz")) else (
            float(f["size"]) if _is_num(f.get("size")) else None
        )
        fee = float(f["fee"]) if _is_num(f.get("fee")) else 0.0
        closed_pnl = float(f["closedPnl"]) if _is_num(f.get("closedPnl")) else 0.0
        # HL separates fee from closedPnl — net so opens aren't a fake 0.
        net = closed_pnl - fee
        value = abs(px * sz) if (px is not None and sz is not None) else None
        dir_raw = str(f.get("dir") or "").strip() or None
        ai = _is_ai_cloid(f.get("cloid") or f.get("c"))
        rows.append(
            {
                "symbol": coin,
                "side": "LONG" if is_buy else "SHORT",
                "orderSide": "buy" if is_buy else "sell",
                "closePrice": px,
                "size": sz,
                "valueUsd": round(value, 2) if value is not None else None,
                "feeUsd": round(fee, 4),
                "pnlUsd": round(net, 4),
                "closedAt": t_ms,
                "ai": ai,
                "dir": dir_raw,
                "reason": "ai" if ai else "manual",
            }
        )
    rows.sort(key=lambda r: int(r.get("closedAt") or 0), reverse=True)
    return rows[:limit]


def _parse_hl_asset_positions(state: Any) -> Dict[str, Dict[str, Any]]:
    """coin → live HL perp fields from clearinghouse."""
    out: Dict[str, Dict[str, Any]] = {}
    if not isinstance(state, dict):
        return out
    for ap in state.get("assetPositions") or []:
        pos = ap.get("position") if isinstance(ap, dict) else None
        if not isinstance(pos, dict):
            continue
        try:
            szi = float(pos.get("szi") or 0)
        except (TypeError, ValueError):
            continue
        if abs(szi) < 1e-12:
            continue
        coin = str(pos.get("coin") or "").upper()
        if not coin:
            continue
        lev = pos.get("leverage") if isinstance(pos.get("leverage"), dict) else {}
        lev_type = str(lev.get("type") or "").lower()
        margin_type = "cross" if lev_type == "cross" else "isolated" if lev_type == "isolated" else None
        liq = pos.get("liquidationPx")
        margin = pos.get("marginUsed")
        lev_val = lev.get("value")
        upnl = pos.get("unrealizedPnl")
        roe = pos.get("returnOnEquity")
        entry_px = pos.get("entryPx")
        pos_val = pos.get("positionValue")
        if pos_val is None:
            pos_val = pos.get("position_value")
        cum = pos.get("cumFunding") if isinstance(pos.get("cumFunding"), dict) else {}
        since_open = cum.get("sinceOpen") if isinstance(cum, dict) else None
        out[coin] = {
            "liquidationPx": float(liq) if _is_num(liq) and float(liq) > 0 else None,
            "marginUsed": float(margin) if _is_num(margin) else None,
            "marginType": margin_type,
            "leverage": float(lev_val) if _is_num(lev_val) else None,
            "unrealizedPnl": float(upnl) if _is_num(upnl) else None,
            "returnOnEquity": float(roe) if _is_num(roe) else None,
            "szi": szi,
            "entryPx": float(entry_px) if _is_num(entry_px) else None,
            "positionValue": abs(float(pos_val)) if _is_num(pos_val) else None,
            # HL: positive sinceOpen = funding paid by the position (cost).
            "fundingPaid": float(since_open) if _is_num(since_open) else None,
        }
        # Also index bare coin for HIP-3 `dex:COIN`
        bare = coin.split(":")[-1]
        if bare and bare != coin:
            out[bare] = out[coin]
    return out


# Mirror workers/ai-agent/src/hl/positionIdentity.ts ENTRY_MATCH_TOL.
# Showcase has no fill/cloid walk — same-side + entry proximity is the
# fail-open stand-in. Divergent entry after a flatten→reopen → Manual.
_ENTRY_MATCH_TOL = 0.03


def _entries_likely_same(
    tracked_entry: Optional[float], live_entry: Optional[float]
) -> bool:
    if not (
        tracked_entry
        and tracked_entry > 0
        and live_entry
        and live_entry > 0
    ):
        return True
    return abs(live_entry - tracked_entry) / tracked_entry <= _ENTRY_MATCH_TOL


def _hl_live_position_row(
    *,
    symbol: str,
    live: Dict[str, Any],
    mark: Optional[float],
    size_usd: Optional[float] = None,
    manual: bool = False,
) -> Dict[str, Any]:
    szi = float(live.get("szi") or 0)
    side = "LONG" if szi > 0 else "SHORT"
    entry = live.get("entryPx")
    entry_f = float(entry) if _is_num(entry) else None
    if size_usd is None and _is_num(live.get("positionValue")):
        size_usd = abs(float(live["positionValue"]))
    if size_usd is None and abs(szi) > 0:
        px = mark if (mark and mark > 0) else entry_f
        if px and px > 0:
            size_usd = abs(szi) * px
    upnl = live.get("unrealizedPnl")
    roe_pct = None
    if live.get("returnOnEquity") is not None:
        roe_pct = float(live["returnOnEquity"]) * 100.0
    elif upnl is not None and live.get("marginUsed") and live["marginUsed"] > 0:
        roe_pct = (float(upnl) / float(live["marginUsed"])) * 100.0
    # Match PortfolioTabs: flip HL sinceOpen (paid) to the user's P&L sign.
    funding_usd = None
    if _is_num(live.get("fundingPaid")):
        funding_usd = round(-float(live["fundingPaid"]), 4)
    return {
        "symbol": symbol,
        "side": side,
        "entry": entry_f,
        "mark": mark,
        "sizeUsd": round(float(size_usd), 2) if size_usd is not None else None,
        "unrealizedPnl": round(float(upnl), 2) if upnl is not None else None,
        "unrealizedPct": round(roe_pct, 2) if roe_pct is not None else None,
        "leverage": live.get("leverage"),
        "marginType": live.get("marginType"),
        "liquidationPx": live.get("liquidationPx"),
        "marginUsed": live.get("marginUsed"),
        "fundingUsd": funding_usd,
        "manual": manual,
    }


def _slim_decision_row(row: Dict[str, Any]) -> Dict[str, Any]:
    dec = row.get("decision") if isinstance(row.get("decision"), dict) else {}
    dtype = str(row.get("type") or "")
    symbol = str(row.get("symbol") or "")
    body = ""
    reasoning = ""
    conviction = None
    headline = dtype.replace("_", " ")
    tone = "neutral"
    direction = None
    pnl_pct = None

    if isinstance(dec, dict):
        nested = dec.get("decisionBody") if isinstance(dec.get("decisionBody"), dict) else {}

        if isinstance(dec.get("summary"), str) and dec["summary"].strip():
            body = dec["summary"].strip()
        elif isinstance(nested.get("summary"), str) and nested["summary"].strip():
            body = nested["summary"].strip()
        elif isinstance(dec.get("reason"), str) and dec["reason"].strip():
            # Skips (e.g. skipped_cooldown) store copy on top-level `reason`.
            body = dec["reason"].strip()

        # Opening: top-level `reasoning`. Monitors: `decisionBody.reason`
        # (metric-citing audit trail — see docs/ai-agents-v1.md).
        if isinstance(dec.get("reasoning"), str) and dec["reasoning"].strip():
            reasoning = dec["reasoning"].strip()
        elif isinstance(nested.get("reason"), str) and nested["reason"].strip():
            reasoning = nested["reason"].strip()
        elif isinstance(nested.get("reasoning"), str) and nested["reasoning"].strip():
            reasoning = nested["reasoning"].strip()
        if not body and reasoning:
            body = reasoning
        elif not body and isinstance(nested.get("reason"), str):
            body = nested["reason"].strip()

        if isinstance(dec.get("conviction"), (int, float)):
            conviction = int(dec["conviction"])
        if conviction is None and isinstance(nested.get("conviction"), (int, float)):
            conviction = int(nested["conviction"])
        if conviction is None and isinstance(nested.get("confidence"), (int, float)):
            conviction = int(nested["confidence"])

        # Direction: openings via decision; monitors via top-level direction.
        for raw_dir in (
            dec.get("direction"),
            nested.get("direction"),
            dec.get("decision") if isinstance(dec.get("decision"), str) else None,
        ):
            if isinstance(raw_dir, str) and raw_dir.strip().upper() in ("LONG", "SHORT"):
                direction = raw_dir.strip().upper()
                break

        if dtype.startswith("opening"):
            if dtype == "opening_flat" or dtype.endswith("_flat"):
                headline = "Flat"
                tone = "neutral"
            elif "invalid" in dtype:
                headline = "Invalid open"
                tone = "negative"
            else:
                headline = "Opened"
                tone = "neutral"
        elif dtype.startswith("monitor"):
            escalated = bool(nested.get("trimEscalatedToClose") and dec.get("executed"))
            action = str(
                "cut" if escalated else (dec.get("action") or nested.get("action") or "hold")
            ).upper()
            from_dir = str(dec.get("fromDirection") or nested.get("fromDirection") or "").upper()
            to_dir = str(dec.get("toDirection") or nested.get("toDirection") or "").upper()
            flip_arrow = ""
            if (
                action == "FLIP"
                and from_dir in ("LONG", "SHORT")
                and to_dir in ("LONG", "SHORT")
            ):
                flip_arrow = f" {from_dir}→{to_dir}"
                direction = to_dir
            labels = {
                "HOLD": "Hold",
                "TRIM": "Trim",
                "ADD": "Add",
                "DCA": "DCA",
                "EXIT": "Exit",
                "FLIP": "Flip",
                "CUT": "Cut",
            }
            headline = f"{labels.get(action, action.title())}{flip_arrow}"
            if escalated:
                headline += " → closed"

            roe = dec.get("roePct")
            pnl = dec.get("pnlPct")
            if _is_num(roe):
                pnl_pct = float(roe)
            elif _is_num(pnl):
                pnl_pct = float(pnl)
            if pnl_pct is not None:
                tone = "positive" if pnl_pct > 0 else "negative" if pnl_pct < 0 else "neutral"
            elif action in ("EXIT", "CUT"):
                tone = "negative"
            else:
                tone = "neutral"
        elif dtype.startswith("skipped"):
            tone = "warn"
            if dtype == "skipped_cooldown":
                headline = "Cooldown"
                rem = dec.get("remainingMinutes")
                total = dec.get("cooldownMinutes")
                ends_soon = bool(dec.get("endsSoon")) or (
                    _is_num(rem) and float(rem) <= 5
                )
                # Opens only on the next hourly cycle after cooldown ends —
                # don't imply a trade lands in ~1m.
                if ends_soon:
                    body = (
                        "Cooldown ending soon — next hourly cycle can open again "
                        "if the setup still looks good"
                        + (f" ({int(total)}m cooldown)" if _is_num(total) else "")
                    )
                elif _is_num(rem) and float(rem) > 0:
                    body = (
                        f"Paused after a loss — no new opens for ~{int(rem)}m more"
                        + (f" ({int(total)}m cooldown)" if _is_num(total) else "")
                    )
                elif not body:
                    body = "Paused after a loss — no fresh opens on this symbol yet"
            elif dtype == "skipped_monitor_window":
                headline = "Waiting"
                if not body:
                    body = "Outside this horizon's re-check window — holding without a new decision"
            elif dtype == "skipped_earnings_window":
                headline = "Earnings pause"
            elif dtype == "skipped_trend_filter":
                headline = "Trend filter"
            elif dtype == "skipped_direction_mandate":
                headline = "Direction mandate"
                if not body:
                    body = "The AI leaned the other way, but this agent only trades one direction — staying flat"
            elif dtype == "skipped_budget":
                headline = "Budget full"
            elif dtype == "skipped_margin":
                headline = "Low margin"
            elif dtype == "skipped_thin_book":
                headline = "Thin book"
                if not body:
                    body = (
                        "The live order book could not absorb this order cleanly — "
                        "waiting for better liquidity instead of paying the slippage"
                    )
            elif dtype in ("skipped_no_data", "skipped_no_price"):
                headline = "No market data"
                if not body:
                    body = (
                        "Market data feed was unavailable this hour — "
                        "no new decision; will retry next cycle"
                    )
            elif dtype == "skipped_user_conflict":
                # Matches app "paused" chip when a live position exists that
                # this agent didn't open (manual / external).
                headline = "Paused — opened manually"
                if not body:
                    body = (
                        "A live position in this market wasn't opened by the agent — "
                        "staying flat until that position is closed"
                    )
            elif dtype == "skipped_stopped":
                headline = "Stopped"
                if not body:
                    body = "Agent was stopped"
            elif dtype == "skipped_paused":
                headline = "Paused"
                if not body:
                    body = "Agent was paused"
            else:
                headline = dtype.replace("skipped_", "").replace("_", " ").title()
                tone = "warn"
        elif dtype == "reconciled_closed":
            # Match app AiReasoningModal: short "Closed" + human body. Prefer
            # stop/TP/liq when the worker recorded closeReason (e.g. stop_fill).
            headline = "Closed"
            tone = "neutral"
            prev = dec.get("previous")
            if isinstance(prev, str) and prev.strip().upper() in ("LONG", "SHORT"):
                direction = prev.strip().upper()
            reason = str(dec.get("closeReason") or "").strip().lower()
            if reason in ("stop_fill", "stop", "sl_fill"):
                body = "Closed by stop-loss on the exchange."
            elif reason in ("tp_fill", "take_profit", "tp"):
                body = "Closed by take-profit on the exchange."
            elif reason in ("liquidation", "liquidated") or dec.get("liquidated") is True:
                body = "Closed by liquidation on the exchange."
                tone = "negative"
            elif reason == "manual" or reason == "user":
                body = "Closed externally (manual close)."
            elif not body:
                body = "Closed externally (by you or a tp/sl)."
        else:
            action = nested.get("action") or dec.get("decision") or dec.get("action")
            if isinstance(action, str) and action.strip():
                headline = action.strip().replace("_", " ").title()
                if action.lower() in ("long", "short"):
                    direction = action.upper()
                    headline = "Opened"

    return {
        "id": row.get("id"),
        "at": row.get("created_at"),
        "symbol": symbol,
        "type": dtype,
        "headline": headline,
        "body": body,
        "reasoning": reasoning if reasoning and reasoning != body else None,
        "tone": tone,
        "conviction": conviction,
        "direction": direction,
        "pnlPct": round(pnl_pct, 2) if pnl_pct is not None else None,
    }


def _opening_from_row(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    slim = _slim_decision_row(row)
    dec = row.get("decision") if isinstance(row.get("decision"), dict) else {}
    side = slim.get("direction")
    if side not in ("LONG", "SHORT"):
        return None
    entry = dec.get("entryPrice") or dec.get("entry_price")
    stop = dec.get("stop_price") or dec.get("stopPrice")
    tp = dec.get("take_profit_target") or dec.get("takeProfit")
    reasoning = ""
    if isinstance(dec.get("reasoning"), str):
        reasoning = dec["reasoning"].strip()
    summary = slim.get("body") or ""
    return {
        "at": row.get("created_at"),
        "symbol": row.get("symbol"),
        "side": side,
        "conviction": slim.get("conviction"),
        "summary": summary,
        "reasoning": reasoning,
        "entryPrice": float(entry) if _is_num(entry) else None,
        "stopPrice": float(stop) if _is_num(stop) else None,
        "takeProfit": float(tp) if _is_num(tp) else None,
    }


def _is_num(v: Any) -> bool:
    try:
        return v is not None and abs(float(v)) < 1e15
    except (TypeError, ValueError):
        return False


def _trading_address(row: Dict[str, Any]) -> str:
    if row.get("mode") == "dedicated" and row.get("hl_subaccount_address"):
        return str(row["hl_subaccount_address"])
    return str(row.get("hl_master_address") or "")


def _cache_fresh(now: float) -> bool:
    return (
        _cache["payload"] is not None
        and (now - float(_cache["ts"])) < SHOWCASE_CACHE_TTL_SEC
    )


async def _fetch_hl_safe(fetch_hl: _FetchHl, *args: Any, **kwargs: Any) -> Tuple[Any, bool]:
    """Return (result, ok). ok=False on any exception (not cancellation)."""
    try:
        return await fetch_hl(*args, **kwargs), True
    except asyncio.CancelledError:
        raise
    except Exception:
        return None, False


async def _build_agent_payload(
    row: Dict[str, Any],
    *,
    supabase: Any,
    fetch_hl: _FetchHl,
    shared_mids: Dict[str, float],
) -> Tuple[Dict[str, Any], bool]:
    """Build one agent slice. Returns (payload, critical_ok).

    critical_ok is False when wallet HL portfolio (equity) or clearinghouse
    failed — callers should prefer stale cache over publishing empty books.
    """
    config = row.get("config") if isinstance(row.get("config"), dict) else {}
    symbols = [str(s).upper() for s in (config.get("symbols") or [])]
    coin_parts = {s.split(":")[-1] for s in symbols}
    addr = _trading_address(row)
    critical_ok = True
    created_ms = _created_ms(row)

    equity: List[Dict[str, float]] = []
    pnl_now = 0.0
    hl_live: Dict[str, Dict[str, Any]] = {}
    open_orders: List[Dict[str, Any]] = []
    # True when at least one clearinghouse fetch succeeded — used to hide
    # DB OPEN ghosts after manual/external closes without waiting for worker.
    ch_any_ok = False

    if addr.startswith("0x"):
        dexes = sorted(
            {""}
            | {d.lower() for d in _SHOWCASE_HIP3_DEXES}
            | {
                s.split(":")[0].lower()
                for s in symbols
                if ":" in s and s.split(":")[0]
            }
        )
        hip3_dexes = [d for d in dexes if d]

        # Concurrent HL hops for this wallet.
        tasks: List[Awaitable[Tuple[Any, bool]]] = [
            _fetch_hl_safe(fetch_hl, "portfolio", {"user": addr}),
        ]
        ch_start = 1
        for d in dexes:
            tasks.append(
                _fetch_hl_safe(
                    fetch_hl,
                    "clearinghouseState",
                    {"user": addr, **({"dex": d} if d else {})},
                )
            )
        orders_main_i = len(tasks)
        tasks.append(_fetch_hl_safe(fetch_hl, "frontendOpenOrders", {"user": addr}))
        orders_hip3_start = len(tasks)
        for d in hip3_dexes:
            tasks.append(
                _fetch_hl_safe(
                    fetch_hl, "frontendOpenOrders", {"user": addr, "dex": d}
                )
            )
        fills_main_i = len(tasks)
        tasks.append(
            _fetch_hl_safe(
                fetch_hl, "userFills", {"user": addr, "aggregateByTime": True}
            )
        )

        gathered = await asyncio.gather(*tasks)
        portfolio, portfolio_ok = gathered[0]
        ch_results = gathered[ch_start:orders_main_i]
        orders_main, orders_main_ok = gathered[orders_main_i]
        orders_hip3_results = gathered[orders_hip3_start:fills_main_i]
        fills_main, fills_main_ok = gathered[fills_main_i]

        if portfolio_ok:
            # Rebase to agent create — wallet history often predates the agent
            # (recycled showcase keys / prior fills).
            entry = _portfolio_entry_for_agent(portfolio, since_ms=created_ms)
            equity = indexed_equity_from_pnl_history(entry, since_ms=created_ms)
            if equity:
                pnl_now = equity[-1]["indexed"] - BASELINE_USD
        else:
            critical_ok = False

        for state, ok in ch_results:
            if ok:
                ch_any_ok = True
                hl_live.update(_parse_hl_asset_positions(state))
        if not ch_any_ok:
            critical_ok = False

        all_orders: List[Any] = []
        if orders_main_ok and isinstance(orders_main, list):
            all_orders.extend(orders_main)
        for extra, ok in orders_hip3_results:
            if ok and isinstance(extra, list):
                all_orders.extend(extra)
        # Orders are non-critical — empty on blip is fine (DB TP/SL fallback below).

        # One userFills (weight 20) — HIP-3 coins arrive dex-prefixed on the same list.
        fills_ok = fills_main_ok and isinstance(fills_main, list)
        all_fills = _merge_hl_fill_lists(fills_main if fills_ok else [])
    else:
        all_orders = []
        all_fills = []
        fills_ok = False

    # Positions: DB OPEN rows identify AI-managed names; live HL is the book
    # (size / entry / margin / liq). Worker size_usd only patches hourly, so a
    # manual add/trim would leave Size stuck if we published the DB snapshot.
    pos_res = (
        supabase.table("ai_agent_positions")
        .select(
            "symbol,direction,entry_price,size_usd,leverage,stop_loss,take_profit,status"
        )
        .eq("agent_id", row["id"])
        .eq("status", "OPEN")
        .execute()
    )

    pos_by_coin: Dict[str, Dict[str, Any]] = {}
    for p in pos_res.data or []:
        sym = str(p.get("symbol") or "")
        coin = sym.split(":")[-1].upper()
        pos_by_coin[coin] = p
        if sym:
            pos_by_coin[sym.upper()] = p

    mids = shared_mids
    positions = []
    for p in pos_res.data or []:
        sym = str(p.get("symbol") or "")
        coin = sym.split(":")[-1].upper()
        db_entry = float(p["entry_price"]) if _is_num(p.get("entry_price")) else None
        # Main mids are bare (BTC); HIP-3 mids are dex-prefixed (xyz:CRCL),
        # with bare coin also indexed when merging shared_mids.
        mark = mids.get(sym.upper()) or mids.get(coin)
        side = str(p.get("direction") or "").upper()
        live = hl_live.get(sym.upper()) or hl_live.get(coin) or {}
        # Showcase reads DB OPEN rows; worker reconcile (CLOSED_BY_USER) only
        # runs for *active* agents on the hourly cycle. Manual closes on
        # stopped agents would ghost forever — hide when HL is flat.
        if ch_any_ok and not live:
            continue
        # Same-side + entry identity (positionIdentity.ts without fills).
        # Flipped / flatten→manual-reopen: skip the DB stub; the HL sweep
        # below surfaces the live book as Manual.
        if ch_any_ok and live:
            live_side = "LONG" if float(live.get("szi") or 0) > 0 else "SHORT"
            if side in ("LONG", "SHORT") and live_side != side:
                continue
            live_entry = live.get("entryPx")
            live_entry_f = float(live_entry) if _is_num(live_entry) else None
            if not _entries_likely_same(db_entry, live_entry_f):
                continue
            row_out = _hl_live_position_row(
                symbol=sym,
                live=live,
                mark=mark,
                manual=False,
            )
            if row_out.get("leverage") is None and _is_num(p.get("leverage")):
                row_out["leverage"] = float(p["leverage"])
            positions.append(row_out)
            continue
        lev = float(p["leverage"]) if _is_num(p.get("leverage")) else None
        upnl = None
        if db_entry and mark and db_entry > 0 and _is_num(p.get("size_usd")):
            size_usd = float(p["size_usd"])
            signed = size_usd if side == "LONG" else -size_usd
            upnl = ((mark - db_entry) / db_entry) * signed
        positions.append(
            {
                "symbol": sym,
                "side": side,
                "entry": db_entry,
                "mark": mark,
                "sizeUsd": float(p["size_usd"]) if _is_num(p.get("size_usd")) else None,
                "unrealizedPnl": round(float(upnl), 2) if upnl is not None else None,
                "unrealizedPct": None,
                "leverage": lev,
                "marginType": None,
                "liquidationPx": None,
                "marginUsed": None,
                "fundingUsd": None,
                "manual": False,
            }
        )

    # Live HL perps on this wallet that the agent did not open (manual /
    # external) — including names outside config.symbols. The UI badges
    # those rows Manual so visitors can tell them from AI opens.
    if ch_any_ok:
        covered: Set[str] = set()
        for p in positions:
            s = str(p.get("symbol") or "").upper()
            if s:
                covered.add(s)
                covered.add(s.split(":")[-1])
        seen_live: Set[int] = set()
        for coin, live in hl_live.items():
            ident = id(live)
            if ident in seen_live:
                continue
            seen_live.add(ident)
            try:
                szi = float(live.get("szi") or 0)
            except (TypeError, ValueError):
                continue
            if abs(szi) < 1e-12:
                continue
            coin_u = str(coin or "").upper()
            bare = coin_u.split(":")[-1]
            if coin_u in covered or bare in covered:
                continue
            mark = mids.get(coin_u) or mids.get(bare)
            positions.append(
                _hl_live_position_row(
                    symbol=coin_u,
                    live=live,
                    mark=mark,
                    manual=True,
                )
            )
            covered.add(coin_u)
            if bare:
                covered.add(bare)

    for raw_o in all_orders:
        if not isinstance(raw_o, dict):
            continue
        o = _flatten_hl_order(raw_o)
        coin = str(o.get("coin") or "").upper()
        if not coin:
            continue
        coin_part = coin.split(":")[-1]
        is_trigger = bool(o.get("isTrigger")) or float(o.get("triggerPx") or 0) > 0
        px_raw = o.get("triggerPx") if is_trigger else o.get("limitPx")
        trigger_px = float(px_raw) if _is_num(px_raw) else None
        matched_pos = pos_by_coin.get(coin) or pos_by_coin.get(coin_part)
        tpsl = _extract_tpsl(o)
        if tpsl is None and is_trigger:
            tpsl = _infer_tpsl_from_position(trigger_px=trigger_px, pos=matched_pos)
        kind = "limit"
        if is_trigger:
            # Unclassified triggers default to stop (safer than TP for trailers).
            kind = "take_profit" if tpsl == "tp" else "stop"
        side_raw = str(o.get("side") or "").upper()
        is_buy = side_raw in ("B", "BUY")
        if matched_pos and is_trigger:
            side = str(matched_pos.get("direction") or "").upper() or (
                "LONG" if is_buy else "SHORT"
            )
        else:
            side = "LONG" if is_buy else "SHORT"
        sz_raw = o.get("sz") if o.get("sz") is not None else o.get("size")
        sz = float(sz_raw) if _is_num(sz_raw) else None
        open_orders.append(
            {
                "symbol": coin,
                "side": side,
                "orderSide": "buy" if is_buy else "sell",
                "kind": kind,
                "tpsl": tpsl if tpsl in ("tp", "sl") else None,
                "triggerPx": trigger_px,
                "size": sz if (sz is not None and sz > 0) else None,
                "reduceOnly": bool(o.get("reduceOnly")),
                "isTrigger": is_trigger,
            }
        )

    # Fallback: DB stop/tp only for positions still live on HL (same ghost rule).
    if not open_orders:
        live_syms = {
            str(p.get("symbol") or "").upper()
            for p in positions
            if p.get("symbol")
        }
        live_coins = {s.split(":")[-1] for s in live_syms}
        for p in pos_res.data or []:
            side = str(p.get("direction") or "").upper()
            sym = str(p.get("symbol") or "")
            su = sym.upper()
            if su not in live_syms and su.split(":")[-1] not in live_coins:
                continue
            if _is_num(p.get("stop_loss")):
                open_orders.append(
                    {
                        "symbol": sym,
                        "side": side,
                        "orderSide": "sell" if side == "LONG" else "buy",
                        "kind": "stop",
                        "tpsl": "sl",
                        "triggerPx": float(p["stop_loss"]),
                        "size": None,
                        "reduceOnly": True,
                        "isTrigger": True,
                    }
                )
            if _is_num(p.get("take_profit")):
                open_orders.append(
                    {
                        "symbol": sym,
                        "side": side,
                        "orderSide": "sell" if side == "LONG" else "buy",
                        "kind": "take_profit",
                        "tpsl": "tp",
                        "triggerPx": float(p["take_profit"]),
                        "size": None,
                        "reduceOnly": True,
                        "isTrigger": True,
                    }
                )

    # Completed: live HL fills on this wallet (AI cloid + manual), since agent
    # create. Matches Portfolio history — not only worker-reconciled AI closes.
    closed = _fills_to_closed_rows(all_fills, since_ms=created_ms)
    if not closed and not fills_ok:
        closed_res = (
            supabase.table("ai_agent_positions")
            .select("symbol,direction,entry_price,close_price,closed_at,status,close_reason")
            .eq("agent_id", row["id"])
            .in_("status", ["CLOSED", "CLOSED_BY_USER"])
            .order("closed_at", desc=True)
            .limit(24)
            .execute()
        )
        for c in closed_res.data or []:
            close_px = float(c["close_price"]) if _is_num(c.get("close_price")) else None
            entry_px = float(c["entry_price"]) if _is_num(c.get("entry_price")) else None
            price = close_px if close_px is not None else entry_px
            if price is None:
                continue
            closed.append(
                {
                    "symbol": c.get("symbol"),
                    "side": str(c.get("direction") or "").upper(),
                    "orderSide": None,
                    "closePrice": price,
                    "priceIsEntry": close_px is None and entry_px is not None,
                    "closedAt": c.get("closed_at"),
                    "reason": c.get("close_reason") or c.get("status"),
                    "ai": True,
                }
            )
            if len(closed) >= _SHOWCASE_FILL_LIMIT:
                break

    # Decisions + opening
    dec_res = (
        supabase.table("ai_agent_decisions")
        .select("id,symbol,type,decision,created_at")
        .eq("agent_id", row["id"])
        .order("created_at", desc=True)
        .limit(40)
        .execute()
    )
    decisions_raw = dec_res.data or []
    opening = None
    if positions:
        live_keys = set()
        for p in positions:
            sym = str(p.get("symbol") or "").upper()
            if sym:
                live_keys.add(sym)
                live_keys.add(sym.split(":")[-1])
        for d in decisions_raw:
            if not str(d.get("type") or "").startswith("opening"):
                continue
            dsym = str(d.get("symbol") or "").upper()
            if dsym not in live_keys and dsym.split(":")[-1] not in live_keys:
                continue
            opening = _opening_from_row(d)
            if opening:
                break
    decisions = [
        _slim_decision_row(d)
        for d in decisions_raw
        if _showcase_decision_visible(str(d.get("type") or ""))
    ][:8]

    indexed_now = equity[-1]["indexed"] if equity else BASELINE_USD
    max_capital = (
        float(config["max_capital_usd"])
        if _is_num(config.get("max_capital_usd"))
        else None
    )

    return (
        {
            "id": row["id"],
            "name": row.get("name") or "Agent",
            "status": row.get("status"),
            "horizon": (config.get("horizon") or "scalper"),
            # Trading style (direction) + goal (mandate) — UI shows
            # "Scalper | Free form" / "Investor | Long · Acc".
            "direction": (config.get("direction") or "long_short"),
            "mandate": (config.get("mandate") or "active"),
            "model": _model_label(config),
            "symbols": symbols,
            # Shared notional ceiling across assigned symbols (not per-position).
            "maxCapitalUsd": round(max_capital, 2) if max_capital is not None else None,
            "blurb": None,
            "live": str(row.get("status") or "").lower() == "active",
            "pnlFrom1k": round(pnl_now, 2),
            "indexedEquity": round(indexed_now, 2),
            "equity": equity,
            "positions": positions,
            "openOrders": open_orders,
            "closed": closed,
            "opening": opening,
            "decisions": decisions,
        },
        critical_ok,
    )


async def _rebuild_showcase_payload(
    *,
    supabase: Any,
    fetch_hl: _FetchHl,
) -> Tuple[Dict[str, Any], bool]:
    """Full rebuild. Returns (payload, all_critical_ok)."""
    now = time.time()
    ids = showcase_agent_ids()
    if not ids or not supabase:
        return {"agents": [], "generatedAt": int(now * 1000)}, True

    agents_res = (
        supabase.table("ai_agents")
        .select(
            "id,name,mode,status,config,hl_master_address,hl_subaccount_address,trading_env,created_at"
        )
        .in_("id", ids)
        .execute()
    )
    rows = {str(r["id"]): r for r in (agents_res.data or [])}
    ordered = [rows[i] for i in ids if i in rows]

    # HIP-3 mids (e.g. xyz:CRCL) are NOT in main allMids — fetch each dex once.
    # Always include xyz so off-mandate manuals on that dex still have a mark.
    hip3_dexes: set[str] = {d.lower() for d in _SHOWCASE_HIP3_DEXES}
    for row in ordered:
        cfg = row.get("config") if isinstance(row.get("config"), dict) else {}
        for s in cfg.get("symbols") or []:
            raw_sym = str(s)
            if ":" in raw_sym:
                dex = raw_sym.split(":", 1)[0].strip().lower()
                if dex:
                    hip3_dexes.add(dex)

    mids_jobs: List[Awaitable[Tuple[Any, bool]]] = [
        _fetch_hl_safe(fetch_hl, "allMids", {}),
    ]
    hip3_dex_list = sorted(hip3_dexes)
    for dex in hip3_dex_list:
        mids_jobs.append(_fetch_hl_safe(fetch_hl, "allMids", {"dex": dex}))

    mids_results = await asyncio.gather(*mids_jobs)
    shared_mids: Dict[str, float] = {}
    for raw_mids, _ok in mids_results:
        if not isinstance(raw_mids, dict):
            continue
        for k, v in raw_mids.items():
            try:
                px = float(v)
            except (TypeError, ValueError):
                continue
            if not (px > 0):
                continue
            key = str(k).upper()
            shared_mids[key] = px
            # Index bare coin too (xyz:CRCL → CRCL) for DB symbols either form.
            bare = key.split(":")[-1]
            if bare and bare != key:
                shared_mids[bare] = px

    results = await asyncio.gather(
        *[
            _build_agent_payload(
                row,
                supabase=supabase,
                fetch_hl=fetch_hl,
                shared_mids=shared_mids,
            )
            for row in ordered
        ]
    )
    agents_out = [p for p, _ok in results]
    all_ok = all(ok for _p, ok in results) if results else True
    return {"agents": agents_out, "generatedAt": int(now * 1000)}, all_ok


async def build_showcase_payload(
    *,
    supabase: Any,
    fetch_hl: _FetchHl,
) -> Dict[str, Any]:
    now = time.time()
    if _cache_fresh(now):
        return _cache["payload"]

    async with _refresh_lock:
        now = time.time()
        # Another waiter may have refreshed while we queued.
        if _cache_fresh(now):
            return _cache["payload"]

        stale = _cache["payload"]
        try:
            payload, all_ok = await _rebuild_showcase_payload(
                supabase=supabase, fetch_hl=fetch_hl
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            if stale is not None:
                return stale
            raise

        # HL blip with a prior good payload → keep serving stale, don't poison cache.
        if not all_ok and stale is not None:
            return stale

        _cache.update(ts=time.time(), payload=payload)
        return payload
