# Plan (DRAFT): rag-chat-observability-evals — Observability + agent-eval layer

Generated: 2026-06-26
Repo: rag-chat (`repos/rag-chat`)
Phase: plan (2/4) — **draft / not committed.** Major deferred initiative; this sequences the work
into independently-shippable phases so we can start small and stop anywhere.
Research: `plans/research/rag-chat-observability-evals.md`
Beads: epic agent-forge-harness-ziw — phases ziw.1 (Phase 0) → ziw.2 (Phase 1) → ziw.3 (Phase 2) →
ziw.4 (Phase 3) → ziw.5 (Phase 4), chained blocking. Non-blocking sibling: agent-forge-harness-3t2
(LangGraph/LangChain migration).

## Strategy

Build in dependency order — **observability → evals → comparison/CI → dashboard** — because each
layer feeds the next (no traces → nothing to score; no scores → nothing to compare/show). Reuse the
existing golden retrieval eval (`ingestion/eval_golden.py`) as the seed rather than starting cold
(per Anthropic's "start with what you already test manually"). Default to OSS/self-host. Recommended
stack (confirm in Phase 0): **Langfuse** (tracing + dashboard) · **Ragas** (RAG answer quality) ·
**promptfoo** (version/model A/B + CI gate). Phoenix is the documented Apache-2 alternative.

Each phase is demo-able and shippable on its own. We can pause after any phase.

## Phase 0 — Decide the stack (spike, ~½ day)
**Goal:** lock the three tool choices before writing integration code.
- Stand up Langfuse self-host (docker-compose) **and** Phoenix locally; instrument a handful of real
  `/chat` calls through each; compare: setup cost, version/model tagging, dashboard, footprint.
- Decide Langfuse vs Phoenix as the primary backend; confirm Ragas + promptfoo as eval tools.
- Decide self-host vs free cloud tier; decide trace retention + PII posture.
**Demo:** a few real traces visible in the chosen backend's UI, tagged with model + git SHA.
**AC:** backend chosen with written rationale; docker-compose (or run docs) committed; retention/PII
note recorded.

## Phase 1 — Observability layer (the foundation)
**Goal:** every `/chat` request emits a structured trace: retrieval (chunks, distances, mode-scope),
rerank, generation, **latency per stage**, **token count + cost**, model, and `service_version`
(git SHA). No behavior change to the app.
- Add the chosen tracing SDK (recommended: `from langfuse.openai import OpenAI` drop-in in
  `service/generate.py`; instrument retrieval in `service/rag.py` / `ingestion/retrieval.py` as
  spans).
- Tag traces with `model`, `service_version`, `mode`. Capture sources + answerable flag (mirror
  `exportChat.ts` payload shape).
- Add structured logging (replace `print()`); config via env, off-by-default in tests.
**Demo:** make 5 chat queries → open the dashboard → see per-stage latency, tokens, cost, sources.
**AC:** traces present for retrieval + generation with latency/tokens/cost; traces filterable by
model + version; tests still green; no key/PII leakage into logs.

## Phase 2 — RAG answer-quality eval (extend the golden set)
**Goal:** add **generation-quality** metrics on top of the existing retrieval metrics.
- Extend `ingestion/eval_golden.py` (or a sibling `ingestion/eval_answers.py`) to run the golden
  queries end-to-end through `/chat` and score with **Ragas**: faithfulness/groundedness, answer
  relevancy, context precision/recall, answer correctness.
- Add reference answers / expected key-facts for a curated subset (start with 20–50, per Anthropic).
- Give LLM-judge metrics an "Unknown" escape hatch; record `pass@k`/`pass^k` for a sampled subset.
- Write eval scores back to the Phase-1 traces (Langfuse scores) so quality + telemetry co-locate.
**Demo:** run the eval → table of retrieval + answer-quality metrics for the current version/model.
**AC:** answer-quality metrics computed over the golden subset; scores attached to traces; eval runs
via a documented one-liner; token cost of a run recorded.

## Phase 3 — Version/model comparison + CI gate (the actual goal)
**Goal:** answer "is version/model B better than A?" reproducibly, and stop regressions in CI.
- Encode golden cases as a **promptfoo** config; matrix over `{service_version} × {model}` with
  assertions (exact-match where deterministic; LLM-rubric for groundedness/coverage).
- Produce an A/B comparison report (promptfoo viewer) and a regression gate: fail CI if a chosen
  metric drops beyond a threshold vs. the baseline.
- Wire a PR-gated subset (fast/cheap) + an optional nightly full run (cost guardrail).
**Demo:** run two models (or two versions) through the same suite → side-by-side scorecard + a
deliberately-worse run failing the gate.
**AC:** comparison report across ≥2 models and ≥2 versions; CI gate fails on injected regression;
cost per gate run bounded and documented.

## Phase 4 — Dashboard
**Goal:** quality + telemetry trends visible over time and between versions.
- v1: use the chosen backend's **built-in dashboard** (Langfuse/Phoenix) with saved
  version/model-filtered views. Lowest effort.
- Optional v2 (separate decision): surface a curated metric summary into the harness GitHub Pages
  dashboard (`docs/`, `vite.dashboard.config.ts`) co-located with other harness dashboards.
**Demo:** a dashboard view trending answer-quality + latency/cost by version and model.
**AC:** a shareable view shows quality + cost trends filterable by version + model; documented how to
read it for an A/B decision.

## Non-blocking sibling: Agent SDK → LangGraph/LangChain (separate bead)
**Not required for any phase above.** The app currently uses the **raw OpenAI SDK** in a linear
pipeline — there is no agent framework today. Migrating retrieve→gate→rerank→generate to a LangGraph
graph would add native node-level tracing (OpenInference/Langfuse/LangSmith) and open agentic
patterns, but Langfuse already instruments the raw SDK **without** it. So this is an **independent,
optional** decision — evaluate ROI (tracing granularity + future agentic flexibility) vs. cost
(heavy deps, rewrite of a working pipeline). `repos/NeMo-Flow` is a reference for langgraph + OTel
exporters if pursued. Filed as its own bead, linked to the epic, **not** blocking it.

## Risks / Guardrails
- **Eval token cost** — LLM-judge metrics burn API spend; cap golden subset + cadence (PR subset vs
  nightly full).
- **Self-host footprint** — Langfuse adds services to docker-compose; confirm acceptable in Phase 0.
- **PII/retention** — traces store prompts + answers; define retention before persistent logging.
- **Eval saturation** — if metrics hit ceiling, refresh with harder cases (per Anthropic).
- **Scope creep** — keep the LangGraph migration out of the observability critical path.
