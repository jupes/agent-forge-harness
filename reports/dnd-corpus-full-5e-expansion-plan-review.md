# Plan Review: dnd-corpus-full-5e-expansion — Full 5E Corpus Expansion + Comprehensive Eval + Pre-Embedding QA
Source: plans/drafts/dnd-corpus-full-5e-expansion.md · Reviewed: 2026-06-08

## Verdict: SOUND — 0 Blocker / 0 High / 3 Medium / 2 Low

The plan's load-bearing claims hold up: every function it promises to preserve exists in
`extract_scan.py`, the `content_type` column is unconstrained `text` (so `feat`/`subclass_feature`
add cleanly), the MM/DMG parity baselines (777/925) match the live DB, the test-count baselines
(29 eval + 19 extract_scan) are exact, and the pymupdf rescue claims were directly verified. No false
premise threatens the approach. The findings are operational gaps and one underspecified validator,
all fixable inside the existing checkpoints.

## Findings

### [Medium] embed.py does not auto-load `.env` — F4 ingest pipeline will fail silently per book — Checkpoint 4
**What:** The plan's F4 pipeline is "extract → QA gate → embed clean chunks" and implies `embed.py`
runs like `eval_golden.py`. But `embed.py` reads `os.environ.get("OPENAI_API_KEY")` directly with no
`.env` loader, whereas `eval_golden.py` has an explicit `_ENV_PATH` block that populates the
environment.
**Why it's an issue:** Running `embed.py` without first exporting `OPENAI_API_KEY` exits with
"OPENAI_API_KEY is not set" — across 10 books this is a repeated foot-gun, and was already hit during
the MM/DMG run (worked around with `export $(grep … .env | xargs)`). The plan doesn't capture this,
so an implementer following F4 verbatim stalls.
**Evidence:** `repos/rag-chat/ingestion/embed.py:50` (`os.environ.get` only); contrast
`repos/rag-chat/ingestion/eval_golden.py:32-39` (`_ENV_PATH` loader). — Confidence: Confirmed
**Suggested correction:** Add the same `_ENV_PATH` loader block to `embed.py` (small, one-time) as
part of F4, or document the `export` prerequisite in the F4 acceptance criteria. Adding the loader is
cleaner and removes the trap permanently.

### [Medium] `dict_word_ratio` needs an English wordlist that doesn't exist in the repo or stdlib — Checkpoint 2 (F2)
**What:** The QA gate's `dict_word_ratio` validator is specified as checking "against a small bundled
English wordlist." No such wordlist exists in `repos/rag-chat`, and Python's stdlib ships none.
**Why it's an issue:** F2 can't implement this validator as written without first sourcing/bundling a
wordlist (license + size + where it lives are unspecified). Left unaddressed it either silently
becomes a no-op or blocks the checkpoint.
**Evidence:** No wordlist file under `repos/rag-chat/` (no `words*.txt`/dictionary asset); Python
stdlib has no `words` corpus (only available via NLTK download, which adds a dependency). — Confidence: Confirmed
**Suggested correction:** Either (a) bundle a compact public-domain wordlist (e.g. SCOWL/`words`
~50k, committed under `ingestion/data/`), or (b) drop `dict_word_ratio` for v1 and rely on
`pua_control_ratio` + `alpha_ratio` + `has_cid_marker`, which already catch every observed failure
class (Wayfinders PUA, Tortle CID, XGE junk-OCR). Option (b) is lower-risk for the first landing;
add the dictionary check later if alpha-ratio proves insufficient.

### [Medium] Eberron/Ravnica setting-book layout is unverified — Checkpoint 3/4 — `content_type` classification may underperform
**What:** The plan asserts the supplements are "mixed-content" and gives signature rules tuned from
XGE/MM/DMG, but the setting books (Eberron RFTLW 324p, Ravnica 258p) were only profiled for
*extractability* (fonts + a sample line), not for *structure* (do they even use stat-block/spell/feat
signatures, or mostly prose lore?).
**Why it's an issue:** If Eberron/Ravnica are predominantly lore prose with few of the assumed
anchors, the classifier defaults nearly everything to `rule`/`lore` and the per-book QA pass-rate
(F4's ≥~90% canary) could read fine while content_type is uniformly coarse — weakening the amp
content-type filter for those books.
**Evidence:** Research doc profiled these books for fonts/readability only
(`plans/research/dnd-corpus-full-5e-expansion.md`, Tier-A table); no structural probe was run. —
Confidence: Needs confirmation
**Suggested correction:** In F3/F4, add a one-page structural probe per setting book before writing
its config; accept `rule`/`lore`-heavy output as valid for setting books (it's honest), but set the
expectation explicitly so the F4 QA canary isn't misread.

### [Low] New `LineItem.bold` field must be defaulted — tests construct positionally — Checkpoint 1 (F1)
**What:** F1 adds "bold flag … carried on `LineItem` as a new optional field." `LineItem` is a
dataclass and the existing tests build it positionally (`LineItem(1, 0, 5.3, "…")`).
**Why it's an issue:** A new field without a default, or inserted before `text`, breaks all 19
existing `extract_scan` positional constructions.
**Evidence:** `repos/rag-chat/ingestion/test_extract_scan.py:136` (`LineItem(1, 0, 5.3, "…")`
positional); `extract_scan.py:58-64` dataclass. — Confidence: Confirmed
**Suggested correction:** Append `bold: bool = False` as the last field (the plan already says
"optional" — just make the default explicit and keep it last).

### [Low] extract_scan.py CLI/docs say `--with pdfplumber`; engine swap must update the incantation — Checkpoint 1/4
**What:** The module docstring and usage examples invoke `uv run --with pdfplumber`. F1 swaps the
reader to pymupdf.
**Why it's an issue:** Cosmetic but real — copy-pasting the documented command after the swap omits
`--with pymupdf` and fails to import `fitz`.
**Evidence:** `repos/rag-chat/ingestion/extract_scan.py:20-21` (`--with pdfplumber`). — Confidence: Confirmed
**Suggested correction:** Update the docstring/usage to `--with pymupdf` (keep `--with pdfplumber`
only if a fallback engine flag is retained).

## Verified as accurate (spot-checks)
- All preserved functions exist — `extract_scan.py:113` `is_caps_heading`, `:162`
  `_assign_anchor_owners`, `:213` `extract_mm_chunks`, `:341` `extract_dmg_chunks`, `:136`
  `normalize_entity_name`, `:142` `split_paragraph_chunks` ✓
- `content_type` is unconstrained `text`, no CHECK/enum → `feat`/`subclass_feature` add freely —
  `information_schema` + `pg_constraint` (only `chunks_pkey`) ✓
- MM/DMG parity baselines match live DB — `mm-5e` 777, `dmg-5e` 925 ✓
- Test-count baselines exact — 29 `test_` in `test_eval_golden.py`, 19 in `test_extract_scan.py` ✓
- pymupdf rescues XGE (clean "GRAVE DOMAIN FEATURES…") and Tortle (CID decoded); Wayfinders stays
  PUA, Blood Hunter stays empty — direct `fitz.get_text` probe ✓
- fitz bold signal valid — span `flags & 16` = bold ("RANGER" flags=20=16+4; body flags=4) ✓
- `GoldenQuery` dataclass exists and carries `category`/`book` from the 0ij work —
  `eval_golden.py:54` ✓
- PHB Basic is a distinct `book_slug=phb-basic-v0.2` (569 chunks) deletable independently ✓

## Not verified
- **Per-book chunk-volume estimate (6–9K)** — extrapolated from page counts at 3–4.5 chunks/page;
  actual depends on each book's content density and won't be known until extraction. Not load-bearing.
- **QA pass-rate ≥~90% target** — a goal, not a current fact; the setting books (see Medium #3) are
  the most likely to undershoot.
- **gen_golden templating quality** — that DB-sampled templated questions read naturally and exercise
  retrieval as intended is an assumption verifiable only once F5 runs.
