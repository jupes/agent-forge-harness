# Research — Full 5E Corpus Expansion + Comprehensive Eval Dataset

> **Slug**: `dnd-corpus-full-5e-expansion`
> **Date**: 2026-06-08
> **Phase**: 1 (research) of the Forge pipeline
> **Repo**: `repos/rag-chat` (D&D product track, separate from harness)
> **Predecessor work**: cl1/amp/5ms filters, pd0 (MM+DMG via `extract_scan.py`), 0ij (64-query suite)

---

## Goal

Expand the D&D RAG corpus from 3 books (2,271 chunks) to the full set of cleanly-extractable
5E books, grow the golden eval dataset proportionally and by category, and — critically — add a
**pre-embedding data-quality gate** so the PDF-reader failures that have bitten past iterations are
caught *before* garbage reaches the vector store. After this lands, the next initiative is evaluating
extraction output quality directly.

User directives (this run):
- Add the remaining 5E books; exclude the `UO/` folder **except** Blood Hunter.
- Full Player's Handbook **replaces** PHB Basic v0.2 (`phb-basic-v0.2` retired).
- Include core mechanical supplements **and** the Eberron/Ravnica setting books.
- Land a comprehensive eval dataset alongside the corpus.

---

## Key Finding: the real problem is broken text layers, not calibration

Profiling every candidate PDF (pdfplumber + pymupdf, sampling fonts and extracted text) shows the
corpus splits into three extraction tiers. **This is the "numerous issues with the data
pre-embedding from the pdf reader" the user flagged, made concrete.**

### Tier A — clean extraction (10 books, ingest now)

| slug | book | pages | engine note |
|------|------|-------|-------------|
| `phb-5e` | Player's Handbook (full) | 322 | TimesNewRomanPSMT, minor OCR typos ("warloek", "ofeonfliet") |
| `xge-5e` | Xanathar's Guide to Everything | 195 | **pymupdf only** — pdfplumber reads a junk `HiddenHorzOCR` layer |
| `tce-5e` | Tasha's Cauldron of Everything | 194 | subset fonts (`Fd597699`), extracts clean |
| `vgm-5e` | Volo's Guide to Monsters | 226 | Times-Roman scan, MM-like |
| `mtf-5e` | Mordenkainen's Tome of Foes | 258 | Times-Roman scan |
| `eepc-5e` | Elemental Evil Player's Companion | 25 | AGaramondPro, clean |
| `scag-5e` | Sword Coast Adventurer's Guide | 161 | Times-Roman scan |
| `tortle-5e` | The Tortle Package | 28 | **pymupdf only** — pdfplumber yields `(cid:NNN)` codes |
| `eberron-5e` | Eberron: Rising from the Last War | 324 | subset fonts, clean |
| `ravnica-5e` | Guildmasters' Guide to Ravnica | 258 | Times-Roman, clean |

~1,991 new pages → **est. 6,000–9,000 new chunks** (3–4.5/page). Final corpus ~8–10K chunks across
12 books. Embedding cost negligible (~$0.10 at text-embedding-3-small).

### Tier B — OCR-blocked (defer, file bead)

| book | pages | problem |
|------|-------|---------|
| Wayfinders Guide to Eberron | 176 | body uses a Private-Use-Area custom font (`…`), no Unicode map; only headers decode |
| UA Blood Hunter | 11 | **image-only scan, zero text layer** |

No OCR tooling installed (`tesseract`, `ocrmypdf`, `pytesseract`, `pdf2image` all absent; Ollama is
present but vision-OCR is slow/variable). **User decision: defer both to an OCR follow-up bead.**
Rationale accepted: Wayfinders overlaps `eberron-5e` (clean); Blood Hunter is one homebrew class.

### Tier C — excluded

- `NLRMEv2.pdf` (83p, ArialNarrow/TimesNewRoman) — unidentified, not selected for inclusion.
- Rest of `UO/` (Artificer UA ×2, Revised Ranger, Aberrant Lurk, etc.) — per "exclude UO except Blood Hunter".

---

## Engine decision: move extraction to pymupdf (fitz)

`extract_scan.py` is built on pdfplumber (char-level grouping). pymupdf is strictly better for this
corpus:

1. **It rescues 2 books** pdfplumber can't read (XGE junk-OCR layer, Tortle CID).
2. `page.get_text("dict")` returns blocks→lines→spans with `bbox`, `size`, `font`, and `flags`
   (bold/italic bits) — richer and ~5× faster than pdfplumber char grouping.
3. Bold/italic flags give a second signal beyond font size, which matters because OCR scans drift in
   size (the MM monster-name problem) but bold is more stable.

**Risk**: MM/DMG already extract well via pdfplumber. Re-engining risks regressions. Mitigation
(for the plan): keep the proven `extract_scan.py` structure heuristics (Armor Class anchor, rarity
anchor, two-pass ownership) but swap the *line-reader* underneath to a pymupdf `LineItem` producer;
the pure functions (`extract_mm_chunks`, `extract_dmg_chunks`, `is_caps_heading`, …) stay unit-tested
and unchanged. Re-extract MM/DMG and diff chunk counts to confirm parity before committing.

---

## Content-shape finding: supplements are mixed-content, unlike MM/DMG

MM is all monsters; DMG is items+guidance. The supplements interleave many content types in one book:

- **XGE / TCE**: subclasses (per existing class), spells, feats, magic items, DM tools.
- **VGM / MTF**: monster lore + stat blocks (MM-shaped) **plus** playable races + DM lore.
- **EEPC**: spells + 4 genasi races (small, spell-heavy).
- **SCAG / Eberron / Ravnica**: backgrounds, races, subclasses, setting lore, some monsters/items.

Implication for the plan: per-book `kind` (the current `monster_manual` / `dmg` switch) is too coarse.
We need **within-book content-type classification** — detect stat blocks (Armor Class anchor),
spells (the `Nth-level`/`casting time` signature), feats (the "Prerequisite:" signature), subclass
features (class-name + level table), and fall back to `rule`/`lore` prose. New `content_type` values
to introduce: `feat`, `subclass_feature` (or reuse `class_feature`), `monster` (shared), plus the
existing set. The pre-embedding QA gate (below) validates that the classifier isn't mislabeling.

---

## The new component: pre-embedding data-quality gate

This is the user's stated next focus and the highest-leverage new piece. Today `embed.py` upserts
whatever `extract.py`/`extract_scan.py` emits. A validation pass between extract and embed should
**reject or quarantine** chunks that exhibit known PDF-reader failure signatures:

| signal | threshold (starting point) | catches |
|--------|---------------------------|---------|
| PUA / control-char ratio | > 2% of chars in `-` or control range | Wayfinders-class custom-font garbage |
| `(cid:` marker present | any | undecoded CID fonts (Tortle pre-pymupdf) |
| alpha ratio | < 50% alphabetic | junk-OCR layers (XGE pre-pymupdf: `.o~sl<r`) |
| dictionary-word ratio | < 40% recognizable English words | scrambled OCR |
| chunk length | < 5 words or > ~1,800 chars | fragments / runaway merges |
| entity_name sanity | non-empty, mostly alpha, < 48 chars | OCR-mangled names (Tholl/0Rog) |

Output a JSON QA report per book (counts pass/quarantine, reasons, sample offenders) so a human can
eyeball before embedding. This directly prevents the "garbage in the vector store" failure mode and
is reusable for every future book. It also gives the "evaluate the output of the files" initiative
its measurement surface.

---

## Eval dataset expansion

Current: 64 queries (60 positive + 4 negative) over 3 books. Grow proportionally and by new content:

- **New categories**: `feat`, `subclass`, `setting_lore` (Eberron/Ravnica), `race_feature` (expand),
  `spell_lookup` (expand to XGE/TCE/EEPC spells).
- **Cross-book entity collisions** (high-value, stress the filters): "Shield" the spell vs "Shield"
  armor vs "Shield Guardian" monster; "Hold Person" vs "Hold Monster"; a name appearing in both PHB
  and a supplement.
- **More negatives**: out-of-edition (4E/3.5 terms), out-of-corpus 5E (Spelljammer, Strixhaven),
  nonsense — to harden the future answerability gate (koz).
- **Target**: ~120–150 queries, every category n≥5 so per-category metrics are meaningful.
- Keep the stratified summary + negative-distance reporting already in `eval_golden.py`.

Open question for the plan: golden answers are hand-authored. ~90 new queries is real labor —
the plan should decide author-by-hand vs. semi-automated (sample entities from the corpus, template
questions, human-verify the expected tags).

---

## PHB retirement

Full `phb-5e` supersedes `phb-basic-v0.2`. Plan must: ingest phb-5e, `DELETE FROM dnd.chunks WHERE
book_slug='phb-basic-v0.2'` (569 chunks), and re-point the 20 PHB golden queries' expected tags to
phb-5e equivalents (chapter names/numbers differ between Basic and full PHB — verify each). This
**moots bead `sew`** (PHB Basic re-ingest) — close it as superseded.

---

## Decisions resolved this phase

1. **Engine** → pymupdf (rescues XGE+Tortle; keep extract_scan heuristics, swap the reader). *(research)*
2. **Full PHB replaces Basic**, retire `phb-basic-v0.2`, moot `sew`. *(user)*
3. **Book set** → 10 Tier-A books now; Wayfinders + Blood Hunter deferred to an OCR bead; NLRMEv2 + rest of UO excluded. *(user)*
4. **Pre-embedding QA gate** is in scope as a first-class component. *(research + user intent)*

## Open questions for the plan phase

- **Mixed-content classification**: per-line content-type detection rules — confidence vs. complexity.
  Start with the strongest signatures (stat block, spell, feat) and default the rest to `rule`/`lore`?
- **Golden-answer authoring**: hand-author ~90 queries vs. semi-automated template+verify?
- **QA gate action**: hard-reject quarantined chunks, or embed-but-flag for later audit?
- **MM/DMG re-extraction**: re-run under the pymupdf engine for consistency, or leave the existing
  1,702 chunks as-is and only use pymupdf for new books?
- **Chunk-volume guardrail**: 8–10K chunks is fine for pgvector HNSW, but is there a per-book cap or
  content-type filter (e.g. skip pure art/flavor pages) we want?

---

## Files in play

- `repos/rag-chat/ingestion/extract_scan.py` — extractor (engine swap + content classification)
- `repos/rag-chat/ingestion/embed.py` — insert QA gate call before upsert
- `repos/rag-chat/ingestion/eval_golden.py` — eval suite expansion
- `repos/rag-chat/ingestion/qa_chunks.py` — **new** pre-embedding validation harness
- `repos/rag-chat/ingestion/test_*.py` — unit tests (pure functions, no DB/PDF)
- `repos/rag-chat/docs/` — extraction QA + eval reports
