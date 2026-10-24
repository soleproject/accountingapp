"""Practice product — per-user profile settings (superadmin-only shell for now)."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends

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
