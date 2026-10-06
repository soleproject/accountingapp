from fastapi import APIRouter, Depends, Request

from auth import get_current_user
from deps import require_company
from entitlements import company_entitlements, preview_override, _flag, PREVIEW_CHOICES

router = APIRouter(prefix="/api")


@router.get("/companies/{cid}/entitlements")
async def get_entitlements(cid: str, request: Request, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    ent = await company_entitlements(cid, user, preview_override(request, user))
    ent["preview_switcher"] = _flag("PLAN_PREVIEW_SWITCHER") and user.get("role") in ("superadmin", "pro", "partner", "enterprise")
    ent["preview_choices"] = sorted(PREVIEW_CHOICES) if ent["preview_switcher"] else []
    return ent
