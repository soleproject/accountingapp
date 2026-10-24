"""Practice product — per-user profile settings (superadmin-only shell for now)."""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Optional
from pydantic import BaseModel, Field
import uuid
from fastapi import APIRouter, Depends, HTTPException

from db import db
from auth import require_role

router = APIRouter(prefix="/api/practice")
_guard = require_role("superadmin")


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


@router.get("/contacts")
async def list_contacts(status: str = "Active", user: dict = Depends(_guard)):
    q = {"owner_id": user["id"]}
    if status != "All":
        q["status"] = status
    docs = await db.practice_contacts.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [{**d, "display_name": _display_name(d)} for d in docs]


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
    return [await _with_contact(d, user) for d in docs]


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


@router.get("/time-entries/all")
async def list_time_entries_full(user: dict = Depends(_guard)):
    docs = await db.practice_time_entries.find({"owner_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(2000)
    cids = {d["contact_id"] for d in docs if d.get("contact_id")}
    mids = {d["matter_id"] for d in docs if d.get("matter_id")}
    contacts = {c["id"]: _display_name(c) async for c in db.practice_contacts.find({"id": {"$in": list(cids)}}, {"_id": 0})}
    matters = {m["id"]: m["name"] async for m in db.practice_matters.find({"id": {"$in": list(mids)}}, {"_id": 0, "id": 1, "name": 1})}
    return [{**d, "contact_name": contacts.get(d.get("contact_id"), ""), "matter_name": matters.get(d.get("matter_id"), ""),
             **({"billing_status": _te_status(d)} if "hours" in d else {})} for d in docs]


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
