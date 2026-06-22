# Research: rag-chat-aetheril-overhaul — Aetheril design system + multi-mode D&D assistant
Generated: 2026-06-21
Repo: rag-chat (ui + service + ingestion + vector-db) · Source: aetheril-design-system
Phase: research (1/4) — **umbrella doc**

> This is the umbrella research document. Three workstream deep-dives sit alongside it and are
> authoritative for their domain:
> - [Design System Port (frontend)](rag-chat-aetheril-overhaul-design-system.md)
> - [Multi-Mode Chat (backend)](rag-chat-aetheril-overhaul-chat-modes.md)
> - [App Shell, Users (stub) & Navigation](rag-chat-aetheril-overhaul-app-shell-users.md)

## Goal
Re-skin the rag-chat D&D 5e RAG app to the **Aetheril** design system and grow it from a single
stateless "Sage" chat into a **full app** with a Landing screen, a left-nav workspace, a stubbed
user identity, and **four chat modes** — **Sage** (general), **Spell**, **Rules**, and **GM**
(creative monster/NPC/world-building). The corpus and RAG pipeline are reused; modes are personas +
retrieval scopes over the existing backend, with a stubbed seam for a future second "world" source
that GM chat will eventually synthesize.

## What the Code Says (answered by exploration)

### rag-chat today
- **UI** — React 19 + Vite + TS, single page. `ui/src/App.tsx` renders one chat ("D&D 5e Sage");
  `useChat.ts` holds exchanges in memory; `api.ts` does `POST /chat {prompt}` →
  `{answer, sources[], answerable}` with a discriminated-union `ChatResult` (refusals are 200, not
  errors). Components: `ChatForm` (raw `<textarea>`+`<button>`), `ExchangeView`, `SourceList`.
  Styling is a hand-rolled **dark "grimoire"** theme in `App.css` + `index.css` (plain CSS).
  No router, no users, no persistence, no modes.
- **Tests (UI)** — Vitest 4 + jsdom + Testing Library (React). `api.test.ts`, `useChat.test.tsx`,
  `exportChat.test.ts`, `smoke.test.ts`. **No `"test"` script in `ui/package.json`** (config is in
  `vite.config.ts`); add `"test": "vitest run"`.
- **Service** — FastAPI, stateless `POST /chat` → `RagService.answer(prompt)`
  (`service/rag.py:33`) → retrieve → **answerability gate** (`rag.py:37`: refuse when
  `not answerable or not chunks`) → `generate_answer` (`generate.py`) → cite. Persona is a
  module-level `GROUNDED_PROMPT` (`generate.py:24`), sent as a **user** message — there is no
  `system` message today.
- **Retrieval** — `ingestion/retrieval.py` `RagRetriever`; chunks carry `book_slug`, `content_type`,
  `entity`, `chapter`, `section`, `page`. `book_slug` is indexed (`dnd_chunks_book_slug_idx`).
  Retrieval already derives `content_type`/`entity` filters from the query; there is **no book/scope
  filter parameter yet** — one must be added. `answerable` is a top-1 distance threshold (≤ 0.50).
- **Tests (service)** — pytest with dependency-override + mocked retriever/LLM
  (`test_app.py`, `test_service.py`). `test_response_schema` asserts an exact response key set —
  it will need updating when `mode` is echoed.

### aetheril-design-system
- **Tokens** are plain CSS custom properties (`source/tokens/*.css`, 8 files) — adoptable **as-is**.
  Light "Parchment" + dark "Tavern" switch on `[data-theme="dark"]` at the root. Fonts (Cinzel,
  Spectral, Mulish, JetBrains Mono, Material Symbols Rounded) load from Google Fonts CDN.
- **10 components** ship as `.jsx` + authoritative `.d.ts` contracts: Button, IconButton, TextField,
  Switch, Card, Chip, Avatar, Badge, and the **signature** DiceRoll + ChatMessage. Rebuild each as
  idiomatic React/TS wired to tokens.
- **Reference app** (`source/ui_kits/aetheril-app/`) composes a `useState` screen machine
  (landing → campaigns → chat) into AppShell/Landing/CampaignList/ChatView. It is **UMD-namespaced
  reference only — do not copy verbatim**; rebuild as ES-module React/TS.

See the three workstream docs for full inventories (token names, every component prop surface,
mode→scope mapping, shell regions, seams).

## Decisions Resolved with the User
| Question | Decision | Rationale |
|----------|----------|-----------|
| Depth of "Users" | **UI shell only** — stub current user + user menu; no real auth/persistence this run | Keeps the run focused on design system + chats; clean seam for real auth later |
| Chat architecture | **Shared RAG backend**, per-mode persona + retrieval scope | Reuses the existing pipeline; least duplication; one corpus already |
| Future GM second source | **Stubbed seam now** — GM will later pull a 2nd "world" corpus and synthesize | User intends a second backend later; design the abstraction, no-op it now |
| GM gating | **Creative mode (relaxed gate), GM-only** | GM must invent monsters/NPCs/world; Sage/Spell/Rules stay strictly grounded |
| App shape | **Full Aetheril app shell** (Landing → left-nav workspace + user menu) | Fits users + multiple chats; matches the design system's reference app |
| Modes | **Sage (general) + Spell + Rules + GM = 4 modes** | Preserve today's "ask anything" surface; add three focused chats |
| Theme | **Both themes; light Parchment default + dark Tavern toggle** | Most faithful to the high-fidelity handoff; the dark theme already exists |

### Defaults adopted (agent-surfaced questions I resolved myself; documented for veto)
- **API:** `POST /chat { prompt, mode?: 'sage'|'spell'|'rules'|'gm' = 'sage', conversation_id?: string }`
  → `{ answer, sources[], answerable, mode }` (echo `mode` **and** `conversation_id`). Backward
  compatible via Pydantic defaults; `api.ts` ignores unknown response fields until the UI updates.
- **GM gate:** GM-only branch — proceed when `chunks` is non-empty even if `answerable=False`; keep
  the distance signal and echo `answerable=False` to mark partly-inventive output. The GM persona
  instructs the model to flag invented content inline. The client labels "creative" off `mode` — no
  new `creative` field. (≥1 chunk floor, not a full gate removal.)
- **Spell scope:** include all spell-bearing books (phb, xge, tce, eepc, scag, tortle, eberron,
  ravnica); refine via eval later.
- **Second source:** `StubSecondaryRetriever` (no-op, zero cost) now; the real world-corpus store
  choice (shared pgvector vs separate) is deferred to that future push.
- **Conversation history:** stubbed — `LocalStorageConversationStore` behind a `ConversationStore`
  interface; **per-mode** lists; **auto-title from first prompt** + manual rename; seam
  (`ApiConversationStore`) for a real backend later.
- **Routing:** state-switcher `AppNavContext` (screen/mode/conversationId), **no new dependency**;
  FastAPI `StaticFiles(html=True)` already SPA-fallbacks if we later adopt a real router.
- **Fonts:** Google Fonts CDN this run; self-host later (non-blocking).
- **Brand/logo:** adopt `source/assets/logo-mark.svg` for brand + favicon.

## Constraints & Non-Goals
**Constraints**
- Tokens-first: stand up the token layer before components; wire everything to tokens (no raw hex).
- Preserve the two type registers (Spectral narration vs Mulish UI) and honor `prefers-reduced-motion`.
- Keep `api.ts`'s discriminated-union result pattern; backend changes stay backward compatible.
- Strict TS; existing pytest/vitest suites must stay green (rewrite only what the refactor breaks).

**Non-goals (explicitly out of scope this run)**
- Real authentication / login / sessions (stub only).
- DB-backed conversation persistence (local/stub only).
- The real second "world" retrieval corpus + synthesis (seam + stub only).
- Font self-hosting; multi-device sync.

## Open Risks / Assumptions Carried Forward
- **Full CSS migration**, not additive — the grimoire theme is fully replaced; the `App` integration
  test breaks and must be rewritten against the new shell.
- **DS source bugs to patch on port:** DiceRoll `clip-path` clips its border; reduced-motion is
  hardcoded (not token-driven); `TextField.d.ts` omits `onKeyDown` (needed for Enter-to-send);
  `Switch.onChange(next: boolean)` is not a React event.
- **React 19 compatibility** of the DS `.jsx` default imports — verify on port.
- **GM creative quality/safety** — relaxed grounding; persona must flag invented content; citation
  semantics differ from grounded modes.
- **Do not copy** the UMD `ui_kits/aetheril-app` JSX — reference only.

## Recommended Scope for Planning
Materialize **one Beads epic** with **six features** under it, dependency-ordered for parallel work:

1. **F1 — Design-system foundation:** copy/adopt the token layer; light+dark theming + toggle;
   fonts/icons; `.aether-parchment`; logo/favicon. *(foundational; blocks F2/F3)*
2. **F2 — Component library:** rebuild the 10 DS components as TSX wired to tokens, with patches for
   the known source bugs and Vitest tests. *(depends F1)*
3. **F3 — App shell & navigation:** Landing, AppShell, LeftNav (4 mode chips + per-mode conversation
   list), top bar, **stub** user-menu/Avatar, `AppNavContext`. *(depends F2)*
4. **F4 — Multi-mode chat backend:** `ChatMode` enum + API contract; per-mode persona (system
   message split); per-mode retrieval scoping (`book_slugs` param + `_scope_for_mode`); GM relaxed
   gate; `StubSecondaryRetriever` seam + `_merge_results`; pytest. *(parallel with F1–F3)*
5. **F5 — Chat experience integration:** ChatMessage/DiceRoll wired to the backend; mode+conversation
   -aware `useChat`; stubbed `ConversationStore`; composer (TextField+IconButton); sources in a Card;
   keep export. *(depends F2, F3, F4)*
6. **F6 — Polish & QA:** reduced-motion, accessibility (WCAG AA, 44px touch floor), e2e smoke,
   README/docs refresh. *(depends all)*

The plan phase ([forge-plan](../../.claude/skills/forge-plan/SKILL.md)) should turn this into the
epic + features + TDD tasks with demo checkpoints, and may keep F1–F3 (frontend) and F4 (backend) as
parallel sub-agent tracks.
