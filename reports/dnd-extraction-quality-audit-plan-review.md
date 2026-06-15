# Plan Review: dnd-extraction-quality-audit — Systemic chunk mis-extraction fix + regression guard
Source: plans/drafts/dnd-extraction-quality-audit.md · Reviewed: 2026-06-14

## Verdict: NEEDS REVISION — 0B / 1H / 1M / 1L

The plan's diagnosis and integration points are accurate (every line ref and file claim checks out),
but **Checkpoint F's re-embed step is incomplete**: `embed.py` is upsert-only, so re-extracting a
book leaves its *old* mis-tagged chunks alive in the DB alongside the new ones — the exact
Eldritch-Blast blob the run exists to kill would survive. One Medium (all run commands use a `python`
that isn't on PATH here) and one Low round it out.

## Findings

### [HIGH] Re-embed doesn't remove stale chunks — old mis-tagged blobs survive re-extraction — Checkpoint F
**What:** Checkpoint F says "re-extract … then re-embed changed books via `embed.py`" and the research
constraint is "re-embed only the books whose extraction actually changes." The plan assumes re-embedding
*replaces* a book's rows.
**Why it's an issue:** `embed.py` only **upserts** (`ON CONFLICT (chunk_id) DO UPDATE`), it never
deletes. `chunk_id = _chunk_id(book_slug, page, col, counter[0])` is keyed on the per-extraction running
`counter[0]` (extract_scan.py:653) — so when spells split correctly the chunk count/order changes and the
**new chunks get new ids**. The old Eldritch-Blast(28) / Demilich(22) rows keep their old ids, match no
new row, and are never overwritten or deleted. Result: the corpus ends up with BOTH the broken blobs and
the fixed chunks. The broken blob stays retrievable, and because the collapse detector (CP-D) is specced
to run over the **JSONL** (not the DB), nothing catches the orphaned DB rows. Checkpoint F could even look
green (clean Fireball chunk retrievable) while the defect persists.
**Evidence:** `ingestion/embed.py:110` `ON CONFLICT (chunk_id) DO UPDATE SET …` — no `DELETE`/replace;
`grep DELETE ingestion/embed.py` → none. `ingestion/extract_scan.py:653` `_chunk_id(..., counter[0])`.
The DB README's "stable across re-ingests" only holds when extraction output is byte-identical — which
this run deliberately changes. — Confidence: **Confirmed**
**Suggested correction:** Add to Checkpoint F (and 0im.6 AC): before re-embedding a changed book, delete
its rows — `DELETE FROM dnd.chunks WHERE book_slug = :slug` — or add an `embed.py --replace-book` mode that
does the delete+insert in one transaction. Then assert post-condition: `SELECT count(*) FROM dnd.chunks
WHERE book_slug='phb-5e'` equals the new JSONL line count (no orphans), and run the collapse detector
**against the DB** as well as the JSONL.

### [MEDIUM] Run commands invoke a `python` that isn't on PATH in this environment — Validation Commands / all checkpoint demos
**What:** Every demo/validation command is `python -m ingestion.test_extract_scan`,
`python ingestion/extract_scan.py …`, `python -m ingestion.qa_chunks …`, etc.
**Why it's an issue:** Bare `python` here resolves to the Windows Store alias stub ("Python was not
found"), so every command as written is a no-op/failure. All Python this session has run through `uv`.
DB/embedding/eval commands additionally need the deps injected.
**Evidence:** `python ingestion/test_extract_scan.py` → "Python was not found…"; `uv run python
ingestion/test_extract_scan.py` → "47/47 passed". — Confidence: **Confirmed**
**Suggested correction:** Prefix with `uv run`: `uv run python ingestion/test_extract_scan.py`
(both `-m` and script form work under uv). For qa/embed/eval add deps:
`uv run --with "psycopg[binary]" --with openai python …`. (Pure extraction/qa/golden tests need no extras.)

### [LOW] `<PHB pdf>` placeholder + forward-referenced `--collapse-check` flag — CP-A demo / Validation Commands
**What:** CP-A demo uses `"<PHB pdf>"`; Validation lists `python -m ingestion.qa_chunks --collapse-check …`.
**Why it's an issue:** The PDF path is unstated (minor friction), and `--collapse-check` doesn't exist yet —
it's built in CP-D, so listing it under top-level Validation reads as if it's available now.
**Evidence:** PDF is `repos/DnD-Books/5e/Books/D&D 5E - Player's Handbook.pdf` (69 PDFs under DnD-Books).
`ingestion/qa_chunks.py:176-178` argparse has only `chunks` + `--max-chars`, no `--collapse-check`. — Confidence: **Confirmed**
**Suggested correction:** Name the exact PDF path in CP-A; mark `--collapse-check` as "added in CP-D".

## Verified as accurate (spot-checks)
- `extract_supplement_chunks` extractor + all cited symbols — `extract_scan.py:584, _SPELL_ANCHOR_RE:513, open_anchored:665, recover_statblock_name:632, is_heading:627, classify_content_type:561` ✓
- QA-gate plug-in points — `qa_chunks.py: entity_name_ok:79, classify_chunk:101, run_qa:127` (per-chunk only; aggregate collapse check is genuinely new) ✓
- The "passes on clean input" test claim — `test_extract_scan.py: test_supplement_spell_name_not_swallowed_by_prior_chunk:448, test_supplement_extracts_spells_via_anchor:430` exist; full suite 47/47 green ✓
- `test_qa_chunks.py` exists with a `_run()` runner; `qa_chunks.py` has an argparse `main` ✓
- `embed.py` (per-book via `--chunks <jsonl>`), `eval_golden.py`, `golden_set.json` all exist ✓
- Source PDFs available for re-extraction — 69 under `repos/DnD-Books`, incl. the 5e PHB ✓
- Per-book JSONLs present for the CP-D "flag the current blobs" demo (`ingestion/chunks-*.jsonl`) ✓

## Not verified
- That OCR-fuzzy school matching (`c↔e`, `l↔I`) won't introduce **false-positive** spell anchors on
  non-spell prose — that's an implementation risk the TDD (tests 1–3) must pin down, not a plan-accuracy
  defect. Carry as a watch-item into implement.
- Exact set of books whose extraction output changes (hence which to re-embed) — only determinable after
  CP-A–C are implemented and re-extraction is diffed against the committed JSONLs.
