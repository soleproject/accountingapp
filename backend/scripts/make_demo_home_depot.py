"""Generates a fake Home Depot receipt PNG for testing Q1
(Uncategorized transaction) upload flow.

Total is crafted to match exactly the seeded Q1 transaction from
`seed_e2e_batch_demo.py`:  HOME DEPOT #6234 RENO NV · -$483.29 on
2026-09-06 on Business Checking ****4291.

Output → /app/frontend/public/home-depot-receipt-demo.png
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont

OUT_PATH = "/app/frontend/public/home-depot-receipt-demo.png"


def try_font(paths: list[str], size: int):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def build_receipt() -> None:
    W, H = 640, 1200
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)

    mono = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"], 14)
    mono_bold = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"], 14)
    mono_big = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"], 20)
    sans = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 13)
    sans_small = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 11)

    y = 30

    # ── Header (orange) ───────────────────────────────────────
    draw.rectangle([(30, y), (W - 30, y + 60)], fill="#f96302")
    draw.text((W // 2 - 90, y + 16), "THE HOME DEPOT",
              fill="white", font=mono_big)
    y += 80

    for line in [
        "STORE #6234  RENO NV",
        "9750 S VIRGINIA ST",
        "RENO, NV 89511",
        "(775) 852-3200",
    ]:
        w = draw.textlength(line, font=sans_small)
        draw.text(((W - w) / 2, y), line, fill="black", font=sans_small)
        y += 15
    y += 8

    # ── Meta ──────────────────────────────────────────────────
    draw.line([(30, y), (W - 30, y)], fill="black", width=1)
    y += 8
    meta_lines = [
        ("SALE",                              "09/06/2026 10:42 AM"),
        ("CASHIER: JAMIE",                    "TERM: 04"),
        ("TRANS #: 6234-04-88291",            ""),
    ]
    for left, right in meta_lines:
        draw.text((30, y), left, fill="black", font=mono)
        if right:
            rw = draw.textlength(right, font=mono)
            draw.text((W - 30 - rw, y), right, fill="black", font=mono)
        y += 18
    draw.line([(30, y), (W - 30, y)], fill="black", width=1)
    y += 10

    # ── Line items ────────────────────────────────────────────
    items = [
        # SKU, description, qty, unit, ext
        ("184552", "4x4x8 PT POST",          6, 19.98, 119.88),
        ("100318", "QUIKRETE 80LB CONCRETE", 10, 6.98,  69.80),
        ("161640", "2x4x10 KD SPF STUD",     8, 8.47,  67.76),
        ("205814", "CYPRESS MULCH 2CF",      12, 4.98,  59.76),
        ("310457", "MILWAUKEE M18 IMPACT",   1, 99.00, 99.00),
        ("471822", "CONTRACT TRASH BAG 42G", 1, 16.97, 16.97),
        ("504211", "NITRILE WORK GLOVE 5PK", 1, 15.98, 15.98),
    ]
    for sku, desc, qty, unit, ext in items:
        # Line 1 — SKU + description
        draw.text((30, y), f"{sku}  {desc}", fill="black", font=mono)
        # Right-aligned extended
        rt = f"${ext:>7.2f}"
        rw = draw.textlength(rt, font=mono)
        draw.text((W - 30 - rw, y), rt, fill="black", font=mono)
        y += 16
        # Line 2 — qty × unit (indented)
        detail = f"    {qty} @ ${unit:.2f} ea"
        draw.text((30, y), detail, fill="#555", font=sans_small)
        y += 16

    y += 4
    draw.line([(30, y), (W - 30, y)], fill="black", width=1)
    y += 10

    # ── Totals ────────────────────────────────────────────────
    for label, amt, bold in [
        ("SUBTOTAL",         449.15, False),
        ("SALES TAX 7.60%",   34.14, False),
        ("TOTAL",            483.29, True),
    ]:
        f = mono_bold if bold else mono
        draw.text((30, y), label, fill="black", font=f)
        rt = f"${amt:>7.2f}"
        rw = draw.textlength(rt, font=f)
        draw.text((W - 30 - rw, y), rt, fill="black", font=f)
        y += 20
    draw.line([(30, y), (W - 30, y)], fill="black", width=1)
    y += 12

    # ── Tender ────────────────────────────────────────────────
    for label, amt in [
        ("VISA BUSINESS CHK  ****4291", 483.29),
        ("AUTH: 004821",                None),
        ("CHANGE",                        0.00),
    ]:
        draw.text((30, y), label, fill="black", font=mono)
        if amt is not None:
            rt = f"${amt:>7.2f}"
            rw = draw.textlength(rt, font=mono)
            draw.text((W - 30 - rw, y), rt, fill="black", font=mono)
        y += 18

    y += 12
    draw.line([(30, y), (W - 30, y)], fill="black", width=1)
    y += 10

    # ── PRO account footer ───────────────────────────────────
    for line in [
        "PRO XTRA ACCOUNT",
        "ACME LANDSCAPING LLC",
        "PROX #: 88-4291-6234",
        "PERKS EARNED THIS VISIT: 448",
        "",
        "*** THANK YOU FOR SHOPPING ***",
        "Return within 90 days with receipt",
    ]:
        w = draw.textlength(line, font=sans_small)
        draw.text(((W - w) / 2, y), line, fill="black", font=sans_small)
        y += 15

    y += 12
    # ── Bar-code-ish stripe as visual filler ─────────────────
    import random
    random.seed(0)
    x = 60
    while x < W - 60:
        bw = random.choice([2, 3, 4])
        draw.rectangle([(x, y), (x + bw, y + 40)], fill="black")
        x += bw + random.choice([2, 3, 4, 5])
    y += 46
    draw.text((W // 2 - 90, y), "6234 04 88291 483.29",
              fill="black", font=mono)
    y += 30

    img = img.crop((0, 0, W, min(H, y + 20)))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    img.save(OUT_PATH, "PNG", optimize=True)
    print(f"wrote {OUT_PATH}")
    print("total: $483.29  ·  subtotal $449.15 + tax $34.14  ·  7 line items")


if __name__ == "__main__":
    build_receipt()
