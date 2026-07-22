"""Private-label subdomain helpers — validation + reserved list.

A subdomain is one DNS label under the platform's private-label root
(default `accountingapp.ai`), e.g. `acme` → `acme.accountingapp.ai`.

Mirrors Rocket Suite's `lib/enterprise/subdomain.ts` intent so the two
apps' rules stay compatible if a firm ever moves between them.
"""
from __future__ import annotations
import os
import re


# Configurable private-label root domain. Ops sets this via env; there is no
# hardcoded fallback outside the default because a wrong value silently
# breaks the wildcard host resolver — better to name it clearly here.
PRIVATE_LABEL_ROOT = (
    os.environ.get("PRIVATE_LABEL_ROOT", "accountingapp.ai").strip().lower()
)

# The main (non-white-label) app host — the platform's OWN brand. Users
# hitting this host always see SmartBooks branding, never a firm's.
PRIMARY_HOST = (
    os.environ.get("PRIMARY_HOST", "app.smartbookssoftware.ai").strip().lower()
)

# Labels a firm can never claim — platform infra + reserved brand words.
# Kept lean so generic business words (billing, support, dashboard, …)
# remain valid firm subdomains; app routes are PATHS, not hosts.
RESERVED = {
    "app", "www", "api", "admin", "mail", "smtp", "imap", "pop", "ftp",
    "ns1", "ns2", "mx", "cdn", "static", "assets", "webhook", "webhooks",
    "cron", "smartbooks", "smartbookssoftware", "accountingapp",
}

# 3-40 chars total. Must start and end with alphanumeric. Lowercase
# letters, digits, and single hyphens allowed in the middle.
_SUBDOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")


def normalize_subdomain(value: str) -> str:
    return (value or "").strip().lower()


def validate_subdomain(value: str) -> tuple[bool, str, str]:
    """Return (ok, error_or_empty, normalized_value)."""
    v = normalize_subdomain(value)
    if not v:
        return False, "Enter a subdomain.", ""
    if len(v) < 3 or len(v) > 40:
        return False, "Use 3-40 characters.", v
    if not _SUBDOMAIN_RE.match(v):
        return False, (
            "Use lowercase letters, numbers, and hyphens — not at the start "
            "or end."
        ), v
    if "--" in v:
        return False, "No double hyphens.", v
    if v in RESERVED:
        return False, "That subdomain is reserved — pick another.", v
    return True, "", v


def subdomain_from_host(host: str) -> str | None:
    """Return the firm label if `host` is `<label>.<PRIVATE_LABEL_ROOT>`.

    Returns None for the bare root (accountingapp.ai), the primary app host,
    reserved labels, or any host outside the private-label root.
    """
    h = (host or "").split(":", 1)[0].strip().lower()
    if not h:
        return None
    if h == PRIMARY_HOST:
        return None
    suffix = f".{PRIVATE_LABEL_ROOT}"
    if not h.endswith(suffix):
        return None
    label = h[: -len(suffix)]
    if not label or "." in label:
        return None
    return None if label in RESERVED else label


def subdomain_to_host(sub: str) -> str:
    return f"{sub}.{PRIVATE_LABEL_ROOT}"
