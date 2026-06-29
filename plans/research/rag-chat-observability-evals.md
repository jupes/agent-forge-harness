# Research: rag-chat-observability-evals — Observability + agent-eval layer

Generated: 2026-06-26
Repo: rag-chat (`repos/rag-chat`)
Phase: research (1/4) — **initial options survey** (deliberately not yet a committed design)
Beads: epic agent-forge-harness-ziw (phases ziw.1–ziw.5) + **now-foundational** agent-forge-harness-3t2 (LangGraph migration — see Decision Update)
Constraint: **prefer free / open-source** wherever possible.

## Decision Update (2026-06-29) — LangGraph adopted; migration is now foundational

> **Supersedes the "observability does NOT depend on LangGraph" framing below.** The team has
> decided to **migrate rag-chat off the raw OpenAI SDK to LangGraph** (with `langchain-openai`'s
> `ChatOpenAI` for the LLM node). This is now a **product decision, not an optional ROI call**, so
> the relationships in this epic change:
>
> - **`agent-forge-harness-3t2` (LangGraph migration) becomes the foundational first phase of the
>   epic**, not a non-blocking sibling. Everything else builds on the graph.
> - **Observability arrives *with* the migration.** Instead of a drop-in raw-SDK wrapper
>   (`from langfuse.openai import OpenAI`), tracing comes from the chosen backend's **LangChain /
>   LangGraph callback handler** — Langfuse `CallbackHandler` or OpenInference `LangChainInstrumentor`
>   — which captures **node-level** spans (retrieve / gate / rerank / generate) natively.
> - The **Phase 0 stack spike still stands** (Langfuse vs Phoenix) but is now evaluated through the
>   **LangGraph callback integration**, not the OpenAI wrapper.
> - **Why this is a clean migration here:** the current pipeline is already a linear sequence of pure,
>   well-seamed steps (`RagService.answer`: retrieve → optional gm-merge → grounding gate → generate →
>   cite, `service/rag.py:100-154`), and `generate_answer` already takes an **injectable client**
>   (`service/generate.py`) — those seams map almost 1:1 onto LangGraph nodes, and the injectable seam
>   is preserved for tests.
> - **Parity bar:** the migration must hold behavior parity against the existing golden eval
>   (`ingestion/eval_golden.py`: Hit@1 ≈ 83.3%, Recall@10 ≈ 94.3%) and keep generation identical
>   (same per-mode prompts, model, temperature) — it's an orchestration refactor, not a behavior
>   change.
> - **New deps:** `langgraph`, `langchain-core`, `langchain-openai` added to `pyproject.toml`
>   (currently `fastapi, uvicorn, openai, psycopg, pydantic`). `openai` stays (transitive via
>   `langchain-openai`; embeddings still call it directly in `ingestion/retrieval.py`).
> - `repos/NeMo-Flow` (`knowledge/repos/NeMo-Flow.yaml`) is the reference for langgraph + OTel /
>   OpenInference exporters.
>
> The committed phase design in `plans/drafts/rag-chat-observability-evals.md` is re-sequenced to
> match. The OSS survey + Anthropic-eval principles below remain valid as reference.

## Goal

Establish a repeatable, low-cost way to answer one question: **"Is version/model B better than
version/model A for this RAG app?"** — across both the *service* (retrieval + prompt + pipeline
changes) and the *model* (e.g. `gpt-4o-mini` → another model). That requires three layers, built in
order:

1. **Observability** — capture what actually happens per request (retrieval hits, latency, tokens,
   cost, the generated answer) so we have data to evaluate and to debug regressions.
2. **Agent evals** — score answer/retrieval quality against curated test cases, comparably across
   versions and models, ideally gating in CI.
3. **Dashboard** — surface the trend/comparison so quality is visible over time and between versions.

This is a **major, deferred** initiative. This doc surveys OSS options and recommends a lean
starting stack; the committed phase design lives in `plans/drafts/rag-chat-observability-evals.md`.

## Concepts in Plain Terms (read this first)

If you're new to the tooling, here's what each thing actually *is* and how the pieces relate.

- **Observability / tracing** — recording what the app does on every LLM call: the prompt, the
  answer, how long it took, how many tokens, the cost, and which model. Today rag-chat captures
  **none** of this (only stray `print()`s). A tracing tool gives you a searchable, filterable web UI
  over that data so you can debug regressions and compare runs.
- **Langfuse** — an **open-source (MIT)** LLM-observability tool you self-host with Docker. Beyond raw
  traces it adds **version/model tags**, **scores** (eval results attach to each trace), datasets,
  prompt management, and a **built-in dashboard** for trends over time. Instruments rag-chat's
  *existing* OpenAI calls via a drop-in wrapper (`from langfuse.openai import OpenAI`) — near-zero
  code change. Best fit for the actual goal (compare versions/models + dashboard). Also offers a
  capped **free cloud tier** if we don't want to self-host.
- **Arize Phoenix** — an **open-source (Apache-2 / Elastic)** tool that does observability **plus
  built-in RAG evaluators** (relevance, hallucination/groundedness, Q&A correctness) in one package.
  Auto-instruments via OpenInference; runs locally (`phoenix serve`); notebook-friendly. Great if you
  want tracing + RAG eval in a single tool; less polished than Langfuse for long-running production
  version tracking.
- **Phase 0 (ziw.1) is the choice between these two** — stand both up, push a few real `/chat` calls
  through each, compare setup cost / tagging / dashboard / footprint, and pick one as the primary
  backend for everything after.
- **Other observability options** (surveyed, not recommended for v1): **OpenTelemetry + OpenLLMetry**
  (vendor-neutral spans → any backend; most plumbing, no LLM-specific UI), **NeMo-Flow** (local repo;
  only worth it if we also migrate to LangGraph), **LangSmith** / **Braintrust** (commercial, free
  tiers, **not OSS** → deprioritized per the free/OSS constraint).
- **Evals** — scoring answer/retrieval *quality* against curated test cases. **Ragas** (Apache-2)
  computes RAG **generation** metrics (faithfulness, answer-correctness, etc.) — the gap our existing
  retrieval-only `eval_golden.py` leaves. **promptfoo** (MIT) runs **A/B comparisons across versions
  and models** and gates CI on regressions — this is the most direct answer to "is B better than A?".
- **Relationship to LangGraph (bead `agent-forge-harness-3t2`, later)** — **independent.** rag-chat
  today is a linear pipeline on the **raw OpenAI SDK** (no agent framework). Langfuse/Phoenix
  instrument that raw SDK directly, so observability does **not** require LangGraph. Migrating to
  LangGraph would add native *node-level* tracing and agentic flexibility, but it's optional ROI —
  filed as a **non-blocking sibling** and deliberately kept off this critical path.
- **Is it free?** The recommended stack is **fully free / OSS, self-hosted**: Langfuse (MIT),
  Phoenix (Apache-2), Ragas (Apache-2), promptfoo (MIT), OpenTelemetry/OpenLLMetry (OSS). The **one
  real running cost** is **API tokens** when LLM-judge evals execute (Ragas/promptfoo rubrics call an
  LLM to grade answers) — bounded via golden-subset size + cadence (PR subset vs nightly full).
  See the cost/license summary table below.

### Cost / license summary

| Tool | Role | License | Cost to run |
|---|---|---|---|
| **Langfuse** (self-host) | tracing + dashboard | OSS (MIT core) | Free; Docker services (Postgres + ClickHouse). Capped free cloud tier exists. |
| **Arize Phoenix** | tracing + built-in RAG evals | OSS (Apache-2 / ELv2) | Free; runs locally. |
| **Ragas** | RAG answer-quality metrics | OSS (Apache-2) | Free lib; **API tokens** when LLM-judge metrics run. |
| **promptfoo** | version/model A/B + CI gate | OSS (MIT) | Free lib; **API tokens** for LLM-rubric assertions. |
| OpenTelemetry + OpenLLMetry | vendor-neutral tracing | OSS | Free; needs a backend (Tempo/Jaeger) + plumbing. |
| LangSmith | tracing + evals | **Commercial** | Free tier (capped); not OSS → deprioritized. |
| Braintrust | tracing + evals | **Commercial** | Free tier (capped); not OSS → deprioritized. |

## What the Code Says Today (from exploration)

The app is **not** an agent — it is a linear RAG pipeline using the **raw OpenAI Python SDK**, with
**no runtime observability** at all.

- **Service:** FastAPI, `POST /chat` → `service/app.py:54`. Orchestrator `RagService.answer()` at
  `service/rag.py:100-135`. Flow: retrieve → (GM secondary merge) → answerability gate → grounded
  generate → cite.
- **LLM:** OpenAI SDK, `gpt-4o-mini` (`service/generate.py:22`), `client.chat.completions.create()`
  at `service/generate.py:114-121`, temperature 0.2 hardcoded.
- **Embeddings:** OpenAI `text-embedding-3-small` (`ingestion/retrieval.py:46`).
- **Retrieval:** pgvector HNSW kNN, mode-scoped filters (`ingestion/scope.py`), fallback on
  distance > 0.42, answerability gate at distance ≤ 0.50; optional cross-encoder rerank
  (`cross-encoder/ms-marco-MiniLM-L-6-v2`, `ingestion/rerank.py`).
- **Observability today: effectively none.** Only `print()` calls (`service/app.py:34`,
  `ingestion/retrieval.py:53`). **No** logging framework, request IDs, latency timers, token/cost
  capture, tracing, or metrics. Confirmed absent: OpenTelemetry, Langfuse, Phoenix, Prometheus.
- **What already exists (reuse this):** `ingestion/eval_golden.py` — offline **retrieval-only**
  golden eval over a 160-query set: Precision@5, Hit@1, MRR, Recall@10, stratified by category
  (reports Hit@1 ≈ 83.3%, Recall@10 ≈ 94.3%). It does **not** measure *generation* quality
  (faithfulness, answer correctness). This is the seed of the eval layer, not a throwaway.
- **UI:** React 19 + Vite. `ui/src/exportChat.ts` already serializes a conversation to JSON
  (prompt/answer/answerable/sources) — a client-side precedent for the data shape we'd log
  server-side. No dashboard surface today.
- **Config:** `OPENAI_API_KEY`, `DATABASE_URL`; pgvector via docker-compose; service on :8000.

### Key implication ⚠️ SUPERSEDED — see "Decision Update (2026-06-29)" above

*(Historical framing, kept for context.)* Observability does **not** technically *require* the
LangGraph migration — Langfuse/Phoenix can instrument the raw OpenAI SDK via a drop-in wrapper, which
is why the two were originally decoupled. **That decoupling no longer drives the plan:** the team has
chosen to adopt LangGraph regardless, so the migration is now the epic's foundation and tracing is
done via LangGraph callback instrumentation rather than the raw-SDK wrapper.

## Anthropic "Demystifying Evals for AI Agents" — principles applied here

(Source: anthropic.com/engineering/demystifying-evals-for-ai-agents)

- **Start with what you already test manually.** We already have `eval_golden.py` + a curated query
  set — convert/extend those into the eval suite rather than waiting for perfect infra.
- **Three grader types:** code-based (string/regex/exact-match), model-based (LLM-rubric, pairwise,
  multi-judge), human (SME spot-check). Prefer deterministic graders where possible; give LLM judges
  an "Unknown" escape hatch and **calibrate against human judgment regularly**.
- **Grade the output, not the path.** Score the answer, not the internal trajectory — keeps evals
  robust to pipeline refactors.
- **Non-determinism metrics:** `pass@k` (≥1 of k correct) and `pass^k` (all k succeed) capture
  reliability; a single run hides variance.
- **RAG-specific checks:** *groundedness* (claims supported by retrieved sources), *coverage* (key
  facts a good answer must include), *source quality* (authoritative sources retrieved, not just
  first). These map cleanly onto Ragas metrics below.
- **Frameworks named:** Langfuse (self-hosted OSS), Arize Phoenix (OSS), LangSmith (commercial),
  Braintrust (commercial), Harbor (containerized eval). "Pick a framework that fits your workflow,
  then invest in high-quality test cases and graders."

## Options Surveyed (free / OSS first)

### A. Observability / tracing backend

| Option | License / cost | Fit for this app | Notes |
|---|---|---|---|
| **Langfuse (self-hosted)** ⭐ | OSS (MIT core), free self-host via Docker | **High** | Drop-in `from langfuse.openai import OpenAI` wraps the *existing* SDK — captures latency, tokens, cost, prompt/response per call. Sessions, **version/model tags**, **scores** (eval results attach to traces), **datasets**, prompt management, **built-in dashboard**. Single best fit for "compare versions/models + a dashboard, OSS." |
| **Arize Phoenix** ⭐ | OSS (Apache-2 / ELv2), free, local (`phoenix serve`) | **High (RAG)** | OpenInference auto-instrumentation; **built-in RAG evals** (relevance, hallucination/groundedness, Q&A correctness); notebook-friendly; local UI. Strong if we want RAG eval + tracing in one OSS tool. Less polished for long-run prod version-tracking than Langfuse. |
| **OpenTelemetry + OpenLLMetry (Traceloop)** | OSS | Medium | Vendor-neutral spans → any OTel backend (Grafana Tempo/Jaeger). Max flexibility, **most plumbing**, no LLM-specific UI out of the box. Good if we standardize on OTel org-wide. |
| **NeMo-Flow** (local repo `repos/NeMo-Flow`) | OSS (NVIDIA), local | Conditional | Rust-core runtime with **built-in OTel / OpenInference / ATIF exporters** for tool+LLM calls and **langchain/langgraph integration extras**. Heavier (Rust core + bindings); CLI marked experimental. **Most attractive only if** we also migrate to LangGraph and want one runtime for execution + observability. Otherwise overkill vs Langfuse. |
| LangSmith | Commercial, free tier (cap) | Medium | Best-in-class if already on LangChain; not OSS → deprioritized per constraint. |
| Braintrust | Commercial, free tier | Medium | Eval + prod observability; not OSS → deprioritized. |

### B. Eval framework (scoring quality)

| Option | License | Fit | Notes |
|---|---|---|---|
| **Ragas** ⭐ | OSS (Apache-2) | **High** | Purpose-built RAG metrics: **faithfulness/groundedness, answer relevancy, context precision, context recall, answer correctness**. Directly fills the gap `eval_golden.py` leaves (it measures retrieval, not generation). Python, integrates with Langfuse + Phoenix. |
| **promptfoo** ⭐ | OSS (MIT) | **High (the comparison goal)** | Config-driven eval + **A/B across prompts, models, providers**; assertions incl. LLM-rubric, `context-faithfulness`, `context-recall`; **CI integration** + local results viewer. This is the most direct answer to "determine quality between app versions and the model used." |
| DeepEval | OSS | Medium-High | Pytest-style LLM eval, RAG metrics, CI-friendly. Alternative/overlap with Ragas+promptfoo. |
| Phoenix evals | OSS | Medium-High | Built-in if we choose Phoenix as the backend; avoids a second tool. |
| Harbor | OSS | Low (now) | Containerized agent eval w/ cloud scale — relevant later if evals become agentic/heavy. |

### C. Dashboard

- **Lowest effort:** use **Langfuse's** (or **Phoenix's**) built-in self-hosted dashboard — traces,
  scores, version/model filters come free. Recommended for v1.
- **promptfoo** ships a local eval-comparison viewer for the A/B results specifically.
- **Bespoke option:** surface eval metrics into the **harness's existing GitHub Pages dashboard**
  (`docs/`, `vite.dashboard.config.ts`) — more work, more control, only if we want it co-located with
  other harness dashboards. Defer unless needed.

## Recommended Lean Starting Stack (initial — to be confirmed in plan)

1. **Tracing/observability → Langfuse (self-hosted).** Drop-in OpenAI wrapper instruments the
   current pipeline with near-zero code; tag each trace with `service_version` (git SHA) + `model`.
   Gives latency/token/cost + a dashboard immediately. (Phoenix is the strong Apache-2 alternative
   if MIT/self-host posture or RAG-eval-in-one-tool is preferred.)
2. **RAG answer-quality eval → Ragas**, layered on the existing `eval_golden.py` golden set
   (extend it from retrieval-only to add faithfulness / answer-correctness). Write eval scores back
   to Langfuse traces as scores.
3. **Version/model comparison + CI gate → promptfoo.** Encode the golden cases as a promptfoo
   config; run A/B across `{service version} × {model}`; fail CI on regression beyond a threshold.
4. **Dashboard → Langfuse built-in** for v1; revisit a bespoke harness-dashboard surface later.

### Why this order
Observability is the prerequisite (no data → no evals). Evals reuse the existing golden set (cheap
start, per Anthropic guidance). Comparison/CI is where the user's actual goal ("quality between
versions and models") is realized. Dashboard rides on tooling we already stood up.

## Open Questions for the Plan Phase

1. **Langfuse vs Phoenix** as primary backend — pick one for v1 (recommend Langfuse for
   version/model tracking + dashboard; Phoenix if Apache-2 + one-tool RAG eval matters more).
2. **Self-host footprint** — Langfuse self-host adds Postgres + clickhouse-ish services to
   docker-compose; confirm acceptable local/infra cost vs. its (capped) free cloud tier.
3. **Cost guardrails** — running LLM-judge evals (Ragas/promptfoo rubrics) burns API tokens; cap
   eval-set size + cadence (PR-gated subset vs. nightly full set).
4. **The "Agent SDK → LangGraph/LangChain" question is OUT of this critical path** — filed as a
   separate, non-blocking bead. Decide independently whether the observability win it adds
   (native node-level tracing) justifies the migration, since Langfuse already instruments the raw
   SDK without it.
5. **PII / data retention** — traces will store user prompts + answers; define retention before
   enabling persistent logging.

## Reuse Inventory (don't rebuild)

- `ingestion/eval_golden.py` — golden query set + retrieval metrics → seed for the eval suite.
- `ui/src/exportChat.ts` `buildExportPayload()` — canonical per-exchange data shape.
- `docker-compose.yml` — extend with the observability backend service.
- `repos/NeMo-Flow` (local) + `knowledge/repos/NeMo-Flow.yaml` — reference for OTel/OpenInference
  exporters and langgraph integration if the migration bead proceeds.
- Harness `docs/` dashboard + `vite.dashboard.config.ts` — candidate host for a bespoke surface.
