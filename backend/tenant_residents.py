"""
BuilderPad Residents — helpers for AI agents that live on a tenant app.

Spec: docs/RESIDENTS.md. Routes stay in server.py; this module holds the
request models, persona / avatar sanitizers, and public views.

A resident is a normal `ai_agents` row (`mode='resident'`) that trades from
the creator's HD 2 embedded EOA. `tenant_residents` maps agents → tenant.
Nothing here touches trading logic.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional

from pydantic import BaseModel, field_validator

# HD 0 trade · HD 1 builder · HD 2 resident — see web/src/lib/embeddedWallets.ts
RESIDENT_WALLET_INDEX = 2

MOODS = ("idle", "focused", "tense", "smug", "shrug", "sleep")
VOICE_CHANNELS = ("trade", "craft", "macro", "vibe", "fun", "letter", "cast")

# Avatar presets ship with the web bundle (web/public/resident/presets/{id}/).
# Keep the ids here so a stale client cannot point the row at a missing folder.
AVATAR_PRESETS = ("atlas", "yuna", "selene", "nova", "sol")
# Old id shipped as `luna`; keep accepting it and rewrite to `yuna`.
_PRESET_ALIASES = {"luna": "yuna"}
AVATAR_KINDS = ("preset", "vrm")

PERSONA_NAME_MAX = 40
PERSONA_TONE_MAX_ITEMS = 5
PERSONA_TONE_ITEM_MAX = 24
PERSONA_CATCHPHRASES_MAX_ITEMS = 6
PERSONA_CATCHPHRASE_MAX = 80
PERSONA_BIO_MAX = 280
URL_MAX = 300

_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
# Preset files only. No `..`, no dot-segments — the old class allowed `/resident/../`.
_PRESET_PATH_RE = re.compile(
    r"^/resident/(?:[A-Za-z0-9_\-]+/)*[A-Za-z0-9_\-]+\.(?:vrma|vrm|webp|png|jpg)$"
)
_HTTPS_RE = re.compile(r"^https://[^\s\"'<>]+$")

# Voice-only text. Persona must never smuggle trade instructions into prompts;
# the worker wraps it in a fixed house system prompt regardless.
_BANNED = re.compile(
    r"\b(ignore (all|previous|prior) instructions|system prompt|leverage to|"
    r"buy now|sell now|guaranteed|100x|financial advice)\b",
    re.IGNORECASE,
)


class ResidentError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _clean_text(v: Any, max_len: int) -> str:
    text = " ".join(str(v or "").split())
    if _BANNED.search(text):
        raise ResidentError("That text is not allowed in a persona")
    return text[:max_len]


def _clean_list(v: Any, *, max_items: int, item_max: int) -> List[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise ResidentError("Expected a list of short strings")
    out: List[str] = []
    for item in v[:max_items]:
        text = _clean_text(item, item_max)
        if text:
            out.append(text)
    return out


def normalize_persona(raw: Any) -> Dict[str, Any]:
    """Sanitize `tenants.persona`. Empty dict = no character text yet."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ResidentError("persona must be an object")
    show_hour = raw.get("show_hour_utc")
    hour: Optional[int] = None
    if show_hour is not None and show_hour != "":
        try:
            hour = int(show_hour)
        except (TypeError, ValueError):
            raise ResidentError("show_hour_utc must be 0–23")
        if hour < 0 or hour > 23:
            raise ResidentError("show_hour_utc must be 0–23")
    out: Dict[str, Any] = {
        "display_name": _clean_text(raw.get("display_name"), PERSONA_NAME_MAX),
        "tone": _clean_list(
            raw.get("tone"), max_items=PERSONA_TONE_MAX_ITEMS, item_max=PERSONA_TONE_ITEM_MAX
        ),
        "catchphrases": _clean_list(
            raw.get("catchphrases"),
            max_items=PERSONA_CATCHPHRASES_MAX_ITEMS,
            item_max=PERSONA_CATCHPHRASE_MAX,
        ),
        "bio_voice": _clean_text(raw.get("bio_voice"), PERSONA_BIO_MAX),
    }
    if hour is not None:
        out["show_hour_utc"] = hour
    return out


def _clean_url(v: Any, *, label: str) -> str:
    text = str(v or "").strip()
    if not text:
        return ""
    if len(text) > URL_MAX:
        raise ResidentError(f"{label} URL is too long")
    if ".." in text:
        raise ResidentError(f"{label} must be an https URL")
    if _PRESET_PATH_RE.fullmatch(text) or _HTTPS_RE.fullmatch(text):
        return text
    raise ResidentError(f"{label} must be an https URL")


def normalize_avatar(raw: Any) -> Dict[str, Any]:
    """Sanitize `tenants.avatar`. Presets only until the upload sanitizer exists.

    `kind=vrm` with an arbitrary https URL would be loaded in the visitor's
    page. Reject it until Phase 4.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ResidentError("avatar must be an object")
    kind = str(raw.get("kind") or "preset").strip().lower()
    if kind == "vrm":
        raise ResidentError("Custom avatar models are not available yet")
    if kind != "preset":
        raise ResidentError("avatar.kind must be preset")
    poster = _clean_url(raw.get("poster_url"), label="Poster")
    preset = str(raw.get("preset_id") or "").strip().lower()
    preset = _PRESET_ALIASES.get(preset, preset)
    if preset not in AVATAR_PRESETS:
        raise ResidentError("Unknown avatar preset")
    return {
        "kind": "preset",
        "preset_id": preset,
        "poster_url": poster or f"/resident/presets/{preset}/poster.webp",
    }


def has_resident_identity(row: Dict[str, Any]) -> bool:
    persona = row.get("persona") if isinstance(row.get("persona"), dict) else {}
    avatar = row.get("avatar") if isinstance(row.get("avatar"), dict) else {}
    return bool(persona.get("display_name")) or bool(avatar.get("kind"))


def public_avatar(raw: Any) -> Dict[str, Any]:
    """Preset avatars only. Drop stored `kind=vrm` until the sanitizer exists."""
    if not isinstance(raw, dict) or str(raw.get("kind") or "").lower() != "preset":
        return {}
    try:
        return normalize_avatar(raw)
    except ResidentError:
        return {}


def resident_view(row: Dict[str, Any], *, agent_count: int) -> Optional[Dict[str, Any]]:
    """`tenants.resident` on public tenant reads. None = a human app."""
    if agent_count <= 0 and not has_resident_identity(row):
        return None
    persona = row.get("persona") if isinstance(row.get("persona"), dict) else {}
    avatar = row.get("avatar") if isinstance(row.get("avatar"), dict) else {}
    return {
        "agents": int(agent_count),
        "persona": persona,
        "avatar": public_avatar(avatar),
    }


def voice_public(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "id": r.get("id"),
                "agent_id": r.get("agent_id"),
                "channel": r.get("channel"),
                "mood": r.get("mood") if r.get("mood") in MOODS else "idle",
                "text": r.get("text") or "",
                "refs": r.get("refs") if isinstance(r.get("refs"), dict) else {},
                "created_at": r.get("created_at"),
            }
        )
    return out


def latest_mood(voice_rows: List[Dict[str, Any]], agent_rows: List[Dict[str, Any]]) -> str:
    """Current mood: any *active* attached agent stays awake.

    Voice can color the mood, but a stale `sleep` line must not override a live
    book. Sleep only when every attached agent is paused/stopped/draft/revoked.
    """
    live = False
    asleep_only = False
    if agent_rows:
        live = any(
            str(a.get("status") or "").lower() == "active" or a.get("live") is True
            for a in agent_rows
        )
        asleep_only = (not live) and all(
            str(a.get("status") or "").lower() in {"paused", "stopped", "draft", "revoked"}
            for a in agent_rows
        )
    if live:
        for r in voice_rows:
            m = r.get("mood")
            if m in MOODS and m != "sleep":
                return str(m)
        return "idle"
    if asleep_only:
        return "sleep"
    for r in voice_rows:
        m = r.get("mood")
        if m in MOODS:
            return str(m)
    return "idle"


class AttachResidentRequest(BaseModel):
    agent_id: str

    @field_validator("agent_id")
    @classmethod
    def _uuid(cls, v: str) -> str:
        s = (v or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", s):
            raise ValueError("Invalid agent id")
        return s


class RegisterResidentWalletRequest(BaseModel):
    resident_wallet: str
    resident_wallet_index: Optional[int] = None

    @field_validator("resident_wallet")
    @classmethod
    def _addr(cls, v: str) -> str:
        w = (v or "").strip().lower()
        if not _ADDR_RE.fullmatch(w):
            raise ValueError("Invalid wallet address")
        return w

    @field_validator("resident_wallet_index")
    @classmethod
    def _idx(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return RESIDENT_WALLET_INDEX
        if int(v) < 2:
            raise ValueError("resident_wallet_index must be >= 2")
        return int(v)


def assert_resident_wallet_distinct(
    pair: Dict[str, Any], resident_wallet: str, *, embedded: Optional[set] = None
) -> None:
    trade = str(pair.get("trade_wallet") or "").lower()
    builder = str(pair.get("builder_wallet") or "").lower()
    if resident_wallet in (trade, builder):
        raise ResidentError("Resident wallet must be a third embedded address", 400)
    if embedded is not None and resident_wallet not in embedded:
        raise ResidentError("Resident wallet must be a Privy embedded wallet", 400)


def is_house_showcase_agent(agent_id: str) -> bool:
    """True when `agent_id` is in `SHOWCASE_AGENT_IDS` (house lineup)."""
    try:
        from ai_agent_showcase import showcase_agent_ids
    except Exception:
        return False
    aid = (agent_id or "").strip().lower()
    return aid in {x.strip().lower() for x in showcase_agent_ids()}


def assert_agent_attachable(
    agent: Optional[Dict[str, Any]], *, privy_user_id: str, resident_wallet: Optional[str]
) -> None:
    if not agent:
        raise ResidentError("Agent not found", 404)
    if str(agent.get("privy_user_id") or "") != privy_user_id:
        raise ResidentError("Agent not found", 404)
    if agent.get("status") == "revoked":
        raise ResidentError("This agent was revoked", 400)
    # House showcase agents keep their existing master (not HD 2). Same-owner
    # attach is enough — the worker still puts this app's builder on orders.
    if is_house_showcase_agent(str(agent.get("id") or "")):
        return
    if (agent.get("mode") or "") != "resident":
        raise ResidentError("Only resident-mode agents can live on an app", 400)
    if not resident_wallet:
        raise ResidentError("Create the resident wallet first", 400)
    master = str(agent.get("hl_master_address") or "").lower()
    if master != resident_wallet.lower():
        raise ResidentError("Agent must trade from your resident wallet", 400)
