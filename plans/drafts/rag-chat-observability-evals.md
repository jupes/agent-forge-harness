# Plan (DRAFT): rag-chat-observability-evals — Observability + agent-eval layer

Generated: 2026-06-26 · **Re-sequenced: 2026-06-29 (LangGraph adopted as foundation)**
Repo: rag-chat (`repos/rag-chat`)
Phase: plan (2/4) — **draft / not committed.** Major deferred initiative; this sequences the work
into independently-shippable phases so we can start small and stop anywhere.
Research: `plans/research/rag-chat-observability-evals.md` (see its **Decision Update (2026-06-29)**).
Beads: epic agent-forge-harness-ziw. Existing child IDs are **kept** (not renumbered) and re-scoped
(see "Beads re-sequencing" below): ziw.1 (stack spike) → **ziw.2 = LangGraph migration, foundational**
(folds in 3t2) → ziw.3 (answer evals) → ziw.4 (comparison + CI) → ziw.5 (dashboard).

## What changed (2026-06-29)

The team decided to **migrate rag-chat off the raw OpenAI SDK to LangGraph** (+ `langchain-openai`
`ChatOpenAI` for the LLM node). That makes the migration the **foundation** of this epic rather than
an optional sibling:

- The old **"Phase 1 — observability layer on the raw SDK"** is replaced by **"migrate to LangGraph,
  and get node-level tracing as part of it"** (via the chosen backend's LangChain/LangGraph callback
  handler, not a raw-SDK wrapper).
- Bead **`agent-forge-harness-3t2`** (LangGraph migration) is **folded in as the foundational phase**,
  no longer a non-blocking sibling.
- Everything downstream (Ragas evals, promptfoo comparison, dashboard) is unchanged in intent and now
  rides on the graph.

## Strategy

Build in dependency order — **stack decision → LangGraph migration (+ native tracing) → answer evals
→ comparison/CI → dashboard** — because each layer feeds the next (no graph/traces → nothing to
score; no scores → nothing to compare/show). Reuse the existing golden retrieval eval
(`ingestion/eval_golden.py`) as the parity gate *and* the eval seed. Default to OSS/self-host.
Recommended stack (confirm in Phase 0): **Langfuse** (tracing + dashboard) · **Ragas** (RAG answer
quality) · **promptfoo** (version/model A/B + CI gate). Phoenix is the documented Apache-2
alternative. Each phase is demo-able and shippable on its own; we can pause after any phase.

## Phase 0 — Decide the stack (spike, ~½ day) · bead ziw.0

**Goal:** lock the three tool choices before writing integration code — now evaluated through the
**LangGraph callback integration**, not the OpenAI wrapper.
- Stand up Langfuse self-host (docker-compose) **and** Phoenix locally; run a handful of real `/chat`
  calls through a **minimal LangGraph spike** wired to each backend's callback handler (Langfuse
  `CallbackHandler` / OpenInference `LangChainInstrumentor`); compare: setup cost, **node-level**
  span quality, version/model tagging, dashboard, footprint.
- Decide Langfuse vs Phoenix as the primary backend; confirm Ragas + promptfoo as eval tools.
- Decide self-host vs free cloud tier; decide trace retention + PII posture.
**Demo:** a few real traces visible in the chosen backend's UI, showing **per-node** spans tagged
with model + git SHA.
**AC:** backend chosen with written rationale; docker-compose (or run docs) committed; retention/PII
note recorded; node-level traces from a LangGraph spike visible in the chosen backend.

## Phase 1 — LangGraph migration + native tracing (the foundation) · bead ziw.1 (folds in 3t2)

**Goal:** re-implement `RagService.answer`'s pipeline as a **LangGraph graph** with behavior parity,
and get **node-level tracing for free** from the migration. No behavior change to the app.
- **Model the existing seams as nodes:** `retrieve` → optional `gm_merge` → `grounding_gate` →
  `generate` → `cite`, matching `service/rag.py:100-154` exactly (same mode handling, same refusal
  paths, same gate thresholds). Graph state carries `prompt`, `mode`, `RetrievalResult`, `context`,
  `answer`, `sources`, `answerable`.
- **LLM node uses `langchain-openai` `ChatOpenAI`** (replacing the raw `client.chat.completions.create`
  in `generate_answer`), preserving the per-mode system prompts, model, and `TEMPERATURE` from
  `config.py`. **Keep an injectable seam** (inject a fake chat model in tests) so existing
  `service/test_service.py` style DI still works.
- **Wire the chosen backend's callback handler** at graph invocation so retrieve/gate/rerank/generate
  emit **node-level spans** with latency, and the LLM node emits tokens + cost. Tag traces with
  `model`, `service_version` (git SHA), `mode`. Capture sources + answerable flag (mirror
  `ui/src/exportChat.ts` payload shape).
- **Add deps** to `pyproject.toml`: `langgraph`, `langchain-core`, `langchain-openai` (keep `openai`
  — still used for embeddings in `ingestion/retrieval.py` and transitively by `langchain-openai`).
  Update `test_packaging.py` if the import surface changes.
- Replace remaining `print()` with structured logging; config via env, off-by-default in tests.
**Parity gate (must pass before close):** `ingestion/eval_golden.py` retrieval metrics unchanged
(Hit@1 ≈ 83.3%, Recall@10 ≈ 94.3%); all existing tests green; `/chat` responses byte-equivalent for a
fixed seed/prompt set (same prompts/model/temperature → same answers).
**Demo:** make 5 chat queries → open the dashboard → see per-**node** latency, tokens, cost, sources;
run the golden eval → identical metrics to pre-migration.
**AC:** pipeline runs as a LangGraph graph; behavior parity verified vs golden eval + existing tests;
node-level traces present (retrieve/gate/rerank/generate) with latency/tokens/cost, filterable by
model + version; no key/PII leakage into logs.

## Phase 2 — RAG answer-quality eval (extend the golden set) · bead ziw.2

**Goal:** add **generation-quality** metrics on top of the existing retrieval metrics.
- Extend `ingestion/eval_golden.py` (or a sibling `ingestion/eval_answers.py`) to run the golden
  queries end-to-end through the **graph** and score with **Ragas**: faithfulness/groundedness,
  answer relevancy, context precision/recall, answer correctness.
- Add reference answers / expected key-facts for a curated subset (start with 20–50, per Anthropic).
- Give LLM-judge metrics an "Unknown" escape hatch; record `pass@k`/`pass^k` for a sampled subset.
- Write eval scores back to the Phase-1 traces (Langfuse/Phoenix scores) so quality + telemetry
  co-locate (LangGraph run id → score).
**Demo:** run the eval → table of retrieval + answer-quality metrics for the current version/model.
**AC:** answer-quality metrics computed over the golden subset; scores attached to traces; eval runs
via a documented one-liner; token cost of a run recorded.

## Phase 3 — Version/model comparison + CI gate (the actual goal) · bead ziw.3

**Goal:** answer "is version/model B better than A?" reproducibly, and stop regressions in CI.
- Encode golden cases as a **promptfoo** config; matrix over `{service_version} × {model}` with
  assertions (exact-match where deterministic; LLM-rubric for groundedness/coverage). The provider
  target is the graph endpoint, so version = git SHA of the graph.
- Produce an A/B comparison report (promptfoo viewer) and a regression gate: fail CI if a chosen
  metric drops beyond a threshold vs. the baseline.
- Wire a PR-gated subset (fast/cheap) + an optional nightly full run (cost guardrail).
**Demo:** run two models (or two versions) through the same suite → side-by-side scorecard + a
deliberately-worse run failing the gate.
**AC:** comparison report across ≥2 models and ≥2 versions; CI gate fails on injected regression;
cost per gate run bounded and documented.

## Phase 4 — Dashboard · bead ziw.4

**Goal:** quality + telemetry trends visible over time and between versions.
- v1: use the chosen backend's **built-in dashboard** (Langfuse/Phoenix) with saved
  version/model-filtered views — now showing **node-level** graph spans. Lowest effort.
- Optional v2 (separate decision): surface a curated metric summary into the harness GitHub Pages
  dashboard (`docs/`, `vite.dashboard.config.ts`) co-located with other harness dashboards.
**Demo:** a dashboard view trending answer-quality + latency/cost by version and model.
**AC:** a shareable view shows quality + cost trends filterable by version + model; documented how to
read it for an A/B decision.

## Beads re-sequencing (apply in the plan phase)

Current children of `agent-forge-harness-ziw`: ziw.1 (Phase 0 spike), ziw.2 (Phase 1 observability),
ziw.3 (Phase 2 evals), ziw.4 (Phase 3 comparison), ziw.5 (Phase 4 dashboard). New mapping:

| New phase | Bead action |
|---|---|
| P0 stack spike | Keep **ziw.1** as the spike, but re-title to note it now validates **LangGraph callback** instrumentation (not the OpenAI wrapper). |
| P1 LangGraph migration + tracing (**foundation**) | Re-scope **ziw.2** from "observability on raw SDK" to "LangGraph migration + node-level tracing"; **fold in `agent-forge-harness-3t2`** (mark 3t2 superseded-by/duplicate-of ziw.2, or add `dep: ziw.2 → 3t2` and close 3t2 into it). Migration parity gate is the close criterion. |
| P2 answer evals | **ziw.3** unchanged (runs through the graph). |
| P3 comparison + CI | **ziw.4** unchanged. |
| P4 dashboard | **ziw.5** unchanged. |

Dependency chain stays linear: P0 → P1 → P2 → P3 → P4. Update each child's description/AC to reference
the LangGraph foundation. Record the strategy change as a `design:` comment on the epic.

## Risks / Guardrails

- **Migration regressions** — the rewrite must hold parity; the golden eval + byte-equivalence check
  is the gate. Migrate behavior-first (no prompt/model/temperature changes in the same phase).
- **Dependency weight** — `langgraph` + `langchain-*` are heavy; pin versions, keep the LLM node thin,
  and confirm Docker image size impact (Dockerfile.service `pip install .`).
- **Lost test seam** — preserve the injectable-client pattern (inject a fake `ChatOpenAI`) so
  `service/test_service.py`-style DI keeps working; don't make tests hit the network.
- **Eval token cost** — LLM-judge metrics burn API spend; cap golden subset + cadence (PR subset vs
  nightly full).
- **Self-host footprint** — Langfuse adds services to docker-compose; confirm acceptable in Phase 0.
- **PII/retention** — traces store prompts + answers; define retention before persistent logging.
- **Eval saturation** — if metrics hit ceiling, refresh with harder cases (per Anthropic).
