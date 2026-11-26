"""A real PDF of the same report (pure pip: fpdf2, which needs Pillow; no Chrome, no system packages).

build(result, brand=..., logo_png=..., accent=..., prepared_for=..., contact_line=..., footer=...) -> bytes.
The numbers come from the same result object as the HTML; only the header and the footer differ per brand.
Text is limited to the PDF core font (Latin-1); `<` and `>` are dropped so no markup can ride along.
"""
import io
import re

from .niches import niche_label
from .report import GRADE_LABEL
from .report_pro import ACCENT_RE, _vendor, method_footer

_FIXES = {"–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "·": "-",
          "…": "..."}


def _t(v, limit=400):
    s = "".join(_FIXES.get(c, c) for c in str(v))
    s = re.sub(r"[<>\x00-\x1f]", " ", s)
    s = s.encode("latin-1", "replace").decode("latin-1")
    return re.sub(r"\s+", " ", s).strip()[:limit]


def _rgb(accent):
    a = accent if accent and ACCENT_RE.fullmatch(accent) else "#4f46e5"
    return tuple(int(a[i:i + 2], 16) for i in (1, 3, 5))


def build(result, date, brand, logo_png=None, accent=None, prepared_for=None, contact_line=None, footer=None):
    from fpdf import FPDF
    s = result.score
    pdf = FPDF(format="Letter", unit="mm")
    pdf.set_auto_page_break(True, margin=18)
    pdf.set_margin(16)
    pdf.set_title(_t(brand, 120))
    pdf.add_page()
    r, g, b = _rgb(accent)
    y0 = pdf.get_y()
    if logo_png:
        pdf.image(io.BytesIO(logo_png), x=16, y=y0, h=14)
        pdf.set_xy(16, y0 + 16)
    pdf.set_text_color(r, g, b)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, _t(brand, 120), new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(17, 24, 39)
    if prepared_for:
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(0, 6, _t("Prepared for " + prepared_for, 160), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 20)
    pdf.multi_cell(0, 10, _t(result.target, 160), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(107, 114, 128)
    pdf.multi_cell(0, 5, _t(f"{niche_label(result.niche.label)} - {result.city} - {len(result.prompts)} customer questions - "
                            f"{s.total_answers} AI answers - {date}"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(17, 24, 39)
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 26)
    pdf.cell(0, 12, f"{s.score} / 100", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    hits = sum(p.target_hits for p in s.providers)
    pdf.multi_cell(0, 5, f"AI visibility. {hits} of {s.total_answers} answers named this business.",
                   new_x="LMARGIN", new_y="NEXT")

    def heading(text):
        pdf.ln(4)
        pdf.set_text_color(r, g, b)
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, _t(text), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(17, 24, 39)
        pdf.set_font("Helvetica", "", 10)

    heading("By AI assistant")
    for p in s.providers:
        pdf.multi_cell(0, 5.5, _t(f"{_vendor(p.provider)} ({p.mode}): named you {p.target_hits}/{p.answers} ({p.rate:.0%}), "
                                  f"95% range {p.ci[0]:.0%}-{p.ci[1]:.0%}"), new_x="LMARGIN", new_y="NEXT")
    heading("Who AI recommends instead")
    if s.competitors:
        for n, c, share in s.competitors[:6]:
            pdf.multi_cell(0, 5.5, _t(f"{n}: {share:.0%} of answers"), new_x="LMARGIN", new_y="NEXT")
    else:
        pdf.cell(0, 5.5, "none found", new_x="LMARGIN", new_y="NEXT")
    heading("Likely reasons and what to fix")
    for i, f in enumerate(result.findings, 1):
        pdf.set_font("Helvetica", "B", 10)
        pdf.multi_cell(0, 5.5, _t(f"{i}. {f.reason}"), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 10)
        pdf.multi_cell(0, 5, _t(f.fix), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(107, 114, 128)
        pdf.multi_cell(0, 5, _t(f"Evidence: {f.evidence} ({GRADE_LABEL[f.grade]}; effort: {f.effort})"),
                       new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(17, 24, 39)
        pdf.ln(1.5)
    pdf.ln(3)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(107, 114, 128)
    if contact_line:
        pdf.multi_cell(0, 4.5, _t(contact_line, 200), new_x="LMARGIN", new_y="NEXT")
    pdf.multi_cell(0, 4.5, _t(footer or method_footer(result, date), 900), new_x="LMARGIN", new_y="NEXT")
    return bytes(pdf.output())
