"""One-shot font downloader — pulls the 12 report-styling fonts from
google/fonts and materializes Regular + Bold static TTFs in
`backend/fonts/`. Run once locally; the resulting TTFs are committed
to the repo so runtime doesn't touch the network.

For variable fonts (Inter, Roboto, Open Sans, etc.), `fontTools`
instantiates a fixed-weight static TTF from the master file. Fonts that
already ship with static Regular + Bold (Lato, Poppins, IBM Plex Mono)
are fetched directly.

Usage:
    cd /app/backend && python3 scripts/download_fonts.py
"""
import os
import sys
import io
import urllib.request

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

BASE = "https://raw.githubusercontent.com/google/fonts/main"

# Variable fonts — one master file per family, weights instanced at
# runtime via fontTools. Each entry: (family, url_path).
# Merriweather is excluded from this list because its master carries 3
# axes (opsz + wdth + wght) which makes fontTools' instancer take
# minutes per weight. PT Serif ships pre-baked static Regular + Bold
# with a similar Merriweather-esque book-serif feel, so it lives in
# STATIC_FONTS below instead.
VARIABLE_FONTS = [
    ("Inter",             "/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf"),
    ("Roboto",            "/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf"),
    ("OpenSans",          "/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf"),
    ("Nunito",            "/ofl/nunito/Nunito%5Bwght%5D.ttf"),
    ("PlayfairDisplay",   "/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"),
    ("Lora",              "/ofl/lora/Lora%5Bwght%5D.ttf"),
    ("LibreBaskerville",  "/ofl/librebaskerville/LibreBaskerville%5Bwght%5D.ttf"),
    ("JetBrainsMono",     "/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf"),
]

# Static-only families — Regular + Bold TTFs shipped directly by upstream.
STATIC_FONTS = [
    ("Lato",              "/ofl/lato/Lato-Regular.ttf",       "/ofl/lato/Lato-Bold.ttf"),
    ("Poppins",           "/ofl/poppins/Poppins-Regular.ttf", "/ofl/poppins/Poppins-Bold.ttf"),
    ("IBMPlexMono",       "/ofl/ibmplexmono/IBMPlexMono-Regular.ttf",
                          "/ofl/ibmplexmono/IBMPlexMono-Bold.ttf"),
    ("PTSerif",           "/ofl/ptserif/PT_Serif-Web-Regular.ttf",
                          "/ofl/ptserif/PT_Serif-Web-Bold.ttf"),
]

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")
os.makedirs(OUT_DIR, exist_ok=True)


def _fetch(url: str) -> bytes:
    print(f"  ↓ {url}")
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def instance_variable(family: str, path: str) -> None:
    """Download a variable font and emit Regular (400) + Bold (700) static
    TTFs. The variable font's design axes vary between families
    (Inter has opsz+wght, Roboto adds wdth) so we only pin `wght`
    and let the other axes stay at their defaults."""
    raw = _fetch(BASE + path)
    for weight, suffix in ((400, "Regular"), (700, "Bold")):
        f = TTFont(io.BytesIO(raw))
        instanced = instantiateVariableFont(f, {"wght": weight})
        out = os.path.join(OUT_DIR, f"{family}-{suffix}.ttf")
        instanced.save(out)
        print(f"    → {os.path.basename(out)} ({os.path.getsize(out) // 1024} KB)")


def fetch_static(family: str, reg_path: str, bold_path: str) -> None:
    """Download pre-made static Regular + Bold TTFs verbatim."""
    for suffix, path in (("Regular", reg_path), ("Bold", bold_path)):
        out = os.path.join(OUT_DIR, f"{family}-{suffix}.ttf")
        with open(out, "wb") as fh:
            fh.write(_fetch(BASE + path))
        print(f"    → {os.path.basename(out)} ({os.path.getsize(out) // 1024} KB)")


def main() -> None:
    print(f"Target: {os.path.abspath(OUT_DIR)}")
    for family, path in VARIABLE_FONTS:
        print(f"\n[variable] {family}")
        instance_variable(family, path)
    for family, reg, bold in STATIC_FONTS:
        print(f"\n[static]   {family}")
        fetch_static(family, reg, bold)
    print("\nDone.")


if __name__ == "__main__":
    main()
