# Research — Scan Extraction Fix: monster-name binding on VGM/MTF

> **Slug**: `dnd-scan-extraction-fix` · **Beads**: agent-forge-harness-qg4 (escalated)
> **Date**: 2026-06-08 · **Phase**: 1 (research) · **Repo**: `repos/rag-chat`
> **Origin**: qg4 scope investigation showed bulk name-merge is unsafe; the real problem is an
> extraction bug, not name cleanup.

---

## Problem

Heavily-OCR'd monster books (Volo's, Mordenkainen's) lose monster names during extraction: stat
blocks land with mangled or wrong `entity_name` (Challenge/Skills field lines, type lines, OCR
garbage), so ~223 chunks were quarantined by the QA gate's `bad_entity` check and never embedded.
Affected monsters (Banderhobb, Meazel, Gloom Weaver, Duergar variants, …) are simply **absent from
the corpus**, which drags the `monster` retrieval category (Hit@1 0.70, MRR 0.734).

## Root cause (confirmed)

`extract_supplement_chunks` opens a monster chunk on the `Armor Class N` anchor and binds the name
via `cur_lines.pop()` — **the line directly above the anchor**. But in a real stat block that line is
the **type line**, not the name:

```
12.3pt BOLD   BANDBRHOBB                      ← the name (OCR of "Banderhobb")
10.1pt BOLD   Largemonstrosity, neutral evil  ← type line  (size + creature-type + alignment)
 8.6pt BOLD   Armor Class 15 (natural armor)  ← anchor
```

The extractor pops the type line (or, on noisier pages, a Challenge/Skills line or OCR junk) as the
name. The **name is reliably the nearest bold ~12pt line above the type line** — and the fitz reader
already carries the bold flag (added in F1), but the supplement extractor never uses it for naming.

## Impact / recoverability (measured)

Scanning every `Armor Class` anchor and checking for a bold ≥11.5pt line within 4 lines above:

| book | stat blocks | bold-name recoverable | rate |
|------|-------------|-----------------------|------|
| VGM | 118 | 84 | **71%** |
| MTF | 139 | 51 | **37%** |

A bold-name-aware fix cleanly recovers ~135 monster names. MTF's lower rate is a **secondary layout**:
its appendix presents many monsters in dotted-leader "contents" stat tables
(`Challenge 9 (5,000 XP) Meazel ...........`) where the name is inline in a leader list, not a bold
heading — a harder case worth a separate pass (or accepting partial recovery).

## Fix direction

Improve monster-name binding in `extract_supplement_chunks` (and reuse the signal anywhere a stat
block is opened):

1. On the `Armor Class` anchor, **don't pop the immediate previous line**. Instead look back over a
   small window (≤4 lines) for the **nearest bold line ≥ ~11.5pt** — that's the name.
2. Skip the **type line** explicitly (regex: `(tiny|small|…|gargantuan).*(aberration|beast|…|undead)`)
   so it's never mistaken for the name, and pull it into the stat-block body (as the MM extractor
   already does).
3. Fall back to the current behavior only when no bold name line is found (rare; MTF leader tables).

This is low-risk: it leverages a signal already in the `LineItem` stream, is a pure change to the
name-selection step, and is unit-testable with synthetic streams (bold name + type line + anchor).
It generalizes to any supplement carrying stat blocks (TCE, Eberron, Ravnica also have monsters).

## Scope decision

- **In scope**: bold-name binding fix in the supplement extractor; re-extract → QA → re-embed the
  monster-bearing supplements (vgm, mtf, and check tce/eberron/ravnica); measure `monster` Hit@1/MRR
  delta on the golden suite.
- **Out of scope (note as follow-up)**: MTF appendix dotted-leader stat tables (the ~37% remainder) —
  a distinct parser; accept partial recovery this round.
- **qg4** (narrow name-merge) is **superseded** by this fix — recovering names at extraction time is
  strictly better than post-hoc fuzzy-merge. Close qg4 when this ships.

## Open questions for the plan

- **Look-back window & bold threshold**: 4 lines / 11.5pt from the measurement — confirm against a
  few more samples, or make per-book config.
- **Which books to re-ingest**: vgm + mtf for sure; do tce/eberron/ravnica monsters benefit enough to
  re-ingest them too, or only if the eval shows monster misses there?
- **Measurement**: the current golden monster queries skew to MM/DMG entities; add a few VGM/MTF
  monster queries (Banderhobb, Meazel, …) so the eval can actually see the recovery.

## Files
- `repos/rag-chat/ingestion/extract_scan.py` — `extract_supplement_chunks` name binding.
- `repos/rag-chat/ingestion/test_extract_scan.py` — bold-name binding tests.
- re-ingest via `ingestion/ingest_books.py`; measure via `ingestion/eval_golden.py`.
