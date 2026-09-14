"""Generates a fake Costco-style receipt PNG for testing the Question 8
split-transaction vision analysis flow.

Output lands at `/app/frontend/public/costco-receipt-demo.png` so the
user can download it directly from the preview URL:
    <preview>/costco-receipt-demo.png

The receipt intentionally mixes business + personal line items so
GPT-4o has interesting work to do when it proposes a split. Totals are
crafted to land within a few dollars of $1,200 so it lines up with
the seeded demo transaction on Sales Tax Tester LLC.
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont


OUT_PATH = "/app/frontend/public/costco-receipt-demo.png"

# (description, price, kind) — `kind` is metadata for the human but is
# NOT written to the receipt image; GPT-4o has to infer it from the
# description itself.
LINE_ITEMS = [
    # ── Business supplies ──────────────────────────────────
    ("HP83A TONER 2PK",         189.99, "business"),
    ("EXEC OFFICE CHAIR",       249.99, "business"),
    ("COPY PAPER 5000CT",        54.99, "business"),
    ("LED DESK LAMP",            47.99, "business"),
    ("USB-C HUB 8-IN-1",         29.99, "business"),
    ("FIRE EXTINGUISHER 5LB",    32.99, "business"),
    ("WHITEBOARD 48x36",         64.99, "business"),
    ("PAPER SHREDDER",           49.99, "business"),
    # ── Personal groceries + household ─────────────────────
    ("KIRK CHKN THIGHS 6LB",     22.99, "personal"),
    ("ORGANIC SPINACH TUB",       6.49, "personal"),
    ("ROTISSERIE CHICKEN",        4.99, "personal"),
    ("MIXED NUTS 2.5LB",         17.99, "personal"),
    ("ALMOND MILK 6PK",          14.99, "personal"),
    ("BANANAS 3LB",               2.49, "personal"),
    ("KIRK COFFEE 2.5LB",        19.99, "personal"),
    ("ATLANTIC SALMON 2LB",      28.99, "personal"),
    ("STRAWBERRIES 2LB",          8.99, "personal"),
    ("PAPER TOWELS 12PK",        23.99, "personal"),
    ("KIDS SNACK PACK",          19.99, "personal"),
    ("LAUNDRY DETERGENT",        22.99, "personal"),
    ("KIRK CAB SAV 750ML",       12.99, "personal"),
    ("HONEY NUT CHEER 2PK",      10.99, "personal"),
    ("FROZEN PIZZA 5PK",         19.99, "personal"),
    ("SHARP CHEDDAR 2LB",        11.99, "personal"),
    ("SOURDOUGH LOAF 2PK",        6.99, "personal"),
    ("GREEK YOGURT 4PK",          9.99, "personal"),
    ("BLUEBERRIES 18OZ",          7.49, "personal"),
    ("AA BATTERIES 48PK",        17.99, "personal"),
    ("EGG CARTON 24CT",           7.99, "personal"),
    ("GROUND BEEF 4LB",          24.99, "personal"),
    ("APPLE JUICE 3PK",           8.99, "personal"),
    ("FROZEN BERRIES 4LB",       12.99, "personal"),
    ("BAGELS 12PK",               5.99, "personal"),
    ("PAPER PLATES 250CT",       14.99, "personal"),
    ("DISH SOAP 128OZ",           8.99, "personal"),
    ("TOMATOES 4LB",              6.99, "personal"),
    ("CANNED TUNA 8PK",          12.99, "personal"),
    ("PASTA 6PK",                 8.99, "personal"),
    ("OLIVE OIL 3L",             19.99, "personal"),
    ("BROWNIE MIX 2PK",           6.99, "personal"),
    ("APPLES 5LB BAG",            7.99, "personal"),
    ("CARROTS 5LB",               5.99, "personal"),
    ("CROISSANTS 12PK",           7.99, "personal"),
    ("GOAT CHEESE 2PK",          10.99, "personal"),
    ("SPARKLING WATER 24PK",     15.99, "personal"),
    ("VITAMIN D3 300CT",         14.99, "personal"),
    ("PROTEIN BARS 20PK",        16.99, "personal"),
    ("HONEY 3LB",                12.99, "personal"),
    ("MAPLE SYRUP 1L",           16.99, "personal"),
    ("KIRKLAND WINE 1.5L",       14.99, "personal"),
    ("ICE CREAM 3PK",            13.99, "personal"),
    ("CANDLES 3PK",              14.99, "personal"),
]


def build_receipt() -> None:
    W, H = 720, 1600
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)

    # Use a monospaced font if available for the receipt aesthetic;
    # fall back to PIL's built-in bitmap font if not.
    def try_font(paths: list[str], size: int):
        for p in paths:
            try:
                return ImageFont.truetype(p, size)
            except (OSError, IOError):
                continue
        return ImageFont.load_default()

    mono_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
    ]
    mono = try_font(mono_paths, 15)
    mono_sm = try_font(mono_paths, 13)
    mono_bold = try_font(mono_paths, 17)
    header = try_font(mono_paths, 22)

    # ── Header ───────────────────────────────────────────────────
    y = 24
    draw.text((W // 2 - 60, y), "COSTCO", fill="black", font=header); y += 30
    draw.text((W // 2 - 80, y), "WHOLESALE", fill="black", font=mono_bold); y += 25
    draw.text((W // 2 - 120, y), "6255 S VIRGINIA ST", fill="black", font=mono_sm); y += 18
    draw.text((W // 2 - 90, y), "RENO NV  89502", fill="black", font=mono_sm); y += 18
    draw.text((W // 2 - 95, y), "(775) 826-1010", fill="black", font=mono_sm); y += 30
    draw.text((30, y), "-" * 56, fill="black", font=mono); y += 22
    draw.text((30, y), "MEMBER # 111987456321          WAREHOUSE # 1148",
              fill="black", font=mono_sm); y += 18
    draw.text((30, y), "09/09/2026 14:32   OP: 034  REG: 07  TRAN: 0192",
              fill="black", font=mono_sm); y += 22
    draw.text((30, y), "-" * 56, fill="black", font=mono); y += 22

    # ── Line items ───────────────────────────────────────────────
    subtotal = 0.0
    for desc, price, _kind in LINE_ITEMS:
        # Truncate description if too long so it doesn't overrun the price
        desc_disp = desc[:36]
        left = f"{desc_disp:<36}"
        right = f"${price:>7.2f}"
        draw.text((30, y), left, fill="black", font=mono)
        draw.text((W - 30 - 90, y), right, fill="black", font=mono)
        y += 20
        subtotal += price

    # Tune subtotal to land near $1,110 (so grand total after tax ≈ $1,200)
    # Actually — sales tax in NV Reno = 8.265%. We want grand total ≈ $1,200
    # so subtotal target ≈ $1,108.42. Adjust with a Costco "instant savings"
    # or "manufacturer coupon" line so the receipt still totals cleanly.
    tax_rate = 0.08265
    target_grand_total = 1200.00
    target_subtotal = round(target_grand_total / (1 + tax_rate), 2)
    adjustment = round(target_subtotal - subtotal, 2)
    if abs(adjustment) > 0.01:
        # Positive adjustment = add an item; negative = subtract via coupon.
        label = "INSTANT SAVINGS" if adjustment < 0 else "BULK ITEM UPCHARGE"
        left = f"{label:<36}"
        right = f"${adjustment:>7.2f}"
        draw.text((30, y), left, fill="black", font=mono)
        draw.text((W - 30 - 90, y), right, fill="black", font=mono)
        y += 20
        subtotal += adjustment

    tax = round(subtotal * tax_rate, 2)
    grand_total = round(subtotal + tax, 2)

    y += 6
    draw.text((30, y), "-" * 56, fill="black", font=mono); y += 22
    for label, val in (
        ("SUBTOTAL",       subtotal),
        ("SALES TAX 8.265%", tax),
        ("TOTAL",           grand_total),
    ):
        left = f"{label:<36}"
        right = f"${val:>7.2f}"
        weight = mono_bold if label == "TOTAL" else mono
        draw.text((30, y), left, fill="black", font=weight)
        draw.text((W - 30 - 90, y), right, fill="black", font=weight)
        y += 22
    y += 6
    draw.text((30, y), "-" * 56, fill="black", font=mono); y += 22
    draw.text((30, y), "VISA XXXX-XXXX-XXXX-4291                          ",
              fill="black", font=mono_sm); y += 18
    draw.text((30, y), "AUTH #: 041592     APPROVED", fill="black", font=mono_sm); y += 22
    draw.text((W // 2 - 90, y), "THANK YOU FOR SHOPPING", fill="black", font=mono_sm); y += 18
    draw.text((W // 2 - 60, y), "AT COSTCO!", fill="black", font=mono_sm); y += 25
    draw.text((W // 2 - 100, y), "* * *  # ITEMS SOLD: 51  * * *",
              fill="black", font=mono_sm); y += 22

    # Trim any unused canvas at the bottom.
    img = img.crop((0, 0, W, y + 24))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    img.save(OUT_PATH, "PNG", optimize=True)
    print(f"wrote {OUT_PATH}")
    print(f"subtotal ${subtotal:.2f}  tax ${tax:.2f}  grand ${grand_total:.2f}")
    print(f"item count: {len(LINE_ITEMS)}")


if __name__ == "__main__":
    build_receipt()
