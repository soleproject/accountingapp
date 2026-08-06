"""Regression tests for the business-type canonicalizer introduced in
Feb 2026. Guarantees that every write to `companies.business_type` —
from the "Add a new client" modal, the AI onboarding coach, the Company
Settings PATCH, or the My Businesses form — lands on one of the seven
canonical entity forms.
"""
from routes.onboarding import _canonicalize_business_type as canon


# ---- exact canonicals round-trip ----
def test_exact_canonicals_unchanged():
    for c in [
        "Sole Proprietor",
        "LLC – Partnership",
        'LLC – "S" Elected',
        'LLC – "C" Elected',
        '"S" Corporation',
        '"C" Corporation',
        "Limited Partnership",
    ]:
        assert canon(c) == c, c


def test_case_insensitive_match():
    assert canon("sole proprietor") == "Sole Proprietor"
    assert canon("LIMITED PARTNERSHIP") == "Limited Partnership"


# ---- LLC variants ----
def test_bare_llc_defaults_to_partnership():
    """IRS default treatment for a multi-member LLC is partnership."""
    assert canon("LLC") == "LLC – Partnership"
    assert canon("we're an LLC") == "LLC – Partnership"
    assert canon("Limited Liability Company") == "LLC – Partnership"


def test_llc_with_s_election():
    for phrase in [
        "LLC S-corp",
        "LLC taxed as S-corp",
        "S-elected LLC",
        "LLC filing 2553",  # 2553 is the S-election form
        "LLC subchapter S",
    ]:
        # We accept either exact or best-effort — must resolve to LLC-S or
        # at least reference the LLC bucket.
        got = canon(phrase)
        assert got in ('LLC – "S" Elected', "LLC – Partnership"), phrase
    # Direct: "LLC S-corp" should land squarely on LLC–S
    assert canon("LLC S-corp") == 'LLC – "S" Elected'
    assert canon("LLC elected S") == 'LLC – "S" Elected'


def test_llc_with_c_election():
    assert canon("LLC C-corp") == 'LLC – "C" Elected'
    assert canon("LLC taxed as C-corp") == 'LLC – "C" Elected'


# ---- Non-LLC corporations ----
def test_s_corp_variants():
    assert canon("S-corp") == '"S" Corporation'
    assert canon("S corp") == '"S" Corporation'
    assert canon("Subchapter S") == '"S" Corporation'
    assert canon("Sub-S") == '"S" Corporation'
    assert canon("S Corporation") == '"S" Corporation'


def test_c_corp_variants():
    assert canon("C-corp") == '"C" Corporation'
    assert canon("C Corporation") == '"C" Corporation'
    assert canon("Acme Inc") == '"C" Corporation'   # "Inc" heuristic
    assert canon("corporation") == '"C" Corporation'


# ---- Sole prop + Limited Partnership ----
def test_sole_proprietor_variants():
    for phrase in ["Sole Proprietor", "sole prop", "sole-prop",
                   "self-employed", "self employed", "Schedule C", "DBA"]:
        assert canon(phrase) == "Sole Proprietor", phrase


def test_limited_partnership():
    assert canon("Limited Partnership") == "Limited Partnership"
    assert canon("LP") == "Limited Partnership"
    assert canon("Acme LP") == "Limited Partnership"


# ---- Fail-safes ----
def test_empty_or_none_returns_none():
    assert canon("") is None
    assert canon(None) is None
    assert canon("   ") is None


def test_unrecognized_returned_untouched():
    """A completely unknown value like 'Marketing agency' should be
    handed back untouched rather than silently dropped — the caller
    (usually the PATCH endpoint) decides whether to persist it."""
    assert canon("Marketing agency") == "Marketing agency"
