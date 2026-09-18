"""Twitch Helix lookups for BuilderPad desk overlays.

App-token only (Client-ID + secret). We never use the creator's OAuth token.
Public GET /helix/streams is enough for live/offline. Cache aggressively —
the desk polls this every ~45s per open terminal.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Dict, Optional

import httpx

TWITCH_CLIENT_ID = (os.getenv("TWITCH_CLIENT_ID") or "").strip()
TWITCH_CLIENT_SECRET = (os.getenv("TWITCH_CLIENT_SECRET") or "").strip()
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
USERS_URL = "https://api.twitch.tv/helix/users"
STREAMS_URL = "https://api.twitch.tv/helix/streams"
STATUS_TTL_S = 45.0
LOGIN_TTL_S = 6 * 3600.0
TOKEN_SKEW_S = 60.0

_lock = asyncio.Lock()
_token: Optional[str] = None
_token_exp = 0.0
_status: Dict[str, tuple[float, Dict[str, Any]]] = {}
_logins: Dict[str, tuple[float, str]] = {}


def configured() -> bool:
    return bool(TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET)


async def stream_status(client: Optional[httpx.AsyncClient], login: str) -> Dict[str, Any]:
    """Return `{ live, title?, viewer_count? }`. `live` is None if Helix is unset or failed."""
    handle = (login or "").strip().lstrip("@").lower()
    if not handle:
        return {"live": False}
    if not configured() or client is None:
        return {"live": None}
    now = time.monotonic()
    hit = _status.get(handle)
    if hit and hit[0] > now:
        return hit[1]
    try:
        resp = await _helix_get(client, STREAMS_URL, {"user_login": handle})
        if resp is None:
            return {"live": None}
        rows = (resp.json() or {}).get("data") or []
        row = rows[0] if rows else None
        out: Dict[str, Any] = {"live": bool(row)}
        if row:
            title = str(row.get("title") or "").strip()
            if title:
                out["title"] = title[:140]
            viewers = row.get("viewer_count")
            if isinstance(viewers, int) and viewers >= 0:
                out["viewer_count"] = viewers
    except Exception:
        return {"live": None}
    _status[handle] = (now + STATUS_TTL_S, out)
    return out


async def login_for_user_id(client: Optional[httpx.AsyncClient], user_id: str) -> Optional[str]:
    """Resolve a Twitch numeric user id (Privy `subject`) to the public login."""
    uid = str(user_id or "").strip()
    if not uid or not uid.isdigit() or not configured() or client is None:
        return None
    now = time.monotonic()
    hit = _logins.get(uid)
    if hit and hit[0] > now:
        return hit[1] or None
    try:
        resp = await _helix_get(client, USERS_URL, {"id": uid})
        if resp is None:
            return None
        rows = (resp.json() or {}).get("data") or []
        login = str((rows[0] or {}).get("login") or "").strip().lstrip("@").lower() if rows else ""
        if not login:
            return None
        _logins[uid] = (now + LOGIN_TTL_S, login)
        return login
    except Exception:
        return None


async def _helix_get(
    client: httpx.AsyncClient, url: str, params: Dict[str, str]
) -> Optional[httpx.Response]:
    token = await _app_token(client)
    headers = {"Client-ID": TWITCH_CLIENT_ID, "Authorization": f"Bearer {token}"}
    resp = await client.get(url, params=params, headers=headers, timeout=8.0)
    if resp.status_code == 401:
        async with _lock:
            global _token, _token_exp
            _token = None
            _token_exp = 0.0
        token = await _app_token(client)
        headers = {"Client-ID": TWITCH_CLIENT_ID, "Authorization": f"Bearer {token}"}
        resp = await client.get(url, params=params, headers=headers, timeout=8.0)
    if not resp.is_success:
        return None
    return resp


async def _app_token(client: httpx.AsyncClient) -> str:
    global _token, _token_exp
    now = time.monotonic()
    if _token and _token_exp > now:
        return _token
    async with _lock:
        now = time.monotonic()
        if _token and _token_exp > now:
            return _token
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": TWITCH_CLIENT_ID,
                "client_secret": TWITCH_CLIENT_SECRET,
                "grant_type": "client_credentials",
            },
            timeout=8.0,
        )
        resp.raise_for_status()
        body = resp.json() or {}
        token = str(body.get("access_token") or "")
        if not token:
            raise RuntimeError("Twitch token missing")
        expires = float(body.get("expires_in") or 3600)
        _token = token
        _token_exp = now + max(60.0, expires - TOKEN_SKEW_S)
        return token
