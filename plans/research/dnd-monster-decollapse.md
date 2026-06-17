# Research: dnd-monster-decollapse — MM/monster family + neighbor statblock collapse

Generated: 2026-06-15
Repo: repos/rag-chat
Phase: research (1/4)

## Goal

The collapse detector (built in 0im) flags **71 monster entities** whose chunks carry more than one
stat-anchor — i.e. multiple monster stat blocks merged under one name. The acute spell collapse was
fixed in 0im; this run fixes the **monster** equivalent so individual monsters (giants, the Kraken's
neighbors, dragon wyrmlings, devils, demons…) are retrievable by their own name. Deferred bead is
agent-forge-harness-0im.3.

## What the Code Says (answered by exploration)

### Scope (DB collapse-check `--from-db`, 2026-06-15)
- **71 offenders total: 64 mm-5e, 5 ravnica-5e, 1 mtf-5e, 1 xge-5e.** MM is the bulk.
- Two shapes, same root cause:
  - **family/section header owns members:** `Giants`(6 anchors/24 chunks), `Elementals`(4/7),
    `Be'Holders`(3/10).
  - **a named monster absorbs its alphabetical neighbors:** `Kraken` p198 (real AC 18) absorbs 5
    more stat blocks on p200–203 (AC 13/11/13/13/17 = Kuo-toa, Lamia, Lich, Lizardfolk…), all named
    `Kraken`. Also `Wereboar`(5), `Glabrezu`(4), `Hobgoblin Captain`(4), `Ultroloth`(4), dragon
    wyrmlings, devils, etc.

### Root cause
- The MM uses the two-pass `extract_mm_chunks` (`extract_scan.py:249`); `mm-5e` config is
  `heading_min_pt: 10.5`, engine `pdfplumber`.
- `_assign_anchor_owners` (`extract_scan.py:198`) binds each `Armor Class` anchor to a **caps
  heading** (`is_caps_heading`, size ≥ 10.5). When the individual monster's name line renders
  **below 10.5** (confirmed: `STORM GIANT` = 10.1pt), it isn't collected as a heading, so the anchor
  falls through to **Rule 3 — nearest preceding heading anywhere** = the family header or the previous
  monster's name. That is the collapse. (`mm-5e` has 378 distinct names that *did* clear 10.5; ~64 of
  them act as magnets for ~130+ neighbors whose names didn't.)
- The supplement path (`extract_supplement_chunks`, used by ravnica/mtf/xge) has `recover_statblock_name`
  + `recent_headings`, but `recent_headings` only holds lines that passed `is_heading` (bold or
  caps ≥ heading_min) — so sub-threshold names miss there too. Same root cause, both paths.

### Critical constraint — legitimate family fallback must be preserved
- `test_mm_no_heading_falls_back_to_family_section:182` encodes intended behavior: the **Beholder**
  case has **no individual name line** near the stat block (only the `BEHOLDERS` family header + lore,
  then the type line `Large aberration…`), and it *should* inherit `Beholders`. The fix must therefore
  recover an individual name **only when one actually exists** (a short caps line just above the
  `<size> <type>` line), and otherwise keep the family fallback.

### The proven pattern to reuse
- 0im already solved the analogous spell problem two ways we can mirror: the **name-size exemption**
  (keep a name-looking line that renders just below the body/heading floor) and `recover_statblock_name`
  (walk back past the type line + stat-field words to the name). `is_type_line` (`extract_scan.py:545`)
  and `_STAT_FIELD_WORDS` already exist to support type-line-relative recovery.
- Regression guards are already in place: `detect_collapse`/`--collapse-check --from-db` (must drop to
  ~0 monster offenders) and the golden test (Lich/Tarrasque/Mind Flayer must stay correct).

### Existing MM test coverage (where new tests go) — `test_extract_scan.py`
- `test_mm_extracts_stat_blocks_per_monster:113`, `test_mm_cross_column_ownership:147`,
  `test_mm_no_heading_falls_back_to_family_section:182` (the constraint above),
  `test_vgm_monster_named_from_heading_not_type_line:502`.

## Decisions Resolved with the User

| Question | Decision | Rationale |
|----------|----------|-----------|
| Route | **Full pipeline** | Cross-cutting change to the healthiest category (378 entities) + re-extract/re-embed/eval; the plan-review gate caught a real HIGH on the analogous spell work. |

## Constraints & Non-Goals

- **Constraint — don't regress the 378 healthy MM monsters** or the Beholder-style legit family
  fallback. Recovery activates only when a sub-threshold individual name is actually present.
- **Constraint — don't regress eval Hit@1 (83.3%)** or the golden test.
- **Non-goal — re-OCR / source text quality** (that's 6om/1nh). This is about *which name owns which
  stat block*, not character-level OCR.
- **Non-goal — `Demilich`-style single large entries** (one stat block + lots of lore is correct; the
  detector already doesn't flag them).

## Open Risks / Assumptions Carried Forward

- Sub-threshold monster names may themselves be OCR-garbled (e.g. `Marl Lith` = Marilith,
  `Be'Holders`); recovery should still bind the stat block to *a* per-monster name even if the name
  text is imperfect (better than collapsing into a neighbor). Perfect names are a 6om concern.
- MM re-extraction uses pdfplumber (slower, noisier) — re-extract MM + the 3 supplement books, then
  re-embed only those.

## Recommended Scope for Planning

Port **type-line-relative, sub-threshold name recovery** into both extractors:
1. In `_assign_anchor_owners` / `extract_mm_chunks`: for each `Armor Class` anchor, prefer a short
   caps name line immediately above the `<size> <type>` line (collected even when below
   `heading_min`), skipping type lines + stat-field words; fall back to the current family/Rule-3
   owner only when no such name exists (preserves the Beholder test).
2. In `extract_supplement_chunks`: let sub-threshold caps names reach `recent_headings` /
   `recover_statblock_name` so ravnica/mtf/xge stat blocks recover their own name.
3. Re-extract mm + ravnica + mtf + xge → QA → replace-embed → verify: `--collapse-check --from-db`
   monster offenders ~0, golden green, Hit@1 ≥ 83.3%, spot-check Kraken/Kuo-toa & a giant species
   retrieve by name. TDD with new cases (giant family, Kraken-neighbor) alongside the preserved
   Beholder test.
```
