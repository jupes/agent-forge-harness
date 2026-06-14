# Research — D&D Chat UI (React + Vite) [3zs]

> **Slug**: `dnd-chat-ui` · **Bead**: agent-forge-harness-3zs (epic)
> **Date**: 2026-06-08 · **Phase**: 1 (research) · **Repo**: `repos/rag-chat` (new `ui/`)
> **Goal**: single-page chat — prompt in, grounded answer out, **collapsible source
> citations**, loading state. Talks to the agent service (`POST /chat`, shipped in 88v).

---

## Current state

- **No frontend exists** anywhere in rag-chat — greenfield `ui/`.
- **The API contract is already fixed** by `service/models.py`:
  `ChatRequest{prompt}` → `ChatResponse{answer: str, sources: Source[], answerable: bool}`,
  `Source{book, chapter?, section?, entity?, page?, snippet}`. Errors: 422 (empty prompt),
  503 (not ready / upstream). Refusals come back `200` with `answerable=false` and a fixed
  refusal answer — the UI should style these distinctly, not as errors.
- **Service runs at** `localhost:8000` (uvicorn; see `service/README.md`). It is stateless —
  any conversation history is purely client-side.
- **Toolchain present**: node v25.8.2, bun 1.3.10, npm 11. Bun is the harness standard
  (CLAUDE.md quality gates are `bun run … && bun test`), so bun is the package manager /
  script runner; Vite is the build tool. **User decision: React + Vite (full pipeline)** over
  the zero-build static page.

## Decisions (research; overridable at the plan gate)

1. **Scaffold**: Vite `react-ts` template under `repos/rag-chat/ui/`, TypeScript **strict**
   (harness constitution: no `any` without justification).
2. **Dev wiring — proxy, not CORS**: Vite `server.proxy` forwards `/chat` → `http://localhost:8000`.
   Same-origin in the browser, zero changes to the FastAPI service, no CORS middleware. In
   prod, the built `ui/dist` can be mounted by FastAPI (`StaticFiles`) so one process serves
   both — a small optional checkpoint.
3. **Component shape** (small, testable):
   - `App` — holds the exchange list (client-side state only).
   - `ChatForm` — textarea + submit; disabled while loading.
   - `ExchangeView` — user prompt + answer (or refusal styling when `answerable=false`).
   - `SourceList` — collapsible citations (`<details>`-based; one entry per `Source`,
     showing book/entity/page + snippet).
   - `useChat` hook — `POST /chat`, loading/error state; isolates fetch for easy mocking.
4. **State**: an in-memory list of exchanges `{prompt, response | error, pending}` — feels
   like a chat, costs nothing, honest about the stateless backend (no fake history sent to it).
5. **Styling**: hand-rolled CSS, dark parchment/grimoire theme (D&D-flavored), no CSS
   framework — keeps the toolchain lean; the AC is about function, the theme adds craft.
6. **Testing**: **vitest + @testing-library/react + jsdom**, run via `bunx vitest run`.
   (Bun's native test runner still has DOM/RTL gaps; vitest is the Vite-native standard.)
   Mock `fetch` in the hook tests; component tests assert loading → answer → sources flow,
   refusal styling, and error rendering.

## What the UI must handle (from the real API)

| case | API behaviour | UI behaviour |
|------|---------------|--------------|
| grounded answer | 200, `answerable=true`, sources ≥1 | answer text + collapsible sources (count badge) |
| refusal | 200, `answerable=false`, sources `[]` | distinct "not in my sources" styling, no sources block |
| empty prompt | 422 | client-side prevent; disable submit on empty |
| service down/not ready | 503 / network error | inline error bubble + retry affordance |
| latency (~1–3 s: embed + LLM) | — | loading indicator on the pending exchange; form disabled |

## Open questions for the plan

- **Prod serving checkpoint**: mount `ui/dist` from FastAPI now, or defer to the 09q
  full-stack epic? (Lean: include — it's ~6 lines and makes the demo one process.)
- **Markdown in answers**: gpt-4o-mini may emit markdown ("**bold**", lists). Render as
  plain text v1, or add a tiny md renderer? (Lean: plain text with whitespace preserved;
  note md as follow-up.)
- **Citation markers**: answers cite `[1]`/`[2]` inline — link them to the corresponding
  source entry (anchor/highlight) or leave plain? (Lean: leave plain v1.)

## Risks

- **vitest/jsdom on bun** — well-trodden (`bunx vitest`), but verify early in C1 with a
  smoke test before building components.
- **Node 25 + Vite compat** — current Vite supports it; the scaffold step will confirm.
- **Out-of-scope creep** — streaming, chat-history persistence, auth all belong to 09q/later.

## Files (planned)

- new: `repos/rag-chat/ui/` (Vite react-ts app: `src/App.tsx`, `src/components/*`,
  `src/useChat.ts`, `src/api.ts` (typed contract mirroring models.py), tests, `vite.config.ts`
  with proxy, `package.json`)
- edit (optional checkpoint): `repos/rag-chat/service/app.py` (mount `ui/dist`)
- edit: `repos/rag-chat/service/README.md` (UI run instructions)
