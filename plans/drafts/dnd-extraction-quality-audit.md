# Plan: dnd-extraction-quality-audit — Systemic chunk mis-extraction fix + regression guard

Generated: 2026-06-14
Repo: repos/rag-chat
Phase: plan (2/4) — from plans/research/dnd-extraction-quality-audit.md

## Summary

Harden `extract_supplement_chunks` so OCR-corrupted spell anchors still split + name each spell
(fault A/B), stop field/stat lines from becoming entity-names (D), and prefer an individual monster
name over a family-section header (C). Add a **corpus-wide collapse-detector** to the pre-embedding
QA gate plus a **canonical-entity golden test** as the permanent "don't-regress" guard, then
re-extract + re-embed the changed books and prove Fireball (and 14 other canonical spells) retrievable
with Hit@1 ≥ prior. TDD-first; every fault class gets a failing test before the fix.

## Existing Code to Reuse

- `ingestion/extract_scan.py` — `extract_supplement_chunks:584`, `_SPELL_ANCHOR_RE:513`,
  `open_anchored:665`, `recover_statblock_name:632`, `is_heading:627`, `classify_content_type:561`.
- `ingestion/qa_chunks.py` — `entity_name_ok:79`, `classify_chunk:101`, `run_qa:127` (per-chunk; the
  aggregate collapse check is new here).
- `ingestion/test_extract_scan.py` — `_run()` self-runner; existing
  `test_supplement_extracts_spells_via_anchor:430`,
  `test_supplement_spell_name_not_swallowed_by_prior_chunk:448` (passes on clean input — extend with
  garbled cases), `test_caps_heading_accepts_ocr_mixed_case:205`.
- `ingestion/test_qa_chunks.py` — `_run()` self-runner for the new QA tests.
- `ingestion/embed.py` — idempotent re-embed (per-book). `ingestion/eval_golden.py` + `golden_set.json`
  — Hit@1 regression baseline. `ingestion/retrieval.py` `RagRetriever` — the live demo check.

## TDD Strategy (red-green-refactor)

Following .claude/skills/tdd. Behaviors tested through pure functions over synthetic `LineItem`
streams / chunk dicts (no DB, no PDF), vertically — one failing test → minimal code → repeat.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | A spell whose level/school line is OCR-garbled ("Evoeation eantrip", "3rd-leveI evocation") still opens its own chunk named for the line above it | `test_extract_scan.py` | **yes** |
| 2 | The PHB Fireball lines (name "Fireball" + garbled "3rd-leveI evocation" + body) extract as one `spell` chunk with `entity_name="Fireball"` | `test_extract_scan.py` | no |
| 3 | When the strict + fuzzy anchor both miss, a spell-shaped block still does not merge into the previous chunk (fallback boundary) | `test_extract_scan.py` | no |
| 4 | A field/stat line ("Components: V, S", "Duration: 1 Minute", "Spell Descriptions", "Casting Time: 1 action") is never emitted as an `entity_name` | `test_extract_scan.py` | no |
| 5 | `entity_name_ok` returns False for stoplisted field/section names (defense in depth at the QA gate) | `test_qa_chunks.py` | no |
| 6 | A statblock anchor following a family header ("GIANTS") names the chunk for the individual monster, not the family | `test_extract_scan.py` | no |
| 7 | The collapse detector flags an `(entity_name, page_start)` group with > N chunks, and a per-book distinct-entity ratio below the floor | `test_qa_chunks.py` | no |
| 8 | Golden check: every canonical entity (Fireball + 14 spells across schools/levels) appears in the re-extracted JSONL as a correctly-named `spell` chunk | `test_golden_entities.py` | no |

Refactor watch-list (after green): factor a single `fuzzy_anchor` / OCR-normalize helper reused by
spell + feat + statblock detection; share the field-word stoplist between extraction and `qa_chunks`.

## Build Sequence & Checkpoints

### Checkpoint A — OCR-tolerant spell anchoring + fallback (fault A/B)  *(tracer)*
Steps:
1. Add an OCR-normalize helper (c↔e, l↔I↔1, 0↔O, 5↔S) used to test the school/level pattern — `extract_scan.py`.
2. Broaden `_SPELL_ANCHOR_RE` matching via the normalized line; add a fallback in `open_anchored`/main loop so a spell-shaped block without a clean anchor still starts a new chunk — `extract_scan.py`.
3. Tests 1–3 red → green.
Demo: `uv run python ingestion/test_extract_scan.py` (spell tests green, incl. garbled). Then
`uv run python ingestion/extract_scan.py "../DnD-Books/5e/Books/D&D 5E - Player's Handbook.pdf" --book-slug phb-5e --out /tmp/phb.jsonl`
and grep the JSONL → `entity_name="Fireball"` present.

### Checkpoint B — reject junk/field entity-names (fault D)
Steps:
1. Field/section stoplist (`Components`, `Duration`, `Casting Time`, `Range`, `Spell Descriptions`, `At Higher Levels`, …); block these from becoming `cur_entity` in `is_heading`/flush — `extract_scan.py`.
2. Mirror the stoplist in `entity_name_ok` — `qa_chunks.py`. Tests 4–5 red → green.
Demo: `uv run python ingestion/test_extract_scan.py && uv run python ingestion/test_qa_chunks.py` green.

### Checkpoint C — monster-section de-collapse (fault C)
Steps:
1. In `recover_statblock_name`/`open_anchored`, prefer the nearest non-family individual name; treat a plural/family header ("GIANTS") as a section, not the entity, when a distinct name is available — `extract_scan.py`. Test 6 red → green.
Demo: `uv run python ingestion/test_extract_scan.py` (Demilich/Giants test green).

### Checkpoint D — corpus-wide collapse-detector QA gate
Steps:
1. New aggregate check in `qa_chunks.py`: `detect_collapse(chunks)` → offenders where an
   `(entity_name, page_start)` group exceeds `COLLAPSE_MAX` or a book/content_type distinct-entity
   ratio is below `DISTINCT_FLOOR`; surface in `run_qa`'s report + non-zero exit. Add the
   `--collapse-check` CLI flag here (it does not exist pre-CP-D) — `qa_chunks.py`. Test 7 red → green.
Demo: `uv run python ingestion/qa_chunks.py --collapse-check ingestion/chunks-phb-5e.jsonl` on the
**current** committed JSONLs → it FLAGS Eldritch Blast(28)/Demilich(22) (proves it catches the real
bug); after Checkpoints A–C re-extract → clean. The same detector is re-run **against the DB** in CP-F.

### Checkpoint E — canonical-entity golden regression test
Steps:
1. `golden_entities.json` (Fireball, Magic Missile, Counterspell, Wish, Cure Wounds, Healing Word,
   Shield, Lightning Bolt, Polymorph, Sleep, Haste, Misty Step, Bless, Mage Hand, Eldritch Blast)
   with expected book/content_type; `test_golden_entities.py` asserts each is a correctly-named chunk
   in the re-extracted JSONL — new files. Test 8 red (now) → green (after re-extract).
Demo: `uv run python ingestion/test_golden_entities.py`.

### Checkpoint F — re-extract + re-replace-embed + verify (no new unit test)
Steps:
1. Re-extract every book whose output changed; run the `qa_chunks` collapse gate (must pass).
2. **Replace, don't just upsert.** `embed.py` is upsert-only (`ON CONFLICT (chunk_id) DO UPDATE`,
   embed.py:110) and `chunk_id` is keyed on a per-extraction counter (extract_scan.py:653), so
   re-extraction produces new ids and the **old mis-tagged rows would be orphaned, not overwritten**.
   Add an `embed.py --replace-book` mode (or an explicit `DELETE FROM dnd.chunks WHERE book_slug=:slug`
   in one transaction) that clears a book's rows before inserting the re-extracted chunks.
3. **No-orphans assertion** per changed book: `SELECT count(*) FROM dnd.chunks WHERE book_slug=:slug`
   equals the new JSONL line count; and re-run the collapse detector **against the DB** (not just the
   JSONL) so stale rows can't hide.
4. Live check: `RagRetriever` on "fireball?" → `answerable=true`, Fireball citation; re-run
   `eval_golden.py` → Hit@1 ≥ prior 80.5%.
Demo: ask "fireball?" in the chat UI → grounded answer with a PHB Fireball citation;
`uv run python ingestion/qa_chunks.py --collapse-check --from-db` reports zero offenders.

## Files to Create / Modify

| File | Create/Modify | Purpose |
|------|---------------|---------|
| `ingestion/extract_scan.py` | Modify | OCR-tolerant anchor + fallback (A/B), field-name stoplist (D), monster de-collapse (C) |
| `ingestion/qa_chunks.py` | Modify | field-name stoplist in `entity_name_ok` (D) + `detect_collapse` aggregate gate + `--collapse-check`/`--from-db` CLI |
| `ingestion/embed.py` | Modify | `--replace-book` mode: `DELETE FROM dnd.chunks WHERE book_slug` before insert (F — prevents orphaned stale rows) |
| `ingestion/test_extract_scan.py` | Modify | tests 1–4, 6 (garbled anchor, Fireball, fallback, junk-name, de-collapse) |
| `ingestion/test_qa_chunks.py` | Modify | tests 5, 7 (stoplist, collapse detector) |
| `ingestion/golden_entities.json` | Create | canonical entities that must extract correctly |
| `ingestion/test_golden_entities.py` | Create | test 8 — golden entities present in re-extracted JSONL |

## Validation Commands
```bash
# pure tests — no DB/network, no extra deps (bare `python` here is a Win Store stub → use uv run)
uv run python ingestion/test_extract_scan.py
uv run python ingestion/test_qa_chunks.py
uv run python ingestion/test_golden_entities.py
uv run python ingestion/qa_chunks.py --collapse-check ingestion/chunks-phb-5e.jsonl   # gate (flag added in CP-D)
# DB/embedding/eval — need the drivers injected
uv run --with "psycopg[binary]" --with openai python ingestion/qa_chunks.py --collapse-check --from-db   # CP-F: zero offenders
uv run --with "psycopg[binary]" --with openai python ingestion/eval_golden.py                            # Hit@1 >= prior 80.5%
```

## Beads Issue Map

| Beads ID | Type | Title | Depends on | Priority |
|----------|------|-------|-----------|----------|
| `0im` | epic | Extraction-quality audit — fix mis-extraction + regression guard | — | P1 |
| `0im.1` | task | A: OCR-tolerant spell anchoring + fallback | — | P1 |
| `0im.2` | task | B: Reject junk/field entity-names | 0im.1 | P2 |
| `0im.3` | task | C: Monster-section de-collapse | 0im.2 | P2 |
| `0im.4` | task | D: Corpus-wide collapse-detector QA gate | 0im.1 | P1 |
| `0im.5` | task | E: Canonical-entity golden regression test | 0im.1 | P1 |
| `0im.6` | task | F: Re-extract + re-embed + verify Fireball, Hit@1 ≥ prior | 0im.2,.3,.4,.5 | P1 |
| `7p3` | bug | (existing) Fireball/PHB spells missing — closed by F | 0im.6 | P1 |

## Estimated Scope
- Files: 2 new / 5 modified; Complexity: **High** (OCR heuristics + replace-embed + eval guard); Checkpoints: 6.

## Plan-review corrections applied (reports/dnd-extraction-quality-audit-plan-review.md)
- **[High]** CP-F now replaces (delete-by-book) before re-embed + a no-orphans / collapse-against-DB
  assertion — `embed.py` is upsert-only and chunk_ids change on re-extraction (would orphan old blobs).
- **[Medium]** All demo/validation commands prefixed with `uv run` (bare `python` is a Win Store stub here);
  DB/embed/eval commands get `--with "psycopg[binary]" --with openai`.
- **[Low]** Named the exact PHB PDF path; `--collapse-check` flagged as built in CP-D, not pre-existing.
