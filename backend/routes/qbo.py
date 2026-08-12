"""QBO OAuth + migration routes.

Endpoints (all mounted under /api):
  POST   /companies/{cid}/qbo/oauth/start      → returns Intuit consent URL
  GET    /qbo/oauth/callback                    → OAuth redirect target
  GET    /companies/{cid}/qbo/status            → connection info
  POST   /companies/{cid}/qbo/disconnect        → revoke tokens + mark disconnected
  GET    /companies/{cid}/qbo/preview           → count(*) per entity
  POST   /companies/{cid}/qbo/migrations        → kick off background import
  GET    /companies/{cid}/qbo/migrations/{jid}  → poll job status
"""
from __future__ import annotations
import asyncio
import uuid
import secrets
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from db import db, now_iso
from auth import get_current_user
from deps import require_company
import qbo_service as Q

# The OAuth callback runs on api.smartbookssoftware.ai but the user lives
# on app.smartbookssoftware.ai — so every RedirectResponse must include
# the absolute app URL, not a relative /connections/qbo path. Otherwise
# the browser resolves the relative path against api.* and the SPA
# catch-all on the FRONTEND service never sees the query params.
_APP_URL = Q.QBO_APP_URL.rstrip("/")

router = APIRouter(prefix="/api")


# Whitelist of API hosts we're willing to send Intuit back to. Each
# entry MUST also be registered on the Intuit Developer app's Redirect
# URIs list, or Intuit will reject the auth request with
# `invalid_redirect_uri`. Adding a new private label = (1) add the API
# host here, (2) add the same callback URL on developer.intuit.com.
_QBO_ALLOWED_HOSTS = {
    "api.smartbookssoftware.ai",
    "api.cypherpro.accountingapp.ai",
    # Additional private labels appended as they onboard. Keep in sync
    # with the Redirect URIs list on the Intuit app.
}


def _redirect_uri_from_request(request: Request) -> str | None:
    """Derive the Intuit callback URL from the incoming request Host,
    provided the host is on the whitelist. Returns None so the caller
    falls back to the env-configured default (SmartBooks flagship)."""
    # Behind the Kubernetes ingress + Emergent proxy, the label's
    # forwarding host lands in `x-forwarded-host` (Host is often
    # rewritten to the internal service name).
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or ""
    ).split(":")[0].lower()
    if host in _QBO_ALLOWED_HOSTS:
        # Emergent always terminates TLS at the edge — use https
        # unconditionally so the callback URL matches what's registered
        # on Intuit (which requires https for prod).
        return f"https://{host}/api/qbo/oauth/callback"
    return None


def _return_to_host_from_request(request: Request) -> str | None:
    """Capture the FRONTEND host the user is browsing when they kick
    off the OAuth flow. This is stored on the state record so the
    callback (which runs on whichever API host Intuit sends it to)
    can bounce the user back to the correct label's frontend.

    Independent of `_redirect_uri_from_request` — the Intuit callback
    URL is constrained to hosts Intuit knows about, but the FINAL
    redirect at the end of the flow can be ANY frontend host our app
    serves.

    Header priority — the more the source *directly* reflects "which
    tab is the browser on right now", the higher it ranks:

      1. `Referer` — the FULL URL of the page that made the API call
         (e.g. `https://enterprise.accountingapp.ai/connections/qbo`).
         Set by every same-origin fetch — authoritative for the
         frontend host.
      2. `Origin` — scheme+host only; set on cross-origin and POST
         requests. Same authority as Referer but missing the path.
      3. `x-forwarded-host` — the Emergent/Kubernetes ingress
         forwarding host. Falls back here ONLY when the browser
         didn't provide the other two (curl, non-browser flows), and
         even then, we skip any host we recognize as the flagship API
         (`api.smartbookssoftware.ai`) because "strip api. prefix"
         collapses that to the bare marketing domain
         `smartbookssoftware.ai` — which doesn't serve the app.

    Returns a scheme+host string or None if nothing usable was found."""
    # 1. Referer — parse to scheme+host.
    ref = request.headers.get("referer") or request.headers.get("referrer")
    if ref:
        try:
            from urllib.parse import urlparse
            p = urlparse(ref)
            if p.scheme in {"http", "https"} and p.netloc:
                return f"{p.scheme}://{p.netloc}"
        except Exception:  # noqa: BLE001
            pass

    # 2. Origin — already scheme+host, just trust it.
    origin = request.headers.get("origin")
    if origin and origin.startswith(("http://", "https://")):
        # Some proxies append a trailing slash — strip it.
        return origin.rstrip("/")

    # 3. Fallback — x-forwarded-host. Only fires for non-browser
    # callers (curl, Postman) or misconfigured proxies.
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or ""
    ).split(":")[0].lower()
    if not host:
        return None
    # Skip internal / opaque hosts that can't map to a real frontend.
    if host in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return None
    # If the host clearly points at an API subdomain, we cannot
    # confidently derive the frontend host — return None and let the
    # caller fall back to `_APP_URL` rather than sending the user to
    # a wrong bare domain.
    if host.startswith("api."):
        return None
    return f"https://{host}"


class OAuthStartOut(BaseModel):
    url: str


@router.post("/companies/{cid}/qbo/oauth/start", response_model=OAuthStartOut)
async def qbo_oauth_start(cid: str, request: Request,
                          user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    state = secrets.token_urlsafe(32)
    # Per-request redirect URI so private-label domains (Cypher Pro,
    # etc.) return the user to THEIR domain after consent instead of
    # bouncing back to SmartBooks. The URI is persisted on the state
    # record so the token-exchange callback can send Intuit the same
    # exact value (Intuit does a strict-equality check).
    redirect_uri = _redirect_uri_from_request(request)
    # Separately capture the FRONTEND host the user came from. Even
    # when the Intuit callback lands on the flagship API (because the
    # label's API host isn't registered with Intuit), we want the
    # user's final landing page to be their OWN label's app. This is
    # what fixes the "click Connect in QBO consent → land on SmartBooks
    # login" bug for enterprise/partner private labels.
    return_to_host = _return_to_host_from_request(request)
    await db.qbo_oauth_states.insert_one({
        "state": state, "company_id": cid, "user_id": user["id"],
        "redirect_uri": redirect_uri,
        "return_to_host": return_to_host,
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "created_at": now_iso(),
    })
    return {"url": Q.authorization_url(state, redirect_uri=redirect_uri)}


@router.get("/qbo/oauth/callback")
async def qbo_oauth_callback(
    request: Request,
    code: str = Query(None),
    state: str = Query(None),
    realmId: str = Query(None),
    error: str = Query(None),
):
    """Intuit redirects here after the user consents. Any failure path
    redirects to `/connections/qbo?qbo_error=<reason>` so the frontend
    can surface a useful toast instead of dumping a raw 4xx page.

    Multi-tenant: the private-label host that initiated the flow is
    persisted on the state record. We look it up here and (a) send
    Intuit the same redirect_uri during the token exchange, and (b)
    bounce the user back to the label's own frontend on success/error
    instead of the SmartBooks flagship."""
    # Fallback to the standard SmartBooks app URL if the state record
    # doesn't carry a private-label return target.
    def _label_app_url(rec: dict | None) -> str:
        # Priority 1: `return_to_host` — captured from the FRONTEND's
        # Referer/Origin on OAuth start. This is the authoritative
        # source for "where did this user come from" and works for
        # every label, including shared-host labels
        # (`enterprise.accountingapp.ai`).
        rth = (rec or {}).get("return_to_host")
        if rth:
            return rth.rstrip("/")
        # Priority 2 (legacy): derive from the Intuit-callback host by
        # stripping the `api.` prefix — but ONLY when the resulting
        # host is a private-label subdomain, not the bare
        # `smartbookssoftware.ai` marketing site (which doesn't serve
        # the app). Belt-and-suspenders: if `return_to_host` is missing
        # but `redirect_uri` points at `api.<label>.accountingapp.ai`,
        # we can still recover the label's frontend.
        uri = (rec or {}).get("redirect_uri")
        if uri:
            try:
                from urllib.parse import urlparse
                host = urlparse(uri).netloc
                if host.startswith("api.") and host.endswith(".accountingapp.ai"):
                    return f"https://{host[4:]}"
            except Exception:  # noqa: BLE001
                pass
        return _APP_URL

    def _err(reason: str, rec: dict | None = None) -> RedirectResponse:
        target = f"{_label_app_url(rec)}/connections/qbo?qbo_error={reason}"
        return RedirectResponse(target, status_code=302)

    # Intuit itself returned an error (user hit "No thanks", scope
    # rejected, invalid client, etc.). We still want the "No thanks"
    # bounce to land on the LABEL's frontend so the user isn't dumped
    # on the flagship. If `state` came through, peek at the record
    # (without deleting — the exchange path below deletes it) to grab
    # the recorded return-to-host. Any lookup failure silently falls
    # back to the platform default.
    if error or not code or not state or not realmId:
        peek_rec = None
        if state:
            try:
                peek_rec = await db.qbo_oauth_states.find_one({"state": state})
            except Exception:  # noqa: BLE001
                peek_rec = None
        return _err(error or "missing_params", peek_rec)

    rec = await db.qbo_oauth_states.find_one_and_delete({"state": state})
    if not rec:
        return _err("state_expired")
    try:
        exp = datetime.fromisoformat(rec["expires_at"])
        if exp < datetime.now(timezone.utc):
            return _err("state_expired", rec)
    except (KeyError, ValueError):
        return _err("state_bad", rec)
    cid = rec["company_id"]
    # Same redirect URI we sent to Intuit at auth-start time — Intuit
    # rejects the exchange with `invalid_grant` otherwise. Persisted on
    # the state record for exactly this reason.
    stored_redirect_uri = rec.get("redirect_uri")
    try:
        tokens = await Q.exchange_code(code, realmId, redirect_uri=stored_redirect_uri)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception(
            "QBO token exchange failed for cid=%s realm=%s", cid, realmId
        )
        return _err(f"exchange_failed:{str(e)[:120]}", rec)
    try:
        await Q.save_connection(cid, realmId, tokens)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception(
            "QBO save_connection failed for cid=%s", cid
        )
        return _err(f"save_failed:{str(e)[:120]}", rec)
    # Success — land the user on the QBO Connect page (not the generic
    # /connections page — that route doesn't refresh QBO status). Use
    # the label's own app host (recorded on the state at OAuth-start
    # time) so private-label users don't get bounced onto the flagship
    # SmartBooks login. Absolute URL so the browser lands on the
    # FRONTEND service, not the API.
    return RedirectResponse(
        f"{_label_app_url(rec)}/connections/qbo?qbo=connected&realm={realmId}",
        status_code=302,
    )


@router.get("/companies/{cid}/qbo/status")
async def qbo_status(cid: str, user: dict = Depends(get_current_user)):
    """Returns connection state PLUS the cached preview counts and the
    most-recent migration job for this company — lets the frontend
    rehydrate the 3-step page on reload without extra roundtrips."""
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    last_job = await db.qbo_jobs.find_one(
        {"company_id": cid, "stale": {"$ne": True}},
        sort=[("created_at", -1)],
    )
    if last_job:
        last_job.pop("_id", None)
    if not conn:
        return {"connected": False, "last_job": last_job}
    preview = None
    if conn.get("preview_counts"):
        preview = {
            "counts": conn["preview_counts"],
            "total": sum(c for c in conn["preview_counts"].values() if c > 0),
            "preview_at": conn.get("preview_at"),
        }
    return {
        "connected": conn.get("status") == "connected",
        "realm_id": conn.get("realm_id"),
        "environment": conn.get("environment"),
        "connected_at": conn.get("created_at"),
        "last_updated": conn.get("updated_at"),
        "preview": preview,
        "last_job": last_job,
    }


@router.post("/companies/{cid}/qbo/disconnect")
async def qbo_disconnect(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    if conn and conn.get("refresh_token_enc"):
        try:
            from crypto_service import decrypt
            await Q.revoke(decrypt(conn["refresh_token_enc"]))
        except Exception:  # noqa: BLE001
            pass
    await db.qbo_connections.update_one(
        {"company_id": cid},
        {"$set": {"status": "disconnected", "access_token_enc": None,
                  "refresh_token_enc": None, "updated_at": now_iso()},
         # Wipe the cached preview + persistent old-job pointer so the
         # UI shows a clean 3-step flow on the next Connect, not stale
         # numbers from the last realm.
         "$unset": {"preview_counts": "", "preview_at": ""}},
    )
    await db.qbo_jobs.update_many(
        {"company_id": cid, "status": {"$in": ["queued", "running"]}},
        {"$set": {"status": "cancelled", "finished_at": now_iso()}},
    )
    # Also mark any prior "done" jobs stale so refreshStatus doesn't
    # hydrate a Complete state for a connection that no longer exists.
    await db.qbo_jobs.update_many(
        {"company_id": cid, "status": "done"},
        {"$set": {"stale": True}},
    )
    return {"ok": True}


@router.get("/companies/{cid}/qbo/preview")
async def qbo_preview(cid: str, user: dict = Depends(get_current_user)):
    """Cheap count(*) per entity so the user can preview scope
    before committing to the full import."""
    await require_company(user, cid)
    try:
        counts = await Q.preview_counts(cid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"QBO preview failed: {e}") from e
    return {"counts": counts, "total": sum(c for c in counts.values() if c > 0)}


@router.post("/companies/{cid}/qbo/migrations")
async def qbo_start_migration(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    conn = await Q.get_connection(cid)
    if not conn or conn.get("status") != "connected":
        raise HTTPException(400, "QBO not connected")
    # Only one active migration per company at a time.
    existing = await db.qbo_jobs.find_one(
        {"company_id": cid, "status": {"$in": ["queued", "running"]}},
    )
    if existing:
        return {"job_id": existing["job_id"], "already_running": True}
    job_id = str(uuid.uuid4())
    await db.qbo_jobs.insert_one({
        "job_id": job_id, "company_id": cid,
        "status": "queued", "phase": "queued", "percent": 0,
        "processed": 0, "created_at": now_iso(),
    })
    # Fire-and-forget task. The service updates the job doc as it runs.
    asyncio.create_task(Q.run_migration(job_id, cid))
    return {"job_id": job_id, "already_running": False}


@router.get("/companies/{cid}/qbo/migrations/{job_id}")
async def qbo_migration_status(cid: str, job_id: str,
                               user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await db.qbo_jobs.find_one({"job_id": job_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, "Job not found")
    doc.pop("_id", None)
    return doc


@router.post("/companies/{cid}/qbo/relink-payments")
async def qbo_relink_payments(cid: str, user: dict = Depends(get_current_user)):
    """Backfill `linked_invoice_id` / `linked_bill_id` on already-
    imported QBO payments by resolving each payment's `applied_to`
    QBO IDs against our local invoices/bills. Idempotent — safe to run
    multiple times. Returns the count updated on this call.

    Used after a QBO migration that predates the auto-link step in
    `run_migration`. Future migrations link payments automatically."""
    await require_company(user, cid)
    updated = await Q.resolve_payment_links(cid)
    return {"payments_linked": updated}


@router.get("/companies/{cid}/qbo/ai-align-plan")
async def qbo_ai_align_plan(cid: str, user: dict = Depends(get_current_user)):
    """Ask Claude to align QBO-imported accounts to our canonical PFC
    codes. Returns the plan for the UI to preview (no DB writes).

    The UI shows the proposal grouped by confidence, lets the user edit
    matches, then submits back to `POST /qbo/ai-align`."""
    await require_company(user, cid)
    from qbo_ai_align import plan_alignment
    return await plan_alignment(cid)


@router.post("/companies/{cid}/qbo/ai-align")
async def qbo_ai_align_apply(
    cid: str,
    payload: dict,
    user: dict = Depends(get_current_user),
):
    """Commit an alignment plan. Payload:
      {
        "proposals": [...],           # from /ai-align-plan, possibly edited
        "min_confidence": "medium",   # optional, default "medium"
        "deactivate_seeded": true,    # optional, default true
      }
    Writes `code` onto matched QBO accounts and deactivates our seeded
    duplicates for codes that got a QBO home."""
    await require_company(user, cid)
    from qbo_ai_align import apply_alignment
    return await apply_alignment(
        company_id=cid,
        proposals=payload.get("proposals") or [],
        min_confidence=payload.get("min_confidence", "medium"),
        deactivate_seeded=bool(payload.get("deactivate_seeded", True)),
    )


@router.post("/companies/{cid}/qbo/reset-qbo-codes")
async def qbo_reset_codes(cid: str, user: dict = Depends(get_current_user)):
    """Remove any `code` values we stamped onto QBO accounts by an
    earlier `qbo_ai_align` run — that approach is retired in favor of
    the per-company `pfc_org_overrides` map. Also reactivates seeded
    accounts we deactivated. Safe to run — restores accounts to the
    exact shape QBO migration produced."""
    await require_company(user, cid)
    reset = await db.accounts.update_many(
        {"company_id": cid, "source": "qbo", "pfc_aligned_at": {"$exists": True}},
        {"$unset": {"code": "", "pfc_aligned_at": "",
                    "pfc_alignment_confidence": ""}},
    )
    reactivated = await db.accounts.update_many(
        {"company_id": cid, "source": {"$ne": "qbo"},
         "deactivated_reason": "qbo_ai_aligned"},
        {"$set": {"active": True},
         "$unset": {"deactivated_at": "", "deactivated_reason": ""}},
    )
    return {"reset_qbo_codes": reset.modified_count,
            "reactivated_seeded": reactivated.modified_count}


@router.get("/companies/{cid}/pfc-map/plan")
async def pfc_map_plan(cid: str, user: dict = Depends(get_current_user)):
    """Ask Claude to propose a Plaid PFC → account map for this company.
    Returns the proposal for UI review (no DB writes)."""
    await require_company(user, cid)
    from pfc_ai_builder import plan_pfc_map
    return await plan_pfc_map(cid)


@router.post("/companies/{cid}/pfc-map/apply")
async def pfc_map_apply(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
):
    """Commit a reviewed PFC → account map to `pfc_org_overrides`.
    Payload: {proposals: [...], min_confidence: 'high|medium|low'}"""
    await require_company(user, cid)
    from pfc_ai_builder import apply_pfc_map
    return await apply_pfc_map(
        company_id=cid,
        proposals=payload.get("proposals") or [],
        min_confidence=payload.get("min_confidence", "medium"),
    )


@router.get("/companies/{cid}/pfc-map")
async def pfc_map_get(cid: str, user: dict = Depends(get_current_user)):
    """Return the current PFC → account map for this company — one row
    per detailed PFC code, joined with account name/type. UI settings
    page renders this."""
    await require_company(user, cid)
    from pfc_ai_builder import get_pfc_map
    return {"rows": await get_pfc_map(cid)}


@router.put("/companies/{cid}/pfc-map/{pfc_detailed}")
async def pfc_map_set_one(
    cid: str, pfc_detailed: str, payload: dict,
    user: dict = Depends(get_current_user),
):
    """User override for a single PFC → account. Body: {account_id}.
    Pass account_id='' to clear the override (falls back to code)."""
    await require_company(user, cid)
    aid = (payload.get("account_id") or "").strip()
    if not aid:
        await db.pfc_org_overrides.delete_one(
            {"company_id": cid, "pfc_detailed": pfc_detailed},
        )
        return {"cleared": True}
    # Validate the account belongs to this company.
    exists = await db.accounts.find_one(
        {"company_id": cid, "id": aid}, {"id": 1},
    )
    if not exists:
        raise HTTPException(400, "account_id not found on this company")
    from pfc_resolver import set_pfc_override
    return await set_pfc_override(
        company_id=cid, pfc_detailed=pfc_detailed,
        category_account_id=aid, source="user",
    )


@router.get("/companies/{cid}/qbo/cleanup-plan")
async def qbo_cleanup_plan(cid: str, user: dict = Depends(get_current_user)):
    """List seeded accounts that have a QBO equivalent AND are
    unreferenced — candidates for deactivation. `kept` are seeded
    accounts we recommend keeping (structural, or no QBO replacement,
    or referenced by ledger docs). NO writes."""
    await require_company(user, cid)
    from pfc_ai_builder import plan_cleanup
    return await plan_cleanup(cid)


@router.post("/companies/{cid}/qbo/cleanup-apply")
async def qbo_cleanup_apply(
    cid: str, payload: dict, user: dict = Depends(get_current_user),
):
    """Deactivate the seeded accounts the user confirmed on the
    settings page. Body: {account_ids: [...]}."""
    await require_company(user, cid)
    from pfc_ai_builder import apply_cleanup
    return await apply_cleanup(cid, payload.get("account_ids") or [])


@router.post("/companies/{cid}/qbo/cleanup-reverse")
async def qbo_cleanup_reverse(cid: str, user: dict = Depends(get_current_user)):
    """Undo — reactivate every seeded account that got deactivated by
    `cleanup-apply` (`deactivated_reason == "qbo_dedup"`)."""
    await require_company(user, cid)
    from pfc_ai_builder import reverse_cleanup
    return await reverse_cleanup(cid)


@router.post("/companies/{cid}/qbo/cleanup-all-seeded")
async def qbo_cleanup_all_seeded(cid: str, user: dict = Depends(get_current_user)):
    """Aggressive one-click cleanup — deactivates EVERY seeded account
    (source != qbo) that isn't a structural fallback and isn't referenced
    by any existing ledger doc. Reversible via `cleanup-reverse`."""
    await require_company(user, cid)
    from pfc_ai_builder import apply_cleanup_all_seeded
    return await apply_cleanup_all_seeded(cid)


@router.post("/companies/{cid}/qbo/rebuild-account-hierarchy")
async def qbo_rebuild_account_hierarchy(cid: str, user: dict = Depends(get_current_user)):
    """Backfill for companies whose QBO CoA was imported before the
    parent-resolver fix. Splits colon-joined names into leaf +
    parent_account_id links. Idempotent — safe to run repeatedly."""
    await require_company(user, cid)
    from qbo_service import resolve_account_parents
    updated = await resolve_account_parents(cid)
    return {"updated": updated}


@router.post("/companies/{cid}/qbo/rebuild-transaction-categories")
async def qbo_rebuild_transaction_categories(cid: str, user: dict = Depends(get_current_user)):
    """Backfill: for companies migrated before the resolvers were wired
    in, translate each QBO-imported transaction's line-item AccountRef
    into a top-level `category_account_id`, sign the amount based on
    txn_type, and populate `bank_account_id` from the QBO source/deposit
    account. Idempotent."""
    await require_company(user, cid)
    from qbo_service import (resolve_transaction_categories,
                             resolve_transaction_signs,
                             resolve_transaction_banks,
                             resolve_transaction_posted)
    categorized = await resolve_transaction_categories(cid)
    signed = await resolve_transaction_signs(cid)
    banks = await resolve_transaction_banks(cid)
    posted = await resolve_transaction_posted(cid)
    return {"updated": categorized, "signed": signed, "banks": banks,
            "posted": posted}


@router.get("/companies/{cid}/qbo/diagnostics")
async def qbo_diagnostics(cid: str, user: dict = Depends(get_current_user)):
    """Full audit of a company's QBO migration state. Returns:
      - connection status (realm, environment, last update)
      - every migration job the company has run
      - count of source='qbo' docs in each target collection, WITH the
        Preview count that QBO itself reported so we can spot deltas
      - a sample of the FIRST qbo doc from each collection (name/id/type)
        so the user can eyeball whether the mapping is landing correctly
    Used exclusively for support triage. Cheap — a few counts + one
    `find_one` per collection."""
    await require_company(user, cid)
    conn = await db.qbo_connections.find_one({"company_id": cid}) or {}
    jobs_cur = db.qbo_jobs.find({"company_id": cid}).sort("created_at", -1)
    jobs = []
    async for j in jobs_cur:
        j.pop("_id", None)
        jobs.append(j)

    # For each of the four Foundation collections, count how many QBO-
    # sourced docs exist AND grab one sample so we can eyeball mapping.
    # We also count the transactional collections (invoices/bills/etc.)
    # because a common failure mode is "Foundation imported fine but
    # Invoice/Bill/Payment mappers crashed" — the counts here immediately
    # reveal a partial import.
    out_collections = {}
    for coll_name, entity_label in [
        ("accounts", "Account"),
        ("contacts", "Customer+Vendor"),
        ("items", "Item"),
        ("invoices", "Invoice"),
        ("bills", "Bill"),
        ("payments", "Payment+BillPayment"),
        ("journal_entries", "JournalEntry"),
        ("transactions", "Deposit+Transfer+Purchase+SalesReceipt+RefundReceipt+CreditMemo"),
    ]:
        total = await db[coll_name].count_documents(
            {"company_id": cid, "source": "qbo"},
        )
        sample = await db[coll_name].find_one(
            {"company_id": cid, "source": "qbo"},
            projection={"_id": 0, "raw": 0},   # trim heavy `raw` blob
        )
        out_collections[coll_name] = {
            "entity": entity_label,
            "count_in_db": total,
            "sample": sample,
        }

    # Try a live QBO preview so we can compare live counts to imported.
    preview = None
    try:
        if conn.get("status") == "connected":
            preview = await Q.preview_counts(cid)
    except Exception as e:  # noqa: BLE001
        preview = {"error": str(e)[:200]}

    return {
        "connection": {
            "connected": conn.get("status") == "connected",
            "realm_id": conn.get("realm_id"),
            "environment": conn.get("environment"),
            "created_at": conn.get("created_at"),
            "updated_at": conn.get("updated_at"),
        },
        "mapper_version": Q.MAPPER_VERSION,
        "jobs": jobs,
        "collections": out_collections,
        "live_qbo_preview": preview,
    }
