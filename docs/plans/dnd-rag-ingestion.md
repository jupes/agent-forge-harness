# D&D 5e RAG — PDF Ingestion Plan

> **Status**: Draft  
> **Last updated**: 2026-05-09  
> **Scope**: Ingest D&D 5e rulebook PDFs (starting with *Player's Basic Rules v0.2*) into the shared **pgvector** Docker service so agents can answer rules/spell/feature questions with chunk-grounded citations.

**Separate project**: This is the **D&D 5e app** RAG pipeline — entirely distinct from the harness code-repo RAG ([harness-rag-local-vector.md](./harness-rag-local-vector.md)). The two share a pgvector Docker container but use completely separate PostgreSQL schemas (`dnd.*` here, `harness.*` there). No cross-schema queries; no shared tables.

**Implementation home**: All code (extraction, chunking, embed, upsert, retrieval) lives in the **`rag-chat` sub-repo** (`repos/rag-chat/`). This document is the design spec only.

**Beads**: Epic **agent-forge-harness-rzx**; extraction **agent-forge-harness-8ew**; schema **agent-forge-harness-jes**; chunking **agent-forge-harness-10g**; embed+upsert **agent-forge-harness-26t**.

---

## Goals

1. Extract structured text from D&D PDF rulebooks with preserved hierarchy (Part → Chapter → Section).
2. Define a **chunk metadata schema** that supports filtering by content type (spell, rule, table, race feature, class feature, condition, etc.).
3. Chunk content at **semantic boundaries** — spell descriptions, table rows, and rule blocks must not be split mid-unit.
4. Upsert embeddings into pgvector **idempotently** so re-ingestion on new editions is safe.
5. Keep the pipeline runnable locally with no cloud dependencies — local embedding model via Ollama.

---

## Source Material

| File | Pages | Status |
|------|-------|--------|
| `PlayerDnDBasicRules_v0.2_PrintFriendly.pdf` | 115 | Pilot corpus |

Additional books (Monster Manual excerpts, Dungeon Master's Guide, etc.) can be added once the schema is validated against the Basic Rules.

---

## Content Structure (Basic Rules v0.2)

```
Introduction
Part 1 — Creating a Character
  Chapter 1: Step-by-step Characters
  Chapter 2: Races (Human, Dwarf, Elf, Halfling)
  Chapter 3: Classes (Cleric, Fighter, Rogue, Wizard)
  Chapter 4: Personality and Background
  Chapter 5: Equipment
  Chapter 6: Customization Options (Feats, Multiclassing)
Part 2 — Playing the Game
  Chapter 7: Using Ability Scores
  Chapter 8: Adventuring
  Chapter 9: Combat
Part 3 — The Rules of Magic
  Chapter 10: Spellcasting
  Chapter 11: Spells (100+ individual entries)
Appendix A: Conditions
Appendix B: Gods of the Multiverse
Appendix C: The Five Factions
```

### Content Types

| Type | Description | Chunking rule |
|------|-------------|---------------|
| `rule` | Prose rule text (action economy, movement, etc.) | Paragraph-level; max ~400 tokens |
| `spell` | Individual spell description (name → casting time/range/components/duration/effect) | **Atomic** — never split a spell across chunks |
| `table` | Armor table, weapon table, spell slot table, etc. | **Atomic** — keep all rows in one chunk with table title |
| `race_feature` | Racial trait block (Darkvision, Brave, etc.) | Atomic per feature or per race block |
| `class_feature` | Class feature description (Spellcasting, Action Surge, etc.) | Atomic per feature |
| `background` | Background entry (Proficiencies, Feature, Suggested Characteristics) | Atomic per background |
| `condition` | Condition description (Blinded, Charmed, etc.) | Atomic per condition |
| `narrative` | Flavor text, introductions, building-Bruenor examples | Paragraph-level; lower retrieval priority |

---

## Chunk Schema (decided)

```typescript
interface DndChunk {
  // Identity
  chunk_id: string;       // deterministic: sha256(book_slug + page_start + chunk_index)
  book_slug: string;      // e.g. "phb-basic-v0.2"
  source_file: string;    // original filename

  // Location in document
  page_start: number;     // 1-indexed PDF page
  page_end: number;       // inclusive; equals page_start for single-page chunks
  part: string | null;    // "Part 1" / "Part 2" / "Part 3" / "Appendix A" etc.
  chapter: string | null; // "Chapter 3: Classes"
  section: string | null; // heading of nearest H2 ancestor

  // Content classification
  content_type: DndContentType;

  // Named entity — split into two fields for class features
  entity_name: string | null;    // spell name, race name, condition name, etc.
  class_name: string | null;     // parent class for class_feature chunks (e.g. "Fighter")
  feature_name: string | null;   // specific feature name for class_feature chunks (e.g. "Action Surge")

  // Text
  text: string;
}

type DndContentType =
  | "rule"
  | "spell"
  | "table"
  | "race_feature"
  | "class_feature"
  | "background"
  | "condition"
  | "narrative";
```

**Decisions recorded:**
- `class_name` + `feature_name` replaces the single `entity_name` field for `class_feature` chunks; other content types use only `entity_name` (leave `class_name`/`feature_name` null).
- `subsection` heading level dropped — `section` + `entity_name`/`feature_name` is sufficient.
- `narrative` chunks included but excluded from the default retrieval path (filter `content_type != 'narrative'` in standard queries; include only when explicitly requested).

---

## Database Topology (decided)

**Separate PostgreSQL schema** (`dnd` schema, same DB as harness chunks, same Docker container).

```sql
CREATE SCHEMA IF NOT EXISTS dnd;
-- All D&D tables live under dnd.*
```

Rationale:
- One pgvector container and one connection string shared with harness.
- `DROP SCHEMA dnd CASCADE` wipes the entire D&D corpus without touching harness code-chunk tables.
- No cross-corpus query confusion — table names (`dnd.chunks`) are unambiguous.

---

## Embedding Model (decided)

**`mxbai-embed-large` via Ollama** — 1024 dimensions.

```bash
ollama pull mxbai-embed-large
```

All `VECTOR(...)` columns in DDL use **1024**. The harness pgvector container must have the `mxbai-embed-large` model pulled before running ingestion.

---

## Phase 1 — PDF Text Extraction (`rag-chat`)

**Goal**: A script in `repos/rag-chat/` that reads the PDF and outputs `raw-extract.jsonl` — one line per logical block with raw text + detected metadata.

**Approach**:
- **Spike first**: run `pdfplumber` (Python) and `unpdf`/`pdf-parse` (Node) on Chapter 5 (Equipment tables) and Chapter 11 (Spells). Pick whichever preserves table row structure and spell header detection better.
- Detect heading levels by font size/weight heuristics or regex against known chapter title patterns.
- Output shape: `{ page: number, block_index: number, raw_text: string, heading_level: 1|2|3|null, heading_text: string|null }`.

**Acceptance** (`agent-forge-harness-8ew`):
- Script runs on `PlayerDnDBasicRules_v0.2_PrintFriendly.pdf` → `raw-extract.jsonl`.
- "Fireball" spell block is a single contiguous block.
- Chapter 3 heading detected as `heading_level: 1`.
- Weapons table (p.43) rows appear intact, not fragmented across lines.

---

## Phase 2 — Chunking (`rag-chat`)

**Goal**: Transform `raw-extract.jsonl` → `chunks.jsonl` where each line is a `DndChunk` (without embedding).

**Rules**:
- `spell`: one chunk per spell. Boundary = spell name heading → next spell name heading.
- `table`: one chunk per table, title included in text.
- `class_feature`, `race_feature`, `background`, `condition`: one chunk per named entity block.
- `rule` / `narrative`: paragraph-grouped, max ~400 tokens, 50-token overlap; section context preserved in metadata.
- `chunk_id`: `sha256(book_slug + ":" + page_start + ":" + chunk_index)` — deterministic, stable across re-runs.

**Acceptance** (`agent-forge-harness-10g`):
- `chunks.jsonl` produced; chunk count in expected range (~600–1200 for 115 pages).
- Re-running on same input produces identical `chunks.jsonl`.
- No spell split across two chunks (verify by checking all spell-name headings appear as `entity_name` on exactly one chunk each).

---

## Phase 3 — Embedding + pgvector Upsert (`rag-chat`)

**Dependencies**: pgvector container healthy (harness-rag-local-vector Phase 1).

**DDL** (dimension TBD — placeholder 768):
```sql
CREATE SCHEMA IF NOT EXISTS dnd;

CREATE TABLE IF NOT EXISTS dnd.chunks (
  chunk_id     TEXT PRIMARY KEY,
  book_slug    TEXT NOT NULL,
  source_file  TEXT NOT NULL,
  page_start   INT,
  page_end     INT,
  part         TEXT,
  chapter      TEXT,
  section      TEXT,
  content_type TEXT NOT NULL,
  entity_name  TEXT,
  class_name   TEXT,
  feature_name TEXT,
  text         TEXT NOT NULL,
  embedding    VECTOR(1024)  -- mxbai-embed-large via Ollama
);

CREATE INDEX IF NOT EXISTS dnd_chunks_embedding_idx
  ON dnd.chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

**Upsert**:
```sql
INSERT INTO dnd.chunks (...) VALUES (...)
ON CONFLICT (chunk_id) DO UPDATE SET
  text = EXCLUDED.text,
  embedding = EXCLUDED.embedding,
  content_type = EXCLUDED.content_type,
  entity_name = EXCLUDED.entity_name,
  class_name = EXCLUDED.class_name,
  feature_name = EXCLUDED.feature_name;
```

**Acceptance** (`agent-forge-harness-26t`):
- All chunks upserted; row count matches `chunks.jsonl` line count.
- Re-run: row count unchanged (idempotent).
- `SELECT * FROM dnd.chunks WHERE content_type = 'spell' AND entity_name = 'Fireball'` returns exactly one row.
- Cosine similarity query for "how does the Attack action work?" returns ≥1 `rule` chunk from Chapter 9.

---

## Phase 4 — Golden Set Evaluation

| Question | Expected content_type | Expected entity / section |
|----------|-----------------------|--------------------------|
| "What is the range of Fireball?" | `spell` | entity_name = "Fireball" |
| "How many hit points does a Fighter get at level 1?" | `class_feature` | class_name = "Fighter" |
| "What does the Blinded condition do?" | `condition` | entity_name = "Blinded" |
| "How does grappling work?" | `rule` | chapter = "Chapter 9" |
| "What languages do Elves know?" | `race_feature` | entity_name = "Elf" |
| "What are the components of Cure Wounds?" | `spell` | entity_name = "Cure Wounds" |

Use to tune `topK`, similarity threshold, and chunk boundary decisions after pilot ingestion.

---

## Open Questions

- [ ] **Extraction tool spike**: `pdfplumber` vs. Node alternative — run and compare on Chapter 5 (tables) + Chapter 11 (spells) before committing to one.
- [ ] **Re-ingestion on new PDF editions**: bump `book_slug` (e.g. `phb-basic-v0.3`) and run upsert — old slug rows persist until manually deleted. Or delete-by-slug before re-upsert. Decision needed before second book is added.

---

## Next Steps

1. **Embedding model decision** — user answers Ollama vs. Python, then fix VECTOR dimension in DDL.
2. **Extraction spike** in `repos/rag-chat/` — compare pdfplumber vs. Node on tables + spell blocks.
3. **Land schema DDL** in `rag-chat` once model is decided.
4. **Pilot ingestion** — all 115 pages → golden set eval.
