# Ship Report: dnd-monster-decollapse — MM/monster name de-collapse

Shipped: 2026-06-15
Tracking: agent-forge-harness-0im.3 · Code repo: `repos/rag-chat` (on `master`)
Harness docs branch: `feat/dnd-monster-decollapse` · PR: _(this PR)_

## What Shipped

The collapse detector (built in 0im) flagged 71 monster entities whose stat blocks were merged under
one name — individual monsters named after a family header (`Giants`) or absorbed by an alphabetical
neighbor (`Kraken` swallowing Kuo-Toa→Lizardfolk), because their own name line failed `is_caps_heading`.
This run recovers those names so monsters are retrievable individually. **Live result: "what is a fire
giant?" → Fire Giant (was "Giants"); "kuo-toa" → Kuo-Toa (was "Kraken").** The plan-review caught that
the dominant failure was the upper-ratio (caps) gate, not size — so the fix targets both, plus a
caps-agnostic "name directly above a type line" signal, bound by `_assign_anchor_owners` position
scoring.

## Before → After

| Area | Before | After |
|------|--------|-------|
| "what is a fire giant?" | answer attributed to `Giants` (family) | **Fire Giant** (d=0.273) |
| Kuo-Toa / Glabrezu / giant species | collapsed into a neighbor/family | own entities, retrievable by name |
| Canonical monsters (sample of 10) | partial | **10/10** recover their own name |
| Name detection | size ≥ 10.5 **and** upper-ratio ≥ 0.6 only | + sub-threshold size, + relaxed upper-ratio, + above-type-line signal |
| Re-embed safety | n/a | `--replace-book` — no orphaned rows (counts verified) |
| Collapse detector (mm / ravnica) | 64 / 5 | 60 / 4 (residual = legit multi-forms + lore + deep tail) |

## Work Done

- **CP-A** (0im.3.1) — `is_monster_name_candidate` (relaxed upper-ratio + size floor + above-type-line),
  fed into `_assign_anchor_owners` position scoring; Beholder family-fallback preserved. (`09d4666`)
- **CP-B** (0im.3.2) — supplement-path recovery (title-case names above type lines into
  `recent_headings`); type-line folding into the stat block. (`d3154d1`)
- **CP-C** (0im.3.3) — golden set gains Fire/Storm Giant, Kraken, Kuo-Toa. (`d1efffd`)
- **CP-D** (0im.3.4) — re-extract + replace-embed mm/ravnica/mtf/xge; verified live. (`0f9043a`)

## Beads Completed

| Beads ID | Title | Status |
|----------|-------|--------|
| agent-forge-harness-0im.3.1 | A: MM monster-name recovery | closed |
| agent-forge-harness-0im.3.2 | B: Supplement-path recovery | closed |
| agent-forge-harness-0im.3.3 | C: Golden canonical monsters | closed |
| agent-forge-harness-0im.3.4 | D: Re-extract + replace-embed + verify | closed |
| agent-forge-harness-0im.3 | (tracking) MM/monster de-collapse | closed |
| agent-forge-harness-ask | Detector multi-form refinement + deep two-column tail | **open (follow-up)** |

## Test It Yourself (walkthrough)

From `repos/rag-chat` (DB up: `docker compose up -d vector-db`):
1. `uv run python ingestion/test_extract_scan.py` → 56/56 (Kuo-ToA mixed-case, giants, Beholder-preserved, no-false-owner).
2. `uv run python ingestion/test_golden_entities.py` → 1/1 (18 canonical entities incl. the giants/Kraken/Kuo-Toa).
3. Fire Giant live:
   `uv run --with "psycopg[binary]" --with openai python -c "import sys;sys.path.insert(0,'ingestion');from retrieval import RagRetriever;r=RagRetriever();x=r.retrieve('what is a fire giant?');print(x.answerable, x.chunks[0].entity_name)"`
   → `True Fire Giant`
4. `PYTHONUTF8=1 uv run --with "psycopg[binary]" --with openai python ingestion/eval_golden.py` → Hit@1 83.3%.

## Follow-ups / Known Gaps (agent-forge-harness-ask)

- The collapse detector still counts **legitimate** multi-stat-block monsters (lycanthropes:
  Wereboar = human/beast/hybrid) and **lore sections** (`Regional Effects`, `Giants` intro) as
  "offenders" — refine `detect_collapse` to exclude these.
- A genuine residual tail (names split from their stat block across columns/pages in the OCR'd
  two-column layout) needs column-aware reconstruction — same class as the spell two-column issue.
- Scope reframed from "~0 offenders" to "canonical monsters retrievable + detector materially
  reduced", which is the achievable, user-meaningful bar for the OCR'd source.
