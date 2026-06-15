# Ship Report: dnd-extraction-quality-audit — Systemic chunk mis-extraction fix + regression guard

Shipped: 2026-06-15
Epic: agent-forge-harness-0im · Code repo: `repos/rag-chat` (github.com/jupes/rag-chat, on `master`)
Harness docs branch: `feat/dnd-extraction-quality-audit` · PR: _(this PR)_

## What Shipped

A user asked the chat app "fireball?" and got a refusal — even though Fireball is in the PHB. The
investigation showed Fireball had **no entity** in the corpus, the visible tip of a systemic
extraction failure: OCR-corrupted spell anchors merged hundreds of spells into mis-named blobs. This
run fixed the spell extraction (three stacked OCR defenses), stopped junk/field lines from becoming
entity-names, added a **corpus-wide collapse detector** + a **canonical-entity golden test** as
permanent regression guards, and re-extracted + replace-embedded all seven spell-bearing books.
**Fireball (and all 15 sampled canonical spells) now answer live**, and retrieval **Hit@1 rose
80.5% → 83.3%** (spell_lookup Hit@1 96%).

## Before → After

| Area | Before | After |
|------|--------|-------|
| "fireball?" query | Refusal — top-1 distance 0.5095, just over the 0.50 gate | Grounded answer — distance **0.3826**, top hit `Fireball` |
| Fireball as an entity | absent (0 chunks); text buried in a 28-chunk "Eldritch Blast" blob | own `Fireball` spell chunk (phb p242) |
| PHB distinct spell entities | 30 (≈340 spells unnamed) | **359** |
| Canonical spells present (sample of 15) | 2/15 | **15/15** |
| Junk entity-names (`Components:`, `Duration:`, sentence fragments) | embedded into the store | rejected at extraction + quarantined by the QA gate |
| Collapse regression guard | none | `detect_collapse` + `--collapse-check`/`--from-db` gate + golden test |
| Eval Hit@1 (overall) | 80.5% | **83.3%**; spell_lookup Hit@1 96%, MRR 0.96 |
| Re-embedding | upsert-only (would orphan stale chunks) | `embed.py --replace-book` (delete-by-book; no orphans) |

## Work Done

- **CP-A — OCR-tolerant spell extraction** (0im.1): fuzzy anchor keywords (`c↔e`, `l↔I`…), a
  casting-time fallback anchor for shredded level lines (`3rd~evelevoeaUon`), and a name-size
  exemption (PHB names render ~7.4pt, below the 8.0 body floor). `44db29a`, `8a09654`
- **CP-B — reject junk/field entity-names** (0im.2): `is_field_line` guard in extraction +
  `entity_name_ok` rejects field/section labels and sentence fragments. `4b7b899`
- **CP-C — monster de-collapse** (0im.3): **DEFERRED** (user decision) — MM/ravnica monster
  family/statblock collapse (71 entities, e.g. giants, dragon wyrmlings). Tracked; the new detector
  makes it visible.
- **CP-D — corpus-wide collapse detector** (0im.4): `detect_collapse` flags entities merging
  multiple stat-anchors; CLI gate. `04f8b9f`
- **CP-E — canonical-entity golden test** (0im.5): `golden_entities.json` + `test_golden_entities.py`. `033f68b`
- **CP-F — re-extract + replace-embed + verify** (0im.6): 7 books re-extracted, QA-split,
  replace-embedded; verified end to end. `033f68b`

## Beads Completed

| Beads ID | Title | Status |
|----------|-------|--------|
| agent-forge-harness-0im.1 | A: OCR-tolerant spell anchoring + fallback | closed |
| agent-forge-harness-0im.2 | B: Reject junk/field entity-names | closed |
| agent-forge-harness-0im.4 | D: Corpus-wide collapse-detector QA gate | closed |
| agent-forge-harness-0im.5 | E: Canonical-entity golden regression test | closed |
| agent-forge-harness-0im.6 | F: Re-extract + replace-embed + verify | closed |
| agent-forge-harness-7p3 | Core PHB spells (Fireball) missing | closed (resolved by 0im.6) |
| agent-forge-harness-0im.3 | C: MM/monster family-section de-collapse | **deferred** (until 2026-07-01) |
| agent-forge-harness-0im | [epic] Extraction-quality audit | closed (C tracked as deferred follow-up) |

## Test It Yourself (walkthrough)

From `repos/rag-chat` (DB up: `docker compose up -d vector-db`):

1. **Unit tests** (pure, no DB):
   `uv run python ingestion/test_extract_scan.py` → 51/51 ·
   `uv run python ingestion/test_qa_chunks.py` → 25/25 ·
   `uv run python ingestion/test_golden_entities.py` → 1/1
2. **Fireball live:**
   `uv run --with "psycopg[binary]" --with openai python -c "import sys;sys.path.insert(0,'ingestion');from retrieval import RagRetriever;r=RagRetriever();x=r.retrieve('fireball?');print(x.answerable, round(x.top1_distance,3), x.chunks[0].entity_name)"`
   → `True 0.383 Fireball`
3. **Collapse gate (spells clean; monsters = deferred CP-C):**
   `uv run --with "psycopg[binary]" python ingestion/qa_chunks.py --collapse-check --from-db`
4. **Eval:** `PYTHONUTF8=1 uv run --with "psycopg[binary]" --with openai python ingestion/eval_golden.py` → Hit@1 ≈ 83%.
5. **In the app:** `docker compose up --build` → ask "fireball?" at <http://localhost:5173> → grounded answer with a PHB citation.

## Follow-ups / Known Gaps

- **CP-C / 0im.3 (deferred):** MM + ravnica monster family-section collapse (71 entities — giants,
  krakens, dragon wyrmlings, elementals…) named by family/section headers because individual
  statblock names render below the heading threshold. Same root class as the spell name-size issue;
  fix = port type-line-relative name recovery into `extract_mm_chunks` + the supplement monster path,
  re-extract MM, regression-check the 378 monster entities. Detector flags all of them today.
- Minor residual: xge-5e `Earth Tremor` (heavy OCR) still merges with its neighbour (1 case).
- `eval_golden.py` prints box-drawing chars; on Windows run with `PYTHONUTF8=1`.
