"""Generates a fake mortgage statement PNG for testing Question 9
liability-split vision analysis.

Output lands at `/app/frontend/public/mortgage-statement-demo.png` so
the user can download it directly from the preview URL:
    <preview>/mortgage-statement-demo.png

Splits are crafted to add up cleanly to $2,145.67 (matching the seeded
Q9 transaction from `seed_e2e_batch_demo.py`).
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont


OUT_PATH = "/app/frontend/public/mortgage-statement-demo.png"


def try_font(paths: list[str], size: int):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def build_statement() -> None:
    W, H = 900, 1250
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)

    sans_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    sans_bold_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    mono_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    body = try_font(sans_paths, 14)
    body_bold = try_font(sans_bold_paths, 14)
    small = try_font(sans_paths, 12)
    header = try_font(sans_bold_paths, 26)
    mono = try_font(mono_paths, 14)
    mono_bold = try_font(mono_paths, 14)

    # ── Header ────────────────────────────────────────────────
    y = 30
    draw.rectangle([(0, 0), (W, 90)], fill="#c8102e")
    draw.text((30, 24), "WELLS FARGO", fill="white", font=header)
    draw.text((30, 60), "Home Mortgage", fill="white", font=body_bold)
    draw.text((W - 250, 30), "Monthly Statement", fill="white", font=body_bold)
    draw.text((W - 250, 56), "Statement date: 09/01/2026", fill="white", font=small)

    y = 110
    draw.text((30, y), "PROPERTY / LOAN INFORMATION", fill="#c8102e", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#c8102e", width=1); y += 10
    for label, val in [
        ("Borrower",           "ACME LANDSCAPING LLC"),
        ("Loan number",        "0421-889302"),
        ("Property address",   "482 Maple Ridge Dr, Reno NV 89502"),
        ("Loan type",          "Conventional 30-yr fixed  ·  Rate 6.125%"),
        ("Current principal",  "$318,412.55"),
        ("Escrow balance",     "$4,182.44"),
    ]:
        draw.text((30, y), label, fill="#555", font=small)
        draw.text((240, y), val, fill="black", font=body)
        y += 20

    y += 20
    draw.text((30, y), "PAYMENT DUE 10/01/2026", fill="#c8102e", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#c8102e", width=1); y += 12

    # ── Payment breakdown block ───────────────────────────────
    rows = [
        ("Principal",              "$   812.45"),
        ("Interest",                "$ 1,104.22"),
        ("Escrow (Taxes & Ins.)",   "$   210.00"),
        ("Late/Other fees",         "$    19.00"),
    ]
    for label, amt in rows:
        draw.text((60, y), label, fill="black", font=body)
        draw.text((W - 200, y), amt, fill="black", font=mono)
        y += 26

    draw.line([(60, y + 4), (W - 60, y + 4)], fill="black", width=1); y += 14
    draw.text((60, y), "TOTAL PAYMENT DUE", fill="black", font=body_bold)
    draw.text((W - 200, y), "$ 2,145.67", fill="black", font=mono_bold); y += 40

    # ── Year-to-date summary ──────────────────────────────────
    draw.text((30, y), "YEAR-TO-DATE PAYMENTS", fill="#c8102e", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#c8102e", width=1); y += 12
    ytd_rows = [
        ("Principal paid YTD",  "$  6,872.31"),
        ("Interest paid YTD",   "$  9,948.72"),
        ("Escrow paid YTD",     "$  1,890.00"),
        ("Total paid YTD",      "$ 18,711.03"),
    ]
    for label, amt in ytd_rows:
        draw.text((60, y), label, fill="black", font=body)
        draw.text((W - 200, y), amt, fill="black", font=mono)
        y += 22

    y += 30
    draw.text((30, y), "IMPORTANT NOTES", fill="#c8102e", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#c8102e", width=1); y += 12
    for note in [
        "Escrow holds funds for property taxes and homeowners insurance.",
        "An escrow analysis is scheduled for December 2026.",
        "Please write your loan number on all correspondence.",
    ]:
        draw.text((60, y), "•  " + note, fill="black", font=small); y += 18

    y += 30
    draw.text((30, y), "Wells Fargo Home Mortgage · PO Box 10335, Des Moines IA 50306 · 1-800-357-6675",
              fill="#666", font=small)

    img = img.crop((0, 0, W, min(H, y + 30)))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    img.save(OUT_PATH, "PNG", optimize=True)
    print(f"wrote {OUT_PATH}")
    print("payment: $2,145.67  ·  P $812.45  I $1,104.22  E $210.00  F $19.00")


if __name__ == "__main__":
    build_statement()
