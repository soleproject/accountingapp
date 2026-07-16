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


def create_link_token(user_id: str, client_name: str = "Axiom Ledger", webhook_url: str | None = None,
                      access_token_for_update: str | None = None) -> str:
    """Create a Plaid Link token. When `access_token_for_update` is provided,
    the token is generated in **update mode** for that existing Item — this
    re-authenticates without changing the item_id and requests the extended
    730-day transaction history (Plaid will then backfill older txns).
    """
    kwargs = {
        "client_name": client_name,
        "country_codes": [CountryCode("US")],
        "language": "en",
        "user": LinkTokenCreateRequestUser(client_user_id=user_id),
        # Request the maximum 730 days of transaction history. Actual coverage
        # is capped by each institution (BofA/Chase/etc. all release ≥24 mo).
        "transactions": LinkTokenTransactions(days_requested=730),
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
    return {
        "transaction_id": t["transaction_id"],
        "account_id": t["account_id"],
        "date": t["date"].isoformat() if hasattr(t["date"], "isoformat") else str(t["date"]),
        "name": t.get("name") or t.get("merchant_name") or "",
        "merchant_name": t.get("merchant_name") or "",
        # Plaid returns positive for outflow; flip to accounting convention (negative = expense)
        "amount": -float(t["amount"]),
        "pending": bool(t.get("pending", False)),
        "category": list(t.get("category") or []),
        "personal_finance_category": (lambda pfc: {
            "primary": pfc.get("primary") if pfc else None,
            "detailed": pfc.get("detailed") if pfc else None,
            "confidence_level": pfc.get("confidence_level") if pfc else None,
        } if pfc else None)(t.get("personal_finance_category")),
        "iso_currency_code": t.get("iso_currency_code", "USD"),
    }
