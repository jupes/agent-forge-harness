# Plan — D&D Chat UI (React + Vite) [3zs]

> **Slug**: `dnd-chat-ui` · **Bead**: agent-forge-harness-3zs (epic)
> **Phase**: 2 (plan) · **Research**: [plans/research/dnd-chat-ui.md](../research/dnd-chat-ui.md)
> **Repo**: `repos/rag-chat` (new `ui/`) · **Approach**: TDD (hook + components via vitest/RTL),
> demo-able checkpoints, Beads-tracked.

---

## Resolved decisions

- **Stack**: Vite `react-ts`, bun as PM/runner, TypeScript strict. vitest + @testing-library/react
  + jsdom via `bunx vitest run`.
- **Dev wiring**: Vite `server.proxy` `/chat` + `/healthz` → `http://localhost:8000`. No CORS, no
  service changes for dev.
- **Prod serving** *(open q resolved: include)*: FastAPI mounts `ui/dist` when present (~6 lines,
  guarded) so one process serves API + UI; demo runs as a single origin.
- **Answers as plain text** v1, whitespace preserved (`white-space: pre-wrap`); markdown rendering
  noted as follow-up. **Citation markers `[1]` stay plain** v1.
- **State**: client-side exchange list `{id, prompt, status: pending|done|error, response?}`;
  service stays stateless.
- **Theme**: hand-rolled dark grimoire/parchment CSS; no framework.

## Build — 4 checkpoints

### C1 — scaffold + typed API client + useChat (TDD foundation)  *(3zs.a)*

- Scaffold `ui/` (Vite react-ts), bun install; wire vitest + RTL + jsdom; **smoke-test the
  toolchain first** (one trivial passing test) before real code.
- `src/api.ts` — typed contract mirroring `service/models.py` (`ChatResponse`, `Source`) +
  `postChat(prompt, fetchImpl)` handling 200 / 422 / 503 / network error into a discriminated
  result type.
- `src/useChat.ts` — hook owning the exchange list + loading; `send(prompt)` appends a pending
  exchange, resolves it to done/error.
- **Tests (red→green)**: postChat happy/refusal/503/network; useChat pending→done flow, error
  flow, no-double-submit while pending.
- **Demo**: `bunx vitest run` green; `bun run dev` serves the scaffold.

### C2 — components + styling  *(3zs.b)*

- `ChatForm` (textarea + submit; disabled while pending; Enter submits, Shift+Enter newline),
  `ExchangeView` (prompt bubble + answer; refusal styling when `answerable=false`; error bubble
  with retry), `SourceList` (collapsible `<details>` with count badge; book/entity/page + snippet
  per source), `App` composition; grimoire theme CSS.
- **Tests**: RTL — submit flow renders pending then answer (mocked fetch); sources collapsed by
  default, expand on click, count badge; refusal renders distinct style and no sources; error
  + retry re-sends.
- **Demo**: `bun run dev` against the live service — ask a Mind Flayer question in the browser,
  watch loading → grounded answer → expand sources; ask an out-of-corpus question → refusal style.

### C3 — prod serving + service README  *(3zs.c)*

- `vite build` → `ui/dist`; mount in `service/app.py` (guarded `StaticFiles(..., html=True)` only
  when the dist exists, mounted last so `/chat`/`/healthz` win).
- Endpoint tests still green (mount must not shadow API routes); add one test asserting `/chat`
  still resolves with the mount active.
- `service/README.md` + `ui/README.md` run instructions.
- **Demo**: single `uvicorn service.app:app` serves the built UI at `/` and answers `/chat`.

### C4 — ship  *(3zs.d)*

Ship report + PR; close 3zs children + epic (09q full-stack epic becomes unblocked).

## Beads

Epic **3zs** (exists). Children: 3zs.a scaffold+client+hook *(P2)* → 3zs.b components+styling
*(P2)* → 3zs.c prod serving+docs *(P2)* → 3zs.d ship *(P2)*. Linear spine.

## Test strategy (TDD)

vitest + RTL, mocked fetch — no live service in tests. Red→green per unit (api → hook →
components). The live service is used only in checkpoint demos. Existing 12 service (Python)
tests must stay green after the C3 mount change. Type gate: `tsc --noEmit` strict.

## Risks & mitigations

- **Toolchain friction (bun+vitest+jsdom, node 25)** → C1 smoke test first; if vitest won't run
  under bun, fall back to `npm run` scripts (npm 11 present) without changing the plan.
- **Static mount shadows API routes** → mount last + explicit test (C3).
- **Latency UX** (1–3 s) → pending bubble + disabled form (C2 tests cover it).
- **Scope creep** (streaming, history persistence, md rendering) → noted follow-ups, 09q.

## Definition of done

Browser: submit prompt → loading → grounded answer with collapsible sources; refusal styled
distinctly; errors recoverable. `bunx vitest run` + `tsc --noEmit` green; service tests green with
the mount; single-process demo works; README updated; 3zs + children closed; PR.
