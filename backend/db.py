"""MongoDB helpers and base document utilities."""
from __future__ import annotations
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Annotated, Optional, Any
from bson import ObjectId
from dotenv import load_dotenv
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv(Path(__file__).parent / ".env")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

_client = AsyncIOMotorClient(
    MONGO_URL,
    # Pool sized for 3k-user hardening: default is 100 which caps concurrent
    # Mongo ops per pod. At scale we run ~40 concurrent Plaid syncs plus
    # ~200 concurrent API requests → 200 conns leaves headroom for burst.
    # Override via env for even bigger pods.
    maxPoolSize=int(os.environ.get("MONGO_MAX_POOL_SIZE", "200")),
    minPoolSize=int(os.environ.get("MONGO_MIN_POOL_SIZE", "10")),
    serverSelectionTimeoutMS=5000,
)
db = _client[DB_NAME]


def _to_str(v: Any) -> str:
    if isinstance(v, ObjectId):
        return str(v)
    return str(v) if v is not None else v


PyObjectId = Annotated[str, BeforeValidator(_to_str)]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def coerce(doc: dict | None) -> dict | None:
    if not doc:
        return doc
    d = dict(doc)
    if "_id" in d:
        mongo_id = d.pop("_id")
        # Only use _id as id if the document doesn't already have its own id field
        if "id" not in d or d["id"] is None:
            d["id"] = str(mongo_id)
    return d


class BaseDoc(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    id: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
