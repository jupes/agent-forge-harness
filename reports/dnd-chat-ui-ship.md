# Ship Report: dnd-chat-ui — D&D 5e Sage Chat UI (React + Vite) [3zs]

Shipped: 2026-06-14
Epic: agent-forge-harness-3zs · Code repo: `repos/rag-chat` (github.com/jupes/rag-chat, on `master`)
Harness docs branch: `feat/dnd-chat-ui` · PR: _(this PR)_

## What Shipped

A single-page chat interface — the **D&D 5e Sage** — where a user types a question and sees a
grounded answer with collapsible source citations. It talks to the stateless `POST /chat` agent
service (shipped in 88v): loading state while the embed+LLM round-trips, distinct styling for
out-of-corpus refusals (not treated as errors), and a recoverable error bubble with retry. The
build also ships **single-process serving** (FastAPI mounts the built `ui/dist`), a **full Docker
Compose stack** (one `docker compose up` for db + service + ui), and an **Export ↓** button that
dumps the conversation + sources to JSON for debugging.

## Before → After

| Area | Before | After |
|------|--------|-------|
| User-facing UI | None — the service was API-only (`curl`) | Browser chat at `:5173` (dev) / `:8000` (single-process) / `:5173` (compose) |
| Answers | JSON from `POST /chat` | Rendered answer + collapsible source list (book · entity · page + snippet) |
| Refusals | `200 {answerable:false}` in JSON | Distinct "not in my sources" styling, no sources block — not an error |
| Errors / latency | Caller's problem | Pending "Consulting the tomes…" bubble; error bubble with **Retry** |
| Running the stack | Manual uvicorn + DB | `docker compose up --build` (3 services) **or** one uvicorn serving UI+API |
| Debugging a session | Re-run by hand | **Export ↓** → `dnd-chat-<timestamp>.json` (prompt, answer, answerable, sources, error) |

## Work Done

- **C1 — scaffold + typed API client + `useChat`** *(3zs.a / x4o)* — Vite react-ts under `ui/`,
  bun + vitest + RTL + jsdom (toolchain smoke-tested first); `api.ts` mirrors `service/models.py`
  exactly with a discriminated `ChatResult` (200/422/503/network); `useChat` owns the exchange
  list with no-double-submit. (`45f2e9a`)
- **C2 — components + grimoire theme** *(3zs.b / piw)* — `ChatForm`, `ExchangeView`, `SourceList`,
  `App`; hand-rolled dark-grimoire CSS; Enter-submits / Shift+Enter-newline; refusal + error +
  retry rendering; sources collapsed by default with a count badge. (`af3a78f`)
- **Export button** *(e1x)* — `exportChat.ts` (pure `buildExportPayload` + side-effectful download);
  header **Export ↓**, disabled until the first exchange. (`e8fdc88`)
- **Docker Compose full stack** — `Dockerfile.service` (python:3.12-slim), `ui/Dockerfile`
  (bun build → nginx) + `nginx.conf` reverse-proxy, `.dockerignore`s; compose adds `service` +
  `ui` to the existing `vector-db`; root README rewritten with E2E quickstart. (`3bc4f4c`)
- **C3 — single-process serving** *(3zs.c / fkf)* — guarded `StaticFiles` mount of `ui/dist` in
  `app.py`, registered **after** the route decorators so `/chat` + `/healthz` always win; new test
  asserts `/chat` still resolves with the mount active; service README documents the path. (`076318f`)

## Beads Completed

| Beads ID | Title | Status |
|----------|-------|--------|
| agent-forge-harness-x4o | 3zs.a UI scaffold + typed API client + useChat hook | closed |
| agent-forge-harness-piw | 3zs.b chat components + grimoire styling | closed |
| agent-forge-harness-e1x | Chat export button — download conversation as JSON | closed |
| agent-forge-harness-fkf | 3zs.c prod serving (FastAPI mounts ui/dist) + docs | closed |
| agent-forge-harness-11n | 3zs.d chat UI ship (report + PR) | closed |
| agent-forge-harness-3zs | [epic] Chat UI — user-facing interface | closed |

Unblocks **agent-forge-harness-09q** ([epic] RAG Chat — full-stack app).

## Test It Yourself (walkthrough)

**Option A — one command (Docker, full stack):**
1. `cd repos/rag-chat` (ensure `.env` has `OPENAI_API_KEY`)
2. `docker compose up --build`
3. Open **http://localhost:5173** — ask *"What does a Mind Flayer do with its tentacles?"*
   - Expect: "Consulting the tomes…" → grounded answer; click the **N sources** badge → expands
     to `mm-5e · Mind Flayer · p.NNN` + snippet.
4. Ask *"How do I evolve my Pokémon?"* — Expect: distinct refusal styling, no sources.
5. Click **Export ↓** — Expect: `dnd-chat-<timestamp>.json` downloads with both exchanges.

**Option B — single process (no nginx):**
1. `cd repos/rag-chat/ui && bun run build`
2. `cd .. && uv run --with fastapi --with uvicorn --with openai --with "psycopg[binary]" uvicorn service.app:app --port 8000`
3. Open **http://localhost:8000** — same UI, one process serving UI + API.

**Automated:**
- UI: `cd repos/rag-chat/ui && bunx vitest run` — 28 tests green; `bunx tsc --noEmit` clean.
- Service: `cd repos/rag-chat && uv run … python -m service.test_app` (7) + `… python -m service.test_service` (6) — 13 green.

## Follow-ups / Known Gaps

- Markdown rendering of answers (plain text + `white-space: pre-wrap` in v1) — deferred to 09q.
- Inline citation markers `[1]` are plain text (not linked to source entries) — deferred to 09q.
- Streaming (SSE), chat-history persistence, auth — out of scope, belong to 09q / later.
- Browser downloads land in the default download folder (browsers can't target the Desktop path
  directly) — documented behavior, not a bug.
