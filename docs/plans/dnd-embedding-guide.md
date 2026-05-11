# D&D RAG Embedding Model Guide

> **Status**: Living document — update when a new model is tested or context limits change
> **Last updated**: 2026-05-10
> **Scope**: Embedding models evaluated for the D&D RAG ingestion pipeline

---

## Decision Summary

| Model | Vendor | Dim | Context | Cost | Status |
|-------|--------|-----|---------|------|--------|
| `mxbai-embed-large` | Ollama (local) | 1024 | ~256 tokens effective | Free | **Rejected** — context too short |
| `nomic-embed-text` | Ollama (local) | 768 | 8192 tokens | Free | **Current** |
| `text-embedding-3-small` | OpenAI API | 1536 | 8192 tokens | $0.02/1M tokens | Next fallback |
| `text-embedding-3-large` | OpenAI API | 3072 | 8192 tokens | $0.13/1M tokens | Fallback if quality insufficient |

Escalation path: **nomic-embed-text → text-embedding-3-small → text-embedding-3-large**

---

## mxbai-embed-large — Rejected

**Advertised**: 512-token context, 1024d output, strong benchmark performance.

**Actual behaviour via Ollama**: The effective context window is far shorter than the 512-token spec.
Chunks of 280 words (~1800 chars) returned `HTTP 400: the input length exceeds the context length`.
Passing `options: {"num_ctx": 8192}` in the embed request has no effect — the limit is baked into
the model weights, not the Ollama runtime config.

**Impact on D&D content**: 109 of 569 chunks exceed 1500 chars. Rule and narrative chunks can run to
3200+ chars (equipment lists, multi-paragraph descriptions). Truncating to fit the context window
would silently drop the second half of long rule descriptions — bad for retrieval.

**Lesson**: Always test against your actual corpus before committing to an embedding model. Advertised
context length ≠ Ollama's effective context length for that model.

---

## nomic-embed-text — Current

**Model**: `nomic-embed-text` via Ollama
**Pull**: `ollama pull nomic-embed-text`
**Dim**: 768
**Context**: 8192 tokens — handles all D&D chunks comfortably
**Cost**: Free (local inference)
**Schema**: `embedding vector(768)` in `dnd.chunks`

### Why chosen over mxbai-embed-large

- 8192-token context fits the entire corpus without truncation
- Specifically designed and benchmarked for RAG / document retrieval
- Recommended in Ollama's official embedding model docs
- Same zero-cost, zero-API-key operational model

### Known limitations

- 768d vs 1024d (mxbai) or 1536d (OpenAI) — lower dimension = marginally less representational
  capacity, but well within acceptable range for semantic search at this scale
- Local CPU inference — slower than a hosted API (~2–4s per batch of 32)
- Requires Ollama running locally; not suitable for a hosted/serverless embed endpoint

---

## text-embedding-3-small — Next fallback

**Model**: `text-embedding-3-small` via OpenAI API
**Dim**: 1536
**Context**: 8192 tokens
**Cost**: $0.02 / 1M tokens
  - Full 569-chunk ingest ≈ 60,000 tokens → **~$0.0012 per full re-ingest**
  - Re-embedding a single book: negligible
**Schema**: `embedding vector(1536)` in `dnd.chunks`

### When to escalate

- nomic-embed-text retrieval quality is unsatisfactory (low precision on eval queries)
- The pipeline needs to run in a hosted/serverless context (no local Ollama available)
- Multiple books are added and local embed throughput becomes a bottleneck

### Setup

```python
# pip install openai
from openai import OpenAI
client = OpenAI()  # reads OPENAI_API_KEY env var

def embed_batch(texts: list[str]) -> list[list[float]]:
    resp = client.embeddings.create(model="text-embedding-3-small", input=texts)
    return [d.embedding for d in resp.data]
```

**Note**: OpenAI SDK handles chunking, retries, and rate limiting automatically.
No manual batch sizing needed.

---

## text-embedding-3-large — Quality escalation

**Model**: `text-embedding-3-large` via OpenAI API
**Dim**: 3072
**Context**: 8192 tokens
**Cost**: $0.13 / 1M tokens (~$0.008 per full re-ingest)
**Schema**: `embedding vector(3072)` in `dnd.chunks`

Escalate only if `text-embedding-3-small` retrieval is insufficient after tuning
retrieval parameters (top-k, score thresholds, hybrid search).

---

## Changing the embedding model

Switching models requires:

1. **Drop and recreate** the embedding column with the new dimension:
   ```sql
   ALTER TABLE dnd.chunks DROP COLUMN embedding;
   ALTER TABLE dnd.chunks ADD COLUMN embedding vector(<new_dim>) NOT NULL;
   DROP INDEX IF EXISTS dnd_chunks_embedding_hnsw_idx;
   CREATE INDEX dnd_chunks_embedding_hnsw_idx ON dnd.chunks
     USING hnsw (embedding vector_cosine_ops);
   ```
2. **Re-run** `ingestion/embed.py` with `--model <new-model>` (or update the default)
3. **Update** the `EMBED_MODEL` env var and this document

The `ON CONFLICT DO UPDATE` upsert in `embed.py` means re-running is always safe — it overwrites
existing embeddings idempotently.

---

## Evaluation approach

Before escalating models, run the golden query set in `ingestion/eval.py` (TBD) and compare:

- **Precision@5** — are the top 5 results all relevant?
- **Recall** — are known-good chunks appearing in the top 10?
- **MRR** (Mean Reciprocal Rank) — how high does the first correct result appear?

Rough bar: Precision@5 > 0.7 on the spell/condition query set is acceptable for v1.
