"""BuilderPad tenant v1 — helpers for branded trading apps.

Tenants reuse HyperTrade Privy, Railway, Supabase, Bridge2. Orders use the
shared platform builder until the creator's HD-1 wallet is live=own.

Creators get two EOAs on the same login:
  trade_wallet   — Privy HD 0. Desk, Bridge2, unified. Never the HL builder.
  builder_wallet — Standard only. Never userSetAbstraction.
    source=embedded → Privy HD 1
    source=imported → linked external EVM (MetaMask). SIWE login is ownership.
See tenant_builder_wallets. tenants.builder_address stays the platform
address until the builder has ≥100 USDC perp, stays Standard, and live=own.

Public URL (v1):
    https://{slug}.builderpad.xyz

Apex `builderpad.xyz` is the console. Local/dev still uses `/t/{slug}`.
Activated builders (live=own) can attach one creator-owned hostname
(TXT + CNAME → the Vite Vercel project). Preview apps cannot.
See BUILDERPAD.md → Custom domains.
"""
from __future__ import annotations

import base64
import hashlib
import io
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urlparse

from PIL import Image, ImageOps, UnidentifiedImageError

from pydantic import BaseModel, Field, field_validator, model_validator

# Console + `{slug}.builderpad.xyz`. Override with BUILDERPAD_PUBLIC_DOMAIN
# (hostname only, no https://). Custom creator CNAMEs are a separate host
# on the same Vite project (see tenant_domains.py).
def _public_base_domain() -> str:
    v = (os.getenv("BUILDERPAD_PUBLIC_DOMAIN") or "builderpad.xyz").strip().lower()
    v = v.replace("https://", "").replace("http://", "").split("/")[0].strip().lstrip(".")
    return v or "builderpad.xyz"


TENANT_BASE_DOMAIN = _public_base_domain()
TENANT_PUBLIC_ORIGIN = f"https://{TENANT_BASE_DOMAIN}"
TENANT_PUBLIC_ORIGINS = (
    TENANT_PUBLIC_ORIGIN,
    f"https://www.{TENANT_BASE_DOMAIN}",
)

CLOID_TAG = "4250"  # "BP" — must not collide with AI 0x48544149 (HTAI)
MAX_FEE_TENTHS = 100  # 10 bps = 0.10%
DEFAULT_FEE_TENTHS = 30  # match HyperTrade default
# v1 apps ship the whole HyperTrade universe (HIP-3 + crypto perps, ~100).
# Edit / list-delist is paused (Pons IPFS metadata).
MAX_CATALOG = 200
MAX_TENANTS_PER_USER = 10
# Live apps on the shared HyperTrade builder (skip Activate). Own-builder apps
# still use MAX_TENANTS_PER_USER. Stops directory / infra farming of $0 preview.
MAX_PREVIEW_LIVE_PER_USER = 1
# After publish, name / bio / socials / catalog / handle stay frozen.
# Logo may change (creators rebrand marks). Builder fee + buyback/burn
# pledges + the Twitch desk overlay may change. Pledges are not on-chain.
LIVE_LOCKED_FIELDS = (
    "app_name",
    "description",
    "socials",
    "catalog",
    "slug",
)
# Socials the client may only publish after Privy OAuth-verified them.
VERIFIED_SOCIAL_KEYS = (
    "twitter",
    "telegram",
    "discord",
    "tiktok",
    "instagram",
    "youtube",
    "twitch",
)
SOCIAL_LABELS = {
    "twitter": "X",
    "telegram": "Telegram",
    "discord": "Discord",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "youtube": "YouTube",
    "twitch": "Twitch",
}
TRADE_WALLET_INDEX = 0
BUILDER_WALLET_INDEX = 1
IMPORTED_BUILDER_INDEX = 0
BUILDER_WALLET_SOURCES = ("embedded", "imported")
BUILDER_WALLET_STATUSES = ("provisioned", "funded", "active")
BUILDER_ACTIVATION_USDC = 100.0
POOLED_ABSTRACTION = ("unifiedAccount", "portfolioMargin")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")
COIN_RE = re.compile(r"^[A-Za-z0-9]{2,20}$")
HIP3_COIN_RE = re.compile(r"^[a-z0-9]{1,16}:[A-Za-z0-9]{2,20}$")

# Keep in sync with frontend/src/tenants/reserved.ts
RESERVED_SLUGS = {
    "about",
    "admin",
    "ai-agents",
    "ai-agents-faq",
    "api",
    "app",
    "apps",
    "asset",
    "assets",
    "bank",
    "bank-faq",
    "bank-guest",
    "bank-notifications",
    "bank-statement",
    "blog",
    "builderpad",
    "cdn",
    "create",
    "deposit",
    "deposit-withdraw-history",
    "docs",
    "faq",
    "fees",
    "ftp",
    "health",
    "help",
    "home",
    "hypertrade",
    "index",
    "legal",
    "login",
    "mail",
    "me",
    "news",
    "portfolio",
    "price-alerts",
    "privacy",
    "privacy-policy",
    "profile",
    "rewards",
    "showcase",
    "static",
    "status",
    "support",
    "t",
    "terms",
    "trade",
    "trade-history",
    "www",
}


class TenantError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class TenantSocials(BaseModel):
    twitter: str = ""
    telegram: str = ""
    discord: str = ""
    tiktok: str = ""
    instagram: str = ""
    youtube: str = ""
    twitch: str = ""
    website: str = ""

    @field_validator(
        "twitter",
        "telegram",
        "discord",
        "tiktok",
        "instagram",
        "youtube",
        "twitch",
    )
    @classmethod
    def _trim(cls, v: str) -> str:
        return (v or "").strip()[:200]

    @field_validator("website")
    @classmethod
    def _website(cls, v: str) -> str:
        try:
            return normalize_website_url(v)
        except TenantError as e:
            raise ValueError(e.message) from e


def _handle(v: Any) -> str:
    return str(v or "").strip().lstrip("@").lower()


TWITCH_LOGIN_RE = re.compile(r"^[a-z0-9_]{3,25}$")


def twitch_login(*vals: Any) -> str:
    """Twitch channel name only — skip display names and numeric user ids."""
    for v in vals:
        h = _handle(v)
        if TWITCH_LOGIN_RE.match(h):
            return h
    return ""


def privy_twitch_subject(linked_accounts: Iterable[Any]) -> str:
    for acct in linked_accounts or []:
        if not isinstance(acct, dict):
            continue
        atype = str(acct.get("type") or "").lower()
        if "twitch" not in atype:
            continue
        sub = str(acct.get("subject") or "").strip()
        if sub.isdigit():
            return sub
    return ""


def privy_verified_socials(linked_accounts: Iterable[Any]) -> Dict[str, str]:
    """Handles Privy has OAuth-verified, keyed like TenantSocials.

    Reads the server-side `/v1/users/{id}` payload (snake_case types).
    """
    out: Dict[str, str] = {k: "" for k in VERIFIED_SOCIAL_KEYS}
    for acct in linked_accounts or []:
        if not isinstance(acct, dict):
            continue
        atype = str(acct.get("type") or "").lower()
        username = _handle(acct.get("username"))
        name = _handle(acct.get("name"))
        email_local = _handle(str(acct.get("email") or "").split("@")[0])
        if atype == "twitter_oauth" and username:
            out["twitter"] = username
        elif atype == "telegram" and username:
            out["telegram"] = username
        elif atype == "discord_oauth" and username:
            out["discord"] = username
        elif atype == "tiktok_oauth" and username:
            out["tiktok"] = username
        elif atype == "instagram_oauth" and username:
            out["instagram"] = username
        elif atype == "google_oauth":
            out["youtube"] = username or name or email_local
        elif "twitch" in atype:
            out["twitch"] = twitch_login(
                acct.get("username"),
                acct.get("login"),
                acct.get("preferred_username"),
                acct.get("name"),
            )
    return out


def verify_socials(
    socials: "TenantSocials", verified: Optional[Dict[str, str]]
) -> "TenantSocials":
    """Reject any social handle Privy did not verify for this user.

    Website is optional free-text but must be https + a real domain
    (``normalize_website_url``). Raises TenantError so a tampered request
    fails closed instead of publishing someone else's handle.
    ``verified=None`` means Privy could not be consulted (no app secret) — then
    the handles are dropped rather than trusted.
    """
    data = socials.model_dump()
    for key in VERIFIED_SOCIAL_KEYS:
        want = _handle(data.get(key))
        if not want or verified is None:
            data[key] = ""
            continue
        have = _handle(verified.get(key))
        if not have or have != want:
            label = SOCIAL_LABELS.get(key, key)
            raise TenantError(
                f"{label} handle is not verified — connect it in the wizard first",
                status_code=400,
            )
        data[key] = have
    return TenantSocials(**data)


class CreateTenantRequest(BaseModel):
    app_name: str = Field(..., min_length=2, max_length=60)
    slug: str = Field(..., min_length=3, max_length=32)
    description: str = ""
    logo_url: str = ""
    socials: TenantSocials = Field(default_factory=TenantSocials)
    catalog: List[str] = Field(..., min_length=1)
    builder_fee_tenths: int = DEFAULT_FEE_TENTHS
    buyback_pct: int = 0
    burn_pct: int = 0
    owner_wallet: Optional[str] = None

    @field_validator("app_name")
    @classmethod
    def _name(cls, v: str) -> str:
        name = " ".join((v or "").split())
        if len(name) < 2:
            raise ValueError("App name is required")
        return name[:60]

    @field_validator("description")
    @classmethod
    def _desc(cls, v: str) -> str:
        return (v or "").strip()[:256]

    @field_validator("logo_url")
    @classmethod
    def _logo(cls, v: str) -> str:
        try:
            return normalize_logo_url(v)
        except TenantError as e:
            raise ValueError(e.message) from e

    @field_validator("slug")
    @classmethod
    def _slug(cls, v: str) -> str:
        try:
            return normalize_slug(v)
        except TenantError as e:
            raise ValueError(e.message) from e

    @field_validator("builder_fee_tenths")
    @classmethod
    def _fee(cls, v: int) -> int:
        return clamp_fee_tenths(v)

    @field_validator("buyback_pct", "burn_pct")
    @classmethod
    def _pledge(cls, v: int) -> int:
        return clamp_pledge_pct(v)

    @field_validator("catalog")
    @classmethod
    def _catalog_len(cls, v: List[str]) -> List[str]:
        if not v:
            raise ValueError("Pick at least one market")
        if len(v) > MAX_CATALOG:
            raise ValueError(f"Catalog is limited to {MAX_CATALOG} markets")
        return v

    status: str = "live"
    wizard_draft: Optional[Dict[str, Any]] = None

    @field_validator("status")
    @classmethod
    def _status(cls, v: str) -> str:
        status = (v or "live").strip().lower()
        if status not in ("draft", "live"):
            raise ValueError("status must be draft or live")
        return status


class TenantStreamPatch(BaseModel):
    """Desk overlay flags. Handle stays on socials.twitch (Privy-verified)."""

    twitch: Optional[bool] = None


def apply_stream_twitch(
    row: Dict[str, Any],
    enabled: bool,
    verified_twitch: Optional[str] = None,
) -> Dict[str, Any]:
    """Toggle the Twitch overlay. May fill an empty socials.twitch from Privy.

    Does not change an existing handle. Enabling without a verified channel
    raises TenantError("Connect Twitch first"). Overlay-off still fills an
    empty handle so the public Twitch icon can show.
    """
    socials = dict(row.get("socials") or {}) if isinstance(row.get("socials"), dict) else {}
    handle = twitch_login(socials.get("twitch")) or twitch_login(verified_twitch)
    updates: Dict[str, Any] = {"stream_twitch": bool(enabled)}
    if enabled and not handle:
        raise TenantError("Connect Twitch first", 400)
    if handle and not twitch_login(socials.get("twitch")):
        socials["twitch"] = handle
        updates["socials"] = socials
    return updates


def fill_empty_twitch(row: Dict[str, Any], verified_twitch: Optional[str]) -> Optional[Dict[str, Any]]:
    """Live-app exception: copy a Privy-verified login into an empty socials.twitch.

    Does not change an existing handle. Turns the desk overlay on once a channel
    is linked — connecting Twitch is enough; creators can still opt out later.
    """
    socials = dict(row.get("socials") or {}) if isinstance(row.get("socials"), dict) else {}
    if twitch_login(socials.get("twitch")):
        return None
    handle = twitch_login(verified_twitch)
    if not handle:
        return None
    socials["twitch"] = handle
    return {"socials": socials, "stream_twitch": True}


def stream_view(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"twitch": bool(row.get("stream_twitch"))}


class PatchTenantRequest(BaseModel):
    app_name: Optional[str] = None
    description: Optional[str] = None
    logo_url: Optional[str] = None
    socials: Optional[TenantSocials] = None
    catalog: Optional[List[str]] = None
    builder_fee_tenths: Optional[int] = None
    buyback_pct: Optional[int] = None
    burn_pct: Optional[int] = None
    status: Optional[str] = None
    slug: Optional[str] = None
    wizard_draft: Optional[Dict[str, Any]] = None
    stream: Optional["TenantStreamPatch"] = None
    # Trade wallet (Privy HD 0). Wizard sends it on every save so a row created
    # before the embedded wallet resolved is repaired on publish.
    owner_wallet: Optional[str] = None

    @field_validator("owner_wallet")
    @classmethod
    def _owner(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if not v:
            return None
        if not re.fullmatch(r"0x[a-fA-F0-9]{40}", v):
            raise ValueError("Invalid owner_wallet")
        return v.lower()

    @field_validator("app_name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        name = " ".join(v.split())
        if len(name) < 2:
            raise ValueError("App name is required")
        return name[:60]

    @field_validator("description")
    @classmethod
    def _desc(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else v.strip()[:256]

    @field_validator("logo_url")
    @classmethod
    def _logo(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            return normalize_logo_url(v)
        except TenantError as e:
            raise ValueError(e.message) from e

    @field_validator("builder_fee_tenths")
    @classmethod
    def _fee(cls, v: Optional[int]) -> Optional[int]:
        return None if v is None else clamp_fee_tenths(v)

    @field_validator("buyback_pct", "burn_pct")
    @classmethod
    def _pledge(cls, v: Optional[int]) -> Optional[int]:
        return None if v is None else clamp_pledge_pct(v)

    @field_validator("status")
    @classmethod
    def _status(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        status = v.strip().lower()
        if status not in ("draft", "live", "archived"):
            raise ValueError("Status must be draft, live, or archived")
        return status

    @field_validator("slug")
    @classmethod
    def _slug(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            return normalize_slug(v)
        except TenantError as e:
            raise ValueError(e.message) from e

    @field_validator("catalog")
    @classmethod
    def _catalog_len(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return v
        if not v:
            raise ValueError("Pick at least one market")
        if len(v) > MAX_CATALOG:
            raise ValueError(f"Catalog is limited to {MAX_CATALOG} markets")
        return v


class RegisterBuilderWalletsRequest(BaseModel):
    trade_wallet: str
    builder_wallet: str
    builder_wallet_index: Optional[int] = None
    source: str = "embedded"

    @field_validator("trade_wallet", "builder_wallet")
    @classmethod
    def _addr(cls, v: str) -> str:
        w = (v or "").strip().lower()
        if not re.fullmatch(r"0x[0-9a-f]{40}", w):
            raise ValueError("Invalid wallet address")
        return w

    @field_validator("source")
    @classmethod
    def _source(cls, v: str) -> str:
        src = (v or "embedded").strip().lower()
        if src not in BUILDER_WALLET_SOURCES:
            raise ValueError("source must be embedded or imported")
        return src

    @model_validator(mode="after")
    def _distinct_and_index(self) -> "RegisterBuilderWalletsRequest":
        if self.trade_wallet == self.builder_wallet:
            raise ValueError("trade_wallet and builder_wallet must differ")
        if self.source == "imported":
            idx = IMPORTED_BUILDER_INDEX if self.builder_wallet_index is None else int(
                self.builder_wallet_index
            )
            if idx != IMPORTED_BUILDER_INDEX:
                raise ValueError("imported builder_wallet_index must be 0")
            return self.model_copy(update={"builder_wallet_index": IMPORTED_BUILDER_INDEX})
        idx = BUILDER_WALLET_INDEX if self.builder_wallet_index is None else int(
            self.builder_wallet_index
        )
        if idx < 1:
            raise ValueError("builder_wallet_index must be >= 1")
        return self.model_copy(update={"builder_wallet_index": idx})


class BuilderLiveModeRequest(BaseModel):
    live: str

    @field_validator("live")
    @classmethod
    def _live(cls, v: str) -> str:
        mode = (v or "").strip().lower()
        if mode not in ("own", "preview"):
            raise ValueError("live must be own or preview")
        return mode


class UsdcPermitPayload(BaseModel):
    """EIP-2612 permit the web console signed with the builder wallet."""

    usd: str
    deadline: int
    signature: str
    signed_nonce: Optional[int] = None

    @field_validator("usd")
    @classmethod
    def _usd(cls, v: str) -> str:
        s = (v or "").strip()
        if not s.isdigit() or int(s) <= 0:
            raise ValueError("usd must be a positive integer in USDC base units")
        return s

    @field_validator("signature")
    @classmethod
    def _sig(cls, v: str) -> str:
        if not isinstance(v, str) or not v.startswith("0x") or len(v) < 130:
            raise ValueError("Invalid signature")
        return v


class BuilderActivateRequest(BaseModel):
    """One Activate click: optional 5 USDC fee permit + optional Bridge2 deposit permit.

    Sign both before either is submitted. Omit `fee` when already paid; omit
    `deposit` when HL already shows ≥100 USDC perp.
    """

    fee: Optional[UsdcPermitPayload] = None
    deposit: Optional[UsdcPermitPayload] = None


class TenantOrderAttributionRequest(BaseModel):
    cloid: str
    oid: Optional[int] = None
    symbol: str = ""
    wallet_address: str
    notional_usd: Optional[float] = None
    side: Optional[str] = None
    reduce_only: Optional[bool] = None

    @field_validator("cloid")
    @classmethod
    def _cloid(cls, v: str) -> str:
        s = (v or "").strip().lower()
        if not re.fullmatch(r"0x[0-9a-f]{32}", s):
            raise ValueError("Invalid cloid")
        if not s.startswith(f"0x{CLOID_TAG}"):
            raise ValueError("cloid is not a tenant tag")
        return s

    @field_validator("wallet_address")
    @classmethod
    def _wallet(cls, v: str) -> str:
        w = (v or "").strip().lower()
        if not re.fullmatch(r"0x[0-9a-f]{40}", w):
            raise ValueError("Invalid wallet address")
        return w

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, v: str) -> str:
        return (v or "").strip()[:40]

    @field_validator("notional_usd")
    @classmethod
    def _notional(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return None
        n = float(v)
        if not math.isfinite(n) or n < 0:
            raise ValueError("Invalid notional")
        return n

    @field_validator("side")
    @classmethod
    def _side(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip().lower()
        if s in ("buy", "long"):
            return "buy"
        if s in ("sell", "short"):
            return "sell"
        raise ValueError("side must be buy or sell")


def normalize_slug(raw: str) -> str:
    slug = (raw or "").strip().lower()
    if not SLUG_RE.fullmatch(slug):
        raise TenantError(
            "Slug must be 3–32 characters: lowercase letters, numbers, hyphens"
        )
    if slug in RESERVED_SLUGS:
        raise TenantError("This slug is reserved")
    return slug


def normalize_logo_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        return ""
    if len(url) > 500:
        raise TenantError("Logo URL is too long")
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise TenantError("Logo URL must start with https://")
    return url


# Hostname labels only — blocks javascript:, data:, IPs, userinfo tricks.
_WEBSITE_HOST_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)


def normalize_website_url(raw: str) -> str:
    """Optional creator website: https + real domain only. Empty is fine."""
    text = (raw or "").strip()
    if not text:
        return ""
    if len(text) > 200:
        raise TenantError("Website URL is too long")
    lower = text.lower()
    if lower.startswith("http://"):
        raise TenantError("Website must use https://")
    if not lower.startswith("https://"):
        text = "https://" + text.lstrip("/")
    parsed = urlparse(text)
    if parsed.scheme != "https":
        raise TenantError("Website must use https://")
    if parsed.username is not None or parsed.password is not None:
        raise TenantError("Website URL is invalid")
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host or not _WEBSITE_HOST_RE.fullmatch(host):
        raise TenantError("Website must be a domain like example.com")
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", host):
        raise TenantError("Website must be a domain like example.com")
    path = parsed.path or ""
    query = f"?{parsed.query}" if parsed.query else ""
    out = f"https://{host}{path}{query}"
    if len(out) > 200:
        raise TenantError("Website URL is too long")
    return out


def clamp_fee_tenths(value: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError) as exc:
        raise TenantError("Invalid builder fee") from exc
    if n < 0 or n > MAX_FEE_TENTHS:
        raise TenantError("Builder fee must be 0–10 bps (0–100 tenths)")
    return n


def clamp_pledge_pct(value: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError) as exc:
        raise TenantError("Invalid buyback or burn percent") from exc
    if n < 0 or n > 100:
        raise TenantError("Buyback and burn must be 0–100%")
    return n


def cloid_prefix_for_tenant_id(tenant_id: str) -> str:
    digest = hashlib.sha256(str(tenant_id).encode("utf-8")).hexdigest()
    return f"0x{CLOID_TAG}{digest[:8]}"


def public_tenant_url(slug: str) -> str:
    s = (slug or "").strip().lower()
    return f"https://{s}.{TENANT_BASE_DOMAIN}"


def allowed_catalog_symbols(
    asset_meta: Dict[str, Any],
    crypto_meta: Dict[str, Any],
) -> Set[str]:
    out: Set[str] = set()
    for key in crypto_meta:
        out.add(str(key).upper())
    for key, meta in asset_meta.items():
        key_u = str(key).upper()
        out.add(key_u)
        if not isinstance(meta, dict):
            continue
        dex = str(meta.get("dex") or "xyz").lower()
        sym = str(meta.get("symbol") or key).upper()
        display = str(meta.get("displayName") or "").upper()
        out.add(f"{dex}:{sym}".upper())
        out.add(f"{dex}:{key_u}")
        if display:
            out.add(display)
            out.add(f"{dex}:{display}")
    return out


def normalize_catalog(
    raw: Iterable[str],
    allowed: Set[str],
) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for item in raw:
        coin = (item or "").strip()
        if not coin:
            continue
        if not (COIN_RE.fullmatch(coin) or HIP3_COIN_RE.fullmatch(coin)):
            raise TenantError(f"Invalid market symbol: {coin}")
        key = coin if ":" in coin else coin.upper()
        lookup = key.upper()
        if lookup not in allowed and key not in allowed:
            raise TenantError(f"Unknown market: {coin}")
        store = coin if ":" in coin else coin.upper()
        marker = store.upper()
        if marker in seen:
            continue
        seen.add(marker)
        out.append(store)
        if len(out) > MAX_CATALOG:
            raise TenantError(f"Catalog is limited to {MAX_CATALOG} markets")
    if not out:
        raise TenantError("Pick at least one market")
    return out


def reject_live_identity_patch(row: Dict[str, Any], payload: Dict[str, Any]) -> None:
    """Live apps cannot change name / logo / bio / socials / catalog / handle."""
    if (row.get("status") or "") != "live":
        return
    locked = [k for k in LIVE_LOCKED_FIELDS if k in payload]
    if locked:
        raise TenantError(
            "Name, bio, socials, and markets stay as they were at publish. "
            "You can still change the logo, builder fee, buyback, burn, and the Twitch overlay.",
            status_code=400,
        )


def fee_history_public(rows: Optional[Iterable[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for row in rows or []:
        try:
            frm = int(row.get("from_tenths"))
            to = int(row.get("to_tenths"))
        except (TypeError, ValueError):
            continue
        out.append({
            "from_tenths": frm,
            "to_tenths": to,
            "changed_at": row.get("changed_at"),
        })
    return out


def fee_history_row(tenant_id: str, from_tenths: int, to_tenths: int) -> Dict[str, Any]:
    return {
        "tenant_id": tenant_id,
        "from_tenths": int(from_tenths),
        "to_tenths": int(to_tenths),
    }


def pct_history_public(rows: Optional[Iterable[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for row in rows or []:
        try:
            frm = int(row.get("from_pct"))
            to = int(row.get("to_pct"))
        except (TypeError, ValueError):
            continue
        out.append({
            "from_pct": frm,
            "to_pct": to,
            "changed_at": row.get("changed_at"),
        })
    return out


def pledge_history_row(tenant_id: str, kind: str, from_pct: int, to_pct: int) -> Dict[str, Any]:
    k = (kind or "").strip().lower()
    if k not in ("buyback", "burn"):
        raise TenantError("Pledge history kind must be buyback or burn")
    return {
        "tenant_id": tenant_id,
        "kind": k,
        "from_pct": int(from_pct),
        "to_pct": int(to_pct),
    }


# Which verified social names the creator across all their apps. X first.
CREATOR_HANDLE_PRIORITY = ("twitter", "telegram", "twitch", "youtube", "tiktok", "instagram", "discord")


def creator_key(privy_user_id: Any) -> str:
    """Opaque, stable, public grouping key for one login. Never the raw Privy id."""
    uid = str(privy_user_id or "")
    if not uid:
        return ""
    return hashlib.sha256(uid.encode("utf-8")).hexdigest()[:10]


def creator_view(user_rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """One creator across their live apps, or None when they have no verified social.

    Identity is the Privy login (every app the creator connects X on carries
    the same handle), so we group by login and pick the first verified handle by
    `CREATOR_HANDLE_PRIORITY`. No verified social → no public identity: the
    apps read as standalone and the creator line is simply not rendered.
    """
    live = [r for r in user_rows if (r.get("status") or "") == "live"]
    if not live:
        return None
    uid = str(live[0].get("privy_user_id") or "")
    handle = ""
    kind = ""
    for k in CREATOR_HANDLE_PRIORITY:
        for r in live:
            socials = r.get("socials") if isinstance(r.get("socials"), dict) else {}
            h = _handle(socials.get(k)) if k != "twitch" else twitch_login(socials.get(k))
            if h:
                handle, kind = h, k
                break
        if handle:
            break
    if not handle:
        return None
    live.sort(key=lambda r: str(r.get("created_at") or ""))
    return {
        "key": creator_key(uid),
        "handle": handle,
        "kind": kind,
        "apps": [
            {
                "slug": r.get("slug") or "",
                "app_name": r.get("app_name") or "",
                "logo_url": r.get("logo_url") or "",
                "coin_symbol": r.get("coin_symbol") or None,
                "url": public_tenant_url(r.get("slug") or ""),
            }
            for r in live
        ],
    }


def public_view(
    row: Dict[str, Any],
    *,
    include_owner: bool = False,
    attribution: Optional[Dict[str, Any]] = None,
    hl_builder: Optional[Dict[str, Any]] = None,
    fee_history: Optional[List[Dict[str, Any]]] = None,
    buyback_history: Optional[List[Dict[str, Any]]] = None,
    burn_history: Optional[List[Dict[str, Any]]] = None,
    creator: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    slug = row.get("slug") or ""
    socials = row.get("socials") if isinstance(row.get("socials"), dict) else {}
    catalog = row.get("catalog") if isinstance(row.get("catalog"), list) else []
    view: Dict[str, Any] = {
        "id": row.get("id"),
        "slug": slug,
        "app_name": row.get("app_name"),
        "description": row.get("description") or "",
        "logo_url": row.get("logo_url") or "",
        "socials": {
            "twitter": str(socials.get("twitter") or ""),
            "telegram": str(socials.get("telegram") or ""),
            "discord": str(socials.get("discord") or ""),
            "tiktok": str(socials.get("tiktok") or ""),
            "instagram": str(socials.get("instagram") or ""),
            "youtube": str(socials.get("youtube") or ""),
            "twitch": str(socials.get("twitch") or ""),
            "website": str(socials.get("website") or ""),
        },
        "catalog": [str(c) for c in catalog],
        "builder_address": row.get("builder_address"),
        "builder_fee_tenths": int(row.get("builder_fee_tenths") or DEFAULT_FEE_TENTHS),
        "builder_fee_history": fee_history_public(fee_history),
        "buyback_pct": int(row.get("buyback_pct") or 0),
        "burn_pct": int(row.get("burn_pct") or 0),
        "buyback_history": pct_history_public(buyback_history),
        "burn_history": pct_history_public(burn_history),
        "stream": stream_view(row),
        "cloid_prefix": row.get("cloid_prefix"),
        "status": row.get("status"),
        "url": public_tenant_url(slug),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    view["coin"] = coin_view(row)
    host = (row.get("custom_domain") or "").strip().lower()
    verified = bool(host and row.get("custom_domain_verified_at"))
    view["custom_domain"] = host if verified else None
    view["custom_url"] = f"https://{host}" if verified else None
    if include_owner:
        view["privy_user_id"] = row.get("privy_user_id")
        view["owner_wallet"] = row.get("owner_wallet")
        view["wizard_draft"] = row.get("wizard_draft") if row.get("status") == "draft" else None
        from tenant_domains import domain_owner_view

        view["domain"] = domain_owner_view(row)
    if attribution is not None:
        view["attribution"] = attribution
    if hl_builder is not None:
        view["hl_builder"] = hl_builder
    # Null when the login has no verified social — unverified creators stay anonymous.
    view["creator"] = creator
    return view


# Showcase exception: tokens that live on Robinhood Chain but were NOT launched
# through Pons (e.g. a Uniswap v4 pool via pools.xyz). Keyed by tenants.id.
# The creator page shows price / mcap / volume / holders from Dexscreener and
# links out to trade; Pons-only UI (curve ticket, creator fees, buyback, tax)
# is hidden. A real Pons launch stored in coin_* always wins over this map.
EXTERNAL_COINS: Dict[str, Dict[str, Any]] = {
    "a25c7e3d-8d10-471a-9baf-3d3b4ed9ecf0": {
        "token": "0x7bb3E171EC502F65C08D38a61D51B9841524A72D",
        "symbol": "LWL",
        "chain_id": 4663,
        "venue": "pools.xyz",
        "trade_url": "https://pools.xyz/t/robinhood/0x7bb3E171EC502F65C08D38a61D51B9841524A72D",
        "pool": "0xce237c2653ee69f2e3f839df59f5650ba87c807b879f3064c67cb3437e454527",
        # Showcase card stats (not from Pons). 25 bps = 0.25%.
        "buyback_enabled": True,
        "trade_fee_bps": 25,
        "earned_usd": 43,
        "holders": 45,
    },
}


def coin_view(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Pons launch attached to this app, or None. See builderpad_tenant_coin.sql."""
    token = row.get("coin_token")
    if not token:
        ext = EXTERNAL_COINS.get(str(row.get("id") or "").lower())
        if not ext:
            return None
        return {
            "token": str(ext["token"]),
            "curve": "",
            "pair_token": "",
            "chain_id": int(ext.get("chain_id") or 4663),
            "launch_config_id": 0,
            "tx_hash": "",
            "symbol": str(ext.get("symbol") or ""),
            "dev_buy_quote": "0",
            "creator_tax_bps": 0,
            "buyback_enabled": bool(ext.get("buyback_enabled")),
            "fee_recipient": "",
            "launched_at": row.get("created_at"),
            "source": "external",
            "venue": str(ext.get("venue") or ""),
            "trade_url": str(ext.get("trade_url") or ""),
            "pool": str(ext.get("pool") or ""),
            "trade_fee_bps": int(ext["trade_fee_bps"]) if ext.get("trade_fee_bps") is not None else None,
            "earned_usd": float(ext["earned_usd"]) if ext.get("earned_usd") is not None else None,
            "holders": int(ext["holders"]) if ext.get("holders") is not None else None,
        }
    return {
        "token": str(token),
        "curve": str(row.get("coin_curve") or ""),
        "pair_token": str(row.get("coin_pair_token") or ""),
        "chain_id": int(row.get("coin_chain_id") or 0),
        "launch_config_id": int(row.get("coin_launch_config_id") or 0),
        "tx_hash": str(row.get("coin_tx_hash") or ""),
        "symbol": str(row.get("coin_symbol") or ""),
        "dev_buy_quote": str(row.get("coin_dev_buy_quote") or "0"),
        "creator_tax_bps": int(row.get("coin_creator_tax_bps") or 0),
        "buyback_enabled": bool(row.get("coin_buyback_enabled")),
        "fee_recipient": str(row.get("coin_fee_recipient") or ""),
        "launched_at": row.get("coin_launched_at"),
        "source": "pons",
    }


class TenantCoinRequest(BaseModel):
    """What the browser reports after `launchToken` / `launchAndBuy` confirms.

    Only `token` and `tx_hash` are trusted from the client; the rest is
    re-read from the factory in `pons.verify_launch`.
    """

    token: str = Field(..., min_length=42, max_length=42)
    tx_hash: str = Field(..., min_length=66, max_length=66)
    chain_id: int = 4663
    launch_config_id: int = 0
    symbol: str = ""
    dev_buy_quote: str = "0"
    # The HD 0 that signed the launch. Used (after a Privy ownership check) to
    # backfill `owner_wallet` on rows saved before the wallet had resolved.
    owner_wallet: Optional[str] = None

    @field_validator("owner_wallet")
    @classmethod
    def _owner(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if not v:
            return None
        if not re.fullmatch(r"0x[a-fA-F0-9]{40}", v):
            raise ValueError("Invalid owner_wallet")
        return v.lower()

    @field_validator("token")
    @classmethod
    def _token(cls, v: str) -> str:
        v = (v or "").strip()
        if not re.fullmatch(r"0x[a-fA-F0-9]{40}", v):
            raise ValueError("Invalid token address")
        return v

    @field_validator("tx_hash")
    @classmethod
    def _tx(cls, v: str) -> str:
        v = (v or "").strip()
        if not re.fullmatch(r"0x[a-fA-F0-9]{64}", v):
            raise ValueError("Invalid transaction hash")
        return v

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, v: str) -> str:
        return re.sub(r"[^A-Za-z0-9]", "", v or "").upper()[:20]

    @field_validator("dev_buy_quote")
    @classmethod
    def _dev_buy(cls, v: str) -> str:
        v = (v or "0").strip()
        if not re.fullmatch(r"\d+(\.\d+)?", v):
            raise ValueError("Invalid dev buy amount")
        return v[:40]


def sanitize_wizard_draft(raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Keep a small JSON blob for unpublished wizard progress. Not public."""
    if not raw or not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    chapter = raw.get("chapter")
    if isinstance(chapter, int) and chapter in (0, 1, 2):
        out["chapter"] = chapter
    notional = raw.get("notional")
    if isinstance(notional, (int, float)) and notional > 0:
        out["notional"] = float(notional)
    show = raw.get("show")
    if isinstance(show, dict):
        out["show"] = {str(k): bool(v) for k, v in list(show.items())[:12]}
    coin = raw.get("coin")
    if isinstance(coin, dict):
        out["coin"] = {
            "symbol": str(coin.get("symbol") or "")[:20],
            "pairToken": str(coin.get("pairToken") or "")[:42],
            "devBuy": str(coin.get("devBuy") or "")[:40],
            "creatorTaxBps": int(coin.get("creatorTaxBps") or 0),
            "buybackEnabled": bool(coin.get("buybackEnabled")),
            "creatorFeeRecipient": str(coin.get("creatorFeeRecipient") or "")[:42],
            "advancedOpen": bool(coin.get("advancedOpen")),
        }
    return out or None


def row_to_insert(
    *,
    body: CreateTenantRequest,
    privy_user_id: str,
    builder_address: str,
    catalog: List[str],
) -> Dict[str, Any]:
    socials = body.socials.model_dump()
    return {
        "slug": body.slug,
        "app_name": body.app_name,
        "description": body.description,
        "logo_url": body.logo_url,
        "socials": socials,
        "catalog": catalog,
        "builder_address": builder_address,
        "builder_fee_tenths": body.builder_fee_tenths,
        "buyback_pct": body.buyback_pct,
        "burn_pct": body.burn_pct,
        "cloid_prefix": "",  # filled after insert once we have the uuid
        "privy_user_id": privy_user_id,
        "owner_wallet": (body.owner_wallet or "").strip().lower() or None,
        "status": body.status or "live",
        "wizard_draft": sanitize_wizard_draft(body.wizard_draft) if body.status == "draft" else None,
        # Connecting Twitch at publish turns the desk overlay on.
        "stream_twitch": bool(twitch_login(socials.get("twitch"))),
    }


def assert_builder_registration(
    *,
    body: RegisterBuilderWalletsRequest,
    platform_builder: str,
    embedded: Optional[set[str]] = None,
    external: Optional[set[str]] = None,
    imported_standard: Optional[bool] = None,
) -> None:
    """Raise TenantError if the pair cannot be stored.

    When Privy classification is available, imported builders must be external
    EOAs and the trade wallet must be a Privy embed. Imported wallets that are
    unified on HL are rejected — that address cannot be Standard `b`.

    Owning the platform builder via SIWE is allowed (the operator importing
    their existing HL builder). Random clients cannot pass that address —
    ``_assert_caller_owns_wallet`` already requires the Privy user to control it.
    """
    _ = platform_builder
    if body.source == "imported":
        if imported_standard is False:
            raise TenantError(
                "This wallet is unified on Hyperliquid. Switch MetaMask to your "
                "Standard builder address, or create a new builder wallet.",
                400,
            )
        if embedded is not None and body.trade_wallet not in embedded:
            raise TenantError("Trade wallet must be the Privy embedded wallet", 400)
        if external is not None and body.builder_wallet not in external:
            raise TenantError(
                "Imported builder must be the connected wallet (not the Privy trade wallet)",
                400,
            )
        if embedded is not None and body.builder_wallet in embedded:
            raise TenantError("Imported builder cannot be a Privy embedded wallet", 400)
    elif embedded is not None:
        if body.trade_wallet not in embedded or body.builder_wallet not in embedded:
            raise TenantError("Both wallets must be Privy embedded wallets", 400)


def is_standard_builder_mode(mode: Optional[str]) -> bool:
    """HL builder codes require Standard — not unified / portfolio margin."""
    if not mode or mode in ("default", "disabled", "standard"):
        return True
    return mode not in POOLED_ABSTRACTION


def perp_equity_from_clearinghouse(state: Any) -> float:
    if not isinstance(state, dict):
        return 0.0
    summary = state.get("marginSummary") if isinstance(state.get("marginSummary"), dict) else {}
    try:
        return float(summary.get("accountValue") or 0)
    except (TypeError, ValueError):
        return 0.0


def builder_ready(equity: float, mode: Optional[str]) -> bool:
    return equity + 1e-9 >= BUILDER_ACTIVATION_USDC and is_standard_builder_mode(mode)


def builder_fee_paid(row: Optional[Dict[str, Any]]) -> bool:
    return bool(row and row.get("activation_fee_paid_at"))


def builder_wallets_public(
    row: Optional[Dict[str, Any]],
    *,
    hl: Optional[Dict[str, Any]] = None,
    platform_builder: Optional[str] = None,
    activation_fee_usdc: float = 5.0,
) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    status = row.get("status") or "provisioned"
    raw_idx = row.get("builder_wallet_index")
    source = row.get("source") or "embedded"
    try:
        idx = int(raw_idx) if raw_idx is not None else (
            IMPORTED_BUILDER_INDEX if source == "imported" else BUILDER_WALLET_INDEX
        )
    except (TypeError, ValueError):
        idx = IMPORTED_BUILDER_INDEX if source == "imported" else BUILDER_WALLET_INDEX
    view: Dict[str, Any] = {
        "trade_wallet": row.get("trade_wallet"),
        "builder_wallet": row.get("builder_wallet"),
        "builder_wallet_index": idx,
        "source": source,
        "status": status,
        "live": "own" if status == "active" else "preview",
        "never_unify_builder": True,
        "activation_usdc": BUILDER_ACTIVATION_USDC,
        "activation_fee_usdc": float(activation_fee_usdc),
        "activation_fee_paid": builder_fee_paid(row),
        "activation_fee_paid_at": row.get("activation_fee_paid_at"),
        "activation_fee_tx": row.get("activation_fee_tx"),
        "funded_at": row.get("funded_at"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    if platform_builder:
        view["platform_builder"] = platform_builder
    if hl is not None:
        view["hl"] = hl
    return view


def row_to_builder_wallets_insert(
    *,
    privy_user_id: str,
    body: RegisterBuilderWalletsRequest,
) -> Dict[str, Any]:
    return {
        "privy_user_id": privy_user_id,
        "trade_wallet": body.trade_wallet,
        "builder_wallet": body.builder_wallet,
        "builder_wallet_index": int(body.builder_wallet_index),
        "source": body.source,
        "status": "provisioned",
    }


def is_platform_builder(builder_address: Optional[str], platform: str) -> bool:
    """True when the app still uses the shared HyperTrade ``b`` (preview)."""
    plat = normalize_builder_address(platform, platform)
    if not plat:
        return False
    return normalize_builder_address(builder_address, platform) == plat


def count_preview_live(
    rows: Iterable[Dict[str, Any]],
    platform_builder: str,
    *,
    exclude_id: Optional[str] = None,
) -> int:
    """Live apps still on the platform builder. Drafts and own-builder do not count."""
    n = 0
    skip = (exclude_id or "").lower()
    for row in rows:
        if skip and str(row.get("id") or "").lower() == skip:
            continue
        if (row.get("status") or "") != "live":
            continue
        if is_platform_builder(row.get("builder_address"), platform_builder):
            n += 1
    return n


def preview_live_cap_detail() -> str:
    n = MAX_PREVIEW_LIVE_PER_USER
    apps = "app" if n == 1 else f"{n} apps"
    return (
        f"Preview is {n} live {apps} on the shared HyperTrade builder. "
        f"Activate to collect on yours and launch more (up to {MAX_TENANTS_PER_USER})."
    )


def normalize_builder_address(raw: Optional[str], fallback: str) -> str:
    """Canonical lowercase 0x for a *server-held* builder (DB row or env).

    Prefer ``raw`` when it is already a valid address (tenant row, claimed
    HD 1 / imported builder). Use ``fallback`` when ``raw`` is empty or
    malformed (preview apps fall back to ``BUILDER_ADDRESS``).

    Callers must not pass a client-pasted builder. Order ``b`` is always
    ``tenants.builder_address`` written by the server, never a request field.
    """
    for candidate in (raw, fallback):
        s = (candidate or "").strip().lower()
        if re.fullmatch(r"0x[0-9a-f]{40}", s):
            return s
    return (fallback or "").strip().lower()


def aggregate_user_fills_by_oid(fills: Any) -> Dict[int, Dict[str, Any]]:
    """HL userFills / userFillsByTime → per-oid filled notional + builderFee.

    Official fee is fill.builderFee (absent when 0). Multiple fills can share an oid.
    Match attributions as (wallet, oid) — never cloid alone.
    """
    by_oid: Dict[int, Dict[str, Any]] = {}
    if not isinstance(fills, list):
        return by_oid
    for fill in fills:
        if not isinstance(fill, dict):
            continue
        try:
            oid = int(fill.get("oid") or 0)
        except (TypeError, ValueError):
            continue
        if oid <= 0:
            continue
        try:
            px = float(fill.get("px") or 0)
            sz = abs(float(fill.get("sz") or 0))
        except (TypeError, ValueError):
            continue
        raw_fee = fill.get("builderFee")
        try:
            fee = float(raw_fee) if raw_fee not in (None, "") else 0.0
        except (TypeError, ValueError):
            fee = 0.0
        rec = by_oid.setdefault(
            oid,
            {"filled_notional_usd": 0.0, "settled_builder_fee_usd": 0.0, "fill_count": 0},
        )
        rec["filled_notional_usd"] += px * sz
        rec["settled_builder_fee_usd"] += fee
        rec["fill_count"] += 1
    for rec in by_oid.values():
        rec["filled_notional_usd"] = round(float(rec["filled_notional_usd"]), 8)
        rec["settled_builder_fee_usd"] = round(float(rec["settled_builder_fee_usd"]), 8)
    return by_oid


def settlement_patch(agg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "filled_notional_usd": agg.get("filled_notional_usd"),
        "settled_builder_fee_usd": agg.get("settled_builder_fee_usd"),
        "fill_count": int(agg.get("fill_count") or 0),
        "settled_at": datetime.now(timezone.utc).isoformat(),
    }


def attribution_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "cloid": row.get("cloid"),
        "oid": row.get("oid"),
        "symbol": row.get("symbol") or "",
        "side": row.get("side"),
        "reduce_only": row.get("reduce_only"),
        "wallet_address": row.get("wallet_address"),
        "builder_address": row.get("builder_address"),
        "builder_fee_tenths": row.get("builder_fee_tenths"),
        "notional_usd": row.get("notional_usd"),
        "est_builder_fee_usd": row.get("est_builder_fee_usd"),
        "filled_notional_usd": row.get("filled_notional_usd"),
        "settled_builder_fee_usd": row.get("settled_builder_fee_usd"),
        "fill_count": row.get("fill_count"),
        "settled_at": row.get("settled_at"),
        "created_at": row.get("created_at"),
    }


def summarize_attributions(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    orders = 0
    est = 0.0
    settled = 0.0
    filled = 0.0
    for row in rows:
        orders += 1
        try:
            if row.get("est_builder_fee_usd") is not None:
                est += float(row["est_builder_fee_usd"])
        except (TypeError, ValueError):
            pass
        try:
            if row.get("settled_builder_fee_usd") is not None:
                settled += float(row["settled_builder_fee_usd"])
        except (TypeError, ValueError):
            pass
        try:
            if row.get("filled_notional_usd") is not None:
                filled += float(row["filled_notional_usd"])
        except (TypeError, ValueError):
            pass
    return {
        "orders": orders,
        "est_builder_fee_usd": round(est, 8),
        "settled_builder_fee_usd": round(settled, 8),
        "filled_notional_usd": round(filled, 8),
    }


def hl_builder_from_referral(raw: Any, *, fee_tenths: int) -> Optional[Dict[str, Any]]:
    """Lifetime builder fees from HL `referral.builderRewards` (all interfaces).

    Volume is implied as fee / (tenths / 100000). Official fill dumps are daily
    CSVs; this is the cheap public number HL exposes on the builder address.
    """
    if not isinstance(raw, dict):
        return None
    try:
        fee = float(raw.get("builderRewards") or 0)
    except (TypeError, ValueError):
        return None
    if fee <= 0:
        return None
    tenths = max(int(fee_tenths or DEFAULT_FEE_TENTHS), 1)
    notional = fee / (tenths / 100000.0)
    return {
        "fee_usd": round(fee, 4),
        "filled_notional_usd": round(notional, 2),
        "orders": 0,
        "source": "hyperliquid",
        "notional_from": "builder_rewards",
    }


def is_unique_violation(err: Exception) -> bool:
    text = str(err).lower()
    return "duplicate key" in text or "23505" in text or "unique" in text


def parse_supabase_error(err: Exception) -> Tuple[int, str]:
    if is_unique_violation(err):
        return 409, "That slug is already taken"
    return 500, "Could not save tenant"


# ---------------------------------------------------------------------------
# Logo upload — same sanitizer as OrbCast avatars (magic bytes + re-encode).
# Public `tenant-logos` bucket: app logos are meant to be shown on /t/{slug}.
# ---------------------------------------------------------------------------

LOGO_BUCKET = "tenant-logos"
LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_MAX_EDGE = 512
LOGO_MAX_PIXELS = 4096 * 4096
LOGO_PATH_RE = re.compile(r"^[a-f0-9]{32}/[0-9a-f-]{36}\.webp$")
Image.MAX_IMAGE_PIXELS = LOGO_MAX_PIXELS


class TenantLogoUploadRequest(BaseModel):
    """Raw image as base64. JSON avoids multipart; same shape as OrbCast avatars."""

    image_base64: str = Field(..., min_length=32, max_length=4_000_000)


def decode_logo_base64(payload: str) -> bytes:
    text = (payload or "").strip()
    if text.startswith("data:"):
        comma = text.find(",")
        if comma < 0:
            raise TenantError("Use a PNG, JPG, or WebP image")
        text = text[comma + 1 :]
    text = "".join(text.split())
    try:
        raw = base64.b64decode(text, validate=False)
    except Exception as exc:
        raise TenantError("Use a PNG, JPG, or WebP image") from exc
    if not raw:
        raise TenantError("Use a PNG, JPG, or WebP image")
    if len(raw) > LOGO_MAX_BYTES:
        raise TenantError("Image must be 2 MB or smaller", status_code=413)
    return raw


def sniff_image_kind(data: bytes) -> Optional[str]:
    """Magic bytes only — never trust Content-Type or filename."""
    if len(data) < 12:
        return None
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def sanitize_logo_bytes(raw: bytes) -> bytes:
    """Reject polyglots / odd formats; re-encode to a small WebP."""
    if len(raw) > LOGO_MAX_BYTES:
        raise TenantError("Image must be 2 MB or smaller", status_code=413)
    kind = sniff_image_kind(raw)
    if kind is None:
        raise TenantError("Use a PNG, JPG, or WebP image")
    try:
        probe = io.BytesIO(raw)
        with Image.open(probe) as checked:
            checked.verify()
        probe.seek(0)
        img = Image.open(probe)
        img.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise TenantError("That file is not a valid image") from exc
    fmt = (img.format or "").upper()
    expected = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}[kind]
    if fmt != expected:
        img.close()
        raise TenantError("Use a PNG, JPG, or WebP image")
    if img.width * img.height > LOGO_MAX_PIXELS:
        img.close()
        raise TenantError("Image is too large")
    try:
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")
        img.thumbnail((LOGO_MAX_EDGE, LOGO_MAX_EDGE), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="WEBP", quality=82, method=6)
    finally:
        try:
            img.close()
        except Exception:
            pass
    cleaned = out.getvalue()
    if len(cleaned) > LOGO_MAX_BYTES:
        raise TenantError("Image must be 2 MB or smaller", status_code=413)
    if sniff_image_kind(cleaned) != "webp":
        raise TenantError("Could not process that image")
    return cleaned


def logo_object_path(privy_user_id: str) -> str:
    digest = hashlib.sha256(privy_user_id.encode("utf-8")).hexdigest()[:32]
    return f"{digest}/{uuid.uuid4()}.webp"


def logo_public_url(supabase_url: str, path: str) -> str:
    base = (supabase_url or "").rstrip("/")
    return f"{base}/storage/v1/object/public/{LOGO_BUCKET}/{path}"


def ensure_logo_bucket(client: Any) -> None:
    if not client:
        return
    try:
        client.storage.get_bucket(LOGO_BUCKET)
        return
    except Exception:
        pass
    try:
        client.storage.create_bucket(
            LOGO_BUCKET,
            options={
                "public": True,
                "file_size_limit": LOGO_MAX_BYTES,
                "allowed_mime_types": ["image/jpeg", "image/png", "image/webp"],
            },
        )
    except Exception as e:
        raise TenantError(f"Could not create logo storage: {e}", status_code=503) from e


def upload_logo_object(client: Any, path: str, data: bytes) -> None:
    ensure_logo_bucket(client)
    client.storage.from_(LOGO_BUCKET).upload(
        path,
        data,
        file_options={"content-type": "image/webp", "upsert": "true"},
    )
