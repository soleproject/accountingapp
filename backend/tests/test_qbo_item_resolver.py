"""Regression tests — QBO Item post-import resolver (Aug 21 2026).

The QBO migration pipeline runs `map_item` which stores QBO's account
IDs and Type enum, but never resolves them to local `*_account_id`s
or flips the internal `track_inventory` flag. Only the ongoing mirror
pull did that. Result: freshly-migrated QBO companies had inventory
items with `type='inventory'` yet `track_inventory=None`, making the
Inventory Management page look empty even though QBO tracked qty-on-
hand for those items. Sandbox 358d Craig's Landscaping: 4 real
inventory items (Pump, Rock Fountain, Sprinkler Heads, Sprinkler
Pipes) all silent on the Inventory page.

`resolve_item_accounts_and_tracking` is the new post-import resolver.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_account(cid, aid, qbo_id, name, _type,
                          detail_type=""):
    now = datetime.now(timezone.utc).isoformat()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "source": "qbo",
        "qbo_id": qbo_id, "name": name, "type": _type,
        "detail_type": detail_type, "active": True,
        "created_at": now, "updated_at": now,
    })


async def _cleanup(cid):
    for coll in (db.companies, db.accounts, db.items):
        await coll.delete_many({"company_id": cid})


def test_resolver_flips_track_inventory_and_resolves_accounts():
    """Freshly-migrated Inventory item has `item_type='Inventory'`,
    `track_qty_on_hand=True`, quantity + cost fields set, and QBO
    account refs — but `track_inventory=None` and no local account
    id resolution. The resolver must fix all four."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "InvRes Co"})
        await _seed_account(cid, "acct-inv-asset", "81",
                              "Inventory Asset", "asset",
                              detail_type="inventory")
        await _seed_account(cid, "acct-cogs", "80",
                              "Cost of Goods Sold", "cogs")
        await _seed_account(cid, "acct-sales", "79",
                              "Sales of Product Income", "revenue")
        now = datetime.now(timezone.utc).isoformat()
        await db.items.insert_one({
            "id": "qbo-item-pipes", "company_id": cid, "source": "qbo",
            "qbo_id": "17", "name": "Sprinkler Pipes",
            "type": "inventory", "item_type": "Inventory",
            "track_qty_on_hand": True,
            "quantity_on_hand": 31.0, "qty_on_hand": 31.0,
            "cost": 2.50, "price": 2.99,
            "asset_account_qbo_id": "81",
            "expense_account_qbo_id": "80",
            "income_account_qbo_id": "79",
            # These are missing at migration time:
            "track_inventory": None,
            "inventory_account_id": None,
            "cogs_account_id": None,
            "income_account_id": None,
            "created_at": now, "updated_at": now,
        })

        try:
            import qbo_service
            r = await qbo_service.resolve_item_accounts_and_tracking(cid)
            assert r["items_resolved"] == 1
            assert r["tracking_flipped"] == 1

            it = await db.items.find_one({"id": "qbo-item-pipes"})
            assert it["track_inventory"] is True
            assert it["inventory_account_id"] == "acct-inv-asset"
            assert it["inventory_account_name"] == "Inventory Asset"
            assert it["cogs_account_id"] == "acct-cogs"
            assert it["expense_account_id"] == "acct-cogs"
            assert it["income_account_id"] == "acct-sales"
            # cost_basis seeded from QBO PurchaseCost so the
            # Inventory Valuation report shows a starting value.
            assert abs(float(it["cost_basis"]) - 2.50) < 0.001
        finally:
            await _cleanup(cid)

    _run(go())


def test_resolver_skips_service_items():
    """Service items (non-inventory) must NOT get track_inventory
    flipped and their cost_basis must remain unset."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "SvcRes Co"})
        now = datetime.now(timezone.utc).isoformat()
        await db.items.insert_one({
            "id": "qbo-item-svc", "company_id": cid, "source": "qbo",
            "qbo_id": "1", "name": "Gardening",
            "type": "service", "item_type": "Service",
            "track_qty_on_hand": False,
            "cost": 0.0, "price": 50.0,
            "created_at": now, "updated_at": now,
        })

        try:
            import qbo_service
            r = await qbo_service.resolve_item_accounts_and_tracking(cid)
            assert r["tracking_flipped"] == 0
            it = await db.items.find_one({"id": "qbo-item-svc"})
            assert not it.get("track_inventory")
            assert not it.get("cost_basis")
        finally:
            await _cleanup(cid)

    _run(go())


def test_resolver_is_idempotent():
    """Running the resolver twice must not double-flip or overwrite
    an already-populated cost_basis (weighted-average maintained by
    inventory movements over time)."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "Idem Co"})
        await _seed_account(cid, "acct-inv-idem", "81",
                              "Inventory Asset", "asset",
                              detail_type="inventory")
        now = datetime.now(timezone.utc).isoformat()
        await db.items.insert_one({
            "id": "qbo-item-idem", "company_id": cid, "source": "qbo",
            "qbo_id": "5", "name": "Rock Fountain",
            "type": "inventory", "item_type": "Inventory",
            "track_qty_on_hand": True, "quantity_on_hand": 2.0,
            "cost": 125.0, "asset_account_qbo_id": "81",
            "cost_basis": 130.0,  # simulate a movement having updated it
            "created_at": now, "updated_at": now,
        })

        try:
            import qbo_service
            r1 = await qbo_service.resolve_item_accounts_and_tracking(cid)
            r2 = await qbo_service.resolve_item_accounts_and_tracking(cid)
            it = await db.items.find_one({"id": "qbo-item-idem"})
            # cost_basis is not overwritten — respects existing value
            assert abs(float(it["cost_basis"]) - 130.0) < 0.001
            assert it["track_inventory"] is True
            # Second run should be a full no-op.
            assert r2["items_resolved"] == 0
            assert r2["tracking_flipped"] == 0
        finally:
            await _cleanup(cid)

    _run(go())
