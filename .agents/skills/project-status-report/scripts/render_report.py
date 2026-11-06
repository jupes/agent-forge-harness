"""Render a leadership brief from evidence-reviewed JSON. No network or tracker writes."""

import argparse
import json
import os
from datetime import date, datetime
from pathlib import Path
import sys
import tempfile
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def validate(data):
    if not isinstance(data, dict):
        raise ValueError("Report must be a JSON object")

    def required(obj, key):
        if not isinstance(obj.get(key), str) or not obj[key].strip():
            raise ValueError(f"Nonempty text required: {key}")

    for key in ("project", "audience", "period_start", "period_end", "timezone",
                "as_of", "status", "status_reason", "summary", "coverage"):
        required(data, key)
    start, end = (date.fromisoformat(data[k]) for k in ("period_start", "period_end"))
    if start > end:
        raise ValueError("period_start must be on or before period_end")
    try:
        zone = ZoneInfo(data["timezone"])
    except ZoneInfoNotFoundError as error:
        raise ValueError("Unknown timezone or missing timezone database: verify the IANA name and install tzdata if needed") from error
    cutoff = datetime.fromisoformat(data["as_of"].replace("Z", "+00:00"))
    if cutoff.tzinfo is None:
        raise ValueError("as_of must include a UTC offset")
    if end > cutoff.astimezone(zone).date():
        raise ValueError("Reporting period extends beyond the extraction date")
    if data["status"] not in ("On track", "At risk", "Off track", "Unknown"):
        raise ValueError("status must be On track, At risk, Off track, or Unknown")
    if not isinstance(data.get("sources"), list):
        raise ValueError("sources must be an array")
    ids = set()
    for source in data["sources"]:
        if not isinstance(source, dict):
            raise ValueError("Each source must be an object")
        for key in ("id", "label", "locator"):
            required(source, key)
        if source["id"] in ids:
            raise ValueError("Duplicate source ID: " + source["id"])
        ids.add(source["id"])

    def refs(values):
        if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
            raise ValueError("Source references must be arrays of IDs")
        missing = set(values) - ids
        if missing:
            raise ValueError("Unknown source IDs: " + ", ".join(sorted(missing)))

    refs(data.get("summary_sources"))
    for section in ("accomplishments", "risks", "next_steps", "decisions", "metrics"):
        items = data.get(section, [] if section == "metrics" else None)
        if not isinstance(items, list):
            raise ValueError(section + " must be an array")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError(section + " entries must be objects")
            keys = ("label", "value", "definition") if section == "metrics" else ("title", "detail")
            for key in keys:
                required(item, key)
            refs(item.get("sources"))
            if section in ("accomplishments", "metrics") and not item["sources"]:
                raise ValueError(section + " requires evidence references")
            for key in ("owner", "target"):
                if key in item:
                    required(item, key)
    return data


def font_paths(regular=None, bold=None):
    if bool(regular) != bool(bold):
        raise ValueError("Supply both --font-regular and --font-bold")
    candidates = [(regular, bold)] if regular else [
        (str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf"),
         str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arialbd.ttf")),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ]
    for pair in candidates:
        if all(Path(p).is_file() for p in pair):
            return pair
    raise ValueError("No suitable fonts found; supply --font-regular and --font-bold TTF paths")


def render(data, output, regular=None, bold=None):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable

    validate(data)
    regular, bold = font_paths(regular, bold)
    pdfmetrics.registerFont(TTFont("Brief", regular))
    pdfmetrics.registerFont(TTFont("BriefBold", bold))
    pdfmetrics.registerFontFamily("Brief", normal="Brief", bold="BriefBold")
    # Fail before writing if the chosen fonts would silently substitute missing glyphs.
    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for child in value.values():
                yield from strings(child)
        elif isinstance(value, list):
            for child in value:
                yield from strings(child)

    for font in ("Brief", "BriefBold"):
        supported = pdfmetrics.getFont(font).face.charToGlyph
        missing = sorted({ch for s in strings(data) for ch in s if not ch.isspace() and ord(ch) not in supported})
        if missing:
            raise ValueError("Font lacks characters: " + " ".join(missing[:20]))

    navy, teal, muted = (colors.HexColor(c) for c in ("#142D40", "#087E83", "#526371"))
    styles = {
        "kicker": ParagraphStyle("kicker", fontName="BriefBold", fontSize=9, leading=13, textColor=teal, spaceAfter=8),
        "title": ParagraphStyle("title", fontName="BriefBold", fontSize=27, leading=32, textColor=navy, spaceAfter=10),
        "meta": ParagraphStyle("meta", fontName="Brief", fontSize=9, leading=13, textColor=muted, spaceAfter=10),
        "body": ParagraphStyle("body", fontName="Brief", fontSize=10.5, leading=15, textColor=navy, spaceAfter=8, splitLongWords=True),
        "summary": ParagraphStyle("summary", fontName="Brief", fontSize=12, leading=18, textColor=navy, spaceAfter=14),
        "section": ParagraphStyle("section", fontName="BriefBold", fontSize=15, leading=20, textColor=teal, spaceBefore=14, spaceAfter=8, keepWithNext=True),
        "item": ParagraphStyle("item", fontName="BriefBold", fontSize=11, leading=15, textColor=navy, spaceBefore=5, spaceAfter=4, keepWithNext=True),
        "source": ParagraphStyle("source", fontName="Brief", fontSize=9, leading=13, textColor=muted, spaceAfter=6, splitLongWords=True),
    }
    for style in styles.values():
        style.alignment = TA_LEFT
    story = []

    def paragraph(text, style="body"):
        return Paragraph(escape(text).replace("\n", "<br/>"), styles[style])

    def cite(ids):
        return " [" + ", ".join(ids) + "]" if ids else ""

    story.extend([
        paragraph("PROJECT STATUS / " + data["audience"].upper(), "kicker"),
        paragraph(data["project"], "title"),
        paragraph(f'{data["period_start"]} to {data["period_end"]} (inclusive) | {data["timezone"]}', "meta"),
        HRFlowable(width="100%", thickness=2, color=teal, spaceAfter=14),
        paragraph(data["status"].upper(), "kicker"),
        paragraph(data["status_reason"], "body"),
        paragraph(data["summary"] + cite(data["summary_sources"]), "summary"),
    ])
    if data.get("metrics"):
        story.append(paragraph("Measures that matter", "section"))
        for metric in data["metrics"]:
            story.append(paragraph(metric["value"] + " | " + metric["label"], "item"))
            story.append(paragraph(metric["definition"] + cite(metric["sources"]), "body"))
    for key, heading in (("accomplishments", "What changed"), ("risks", "Risks and blockers"),
                         ("next_steps", "Next period"), ("decisions", "Decisions needed")):
        story.append(paragraph(heading, "section"))
        if not data[key]:
            story.append(paragraph("No items evidenced in the available inputs.", "body"))
        for item in data[key]:
            story.append(paragraph(item["title"], "item"))
            story.append(paragraph(item["detail"] + cite(item["sources"]), "body"))
            extra = []
            if key in ("risks", "next_steps", "decisions"):
                extra = ["Owner: " + item.get("owner", "Unassigned"), "Target: " + item.get("target", "Unconfirmed")]
            if extra:
                story.append(paragraph(" | ".join(extra), "source"))
    story.append(paragraph("Evidence and coverage", "section"))
    story.append(paragraph(data["coverage"]))
    story.append(paragraph("Evidence extracted as of " + data["as_of"], "source"))
    for source in data["sources"]:
        story.append(paragraph(f'[{source["id"]}] {source["label"]} - {source["locator"]}', "source"))
    story.append(Spacer(1, 6))

    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".report-", suffix=".pdf", dir=output.parent)
    os.close(descriptor)
    pages = 0

    def frame(canvas, doc):
        nonlocal pages
        pages = doc.page
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#D4DFE5"))
        canvas.line(44, 41, A4[0] - 44, 41)
        canvas.setFont("Brief", 8)
        canvas.setFillColor(muted)
        canvas.drawString(44, 27, "PROJECT STATUS | " + data["period_end"])
        canvas.drawRightString(A4[0] - 44, 27, str(doc.page))
        if doc.page > 1:
            canvas.setFont("BriefBold", 8)
            canvas.drawString(44, A4[1] - 28, "PROJECT STATUS / CONTINUED")
        canvas.restoreState()

    try:
        doc = SimpleDocTemplate(temporary, pagesize=A4, leftMargin=44, rightMargin=44,
                                topMargin=46, bottomMargin=56, title=data["project"] + " - Project status",
                                author="Agent Forge", subject="Project status for " + data["audience"])
        doc.build(story, onFirstPage=frame, onLaterPages=frame)
        os.replace(temporary, output)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()
    return {"path": str(output), "pages": pages}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--font-regular")
    parser.add_argument("--font-bold")
    args = parser.parse_args()
    try:
        if args.input.resolve() == args.output.resolve():
            raise ValueError("Input and output paths must differ")
        data = json.loads(args.input.read_text(encoding="utf-8-sig"))
        result = render(data, args.output, args.font_regular, args.font_bold)
        print(json.dumps({"ok": True, "data": result, "error": None}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "data": None, "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
