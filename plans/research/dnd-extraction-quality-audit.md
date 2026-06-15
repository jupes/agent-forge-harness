# Research: dnd-extraction-quality-audit — Systemic chunk mis-extraction audit + regression guard

Generated: 2026-06-14
Repo: repos/rag-chat
Phase: research (1/4)

## Goal

A user query for "fireball" was refused even though Fireball is in the PHB. Investigation showed
Fireball has **no entity** in the corpus — its text is buried inside a 28-chunk blob mis-named
"Eldritch Blast". The user's hypothesis ("if it happened once it happened elsewhere") is correct.
This run audits the **whole corpus** for the extraction failure, fixes every fault class, and adds
**regression coverage on every faulted item** (plus a corpus-wide guard) so it cannot silently recur.

Scope decided with the user: **Full extraction-quality pass (A+B+C+D)** — fix + test all four fault
classes below, not just PHB spells.

## What the Code Says (answered by exploration)

### The extraction pipeline
- Per-book routing in `main()` — `ingestion/extract_scan.py:892`: `monster_manual` → `extract_mm_chunks`,
  `dmg` → `extract_dmg_chunks`, everything else (`supplement`) → `extract_supplement_chunks`.
  **PHB, XGE, TCE, SCAG, Ravnica, Eberron, etc. are all `supplement`.**
- The supplement extractor is **anchor-driven** — `extract_scan.py:584-723`. Spell/feat names are
  small and unbolded, so it doesn't rely on headings for them; instead it anchors on the structural
  sub-line that follows the name and pops "the line directly above the anchor" as the entity name
  (`open_anchored`, `:665-691`; the spell branch is `name = cur_lines.pop()` at `:685`).

### Root cause of the Fireball collapse (fault A)
- `_SPELL_ANCHOR_RE` — `extract_scan.py:513-516` — requires a clean, line-start
  `"<N>(st|nd|rd|th)-level <school>"` or `"<school> cantrip"`, with the school spelled exactly
  (`abjuration|conjuration|…|transmutation`).
- The PHB scan has **systematic OCR substitution** that breaks this anchor: `c→e`
  ("Evoeation eantrip"), `l→I` ("leveI"), `S→5`, `0→O`. Confirmed in-corpus: only **27 of 195** PHB
  spell chunks contain a clean anchor line (DB query, 2026-06-14); the Fireball chunk
  `3573d350d16cb117c9be` reads "…lO feet wide. The sphere ignites flammable objeets…".
- **There is no fallback when the anchor misses.** A spell whose anchor line is corrupted never opens
  a new chunk — its name + body accumulate under the previous successfully-detected heading. Result:
  ~340 PHB spells collapse into 30 labels; 13/15 canonical spells (Fireball, Magic Missile,
  Counterspell, Wish, Cure Wounds, Shield, Lightning Bolt, Polymorph, Sleep, Haste, Misty Step,
  Bless, Healing Word) have **0** entities.
- `classify_content_type` (`:561-581`) uses a *looser* test (`_SPELL_LEVEL_RE` **or** `_SPELL_SCHOOL_RE`,
  plus a Casting Time/Range field), so the blobs are still *labelled* `spell` — masking the breakage
  (195 chunks "look like spells" but only 27 are properly bounded/named).

### The same failure in other forms (the user was right)
- **B. Other books' spells** — same anchor dependency; xge-5e spell = 53 chunks / 26 distinct names,
  with milder collapse in scag/ravnica/eberron.
- **C. Monster-section collapse** — `recover_statblock_name` (`:632-642`) walks `recent_headings`
  and skips type-lines + `_STAT_FIELD_WORDS`, but a **family/section header** (e.g. "GIANTS",
  "BEHOLDERS") still wins when the individual monster's name isn't a detected heading: mm-5e
  `Demilich`=22, `Giants`=18 chunks under one (entity,page).
- **D. Junk entity-names as headings** — `is_heading` (`:627-630`) accepts *any* bold line 3–60 chars,
  so stat/field lines become entity names: phb `Spell Descriptions`(19), `Duration: 1 Minute`(22),
  `Components: V, S`(6); OCR garble `The Seldari N E`(23, mtf), `If I`(17, scag),
  `Cra Ft Ing Complications`(17, xge).

### Where fixes and tests plug in (existing infrastructure to reuse)
- **Unit tests** live in `ingestion/test_extract_scan.py`. Relevant existing tests:
  `test_supplement_extracts_spells_via_anchor:430` and
  `test_supplement_spell_name_not_swallowed_by_prior_chunk:448` — these assert the *exact* property
  that fails in production, but **pass because they feed clean synthetic anchors**. They never
  exercise OCR-garbled lines. `test_caps_heading_accepts_ocr_mixed_case:205` shows the suite already
  has some OCR-awareness to extend.
- **Pre-embedding QA gate** is `ingestion/qa_chunks.py`. It already has per-chunk
  `entity_name_ok(name)` (`:79`) and `classify_chunk` (`:101`) returning `(ok, reasons)` — the
  natural home for fault **D** (reject field/stat-line names). It has **no aggregate/corpus-wide
  check** — `run_qa` (`:127`) is per-chunk only. The "every item / don't regress" guard (a
  collapse detector) is a **new** capability here.
- **Re-embedding** is `ingestion/embed.py` (idempotent upsert; `content_type = EXCLUDED.content_type`
  fix already in place). The retrieval path under test is `ingestion/retrieval.py` (`RagRetriever`).
- **Eval harness** `ingestion/eval_golden.py` + `golden_set.json` already exists for Hit@1 regression
  — the new canonical-entity golden test should extend this style, not reinvent it.

## Decisions Resolved with the User

| Question | Decision | Rationale |
|----------|----------|-----------|
| Fix scope | **Full pass A+B+C+D** | User: "must have occurred in other places… ensure test coverage on every item with a fault." Fix all classes + a corpus-wide guard, re-extract + re-embed affected books. |

## Constraints & Non-Goals

- **Constraint — OCR is the adversary, not clean PDFs.** The fix must tolerate `c→e`, `l→I`, `S→5`,
  `0→O` style corruption in anchor lines (fuzzy school match + a fallback when the strict anchor
  misses), because the source scans are damaged and won't improve.
- **Constraint — don't regress the healthy 80.5% Hit@1.** Most monster books and feats are already
  clean (~2–3 chunks/entity). Re-extraction must be measured against the existing eval before/after.
- **Constraint — re-embedding has cost/latency** (OpenAI; cf. the transient 431 in 6sa). Re-embed
  only the books whose extraction actually changes.
- **Non-goal** — OCR-cleaning the source PDFs / re-OCR with tesseract (that's deferred bead 1nh).
- **Non-goal** — fixing `dm_guidance` "high chunks/entity" (those are legitimately long prose
  sections, not collapse).

## Open Risks / Assumptions Carried Forward

- **Two-column line ordering**: "the line directly above the anchor" (`:685`) assumes single reading
  order. If the PDF stream interleaves columns, the popped name may be wrong even with a clean
  anchor — the plan must verify name-recovery on real two-column PHB pages, not just synthetic input.
- **"Every faulted item" coverage shape**: literally testing all ~340 spells is impractical; the
  assumption carried forward is **a representative golden set (canonical items per fault class) +
  an aggregate collapse-detector QA gate** that mechanically covers every item by invariant
  (no (entity,page) group above a threshold; per-book distinct-entity floor; no name in the
  field/stat-line stoplist). Thresholds to be set from the measured distributions in the plan.
- **Re-extraction may surface new fault classes** once spells split correctly (e.g. names that were
  hidden inside blobs). The collapse-detector gate is the safety net for that.

## Recommended Scope for Planning

Design a targeted hardening of `extract_supplement_chunks` + `qa_chunks.py`, TDD-first:
1. **OCR-tolerant spell anchoring (A,B)** — fuzzy school/level match (accept `c↔e`, `l↔I`, `1↔l/I`,
   `0↔O`, `5↔S`) and a **fallback** that opens a spell chunk + recovers the name when the strict
   anchor is corrupted; new unit tests feeding garbled "Evoeation eantrip"/"3rd-leveI evocation".
2. **Reject junk entity-names (D)** — extend the stoplist/validation so field & stat lines
   (`Components`, `Duration`, `Casting Time`, `Range`, `Spell Descriptions`, bare OCR fragments)
   can never become an `entity_name`, enforced both at extraction and in `entity_name_ok`.
3. **Monster-section de-collapse (C)** — prefer an individual monster name over a family/section
   header when a statblock anchor fires; tests for Demilich/Giants-style cases.
4. **Corpus-wide collapse-detector QA gate** — a new aggregate check in `qa_chunks.py` failing the
   build when any `(entity_name, page_start)` group exceeds N chunks, a per-book distinct-entity
   floor isn't met, or a stoplisted name appears. This is the "don't regress" guarantee.
5. **Golden retrieval regression test** — a canonical entity list (Fireball + spells across every
   school/level, plus the de-collapsed monsters) asserted retrievable (`answerable=true`, correct
   entity) via `RagRetriever`, extending the `eval_golden` style.
6. **Re-extract + re-embed** the changed books; verify Fireball et al. retrievable and Hit@1 ≥ prior.

Track as a new epic with one feature per fault class + the QA-gate + the golden test, under the
existing D&D corpus line of work (relates to 7p3, c7v, t4q).
