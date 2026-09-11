"""SmartBooks — Payroll Tax Code Catalog

Curated list of common payroll tax codes for Federal + top-10 US states.
NOT a rate engine — we don't compute the amounts, just give users a
structured list of common tax lines they can drop into an itemized
stub, so:
  • Presets: "+ preset for CA" adds Federal + CA state lines at $0.
  • Reporting: Liability Aging can bucket outstanding by state/agency.
  • Pay Liability: users can filter "Pay California only".

Anything not in this catalog stays as free-text (label + amount) with
`tax_code: null` so the escape hatch is always there.

`applies_to`  = "employee" (withheld) or "employer" (employer-paid)
`category`    = income_tax | payroll_tax | disability | unemployment | local
`agency`      = short human-readable payee for the aging screen
`kind`        = ee_tax | er_tax  (matches the line-kind enum on stubs)
"""

FEDERAL = [
    {"code": "FED_WH",       "label": "Federal Income Tax",       "agency": "IRS",
     "kind": "ee_tax", "applies_to": "employee", "category": "income_tax"},
    {"code": "FICA_EE",      "label": "Social Security (EE 6.2%)", "agency": "IRS",
     "kind": "ee_tax", "applies_to": "employee", "category": "payroll_tax"},
    {"code": "MEDICARE_EE",  "label": "Medicare (EE 1.45%)",       "agency": "IRS",
     "kind": "ee_tax", "applies_to": "employee", "category": "payroll_tax"},
    {"code": "FICA_ER",      "label": "Social Security (ER 6.2%)", "agency": "IRS",
     "kind": "er_tax", "applies_to": "employer", "category": "payroll_tax"},
    {"code": "MEDICARE_ER",  "label": "Medicare (ER 1.45%)",       "agency": "IRS",
     "kind": "er_tax", "applies_to": "employer", "category": "payroll_tax"},
    {"code": "FUTA",         "label": "Federal Unemployment",      "agency": "IRS",
     "kind": "er_tax", "applies_to": "employer", "category": "unemployment"},
]


def _state(state_code, agency_short, taxes):
    """Sugar for building state entries; auto-prefixes label with state."""
    out = []
    for t in taxes:
        out.append({
            "code": f"{state_code}_{t['suffix']}",
            "label": f"{state_code} {t['label']}",
            "agency": agency_short,
            "state": state_code,
            "kind": t.get("kind", "ee_tax"),
            "applies_to": t.get("applies_to", "employee"),
            "category": t["category"],
        })
    return out


STATES = {
    "CA": {"name": "California", "agency": "CA EDD / FTB", "codes": _state("CA", "CA EDD", [
        {"suffix": "SIT",  "label": "Income Tax",              "category": "income_tax"},
        {"suffix": "SDI",  "label": "SDI (EE)",                "category": "disability"},
        {"suffix": "PIT",  "label": "Personal Income Tax WH",  "category": "income_tax"},
        {"suffix": "UI",   "label": "Unemployment (ER)",       "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
        {"suffix": "ETT",  "label": "Employment Training (ER)","category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "NY": {"name": "New York", "agency": "NYS DTF / DOL", "codes": _state("NY", "NY State", [
        {"suffix": "SIT",   "label": "State Income Tax",       "category": "income_tax"},
        {"suffix": "SDI",   "label": "SDI (EE)",               "category": "disability"},
        {"suffix": "PFML",  "label": "Paid Family Leave (EE)", "category": "disability"},
        {"suffix": "SUI",   "label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
        {"suffix": "MCTMT", "label": "Metro Commuter Tax (ER)","category": "local", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "TX": {"name": "Texas", "agency": "TX TWC", "codes": _state("TX", "TX TWC", [
        {"suffix": "SUI",   "label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "FL": {"name": "Florida", "agency": "FL DEO", "codes": _state("FL", "FL DEO", [
        {"suffix": "REEMP", "label": "Reemployment Tax (ER)",  "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "PA": {"name": "Pennsylvania", "agency": "PA DOR / DLI", "codes": _state("PA", "PA DOR", [
        {"suffix": "SIT",   "label": "State Income Tax (3.07%)", "category": "income_tax"},
        {"suffix": "SUI_EE","label": "Unemployment (EE)",      "category": "unemployment"},
        {"suffix": "SUI_ER","label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
        {"suffix": "LST",   "label": "Local Services Tax",     "category": "local"},
    ])},
    "IL": {"name": "Illinois", "agency": "IL DOR / IDES", "codes": _state("IL", "IL DOR", [
        {"suffix": "SIT",   "label": "State Income Tax (4.95%)","category": "income_tax"},
        {"suffix": "SUI",   "label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "OH": {"name": "Ohio", "agency": "OH DOT / ODJFS", "codes": _state("OH", "OH DOT", [
        {"suffix": "SIT",   "label": "State Income Tax",       "category": "income_tax"},
        {"suffix": "SUI",   "label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
        {"suffix": "MUNI",  "label": "Municipal Income Tax",   "category": "local"},
    ])},
    "GA": {"name": "Georgia", "agency": "GA DOR / GDOL", "codes": _state("GA", "GA DOR", [
        {"suffix": "SIT",   "label": "State Income Tax",       "category": "income_tax"},
        {"suffix": "SUI",   "label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "NC": {"name": "North Carolina", "agency": "NC DOR / DES", "codes": _state("NC", "NC DOR", [
        {"suffix": "SIT",   "label": "State Income Tax (4.5%)","category": "income_tax"},
        {"suffix": "SUI",   "label": "Unemployment (ER)",      "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
    ])},
    "WA": {"name": "Washington", "agency": "WA DOR / L&I", "codes": _state("WA", "WA DOR", [
        {"suffix": "PFML",  "label": "Paid Family & Medical Leave", "category": "disability"},
        {"suffix": "LNI",   "label": "L&I Workers' Comp",       "category": "disability"},
        {"suffix": "SUI",   "label": "Unemployment (ER)",       "category": "unemployment", "kind": "er_tax", "applies_to": "employer"},
        {"suffix": "CARES", "label": "Cares Fund (Long-term)",  "category": "disability"},
    ])},
}


def catalog(state: str | None = None) -> dict:
    """Return the tax codes visible for a given state.

    Always includes Federal. When `state` is one of the curated ten,
    appends that state's codes. Unknown or None state → Federal only
    (users can still add free-text lines for uncatalogued states).
    """
    codes = list(FEDERAL)
    s = (state or "").upper().strip()
    entry = STATES.get(s)
    if entry:
        codes.extend(entry["codes"])
    return {
        "federal": FEDERAL,
        "state": (entry and {"code": s, "name": entry["name"],
                             "agency": entry["agency"],
                             "codes": entry["codes"]}) or None,
        "all_states": [{"code": k, "name": v["name"], "agency": v["agency"],
                        "count": len(v["codes"])}
                       for k, v in STATES.items()],
        "combined": codes,
    }


# Reverse lookup used by aging pivot ────────────────────────────────
_BY_CODE: dict[str, dict] = {t["code"]: t for t in FEDERAL}
for st in STATES.values():
    for t in st["codes"]:
        _BY_CODE[t["code"]] = t


def lookup(code: str | None) -> dict | None:
    if not code:
        return None
    return _BY_CODE.get(code)
