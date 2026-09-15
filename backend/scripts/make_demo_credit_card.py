"""Generates a fake Chase credit-card statement PNG for testing
Question 9 liability-split vision analysis (credit-card variant).

Output lands at `/app/frontend/public/credit-card-statement-demo.png`.
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont


OUT_PATH = "/app/frontend/public/credit-card-statement-demo.png"


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

    body = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 14)
    body_bold = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], 14)
    small = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 12)
    header = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], 26)
    mono = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"], 14)
    mono_bold = try_font(["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"], 14)

    # ── Header ────────────────────────────────────────────────
    draw.rectangle([(0, 0), (W, 90)], fill="#0a4a8a")
    draw.text((30, 24), "CHASE", fill="white", font=header)
    draw.text((30, 60), "Business Ink Unlimited · Card ending 4291",
              fill="white", font=body_bold)
    draw.text((W - 260, 30), "Statement Date: 09/01/2026", fill="white", font=small)
    draw.text((W - 260, 50), "Account: ****-****-****-4291", fill="white", font=small)
    draw.text((W - 260, 70), "Payment Due: 09/28/2026", fill="white", font=small)

    y = 110
    draw.text((30, y), "ACCOUNT SUMMARY", fill="#0a4a8a", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#0a4a8a", width=1); y += 10
    for label, val in [
        ("Previous balance",              "$ 4,891.22"),
        ("Payments/Credits",              "-$ 2,145.67"),
        ("Purchases",                     "$ 1,872.44"),
        ("Cash advances",                 "$     0.00"),
        ("Fees charged",                  "$    29.00"),
        ("Interest charged",              "$   112.85"),
        ("New balance",                   "$ 4,759.84"),
    ]:
        draw.text((30, y), label, fill="black", font=body)
        draw.text((W - 210, y), val, fill="black", font=mono)
        y += 20

    y += 20
    draw.text((30, y), "PAYMENT INFORMATION", fill="#0a4a8a", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#0a4a8a", width=1); y += 12
    for label, val in [
        ("Payment applied 08/24/2026",     "$ 2,145.67"),
        ("Statement balance",              "$ 4,759.84"),
        ("Minimum payment due",            "$    95.00"),
        ("Annual percentage rate (APR)",   "22.24% variable"),
    ]:
        draw.text((60, y), label, fill="black", font=body)
        draw.text((W - 210, y), val, fill="black", font=mono)
        y += 22

    y += 20
    draw.text((30, y), "PAYMENT BREAKDOWN (Aug 24 $2,145.67)",
              fill="#0a4a8a", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#0a4a8a", width=1); y += 12
    rows = [
        ("Applied to principal",         "$ 2,003.82"),
        ("Applied to finance charges",   "$   112.85"),
        ("Applied to fees",              "$    29.00"),
    ]
    for label, amt in rows:
        draw.text((60, y), label, fill="black", font=body)
        draw.text((W - 210, y), amt, fill="black", font=mono)
        y += 24
    draw.line([(60, y + 4), (W - 60, y + 4)], fill="black", width=1); y += 14
    draw.text((60, y), "TOTAL PAYMENT", fill="black", font=body_bold)
    draw.text((W - 210, y), "$ 2,145.67", fill="black", font=mono_bold); y += 40

    draw.text((30, y), "RECENT TRANSACTIONS", fill="#0a4a8a", font=body_bold); y += 22
    draw.line([(30, y), (W - 30, y)], fill="#0a4a8a", width=1); y += 12
    txns = [
        ("08/03", "HOME DEPOT #4127",         "$    218.42"),
        ("08/08", "GRAINGER INDUSTRIAL",       "$    342.11"),
        ("08/14", "SHELL OIL #94211",          "$     78.30"),
        ("08/19", "STAPLES BUSINESS ADV.",     "$    122.99"),
        ("08/24", "PAYMENT THANK YOU",         "-$ 2,145.67"),
        ("08/27", "AMAZON.COM AMZN.COM/BILL",  "$    459.28"),
    ]
    for d, desc, amt in txns:
        draw.text((30, y), d, fill="black", font=body)
        draw.text((100, y), desc, fill="black", font=body)
        draw.text((W - 210, y), amt, fill="black", font=mono)
        y += 20

    y += 30
    draw.text((30, y), "Chase Card Services · PO Box 15298 Wilmington DE 19850 · 1-800-346-5538",
              fill="#666", font=small)

    img = img.crop((0, 0, W, min(H, y + 30)))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    img.save(OUT_PATH, "PNG", optimize=True)
    print(f"wrote {OUT_PATH}")
    print("payment: $2,145.67  ·  Principal $2,003.82  Interest $112.85  Fees $29.00")


if __name__ == "__main__":
    build_statement()
