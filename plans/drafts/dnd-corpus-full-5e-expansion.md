# Plan — Full 5E Corpus Expansion + Comprehensive Eval + Pre-Embedding QA

> **Slug**: `dnd-corpus-full-5e-expansion`
> **Phase**: 2 (plan) of the Forge pipeline
> **Research**: [plans/research/dnd-corpus-full-5e-expansion.md](../research/dnd-corpus-full-5e-expansion.md)
> **Repo**: `repos/rag-chat`
> **Approach**: TDD (pure functions first, DB/PDF at the edges), demo-able checkpoints, Beads-tracked.

---

## Open questions — resolved

1. **Mixed-content classification** → *incremental signature detection*. Detect the strongest,
   lowest-false-positive signatures first (stat block = `Armor Class \d`; spell = `Nth-level`/
   `Casting Time:`; feat = `Prerequisite:`; subclass = class-name + level table). Everything else
   defaults to `rule` (prose under a section heading) or `lore` (setting books). Each signature is a
   pure, unit-tested predicate. We do **not** chase 100% — the QA gate + eval catch misclassification.
2. **Golden-answer authoring** → *generate from the corpus, not by hand*. A `gen_golden.py` samples
   real `entity_name`/`class_name` rows per `(content_type, book)` from the DB and templates
   questions, so `expected_entity`/`expected_content_type`/`book` are **guaranteed to match real
   data** (no hand-typed label drift). Cross-book collisions + negatives are a small hand-curated
   set. Generated queries are committed as a static `GOLDEN_SET` (reproducible), not regenerated at
   eval time.
3. **QA gate action** → *quarantine, don't embed*. Clean chunks proceed; failures go to
   `chunks-<slug>.quarantine.jsonl` + a JSON report. Nothing quarantined reaches the vector store.
   Re-includable after a fix. (Hard-reject loses data; embed-but-flag pollutes retrieval.)
4. **MM/DMG re-extraction** → *re-run under pymupdf for engine consistency*, with a parity gate:
   chunk counts and stat-block/item counts must stay within ±5% of the committed pdfplumber output,
   else stop and inspect. One engine, less drift.
5. **Chunk guardrails** → no hard per-book cap; the QA gate's min-content checks (≥5 words, alpha
   ratio) drop pure-art/flavor pages naturally. HNSW handles 10K rows fine.

---

## Build — 6 demo-able checkpoints

Each checkpoint is independently demo-able and ends at a natural stop. TDD throughout: pure functions
get a failing unit test first; PDF/DB integration is verified by running the real pipeline.

### Checkpoint 1 — pymupdf engine swap + MM/DMG parity  *(feature)*

Replace the pdfplumber line-reader in `extract_scan.py` with a pymupdf producer emitting the **same**
`LineItem` stream the pure functions already consume. The structure heuristics
(`extract_mm_chunks`, `extract_dmg_chunks`, `is_caps_heading`, `_assign_anchor_owners`, …) are
untouched.

- `read_pdf_stream_fitz(path) -> list[LineItem]`: `page.get_text("dict")` → blocks→lines→spans,
  grouping spans into visual lines by y, dominant size per line, **bold flag** (`flags & 16` or
  font name contains "Bold") carried on `LineItem` as a new optional field.
- NUL/control sanitization (already present) stays.
- **Tests**: a synthetic fitz-dict fixture → asserts `LineItem` stream shape; bold flag plumbed.
- **Demo**: `extract_scan.py "…Monster Manual.pdf" --book-slug mm-5e --engine fitz`; chunk count
  within ±5% of the committed 777; spot-check Basilisk/Tarrasque stat blocks intact.
- **Parity gate**: a small script diffs new vs committed MM/DMG chunk counts by content_type.

### Checkpoint 2 — pre-embedding QA gate  *(feature, the headline new component)*

New `ingestion/qa_chunks.py` — pure validators + a runner.

- Pure predicates (each unit-tested with good + bad samples drawn from the real failures):
  `pua_control_ratio`, `has_cid_marker`, `alpha_ratio`, `dict_word_ratio` (against a small bundled
  English wordlist), `length_ok`, `entity_name_ok`.
- `classify_chunk(chunk) -> (ok: bool, reasons: list[str])` combines them with thresholds from the
  research table.
- `run_qa(in_jsonl) -> (clean_path, quarantine_path, report_dict)`; CLI writes a JSON report
  (counts, per-reason tallies, sample offenders).
- **Tests**: feed a Wayfinders-PUA line, a `(cid:107)` line, an XGE junk-OCR line, a 3-word
  fragment, a "Tholl" entity → all quarantined with the right reason; clean chunks pass.
- **Demo**: run QA over a deliberately-garbled extract; show the report quarantining exactly the
  garbage and passing the good chunks.

### Checkpoint 3 — within-book content-type classification  *(feature)*

- Pure signature predicates: `is_stat_block_anchor`, `is_spell_header` (`^(\d+(st|nd|rd|th)-level|
  cantrip)` or `Casting Time:`), `is_feat_header` (`Prerequisite:`), `is_subclass_context`
  (class-name heading + level-table proximity). Default → `rule`/`lore`.
- A `classify_content_type(line_window) -> str` consulted by a new generic
  `extract_supplement_chunks` for Tier-A books that aren't pure MM/DMG shape.
- **Tests**: labelled synthetic line windows → expected content_type; feat/spell/subclass/stat each.
- **Demo**: extract XGE; print content_type breakdown (subclass_feature, spell, feat, magic_item).

### Checkpoint 4 — ingest the 10 Tier-A books  *(feature)*

- Per-book `BOOK_CONFIGS` entries (engine=fitz, kind, first_content_page, thresholds).
- Pipeline: extract → QA gate → embed clean chunks. Per-book QA report saved.
- `DELETE FROM dnd.chunks WHERE book_slug='phb-basic-v0.2'` (retire Basic); close `sew` as moot.
- **Demo**: DB shows 12 books, ~8–10K chunks; `SELECT book_slug, content_type, count(*)` table;
  QA pass-rate per book ≥ ~90% (lower flags a book needing a config tweak).

### Checkpoint 5 — comprehensive eval dataset  *(feature)*

- `gen_golden.py` samples real entities per (content_type, book) → templated `GoldenQuery` rows;
  output committed into `eval_golden.py`'s `GOLDEN_SET` (replacing the 64 with ~120–150).
- Hand-curated: cross-book collisions (Shield spell/armor/Shield Guardian; Hold Person/Monster),
  expanded negatives (4E terms, out-of-corpus 5E like Spelljammer/Strixhaven).
- Re-point the 20 PHB queries from Basic chapters to phb-5e (verify chapter names/numbers).
- **Tests**: `gen_golden` templating is pure + unit-tested; existing 29 eval unit tests stay green.
- **Demo**: `eval_golden.py --mode vector`; stratified per-category/per-book table across the full
  corpus; report Hit@1/MRR/Recall@10/P@5 and negative separation.

### Checkpoint 6 — reports + ship  *(ship phase)*

Extraction-QA report + full-corpus eval report in `repos/rag-chat/docs/`; close beads; PR.

---

## Beads structure

Epic: **[dnd] Full 5E corpus + comprehensive eval + pre-embedding QA**
- F1 pymupdf engine swap + MM/DMG parity  *(P2)*
- F2 pre-embedding QA gate (`qa_chunks.py`)  *(P1 — highest leverage, user's stated focus)*
- F3 within-book content-type classification  *(P2, depends F1)*
- F4 ingest 10 Tier-A books + retire PHB Basic  *(P2, depends F1+F2+F3)*
- F5 comprehensive eval dataset  *(P2, depends F4)*
- T6 extraction-QA + eval reports  *(P2, depends F5)*
- T7 (follow-up) OCR Wayfinders + Blood Hunter  *(P3, no dep — filed, not done this run)*

Dependency spine: F1 → F3 → F4 → F5 → T6; F2 → F4. Existing beads: `pd0` folds into F4 (close
when the 10 books land); `sew` superseded by F4's PHB retirement; `bo4` reopen-trigger re-checked
at F5 (bigger corpus is the real reranker test).

---

## Test strategy (TDD)

- **Pure-function-first**: every predicate (QA validators, content-type signatures, golden
  templating, the fitz→LineItem grouping) gets a failing unit test, then minimal code, then refactor
  green. No DB or PDF in unit tests — synthetic fixtures only.
- **Integration by real run**: extraction/embedding/eval verified by running the actual pipeline at
  each checkpoint's demo (DB up, real PDFs).
- **Regression gates**: MM/DMG parity (±5%) at C1; existing 29 eval + 19 extract_scan unit tests
  stay green throughout.
- Test files: `test_extract_scan.py` (extend), `test_qa_chunks.py` (new), `test_eval_golden.py`
  (extend), `test_gen_golden.py` (new).

## Risks & mitigations

- **Engine swap regresses MM/DMG** → ±5% parity gate at C1; keep pure functions unchanged.
- **Mixed-content misclassification** → QA gate + eval surface it; incremental signatures, safe default.
- **Supplement layouts vary** (Ravnica vs XGE) → per-book config + QA pass-rate as the canary;
  a book under ~90% pass gets a config pass before its chunks embed.
- **Golden label drift** → generated from real rows, not hand-typed.
- **Scope creep** → Wayfinders/Blood Hunter explicitly deferred (OCR bead); NLRMEv2 excluded.

## Definition of done

12 books in `dnd.chunks` (~8–10K chunks), PHB Basic retired, every book with a QA report ≥~90%
pass, ~120–150-query stratified eval landing with per-category/book metrics + negative separation,
all unit tests green, two docs written, beads closed, PR opened.
