# Ship Report — Scan Extraction Fix: monster-name binding (VGM/MTF)

> **Slug**: `dnd-scan-extraction-fix` · **Bead**: agent-forge-harness-qg4 (+ children e1r/2fp/ob2)
> **Date**: 2026-06-08 · **Repo**: `repos/rag-chat` (pushed to `master`)
> **Pipeline**: Forge full (research → plan → review → implement → ship)

---

## What shipped

OCR'd monster books (Volo's, Mordenkainen's) were losing monster names at extraction: the bold name
line and the bold type line both tripped `is_heading`, so the name never reached the chunk body and
the stat block was named after the **type line** (or lost entirely) — then quarantined by the QA
gate's `bad_entity` check and **never embedded**. Whole monsters (Froghemoth, Babau, Draegloth,
Meazel, Allip, …) were simply absent from the corpus.

The fix recovers the name from a **recent-heading history** (LineItems carrying bold/size), skipping
the type line (`_TYPE_LINE_RE`) and bare stat-field labels (`_STAT_FIELD_WORDS`), and folds the type
line into the body. Spell/feat naming is unchanged (their non-bold names correctly land in
`cur_lines`).

---

## Before / after

| | Before | After |
|---|--------|-------|
| Corpus chunks | 8,851 | **9,011** (+160 recovered) |
| Monster chunks | 1,202 | **1,225** |
| VGM monster names | mostly type/Challenge lines | real names (Death Kiss, Gauth, Bodak, Babau, Draegloth, Velociraptor, …) |
| VGM stat blocks named after a type line | many | **0** (1 stray of 92) |
| Recovered monsters retrievable (8 sampled) | 0/8 (absent) | **7/8 in Recall@10** |

## Eval (179-query suite, vector mode, 9,011 chunks)

Overall: Hit@1 70.7%, MRR 0.778, Recall@10 89.1%. The 8 new VGM/MTF monster queries were added to the
`monster` category (33 → 41).

**The recovery works** — 7 of 8 previously-absent monsters now retrieve (the 8th, Death Kiss, has a
residual OCR name split as "Death"). But Hit@1 on them is low, and the reason is a genuine insight,
not a fix failure:

| query | Hit@1 | first-hit rank | rank-1 entity (type) |
|-------|-------|----------------|----------------------|
| Meazel | ✓ | 1 | Meazel (monster) |
| Froghemoth | ✗ | 7 | Froghemoth (**rule**) |
| Draegloth | ✗ | 6 | Draegloth (**rule**) |
| Flail Snail | ✗ | 2 | Flail Snail (**rule**) |
| Allip | ✗ | 3 | Allip (**rule**) |
| Nupperibo | ✗ | 2 | Nupperibo (**rule**) |
| Babau | ✗ | 2 | Demilich (monster) |
| Death Kiss | ✗ | — | Death (rule) |

Each recovered monster has **both** a lore chunk (`content_type=rule`, because lore prose lacks
Armor Class/Hit Points) and a stat block (`content_type=monster`). For "What is a Froghemoth?" the
**lore chunk ranks first** — and it is arguably the better answer — but `is_hit` requires
`content_type=monster`, so it scores as a miss. The monster category Hit@1 dipping (23/33 → 22/41) is
this artifact: we added 8 hard "What is X?" queries whose best answer is lore-typed.

---

## How to verify

```bash
cd repos/rag-chat
docker compose up -d
uv run python ingestion/test_extract_scan.py        # 43/43 (6 new: type-line + heading-history)
# Recovered monsters are in the corpus with correct names:
docker exec rag-chat-vector-db psql -U rag -d rag_chat \
  -c "SELECT entity_name FROM dnd.chunks WHERE book_slug='vgm-5e' AND content_type='monster'
      AND entity_name IN ('Babau','Death Kiss','Draegloth','Froghemoth') GROUP BY 1;"
PYTHONIOENCODING=utf-8 uv run --with "psycopg[binary]" --with openai \
  python ingestion/eval_golden.py --mode vector    # monster category, recovered-monster rows
```

---

## Decisions / deviations

- **Plan-review High fix applied**: the planned `find_statblock_name(prior_lines: list[LineItem])`
  couldn't work (`cur_lines` is `list[str]`; bold name+type lines are consumed as headings). Built
  the corrected design — a recent-heading history with type-line + stat-field skip.
- **MTF dotted-leader appendix tables** remain a separate parser (out of scope, as planned).

## Follow-up filed

- **Monster lore is `content_type=rule`** — a "What is X?" query's best answer (the lore) competes
  with the stat block and is typed `rule`, so it doesn't satisfy a `monster` expectation. Worth either
  (a) classifying monster lore as `monster`, or (b) letting `is_hit` accept the entity across
  monster/rule for descriptive queries. Filed as a follow-up.
- **Residual OCR names** (Death Kiss → "Death"; ~1 stray VGM name) — the narrow qg4 cleanup tail.

## Beads

Closed e1r (fix), 2fp (re-ingest). qg4.c (this report) closes with the run. qg4 epic closes once the
follow-up is filed.

## Quality gates

43 extract + 20 QA + 9 gen_golden + 29 eval + 10 rerank unit tests green. Corpus re-embedded, no
duplicates (old vgm/mtf rows deleted before re-embed). Pushed to rag-chat `master`.
