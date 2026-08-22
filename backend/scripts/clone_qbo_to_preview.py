"""Clone a QBO-connected company from PROD to PREVIEW without a
re-OAuth step. Copies the `companies` row and the `qbo_connections`
row (decrypting with the source Fernet key and re-encrypting with the
target key so tokens are readable in the target). No entity data is
copied — after cloning, click Run Migration on Connect QBO in
preview to pull everything fresh.

Usage
-----
Run from a shell that has network access to BOTH MongoDB URIs.

    export PROD_MONGO_URL='mongodb+srv://.../axiom_prod'
    export PROD_FIELD_ENCRYPTION_KEY='<prod field-encryption key>'
    export PREVIEW_MONGO_URL='mongodb://localhost:27017'
    export PREVIEW_FIELD_ENCRYPTION_KEY='<preview key from backend/.env>'

    python scripts/clone_qbo_to_preview.py \
        --company-name "BM QBO 2 LLC"

Optional
    --source-company-id <id>   Skip name lookup; pass exact prod id.
    --target-company-id <id>   Reuse a specific id in preview (default: fresh uuid).
    --dry-run                  Show what would be written, do not touch preview DB.

Caveats
-------
* QBO refresh tokens are single-use. After the copy, both prod and
  preview share the same refresh token — whichever environment
  refreshes it first invalidates the other. Preview is expected to
  be short-lived (QA / demo).
* Requires the source Fernet key to decrypt tokens. If prod and
  preview share the same key, the re-encryption step is a no-op.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

from cryptography.fernet import Fernet
from motor.motor_asyncio import AsyncIOMotorClient

# Preview's own crypto_service handles AES-GCM with the `enc_v1:`
# sentinel format its `decrypt` expects. Using it here (instead of
# raw Fernet) means the values we write are guaranteed readable when
# the preview backend calls `decrypt(access_token_enc)` at runtime.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from crypto_service import encrypt as prev_encrypt  # noqa: E402
from crypto_service import decrypt as prev_decrypt  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def clone(company_name: str,
                 source_company_id: str | None,
                 target_company_id: str | None,
                 dry_run: bool) -> None:
    prod_url = os.environ["PROD_MONGO_URL"]
    prev_url = os.environ["PREVIEW_MONGO_URL"]
    # Prod may run without FIELD_ENCRYPTION_KEY, in which case its
    # `access_token_enc` fields are just plaintext strings.
    prod_key = os.environ.get("PROD_FIELD_ENCRYPTION_KEY")
    prod_fernet = Fernet(prod_key.encode()) if prod_key else None

    prod = AsyncIOMotorClient(prod_url)
    prev = AsyncIOMotorClient(prev_url)
    prod_db = prod.get_default_database()
    prev_db = prev.get_default_database()

    # -------- Find the source company on prod --------
    q = ({"id": source_company_id} if source_company_id
          else {"name": company_name})
    src_company = await prod_db.companies.find_one(q)
    if not src_company:
        raise SystemExit(f"Company not found on prod: {q}")
    print(f"[prod] company: id={src_company['id']} name={src_company.get('name')!r}")

    # -------- Find its qbo_connections row --------
    src_conn = await prod_db.qbo_connections.find_one(
        {"company_id": src_company["id"]})
    if not src_conn:
        raise SystemExit("Prod company has no qbo_connections row")
    print(f"[prod] qbo: realm={src_conn['realm_id']} "
          f"env={src_conn.get('env')} status={src_conn.get('status')}")

    # -------- Decrypt (or read plaintext) + re-encrypt tokens --------
    def _read(v: str) -> str:
        # Source is prod. Two possibilities:
        #   1. prod_fernet is set  → tokens are Fernet-encrypted
        #   2. prod_fernet is None → tokens are plaintext (dev mode)
        if prod_fernet is None:
            return v
        return prod_fernet.decrypt(v.encode()).decode()

    # Target is preview. Always run through preview's crypto_service so
    # the resulting value carries the `enc_v1:` sentinel the runtime
    # `decrypt()` expects. When preview has no key, encrypt() is a
    # no-op passthrough, still safe.
    access  = _read(src_conn["access_token_enc"])
    refresh = _read(src_conn["refresh_token_enc"])
    new_access_enc  = prev_encrypt(access)
    new_refresh_enc = prev_encrypt(refresh)

    # -------- Compose preview docs --------
    target_cid = target_company_id or str(uuid.uuid4())
    company_doc = dict(src_company)
    company_doc.pop("_id", None)
    company_doc["id"] = target_cid
    company_doc["updated_at"] = _now_iso()
    company_doc["created_at"] = _now_iso()
    # Prevent any leaked partner/enterprise pointers.
    company_doc.setdefault("partner_id", None)
    company_doc.setdefault("enterprise_id", None)

    conn_doc = dict(src_conn)
    conn_doc.pop("_id", None)
    conn_doc["company_id"] = target_cid
    conn_doc["access_token_enc"] = new_access_enc
    conn_doc["refresh_token_enc"] = new_refresh_enc
    conn_doc["updated_at"] = _now_iso()
    conn_doc["created_at"] = _now_iso()

    # -------- Write to preview --------
    if dry_run:
        print("\n[DRY RUN] would write:")
        print("  companies.id           =", target_cid)
        print("  companies.name         =", company_doc.get("name"))
        print("  qbo_connections.realm  =", conn_doc.get("realm_id"))
        print("  qbo_connections.env    =", conn_doc.get("env"))
        return

    await prev_db.companies.replace_one(
        {"id": target_cid}, company_doc, upsert=True)
    await prev_db.qbo_connections.replace_one(
        {"company_id": target_cid}, conn_doc, upsert=True)
    print(f"\n[preview] wrote company {target_cid} + qbo connection")
    print("           → Open Connect QBO on preview and click Run Migration")
    print("           → Or click Import from Production Connection on Test QBO")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--company-name", default=None)
    ap.add_argument("--source-company-id", default=None)
    ap.add_argument("--target-company-id", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.company_name and not args.source_company_id:
        ap.error("provide --company-name or --source-company-id")
    for k in ("PROD_MONGO_URL", "PREVIEW_MONGO_URL"):
        if not os.environ.get(k):
            ap.error(f"missing env: {k}")
    asyncio.run(clone(args.company_name, args.source_company_id,
                       args.target_company_id, args.dry_run))


if __name__ == "__main__":
    main()
