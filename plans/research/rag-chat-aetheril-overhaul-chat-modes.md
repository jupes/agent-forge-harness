# Research: rag-chat-aetheril-overhaul — Multi-Mode Chat (backend)

Generated: 2026-06-21
Repo: rag-chat (service + ingestion + vector-db)
Phase: research (1/4) — workstream doc

---

## Goal

Turn the single stateless `POST /chat` endpoint (whole-corpus, one persona) into a
**multi-mode** endpoint with four named modes: **sage** (general D&D 5e, the current
default), **spell** (spells and cantrips only), **rules** (mechanics, conditions,
class features), and **gm** (dungeon-master creativity — allowed to invent using the
corpus as inspiration rather than strictly refusing). The design must stay
backward-compatible with the existing client contract (`api.ts`).

---

## What the Code Says (answered by exploration)

### Current /chat request flow

```
POST /chat  →  service/app.py:chat() [line 55]
  svc.answer(req.prompt)           # req is ChatRequest, only field is `prompt`
    │
    └─ service/rag.py:RagService.answer(prompt) [line 33]
         │
         ├─ self.retriever.retrieve(prompt, reranker=self.reranker)
         │     → ingestion/retrieval.py:RagRetriever.retrieve() [line 426]
         │         embed_query(prompt)                             # OpenAI text-embedding-3-small
         │         extract_query_entities(prompt, ...)             # vocab match → classes, entities
         │         extract_query_content_types(prompt, ...)        # entity+keyword → ctypes
         │         retrieve_top_k(conn, emb, prompt, k,
         │                        classes=classes, entities=entities,
         │                        content_types=ctypes)            # filtered cosine kNN SQL
         │         fetch_chunk_details(conn, chunk_ids)            # full text + book_slug per chunk
         │         is_answerable(top1_distance)                    # KOZ gate: dist <= 0.50
         │         → RetrievalResult(chunks, full_texts, top1_distance,
         │                           answerable, book_by_id, ...)
         │
         ├─ [koz gate] if not result.answerable or not result.chunks:  [line 37]
         │       return ChatResponse(answer=REFUSAL, sources=[], answerable=False)
         │
         ├─ context = build_context(result, top_n=5)   # service/generate.py:34
         ├─ answer = generate_answer(prompt, context, model, client)
         │     # builds GROUNDED_PROMPT (system persona in template string), sends single
         │     # user message to gpt-4o-mini; temperature 0.2
         └─ sources = build_sources(result, top_n=5)
              → ChatResponse(answer, sources, answerable=True)
```

**Key files and lines:**
- `service/app.py:55-58` — route handler; passes only `req.prompt` to `svc.answer`
- `service/rag.py:33-43` — `RagService.answer` — the full pipeline; gate at line 37
- `service/rag.py:19` — `REFUSAL` constant string
- `service/generate.py:24-31` — `GROUNDED_PROMPT` is a module-level string constant;
  the persona is baked directly into the format template, not injected per-call
- `service/generate.py:64-77` — `generate_answer()` hard-codes a single `user` message
  with the filled-in `GROUNDED_PROMPT`; there is no `system` message today
- `ingestion/retrieval.py:426-455` — `RagRetriever.retrieve()` — no `mode` or
  `book_filter` parameter; filtering is purely query-derived (entity/class/ctype)

### Chunk schema + corpus books/metadata (what we can scope by)

**Table: `dnd.chunks`** (`vector-db/init/02-schema.sql`)

| Column | Type | Notes |
|--------|------|-------|
| `chunk_id` | TEXT PK | hash of source position |
| `book_slug` | TEXT NOT NULL | e.g. `phb-5e`, `mm-5e`, `dmg-5e` |
| `source_file` | TEXT | PDF filename |
| `page_start` | INT | |
| `page_end` | INT | |
| `part` | TEXT | nullable |
| `chapter` | TEXT | nullable |
| `section` | TEXT | nullable |
| `content_type` | TEXT NOT NULL | see values below |
| `entity_name` | TEXT | nullable |
| `class_name` | TEXT | nullable |
| `feature_name` | TEXT | nullable |
| `text` | TEXT | full chunk body |
| `embedding` | vector(1536) | OpenAI text-embedding-3-small |
| `search_vector` | tsvector | FTS weight A/B/C |

Indexes: `dnd_chunks_book_slug_idx` on `book_slug` exists — filtering by book is
**index-backed and cheap**.

**Known `content_type` values** (from `_CTYPE_KEYWORDS` in `retrieval.py:199-206`,
ARCHITECTURE.md, and eval reports):

| `content_type` | Description |
|---------------|-------------|
| `spell` | Spell / cantrip entries |
| `class_feature` | Class feature blocks (PHB, XGE, TCE) |
| `condition` | Condition definitions |
| `race_feature` | Racial trait blocks |
| `background` | Background entries |
| `monster` | Stat blocks + lore (MM, VGM, MTF) |
| `magic_item` | Magic item entries (DMG) |
| `dm_guidance` | DM chapters (DMG) |
| `feat` | Feat entries (XGE, TCE, PHB) |
| `rule` | General rules prose (PHB, supplements) |

**Corpus books** (12 books, 9,103 chunks, from `ingestion/ingest_books.py:36-47` +
ARCHITECTURE.md + full-corpus-expansion doc):

| `book_slug` | Title | Primary content_types |
|-------------|-------|-----------------------|
| `phb-5e` | Player's Handbook | `rule`, `class_feature`, `race_feature`, `spell`, `condition`, `background` |
| `xge-5e` | Xanathar's Guide to Everything | `spell`, `class_feature`, `feat`, `rule` |
| `tce-5e` | Tasha's Cauldron of Everything | `spell`, `class_feature`, `feat`, `rule` |
| `vgm-5e` | Volo's Guide to Monsters | `monster` |
| `mtf-5e` | Mordenkainen's Tome of Foes | `monster`, `rule` |
| `eepc-5e` | Elemental Evil Player's Companion | `spell`, `race_feature` |
| `scag-5e` | Sword Coast Adventurer's Guide | `rule`, `class_feature`, `race_feature` |
| `tortle-5e` | The Tortle Package | `race_feature`, `rule` |
| `eberron-5e` | Eberron: Rising from the Last War | `rule`, `race_feature`, `class_feature` |
| `ravnica-5e` | Guildmasters' Guide to Ravnica | `rule`, `race_feature`, `monster` |
| `mm-5e` | Monster Manual | `monster` |
| `dmg-5e` | Dungeon Master's Guide | `dm_guidance`, `magic_item` |

**No `category` or `mode` metadata column exists in the DB.** Scoping must be achieved
through the existing `book_slug` and `content_type` columns.

### Where persona prompt is built

`service/generate.py:24-31` — `GROUNDED_PROMPT` is a module-level constant:

```python
GROUNDED_PROMPT = (
    "You are a Dungeons & Dragons 5th Edition rules assistant. "
    "Answer the user's question using ONLY the numbered sources below. "
    "Cite the sources you use inline as [1], [2], etc. "
    "If the sources do not contain the answer, say you don't have that in your "
    "sources — do not use outside knowledge.\n\n"
    "Sources:\n{context}\n\nQuestion: {question}\n\nAnswer:"
)
```

This string is filled via `.format()` in `generate_answer()` (line 71) and placed
as the **sole** `user` message body. There is **no `system` message** today.

The cleanest seam for per-mode persona injection is `generate_answer()`:
- Currently: `messages=[{"role": "user", "content": prompt_filled}]`
- After: accept a `system_prompt: str | None = None` parameter; prepend a
  `{"role": "system", "content": system_prompt}` message when provided.

The persona string itself (the "You are a..." preamble) should move out of
`GROUNDED_PROMPT` and become a per-mode constant so the grounding instruction
(`ONLY the numbered sources…`) can be shared.

### Where the answerability gate lives

**Gate A — koz (corpus-level answerability)**
`service/rag.py:37` — `if not result.answerable or not result.chunks`

`result.answerable` is set in `ingestion/retrieval.py:441`:
```python
answerable = is_answerable(top1)
```
where `is_answerable()` (line 257) returns `top1_distance <= 0.50`.
`KOZ_ANSWERABLE_DISTANCE = 0.50` at line 243.

This is the gate that must be **relaxed** for `mode='gm'` only.

**Gate B — ipl (over-restriction fallback)**
`ingestion/retrieval.py:244-253` — `needs_unfiltered_fallback()`, threshold 0.42.
Fires inside `retrieve_top_k` only when `fallback=True` is passed; `RagRetriever.retrieve`
does not pass `fallback=True`, so this gate is currently dormant at runtime.

---

## Recommended Backend Design

### Mode enum + API contract change

**New `models.py`:**

```python
from enum import Enum

class ChatMode(str, Enum):
    sage  = "sage"
    spell = "spell"
    rules = "rules"
    gm    = "gm"

class ChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Natural-language D&D question")
    mode: ChatMode = Field(ChatMode.sage, description="Chat mode (sage|spell|rules|gm)")
    conversation_id: str | None = Field(None, description="Carried through; persistence is stubbed")

class ChatResponse(BaseModel):
    answer: str
    sources: list[Source]
    answerable: bool
    mode: ChatMode = ChatMode.sage   # echo back — optional field, ignored by old clients
```

**Backward compatibility analysis vs `ui/src/api.ts`:**
- `api.ts` sends `JSON.stringify({ prompt })` — the new `mode` and `conversation_id`
  fields are **optional with defaults**, so existing clients sending only `prompt` continue
  to work without change.
- `api.ts` reads `{ answer, sources, answerable }` — adding `mode` to the response is
  additive; `as ChatResponse` cast in TypeScript will just ignore the extra field until
  the UI is updated.
- The `Source` interface in `api.ts` is unchanged.
- `422` / `503` error handling in `api.ts` is unchanged.

**No breaking changes.** The UI can be updated separately to send/display `mode`.

### Per-mode persona injection

**Step 1: Extract persona from `GROUNDED_PROMPT` in `generate.py`:**

```python
# Shared grounding instruction (injected in every mode's system prompt)
_GROUNDING_SUFFIX = (
    "Answer the user's question using ONLY the numbered sources below. "
    "Cite the sources you use inline as [1], [2], etc. "
    "If the sources do not contain the answer, say you don't have that in your "
    "sources — do not use outside knowledge."
)

PERSONA_PROMPTS: dict[str, str] = {
    "sage": (
        "You are the Sage — an all-knowing D&D 5th Edition assistant. "
        + _GROUNDING_SUFFIX
    ),
    "spell": (
        "You are a Spell Archivist specializing in D&D 5e spells and cantrips. "
        "Be precise about components, ranges, durations, and upcasting. "
        + _GROUNDING_SUFFIX
    ),
    "rules": (
        "You are a Rules Arbiter for D&D 5e. Cite rules text exactly; "
        "be clear when a rule has errata or is disputed. "
        + _GROUNDING_SUFFIX
    ),
    "gm": (
        "You are the GM Oracle — a creative Dungeon Master assistant. "
        "Ground your answers in the D&D 5e sources provided, but you may "
        "extrapolate, invent, and create (monsters, NPCs, plot hooks) "
        "inspired by those sources. When inventing, say so explicitly. "
        "Cite sources where you draw from them; note invented content."
    ),
}
```

**Step 2: Thread `mode` through `generate_answer()`:**

```python
def generate_answer(
    question: str,
    context: str,
    *,
    mode: str = "sage",
    model: str = DEFAULT_MODEL,
    client=None,
) -> str:
    system = PERSONA_PROMPTS.get(mode, PERSONA_PROMPTS["sage"])
    grounded = GROUNDED_TEMPLATE.format(context=context, question=question)
    messages = [
        {"role": "system", "content": system},
        {"role": "user",   "content": grounded},
    ]
    resp = client.chat.completions.create(
        model=model, messages=messages, temperature=0.2,
    )
    return resp.choices[0].message.content.strip()
```

Where `GROUNDED_TEMPLATE` is the numbered-sources block without the persona preamble:
```python
GROUNDED_TEMPLATE = (
    "Sources:\n{context}\n\nQuestion: {question}\n\nAnswer:"
)
```

**Step 3: Thread `mode` through `RagService.answer()`:**

```python
def answer(self, prompt: str, mode: str = "sage") -> ChatResponse:
    ...
    answer = generate_answer(prompt, context, mode=mode, model=self.model, client=self.llm_client)
```

**Step 4: Thread `mode` through `app.py:chat()`:**

```python
@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest, svc: RagService = Depends(get_service)) -> ChatResponse:
    try:
        return svc.answer(req.prompt, mode=req.mode.value)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"upstream error: {exc}") from exc
```

### Per-mode retrieval scoping (book/section mapping table)

The existing `content_type` filter in `build_vector_sql` accepts an arbitrary set of
content type strings. The `book_slug` column also has a dedicated index
(`dnd_chunks_book_slug_idx`). We need to add a `book_slugs: set[str] | None`
parameter to `build_vector_sql` and `retrieve_top_k`.

**Mode → scope mapping:**

| Mode | `content_types` forced | `book_slugs` allowed | Rationale |
|------|------------------------|----------------------|-----------|
| `sage` | none (query-derived, current behavior) | none (all books) | General assistant; keep current pipeline unchanged |
| `spell` | `{"spell"}` | `{"phb-5e","xge-5e","tce-5e","eepc-5e","scag-5e","tortle-5e","eberron-5e","ravnica-5e"}` | PHB spells + supplements; exclude MM/DMG which have no spell chunks |
| `rules` | `{"rule","class_feature","condition","race_feature","background","feat"}` | all books (all supply rules prose) | Exclude `monster`, `magic_item`, `dm_guidance` |
| `gm` | none (query-derived) + `{"monster","dm_guidance","magic_item"}` merged | all books | GM wants monsters, items, and guidance; query-derived filtering still applies |

**Implementation — add `book_slugs` filter to `build_vector_sql`** (`ingestion/retrieval.py`):

```python
def build_vector_sql(
    emb_str: str,
    k: int,
    classes: set[str],
    entities: set[str],
    content_types: set[str] | None = None,
    book_slugs: set[str] | None = None,      # NEW
) -> tuple[str, tuple]:
    ...
    if book_slugs:
        where_parts.append("book_slug = ANY(%s)")
        params_mid.append(list(book_slugs))
    ...
```

For `spell` mode the content_types override **replaces** (not merges with) the
query-derived types, so a user asking "how do spells work" in spell mode doesn't
accidentally get pulled to `rule` chunks.

For `rules` mode the forced `content_types` **merges** with query-derived types
(union), ensuring that a rules-mode query for "Fireball" doesn't get `monster` chunks.
Actually simpler: in `rules` mode, force content_types to be the intersection of
query-derived ctypes and the rules allowlist; if the intersection is empty, use the
full allowlist.

For `gm` mode the forced content_types are **merged** (union) with query-derived so the
GM gets monster/item/guidance context even for queries that don't mention a specific entity.

**Where it plugs in — `RagRetriever.retrieve()`:**

Add `mode: str = "sage"` parameter:

```python
def retrieve(self, prompt: str, k: int = TOP_K, reranker=None, mode: str = "sage") -> RetrievalResult:
    emb = embed_query(prompt)
    classes, entities = extract_query_entities(prompt, self.known_classes, self.known_entities)
    ctypes = extract_query_content_types(prompt, self.entity_to_ctype, self.class_to_ctype)

    forced_ctypes, allowed_books = _scope_for_mode(mode, ctypes)

    with psycopg.connect(self.dsn) as conn:
        chunks = retrieve_top_k(
            conn, emb, prompt, k, mode="vector",
            classes=classes, entities=entities,
            content_types=forced_ctypes,
            book_slugs=allowed_books,           # NEW param
        )
        ...
```

`_scope_for_mode()` is a pure function in `retrieval.py` (or `rag.py`) that takes
`(mode, query_ctypes)` and returns `(effective_ctypes, book_slug_set | None)`.

`RagService.answer()` passes `mode` down to `self.retriever.retrieve(prompt, mode=mode)`.

### GM creative gate (relaxed, GM-only)

**Current gate** (`service/rag.py:37`):
```python
if not result.answerable or not result.chunks:
    return ChatResponse(answer=REFUSAL, sources=[], answerable=False)
```

`result.answerable` is `top1_distance <= 0.50`. For GM mode we want to allow
answering even when `answerable=False`, as long as some chunks were retrieved at all.

**Proposed minimal change in `RagService.answer()`:**

```python
def answer(self, prompt: str, mode: str = "sage") -> ChatResponse:
    result = self.retriever.retrieve(prompt, reranker=self.reranker, mode=mode)

    # Grounding gate: strict for sage/spell/rules; relaxed for gm.
    if mode == "gm":
        # GM mode: proceed if ANY chunks were retrieved, even at low confidence.
        # If nothing retrieved at all, fall back to refusal.
        if not result.chunks:
            return ChatResponse(answer=REFUSAL, sources=[], answerable=False)
        # answerable=False chunks are still used as "inspiration" context
    else:
        # sage / spell / rules: strict koz gate
        if not result.answerable or not result.chunks:
            return ChatResponse(answer=REFUSAL, sources=[], answerable=False)

    context = build_context(result, top_n=CONTEXT_TOP_N)
    answer = generate_answer(prompt, context, mode=mode, model=self.model, client=self.llm_client)
    sources = build_sources(result, top_n=CONTEXT_TOP_N)
    # For GM mode, pass answerable=result.answerable so the client knows whether
    # the answer is fully grounded (True) or partly inventive (False).
    return ChatResponse(answer=answer, sources=sources, answerable=result.answerable)
```

**Citation behavior when content is partly invented (GM mode):**
- `sources[]` still populated from retrieved chunks — the client knows which chunks
  were used as inspiration.
- `answerable=False` in the response signals the UI that the answer may contain
  invented content. The GM persona prompt already instructs the model to say "I'm
  inventing this" inline.
- UI can render a distinct "GM creative" badge when `mode='gm' && answerable=False`.

This is the **minimal change**: one `if mode == "gm"` branch in `rag.py:answer()`.
No changes to `retrieval.py` gates (they still set `result.answerable` correctly;
we just choose not to act on it strictly for GM mode).

### Second-source seam for GM (stubbed now)

The GM mode will eventually pull from a "world corpus" (user-defined campaign notes,
custom monsters, homebrew) in addition to the official books. That second retriever
is **not built yet**, but the seam should be designed now so the future addition
is a one-file drop-in.

**Interface design (`service/rag.py` or a new `service/retrieval_sources.py`):**

```python
from typing import Protocol

class SecondaryRetriever(Protocol):
    """Retrieves chunks from a second corpus (e.g., world/campaign notes).
    Must return a RetrievalResult-compatible object."""
    def retrieve(self, prompt: str, k: int = 5) -> "SecondaryResult":
        ...

class SecondaryResult:
    chunks: list  # same shape as RetrievedChunk
    full_texts: dict[str, str]
    book_by_id: dict[str, str]
    answerable: bool


class StubSecondaryRetriever:
    """No-op stub — always returns empty results. Replace with a real
    SecondaryRetriever when the world corpus is built."""
    def retrieve(self, prompt: str, k: int = 5) -> SecondaryResult:
        return SecondaryResult(chunks=[], full_texts={}, book_by_id={}, answerable=False)
```

**Where it plugs into `RagService`:**

```python
class RagService:
    def __init__(
        self, retriever=None, *, reranker=None, dsn=None,
        model=DEFAULT_MODEL, llm_client=None,
        secondary_retriever=None,    # NEW: injected; defaults to stub
    ):
        self.retriever = retriever or RagRetriever(dsn)
        self.reranker = reranker
        self.model = model
        self.llm_client = llm_client
        self.secondary = secondary_retriever or StubSecondaryRetriever()

    def _merge_results(self, primary: RetrievalResult, secondary: SecondaryResult) -> RetrievalResult:
        """Merge primary + secondary chunks; primary book chunks take precedence.
        Deduplication by chunk_id. Stub returns primary unchanged."""
        if not secondary.chunks:
            return primary
        # Merge: primary chunks first (ranked higher), secondary appended
        merged_chunks = primary.chunks + [c for c in secondary.chunks
                                          if c.chunk_id not in {x.chunk_id for x in primary.chunks}]
        merged_texts = {**secondary.full_texts, **primary.full_texts}   # primary wins on collision
        merged_books = {**secondary.book_by_id, **primary.book_by_id}
        return RetrievalResult(
            chunks=merged_chunks,
            full_texts=merged_texts,
            top1_distance=primary.top1_distance,
            answerable=primary.answerable or secondary.answerable,
            book_by_id=merged_books,
            matched_classes=primary.matched_classes,
            matched_entities=primary.matched_entities,
            matched_content_types=primary.matched_content_types,
        )

    def answer(self, prompt: str, mode: str = "sage") -> ChatResponse:
        result = self.retriever.retrieve(prompt, reranker=self.reranker, mode=mode)

        # Second-source merge (GM mode only; stub is a no-op)
        if mode == "gm":
            secondary = self.secondary.retrieve(prompt)
            result = self._merge_results(result, secondary)

        # Gate + generate (as above) ...
```

**Key design properties:**
- The stub costs zero: `StubSecondaryRetriever.retrieve()` returns empty immediately.
- Production replacement is a drop-in: implement `SecondaryRetriever` protocol, pass
  to `RagService(secondary_retriever=MyWorldRetriever(...))`.
- Merge order (primary first) ensures book citations appear before world citations.
- `_merge_results` is testable independently with mock data.

### Test plan (pytest)

**Extend `service/test_service.py` (pure, mocked retriever + LLM):**

```python
# 1. Persona selection
def test_sage_mode_uses_sage_persona():
    """generate_answer() called with mode='sage' sends the Sage system prompt."""
    # Intercept messages list passed to LLM
    ...assert 'rules assistant' in messages[0]['content']...

def test_gm_mode_uses_gm_persona():
    ...assert 'GM Oracle' in messages[0]['content']...

def test_spell_mode_uses_spell_persona():
    ...assert 'Spell Archivist' in messages[0]['content']...

# 2. Scoped retrieval — verify _scope_for_mode() returns expected ctypes/books
def test_spell_scope_forces_spell_ctype():
    ctypes, books = _scope_for_mode("spell", set())
    assert "spell" in ctypes
    assert "monster" not in ctypes
    assert "dmg-5e" not in books

def test_rules_scope_excludes_monster_ctype():
    ctypes, books = _scope_for_mode("rules", {"monster"})
    assert "monster" not in ctypes

def test_gm_scope_includes_dm_guidance():
    ctypes, books = _scope_for_mode("gm", set())
    assert "dm_guidance" in ctypes or books is None  # no book restriction

# 3. GM gate relaxation
def test_gm_mode_answers_even_when_not_answerable():
    """GM mode skips the koz gate when chunks are present."""
    result = _result(answerable=False)   # existing _result() helper, top1=0.70
    svc = RagService(
        retriever=_FakeRetriever(result),
        llm_client=_FakeLLM("Here is a creative monster idea [1].")
    )
    resp = svc.answer("Invent a swamp monster", mode="gm")
    assert resp.answer != REFUSAL          # NOT refused
    assert resp.answerable is False        # echoes the low confidence to client

def test_sage_mode_refuses_when_not_answerable():
    result = _result(answerable=False)
    svc = RagService(retriever=_FakeRetriever(result), llm_client=_FakeLLM("x"))
    resp = svc.answer("Invent a swamp monster", mode="sage")
    assert resp.answer == REFUSAL

def test_gm_mode_refuses_when_no_chunks():
    """Even GM mode refuses if the retriever returns no chunks."""
    empty = RetrievalResult(chunks=[], full_texts={}, top1_distance=None,
                            answerable=False, book_by_id={})
    svc = RagService(retriever=_FakeRetriever(empty), llm_client=_FakeLLM("x"))
    resp = svc.answer("Xyz", mode="gm")
    assert resp.answer == REFUSAL

# 4. Second-source seam
def test_stub_secondary_is_noop():
    stub = StubSecondaryRetriever()
    r = stub.retrieve("anything")
    assert r.chunks == []

def test_merge_results_with_empty_secondary():
    primary = _result(answerable=True)
    secondary = StubSecondaryRetriever().retrieve("x")
    svc = RagService(retriever=_FakeRetriever(primary), llm_client=_FakeLLM("ans"))
    # Confirm merge doesn't corrupt primary
    result = svc._merge_results(primary, secondary)
    assert result.chunks == primary.chunks

# 5. API contract
def test_chat_with_mode_spell():
    """Endpoint accepts mode='spell', returns valid ChatResponse."""
    c = _client(_GROUNDED)
    r = c.post("/chat", json={"prompt": "What is Fireball?", "mode": "spell"})
    assert r.status_code == 200

def test_chat_default_mode_sage():
    """Omitting mode defaults to sage — backward compat."""
    c = _client(_GROUNDED)
    r = c.post("/chat", json={"prompt": "What is a Basilisk?"})
    assert r.status_code == 200
    assert r.json().get("mode") == "sage"   # echoed

def test_chat_invalid_mode_422():
    c = _client(_GROUNDED)
    r = c.post("/chat", json={"prompt": "x", "mode": "invalid"})
    assert r.status_code == 422

def test_conversation_id_carried_through():
    """conversation_id is accepted and echoed (or silently ignored) — no 422."""
    c = _client(_GROUNDED)
    r = c.post("/chat", json={"prompt": "x", "conversation_id": "abc123"})
    assert r.status_code == 200
```

**Extend `service/test_app.py`:**
- `test_response_schema()` needs updating: `set(body.keys())` will now include `"mode"`;
  update assertion to `{"answer", "sources", "answerable", "mode"}`.
- Add: `test_chat_with_all_modes()` — POST with each mode value, assert 200.

---

## Risks / Friction

1. **`_scope_for_mode` for `spell` mode: content_type override vs. query-derived merge**
   The current `extract_query_content_types()` may produce `{"class_feature"}` for a
   query like "What is Fireball for a Sorcerer?" — if we force `{"spell"}` only, the
   class_feature filter is dropped. This is correct behavior for Spell mode (we want
   spells, not class descriptions), but needs explicit documentation. For Rules mode,
   be careful that forcing the allowlist does not under-restrict; safest is to compute
   the union of forced + query-derived ctypes then drop content_types not in the
   rules allowlist.

2. **`RagRetriever.retrieve()` signature change + backward compat**
   Adding `mode` to `retrieve()` must not break the eval harness `eval_golden.py`
   which imports `RagRetriever` directly and calls `retriever.retrieve(prompt)`.
   Use a default of `mode="sage"` (existing behavior for all existing callers).
   No change needed in `eval_golden.py`.

3. **`generate_answer()` signature change breaks existing `test_service.py`**
   `test_generate_answer_uses_injected_client()` calls `generate_answer("Q?", "ctx", client=...)`.
   The `mode` parameter defaults to `"sage"` so no breakage, but the test should be
   extended to verify the system message is present.

4. **Hybrid search (`dnd.hybrid_search()`) does not accept `book_slug` filter**
   The function in `03-hybrid-search.sql` has no `book_slug` WHERE clause. Since hybrid
   mode is not currently adopted at runtime (ARCHITECTURE.md notes it ties pure vector),
   this is a non-issue for v1. If hybrid is ever adopted, the SQL function needs a
   `p_books text[] DEFAULT NULL` parameter.

5. **`book_slugs` filter in `build_vector_sql` + `retrieve_top_k`**
   Currently `_VECTOR_SQL` (the unfiltered base query) is used when there are no
   entity/class/ctype filters. Adding `book_slugs` means the unfiltered path must now
   produce filtered-by-book results. The easiest fix: always use `build_vector_sql` and
   only fall through to `_VECTOR_SQL` when all filter sets are empty including books.

6. **GM gate relaxation and distance semantics**
   When GM mode proceeds despite `top1_distance > 0.50`, the chunks may be weakly
   related. The GM persona prompt must clearly instruct the model to draw on the chunks
   as inspiration rather than as authoritative sources. Monitor answer quality for GM
   mode separately.

7. **`conversation_id` is carry-through only**
   The field is accepted and stored in `ChatRequest` but not persisted or used by
   `RagService`. Session continuity (conversation history injected into the prompt) is
   a separate feature. Do not attempt to thread it to `generate_answer()` yet —
   explicitly `Field(..., description="carried through; persistence is stubbed")`.

8. **`dmg-5e` not in `ingest_books.py` BOOKS dict**
   `ingest_books.py:36-47` lists 10 books but **omits `mm-5e` and `dmg-5e`** — they
   were ingested separately before `ingest_books.py` existed (per the corpus-expansion
   eval report). The GM mode book mapping needs to include these two; they are confirmed
   in the corpus by chunk JSONL files (`chunks-mm-5e.jsonl`, `chunks-dmg-5e.jsonl`).
   No action needed for retrieval, but documentation should reflect all 12 slugs.

---

## Open Questions for the User (only what code cannot answer)

1. **Spell mode scope: include supplement spells from `eberron-5e`, `ravnica-5e`, `tortle-5e`?**
   These books contain `race_feature` / `rule` content but also some spell-adjacent
   content. The book classification above treats them as spell-eligible (they're in the
   allowed set), but the user may want Spell mode to cover only PHB + XGE + TCE + EEPC.
   Decision needed before implementing `_scope_for_mode`.

2. **GM mode: what is the minimum chunk count before proceeding with creative generation?**
   Currently the proposal is "any chunk = proceed." Should there be a floor (e.g. at
   least 2 chunks)? Or should the gate be purely on whether the distance is below a
   softer threshold (e.g. 0.65 instead of 0.50) rather than completely removed?

3. **`answerable` field semantics in GM mode responses:**
   `answerable=False` currently means "out of corpus, refused." In GM mode it would
   mean "answered creatively from weak corpus match." Should this be communicated via
   a distinct field (e.g. `creative: bool`) rather than re-using `answerable`? This is
   a UI/UX decision more than a backend one, but it affects the response model.

4. **`conversationId` persistence scope:**
   Should the carry-through `conversation_id` field be echoed in `ChatResponse`?
   The UI would need it to correlate turns for future history injection.

5. **GM second-source corpus: what is the storage backend?**
   The stub designs against a `Protocol` interface. Before building the real
   `SecondaryRetriever`, the user needs to decide: same pgvector DB (new `dnd_world`
   schema), separate vector DB, or a lightweight in-process store (chroma, lancedb).
   This decision affects the interface's `__init__` signature.
