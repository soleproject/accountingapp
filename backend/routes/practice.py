"""Practice product — per-user profile settings (superadmin-only shell for now)."""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Optional
from pydantic import BaseModel, Field
import uuid
import logging
from fastapi import APIRouter, Depends, HTTPException, Request

from db import db
from auth import require_role, hash_password

router = APIRouter(prefix="/api/practice")
_role_guard = require_role("superadmin", "practice")


# path prefix -> permission feature
_FEATURE_BY_PATH = [
    ("/expenses/categories", "Expenses"), ("/contacts", "Contacts"), ("/matters", "Matters"), ("/tasks", "Activities (Tasks, Events & Calls)"),
    ("/events", "Activities (Tasks, Events & Calls)"), ("/time-entries", "Time Entries"), ("/expenses", "Expenses"), ("/invoices", "Invoices"),
    ("/items", "Items"), ("/taxes", "Sales Taxes"), ("/roles/features", None), ("/roles", "Roles"), ("/users", "Users & User Groups"),
    ("/payments", "Contact Payments"), ("/retainers", "Contact Payments"), ("/checks", "Firm Payments"), ("/bank-accounts", "Bank Accounts"), ("/ledger", "Bank Accounts"),
    ("/activity", "Recent Activity"), ("/profile", "Settings & Billing"),
]
_ACTION_BY_METHOD = {"GET": "view", "POST": "create", "PUT": "edit", "PATCH": "edit", "DELETE": "delete"}


def _feature_for(path: str):
    rel = path.split("/api/practice", 1)[-1]
    for prefix, feat in _FEATURE_BY_PATH:
        if rel == prefix or rel.startswith(prefix + "/") or rel.startswith(prefix + "?"):
            return feat
    return None


def _action_for(method: str, path: str) -> str:
    if method == "POST" and (path.endswith("/clone") or path.endswith("/generate") or path.endswith("/payments") or path.endswith("/checks")):
        return "create"
    if method == "POST" and (path.endswith("/save") or path.endswith("/print") or path.endswith("/resend-invite") or path.endswith("/activity")):
        return "edit" if not path.endswith("/activity") else "create"
    return _ACTION_BY_METHOD.get(method, "view")


def can(perms: dict, feature: str, action: str) -> bool:
    if perms is None:
        return True
    f = perms.get(feature) or {}
    if action == "view":
        return bool(f.get("view") or f.get("view_all"))
    if action == "edit":
        return bool(f.get("edit") or f.get("edit_all"))
    return bool(f.get(action))


async def _staff_perms(account_id: str, owner_id: str):
    pu = await db.practice_users.find_one({"owner_id": owner_id, "account_id": account_id}, {"_id": 0, "role_id": 1, "active": 1})
    if not pu or pu.get("active") is False:
        return {}, None
    role = await db.practice_roles.find_one({"id": pu.get("role_id")}, {"_id": 0, "permissions": 1, "name": 1})
    return (role or {}).get("permissions", {}), (role or {}).get("name")


async def _guard(request: Request, user: dict = Depends(_role_guard)) -> dict:
    # Invited staff share the firm owner's Practice data and are limited by their role.
    if not user.get("practice_owner_id"):
        return {**user, "permissions": None, "role_name": "Admin", "is_owner": True}
    perms, role_name = await _staff_perms(user["id"], user["practice_owner_id"])
    feature = _feature_for(request.url.path)
    if feature and not can(perms, feature, _action_for(request.method, request.url.path)):
        raise HTTPException(403, f"Your role does not allow this action on {feature}.")
    return {**user, "id": user["practice_owner_id"], "staff_user_id": user["id"], "permissions": perms, "role_name": role_name or "", "is_owner": False}


@router.get("/me")
async def practice_me(user: dict = Depends(_guard)):
    return {"name": user.get("name"), "email": user.get("email"), "role_name": user.get("role_name"), "is_owner": user.get("is_owner"), "permissions": user.get("permissions")}


class PracticeProfile(BaseModel):
    first_name: str = ""
    middle_name: str = ""
    last_name: str = ""
    job_title: str = ""
    mobile: str = ""
    email: str = ""
    time_zone: str = "(UTC-08:00) Pacific Time (US & Canada)"
    home_phone: str = ""
    office_phone: str = ""
    hourly_rate: float = Field(0.0, ge=0)
    round_time_entries: bool = False
    daily_agenda_email: bool = True
    profile_picture: Optional[str] = None


def _defaults(user: dict) -> dict:
    parts = (user.get("name") or "").split(" ")
    return PracticeProfile(
        first_name=parts[0] if parts else "",
        last_name=" ".join(parts[1:]),
        email=user.get("email") or "",
    ).model_dump()


@router.get("/profile")
async def get_profile(user: dict = Depends(_guard)):
    doc = await db.practice_profiles.find_one({"user_id": user["id"]}, {"_id": 0, "user_id": 0})
    return doc or {**_defaults(user), "saved": False}


@router.put("/profile")
async def put_profile(inp: PracticeProfile, user: dict = Depends(_guard)):
    data = {**inp.model_dump(), "saved": True, "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_profiles.update_one({"user_id": user["id"]}, {"$set": data}, upsert=True)
    return data


class PracticePerson(BaseModel):
    first_name: str = ""
    middle_name: str = ""
    last_name: str = ""
    home: str = ""
    mobile: str = ""
    office: str = ""
    fax: str = ""
    email: str = ""
    client_portal: bool = False
    notes: str = ""
    preferred_contact_method: str = ""


class PracticePortalSettings(BaseModel):
    show_unpaid_invoices: bool = True
    show_paid_invoices: bool = True
    show_account_balances: bool = False
    show_all_payments: bool = True
    send_payment_reminders: bool = True


class PracticeContactIn(BaseModel):
    company_name: str = ""
    company_notes: str = ""
    contacts: list[PracticePerson] = Field(default_factory=list)
    address: str = ""
    assigned_to: str = ""
    tags: list[str] = Field(default_factory=list)
    status: str = "Active"
    number: Optional[str] = None
    website: str = ""
    additional_invoice_recipients: str = ""
    invoice_template: str = ""
    portal_settings: PracticePortalSettings = Field(default_factory=PracticePortalSettings)


def _display_name(c: dict) -> str:
    people = c.get("contacts") or []
    p = people[0] if people else {}
    name = " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x).strip()
    return name or c.get("company_name") or "Unnamed contact"


async def _billable_sums(uid: str, key: str) -> dict:
    sums: dict = {}
    for coll in (db.practice_time_entries, db.practice_expenses):
        async for d in coll.find({"owner_id": uid}, {"_id": 0, key: 1, "total": 1, "billing_status": 1, "billable": 1}):
            if _te_status(d) == "Billable" and d.get(key):
                sums[d[key]] = round(sums.get(d[key], 0) + (d.get("total") or 0), 2)
    return sums


@router.get("/contacts")
async def list_contacts(status: str = "Active", user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if status != "All":
        q["status"] = status
    docs = await db.practice_contacts.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    sums = await _billable_sums(user["id"], "contact_id")
    return [{**d, "display_name": _display_name(d), "billable": sums.get(d["id"], 0)} for d in docs]


@router.post("/contacts")
async def create_contact(inp: PracticeContactIn, user: dict = Depends(_guard)):
    if not inp.contacts or not (inp.contacts[0].first_name or inp.contacts[0].last_name or inp.company_name):
        raise HTTPException(400, "Enter a first name, last name, or company.")
    now = datetime.now(timezone.utc).isoformat()
    count = await db.practice_contacts.count_documents({"owner_id": user["id"]})
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(),
           "internal_id": int(inp.number) if (inp.number or "").isdigit() else count + 1,
           "created_at": now, "updated_at": now}
    await db.practice_contacts.insert_one(doc)
    doc.pop("_id", None)
    return {**doc, "display_name": _display_name(doc)}


@router.get("/contacts/{contact_id}")
async def get_contact(contact_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_contacts.find_one({"id": contact_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Contact not found")
    return {**doc, "display_name": _display_name(doc), "counts": await _counts(user["id"], contact_id=contact_id)}


class PracticeMatterIn(BaseModel):
    contact_id: str
    name: str
    notes: str = ""
    matter_rate: str = "User Hourly Rate"
    custom_rate: Optional[float] = None
    invoice_template: str = ""
    evergreen_retainer: bool = False
    additional_invoice_recipients: str = ""
    statute_of_limitations: Optional[str] = None
    open_date: Optional[str] = None
    close_date: Optional[str] = None
    assigned_to: str = ""
    originating_attorney: str = ""
    tags: list[str] = Field(default_factory=list)
    status: str = "Open"
    matter_number: Optional[str] = None


async def _with_contact(doc: dict, user: dict) -> dict:
    c = await db.practice_contacts.find_one({"id": doc.get("contact_id"), "owner_id": user["id"]}, {"_id": 0})
    return {**doc, "contact_name": _display_name(c) if c else "", "contact_tags": (c or {}).get("tags", [])}


@router.get("/matters")
async def list_matters(status: str = "Open", contact_id: Optional[str] = None, user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if status != "All":
        q["status"] = status
    if contact_id:
        q["contact_id"] = contact_id
    docs = await db.practice_matters.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    sums = await _billable_sums(user["id"], "matter_id")
    return [{**(await _with_contact(d, user)), "billable": sums.get(d["id"], 0)} for d in docs]


@router.get("/matters/counts")
async def matter_counts(user: dict = Depends(_guard)):
    now = datetime.now(timezone.utc)
    this_month = now.strftime("%Y-%m")
    last = (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    docs = await db.practice_matters.find({"owner_id": user["id"]}, {"_id": 0, "status": 1, "created_at": 1}).to_list(5000)
    return {
        "all": len(docs),
        "open": sum(1 for d in docs if d.get("status") == "Open"),
        "created_this_month": sum(1 for d in docs if (d.get("created_at") or "").startswith(this_month)),
        "created_last_month": sum(1 for d in docs if (d.get("created_at") or "").startswith(last)),
    }


@router.post("/matters")
async def create_matter(inp: PracticeMatterIn, user: dict = Depends(_guard)):
    if not inp.name.strip():
        raise HTTPException(400, "Matter name is required.")
    if not await db.practice_contacts.find_one({"id": inp.contact_id, "owner_id": user["id"]}):
        raise HTTPException(400, "Select a contact.")
    now = datetime.now(timezone.utc).isoformat()
    count = await db.practice_matters.count_documents({"owner_id": user["id"]})
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(),
           "matter_number": inp.matter_number or str(count + 1), "created_at": now, "updated_at": now}
    await db.practice_matters.insert_one(doc)
    doc.pop("_id", None)
    return await _with_contact(doc, user)


@router.get("/matters/{matter_id}")
async def get_matter(matter_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_matters.find_one({"id": matter_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Matter not found")
    return {**(await _with_contact(doc, user)), "counts": await _counts(user["id"], matter_id=matter_id)}


@router.put("/matters/{matter_id}")
async def update_matter(matter_id: str, inp: PracticeMatterIn, user: dict = Depends(_guard)):
    if not inp.name.strip():
        raise HTTPException(400, "Matter name is required.")
    if not await db.practice_contacts.find_one({"id": inp.contact_id, "owner_id": user["id"]}):
        raise HTTPException(400, "Select a contact.")
    data = {**inp.model_dump(), "updated_at": datetime.now(timezone.utc).isoformat()}
    if not data.get("matter_number"):
        data.pop("matter_number")
    r = await db.practice_matters.update_one({"id": matter_id, "owner_id": user["id"]}, {"$set": data})
    if not r.matched_count:
        raise HTTPException(404, "Matter not found")
    doc = await db.practice_matters.find_one({"id": matter_id}, {"_id": 0})
    return await _with_contact(doc, user)


class PracticeReminder(BaseModel):
    method: str = "Popup"
    amount: int = 10
    unit: str = "Minute(s)"


class PracticeTaskIn(BaseModel):
    reminders: list[PracticeReminder] = Field(default_factory=list)
    save_reminders: bool = True
    contact_id: Optional[str] = None
    matter_id: Optional[str] = None
    subject: str
    due_date: str
    due_time: Optional[str] = None
    all_day: bool = True
    status: str = "Not Completed"
    description: str = ""
    private: bool = False
    priority: str = "Medium"
    repeat: str = "Never"
    assigned_users: list[str] = Field(default_factory=list)
    assigned_contacts: str = ""
    tags: list[str] = Field(default_factory=list)
    email_assignees: bool = True


@router.get("/tasks/reminder-defaults")
async def reminder_defaults(user: dict = Depends(_guard)):
    doc = await db.practice_profiles.find_one({"user_id": user["id"]}, {"_id": 0, "default_reminders": 1})
    return (doc or {}).get("default_reminders") or []


@router.get("/tasks")
async def list_tasks(start: Optional[str] = None, end: Optional[str] = None, user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if start and end:
        q["due_date"] = {"$gte": start, "$lte": end}
    docs = await db.practice_tasks.find(q, {"_id": 0}).sort([("due_date", 1), ("due_time", 1)]).to_list(2000)
    cids = {d["contact_id"] for d in docs if d.get("contact_id")}
    mids = {d["matter_id"] for d in docs if d.get("matter_id")}
    contacts = {c["id"]: _display_name(c) async for c in db.practice_contacts.find({"id": {"$in": list(cids)}}, {"_id": 0})}
    matters = {m["id"]: m["name"] async for m in db.practice_matters.find({"id": {"$in": list(mids)}}, {"_id": 0, "id": 1, "name": 1})}
    return [{**d, "contact_name": contacts.get(d.get("contact_id"), ""), "matter_name": matters.get(d.get("matter_id"), ""),
             **({"billing_status": _te_status(d)} if "hours" in d else {})} for d in docs]


@router.post("/tasks")
async def create_task(inp: PracticeTaskIn, user: dict = Depends(_guard)):
    if not inp.subject.strip():
        raise HTTPException(400, "Subject is required.")
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "kind": "task", "created_at": now, "updated_at": now}
    if doc["all_day"]:
        doc["due_time"] = None
    if inp.save_reminders and inp.reminders:
        await db.practice_profiles.update_one({"user_id": user["id"]}, {"$set": {"default_reminders": doc["reminders"]}}, upsert=True)
    await db.practice_tasks.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.put("/tasks/{task_id}")
async def update_task(task_id: str, inp: PracticeTaskIn, user: dict = Depends(_guard)):
    data = {**inp.model_dump(), "updated_at": datetime.now(timezone.utc).isoformat()}
    if data["all_day"]:
        data["due_time"] = None
    r = await db.practice_tasks.update_one({"id": task_id, "owner_id": user["id"]}, {"$set": data})
    if not r.matched_count:
        raise HTTPException(404, "Task not found")
    return await db.practice_tasks.find_one({"id": task_id}, {"_id": 0})


@router.patch("/tasks/{task_id}/status")
async def set_task_status(task_id: str, body: dict, user: dict = Depends(_guard)):
    r = await db.practice_tasks.update_one({"id": task_id, "owner_id": user["id"]},
                                           {"$set": {"status": body.get("status", "Completed"), "updated_at": datetime.now(timezone.utc).isoformat()}})
    if not r.matched_count:
        raise HTTPException(404, "Task not found")
    return await db.practice_tasks.find_one({"id": task_id}, {"_id": 0})


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, user: dict = Depends(_guard)):
    r = await db.practice_tasks.delete_one({"id": task_id, "owner_id": user["id"]})
    if not r.deleted_count:
        raise HTTPException(404, "Task not found")
    return {"ok": True}


class PracticeTimeEntryIn(BaseModel):
    contact_id: str
    matter_id: str
    task_id: Optional[str] = None
    item: str = ""
    hours: float = Field(..., ge=0)
    hours_raw: str = ""
    date: str
    description: str = ""
    billable: bool = True
    billed_by: str = ""
    hourly_rate: float = 0
    total: float = 0
    private_notes: str = ""


def parse_hours(raw: str) -> Optional[float]:
    """Accepts '1h 10m', '1:10', '1.2h', '45m', '1.5'."""
    import re
    s = (raw or "").strip().lower()
    if not s:
        return None
    if ":" in s:
        h, m = s.split(":", 1)
        return int(h or 0) + int(m or 0) / 60
    hrs = re.search(r"([\d.]+)\s*h", s)
    mins = re.search(r"([\d.]+)\s*m", s)
    if hrs or mins:
        return (float(hrs.group(1)) if hrs else 0) + (float(mins.group(1)) if mins else 0) / 60
    try:
        return float(s)
    except ValueError:
        return None


@router.post("/time-entries/parse")
async def parse_hours_api(body: dict, user: dict = Depends(_guard)):
    h = parse_hours(body.get("raw", ""))
    if h is None:
        raise HTTPException(400, "Use a format like 1h 10m, 1:10 or 1.2h")
    return {"hours": round(h, 4)}


@router.get("/time-entries")
async def list_time_entries(contact_id: Optional[str] = None, matter_id: Optional[str] = None, user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if contact_id:
        q["contact_id"] = contact_id
    if matter_id:
        q["matter_id"] = matter_id
    return await db.practice_time_entries.find(q, {"_id": 0}).sort("date", -1).to_list(2000)


@router.post("/time-entries")
async def create_time_entry(inp: PracticeTimeEntryIn, user: dict = Depends(_guard)):
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(),
           "total": round(inp.hours * inp.hourly_rate, 2) if inp.billable else 0, "created_at": now}
    await db.practice_time_entries.insert_one(doc)
    doc.pop("_id", None)
    return doc


async def _counts(user_id: str, **match) -> dict:
    q = {"owner_id": user_id, **match}
    return {
        "matters": await db.practice_matters.count_documents(q) if "contact_id" in match and "matter_id" not in match else None,
        "activities": await db.practice_tasks.count_documents(q),
        "time": await db.practice_time_entries.count_documents(q),
    }


class PracticeTaxIn(BaseModel):
    name: str
    rate: float = Field(..., ge=0)
    description: str = ""
    compound: bool = False


class PracticeItemIn(BaseModel):
    name: str
    code: str = ""
    description: str = ""
    price: float = Field(0, ge=0)
    use_item_price: bool = False
    tax1_id: Optional[str] = None
    tax2_id: Optional[str] = None


async def _simple_list(coll, user):
    return await coll.find({"owner_id": user["id"]}, {"_id": 0}).sort("name", 1).to_list(500)


async def _simple_create(coll, inp, user):
    if not inp.name.strip():
        raise HTTPException(400, "Name is required.")
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "created_at": datetime.now(timezone.utc).isoformat()}
    await coll.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/taxes")
async def list_taxes(user: dict = Depends(_guard)):
    return await _simple_list(db.practice_taxes, user)


@router.post("/taxes")
async def create_tax(inp: PracticeTaxIn, user: dict = Depends(_guard)):
    return await _simple_create(db.practice_taxes, inp, user)


@router.get("/items")
async def list_items(user: dict = Depends(_guard)):
    return await _simple_list(db.practice_items, user)


@router.post("/items")
async def create_item(inp: PracticeItemIn, user: dict = Depends(_guard)):
    return await _simple_create(db.practice_items, inp, user)


async def _te_full(docs: list) -> list:
    cids = {d["contact_id"] for d in docs if d.get("contact_id")}
    mids = {d["matter_id"] for d in docs if d.get("matter_id")}
    iids = {d["invoice_id"] for d in docs if d.get("invoice_id")}
    contacts = {c["id"]: _display_name(c) async for c in db.practice_contacts.find({"id": {"$in": list(cids)}}, {"_id": 0})}
    matters = {m["id"]: m["name"] async for m in db.practice_matters.find({"id": {"$in": list(mids)}}, {"_id": 0, "id": 1, "name": 1})}
    invoices = {i["id"]: i.get("number") async for i in db.practice_invoices.find({"id": {"$in": list(iids)}}, {"_id": 0, "id": 1, "number": 1})}
    return [{**d, "contact_name": contacts.get(d.get("contact_id"), ""), "matter_name": matters.get(d.get("matter_id"), ""),
             "invoice_number": invoices.get(d.get("invoice_id")), "billing_status": _te_status(d)} for d in docs]


@router.get("/time-entries/all")
async def list_time_entries_full(user: dict = Depends(_guard)):
    docs = await db.practice_time_entries.find({"owner_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(2000)
    return await _te_full(docs)


@router.get("/time-entries/{entry_id}")
async def get_time_entry(entry_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_time_entries.find_one({"id": entry_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Time entry not found")
    return (await _te_full([doc]))[0]


@router.delete("/time-entries/{entry_id}")
async def delete_time_entry(entry_id: str, user: dict = Depends(_guard)):
    r = await db.practice_time_entries.delete_one({"id": entry_id, "owner_id": user["id"]})
    if not r.deleted_count:
        raise HTTPException(404, "Time entry not found")
    return {"ok": True}


class PracticeEventIn(BaseModel):
    contact_id: Optional[str] = None
    matter_id: Optional[str] = None
    subject: str
    start_date: str
    start_time: Optional[str] = "10:00"
    end_date: str
    end_time: Optional[str] = "11:00"
    all_day: bool = False
    description: str = ""
    reminders: list[PracticeReminder] = Field(default_factory=list)
    private: bool = False
    location: str = ""
    color: str = "#1E88E5"
    priority: str = "Medium"
    repeat: str = "Never"
    assigned_users: list[str] = Field(default_factory=list)
    assigned_contacts: str = ""
    tags: list[str] = Field(default_factory=list)
    email_assignees: bool = True


def _event_doc(inp: PracticeEventIn) -> dict:
    d = inp.model_dump()
    if d["all_day"]:
        d["start_time"] = d["end_time"] = None
    return {**d, "kind": "event", "due_date": d["start_date"], "due_time": d["start_time"], "status": "Scheduled"}


@router.get("/events/conflicts")
async def event_conflicts(date: str, start: str = "00:00", end: str = "23:59", exclude: Optional[str] = None, user: dict = Depends(_guard)):
    q = {"owner_id": user["id"], "kind": "event", "start_date": date}
    if exclude:
        q["id"] = {"$ne": exclude}
    out = []
    async for e in db.practice_tasks.find(q, {"_id": 0, "id": 1, "subject": 1, "start_time": 1, "end_time": 1, "all_day": 1, "assigned_users": 1}):
        if e.get("all_day") or ((e.get("start_time") or "00:00") < end and (e.get("end_time") or "23:59") > start):
            out.append(e)
    return out


@router.post("/events")
async def create_event(inp: PracticeEventIn, user: dict = Depends(_guard)):
    if not inp.subject.strip():
        raise HTTPException(400, "Subject is required.")
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **_event_doc(inp), "created_at": now, "updated_at": now}
    await db.practice_tasks.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.put("/events/{event_id}")
async def update_event(event_id: str, inp: PracticeEventIn, user: dict = Depends(_guard)):
    r = await db.practice_tasks.update_one({"id": event_id, "owner_id": user["id"]}, {"$set": {**_event_doc(inp), "updated_at": datetime.now(timezone.utc).isoformat()}})
    if not r.matched_count:
        raise HTTPException(404, "Event not found")
    return await db.practice_tasks.find_one({"id": event_id}, {"_id": 0})


def _te_status(doc: dict) -> str:
    return doc.get("billing_status") or ("Billable" if doc.get("billable", True) else "Not Billable")


@router.patch("/time-entries/{entry_id}/status")
async def set_time_entry_status(entry_id: str, body: dict, user: dict = Depends(_guard)):
    status = body.get("status")
    if status not in ("Billable", "Billed", "Not Billable"):
        raise HTTPException(400, "Invalid status")
    doc = await db.practice_time_entries.find_one({"id": entry_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Time entry not found")
    billable = status != "Not Billable"
    total = round(doc.get("hours", 0) * doc.get("hourly_rate", 0), 2) if billable else 0
    await db.practice_time_entries.update_one({"id": entry_id}, {"$set": {"billing_status": status, "billable": billable, "total": total}})
    return {**doc, "billing_status": status, "billable": billable, "total": total}


@router.post("/time-entries/{entry_id}/clone")
async def clone_time_entry(entry_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_time_entries.find_one({"id": entry_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Time entry not found")
    new = {**doc, "id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_time_entries.insert_one(new)
    new.pop("_id", None)
    return new


@router.put("/time-entries/{entry_id}")
async def update_time_entry(entry_id: str, inp: PracticeTimeEntryIn, user: dict = Depends(_guard)):
    doc = await db.practice_time_entries.find_one({"id": entry_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Time entry not found")
    status = _te_status(doc) if inp.billable else "Not Billable"
    if inp.billable and status == "Not Billable":
        status = "Billable"
    data = {**inp.model_dump(), "billing_status": status, "total": round(inp.hours * inp.hourly_rate, 2) if inp.billable else 0,
            "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_time_entries.update_one({"id": entry_id}, {"$set": data})
    return {**doc, **data}


@router.get("/activity")
async def activity_feed(user: dict = Depends(_guard)):
    uid = user["id"]
    out = []
    contacts = {c["id"]: c async for c in db.practice_contacts.find({"owner_id": uid}, {"_id": 0})}
    matters = {m["id"]: m async for m in db.practice_matters.find({"owner_id": uid}, {"_id": 0})}
    def re(cid=None, mid=None, extra=None):
        parts = [{"label": _display_name(contacts[cid]), "to": f"/practice/contacts/{cid}"}] if cid in contacts else []
        if mid in matters:
            parts.append({"label": matters[mid]["name"], "to": f"/practice/matters/{mid}"})
        if extra:
            parts.append({"label": extra})
        return parts
    for c in contacts.values():
        out.append({"at": c["created_at"], "text": f"Created a new client: {_display_name(c)}.", "re": re(c["id"])})
    for m in matters.values():
        out.append({"at": m["created_at"], "text": f"Created a new matter: {m['name']}.", "re": re(m["contact_id"], m["id"])})
    async for t in db.practice_tasks.find({"owner_id": uid}, {"_id": 0}):
        kind = "event" if t.get("kind") == "event" else "task"
        out.append({"at": t["created_at"], "text": f"Created a new {kind}: {t['subject']}.", "re": re(t.get("contact_id"), t.get("matter_id"), t["subject"])})
        if t.get("status") == "Completed":
            out.append({"at": t.get("updated_at") or t["created_at"], "text": f"Completed a task: {t['subject']}.", "re": re(t.get("contact_id"), t.get("matter_id"), t["subject"])})
    async for e in db.practice_time_entries.find({"owner_id": uid}, {"_id": 0}):
        out.append({"at": e["created_at"], "text": f"Created a new time entry: {e.get('hours', 0):.2f} hrs / ${e.get('total', 0):.2f}.", "re": re(e.get("contact_id"), e.get("matter_id"))})
    async for n in db.practice_notes.find({"owner_id": uid}, {"_id": 0}):
        out.append({"at": n["created_at"], "text": n["text"], "re": []})
    out.sort(key=lambda x: x["at"], reverse=True)
    return out[:200]


@router.post("/activity")
async def post_activity(body: dict, user: dict = Depends(_guard)):
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Enter something first.")
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], "text": text, "created_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_notes.insert_one(doc)
    doc.pop("_id", None)
    return doc


# ---------- Invoices ----------
class PracticeInvoiceGenerateIn(BaseModel):
    contact_id: str
    matter_ids: list[str]
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    add_time_entries: bool = True
    add_expenses: bool = True
    add_flat_fees: bool = True
    tax1_id: str = ""
    tax2_id: str = ""
    tax_expenses: bool = False


@router.get("/invoices/preview")
async def invoice_preview(contact_id: str, user: dict = Depends(_guard)):
    contact = await db.practice_contacts.find_one({"id": contact_id, "owner_id": user["id"]}, {"_id": 0})
    if not contact:
        raise HTTPException(404, "Contact not found")
    sums = await _billable_sums(user["id"], "matter_id")
    matters = await db.practice_matters.find({"owner_id": user["id"], "contact_id": contact_id}, {"_id": 0, "id": 1, "name": 1}).sort("created_at", -1).to_list(500)
    return {"contact": {"id": contact_id, "display_name": _display_name(contact)},
            "matters": [{"id": m["id"], "name": m["name"], "billable": sums.get(m["id"], 0)} for m in matters]}


@router.post("/invoices/generate")
async def invoice_generate(inp: PracticeInvoiceGenerateIn, user: dict = Depends(_guard)):
    if not inp.matter_ids:
        raise HTTPException(400, "Select at least one matter.")
    q = {"owner_id": user["id"], "contact_id": inp.contact_id, "matter_id": {"$in": inp.matter_ids}}
    if inp.date_from:
        q.setdefault("date", {})["$gte"] = inp.date_from
    if inp.date_to:
        q.setdefault("date", {})["$lte"] = inp.date_to
    entries = []
    if inp.add_time_entries:
        async for te in db.practice_time_entries.find(q, {"_id": 0}).sort("date", 1):
            if _te_status(te) == "Billable":
                entries.append(te)
    expenses = []
    if inp.add_expenses:
        async for ex in db.practice_expenses.find(q, {"_id": 0}).sort("date", 1):
            if _exp_status(ex) == "Billable":
                expenses.append({"id": ex["id"], "item": ex.get("category") or ex.get("cost_type", "Expense"), "description": ex.get("description", ""), "date": ex["date"],
                                 "billed_by": ex.get("billed_by", ""), "qty": ex.get("qty", 1), "price": ex.get("price", 0), "sub": ex.get("total", 0)})
    now = datetime.now(timezone.utc)
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], "status": "Draft", "number": None,
           "contact_id": inp.contact_id, "matter_ids": inp.matter_ids, "template": "Default Invoice Template", "submit_for_approval": False,
           "date": now.date().isoformat(), "due_date": (now + timedelta(days=29)).date().isoformat(), "discount": 0.0,
           "time_entries": [{"id": te["id"], "item": te.get("item") or "Time", "description": te.get("description", ""), "date": te["date"],
                             "billed_by": te.get("billed_by", ""), "hours": te.get("hours", 0), "rate": te.get("hourly_rate", 0), "sub": te.get("total", 0)} for te in entries],
           "expenses": expenses, "flat_fees": [], "tax1_id": inp.tax1_id, "tax2_id": inp.tax2_id, "tax_expenses": inp.tax_expenses, "paid": 0.0,
           "notes": "", "terms": "", "pay_operating": True, "pay_trust": False, "send_reminders": True, "add_unpaid": False, "add_interest": False,
           "created_at": now.isoformat(), "updated_at": now.isoformat()}
    await db.practice_invoices.insert_one(doc)
    doc.pop("_id", None)
    return doc


def _inv_totals(doc: dict) -> dict:
    sub = sum(t.get("sub", 0) for t in doc.get("time_entries", [])) + sum(e.get("sub", 0) for e in doc.get("expenses", [])) + sum(f.get("sub", 0) for f in doc.get("flat_fees", []))
    total = round(sub * (1 - (doc.get("discount") or 0) / 100), 2)
    paid = round(doc.get("paid", 0), 2)
    return {"total": total, "paid": paid, "balance": round(total - paid, 2)}


async def _inv_out(doc: dict, user: dict) -> dict:
    contact = await db.practice_contacts.find_one({"id": doc["contact_id"]}, {"_id": 0})
    matters = await db.practice_matters.find({"id": {"$in": doc["matter_ids"]}}, {"_id": 0, "id": 1, "name": 1}).to_list(50)
    prof = await db.practice_profiles.find_one({"user_id": user["id"]}, {"_id": 0}) or {}
    firm = {"name": user.get("company_name") or user.get("firm_name") or user.get("name", ""), "email": prof.get("email") or user.get("email", ""), "phone": prof.get("office_phone", "")}
    return {**doc, **_inv_totals(doc), "contact_name": _display_name(contact) if contact else "", "matters": matters, "firm": firm}


@router.get("/invoices")
async def list_invoices(contact_id: Optional[str] = None, user: dict = Depends(_guard)):
    q = {"owner_id": user["id"], "status": {"$ne": "Draft"}}
    if contact_id:
        q["contact_id"] = contact_id
    docs = await db.practice_invoices.find(q, {"_id": 0}).sort("number", -1).to_list(2000)
    out = [await _inv_out(d, user) for d in docs]
    today = datetime.now(timezone.utc).date().isoformat()
    return {"rows": out, "all": round(sum(o["total"] for o in out), 2), "due": round(sum(o["balance"] for o in out), 2),
            "overdue": round(sum(o["balance"] for o in out if o["balance"] > 0 and (o.get("due_date") or "") < today), 2)}


@router.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_invoices.find_one({"id": invoice_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Invoice not found")
    saved = await db.practice_invoices.find({"owner_id": user["id"], "status": {"$ne": "Draft"}}, {"_id": 0, "id": 1}).sort("number", 1).to_list(2000)
    ids = [d["id"] for d in saved]
    i = ids.index(invoice_id) if invoice_id in ids else -1
    return {**(await _inv_out(doc, user)), "prev_id": ids[i - 1] if i > 0 else None, "next_id": ids[i + 1] if 0 <= i < len(ids) - 1 else None}


@router.post("/invoices/{invoice_id}/save")
async def save_invoice(invoice_id: str, body: dict, user: dict = Depends(_guard)):
    doc = await db.practice_invoices.find_one({"id": invoice_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Invoice not found")
    allowed = {k: v for k, v in body.items() if k in INVOICE_FIELDS}
    number = doc.get("number") or allowed.get("number")
    if not number:
        last = await db.practice_invoices.find({"owner_id": user["id"], "number": {"$ne": None}}, {"_id": 0, "number": 1}).sort("number", -1).to_list(1)
        number = (last[0]["number"] if last else 0) + 1
    allowed.update({"number": number, "status": "Saved", "saved_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()})
    await db.practice_invoices.update_one({"id": invoice_id}, {"$set": allowed})
    te_ids = [t["id"] for t in allowed.get("time_entries", doc.get("time_entries", []))]
    if te_ids:
        await db.practice_time_entries.update_many({"id": {"$in": te_ids}, "owner_id": user["id"]}, {"$set": {"billing_status": "Billed", "invoice_id": invoice_id}})
    ex_ids = [e["id"] for e in allowed.get("expenses", doc.get("expenses", []))]
    if ex_ids:
        await db.practice_expenses.update_many({"id": {"$in": ex_ids}, "owner_id": user["id"]}, {"$set": {"billing_status": "Billed", "invoice_id": invoice_id}})
    return await get_invoice(invoice_id, user)


@router.delete("/invoices/{invoice_id}")
async def delete_invoice(invoice_id: str, user: dict = Depends(_guard)):
    r = await db.practice_invoices.delete_one({"id": invoice_id, "owner_id": user["id"]})
    if not r.deleted_count:
        raise HTTPException(404, "Invoice not found")
    await db.practice_time_entries.update_many({"invoice_id": invoice_id, "owner_id": user["id"]}, {"$set": {"billing_status": "Billable"}, "$unset": {"invoice_id": ""}})
    await db.practice_expenses.update_many({"invoice_id": invoice_id, "owner_id": user["id"]}, {"$set": {"billing_status": "Billable"}, "$unset": {"invoice_id": ""}})
    return {"ok": True}


INVOICE_FIELDS = ("template", "submit_for_approval", "date", "due_date", "discount", "time_entries", "expenses", "flat_fees", "number", "matter_ids",
                  "notes", "terms", "pay_operating", "pay_trust", "send_reminders", "add_unpaid", "add_interest")


@router.put("/invoices/{invoice_id}")
async def update_invoice(invoice_id: str, body: dict, user: dict = Depends(_guard)):
    allowed = {k: v for k, v in body.items() if k in INVOICE_FIELDS}
    allowed["updated_at"] = datetime.now(timezone.utc).isoformat()
    r = await db.practice_invoices.update_one({"id": invoice_id, "owner_id": user["id"]}, {"$set": allowed})
    if not r.matched_count:
        raise HTTPException(404, "Invoice not found")
    return await get_invoice(invoice_id, user)


# ---------- Expenses ----------
EXPENSE_CATEGORIES = [
    ("E101", "Copying"), ("E102", "Outside printing"), ("E103", "Word processing"), ("E104", "Facsimile"), ("E105", "Telephone"),
    ("E106", "Online research"), ("E107", "Delivery services/messengers"), ("E108", "Postage"), ("E109", "Local travel"), ("E110", "Out-of-town travel"),
    ("E111", "Meals"), ("E112", "Court fees"), ("E113", "Subpoena fees"), ("E114", "Witness fees"), ("E115", "Deposition transcripts"),
    ("E116", "Trial transcripts"), ("E117", "Trial exhibits"), ("E118", "Litigation support vendors"), ("E119", "Experts"), ("E120", "Private investigators"),
    ("E121", "Arbitrators/mediators"), ("E122", "Local counsel"), ("E123", "Other professionals"), ("E124", "Other"),
]


class PracticeExpenseIn(BaseModel):
    contact_id: str
    matter_id: str
    cost_type: str = "Soft Cost"
    date: str
    qty: float = 1
    price: float
    description: str = ""
    category: str = ""
    receipt_name: str = ""
    billable: bool = True
    billed_by: str = ""
    private_notes: str = ""
    account: str = ""
    payee: str = ""
    payment_method: str = ""
    payment_notes: str = ""


def _exp_status(doc: dict) -> str:
    return doc.get("billing_status") or ("Billable" if doc.get("billable", True) else "Not Billable")


async def _exp_names(docs: list) -> list:
    cids = {d["contact_id"] for d in docs if d.get("contact_id")}
    mids = {d["matter_id"] for d in docs if d.get("matter_id")}
    contacts = {c["id"]: _display_name(c) async for c in db.practice_contacts.find({"id": {"$in": list(cids)}}, {"_id": 0})}
    matters = {m["id"]: m["name"] async for m in db.practice_matters.find({"id": {"$in": list(mids)}}, {"_id": 0, "id": 1, "name": 1})}
    return [{**d, "contact_name": contacts.get(d.get("contact_id"), ""), "matter_name": matters.get(d.get("matter_id"), ""), "billing_status": _exp_status(d)} for d in docs]


async def _categories(uid: str) -> list:
    doc = await db.practice_expense_categories.find_one({"owner_id": uid}, {"_id": 0})
    if doc:
        return doc["categories"]
    cats = sorted([{"code": c, "name": n} for c, n in EXPENSE_CATEGORIES], key=lambda c: c["name"].lower())
    await db.practice_expense_categories.insert_one({"owner_id": uid, "categories": cats})
    return cats


@router.get("/expenses/categories")
async def expense_categories(user: dict = Depends(_guard)):
    return await _categories(user["id"])


class CategoriesIn(BaseModel):
    categories: list[dict]


@router.put("/expenses/categories")
async def save_expense_categories(inp: CategoriesIn, user: dict = Depends(_guard)):
    cats = [{"name": (c.get("name") or "").strip(), "code": (c.get("code") or "").strip()} for c in inp.categories]
    if any(not c["name"] for c in cats):
        raise HTTPException(400, "Every category needs a name.")
    cats.sort(key=lambda c: c["name"].lower())
    await db.practice_expense_categories.update_one({"owner_id": user["id"]}, {"$set": {"categories": cats}}, upsert=True)
    return cats


@router.get("/expenses")
async def list_expenses(contact_id: Optional[str] = None, matter_id: Optional[str] = None, user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if contact_id:
        q["contact_id"] = contact_id
    if matter_id:
        q["matter_id"] = matter_id
    docs = await db.practice_expenses.find(q, {"_id": 0}).sort([("date", -1), ("created_at", -1)]).to_list(2000)
    return await _exp_names(docs)


def _exp_doc(inp: PracticeExpenseIn) -> dict:
    total = round(inp.qty * inp.price, 2)
    return {**inp.model_dump(), "total": total if inp.billable else 0, "amount": total}


@router.post("/expenses")
async def create_expense(inp: PracticeExpenseIn, user: dict = Depends(_guard)):
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **_exp_doc(inp), "billing_status": "Billable" if inp.billable else "Not Billable", "created_at": now, "updated_at": now}
    await db.practice_expenses.insert_one(doc)
    doc.pop("_id", None)
    return (await _exp_names([doc]))[0]


@router.put("/expenses/{expense_id}")
async def update_expense(expense_id: str, inp: PracticeExpenseIn, user: dict = Depends(_guard)):
    doc = await db.practice_expenses.find_one({"id": expense_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Expense not found")
    status = _exp_status(doc) if inp.billable else "Not Billable"
    if inp.billable and status == "Not Billable":
        status = "Billable"
    data = {**_exp_doc(inp), "billing_status": status, "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_expenses.update_one({"id": expense_id}, {"$set": data})
    return (await _exp_names([{**doc, **data}]))[0]


@router.patch("/expenses/{expense_id}/status")
async def set_expense_status(expense_id: str, body: dict, user: dict = Depends(_guard)):
    status = body.get("status")
    if status not in ("Billable", "Billed", "Not Billable"):
        raise HTTPException(400, "Invalid status")
    doc = await db.practice_expenses.find_one({"id": expense_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Expense not found")
    billable = status != "Not Billable"
    data = {"billing_status": status, "billable": billable, "total": doc.get("amount", 0) if billable else 0}
    await db.practice_expenses.update_one({"id": expense_id}, {"$set": data})
    return (await _exp_names([{**doc, **data}]))[0]


@router.post("/expenses/{expense_id}/clone")
async def clone_expense(expense_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_expenses.find_one({"id": expense_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Expense not found")
    new = {**doc, "id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc).isoformat()}
    new.pop("invoice_id", None)
    if new.get("billing_status") == "Billed":
        new["billing_status"] = "Billable"
    await db.practice_expenses.insert_one(new)
    new.pop("_id", None)
    return (await _exp_names([new]))[0]


@router.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: str, user: dict = Depends(_guard)):
    r = await db.practice_expenses.delete_one({"id": expense_id, "owner_id": user["id"]})
    if not r.deleted_count:
        raise HTTPException(404, "Expense not found")
    return {"ok": True}


# ---------- Payments ----------
class PaymentApplication(BaseModel):
    invoice_id: str
    amount: float
    applied_date: Optional[str] = None


class PracticePaymentIn(BaseModel):
    contact_id: str
    matter_id: str = ""
    date: str
    payment_method: str = "Cash"
    bank_account: str = "Operating Account"
    notes: str = ""
    applications: list[PaymentApplication]


@router.post("/payments")
async def add_payment(inp: PracticePaymentIn, user: dict = Depends(_guard)):
    apps = [a for a in inp.applications if a.amount > 0]
    if not apps:
        raise HTTPException(400, "Enter an amount to pay.")
    now = datetime.now(timezone.utc).isoformat()
    for a in apps:
        inv = await db.practice_invoices.find_one({"id": a.invoice_id, "owner_id": user["id"]}, {"_id": 0})
        if not inv:
            raise HTTPException(404, "Invoice not found")
        t = _inv_totals(inv)
        if a.amount > t["balance"] + 0.005:
            raise HTTPException(400, f"Amount exceeds open balance for I-{inv.get('number')}.")
        paid = round(t["paid"] + a.amount, 2)
        status = "Paid" if paid >= t["total"] - 0.005 else "Partially Paid"
        await db.practice_invoices.update_one({"id": a.invoice_id}, {"$set": {"paid": paid, "status": status, "last_payment_date": a.applied_date or inp.date, "updated_at": now}})
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "amount": round(sum(a.amount for a in apps), 2), "created_at": now}
    await db.practice_payments.insert_one(doc)
    doc.pop("_id", None)
    return doc


class PracticeRetainerIn(BaseModel):
    contact_id: str
    matter_id: str = ""
    amount: float
    date: str
    payment_method: str = "Cash"
    bank_account: str = "Operating Account"
    notes: str = ""
    auto_apply: bool = False


@router.post("/retainers")
async def add_retainer(inp: PracticeRetainerIn, user: dict = Depends(_guard)):
    if inp.amount <= 0:
        raise HTTPException(400, "Enter an amount.")
    if not inp.contact_id:
        raise HTTPException(400, "Select a contact.")
    now = datetime.now(timezone.utc).isoformat()
    apps = []
    if inp.auto_apply and inp.bank_account != "Trust Account":
        remaining = round(inp.amount, 2)
        invs = await db.practice_invoices.find({"owner_id": user["id"], "contact_id": inp.contact_id}, {"_id": 0}).sort("date", 1).to_list(500)
        for inv in invs:
            if remaining <= 0:
                break
            t = _inv_totals(inv)
            if t["balance"] <= 0.005:
                continue
            amt = round(min(remaining, t["balance"]), 2)
            paid = round(t["paid"] + amt, 2)
            status = "Paid" if paid >= t["total"] - 0.005 else "Partially Paid"
            await db.practice_invoices.update_one({"id": inv["id"]}, {"$set": {"paid": paid, "status": status, "last_payment_date": inp.date, "updated_at": now}})
            apps.append({"invoice_id": inv["id"], "amount": amt, "applied_date": inp.date})
            remaining = round(remaining - amt, 2)
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "kind": "retainer", "applications": apps, "created_at": now}
    await db.practice_payments.insert_one(doc)
    doc.pop("_id", None)
    return doc


class PracticeCheckIn(BaseModel):
    contact_id: str
    matter_id: str = ""
    amount: float
    bank_account: str = "Operating Account"
    payment_method: str = "Check"
    date: str
    notes: str = ""
    payee: str
    to_print: bool = True


@router.post("/checks")
async def write_check(inp: PracticeCheckIn, user: dict = Depends(_guard)):
    if inp.amount <= 0:
        raise HTTPException(400, "Enter an amount.")
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "created_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_checks.insert_one(doc)
    doc.pop("_id", None)
    return doc


# ---------- Users & Roles ----------
ROLE_FEATURES = [
    ("Contacts", "cvedaVE"), ("Activities (Tasks, Events & Calls)", "cvedVE"), ("Files", "cvedVE"), ("Flat Fee", "cvedVE"), ("Expenses", "cvedVE"),
    ("Recent Activity", "cvedVE"), ("Invoices", "cvedVE"), ("Items", "cved"), ("Contact Payments", "cvedVE"), ("Firm Payments", "cved"),
    ("Financial Summary", "vV"), ("Matters", "cvedaVE"), ("Reports", "v"), ("Roles", "cved"), ("Sales Taxes", "cved"), ("Settings & Billing", "ve"),
    ("Time Entries", "cvedVE"), ("Users & User Groups", "cvedVE"), ("Bank Accounts", "cved"),
]
PERM_KEYS = {"c": "create", "v": "view", "e": "edit", "d": "delete", "a": "archive", "V": "view_all", "E": "edit_all"}


def _admin_perms() -> dict:
    return {f: {PERM_KEYS[k]: True for k in keys} for f, keys in ROLE_FEATURES}


async def _ensure_admin_role(uid: str) -> dict:
    role = await db.practice_roles.find_one({"owner_id": uid, "name": "Admin"}, {"_id": 0})
    if role:
        return role
    now = datetime.now(timezone.utc).isoformat()
    role = {"id": str(uuid.uuid4()), "owner_id": uid, "name": "Admin", "permissions": _admin_perms(), "restrict_ip": False, "restrict_past_time": False, "system": True, "created_at": now, "updated_at": now}
    await db.practice_roles.insert_one(role)
    role.pop("_id", None)
    return role


async def _ensure_self_user(user: dict) -> None:
    if await db.practice_users.find_one({"owner_id": user["id"], "email": user.get("email")}):
        return
    admin = await _ensure_admin_role(user["id"])
    parts = (user.get("name") or "").split(" ")
    now = datetime.now(timezone.utc).isoformat()
    await db.practice_users.insert_one({"id": str(uuid.uuid4()), "owner_id": user["id"], "first_name": parts[0], "middle_name": "", "last_name": " ".join(parts[1:]),
                                        "email": user.get("email"), "role_id": admin["id"], "active": True, "is_owner": True, "last_login": now, "created_at": now})


@router.get("/roles/features")
async def role_features(user: dict = Depends(_guard)):
    return [{"feature": f, "allowed": [PERM_KEYS[k] for k in keys]} for f, keys in ROLE_FEATURES]


@router.get("/roles")
async def list_roles(user: dict = Depends(_guard)):
    await _ensure_admin_role(user["id"]); await _ensure_self_user(user)
    roles = await db.practice_roles.find({"owner_id": user["id"]}, {"_id": 0}).sort("name", 1).to_list(200)
    counts: dict = {}
    async for u in db.practice_users.find({"owner_id": user["id"]}, {"_id": 0, "role_id": 1}):
        counts[u.get("role_id")] = counts.get(u.get("role_id"), 0) + 1
    return [{**r, "users": counts.get(r["id"], 0)} for r in roles]


class PracticeRoleIn(BaseModel):
    name: str
    permissions: dict
    restrict_ip: bool = False
    restrict_past_time: bool = False


@router.post("/roles")
async def create_role(inp: PracticeRoleIn, user: dict = Depends(_guard)):
    if not inp.name.strip():
        raise HTTPException(400, "Enter a role name.")
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "system": False, "created_at": now, "updated_at": now}
    await db.practice_roles.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/roles/{role_id}")
async def get_role(role_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_roles.find_one({"id": role_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Role not found")
    return doc


@router.put("/roles/{role_id}")
async def update_role(role_id: str, inp: PracticeRoleIn, user: dict = Depends(_guard)):
    r = await db.practice_roles.update_one({"id": role_id, "owner_id": user["id"]}, {"$set": {**inp.model_dump(), "updated_at": datetime.now(timezone.utc).isoformat()}})
    if not r.matched_count:
        raise HTTPException(404, "Role not found")
    return await get_role(role_id, user)


class PracticeUserIn(BaseModel):
    first_name: str = ""
    middle_name: str = ""
    last_name: str = ""
    email: str
    hourly_rate: float = 0
    round_time_entries: bool = False
    time_zone: str = "(UTC-08:00) Pacific Time (US & Canada)"
    role_id: str
    job_title: str = ""
    notes: str = ""
    address: str = ""
    mobile: str = ""
    home: str = ""
    work: str = ""
    fax: str = ""
    active: bool = True


async def _users_out(uid: str, docs: list) -> list:
    roles = {r["id"]: r["name"] async for r in db.practice_roles.find({"owner_id": uid}, {"_id": 0, "id": 1, "name": 1})}
    return [{**d, "name": " ".join(p for p in [d.get("first_name"), d.get("middle_name"), d.get("last_name")] if p), "role_name": roles.get(d.get("role_id"), "")} for d in docs]


@router.get("/users")
async def list_users(user: dict = Depends(_guard)):
    await _ensure_admin_role(user["id"]); await _ensure_self_user(user)
    await db.practice_users.update_one({"owner_id": user["id"], "is_owner": True}, {"$set": {"last_login": user.get("last_login") or datetime.now(timezone.utc).isoformat()}})
    docs = await db.practice_users.find({"owner_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(500)
    acct_ids = [d["account_id"] for d in docs if d.get("account_id")]
    logins = {a["id"]: a.get("last_login") async for a in db.users.find({"id": {"$in": acct_ids}}, {"_id": 0, "id": 1, "last_login": 1})}
    docs = [{**d, "last_login": logins.get(d.get("account_id")) or d.get("last_login")} for d in docs]
    return await _users_out(user["id"], docs)


@router.post("/users")
async def create_user(inp: PracticeUserIn, user: dict = Depends(_guard)):
    email = inp.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Enter a valid email address.")
    if await db.practice_users.find_one({"owner_id": user["id"], "email": email}):
        raise HTTPException(400, "A user with this email already exists.")
    if not await db.practice_roles.find_one({"id": inp.role_id, "owner_id": user["id"]}):
        raise HTTPException(400, "Select a role.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "An account with this email already exists.")
    import secrets as _secrets
    from routes.auth import mint_password_set_token
    from email_dispatcher import dispatch, public_base_url
    import email_templates as _tmpl
    now = datetime.now(timezone.utc).isoformat()
    name = " ".join(p for p in [inp.first_name, inp.middle_name, inp.last_name] if p) or email.split("@")[0]
    account = {"id": str(uuid.uuid4()), "email": email, "name": name, "role": "practice", "practice_owner_id": user["id"],
               "password": hash_password(_secrets.token_urlsafe(24)), "status": "invited", "created_at": now, "updated_at": now}
    await db.users.insert_one(account)
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], **inp.model_dump(), "email": email, "account_id": account["id"], "last_login": None, "created_at": now}
    await db.practice_users.insert_one(doc)
    doc.pop("_id", None)
    role = await db.practice_roles.find_one({"id": inp.role_id}, {"_id": 0, "name": 1})
    invite_sent = False
    try:
        token = await mint_password_set_token(account["id"], purpose="welcome", ttl_days=7)
        subject, html = _tmpl.team_invite(invitee_name=name, inviter_name=user.get("name") or "Your firm", role_label=(role or {}).get("name", "User"),
                                          role_description="Sign in to Practice to manage matters, contacts, calendar, time and billing.",
                                          company_names=[], magic_url=f"{public_base_url()}/set-password/{token}", brand_name="Practice")
        r = await dispatch(kind="practice_invite", to=email, subject=subject, html=html, initiating_user_id=user["id"], related={"purpose": "practice_invite"})
        invite_sent = bool((r or {}).get("ok", True)) and (r or {}).get("status") != "failed"
    except Exception:
        logging.getLogger(__name__).exception("Practice invite email failed for %s", email)
    return {**(await _users_out(user["id"], [doc]))[0], "invite_sent": invite_sent}


@router.post("/users/{puser_id}/resend-invite")
async def resend_invite(puser_id: str, user: dict = Depends(_guard)):
    doc = await db.practice_users.find_one({"id": puser_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc or not doc.get("account_id"):
        raise HTTPException(404, "User not found")
    from routes.auth import mint_password_set_token
    from email_dispatcher import dispatch, public_base_url
    import email_templates as _tmpl
    token = await mint_password_set_token(doc["account_id"], purpose="welcome", ttl_days=7)
    name = " ".join(p for p in [doc.get("first_name"), doc.get("last_name")] if p) or doc["email"]
    subject, html = _tmpl.team_invite(invitee_name=name, inviter_name=user.get("name") or "Your firm", role_label="User",
                                      role_description="Sign in to Practice to manage matters, contacts, calendar, time and billing.",
                                      company_names=[], magic_url=f"{public_base_url()}/set-password/{token}", brand_name="Practice")
    r = await dispatch(kind="practice_invite", to=doc["email"], subject=subject, html=html, initiating_user_id=user["id"], related={"purpose": "practice_invite"})
    return {"ok": True, "result": r}


# ---------- Bank accounts & ledger ----------
async def _ensure_accounts(user: dict) -> None:
    if await db.practice_bank_accounts.find_one({"owner_id": user["id"]}):
        return
    now = datetime.now(timezone.utc).isoformat()
    await db.practice_bank_accounts.insert_many([
        {"id": str(uuid.uuid4()), "owner_id": user["id"], "name": "Operating Account", "type": "Operating Account", "default": True, "status": "Active", "created_by": user.get("name", ""), "created_at": now},
        {"id": str(uuid.uuid4()), "owner_id": user["id"], "name": "Trust Account", "type": "Trust Account", "default": True, "status": "Active", "created_by": user.get("name", ""), "created_at": now},
    ])


async def _ledger(uid: str) -> list:
    rows = []
    async for p in db.practice_payments.find({"owner_id": uid}, {"_id": 0}):
        rows.append({"src": "payment", "id": p["id"], "type": "Payment", "notes": p.get("notes", ""), "date": p["date"], "amount": p.get("amount", 0), "method": p.get("payment_method", ""),
                     "contact_id": p.get("contact_id"), "matter_id": p.get("matter_id"), "payee": "", "account": p.get("bank_account", "Operating Account"), "reconciled": p.get("reconciled", False),
                     "deposit_date": p.get("deposit_date"), "print_queue": False, "check_no": None, "created_at": p.get("created_at", ""), "kind": p.get("kind", "payment")})
    async for e in db.practice_expenses.find({"owner_id": uid, "cost_type": "Hard Cost"}, {"_id": 0}):
        rows.append({"src": "expense", "id": e["id"], "type": "Expense", "notes": e.get("payment_notes") or "", "date": e["date"], "amount": -(e.get("amount") or 0), "method": e.get("payment_method", ""),
                     "contact_id": e.get("contact_id"), "matter_id": e.get("matter_id"), "payee": e.get("payee", ""), "account": e.get("account") or "Operating Account", "reconciled": e.get("reconciled", False),
                     "deposit_date": None, "print_queue": e.get("payment_method") == "Check" and e.get("to_print", True) and not e.get("check_no"), "check_no": e.get("check_no"), "created_at": e.get("created_at", "")})
    async for c in db.practice_checks.find({"owner_id": uid}, {"_id": 0}):
        rows.append({"src": "check", "id": c["id"], "type": "Check", "notes": c.get("notes", ""), "date": c["date"], "amount": -(c.get("amount") or 0), "method": c.get("payment_method", "Check"),
                     "contact_id": c.get("contact_id"), "matter_id": c.get("matter_id"), "payee": c.get("payee", ""), "account": c.get("bank_account", "Operating Account"), "reconciled": c.get("reconciled", False),
                     "deposit_date": None, "print_queue": c.get("payment_method") == "Check" and c.get("to_print", True) and not c.get("check_no"), "check_no": c.get("check_no"), "created_at": c.get("created_at", "")})
    rows.sort(key=lambda r: r["created_at"])
    ids = {r["contact_id"] for r in rows if r.get("contact_id")} | {r["payee"] for r in rows if r.get("payee")}
    mids = {r["matter_id"] for r in rows if r.get("matter_id")}
    contacts = {c["id"]: _display_name(c) async for c in db.practice_contacts.find({"id": {"$in": list(ids)}}, {"_id": 0})}
    matters = {m["id"]: m["name"] async for m in db.practice_matters.find({"id": {"$in": list(mids)}}, {"_id": 0, "id": 1, "name": 1})}
    out = []
    for i, r in enumerate(rows):
        out.append({**r, "ref": f"P-{1000 + i}", "contact_name": contacts.get(r.get("contact_id"), ""), "matter_name": matters.get(r.get("matter_id"), ""),
                    "payee_name": contacts.get(r.get("payee"), r.get("payee") or ""), "fees": 0})
    out.sort(key=lambda r: (r["date"], r["created_at"]), reverse=True)
    return out


_SRC = {"payment": "practice_payments", "expense": "practice_expenses", "check": "practice_checks"}


@router.get("/ledger")
async def ledger(user: dict = Depends(_guard)):
    await _ensure_accounts(user)
    return await _ledger(user["id"])


@router.patch("/ledger/{src}/{item_id}")
async def ledger_update(src: str, item_id: str, body: dict, user: dict = Depends(_guard)):
    if src not in _SRC:
        raise HTTPException(404, "Not found")
    allowed = {k: v for k, v in body.items() if k in ("reconciled", "deposit_date", "check_no", "to_print")}
    if "reconciled" in allowed:
        allowed["reconciled_at"] = datetime.now(timezone.utc).isoformat() if allowed["reconciled"] else None
    r = await db[_SRC[src]].update_one({"id": item_id, "owner_id": user["id"]}, {"$set": allowed})
    if not r.matched_count:
        raise HTTPException(404, "Not found")
    return {"ok": True}


class PrintChecksIn(BaseModel):
    items: list[dict]
    start_number: int = 100


@router.post("/checks/print")
async def print_checks(inp: PrintChecksIn, user: dict = Depends(_guard)):
    n = inp.start_number
    for it in inp.items:
        if it.get("src") in _SRC:
            await db[_SRC[it["src"]]].update_one({"id": it.get("id"), "owner_id": user["id"]}, {"$set": {"check_no": n, "to_print": False}})
            n += 1
    return {"ok": True, "last_number": n - 1}


@router.get("/bank-accounts")
async def bank_accounts(user: dict = Depends(_guard)):
    await _ensure_accounts(user)
    rows = await _ledger(user["id"])
    accts = await db.practice_bank_accounts.find({"owner_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(100)
    return [{**a, "balance": round(sum(r["amount"] for r in rows if r["account"] == a["name"]), 2),
             "unreconciled": sum(1 for r in rows if r["account"] == a["name"] and not r["reconciled"])} for a in accts]


class BankAccountIn(BaseModel):
    name: str
    type: str = "Operating Account"


@router.post("/bank-accounts")
async def create_bank_account(inp: BankAccountIn, user: dict = Depends(_guard)):
    if not inp.name.strip():
        raise HTTPException(400, "Enter an account name.")
    doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], "name": inp.name.strip(), "type": inp.type, "default": False, "status": "Active", "created_by": user.get("name", ""), "created_at": datetime.now(timezone.utc).isoformat()}
    await db.practice_bank_accounts.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.put("/users/{puser_id}")
async def update_user(puser_id: str, body: dict, user: dict = Depends(_guard)):
    allowed = {k: v for k, v in body.items() if k in ("first_name", "middle_name", "last_name", "hourly_rate", "round_time_entries", "time_zone", "role_id", "job_title", "notes", "address", "mobile", "home", "work", "fax", "active")}
    if "role_id" in allowed and not await db.practice_roles.find_one({"id": allowed["role_id"], "owner_id": user["id"]}):
        raise HTTPException(400, "Select a role.")
    r = await db.practice_users.update_one({"id": puser_id, "owner_id": user["id"]}, {"$set": allowed})
    if not r.matched_count:
        raise HTTPException(404, "User not found")
    doc = await db.practice_users.find_one({"id": puser_id}, {"_id": 0})
    return (await _users_out(user["id"], [doc]))[0]


@router.get("/ledger/{src}/{item_id}")
async def ledger_item(src: str, item_id: str, user: dict = Depends(_guard)):
    rows = await _ledger(user["id"])
    row = next((r for r in rows if r["src"] == src and r["id"] == item_id), None)
    if not row:
        raise HTTPException(404, "Not found")
    doc = await db[_SRC[src]].find_one({"id": item_id, "owner_id": user["id"]}, {"_id": 0})
    apps = []
    for a in doc.get("applications", []) if src == "payment" else []:
        inv = await db.practice_invoices.find_one({"id": a["invoice_id"]}, {"_id": 0})
        if inv:
            apps.append({"invoice_id": inv["id"], "number": inv.get("number"), "open_balance": _inv_totals(inv)["balance"], "amount": a["amount"], "applied_date": a.get("applied_date") or doc["date"]})
    return {**row, "applications": apps, "detail": doc}


@router.delete("/ledger/{src}/{item_id}")
async def ledger_delete(src: str, item_id: str, user: dict = Depends(_guard)):
    if src not in _SRC:
        raise HTTPException(404, "Not found")
    doc = await db[_SRC[src]].find_one({"id": item_id, "owner_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    if src == "payment":
        for a in doc.get("applications", []):
            inv = await db.practice_invoices.find_one({"id": a["invoice_id"]}, {"_id": 0})
            if inv:
                paid = round(max(0, inv.get("paid", 0) - a["amount"]), 2)
                status = "Paid" if paid >= _inv_totals(inv)["total"] - 0.005 else ("Partially Paid" if paid > 0 else "Saved")
                await db.practice_invoices.update_one({"id": inv["id"]}, {"$set": {"paid": paid, "status": status}})
    await db[_SRC[src]].delete_one({"id": item_id})
    return {"ok": True}
