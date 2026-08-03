"""Contact dedup — collapse duplicate contacts within each company down to
one canonical doc per normalized_name, repointing every foreign key that
references the loser id to the winner id.

BACKGROUND (Feb 2026):
    Before the contact race fix, concurrent Plaid syncs / manual creates
    could bypass the unique index for milliseconds and land duplicate
    contacts. The user's prod DB had 7,157 contacts across 8 companies —
    almost certainly bloat from that race, since 7157/8 = ~895 avg
    per company (implausible for an early-stage accounting SaaS).

STRATEGY:
    1. Group by (company_id, normalized_name)
    2. Sort each group by created_at ASC; oldest = keeper
    3. For every loser id in the group:
         - Update all `transactions`, `invoices`, `bills`, `payments`,
           `receipts`, `communications`, `contact_learning_cache`
           where contact_id = loser → set contact_id = keeper
         - Delete the loser contact doc
    4. Print per-company + grand-total stats

USAGE:
    # DRY RUN (default) — prints what would change, touches nothing:
    python -m tests.dedupe_contacts

    # LIVE — actually repoints FKs and deletes losers:
    python -m tests.dedupe_contacts --apply

    # Single company only (safer for staged rollout):
    python -m tests.dedupe_contacts --company=<cid>
    python -m tests.dedupe_contacts --company=<cid> --apply

SAFETY:
    Runs on the current process's `MONGO_URL` — so if you point it at
    prod, it hits prod. Take a fresh Atlas snapshot before --apply.
"""
from __future__ import annotations
import argparse
import asyncio
import sys
from collections import defaultdict

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from contact_resolver import normalize_contact_name  # noqa: E402


# Collections that carry a `contact_id` foreign key and therefore need to
# be repointed when we merge duplicates. Ordered from largest to smallest
# so progress logs make sense on a big DB.
FK_COLLECTIONS = [
    "transactions",
    "invoices",
    "bills",
    "payments",
    "receipts",
    "communications",
    "contact_learning_cache",
    "rule_candidates",   # may reference contact_id in matched examples
    "rules",             # may reference contact_id in conditions
]


async def _find_dupes(company_filter: str | None) -> dict:
    """Returns {(cid, normalized_name): [contact_docs sorted by created_at ASC]}."""
    q = {}
    if company_filter:
        q["company_id"] = company_filter
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    async for c in db.contacts.find(q):
        key = c.get("normalized_name") or normalize_contact_name(c.get("name") or "")
        if not key:
            continue  # skip nameless contacts — they can't dedupe
        groups[(c["company_id"], key)].append(c)
    # Only keep groups with ≥ 2 docs
    return {k: sorted(v, key=lambda d: d.get("created_at") or "")
            for k, v in groups.items() if len(v) >= 2}


async def _count_fks(loser_ids: set[str], company_id: str) -> dict[str, int]:
    """Count how many docs in each FK collection reference the loser ids."""
    counts: dict[str, int] = {}
    if not loser_ids:
        return counts
    ids_list = list(loser_ids)
    for coll in FK_COLLECTIONS:
        n = await db[coll].count_documents(
            {"company_id": company_id, "contact_id": {"$in": ids_list}},
        )
        counts[coll] = n
    return counts


async def _repoint_and_delete(
    winner_id: str, loser_ids: set[str], company_id: str,
) -> dict[str, int]:
    """LIVE mode only. Repoint every FK from loser → winner, then delete losers."""
    results: dict[str, int] = {}
    ids_list = list(loser_ids)
    for coll in FK_COLLECTIONS:
        r = await db[coll].update_many(
            {"company_id": company_id, "contact_id": {"$in": ids_list}},
            {"$set": {"contact_id": winner_id}},
        )
        results[coll] = r.modified_count
    # Delete the losers themselves
    r = await db.contacts.delete_many(
        {"company_id": company_id, "id": {"$in": ids_list}},
    )
    results["contacts_deleted"] = r.deleted_count
    return results


async def main(apply: bool, company_filter: str | None) -> int:
    print("=" * 70)
    print(f"CONTACT DEDUP — {'LIVE MODE' if apply else 'DRY RUN'}")
    if company_filter:
        print(f"  Company filter: {company_filter}")
    print("=" * 70)

    groups = await _find_dupes(company_filter)
    if not groups:
        print("\nNo duplicate contacts found. Nothing to do.")
        return 0

    per_company: dict[str, dict] = defaultdict(lambda: {"groups": 0, "losers": 0, "fk_reps": 0})
    grand_totals = {"groups": 0, "losers": 0, "fk_repointed": defaultdict(int)}

    # Sort groups by (company_id, dupe_count DESC) so the biggest groups print first
    sorted_groups = sorted(
        groups.items(),
        key=lambda kv: (kv[0][0], -len(kv[1])),
    )

    for (cid, key), docs in sorted_groups:
        winner = docs[0]
        losers = docs[1:]
        loser_ids = {d["id"] for d in losers}

        fk_counts = await _count_fks(loser_ids, cid)
        total_fks = sum(fk_counts.values())

        per_company[cid]["groups"] += 1
        per_company[cid]["losers"] += len(losers)
        per_company[cid]["fk_reps"] += total_fks
        grand_totals["groups"] += 1
        grand_totals["losers"] += len(losers)
        for coll, n in fk_counts.items():
            grand_totals["fk_repointed"][coll] += n

        print(f"\n[{cid[:8]}…] '{key}'  ({len(docs)} dupes → 1 keeper + {len(losers)} losers)")
        print(f"   Keeper: id={winner['id'][:8]}… name={winner.get('name')!r} "
              f"created_at={winner.get('created_at')}")
        for l in losers:
            print(f"   Loser:  id={l['id'][:8]}… name={l.get('name')!r} "
                  f"created_at={l.get('created_at')}")
        if total_fks:
            fk_lines = [f"{coll}={n}" for coll, n in fk_counts.items() if n]
            print(f"   FKs to repoint: {', '.join(fk_lines)} (total={total_fks})")
        else:
            print("   FKs to repoint: (none — safe to just delete losers)")

        if apply:
            result = await _repoint_and_delete(winner["id"], loser_ids, cid)
            print(f"   ✓ Applied: {result}")

    # ── Summary ─────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"Companies with dupes    : {len(per_company)}")
    print(f"Total dupe groups       : {grand_totals['groups']}")
    print(f"Total loser docs        : {grand_totals['losers']}")
    print(f"Total FK repoints       :")
    for coll, n in sorted(grand_totals["fk_repointed"].items(), key=lambda kv: -kv[1]):
        if n:
            print(f"   {coll:30s}: {n}")
    print()
    print("Per-company breakdown:")
    for cid, s in sorted(per_company.items(), key=lambda kv: -kv[1]["losers"]):
        print(f"   {cid[:16]}…  groups={s['groups']:4d}  losers={s['losers']:5d}  "
              f"fk_reps={s['fk_reps']:5d}")

    if not apply:
        print("\n" + "!" * 70)
        print("DRY RUN — no changes were made. Re-run with --apply to execute.")
        print("!" * 70)
    else:
        print("\n✓ Live changes applied. Recommend `db.contacts.countDocuments()` to verify.")

    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Contact dedup — dry-run by default")
    parser.add_argument("--apply", action="store_true",
                        help="Actually apply changes (default is dry-run).")
    parser.add_argument("--company", default=None,
                        help="Limit to a single company_id (safer for staged rollout).")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(apply=args.apply, company_filter=args.company)))
