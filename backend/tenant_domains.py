"""Creator-owned custom domains for activated BuilderPad apps.

Preview (shared HyperTrade `b`) cannot attach a host. Canonical public URL is
`https://{slug}.builderpad.xyz`. The Vite SPA on Vercel serves the hostname;
FastAPI maps host → slug. Local/dev still uses `/t/{slug}`.

Creators add two DNS records at their registrar (GoDaddy / Namecheap / …):
  TXT   `_builderpad.{host}` → token
  CNAME `{host}`             → Vercel (`cname.vercel-dns.com` by default)

HTTPS is Let's Encrypt on that Vercel project (Pro). Do not tell them to buy a cert.
`{slug}.builderpad.xyz` is covered by Privy origin `https://*.builderpad.xyz`.
Creator-owned hosts must still be added in the Privy dashboard (no public API).
"""
from __future__ import annotations

import os
import re
import secrets
import time
from typing import Any, Dict, Iterable, List, Optional, Set
from urllib.parse import urlparse

import httpx

from pydantic import BaseModel, Field, field_validator

from tenants import RESERVED_SLUGS, SLUG_RE, TENANT_BASE_DOMAIN, TenantError

CNAME_TARGET = (os.getenv("BUILDERPAD_VERCEL_CNAME") or "cname.vercel-dns.com").strip().rstrip(".")
TXT_LABEL = "_builderpad"
# Vercel publishes cname.vercel-dns.com and cname.vercel-dns-0.com (not arbitrary *vercel-dns*).
_VERCEL_CNAME_RE = re.compile(r"^cname\.vercel-dns(?:-\d+)?\.com$")

# Bare `example.com` is not v1 (needs ALIAS / A 76.76.21.21). Subdomain only.
_HOST_RE = re.compile(
    r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)"
    r"(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)

_PLATFORM_HOSTS = {
    "localhost",
    "127.0.0.1",
    TENANT_BASE_DOMAIN,
    f"www.{TENANT_BASE_DOMAIN}",
    "hypertrade.exchange",
    "www.hypertrade.exchange",
    "app.hypertrade.exchange",
    "ai.hypertrade.exchange",
}

_PLATFORM_SUFFIXES = (
    ".vercel.app",
    ".localhost",
    f".{TENANT_BASE_DOMAIN}",
    ".hypertrade.exchange",
)

_verified_hosts: Set[str] = set()
_verified_hosts_at = 0.0
_VERIFIED_TTL = 60.0


class AssignDomainRequest(BaseModel):
    host: str = Field(..., min_length=3, max_length=253)

    @field_validator("host")
    @classmethod
    def _host(cls, v: str) -> str:
        try:
            return normalize_custom_host(v)
        except TenantError as e:
            raise ValueError(e.message) from e


def vercel_cname_target() -> str:
    return CNAME_TARGET


def normalize_custom_host(raw: str) -> str:
    v = (raw or "").strip().lower()
    v = v.replace("https://", "").replace("http://", "")
    v = v.split("/")[0].split(":")[0].strip().rstrip(".")
    if not v:
        raise TenantError("Enter an address like trade.yourdomain.com")
    try:
        v = v.encode("idna").decode("ascii")
    except UnicodeError:
        raise TenantError("That domain has characters we cannot use")
    if not _HOST_RE.fullmatch(v):
        raise TenantError("Use lowercase letters, numbers, and dots. Example: trade.yourdomain.com")
    labels = v.split(".")
    if len(labels) < 3:
        raise TenantError(
            "Put a name in front of your domain, like trade.yourdomain.com or app.yourdomain.com. "
            "The bare domain (yourdomain.com) is not supported yet."
        )
    if v in _PLATFORM_HOSTS or any(v.endswith(s) for s in _PLATFORM_SUFFIXES):
        raise TenantError("That address is reserved")
    return v


def txt_fqdn(host: str) -> str:
    return f"{TXT_LABEL}.{host}"


def dns_short_names(host: str) -> Dict[str, str]:
    """Registrar 'Name/Host' fields are usually relative to the zone (last two labels)."""
    labels = host.split(".")
    left = ".".join(labels[:-2])
    return {
        "txt_short": f"{TXT_LABEL}.{left}" if left else TXT_LABEL,
        "cname_short": left or "@",
    }


def new_txt_token() -> str:
    return "bp_" + secrets.token_urlsafe(16).replace("-", "").replace("_", "")[:22]


def domain_records(host: str, token: str) -> Dict[str, str]:
    short = dns_short_names(host)
    return {
        "host": host,
        "txt_name": txt_fqdn(host),
        "txt_short": short["txt_short"],
        "txt_value": token,
        "cname_name": host,
        "cname_short": short["cname_short"],
        "cname_target": CNAME_TARGET,
    }


def domain_owner_view(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    host = (row.get("custom_domain") or "").strip().lower()
    token = (row.get("custom_domain_txt") or "").strip()
    if not host or not token:
        return None
    rec = domain_records(host, token)
    rec["verified"] = bool(row.get("custom_domain_verified_at"))
    return rec


def remember_verified_host(host: str) -> None:
    if host:
        _verified_hosts.add(host.lower())


def forget_verified_host(host: str) -> None:
    _verified_hosts.discard((host or "").lower())


def replace_verified_hosts(hosts: Iterable[str]) -> None:
    global _verified_hosts, _verified_hosts_at
    _verified_hosts = {h.lower() for h in hosts if h}
    _verified_hosts_at = time.monotonic()


def cached_verified_hosts() -> Set[str]:
    return set(_verified_hosts)


def verified_hosts_stale() -> bool:
    return (time.monotonic() - _verified_hosts_at) >= _VERIFIED_TTL


def origin_host(origin: str) -> str:
    try:
        return (urlparse(origin).hostname or "").lower()
    except Exception:
        return ""


def normalize_lookup_host(raw: str) -> str:
    """Hostname from a by-host query. Apex, `{slug}.base`, or a creator CNAME."""
    v = (raw or "").strip().lower()
    v = v.replace("https://", "").replace("http://", "")
    v = v.split("/")[0].split(":")[0].strip().rstrip(".")
    if not v or len(v) > 253:
        raise TenantError("Tenant not found", status_code=404)
    return v


def platform_tenant_slug(host: str) -> Optional[str]:
    """`alice.builderpad.xyz` → `alice`. Apex / www / nested labels → None."""
    h = (host or "").strip().lower().rstrip(".")
    suffix = f".{TENANT_BASE_DOMAIN}"
    if h in {TENANT_BASE_DOMAIN, f"www.{TENANT_BASE_DOMAIN}"}:
        return None
    if not h.endswith(suffix):
        return None
    label = h[: -len(suffix)]
    if not label or "." in label:
        return None
    if label in RESERVED_SLUGS or not SLUG_RE.fullmatch(label):
        return None
    return label


def origin_is_platform_wildcard(origin: str) -> bool:
    """HTTPS `https://{label}.builderpad.xyz` — one label, not nested."""
    if not (origin or "").lower().startswith("https://"):
        return False
    host = origin_host(origin)
    suffix = f".{TENANT_BASE_DOMAIN}"
    if not host.endswith(suffix):
        return False
    label = host[: -len(suffix)]
    return bool(label) and "." not in label


def origin_is_verified_custom(origin: str) -> bool:
    if not (origin or "").lower().startswith("https://"):
        return False
    host = origin_host(origin)
    return bool(host) and host in _verified_hosts


def _strip_txt(data: str) -> str:
    v = (data or "").strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v.replace('" "', "").replace('"', "").strip()


async def _doh_answers(name: str, rtype: str) -> List[str]:
    urls = (
        f"https://dns.google/resolve?name={name}&type={rtype}",
        f"https://cloudflare-dns.com/dns-query?name={name}&type={rtype}",
    )
    headers = {"Accept": "application/dns-json"}
    last_err: Optional[Exception] = None
    async with httpx.AsyncClient(timeout=8.0) as client:
        for url in urls:
            try:
                res = await client.get(url, headers=headers)
                res.raise_for_status()
                answers = res.json().get("Answer") or []
                out: List[str] = []
                for a in answers:
                    data = str(a.get("data") or "").strip()
                    if data:
                        out.append(data.rstrip("."))
                return out
            except Exception as e:
                last_err = e
                continue
    if last_err:
        raise TenantError(
            "We could not look up DNS yet. Wait a minute and tap Check DNS again.",
            status_code=503,
        )
    return []


async def txt_values(fqdn: str) -> List[str]:
    return [_strip_txt(v) for v in await _doh_answers(fqdn, "TXT") if _strip_txt(v)]


async def cname_targets(host: str) -> List[str]:
    return [v.lower() for v in await _doh_answers(host, "CNAME")]


def cname_points_at_vercel(targets: Iterable[str]) -> bool:
    """True if the host CNAMEs at Vercel DNS (not a substring of some other name)."""
    want = CNAME_TARGET.lower().rstrip(".")
    for raw in targets:
        host = (raw or "").lower().rstrip(".")
        if not host:
            continue
        if host == want or _VERCEL_CNAME_RE.fullmatch(host):
            return True
    return False


def _vercel_creds() -> Optional[Dict[str, str]]:
    token = (os.getenv("BUILDERPAD_VERCEL_TOKEN") or "").strip()
    project = (os.getenv("BUILDERPAD_VERCEL_PROJECT_ID") or "").strip()
    if not token or not project:
        return None
    team = (os.getenv("BUILDERPAD_VERCEL_TEAM_ID") or "").strip()
    return {"token": token, "project": project, "team": team}


def vercel_configured() -> bool:
    return _vercel_creds() is not None


def _vercel_params(creds: Dict[str, str]) -> Dict[str, str]:
    return {"teamId": creds["team"]} if creds.get("team") else {}


async def vercel_attach_domain(host: str) -> Dict[str, Any]:
    """Add hostname to the Vite Vercel project. Missing env → skip (DNS still ours)."""
    creds = _vercel_creds()
    if not creds:
        return {"ok": True, "configured": False}
    headers = {"Authorization": f"Bearer {creds['token']}"}
    params = _vercel_params(creds)
    base = f"https://api.vercel.com/v10/projects/{creds['project']}/domains"
    async with httpx.AsyncClient(timeout=20.0) as client:
        added = await client.post(base, headers=headers, params=params, json={"name": host})
        if added.status_code not in (200, 201):
            body = added.json() if added.headers.get("content-type", "").startswith("application/json") else {}
            err = str((body.get("error") or {}).get("message") or added.text or "")
            already = added.status_code in (400, 409) and (
                "already" in err.lower() or "exists" in err.lower()
            )
            if not already:
                raise TenantError(
                    "The address was saved, but we could not attach it to hosting yet. Try Check DNS again.",
                    status_code=502,
                )
        verify = await client.post(
            f"https://api.vercel.com/v9/projects/{creds['project']}/domains/{host}/verify",
            headers=headers,
            params=params,
        )
        verified = False
        extra: List[Dict[str, str]] = []
        if verify.status_code in (200, 201):
            payload = verify.json() if verify.headers.get("content-type", "").startswith("application/json") else {}
            verified = bool(payload.get("verified", True))
            for row in payload.get("verification") or []:
                extra.append({
                    "type": str(row.get("type") or "TXT"),
                    "domain": str(row.get("domain") or ""),
                    "value": str(row.get("value") or ""),
                })
        return {"ok": True, "configured": True, "verified": verified, "extra": extra}


async def vercel_detach_domain(host: str) -> None:
    creds = _vercel_creds()
    if not creds or not host:
        return
    headers = {"Authorization": f"Bearer {creds['token']}"}
    params = _vercel_params(creds)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.delete(
                f"https://api.vercel.com/v9/projects/{creds['project']}/domains/{host}",
                headers=headers,
                params=params,
            )
    except Exception:
        return


async def assert_dns_ready(host: str, token: str) -> None:
    txts = await txt_values(txt_fqdn(host))
    if token not in txts:
        raise TenantError(
            "We don't see the TXT record yet. In Advanced DNS, add it exactly as shown, "
            "save, then wait a few minutes. Some providers use the short name "
            f"({dns_short_names(host)['txt_short']})."
        )
    targets = await cname_targets(host)
    if not cname_points_at_vercel(targets):
        raise TenantError(
            "TXT looks good. Now add the CNAME so the address actually opens. "
            f"Name {dns_short_names(host)['cname_short']} → {CNAME_TARGET}. "
            "If you use Cloudflare, set the cloud to DNS only (grey)."
        )
