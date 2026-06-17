# Plan: dnd-monster-decollapse — MM/monster family + neighbor statblock de-collapse

Generated: 2026-06-15
Repo: repos/rag-chat
Phase: plan (2/4) — from plans/research/dnd-monster-decollapse.md

## Summary

71 monster entities merge multiple stat blocks under one name because individual monster names fail
`is_caps_heading`, so each `Armor Class` anchor inherits a family header or the previous monster via
`_assign_anchor_owners` Rule 3. **Plan-review correction:** names fail for TWO reasons, and size is
the *minor* one — the dominant miss is the **uppercase-ratio gate** (mixed-case OCR names like
`Kuo-ToA` at 14.7pt fail the 0.6 upper-ratio), and names are frequently **not adjacent** to the
type/AC anchor (body/page-number/column gaps). Fix: broaden the monster-name candidate test on BOTH
dimensions (relaxed upper-ratio AND a size floor), and bind via `_assign_anchor_owners`
**position-scoring** (not a fixed adjacency window); preserve the legit family fallback (Beholder,
no individual name). **Measure** which lever recovers how many of the 64 on a real re-extract before
locking the heuristic. Re-extract + replace-embed mm/ravnica/mtf/xge; verify collapse detector → ~0
monster offenders, Hit@1 ≥ 83.3%.

## Existing Code to Reuse

- `extract_scan.py` — `extract_mm_chunks:251` (two-pass; pass-1 collect at `:271-282`),
  `_assign_anchor_owners:200` (Rule 1/2/3 position scoring), `is_caps_heading:151`
  (size ≥ heading_min AND upper-ratio ≥ 0.6), `is_type_line:614`, `_STAT_FIELD_WORDS`,
  `recover_statblock_name` (supplement), `recent_headings:694` list, `_MM_STAT_ANCHOR:133`.
- mm-5e config: `heading_min_pt 10.5`, `min_body_pt 7.0` (names **are** in the `visible` stream — not
  dropped — they just fail `is_caps_heading`). **Two failure modes (measured on real MM):**
  (1) **upper-ratio** — `Kuo-ToA` at 14.7pt fails the 0.6 upper-ratio (3/6 = 0.5); this is the
  *dominant* miss for mixed-case OCR names; (2) **size** — `STORM GIANT` at 10.1pt < 10.5.
- `ingestion/qa_chunks.py: detect_collapse` + `--collapse-check --from-db` (regression gate).
- `ingestion/golden_entities.json` + `test_golden_entities.py` (extend with canonical monsters).
- `embed.py --replace-book` (no-orphan re-embed). Re-extract: pdfplumber for mm, fitz for supplements.

## TDD Strategy (red-green-refactor)

Behaviors tested through the public extractors over synthetic `LineItem` streams (no DB/PDF),
vertically. Preserve `test_mm_no_heading_falls_back_to_family_section:182` (must stay green).

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | A **mixed-case** name that fails the upper-ratio gate (e.g. `Kuo-ToA` 14.7pt, ratio 0.5) owns its own stat block, not the previous monster | `test_extract_scan.py` | **yes** |
| 2 | A **size**-sub-threshold name (`STORM GIANT` 10.1pt) owns its own stat block, not the family header | `test_extract_scan.py` | no |
| 3 | A stat block with NO individual name near it still inherits the family/section header (Beholder case — unchanged) | `test_extract_scan.py` | no |
| 4 | A name separated from its AC anchor by body/page-number/column lines is still bound to its stat block via position scoring (not just strict adjacency) | `test_extract_scan.py` | no |
| 5 | Consecutive stat blocks (Kraken → Kuo-Toa neighbor) each get their own name, not merged | `test_extract_scan.py` | no |
| 6 | Supplement path (ravnica/mtf): a name-candidate that failed the gate recovers its own name via `recover_statblock_name` | `test_extract_scan.py` | no |
| 7 | A caps/name-ish body line that is NOT near any AC anchor is NOT promoted to a stat-block owner (no false headings in prose) | `test_extract_scan.py` | no |
| 8 | Golden monsters (Lich/Tarrasque/Mind Flayer) stay correct + new canonical monsters (Fire/Storm Giant, Kraken) present in re-extracted JSONL | `test_golden_entities.py` | no |

Refactor watch-list: factor a shared `is_monster_name_candidate(line)` (short, alpha, not a type line
/ stat-field, **relaxed upper-ratio** so mixed-case OCR names qualify) used by both extractors.

## Build Sequence & Checkpoints

### Checkpoint A — MM name recovery: upper-ratio + size, position-scored  *(tracer)*
Steps:
1. **Measure first.** On a real MM re-extract, count how many of the 64 mm offenders each lever
   recovers: (a) relax the upper-ratio gate, (b) relax the size floor, (c) position-scored binding.
   Lock the candidate test from the data, not assumption. (`/tmp/mm.jsonl` + `--collapse-check`.)
2. Add `is_monster_name_candidate(line)` — short, mostly-alpha, not a type line / stat-field word,
   with a **relaxed upper-ratio** (catch `Kuo-ToA`) and a **size floor** (catch `STORM GIANT`).
   Collect these as name candidates in `extract_mm_chunks` pass-1 (`:271-282`) — `extract_scan.py`.
3. Bind each AC anchor to a candidate via **`_assign_anchor_owners` position scoring** (Rule 1/2:
   nearest preceding same/either-column by stream distance — NOT a fixed adjacency window, since the
   name is often separated from the type/AC by body/page-number/column). Rule 3 (family) only when no
   candidate exists. Tests 1–5, 7 red → green; **test:182 (Beholder) stays green**.
Demo: `uv run python ingestion/test_extract_scan.py` (Kuo-ToA/giants/Kraken/Beholder/no-false-heading green).
Then re-extract: `uv run --with pdfplumber python ingestion/extract_scan.py "../DnD-Books/5e/Books/D&D 5E - Monster Manual.pdf" --book-slug mm-5e --out /tmp/mm.jsonl`
then `uv run python ingestion/qa_chunks.py --collapse-check /tmp/mm.jsonl` → mm monster offenders ~0; `Fire Giant`/`Kraken`/`Kuo-Toa` are distinct entities.

### Checkpoint B — supplement-path name recovery (ravnica/mtf/xge)
Steps:
1. Let `is_monster_name_candidate` lines (relaxed upper-ratio + size floor) reach `recent_headings`
   / `recover_statblock_name` so supplement stat blocks recover their own name — `extract_scan.py`.
   Test 6 red → green.
Demo: `uv run python ingestion/test_extract_scan.py` (supplement de-collapse test green).

### Checkpoint C — golden canonical monsters
Steps:
1. Add canonical monsters to `ingestion/golden_entities.json` (e.g. `Fire Giant`, `Storm Giant`,
   `Kraken` — currently collapsed). Test 8 red now → green after re-extract — `golden_entities.json`.
Demo: `uv run python ingestion/test_golden_entities.py`.

### Checkpoint D — re-extract + replace-embed + verify (no new unit test)
Steps:
1. Re-extract mm (pdfplumber) + ravnica + mtf + xge (fitz); run collapse-check gate per book.
2. QA-split → `embed.py --replace-book` each clean JSONL.
3. Verify: `--collapse-check --from-db` monster offenders ~0; golden 1/1; eval Hit@1 ≥ 83.3%;
   spot-check `RagRetriever('fire giant')`/`('kraken')` → answerable, correct entity.
Demo: ask "what is a fire giant?" → grounded answer citing mm-5e Fire Giant (not "Giants").

## Files to Create / Modify

| File | Create/Modify | Purpose |
|------|---------------|---------|
| `ingestion/extract_scan.py` | Modify | `is_monster_name_candidate` (relaxed upper-ratio + size floor) collection (A) + supplement recovery (B); position-scored binding |
| `ingestion/test_extract_scan.py` | Modify | tests 1–7 (Kuo-ToA mixed-case, giants, non-adjacent binding, Kraken-neighbor, Beholder-preserved, no-false-heading, supplement) |
| `ingestion/golden_entities.json` | Modify | add canonical monsters (Fire Giant, Storm Giant, Kraken) |

## Validation Commands
```bash
uv run python ingestion/test_extract_scan.py
uv run python ingestion/test_golden_entities.py
uv run --with "psycopg[binary]" python ingestion/qa_chunks.py --collapse-check --from-db   # monster offenders ~0
PYTHONUTF8=1 uv run --with "psycopg[binary]" --with openai python ingestion/eval_golden.py  # Hit@1 >= 83.3%
```

## Beads Issue Map
(0im.3 is the tracking task; checkpoint tasks created as children below)

| Beads ID | Type | Title | Depends on | Priority |
|----------|------|-------|-----------|----------|
| `0im.3` | task | MM/monster family + neighbor statblock de-collapse (tracking) | — | P2 |
| A | task | MM sub-threshold monster-name recovery (extract_mm_chunks) | — | P2 |
| B | task | Supplement-path sub-threshold name recovery | A | P2 |
| C | task | Golden canonical monsters | A | P2 |
| D | task | Re-extract + replace-embed mm/ravnica/mtf/xge + verify | A,B,C | P2 |

## Estimated Scope
- Files: 0 new / 3 modified; Complexity: **Medium-High** (touches the healthiest category; re-embed + eval); Checkpoints: 4.

## Risks & Mitigations
- **False headings from relaxing the gates** → candidate must be near an AC anchor (position-scored,
  not bound otherwise) + test 7 + the collapse detector + Hit@1 eval catch regressions.
- **Don't regress the 378 healthy MM monsters / Beholder fallback** → test:182 preserved; eval gate.
- **Sub-threshold names may be OCR-garbled** (`Marl Lith`) → still better to bind a stat block to *a*
  per-monster name than collapse into a neighbor; perfect text is 6om/1nh territory.

## Plan-review corrections applied (reports/dnd-monster-decollapse-plan-review.md)
- **[High]** Fix now targets BOTH failure modes — the dominant **upper-ratio** gate (`Kuo-ToA` 14.7pt,
  ratio 0.5) *and* size — via `is_monster_name_candidate`, and binds with **`_assign_anchor_owners`
  position scoring** (not a fixed ~2-line adjacency window, since names are separated from the
  type/AC by body/page-number/column). CP-A **measures** which lever recovers how many of the 64
  before locking the heuristic.
- **[Low]** Refreshed line refs (`_assign_anchor_owners:200`, `extract_mm_chunks:251`,
  `is_caps_heading:151`, `is_type_line:614`, pass-1 `:271-282`).
