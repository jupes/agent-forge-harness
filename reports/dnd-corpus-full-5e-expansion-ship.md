# Ship Report — Full 5E Corpus Expansion + Comprehensive Eval + Pre-Embedding QA

> **Slug**: `dnd-corpus-full-5e-expansion` · **Epic**: agent-forge-harness-t4q
> **Date**: 2026-06-08 · **Repo**: `repos/rag-chat` (pushed to `master`)
> **Pipeline**: Forge full (research → plan → review → implement → ship)

---

## What shipped

The D&D RAG corpus went from **3 books / 2,271 chunks** to **12 books / 8,851 chunks**, gained a
**pre-embedding data-quality gate**, and now has a **171-query comprehensive eval suite** that
measures retrieval quality per book and content category. The run also produced the honest
full-scale numbers and the evidence to reopen the reranker work.

### Five build checkpoints (all TDD, demo-verified)

| # | Feature | Bead | Commit |
|---|---------|------|--------|
| F1 | pymupdf engine, per-book selection | s86 | be878c2 |
| F2 | pre-embedding QA gate (`qa_chunks.py`) | nza | 8e8e… |
| F3 | anchor-driven supplement extractor | 3qh | 7c92be2 |
| F4 | ingest 10 books + retire PHB Basic | 69t | 0458bb1 |
| F5 | 171-query corpus-generated eval | wsq | (this) |
| T6 | extraction-QA + eval reports | 6en | (this) |

---

## Before / after

| | Before | After |
|---|--------|-------|
| Books | 3 (PHB Basic, MM, DMG) | 12 (full PHB + 9 supplements + MM + DMG) |
| Chunks | 2,271 | 8,851 |
| Extraction engine | pdfplumber only | pdfplumber + pymupdf (per-book) |
| Pre-embedding validation | none | QA gate quarantines garbage |
| Eval suite | 64 hand-written | 171 generated + curated |
| Hit@1 / MRR / Recall@10 | 98.3 / 0.983 / 98.3% (small corpus) | 74.7 / 0.808 / 91.0% (4× corpus) |

The Hit@1 drop is the expected, honest cost of 4× more confusable content + harder generated
queries; the **Recall@10 91% vs Hit@1 74.7% gap** is the actionable finding (reranker territory).

---

## How to verify it yourself

```bash
cd repos/rag-chat
docker compose up -d          # pgvector

# 1. Unit tests (no DB/PDF needed) — 95 total
uv run python ingestion/test_extract_scan.py        # 37/37
uv run python ingestion/test_qa_chunks.py           # 20/20
uv run python ingestion/test_gen_golden.py          # 9/9
uv run --with "psycopg[binary]" --with openai python ingestion/test_eval_golden.py   # 29/29

# 2. Confirm the corpus is live — 12 books, 8,851 chunks
docker exec rag-chat-vector-db psql -U rag -d rag_chat \
    -c "SELECT book_slug, count(*) FROM dnd.chunks GROUP BY 1 ORDER BY 2 DESC;"

# 3. See the QA gate quarantine garbage on a noisy book
uv run python ingestion/qa_chunks.py ingestion/chunks-vgm-5e.jsonl   # ~87.6% pass, names quarantined

# 4. Run the full eval and read the stratified table
PYTHONIOENCODING=utf-8 uv run --with "psycopg[binary]" --with openai \
    python ingestion/eval_golden.py --mode vector
#   → Hit@1 74.7%, MRR 0.808, Recall@10 91.0%, per-category breakdown
```

Reports: `docs/dnd-full-corpus-expansion-2026-06-08.md` (full detail).

---

## Decisions made during the run (deviations from plan)

1. **Per-book engine, not a global fitz swap** — the parity gate caught fitz regressing the MM
   heuristics (Tarrasque/Lich dropped). mm/dmg stay on proven pdfplumber; new books use fitz.
2. **Anchor-driven supplements** — heading detection missed unbolded 9.3pt spell names; anchoring on
   the level/prereq sub-header (like MM's "Armor Class") fixed it (XGE spells 8 → 53).
3. **QA runaway cap 1800 → 8000** — the demo caught the gate false-quarantining complete legendary
   stat blocks; raised to only catch genuine merge bugs.
4. **`dict_word_ratio` dropped** (plan-review finding) — no wordlist; other checks suffice.
5. **`embed.py` `.env` loader added** (plan-review finding).

---

## Beads

**Closed**: t4q-children F1–F5 + T6 (s86, nza, 3qh, 69t, wsq, 6en); pd0 (delivered), sew (mooted by
full-PHB replacement).
**Reopened**: bo4 (cross-encoder reranker) — the corpus-growth trigger is met.
**Open follow-ups**: T7 (OCR Wayfinders/Blood Hunter, deferred), qg4 (OCR entity cleanup, higher
value now), ipl (filter fallback), koz (answerability gate), 3q3 (hybrid re-eval, needs filter
support in hybrid_search), supplement-extraction depth.

## Quality gates

95/95 unit tests green. Corpus embedded and verified. rag-chat commits pushed to `master`
(`613d41e..` through this report). No secrets committed; `.clean`/`.quarantine` derived files
gitignored.
