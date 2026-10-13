"""Tax deductibility of expense accounts (book vs tax).

Every expense account carries an effective `deductible_pct` (100 / 50 / 0).
It is stored on the account when known (templates, CoA editor) and
otherwise inferred from the account name so legacy charts work without a
migration. The P&L is NEVER affected — this only feeds the separate
Book-to-Tax Adjustments report and the AI routing prompts.
"""
from __future__ import annotations

import re

ALLOWED_PCTS = (100, 50, 0)

_ENTERTAIN = re.compile(r"entertain", re.I)
_NONDED = re.compile(r"non[\s-]?deductible|not deductible|0%", re.I)
_MEALS = re.compile(r"\bmeals?\b|\bdining\b|\bsubsistence\b", re.I)
_FULL = re.compile(r"100\s*%|fully deductible|staff welfare|office snacks|company (party|event)|de minimis", re.I)
_PENALTY = re.compile(r"\bpenalt|\bfines?\b|political|lobbying", re.I)


def infer_deductible_pct(name: str | None, acct_type: str | None = "expense") -> int:
    """Best-effort default from the account name. Non-expense → 100."""
    if (acct_type or "expense").lower() not in ("expense",):
        return 100
    n = name or ""
    if _NONDED.search(n) or _PENALTY.search(n):
        return 0
    if _ENTERTAIN.search(n):
        return 0
    if _MEALS.search(n):
        return 100 if _FULL.search(n) else 50
    return 100


def effective_deductible_pct(acct: dict) -> int:
    v = acct.get("deductible_pct")
    if v in ALLOWED_PCTS:
        return int(v)
    return infer_deductible_pct(acct.get("name"), acct.get("type"))


# Accounts every chart should have so meals / entertainment are never lumped.
MEALS_ENTERTAINMENT_ACCOUNTS = [
    {"code": "6400", "name": "Meals - Business (50%)", "type": "expense", "detail_type": "expense", "deductible_pct": 50},
    {"code": "6405", "name": "Meals - 100% Deductible", "type": "expense", "detail_type": "expense", "deductible_pct": 100},
    {"code": "6410", "name": "Entertainment - Non-Deductible", "type": "expense", "detail_type": "expense", "deductible_pct": 0},
]
