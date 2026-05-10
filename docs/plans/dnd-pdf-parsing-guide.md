# D&D PDF Parsing Guide — Extraction Knowledge Base

> **Status**: Living document — update when a new book reveals different formatting  
> **Last updated**: 2026-05-09  
> **Source**: Spike work on `PlayerDnDBasicRules_v0.2_PrintFriendly.pdf` (115 pages)  
> **Tool**: pdfplumber (Python via uv) — see [dnd-extraction-spike.md](./dnd-extraction-spike.md) for tool selection rationale

---

## Why This Document Exists

D&D PDF formatting is not standardised across books. Font sizes, column counts, gutter widths, and table styles differ between publishers and editions. **Do not assume the values from one book carry over to the next** — run the calibration steps below on every new book before writing any ingestion code.

This document records confirmed values for books we have tested, plus calibration recipes to derive the equivalent values for new books quickly.

---

## Confirmed Books

### Player's Basic Rules v0.2 (`phb-basic-v0.2`)

**Source file**: `PlayerDnDBasicRules_v0.2_PrintFriendly.pdf`  
**Pages**: 115  
**Layout**: 2-column throughout (including chapter heading pages)  
**Page dimensions**: 594 × 783 pt

#### Font Hierarchy

| Size (pt) | Role | Example text |
|-----------|------|-------------|
| 24 | Chapter title | `Chapter 3: Classes` |
| 20 | Major entity name (class, race) | `Cleric`, `Dwarf` |
| 15 | Chapter subtitle / flavor | `Healers and Warriors` |
| 12 | **Named entity heading** (spells, conditions, features, backgrounds) | `Fireball`, `Blinded`, `Action Surge` |
| 11 | Chapter category label | `Classes` |
| 10 | Body text | Rule prose, descriptions |
| 9 | Italic / sidebar text | Italicized examples, sidebars |
| 8.5 | Footnotes / fine print | — |

**Key insight**: 12pt is the universal "named entity heading" size in this book. It marks:
- Spell names (Chapter 11)
- Condition names (Appendix A)
- Race feature names (Chapter 2)
- Class feature names (Chapter 3)
- Background names (Chapter 4)

This means **12pt detection is the primary chunking boundary signal** for all non-rule content.

#### Font Names

The fonts have a 6-char subset hash prefix (e.g. `PRRJNW+`). This prefix will differ per PDF instance and should be stripped before matching.

| Logical name | Embedded name (prefix stripped) | Used for |
|-------------|-------------------------------|---------|
| `ScalaSansOffc-Bold` | `ScalaSansOffc-Bold` | Section labels, small headings |
| `ScalaSansOffc` | `ScalaSansOffc` | Stat line labels (Casting Time, Range, etc.) |
| `ScalaSansScOffc` | `ScalaSansScOffc` | Small caps body text, page headers |
| `ScalaSansScOffc-Bold` | `ScalaSansScOffc-Bold` | Bold small caps |
| `MrsEavesAllSmallCaps` | `MrsEavesAllSmallCaps` | All-caps decorative text |
| `MrsEavesSmallCaps` | `MrsEavesSmallCaps` | Subheadings |
| `MrsEavesXLSerifOT-Reg` | `MrsEavesXLSerifOT-Reg` | Serif body text |
| `Bookmania-Regular` | `Bookmania-Regular` | Primary body serif |
| `Bookmania-RegularItalic` | `Bookmania-RegularItalic` | Italic body text |

**Note**: Do not hard-code font names for logic. Use font size as the primary signal; font name only for disambiguation when sizes overlap.

#### Column Layout

```
Page width:  594 pt
Left column: x0 ~63 → x1 ~288
Gutter:      ~288 → ~313  (25 pt gap)
Right column: x0 ~313 → x1 ~531
```

**Safe split point for `page.crop()`**: `x = 297` (page midpoint). Content never crosses this boundary in this book.

```python
mid = page.width / 2  # 297.0
left  = page.crop((0,   0, mid,        page.height)).extract_text()
right = page.crop((mid, 0, page.width, page.height)).extract_text()
```

**Both columns are present on all pages** including chapter title pages — verified on Chapter 3 (p20): left=397 words, right=432 words.

#### Page Header Format

Every content page starts with:
```
{page_number}
D&D Player's Basic Rules v0.2 | {chapter_or_section_title}
```

Strip this before processing:
```python
import re
HEADER_RE = re.compile(r'^\d+\s*\nD&D Player\'s Basic Rules[^\n]*\n', re.MULTILINE)
clean = HEADER_RE.sub('', raw_text).strip()
```

#### Text Line Structure

- Single newlines between all lines — **no double newlines** between paragraphs or blocks in raw pdfplumber output.
- Splitting on `\n\n` yields only 1 block per page. Do not rely on paragraph breaks.
- Spell/entity boundaries must be detected via font size or explicit pattern matching.

#### Spell Entry Pattern

Each spell entry in Chapter 11 follows this fixed format:
```
{Spell Name}              ← 12pt
{N}th-level {school}      ← 10pt
Casting Time: {value}     ← 10pt
Range: {value}
Components: {V/S/M} ({material description if M})
Duration: {value}
{Effect text paragraph(s)}
```

Detection: a 12pt word cluster immediately followed by a line matching `^\d+(st|nd|rd|th)-level` or `^cantrip` on the next line.

#### Condition Entry Pattern (Appendix A)

```
{Condition Name}    ← 12pt
A {condition name} creature...  ← 10pt prose
• Bullet 1
• Bullet 2
```

Same 12pt signal as spells. Differentiate by location (Appendix A page range: 106–108).

#### Table Characteristics

D&D Basic Rules tables are **visual text-column layouts**, not structural PDF table objects. pdfplumber's `extract_tables()` uses line/rectangle detection heuristics:
- Works reliably for tables with visible border lines
- Header rows are detected; data rows contain correct cell text
- Some cells may be empty where visual column alignment substitutes for content
- Table row example from Equipment chapter (p43): `['Padded', '5 gp', '11 + Dex modifier', '—', 'Disadvantage', '8 lb.']`

pdf-parse v2's `getTable()` returns empty cells for all D&D tables — do not use for this book.

---

## Calibration Recipe for New Books

Run this script on ~5 sampled pages of any new D&D PDF before writing ingestion code. Takes under 2 minutes.

```python
"""
Calibrate a new D&D PDF: discover font sizes, page dimensions, column layout.
Usage: uv run --with pdfplumber python calibrate.py <path-to-pdf>
"""
import pdfplumber, sys, collections
sys.stdout.reconfigure(encoding='utf-8')

PDF_PATH = sys.argv[1]
SAMPLE_PAGES = [5, 20, 50, 83, 100]  # adjust to content pages (skip cover/TOC)

with pdfplumber.open(PDF_PATH) as pdf:
    total_pages = len(pdf.pages)
    print(f"Total pages: {total_pages}")
    print(f"Page 1 dimensions: {pdf.pages[0].width:.1f} x {pdf.pages[0].height:.1f} pt\n")

    for page_num in SAMPLE_PAGES:
        if page_num > total_pages:
            continue
        page = pdf.pages[page_num - 1]
        print(f"=== Page {page_num} ===")

        # Font sizes
        size_counts = collections.Counter(round(c['size'], 1) for c in page.chars)
        print(f"  Font sizes (size: count): {dict(size_counts.most_common(8))}")

        # Font names (strip subset prefix)
        font_names = set(c['fontname'].split('+')[-1] for c in page.chars)
        print(f"  Font names: {sorted(font_names)}")

        # Column structure: histogram of x0 positions
        words = page.extract_words()
        x0_buckets = collections.Counter(round(w['x0'] / 10) * 10 for w in words)
        print(f"  x0 clusters (nearest 10pt): {dict(x0_buckets.most_common(6))}")

        # Page header sample
        raw = page.extract_text() or ''
        print(f"  First 120 chars: {raw[:120]!r}")

        # Table detection
        tables = page.extract_tables()
        print(f"  Tables found: {len(tables)}")
        if tables:
            print(f"    First table rows: {len(tables[0])}, cols: {len(tables[0][0])}")
            print(f"    Header row: {tables[0][0]}")
        print()
```

### What to Record After Calibration

For each new book, add a section to this document with:

- [ ] Page dimensions (width × height pt)
- [ ] Font size → role mapping (run on 3+ different content types)
- [ ] Column count and split point(s)
- [ ] Page header regex pattern
- [ ] Named entity heading font size (equivalent of 12pt in Basic Rules)
- [ ] Spell entry structural pattern (if applicable)
- [ ] Table structure observation (visual vs structural, border style)

---

## Common Pitfalls

### Multi-column text without crop
pdfplumber's default `extract_text()` reads words left-to-right across the full page width, which mixes left and right column content mid-sentence. **Always crop to columns first.**

### Relying on double newlines
D&D PDFs use single newlines throughout — no blank lines between paragraphs in raw extraction. Any code that splits on `\n\n` will get 1 block per page.

### Font size rounding
pdfplumber returns float sizes. Always round: `round(c['size'], 1)`. A "12pt" heading may be `11.96` or `12.04` depending on the PDF renderer.

### Subset font prefix
Embedded font names include a 6-char hash prefix (e.g. `PRRJNW+Bookmania-Regular`). Strip it before any font name matching: `fontname.split('+')[-1]`.

### Table cells that appear empty
Some table columns use visual spacing (no ruled lines) that pdfplumber misses. Check the table bounding box and use `extract_text()` on the cropped region as a fallback.

### Page numbers included in extracted text
Both pdfplumber and pdf-parse v2 include the printed page number as the first character(s) of the page text. Always strip the header block (page number + title line) before chunking.

### Chapter title pages are still 2-column
Even pages that look like single-column chapter intros have content in both columns. Do not detect "is this a chapter page?" and skip column splitting — both columns need extraction on every page.

---

## Ingestion Config Pattern

To avoid hardcoding book-specific values, the production extractor should accept a config object per book slug:

```python
BOOK_CONFIGS = {
    "phb-basic-v0.2": {
        "page_width": 594.0,
        "column_split_x": 297.0,         # page.crop(0, 0, split_x, h) for left col
        "entity_heading_size": 12.0,      # font size that marks named entity headings
        "chapter_title_size": 24.0,       # font size for chapter titles
        "entity_name_size": 20.0,         # font size for class/race names
        "header_pattern": r"^\d+\s*\nD&D Player's Basic Rules[^\n]*\n",
        "spell_level_pattern": r"^\d+(st|nd|rd|th)-level|^cantrip",
    },
    # Add new books here after running calibration
}
```

---

## Useful pdfplumber Snippets

```python
# All chars at a given font size on a page
chars_12pt = [c for c in page.chars if round(c['size'], 1) == 12.0]

# Reconstruct words from consecutive chars (same y-position, same size)
from itertools import groupby
words_12pt = []
for (y, size), group in groupby(chars_12pt, key=lambda c: (round(c['top']), round(c['size']))):
    words_12pt.append(''.join(c['text'] for c in group).strip())

# Extract left column only
left_text = page.crop((0, 0, page.width / 2, page.height)).extract_text() or ''

# Extract tables and get first row as header
for table in page.extract_tables():
    header = table[0]
    rows = table[1:]

# Strip page header (page number + title line)
import re
clean = re.sub(r'^\d+\s*\n[^\n]+\n', '', raw_text).strip()
```
