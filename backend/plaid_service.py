"""Plaid Sandbox client and helpers."""
from __future__ import annotations
import os
from datetime import datetime, timedelta, timezone
import plaid
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode

_ENV = os.environ.get("PLAID_ENV", "sandbox").lower()
_HOST = {
    "sandbox": plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}.get(_ENV, plaid.Environment.Sandbox)

_config = plaid.Configuration(
    host=_HOST,
    api_key={
        "clientId": os.environ["PLAID_CLIENT_ID"],
        "secret": os.environ["PLAID_SECRET"],
        "plaidVersion": "2020-09-14",
    },
)
_client = plaid_api.PlaidApi(plaid.ApiClient(_config))


def token_from_item(item: dict | None) -> str | None:
    """Return the decrypted Plaid access token from a `plaid_items` doc.
    Callers pass a raw Mongo doc (potentially with an `enc_v1:` cipher
    on `access_token`); we return the plaintext token ready to hand to
    the Plaid SDK. Safe on None / missing key."""
    if not item:
        return None
    tok = item.get("access_token")
    if not tok:
        return None
    from crypto_service import decrypt
    return decrypt(tok)


def create_link_token(user_id: str, client_name: str = "SmartBooks", webhook_url: str | None = None,
                      access_token_for_update: str | None = None,
                      days_requested: int = 730) -> str:
    """Create a Plaid Link token. When `access_token_for_update` is provided,
    the token is generated in **update mode** for that existing Item — this
    re-authenticates without changing the item_id.

    `days_requested` (0–730) — how many days of transaction history to
    ask Plaid to backfill during the initial sync. Passing a smaller
    number when the user only wants "this year" cuts API cost and
    means Plaid returns less data. Actual coverage per institution
    can still be less if the bank doesn't retain that much history.
    """
    # Plaid rejects days_requested < 1 or > 730; clamp defensively.
    days_requested = max(1, min(730, int(days_requested)))
    kwargs = {
        "client_name": client_name,
        "country_codes": [CountryCode("US")],
        "language": "en",
        "user": LinkTokenCreateRequestUser(client_user_id=user_id),
        "transactions": LinkTokenTransactions(days_requested=days_requested),
    }
    if access_token_for_update:
        # Update mode: pass access_token, omit products.
        kwargs["access_token"] = access_token_for_update
    else:
        kwargs["products"] = [Products("transactions")]
    if webhook_url:
        kwargs["webhook"] = webhook_url
    req = LinkTokenCreateRequest(**kwargs)
    resp = _client.link_token_create(req)
    return resp["link_token"]


def exchange_public_token(public_token: str) -> dict:
    resp = _client.item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=public_token)
    )
    return {"access_token": resp["access_token"], "item_id": resp["item_id"]}


def get_institution_name(access_token: str) -> str | None:
    """Look up the human-readable institution name for a linked item.

    Used at link time so each Plaid account can be created as its own
    CoA row named `{institution} {subtype} ···{last4}` (Rocketsuite-style).
    Falls back to None on any Plaid API error — the resolver then names
    the account off the plaid `official_name` alone.
    """
    try:
        from plaid.model.item_get_request import ItemGetRequest
        from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
        from plaid.model.country_code import CountryCode
        it = _client.item_get(ItemGetRequest(access_token=access_token))
        inst_id = it["item"].get("institution_id")
        if not inst_id:
            return None
        inst = _client.institutions_get_by_id(InstitutionsGetByIdRequest(
            institution_id=inst_id, country_codes=[CountryCode("US")],
        ))
        return inst["institution"].get("name")
    except Exception:  # noqa: BLE001 — non-fatal
        return None


def get_accounts(access_token: str) -> list[dict]:
    resp = _client.accounts_get(AccountsGetRequest(access_token=access_token))
    result = []
    for a in resp["accounts"]:
        result.append({
            "account_id": a["account_id"],
            "name": a.get("name"),
            "official_name": a.get("official_name"),
            "type": str(a.get("type")),
            "subtype": str(a.get("subtype")) if a.get("subtype") else "",
            "mask": a.get("mask"),
            "balance_current": a["balances"].get("current"),
            "balance_available": a["balances"].get("available"),
            "currency": a["balances"].get("iso_currency_code", "USD"),
        })
    return result


def sync_transactions(access_token: str, cursor: str | None = None) -> dict:
    """Return {added, modified, removed, next_cursor, accounts}.

    `accounts` is the fresh balance snapshot that Plaid ships back with every
    `/transactions/sync` call — free of charge, no separate `/accounts/balance/get`
    hit. We capture it so the UI can show "Plaid reported balance $X at
    <timestamp>" without paying for a real-time balance refresh.
    """
    all_added, all_modified, all_removed = [], [], []
    current = cursor
    has_more = True
    last_accounts = []
    while has_more:
        kwargs = {"access_token": access_token}
        if current:
            kwargs["cursor"] = current
        resp = _client.transactions_sync(TransactionsSyncRequest(**kwargs))
        all_added.extend(resp["added"])
        all_modified.extend(resp["modified"])
        all_removed.extend(resp["removed"])
        # Balance snapshot from the last page reflects the most recent state.
        last_accounts = list(resp.get("accounts") or [])
        current = resp["next_cursor"]
        has_more = resp["has_more"]
    return {
        "added": [_serialize_txn(t) for t in all_added],
        "modified": [_serialize_txn(t) for t in all_modified],
        "removed": [{"transaction_id": t["transaction_id"]} for t in all_removed],
        "next_cursor": current,
        "accounts": [_serialize_account_balances(a) for a in last_accounts],
    }


def _serialize_account_balances(a) -> dict:
    """Extract only the balance fields — everything else (name, mask, etc.)
    is already stored on `plaid_items.accounts` at Link time and doesn't
    change between syncs.
    """
    bals = a.get("balances") or {}
    return {
        "account_id": a["account_id"],
        "balance_current":   bals.get("current"),
        "balance_available": bals.get("available"),
        "balance_limit":     bals.get("limit"),
        "iso_currency_code": bals.get("iso_currency_code", "USD"),
    }


def get_accounts_balance_snapshot(access_token: str) -> list[dict]:
    """Free `/accounts/get` (via `get_accounts`) — returns Plaid's cached account
    balances (last refreshed by Plaid, typically < 4h old). Used as the
    balance-snapshot fallback when a `/transactions/sync` call returns an empty
    `accounts` array (which Plaid does whenever the cursor is at end-of-history).

    Explicitly NOT `/accounts/balance/get` — that endpoint forces a live pull
    from the bank and is billed per call.
    """
    return [
        {"account_id": a["account_id"],
         "balance_current": a.get("balance_current"),
         "balance_available": a.get("balance_available"),
         "balance_limit": None,
         "iso_currency_code": a.get("currency", "USD")}
        for a in get_accounts(access_token)
    ]


def _serialize_txn(t) -> dict:
    """Serialize a Plaid `Transaction` object to the flat dict we
    persist. We keep every enrichment field Plaid offers because
    downstream categorization/auditor/contact-resolver needs them:

    - `original_description`: the RAW bank memo before Plaid's cleaning.
      This is the only place ACH-driven fields like `INDN:<PERSON>` and
      `CO ID:<COMPANY>` survive — the cleaned `name` collapses "VENMO
      PAYMENT INDN:JANE DOE CO ID:VENMOACHXXX PPD" down to just "Venmo",
      throwing away who was actually paid.
    - `counterparties[]`: Plaid Transactions Enrichment v2 — an array of
      named participants ({name, type, entity_id, confidence_level,
      logo_url, website}). For P2P apps the SECOND counterparty (after
      the payment_app itself) is typically the real recipient, so this
      is the cleanest source of "who did we Venmo?".
    - `merchant_entity_id`: stable Plaid merchant ID for cross-tenant
      dedup. When two tenants both hit a McDonald's franchise the
      entity_id joins them even if the store names differ.
    - `logo_url` / `website` / `location`: enrichment; useful for the UI
      and the contact-directory sync.
    - `check_number` / `transaction_code`: hard clues for check images
      and ACH-vs-wire-vs-debit routing decisions.
    - `authorized_date`: auth-time date (may differ from posted date;
      used for cash-basis reporting).
    """
    def _cp_to_dict(c):
        if c is None:
            return None
        return {
            "name":              c.get("name"),
            "type":              c.get("type"),
            "entity_id":         c.get("entity_id"),
            "confidence_level":  c.get("confidence_level"),
            "logo_url":          c.get("logo_url"),
            "website":           c.get("website"),
            "phone_number":      c.get("phone_number"),
        }
    loc = t.get("location") or {}
    return {
        "transaction_id":  t["transaction_id"],
        "account_id":      t["account_id"],
        "date":            t["date"].isoformat() if hasattr(t["date"], "isoformat") else str(t["date"]),
        "name":            t.get("name") or t.get("merchant_name") or "",
        "merchant_name":   t.get("merchant_name") or "",
        # Raw memo — pre-enrichment, preserves ACH INDN/CO fields.
        "original_description": t.get("original_description") or "",
        # Plaid Transactions Enrichment v2 named counterparties.
        "counterparties": [
            _cp_to_dict(c) for c in (t.get("counterparties") or [])
            if c and c.get("name")
        ],
        # Stable merchant identity for cross-tenant learning.
        "merchant_entity_id": t.get("merchant_entity_id"),
        "logo_url":     t.get("logo_url"),
        "website":      t.get("website"),
        "check_number":     t.get("check_number"),
        "transaction_code": t.get("transaction_code"),
        # Plaid returns positive for outflow; flip to accounting convention (negative = expense)
        "amount":            -float(t["amount"]),
        "pending":           bool(t.get("pending", False)),
        "authorized_date":   (t.get("authorized_date").isoformat()
                              if hasattr(t.get("authorized_date"), "isoformat")
                              else t.get("authorized_date")),
        "category":          list(t.get("category") or []),
        "personal_finance_category": (lambda pfc: {
            "primary": pfc.get("primary") if pfc else None,
            "detailed": pfc.get("detailed") if pfc else None,
            "confidence_level": pfc.get("confidence_level") if pfc else None,
        } if pfc else None)(t.get("personal_finance_category")),
        "location": {
            "address":     loc.get("address"),
            "city":        loc.get("city"),
            "region":      loc.get("region"),
            "postal_code": loc.get("postal_code"),
            "country":     loc.get("country"),
            "lat":         loc.get("lat"),
            "lon":         loc.get("lon"),
        } if loc else None,
        "iso_currency_code": t.get("iso_currency_code", "USD"),
    }
