"""Import the UR test signer wallet into a Privy user via the REST API.

Temporary dev/testing helper — gated by ENABLE_UR_TEST_WALLET_IMPORT=1.

Key resolution priority (External Wallet Access mode):

  1. UR_TEST_OWNER_PRIVKEY_TESTNET / _MAINNET — the URID-owner key
     (the address UR minted the URID + test USDC + USD24 to). This is
     what the user's Privy embedded wallet should hold so they can sign
     7702 + Ambire batches against the contract that whitelists their
     URID.
  2. UR_API_SIGNER_PRIVKEY_TESTNET / _MAINNET — fallback (legacy testnet
     setup where API signer and URID owner were the same address).

For Managed Custody mode, this whole import flow is unused — the user's
Privy wallet has its own auto-generated key and never holds the URID.

Requires PRIVY_APP_SECRET on the backend (Dashboard → Settings → Basics).
"""
from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx
from eth_account import Account
from pyhpke import AEADId, CipherSuite, KDFId, KEMId

import ur_api

logger = logging.getLogger(__name__)

PRIVY_API_BASE = "https://api.privy.io"
PRIVY_APP_ID = os.getenv("PRIVY_APP_ID", "").strip()
PRIVY_APP_SECRET = os.getenv("PRIVY_APP_SECRET", "").strip()


class PrivyImportError(RuntimeError):
    """Raised when Privy wallet import fails."""


def is_ur_test_wallet_import_enabled() -> bool:
    return os.getenv("ENABLE_UR_TEST_WALLET_IMPORT", "").strip() == "1"


# --------------------------------------------------------------------------- #
# Multi-identity test registry
#
# The dev/QA flow used to assume a SINGLE test identity (one Privy DID, one
# URID-owner key, one URID). To drive more than one device/URID through the
# same plumbing (e.g. a second self-custody testnet URID) we now support N
# identities, configured via indexed env vars (no committed DID defaults):
#
#   slot 1 (legacy, no suffix):
#     UR_TEST_PRIVY_USER_ID
#     UR_TEST_OWNER_PRIVKEY_<ENV>      (falls back to UR_API_SIGNER for legacy)
#     UR_TEST_URID
#   slot 2..N:
#     UR_TEST_PRIVY_USER_ID_<n>
#     UR_TEST_OWNER_PRIVKEY_<ENV>_<n>
#     UR_TEST_URID_<n>
#
# Slots 2..N are discovered by the presence of UR_TEST_PRIVY_USER_ID_<n>.
# Everything below is keyed by the authenticated Privy user_id so each device
# imports ITS OWN URID-owner key and auto-links to ITS OWN URID — a user can
# never be served another identity's key/URID.
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class UrTestIdentity:
    """One configured dev/QA identity (Privy DID ↔ URID-owner key ↔ URID)."""

    privy_user_id: str
    owner_pk: Optional[str]
    owner_address: Optional[str]
    urid: Optional[str]
    source_var: str


def _test_identity_suffixes() -> List[str]:
    """Env suffixes for every configured test identity.

    ``""`` is the legacy slot-1; ``_2``, ``_3``, … are discovered by the
    presence of ``UR_TEST_PRIVY_USER_ID_<n>``.
    """
    suffixes = [""]
    n = 2
    while (os.getenv(f"UR_TEST_PRIVY_USER_ID_{n}") or "").strip():
        suffixes.append(f"_{n}")
        n += 1
    return suffixes


def _identity_for_suffix(sfx: str) -> Optional[UrTestIdentity]:
    env_suffix = ur_api.UR_ENV.upper()
    did = (os.getenv(f"UR_TEST_PRIVY_USER_ID{sfx}") or "").strip()
    if not did:
        return None

    owner_var = f"UR_TEST_OWNER_PRIVKEY_{env_suffix}{sfx}"
    owner_pk = (os.getenv(owner_var) or "").strip()
    owner_addr: Optional[str] = None
    if owner_pk:
        try:
            owner_addr = Account.from_key(owner_pk).address
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s set but invalid: %s", owner_var, exc)
            owner_pk = ""

    # Legacy slot-1 ONLY: fall back to the API-signer key (old testnet setup
    # where the partner signer and the URID owner were the same address). New
    # slots must configure their own owner key explicitly.
    if not owner_pk and sfx == "" and ur_api.UR_SIGNER_PK and ur_api.UR_SIGNER_ADDRESS:
        owner_pk = ur_api.UR_SIGNER_PK
        owner_addr = ur_api.UR_SIGNER_ADDRESS
        owner_var = f"UR_API_SIGNER_PRIVKEY_{env_suffix}"

    urid = (os.getenv(f"UR_TEST_URID{sfx}") or "").strip() or None
    return UrTestIdentity(
        privy_user_id=did,
        owner_pk=owner_pk or None,
        owner_address=owner_addr,
        urid=urid,
        source_var=owner_var,
    )


def get_ur_test_identities() -> List[UrTestIdentity]:
    """All configured dev/QA identities (slot 1 + any slot 2..N)."""
    out: List[UrTestIdentity] = []
    for sfx in _test_identity_suffixes():
        ident = _identity_for_suffix(sfx)
        if ident:
            out.append(ident)
    return out


def get_ur_test_identity(privy_user_id: str) -> Optional[UrTestIdentity]:
    """The identity matching this Privy user, or None."""
    if not privy_user_id:
        return None
    for ident in get_ur_test_identities():
        if ident.privy_user_id == privy_user_id:
            return ident
    return None


def get_ur_test_privy_user_id() -> str:
    """Back-compat: the slot-1 (primary) test DID, used for error messages."""
    ident = _identity_for_suffix("")
    return ident.privy_user_id if ident else ""


def get_ur_test_privy_user_ids() -> set[str]:
    return {i.privy_user_id for i in get_ur_test_identities()}


def is_ur_test_privy_user(privy_user_id: str) -> bool:
    return bool(privy_user_id) and privy_user_id in get_ur_test_privy_user_ids()


def get_ur_test_urid(privy_user_id: str) -> Optional[str]:
    """The URID this test user should auto-link to, or None."""
    ident = get_ur_test_identity(privy_user_id)
    return ident.urid if ident else None


def _resolve_test_wallet_key(
    privy_user_id: str,
) -> Tuple[Optional[str], Optional[str], str]:
    """Return ``(private_key, address, source_var)`` for the wallet to import
    for a SPECIFIC test user. Scoped per-user so each device imports its own
    URID-owner key (never another identity's)."""
    ident = get_ur_test_identity(privy_user_id)
    if ident is None:
        # Unknown user — surface the slot-1 owner var name for the error path.
        return None, None, f"UR_TEST_OWNER_PRIVKEY_{ur_api.UR_ENV.upper()}"
    return ident.owner_pk, ident.owner_address, ident.source_var


def get_ur_test_wallet_address(privy_user_id: str) -> Optional[str]:
    _, address, _ = _resolve_test_wallet_key(privy_user_id)
    return address


def fetch_privy_user(privy_user_id: str) -> Dict[str, Any]:
    """Fetch a Privy user record via the server-side REST API.

    Raises ``PrivyImportError`` on transport/auth failure.
    """
    if not privy_user_id:
        raise PrivyImportError("privy_user_id is required")
    headers = _privy_headers()
    try:
        with httpx.Client(base_url=PRIVY_API_BASE, timeout=15.0) as client:
            resp = client.get(f"/v1/users/{privy_user_id}", headers=headers)
    except Exception as exc:  # noqa: BLE001
        raise PrivyImportError(f"Privy user fetch failed: {exc}") from exc
    if resp.status_code >= 400:
        raise PrivyImportError(
            f"Privy user fetch HTTP {resp.status_code}: {resp.text[:200]}"
        )
    data = resp.json() if resp.content else {}
    if not isinstance(data, dict):
        raise PrivyImportError(f"Privy user fetch returned non-object: {data!r}")
    return data


def extract_email_from_privy_user(data: Dict[str, Any]) -> Optional[str]:
    """Best-effort email from a Privy user payload (email login or OAuth)."""
    top = data.get("email")
    if isinstance(top, str) and "@" in top:
        return top.strip().lower()

    linked_accounts = data.get("linked_accounts") or []
    for acct in linked_accounts:
        if not isinstance(acct, dict):
            continue
        atype = (acct.get("type") or "").lower()
        if atype == "email":
            addr = acct.get("address")
            if isinstance(addr, str) and "@" in addr:
                return addr.strip().lower()
        if atype.endswith("_oauth"):
            for key in ("email", "emailAddress", "userEmail"):
                val = acct.get(key)
                if isinstance(val, str) and "@" in val:
                    return val.strip().lower()

    for acct in linked_accounts:
        if not isinstance(acct, dict):
            continue
        for key in ("email", "emailAddress", "userEmail"):
            val = acct.get(key)
            if isinstance(val, str) and "@" in val:
                return val.strip().lower()
    return None


def fetch_privy_user_email(
    privy_user_id: str, *, raise_on_error: bool = False
) -> Optional[str]:
    """Return the user's email from Privy, or None if unavailable."""
    if not privy_user_id:
        return None
    try:
        data = fetch_privy_user(privy_user_id)
    except PrivyImportError as exc:
        if raise_on_error:
            raise
        logger.warning(
            "Privy email lookup failed for %s: %s", privy_user_id[:24], exc
        )
        return None
    return extract_email_from_privy_user(data)


def fetch_privy_user_eth_addresses(privy_user_id: str) -> set[str]:
    """Return the lowercased Ethereum wallet addresses linked to a Privy user.

    Uses the Privy REST API server-side (app-secret auth). This is the
    authoritative source for "which wallets does this authenticated user
    control" — used to prove URID ownership before binding a link, so a user
    can never claim a URID owned by someone else's wallet.

    Raises ``PrivyImportError`` on transport/auth failure so callers can
    *fail closed* (refuse the bind) rather than silently trusting the request.
    """
    if not privy_user_id:
        return set()
    data = fetch_privy_user(privy_user_id)
    out: set[str] = set()
    for acct in (data.get("linked_accounts") or []):
        if not isinstance(acct, dict):
            continue
        addr = acct.get("address")
        chain = (acct.get("chain_type") or "").lower()
        atype = (acct.get("type") or "").lower()
        # Keep only EVM wallet addresses (embedded + external both surface as
        # wallet-type accounts with chain_type "ethereum").
        if (
            isinstance(addr, str)
            and addr.startswith("0x")
            and len(addr) == 42
            and ("wallet" in atype or chain == "ethereum")
        ):
            out.add(addr.lower())
    return out


def embedded_hd_index(data: Dict[str, Any], address: str) -> Optional[int]:
    """Index of an embedded, non-imported EVM wallet, or None.

    Imported keys (UR test signer) and external wallets are not an HD slot.
    """
    want = (address or "").strip().lower()
    if not want.startswith("0x") or len(want) != 42:
        return None
    for acct in data.get("linked_accounts") or []:
        if not isinstance(acct, dict):
            continue
        addr = acct.get("address")
        if not isinstance(addr, str) or addr.strip().lower() != want:
            continue
        if acct.get("imported") is True:
            return None
        chain = str(acct.get("chain_type") or "").lower()
        atype = str(acct.get("type") or "").lower()
        if chain == "solana" or "solana" in atype:
            return None
        client = str(acct.get("wallet_client_type") or acct.get("wallet_client") or "").lower()
        connector = str(acct.get("connector_type") or "").lower()
        if not (client == "privy" or connector == "embedded" or "embedded" in connector):
            return None
        raw = acct.get("wallet_index")
        if raw is None:
            raw = acct.get("walletIndex")
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None
    return None


def classify_privy_eth_wallets(data: Dict[str, Any]) -> Tuple[set[str], set[str]]:
    """Split a Privy user payload into (embedded, external) EVM addresses.

    Solana / Phantom accounts are ignored — Hyperliquid builders are EVM only.
    An address listed as both (should not happen) counts as embedded.
    """
    embedded: set[str] = set()
    external: set[str] = set()
    for acct in data.get("linked_accounts") or []:
        if not isinstance(acct, dict):
            continue
        addr = acct.get("address")
        if not isinstance(addr, str) or not addr.startswith("0x") or len(addr) != 42:
            continue
        chain = str(acct.get("chain_type") or "").lower()
        atype = str(acct.get("type") or "").lower()
        if chain == "solana" or "solana" in atype:
            continue
        if chain and chain not in ("ethereum", "evm"):
            continue
        client = str(
            acct.get("wallet_client_type") or acct.get("wallet_client") or ""
        ).lower()
        connector = str(acct.get("connector_type") or "").lower()
        addr_l = addr.lower()
        if (
            client == "privy"
            or connector == "embedded"
            or "embedded" in connector
        ):
            embedded.add(addr_l)
        elif client == "phantom":
            continue
        elif "wallet" in atype or chain in ("ethereum", "evm", ""):
            external.add(addr_l)
    external -= embedded
    return embedded, external


def user_owns_eth_address(privy_user_id: str, address: str) -> bool:
    """True iff `address` is one of the Privy user's linked ETH wallets.

    Propagates ``PrivyImportError`` from the lookup so the caller decides how
    to handle an inconclusive result (we fail closed at the call site).
    """
    if not address or not isinstance(address, str):
        return False
    return address.strip().lower() in fetch_privy_user_eth_addresses(privy_user_id)


def _privy_headers() -> Dict[str, str]:
    if not PRIVY_APP_SECRET:
        raise PrivyImportError(
            "PRIVY_APP_SECRET is not set. Add it from the Privy dashboard (Settings → Basics)."
        )
    token = base64.b64encode(f"{PRIVY_APP_ID}:{PRIVY_APP_SECRET}".encode()).decode()
    return {
        "Authorization": f"Basic {token}",
        "Content-Type": "application/json",
        "privy-app-id": PRIVY_APP_ID,
    }


def _encrypt_private_key_hpke(
    encryption_public_key_b64: str, private_key_hex: str
) -> tuple[str, str]:
    suite = CipherSuite.new(
        KEMId.DHKEM_P256_HKDF_SHA256,
        KDFId.HKDF_SHA256,
        AEADId.CHACHA20_POLY1305,
    )
    public_key = suite.kem.deserialize_public_key(
        base64.b64decode(encryption_public_key_b64)
    )
    hex_key = private_key_hex.strip().removeprefix("0x")
    plaintext = bytes.fromhex(hex_key)
    encapsulated_key, sender = suite.create_sender_context(public_key)
    ciphertext = sender.seal(plaintext)
    return (
        base64.b64encode(encapsulated_key).decode(),
        base64.b64encode(ciphertext).decode(),
    )


def import_ur_test_wallet_for_user(*, privy_user_id: str) -> Dict[str, Any]:
    """Import UR test wallet (URID-owner key) and assign it to `privy_user_id`.

    Idempotent on address.
    """
    if not is_ur_test_wallet_import_enabled():
        raise PrivyImportError(
            "UR test wallet import is disabled. Set ENABLE_UR_TEST_WALLET_IMPORT=1."
        )
    if not is_ur_test_privy_user(privy_user_id):
        ids = ", ".join(sorted(get_ur_test_privy_user_ids()))
        hint = f" ({ids})" if ids else " (set UR_TEST_PRIVY_USER_ID)"
        raise PrivyImportError(
            f"UR test wallet import is restricted to a configured QA Privy user{hint}."
        )

    private_key, address, source_var = _resolve_test_wallet_key(privy_user_id)
    if not private_key or not address:
        raise PrivyImportError(
            f"No test wallet key configured for {privy_user_id}. Set {source_var} "
            f"in .env.local."
        )
    logger.info("Importing UR test wallet %s (source=%s)", address, source_var)

    headers = _privy_headers()

    with httpx.Client(base_url=PRIVY_API_BASE, timeout=30.0) as client:
        init_resp = client.post(
            "/v1/wallets/import/init",
            headers=headers,
            json={
                "address": address,
                "chain_type": "ethereum",
                "entropy_type": "private-key",
                "encryption_type": "HPKE",
            },
        )
        if init_resp.status_code >= 400:
            body = init_resp.text[:500]
            # Wallet may already exist globally — still attempt submit with fresh HPKE.
            if init_resp.status_code not in (409, 422):
                logger.warning("Privy import/init failed (%s): %s", init_resp.status_code, body)
                raise PrivyImportError(f"Privy import init failed: {body}")

        init_data = init_resp.json() if init_resp.content else {}
        enc_pub = init_data.get("encryption_public_key")
        if not enc_pub:
            raise PrivyImportError("Privy import init did not return encryption_public_key")

        encapsulated_key, ciphertext = _encrypt_private_key_hpke(
            enc_pub, private_key
        )

        submit_resp = client.post(
            "/v1/wallets/import/submit",
            headers=headers,
            json={
                "wallet": {
                    "address": address,
                    "chain_type": "ethereum",
                    "entropy_type": "private-key",
                    "encryption_type": "HPKE",
                    "ciphertext": ciphertext,
                    "encapsulated_key": encapsulated_key,
                },
                "owner": {"user_id": privy_user_id},
            },
        )

        if submit_resp.status_code >= 400:
            body = submit_resp.text[:500]
            # Already imported for this user / address — treat as success.
            if submit_resp.status_code in (409, 422) and "already" in body.lower():
                logger.info("UR test wallet already imported for %s", privy_user_id)
                return {
                    "address": address,
                    "already_imported": True,
                    "wallet": None,
                }
            logger.warning("Privy import/submit failed (%s): %s", submit_resp.status_code, body)
            raise PrivyImportError(f"Privy import submit failed: {body}")

        wallet = submit_resp.json()
        return {
            "address": address,
            "already_imported": False,
            "wallet_id": wallet.get("id"),
            "wallet": wallet,
        }
