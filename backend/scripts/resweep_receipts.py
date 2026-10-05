"""One-off: re-evaluate every open missing-receipt finding and every unanswered
Clean Up receipt item under receipt_policy. Run: python -m scripts.resweep_receipts"""
import asyncio
import sys

sys.path.insert(0, "/app/backend")
from dotenv import load_dotenv  # noqa: E402

load_dotenv("/app/backend/.env")

from db import db  # noqa: E402
import receipt_policy  # noqa: E402
import compliance_watcher  # noqa: E402
from client_review import ITEM_MISSING_RECEIPT  # noqa: E402


async def prune_cleanup_batches(cid: str) -> tuple[int, int]:
    """Items point at agent_findings (graduated) or transactions. Drop unanswered
    receipt items whose finding was resolved / txn no longer qualifies; refresh prompts."""
    dropped = kept = 0
    async for b in db.client_review_batches.find({"company_id": cid}):
        items = b.get("items") or []
        todo = [i for i in items if i.get("item_type") == ITEM_MISSING_RECEIPT and not i.get("answered_at")]
        if not todo:
            continue
        f_ids = [i.get("source_id") for i in todo if i.get("source_collection") == "agent_findings"]
        t_ids = [i.get("source_id") for i in todo if i.get("source_collection") == "transactions"]
        findings = {f["id"]: f async for f in db.agent_findings.find({"id": {"$in": f_ids}})}
        txns = {t["id"]: t async for t in db.transactions.find({"id": {"$in": t_ids}})}
        dec = await receipt_policy.decide(cid, list(txns.values()))
        out = []
        for i in items:
            if i.get("item_type") != ITEM_MISSING_RECEIPT or i.get("answered_at"):
                out.append(i)
                continue
            if i.get("source_collection") == "agent_findings":
                f = findings.get(i.get("source_id"))
                if not f or f.get("status") != "open":
                    dropped += 1
                    continue
                i["prompt"] = f.get("detail") or f.get("title") or i["prompt"]
                i.setdefault("context", {})["meta"] = f.get("meta") or {}
            else:
                d, t = dec.get(i.get("source_id")), txns.get(i.get("source_id"))
                if not d or not d.flag or not t:
                    dropped += 1
                    continue
                i["prompt"] = f"Missing receipt: ${abs(float(t.get('amount') or 0)):,.2f} · {receipt_policy.who_of(t)} on {t.get('date','')} — {d.label}"
                i.setdefault("context", {}).update({"reason_code": d.reason, "reason_label": d.label})
            out.append(i)
            kept += 1
        await db.client_review_batches.update_one({"id": b["id"]}, {"$set": {
            "items": out, "status": "open" if any(not x.get("answered_at") for x in out) else "completed"}})
    return dropped, kept


async def regraduate(cid: str) -> int:
    """Findings I dropped from cleanup batches earlier still carry batch_id — clear it so they can re-graduate."""
    from client_review import graduate_company_to_cleanup
    ids_in_batches = set()
    async for b in db.client_review_batches.find({"company_id": cid}, {"items.source_id": 1}):
        ids_in_batches |= {i.get("source_id") for i in b.get("items") or []}
    orphans = [f["id"] async for f in db.agent_findings.find({"company_id": cid, "kind": "missing_receipt", "status": "open", "batch_id": {"$nin": [None, ""]}}, {"id": 1}) if f["id"] not in ids_in_batches]
    if orphans:
        await db.agent_findings.update_many({"id": {"$in": orphans}}, {"$set": {"batch_id": None}})
    return await graduate_company_to_cleanup(cid)


async def main():
    async for c in db.companies.find({}, {"id": 1, "name": 1}):
        cid = c["id"]
        try:
            r = await compliance_watcher.scan_company(cid)
            dropped, kept = await prune_cleanup_batches(cid)
            regrad = await regraduate(cid)
            print(f"{c.get('name')}: new={r['missing_receipt']} closed={r['closed']} batch_dropped={dropped} batch_kept={kept} regraduated={regrad}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"{c.get('name')}: FAILED {e}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
