# Plan Review: dnd-chat-ui — D&D Chat UI (React + Vite) [3zs]
Source: plans/drafts/dnd-chat-ui.md · Reviewed: 2026-06-08

## Verdict: SOUND — 0 Blocker / 0 High / 1 Medium / 0 Low

The plan's claims about the existing system check out exactly — the API contract the UI mirrors,
the error behaviors it must handle, and the test counts all match the real `service/` code. The one
finding is an unverified library-behavior assumption (Starlette mount ordering) that the plan
already self-mitigates with an explicit test. Mostly greenfield, so the claim surface was small;
what was checkable is correct.

## Findings

### [Medium] StaticFiles mount-order behavior asserted from memory — C3 (3zs.c)
**What:** C3 states the `ui/dist` mount is "guarded … mounted last so `/chat`/`/healthz` win" —
relying on Starlette matching routes in registration order so a root mount registered after the
route decorators can't shadow them.
**Why it's an issue:** If the ordering assumption were wrong (or the mount were added inside the
lifespan instead of at module scope after the decorators), `POST /chat` could 405/404 behind the
static handler and the single-process demo breaks.
**Evidence:** No first-party Starlette/FastAPI doc was consulted in-session; the claim rests on
prior knowledge. The plan itself hedges correctly: C3 includes "add one test asserting `/chat`
still resolves with the mount active" and "12 service tests stay green" — which catches a wrong
assumption before ship. — Confidence: Needs confirmation
**Suggested correction:** Keep the C3 test as the gate (already planned). Implement the mount at
module scope after the route decorators (not in the lifespan), and verify with the planned test
before the demo.

## Verified as accurate (spot-checks)
- **API contract mirror** — `Source{book: str, chapter/section/entity/page optional, snippet: str}`,
  `ChatResponse{answer, sources, answerable}` — `service/models.py` matches the plan's `api.ts`
  contract exactly ✓
- **422 on empty prompt** comes from `ChatRequest.prompt min_length=1` (`service/models.py:9`) —
  client-side prevention in the UI is consistent ✓
- **503 semantics** — not-ready (`service/app.py:43`) and upstream failure (`service/app.py:57`) ✓
- **Refusal is 200 + `answerable=False` + empty sources, fixed string** (`service/rag.py:19,38`) —
  the plan's "style refusals distinctly, not as errors" is the right reading ✓
- **Endpoints `/chat` + `/healthz` exist** (`service/app.py:47,52`) — matches the Vite proxy list ✓
- **"12 service tests stay green"** — exactly 6 + 6 in `test_service.py`/`test_app.py` ✓
- **Toolchain present** — node v25.8.2, bun 1.3.10, npm 11 (probed live this session) ✓

## Not verified
- **vitest + RTL + jsdom under `bunx` on node 25** — can't be verified without doing it; the plan
  treats this as a risk (not a fact) with a C1 smoke-test-first gate and an npm fallback. Correct
  handling; no finding.
- **Vite `server.proxy` config shape** — greenfield config, nothing in-repo to check against.
- **Realized UX of 1–3 s latency** — only the C2 live demo settles it.
