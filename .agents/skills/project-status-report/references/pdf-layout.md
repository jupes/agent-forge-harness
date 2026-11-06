# PDF contract and layout

Read at the rendering stage. The helper handles layout, not factual verification.

## Runtime

Use an available bundled document runtime when the host provides one; otherwise
use the project's Python environment. Check `python -c "import reportlab"`.
On Windows and other hosts without an IANA timezone database, also install `tzdata`
in that environment so Python's `zoneinfo` can resolve reporting timezones.
If absent, install ReportLab in a task-local virtual environment using
`python -m pip install reportlab tzdata`. Do not add it to the harness's JavaScript manifest.
An unavailable dependency is a rendering blocker, not a reason to invent an artifact.

The renderer discovers Arial on Windows or DejaVu Sans on Linux. For another host,
pass both `--font-regular <ttf>` and `--font-bold <ttf>`. Use licensed fonts with glyph
coverage for the report language; supply a suitable font for CJK or other scripts.
It rejects unsupported characters rather than producing missing-glyph boxes.

## Input JSON

See [example-report.json](../assets/example-report.json). Required fields:

- `project`, `audience`, `period_start`, `period_end` (inclusive ISO dates),
  `timezone` (IANA name), `as_of` (timestamp with offset), `status`, `status_reason`.
- `summary`: a short paragraph; `summary_sources`: IDs supporting the assessment.
- `accomplishments`, `risks`, `next_steps`, `decisions`: arrays of objects with
  `title`, `detail`, and `sources` (source IDs). Optional `owner` and `target`.
- `metrics`: optional objects with `label`, `value`, `definition`, and `sources`.
- `sources`: objects with unique `id`, `label`, and `locator`. Locators are readable
  issue IDs with titles or document sections, not local absolute paths.
- `coverage`: a paragraph describing input coverage and limitations.

Source arrays may be empty for explicitly labeled proposals or unknowns. Confirm
that factual accomplishments have evidence before rendering; the helper cannot
decide whether the sources substantiate the prose. All input text is plain text;
markup is escaped. Array order controls narrative order. Empty sections explicitly
state that no item was evidenced, rather than asserting there are no risks.

## Layout

Use a white page, dark navy typography, restrained teal accents, generous margins,
and a clear title/date hierarchy. Aim for a two-page leadership brief, with longer
source notes on subsequent pages when needed. Use 10.5–11 pt body text with comfortable
leading, short outcome headings, and page numbers. Avoid a separate decorative cover.

The renderer uses flowing paragraphs and repeatable headers/footers, not fixed-height
cards. Status is written as text, so meaning survives monochrome printing. Keep
accomplishments concise and risk/decision details actionable. Use tables or charts only
when comparisons benefit from them; no decorative progress rings or fabricated KPIs.

The generated PDF has selectable text and document metadata. It is not certified
PDF/UA; if the user requires a tagged accessible PDF, use a capable export pipeline
and validate reading order and tags separately.

## Verification

Render with available Poppler:

```bash
pdftoppm -r 120 -png <report.pdf> <preview-prefix>
```

Or use PyMuPDF if installed: open the PDF and save each page's `get_pixmap()` as PNG.
Use `pypdf`, `pdfplumber`, or PyMuPDF for text extraction. Inspect all PNGs with the
host image viewer. Check page breaks, long names/URLs, source notes, glyph coverage,
and footer clearance. Render a dense case as well as the ordinary report after
changing the helper. The latest inspected PDF is the deliverable.

To run the helper's regression checks, install `pypdf` in the same environment and run
`python -B -m unittest discover -s .claude/skills/project-status-report/scripts -p "test_*.py"`.
