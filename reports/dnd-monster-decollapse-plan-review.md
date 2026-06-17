# Plan Review: dnd-monster-decollapse — MM/monster family + neighbor statblock de-collapse
Source: plans/drafts/dnd-monster-decollapse.md · Reviewed: 2026-06-15

## Verdict: NEEDS REVISION — 0B / 1H / 0M / 1L

The plan correctly identifies the symptom (71 monster entities merge stat blocks) and the integration
points (`extract_mm_chunks` / `_assign_anchor_owners` / `recent_headings` all exist; config + the
`min_body`-doesn't-drop-names premise verified). But its **fix mechanism is mis-targeted**: real MM
data shows the dominant failure is the **uppercase-ratio gate** (mixed-case OCR names like `Kuo-ToA`
at 14.7pt — well above the size threshold — fail `is_caps_heading`'s 0.6 upper-ratio), and the name
is frequently **not adjacent** to the type/AC anchor. The size-based, "within ~2 lines" approach as
written would under-fix.

## Findings

### [HIGH] Fix targets size-based sub-threshold names + a fixed adjacency window; real failure is the caps gate + non-adjacent names — Checkpoint A / TDD #1
**What:** The plan's mechanism is "collect a caps-leaning short line **below `heading_min` but ≥ a
`name_floor`** that is **immediately followed (within ~2 lines) by a type line or AC anchor**." It
assumes (a) names fail only by *size* and (b) the name sits ~2 lines from the type/AC anchor.
**Why it's an issue:** Both assumptions are contradicted by the real MM stream, so implementing as
written recovers only the clean size-only cases (e.g. `STORM GIANT` 10.1pt) and **misses the bulk** of
the 64 mm collapses — leaving the headline cases (the Kraken neighbors) still merged.
**Evidence (pdfplumber stream, Monster Manual, 2026-06-15):**
- `Kuo-ToA` renders at **14.7pt** (above `heading_min` 10.5) yet `is_caps_heading(...) = False` —
  its upper/letters ratio is 3/6 = **0.50 < 0.60** (`is_caps_heading:151`, `min_upper_ratio=0.6`).
  Size-based recovery never triggers here; the real miss is the **caps/upper-ratio gate**.
- AC anchor idx 15494 (p201): the 4 lines above are all body prose — **no name or type line nearby**.
- AC anchor idx 15534 (p201): the line where the name should be is the page number `200` (6.1pt); the
  type line is present but the name is further up/in another column. The "within ~2 lines" window
  would bind nothing (or the page number).
— Confidence: **Confirmed**
**Suggested correction:** Broaden the name-candidate test to also relax the **upper-ratio** dimension
(so mixed-case OCR names like `Kuo-ToA` qualify), not just size; and recover the name by **position
scoring** (reuse the `_assign_anchor_owners` Rule 1/2 same-page/either-column nearest-by-stream-distance
approach) rather than a fixed 2-line adjacency window. In CP-A, **measure** how many of the 64 mm
offenders each lever fixes against a real re-extract before locking the heuristic; keep the
Beholder/no-name case falling back to the family header.

### [LOW] Stale line numbers in the plan — "Existing Code to Reuse"
**What:** Cited lines drifted (`_assign_anchor_owners:198`→**200**, `extract_mm_chunks:249`→**251**,
`is_caps_heading:149`→**151**, `is_type_line:545`→**614**).
**Why it's an issue:** Cosmetic — the symbols all exist; line refs moved after this session's
ocr_normalize/casting-time edits.
**Evidence:** `grep -nE "^def …" ingestion/extract_scan.py` (2026-06-15). — Confidence: Confirmed
**Suggested correction:** Refresh the line numbers (or drop them; symbol names suffice).

## Verified as accurate (spot-checks)
- `extract_mm_chunks` (`:251`), `_assign_anchor_owners` (`:200`, Rule 1/2/3), `is_caps_heading` (`:151`),
  `is_type_line` (`:614`), `_MM_STAT_ANCHOR` (`:133`), `recent_headings` (`:694`) all exist ✓
- mm-5e config: `heading_min_pt 10.5`, `min_body_pt 7.0`, engine `pdfplumber` ✓
- **Core premise holds:** sub-threshold names ARE in `visible` (`min_body 7.0`; STORM GIANT 10.1 ≥ 7.0)
  but are collected as neither heading nor anchor — `extract_scan.py:271-282` ✓
- Beholder family-fallback test exists and is the right preserve-target — `test_extract_scan.py:182` ✓
- Regression guards exist + were exercised last run: `detect_collapse`/`--collapse-check --from-db`,
  `golden_entities.json`/`test_golden_entities.py`, `embed.py --replace-book` ✓

## Not verified
- The exact split of the 64 mm offenders fixable by (upper-ratio relax) vs (size relax) vs (position
  scoring) — determinable only by a real re-extract; CP-A should measure it before finalizing the
  heuristic (folded into the suggested correction).
