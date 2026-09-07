"""Markdown → PDF renderer for the GTM playbook docs (Mar 2026).

Purpose-built for the four Cypher-branded business docs (playbook +
three pitch decks). Not a general-purpose Markdown renderer — just
the subset we actually use:

  * H1 / H2 / H3
  * Paragraphs
  * Bold + italic inline
  * Bulleted lists
  * Numbered lists
  * Tables (GitHub-flavor Markdown pipe syntax)
  * Horizontal rules
  * Inline code / code blocks (dropped to monospace)
  * Blockquotes (indented italic)

Style family matches the accounting-report PDF exports so the whole
brand is visually consistent — same Title2 / SubTitle scale, same
slate palette, same table treatment.
"""
from __future__ import annotations

import re
from io import BytesIO
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether,
)


# ── Style palette (mirrors reports._pdf_styles brand grammar) ──────────
_BRAND = {
    "primary":   colors.HexColor("#4F46E5"),  # indigo-600
    "text":      colors.HexColor("#0F172A"),  # slate-900
    "muted":     colors.HexColor("#475569"),  # slate-600
    "light":     colors.HexColor("#F1F5F9"),  # slate-100
    "border":    colors.HexColor("#CBD5E1"),  # slate-300
    "accent":    colors.HexColor("#0EA5E9"),  # cyan-500
}


def _styles():
    return {
        "H1": ParagraphStyle(
            "H1", fontName="Helvetica-Bold", fontSize=22, leading=28,
            textColor=_BRAND["text"], spaceBefore=6, spaceAfter=10,
        ),
        "H2": ParagraphStyle(
            "H2", fontName="Helvetica-Bold", fontSize=15, leading=20,
            textColor=_BRAND["primary"], spaceBefore=14, spaceAfter=6,
        ),
        "H3": ParagraphStyle(
            "H3", fontName="Helvetica-Bold", fontSize=12, leading=16,
            textColor=_BRAND["text"], spaceBefore=10, spaceAfter=4,
        ),
        "Body": ParagraphStyle(
            "Body", fontName="Helvetica", fontSize=10, leading=14,
            textColor=_BRAND["text"], spaceAfter=6, alignment=TA_LEFT,
        ),
        "Bullet": ParagraphStyle(
            "Bullet", fontName="Helvetica", fontSize=10, leading=14,
            textColor=_BRAND["text"], leftIndent=18, bulletIndent=6, spaceAfter=2,
        ),
        "Quote": ParagraphStyle(
            "Quote", fontName="Helvetica-Oblique", fontSize=10, leading=14,
            textColor=_BRAND["muted"], leftIndent=18, spaceBefore=4, spaceAfter=8,
            borderColor=_BRAND["accent"], borderWidth=0, borderPadding=6,
        ),
        "Code": ParagraphStyle(
            "Code", fontName="Courier", fontSize=9, leading=12,
            textColor=_BRAND["text"], backColor=_BRAND["light"],
            leftIndent=8, rightIndent=8, spaceBefore=6, spaceAfter=6,
            borderPadding=6,
        ),
        "Sub": ParagraphStyle(
            "Sub", fontName="Helvetica-Oblique", fontSize=10, leading=13,
            textColor=_BRAND["muted"], spaceAfter=8,
        ),
    }


# ── Inline markdown → mini-HTML for reportlab Paragraph ────────────────
def _inline(md: str) -> str:
    """Convert inline markdown (bold, italic, code, links) to the tiny
    HTML subset reportlab Paragraph understands."""
    s = md
    # Escape reportlab-hostile chars first (only & < >).
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # Inline code `x` → <font face="Courier">x</font>
    s = re.sub(r"`([^`]+)`", r'<font face="Courier">\1</font>', s)
    # Bold **x** or __x__
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"__([^_]+)__", r"<b>\1</b>", s)
    # Italic *x* (avoid double-matching bold's asterisks)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", s)
    # Links [text](url) → underlined + colored
    s = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        r'<link href="\2" color="#4F46E5"><u>\1</u></link>',
        s,
    )
    # Strip stray backslash escapes (Markdown allows \* \_ etc.)
    s = re.sub(r"\\([*_`\[\]()#|~])", r"\1", s)
    return s


# ── Block parsers ──────────────────────────────────────────────────────
def _parse_table(lines: list[str]) -> Optional[Table]:
    """Given a block of pipe-delimited lines, return a reportlab Table.
    Expects a header row + separator row + data rows."""
    if len(lines) < 2:
        return None
    # Strip leading/trailing pipes + whitespace.
    def _split(row):
        row = row.strip()
        if row.startswith("|"):
            row = row[1:]
        if row.endswith("|"):
            row = row[:-1]
        return [c.strip() for c in row.split("|")]

    rows = [_split(ln) for ln in lines]
    # A valid separator row looks like |---|---|
    if not all(re.match(r"^:?-{2,}:?$", c or "-") for c in rows[1]):
        return None
    header = rows[0]
    data_rows = [r for r in rows[2:] if any(c.strip() for c in r)]
    if not data_rows:
        return None

    body = [[Paragraph(_inline(c), _styles()["Body"]) for c in row]
            for row in [header] + data_rows]
    ncols = len(header)
    # Distribute widths roughly evenly, giving the first column a bit more.
    col_widths = None
    if ncols == 2:
        col_widths = [3.5 * inch, 3.5 * inch]
    elif ncols == 3:
        col_widths = [3.0 * inch, 2.0 * inch, 2.0 * inch]
    elif ncols == 4:
        col_widths = [2.5 * inch, 1.5 * inch, 1.5 * inch, 1.5 * inch]
    elif ncols == 5:
        col_widths = [2.0 * inch, 1.4 * inch, 1.4 * inch, 1.1 * inch, 1.1 * inch]
    elif ncols == 6:
        col_widths = [1.7 * inch] + [1.06 * inch] * 5
    tbl = Table(body, colWidths=col_widths, repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _BRAND["light"]),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, 0), (-1, 0), _BRAND["text"]),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, _BRAND["border"]),
    ]))
    return tbl


def _parse_markdown(text: str) -> list:
    """Walk the markdown line-by-line and emit a reportlab flowables
    list. Not a full CommonMark parser — just enough for our docs."""
    st = _styles()
    lines = text.splitlines()
    flow: list = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        stripped = ln.strip()

        # Blank line — small vertical breather.
        if not stripped:
            flow.append(Spacer(1, 4))
            i += 1
            continue

        # Horizontal rule.
        if re.match(r"^\s*(-{3,}|_{3,}|\*{3,})\s*$", ln):
            flow.append(Spacer(1, 4))
            flow.append(HRFlowable(width="100%", thickness=0.5, color=_BRAND["border"]))
            flow.append(Spacer(1, 6))
            i += 1
            continue

        # Code block ```lang ... ```
        if stripped.startswith("```"):
            j = i + 1
            code_lines = []
            while j < len(lines) and not lines[j].strip().startswith("```"):
                code_lines.append(lines[j])
                j += 1
            code = "\n".join(code_lines)
            code_html = code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            code_html = code_html.replace("\n", "<br/>")
            flow.append(Paragraph(code_html, st["Code"]))
            i = j + 1
            continue

        # Table block — starts with `|` and next line is separator.
        if stripped.startswith("|") and i + 1 < len(lines) and "---" in lines[i + 1]:
            j = i
            block = []
            while j < len(lines) and lines[j].strip().startswith("|"):
                block.append(lines[j])
                j += 1
            tbl = _parse_table(block)
            if tbl is not None:
                flow.append(tbl)
                flow.append(Spacer(1, 8))
            i = j
            continue

        # Headings.
        m = re.match(r"^(#{1,3})\s+(.*)$", ln)
        if m:
            level = len(m.group(1))
            key = "H1" if level == 1 else ("H2" if level == 2 else "H3")
            flow.append(Paragraph(_inline(m.group(2)), st[key]))
            i += 1
            continue

        # Blockquote.
        if stripped.startswith("> "):
            j = i
            quote_lines = []
            while j < len(lines) and lines[j].strip().startswith(">"):
                quote_lines.append(lines[j].strip()[1:].strip())
                j += 1
            text_block = " ".join(quote_lines)
            flow.append(Paragraph(_inline(text_block), st["Quote"]))
            i = j
            continue

        # Bulleted / numbered list block.
        if re.match(r"^\s*[-*]\s+", ln) or re.match(r"^\s*\d+\.\s+", ln):
            j = i
            items: list[str] = []
            while j < len(lines):
                bullet_m = re.match(r"^\s*[-*]\s+(.*)$", lines[j])
                num_m    = re.match(r"^\s*\d+\.\s+(.*)$", lines[j])
                if bullet_m:
                    items.append(("•", bullet_m.group(1)))
                elif num_m:
                    items.append((f"{len(items) + 1}.", num_m.group(1)))
                elif lines[j].strip() == "":
                    break
                else:
                    # Continuation line — append to previous item.
                    if items:
                        prev = items[-1]
                        items[-1] = (prev[0], prev[1] + " " + lines[j].strip())
                    else:
                        break
                j += 1
            for marker, txt in items:
                # Manually prefix marker inside the paragraph so we keep
                # tight control over indent + line wrapping.
                flow.append(Paragraph(
                    f'<font color="#4F46E5"><b>{marker}</b></font>&nbsp;&nbsp;{_inline(txt)}',
                    st["Bullet"],
                ))
            i = j
            continue

        # Plain paragraph — collect consecutive non-blank lines.
        j = i
        para_lines = []
        while j < len(lines) and lines[j].strip() and not re.match(
            r"^(#{1,3}\s|[-*]\s|\d+\.\s|>\s|\|)", lines[j].strip(),
        ):
            para_lines.append(lines[j].strip())
            j += 1
        if para_lines:
            flow.append(Paragraph(_inline(" ".join(para_lines)), st["Body"]))
        i = max(j, i + 1)

    return flow


# ── Public entry point ─────────────────────────────────────────────────
def render_markdown_to_pdf(
    md_text: str, *, title: Optional[str] = None, subtitle: Optional[str] = None,
    brand_name: str = "CypherPro",
) -> bytes:
    """Render a Markdown document to a print-friendly PDF.

    Header block (title + subtitle + brand-line) is prepended in a
    consistent visual family. Body flows using `_parse_markdown`.
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.7 * inch, rightMargin=0.7 * inch,
        topMargin=0.75 * inch, bottomMargin=0.6 * inch,
        title=title or "CypherPro Playbook",
        author=brand_name,
    )
    st = _styles()
    story = []
    # Brand strap-line — small colored bar so the doc feels "designed".
    story.append(Paragraph(
        f'<font color="#4F46E5"><b>{brand_name}</b></font>'
        f'&nbsp;&nbsp;<font color="#94A3B8">·</font>&nbsp;&nbsp;'
        f'<font color="#94A3B8">Go-to-Market Playbook</font>',
        st["Sub"],
    ))
    story.append(HRFlowable(width="100%", thickness=1.5, color=_BRAND["primary"]))
    story.append(Spacer(1, 10))
    if title:
        story.append(Paragraph(title, st["H1"]))
    if subtitle:
        story.append(Paragraph(subtitle, st["Sub"]))
    if title or subtitle:
        story.append(Spacer(1, 4))
    # Body.
    story.extend(_parse_markdown(md_text))
    # Footer strip.
    story.append(Spacer(1, 18))
    story.append(HRFlowable(width="100%", thickness=0.5, color=_BRAND["border"]))
    story.append(Paragraph(
        f'<font color="#94A3B8" size="8">'
        f'Confidential — for authorized recipients only. '
        f'© {brand_name} · Generated by CypherPro.'
        f'</font>',
        st["Sub"],
    ))

    doc.build(story)
    return buf.getvalue()
