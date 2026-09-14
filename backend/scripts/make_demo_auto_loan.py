"""Generates a fake auto-loan statement PNG for testing Question 9
liability-split vision analysis (auto-loan variant).

Output lands at `/app/frontend/public/auto-loan-statement-demo.png`.
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont


OUT_PATH = "/app/frontend/public/auto-loan-statement-demo.png"


def try_font(paths: list[str], size: int):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def build_statement() -> None:
    W, H = 900, 1150
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)

    body = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 14)
    body_bold = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], 14)
    small = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 12)
    header = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], 26)
    mono = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"], 14)
    mono_bold = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"], 14)

    # ── Header ────────────────────────────────────────────────
    draw.rectangle([(0, 0), (W, 90)], fill="#003b71")
    draw.text((30, 24), "ALLY BANK", fill="white", font=header)
    draw.text((30, 60), "Auto Finance · Monthly Statement",
              fill="white", font=body_bold)
    draw.text((W - 260, 30), "Statement Date: 09/01/2026", fill="white", font=small)
    draw.text((W - 260, 50), "Loan #: 77-4210-982", fill="white", font=small)
    draw.text((W - 260, 70), "Payment Due: 09/22/2026", fill="white", font=small)

    y = 110
    draw.text((30, y), "VEHICLE / LOAN INFORMATION", fill="#003b71", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#003b71", width=1); y += 10
    for label, val in [
        ("Borrower",           "ACME LANDSCAPING LLC"),
        ("Vehicle",            "2024 Ford F-250 XLT · VIN 1FT7W2BT8REC12984"),
        ("Original loan",      "$ 62,400.00  ·  7 yr @ 6.89% APR"),
        ("Current principal",  "$ 44,782.19"),
        ("Payoff quote",       "$ 45,102.44 (good through 09/15/2026)"),
    ]:
        draw.text((30, y), label, fill="#555", font=small)
        draw.text((240, y), val, fill="black", font=body)
        y += 20

    y += 20
    draw.text((30, y), "PAYMENT DUE 09/22/2026", fill="#003b71", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#003b71", width=1); y += 12
    rows = [
        ("Principal",             "$ 1,895.24"),
        ("Interest",               "$   248.43"),
        ("Late fees",              "$     2.00"),
    ]
    for label, amt in rows:
        draw.text((60, y), label, fill="black", font=body)
        draw.text((W - 200, y), amt, fill="black", font=mono)
        y += 26
    draw.line([(60, y + 4), (W - 60, y + 4)], fill="black", width=1); y += 14
    draw.text((60, y), "TOTAL PAYMENT DUE", fill="black", font=body_bold)
    draw.text((W - 200, y), "$ 2,145.67", fill="black", font=mono_bold); y += 40

    draw.text((30, y), "YEAR-TO-DATE", fill="#003b71", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#003b71", width=1); y += 12
    for label, amt in [
        ("Principal paid YTD",  "$ 15,441.02"),
        ("Interest paid YTD",   "$  2,412.88"),
        ("Fees YTD",            "$      6.00"),
    ]:
        draw.text((60, y), label, fill="black", font=body)
        draw.text((W - 200, y), amt, fill="black", font=mono)
        y += 22

    y += 30
    draw.text((30, y), "Ally Bank · P.O. Box 380902 Bloomington MN 55438 · 1-888-925-2559",
              fill="#666", font=small)

    img = img.crop((0, 0, W, min(H, y + 30)))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    img.save(OUT_PATH, "PNG", optimize=True)
    print(f"wrote {OUT_PATH}")
    print("payment: $2,145.67  ·  Principal $1,895.24  Interest $248.43  Fees $2.00")


if __name__ == "__main__":
    build_statement()
