# Plan — Scan Extraction Fix: monster-name binding (VGM/MTF)

> **Slug**: `dnd-scan-extraction-fix` · **Beads**: agent-forge-harness-qg4 (escalated)
> **Phase**: 2 (plan) · **Research**: [plans/research/dnd-scan-extraction-fix.md](../research/dnd-scan-extraction-fix.md)
> **Repo**: `repos/rag-chat` · **Approach**: TDD (pure name-binding first), demo-able, Beads-tracked.

---

## What the research settled

- **Root cause**: `extract_supplement_chunks` binds a monster's name to the line directly above the
  `Armor Class` anchor — the **type line** — instead of the **nearest bold ~12pt line** (the name).
- **Fix**: look back ≤4 lines from the anchor for the nearest bold ≥11.5pt line; skip the type line
  (size+creature-type+alignment regex); fall back to current behavior if none found.
- **Recoverable**: ~84 VGM + ~51 MTF monster names (71% / 37%). MTF dotted-leader appendix tables are
  a separate, out-of-scope sub-case (accept partial recovery).
- **Eval gap**: golden monster queries skew to MM/DMG; add VGM/MTF queries so recovery is visible.

## Open questions — resolved

1. **Look-back window / bold threshold** → window 4, bold ≥ 11.5pt (from the measurement). Hard-coded
   constants in the extractor (not per-book) — they held across both books sampled; revisit only if a
   re-ingest shows a book missing.
2. **Which books to re-ingest** → vgm + mtf now (the measured problem). Spot-check tce/eberron/ravnica
   monster naming after the fix; re-ingest them only if visibly wrong (avoid churning clean books).
3. **Type-line handling** → skip it for naming AND fold it into the stat-block body (mirror the MM
   extractor, which already pulls the type line into the block).

---

## Build — 3 checkpoints + ship

### Checkpoint 1 — bold-name binding in `extract_supplement_chunks`  *(task)*

- New pure helper `find_statblock_name(prior_lines: list[LineItem]) -> int | None` → index of the
  nearest bold ≥11.5pt line within the last 4, skipping type lines; None if absent.
- A `_TYPE_LINE_RE` (size + creature type + alignment) to identify/skip the type line.
- Rework the `open_anchored` path for the monster (`Armor Class`) case to use it: name = that bold
  line; pull the type line into the body; fall back to current `pop()` when no bold name found.
- Keep spell/feat anchors unchanged (their name IS directly above; verified clean).
- **Tests**: synthetic streams — (a) name/type/anchor → correct name + type in body; (b) noisy line
  between name and anchor → still finds bold name; (c) no bold name → fallback; (d) spell/feat
  unaffected (regression). Plus the existing 37 extract_scan tests stay green.
- **Demo**: re-extract VGM; show monster entity_names now read Banderhobb/… not type/Challenge lines;
  QA `bad_entity` count drops sharply.

### Checkpoint 2 — re-ingest vgm/mtf + measure  *(task)*

- Re-extract vgm + mtf → QA → re-embed (idempotent upsert by chunk_id; new clean monster chunks land,
  old mis-named ones are replaced/added). Report per-book QA pass-rate improvement.
- Spot-check tce/eberron/ravnica monster names; re-ingest if visibly wrong.
- **Demo**: DB monster count up; `SELECT entity_name … WHERE book_slug='vgm-5e' AND section='Stat Block'`
  shows real names; corpus chunk total grows by the recovered count.

### Checkpoint 3 — eval queries + A/B + report/ship  *(task)*

- Add ~6–8 VGM/MTF monster golden queries (Banderhobb, Meazel, Gloom Weaver, Froghemoth, …) via
  `gen_golden` regeneration (they'll be sampled now that the names are clean) or hand-curated.
- Run the suite; report `monster` Hit@1/MRR before vs after. Reranker stays off for the core A/B
  (isolate the extraction fix); optionally also report with `--rerank`.
- Reranker eval report update + PR; close qg4 + this effort.

---

## Beads

qg4 is the tracking bead (escalated). Child tasks:
- qg4.a — bold-name binding fix + tests  *(P3)*
- qg4.b — re-ingest vgm/mtf + QA delta  *(P3, depends a)*
- qg4.c — VGM/MTF eval queries + A/B + report + ship  *(P3, depends b)*

## Test strategy (TDD)

Pure-first: `find_statblock_name` over synthetic `LineItem` streams (no PDF/DB) — the bold/type/window
logic is fully unit-testable. Re-ingest and eval are verified by the real runs at the C2/C3 demos.
Existing 37 extract + 20 QA + 9 gen_golden + 29 eval + 10 rerank tests stay green.

## Risks & mitigations

- **Over-skipping (treating a real name as a type line)** → the type-line regex requires BOTH a size
  word AND a creature-type word; a bare name won't match. Unit-tested.
- **Fallback masks failures** → C2 reports the QA `bad_entity` delta so we see how many names were
  actually recovered vs still falling back.
- **Re-embedding cost** → only vgm/mtf (~2,200 chunks); idempotent upsert; ~$0.03.
- **Eval can't see recovery** → C3 explicitly adds VGM/MTF monster queries.

## Definition of done

Bold-name binding fix + tests; vgm/mtf re-ingested with a measured `bad_entity` drop and recovered
monster names in the DB; VGM/MTF monster golden queries added; `monster` Hit@1/MRR before/after
reported; qg4 closed; PR.
