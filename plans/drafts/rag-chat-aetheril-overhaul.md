# Plan: rag-chat-aetheril-overhaul — Aetheril design system + multi-mode D&D assistant
Generated: 2026-06-21
Repo: rag-chat
Phase: plan (2/4) — from plans/research/rag-chat-aetheril-overhaul.md

> Research source of truth: [umbrella](../research/rag-chat-aetheril-overhaul.md) +
> [design-system](../research/rag-chat-aetheril-overhaul-design-system.md) ·
> [chat-modes](../research/rag-chat-aetheril-overhaul-chat-modes.md) ·
> [app-shell-users](../research/rag-chat-aetheril-overhaul-app-shell-users.md).

## Summary
Re-skin the rag-chat UI to the **Aetheril** token layer + component set (light Parchment default,
dark Tavern toggle) and grow the app into a **full shell** (Landing → left-nav workspace + stub user
menu) hosting **four chat modes** — Sage, Spell, Rules, GM. Modes are personas + retrieval scopes
over the **existing** RAG backend; GM runs a relaxed "creative" gate and carries a **stubbed seam**
for a future second "world" retrieval source. Users and conversation history are **stubbed** this
run (no real auth/DB). Six features under one epic; frontend (F1–F3, F5) and backend (F4) parallelize.

## Existing Code to Reuse
- `ui/src/api.ts` — keep the discriminated-union `ChatResult` + error mapping; **extend** to `postChat(prompt: string, mode: ChatMode = 'sage', conversationId?: string, fetchImpl = fetch)` (`fetchImpl` stays last/optional for tests).
- `ui/src/useChat.ts` — exchange state; **evolve** to `useChat({ post?, mode, conversationId })`.
- `ui/src/exportChat.ts` — keep as-is (export conversation).
- `ui/src/components/SourceList.tsx` — keep logic; wrap in a DS `Card`.
- `service/rag.py` `RagService.answer()` — extend with `mode`; the gate at `rag.py:37` gets a GM branch.
- `service/generate.py` `GROUNDED_PROMPT` (`:24`) — split into per-mode system prompts + shared grounding suffix.
- `ingestion/retrieval.py` `RagRetriever.retrieve()` — add `book_slugs` filter param (col `book_slug` is indexed).
- DS source: `repos/aetheril-design-system/source/tokens/*.css` (adopt as-is), `source/components/*/*.d.ts` (prop contracts), `source/assets/logo-mark.svg`. **Reference only** (do not copy): `source/ui_kits/aetheril-app/*` (UMD).
- Test harnesses: Vitest + Testing Library (UI), pytest with dep-override + mocked retriever/LLM (service).

## TDD Strategy (red-green-refactor)
Following `.claude/skills/tdd`. Behaviors tested through public interfaces, vertical slices, one
failing test at a time. Tracer bullets prove each track end-to-end early.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | Theme provider defaults to light Parchment, toggles to dark Tavern, and persists the choice across reload | `ui/src/ds/theme.test.tsx` | yes (FE foundation) |
| 2 | Button renders each variant, fires onClick, and renders a leading icon slot | `ui/src/ds/Button.test.tsx` | no |
| 3 | IconButton renders icon-only variants and is keyboard-activatable | `ui/src/ds/IconButton.test.tsx` | no |
| 4 | TextField is controlled, shows error/supporting text, and Enter-to-send fires (our TSX **adds** an `onKeyDown` prop beyond the DS `.d.ts`) | `ui/src/ds/TextField.test.tsx` | no |
| 5 | Switch calls onChange(next: boolean) (not a DOM event) and reflects on/off | `ui/src/ds/Switch.test.tsx` | no |
| 6 | Card renders elevated/filled/outlined and lifts on hover only when interactive | `ui/src/ds/Card.test.tsx` | no |
| 7 | Chip renders filter/assist variants and a selected filter chip fills | `ui/src/ds/Chip.test.tsx` | no |
| 8 | Avatar renders initials derived from `name` when no src/icon, and an icon variant otherwise | `ui/src/ds/Avatar.test.tsx` | no |
| 9 | Badge renders semantic tones including nat20, and our TSX **adds** a `nat1` tone (`--aether-nat1`) for fumbles | `ui/src/ds/Badge.test.tsx` | no |
| 10 | DiceRoll renders `2d6 + 4 = 13` in mono, colors crit green / fumble red, and animates only when not reduced-motion | `ui/src/ds/DiceRoll.test.tsx` | no |
| 11 | ChatMessage renders dm/player/system turns with the author's asymmetric bubble + Spectral narration | `ui/src/ds/ChatMessage.test.tsx` | no |
| 12 | App nav starts on Landing; entering the workspace selects a default mode; switching modes updates active mode | `ui/src/shell/appNav.test.tsx` | yes (shell) |
| 13 | LeftNav lists the four modes; clicking one activates it; the theme toggle flips data-theme | `ui/src/shell/LeftNav.test.tsx` | no |
| 14 | User menu shows the stub user's initials and exposes (no-op) profile/sign-out actions | `ui/src/shell/userMenu.test.tsx` | no |
| 15 | `/chat` accepts `{prompt}` (defaults to sage) and `{prompt, mode, conversation_id}`, echoing `mode` + `conversation_id` | `service/test_app.py` | yes (backend) |
| 16 | `generate_answer` selects the correct per-mode persona/system prompt | `service/test_service.py` | no |
| 17 | `_scope_for_mode` maps spell→spell ctypes+spell books, rules→rule ctypes, gm→monster/dm ctypes, sage→unscoped; retrieve passes the book filter | `service/test_service.py` / `ingestion/test_retrieval.py` | no |
| 18 | GM mode with non-empty chunks but answerable=False returns a generated answer; sage/spell/rules still refuse; the stub secondary retriever returns empty and merge keeps primary order | `service/test_service.py` | no |
| 19 | `useChat` sends the active mode + conversationId, and clears exchanges when conversationId changes | `ui/src/useChat.test.tsx` | yes (integration) |
| 20 | ConversationStore (memory impl) creates/lists/renames/removes per-mode conversations and auto-titles from the first prompt | `ui/src/shell/conversationStore.test.ts` | no |
| 21 | Sending a prompt renders a player ChatMessage then a dm ChatMessage, with sources in a Card; export still works | `ui/src/shell/ChatPane.test.tsx` | no |
| 22 | Controls meet the 44px touch floor and expose accessible names; animations are suppressed under prefers-reduced-motion | `ui/src/ds/a11y.test.tsx` | no |

Refactor watch-list (after green): collapse per-component boilerplate into a shared DS primitive
(`stateLayer`, `icon` rendering); factor a single `modeConfig` map (persona + scope + gate policy)
on the backend so a mode is one record, not scattered branches; keep `ChatPane` thin by pushing
exchange→ChatMessage mapping into a pure helper.

## Build Sequence & Checkpoints
Frontend track (F1→F2→F3→F5→F6) and backend track (F4) run in parallel; F5 joins them.

### F1 — Design-system foundation  *(blocks F2; transitively F3/F5)*
**CP-F1.1 Token layer + fonts + parchment + brand.** Copy `tokens/*.css` → `ui/src/ds/tokens/`,
add `ds/styles.css` entry, import in `main.tsx`; load Google Fonts; apply `.aether-parchment`;
swap favicon/logo to `logo-mark.svg`.
Demo: `cd ui && bun run dev` → app renders on parchment with brand fonts/logo.
**CP-F1.2 ThemeProvider + useTheme.** Light Parchment default, dark Tavern; persist to localStorage; set `data-theme` on `<html>`.
Demo: `bun test ui/src/ds/theme.test.tsx` — behavior #1 green.

### F2 — Component library  *(depends F1)*
**CP-F2.1 Actions** — Button, IconButton. Demo: `bun test ui/src/ds/Button.test.tsx ui/src/ds/IconButton.test.tsx` (#2–3).
**CP-F2.2 Forms** — TextField (TSX adds `onKeyDown` for Enter-to-send), Switch (`onChange(next: boolean)`, not a DOM event). Demo: `bun test ui/src/ds/TextField.test.tsx ui/src/ds/Switch.test.tsx` (#4–5).
**CP-F2.3 Containment** — Card, Chip. Demo: `bun test ui/src/ds/Card.test.tsx ui/src/ds/Chip.test.tsx` (#6–7).
**CP-F2.4 Communication** — Avatar, Badge. Demo: `bun test ui/src/ds/Avatar.test.tsx ui/src/ds/Badge.test.tsx` (#8–9).
**CP-F2.5 Signature D&D** — DiceRoll (+clip-path/reduced-motion patch), ChatMessage. Demo: `bun test ui/src/ds/DiceRoll.test.tsx ui/src/ds/ChatMessage.test.tsx` (#10–11).

### F3 — App shell & navigation  *(depends F2)*
**CP-F3.1 AppNavContext + view machine** (screen/mode/conversationId). Demo: `bun test ui/src/shell/appNav.test.tsx` (#12).
**CP-F3.2 Landing screen.** Demo: `bun run dev` → Landing; `bun test` landing render → enters workspace.
**CP-F3.3 WorkspaceShell + LeftNav + TopBar + theme toggle.** Demo: `bun run dev` → workspace; `bun test ui/src/shell/LeftNav.test.tsx` (#13).
**CP-F3.4 Stub CurrentUserContext + user menu (Avatar).** Demo: `bun test ui/src/shell/userMenu.test.tsx` (#14).

### F4 — Multi-mode chat backend  *(parallel; independent of F1–F3)*
**CP-F4.1 ChatMode enum + API contract** — `ChatMode = 'sage'|'spell'|'rules'|'gm'`; `ChatRequest.{mode='sage', conversation_id}`; `ChatResponse.{mode, conversation_id}` echo; **update `test_response_schema`** for the new keys. Demo: `pytest service/test_app.py -k mode` (#15, tracer).
**CP-F4.2 Per-mode persona** (split prompts, system message, `generate_answer(mode=…)`). Demo: `pytest service/test_service.py -k persona` (#16).
**CP-F4.3 Per-mode retrieval scoping** (`book_slugs` param + pure `_scope_for_mode`). Demo: `pytest -k scope` (#17).
**CP-F4.4 GM relaxed gate + StubSecondaryRetriever seam + `_merge_results`.** Demo: `pytest service/test_service.py -k "gm or merge"` (#18).

### F5 — Chat experience integration  *(depends F2, F3, F4)*
**CP-F5.1 mode+conversation-aware `useChat` + `postChat(mode, conversationId)`.** Demo: `bun test ui/src/useChat.test.tsx` (#19, tracer).
**CP-F5.2 ConversationStore** (interface + LocalStorage + Memory impls; per-mode; auto-title; rename). Demo: `bun test ui/src/shell/conversationStore.test.ts` (#20).
**CP-F5.3 ChatPane integration** (ChatMessage feed, composer = TextField+IconButton, sources Card, DiceRoll hook, export, mode-aware empty state). Demo: `bun run dev` → send a prompt per mode; `bun test ui/src/shell/ChatPane.test.tsx` (#21).
**CP-F5.4 LeftNav conversation list wired to store** (select/create/rename). Demo: `bun run dev` → create/switch conversations per mode.

### F6 — Polish & QA  *(depends all)*
**CP-F6.1 Reduced-motion + a11y pass** (44px floor, focus rings, accessible names, AA pairings). Demo: `bun test ui/src/ds/a11y.test.tsx` (#22).
**CP-F6.2 E2E smoke + docs.** Extend `ui/src/smoke.test.ts`; refresh `README.md` + `ui/README.md`; `cd ui && bun run build` green; `docker compose up --build` sanity.
Demo: `bun test && bun run build` green; app boots via compose.

## Files to Create / Modify
| File | Create/Modify | Purpose |
|------|---------------|---------|
| `ui/src/ds/tokens/*.css`, `ui/src/ds/styles.css` | Create | Adopted token layer + entry |
| `ui/src/ds/theme.tsx` | Create | ThemeProvider/useTheme (light/dark + persist) |
| `ui/src/ds/{Button,IconButton,TextField,Switch,Card,Chip,Avatar,Badge,DiceRoll,ChatMessage}.tsx` | Create | 10 DS components (TSX) + tests |
| `ui/src/shell/{AppNav,WorkspaceShell,LeftNav,TopBar,Landing,UserMenu,ChatPane}.tsx` | Create | App shell + nav + stub user menu |
| `ui/src/shell/{currentUser,conversationStore}.ts(x)` | Create | Stub user context; conversation store (interface + impls) |
| `ui/src/App.tsx`, `ui/src/main.tsx` | Modify | Switch Landing↔Workspace; mount providers + DS styles |
| `ui/src/api.ts`, `ui/src/useChat.ts` | Modify | `mode`/`conversationId` plumbing |
| `ui/src/App.css`, `ui/src/index.css` | Modify/Delete | Remove grimoire theme; thin globals only |
| `ui/index.html`, `ui/public/favicon.svg` | Modify | Fonts + brand/logo |
| `ui/package.json` | Modify | Add `"test": "vitest run"` |
| `ui/src/components/{ChatForm,ExchangeView}.tsx` | Delete | Replaced by DS composer + ChatMessage |
| `service/models.py` | Modify | `ChatMode` enum; `mode`/`conversation_id` fields |
| `service/generate.py` | Modify | Per-mode personas; system message; `mode` param |
| `ingestion/retrieval.py` | Modify | add `book_slugs` filter to `build_vector_sql` + `retrieve_top_k` + `retrieve` |
| `service/rag.py` | Modify | `mode` plumbing on `answer()`; pure `_scope_for_mode(mode)`; GM gate branch; secondary seam + `_merge_results` |
| `service/test_app.py`, `service/test_service.py` | Modify | Backend behaviors #15–18; **update `test_response_schema`** |
| `ingestion/test_retrieval.py` | **Create** | book-filter retrieval behavior (#17) |

## API Contract & Back-Compat
- **Request (backward compatible):** `POST /chat { prompt, mode?: 'sage'|'spell'|'rules'|'gm' = 'sage', conversation_id?: string }`. Existing `{ prompt }` callers keep working via Pydantic defaults.
- **Response (additive):** `{ answer, sources[], answerable, mode, conversation_id }`. `service/test_app.py::test_response_schema` asserts an **exact** key set (`{answer, sources, answerable}`) and **must be updated** to include `mode` + `conversation_id` — back-compat is request-side, not the exact-key test.
- **Client:** `postChat(prompt, mode = 'sage', conversationId?, fetchImpl = fetch)`; `ChatResult` discriminated union unchanged (unknown response fields ignored until consumed).
- **DS extensions (we own the TSX rebuild):** where a behavior needs a prop the handoff `.d.ts` lacks, we add it intentionally — `TextField.onKeyDown` (Enter-to-send) and `Badge` `nat1` tone (`--aether-nat1`). Documented extensions, not consumption of the handoff contract verbatim.

## Validation Commands
```bash
# UI
cd ui && bun run test && bun run build && bunx tsc -p tsconfig.app.json --noEmit
# Service
cd .. && uv run --with pytest --with fastapi pytest service ingestion -q
```

## Beads Issue Map
Epic **`agent-forge-harness-4wu`** · 6 features · 21 tasks. Label `aetheril`,`rag-chat`. Initial
`bd ready`: **`4wu.1.1`** (FE track) + **`4wu.4.1`** (BE track) — the rest unblock by dependency.

| Beads ID | Type | Title | Depends on | Priority |
|----------|------|-------|-----------|----------|
| `4wu` | epic | rag-chat: Aetheril design system + multi-mode assistant | — | P2 |
| `4wu.1` | feature | Design-system foundation (tokens + theming) | — | P2 |
| `4wu.2` | feature | Aetheril component library (10 components) | 4wu.1 | P2 |
| `4wu.3` | feature | App shell & navigation (+ stub user) | 4wu.2 | P2 |
| `4wu.4` | feature | Multi-mode chat backend (Sage/Spell/Rules/GM) | — | P2 |
| `4wu.5` | feature | Chat experience integration | 4wu.2, .3, .4 | P2 |
| `4wu.6` | feature | Polish & QA (a11y, reduced-motion, docs) | 4wu.5 | P3 |
| `4wu.1.1` → `.1.2` | task | Token layer → ThemeProvider | chain | P2 |
| `4wu.2.1` → `.2.5` | task | Actions → Forms → Containment → Communication → Signature | chain; `.2.1`←`.1.2` | P2 |
| `4wu.3.1` → `.3.4` | task | AppNav → Landing → WorkspaceShell → User menu | chain; `.3.1`←`.2.5` | P2 |
| `4wu.4.1` → `.4.4` | task | API contract → persona → scoping → GM gate/seam | chain | P2 |
| `4wu.5.1` → `.5.4` | task | useChat → ConversationStore → ChatPane → nav list | chain; `.5.1`←`.2.5`,`.3.4`,`.4.4` | P2 |
| `4wu.6.1` → `.6.2` | task | a11y/reduced-motion → e2e + docs | chain; `.6.1`←`.5.4` | P3 |

## Estimated Scope
- Files: ~32 new / ~13 modified / 2 deleted; Complexity: **High**; Checkpoints: 21 across 6 features.
- Parallelism: FE (F1→F2→F3) and BE (F4) independent; F5 joins; F6 last. Suited to 2 worker tracks.

## Plan Review
- **Turn 1 — NEEDS REVISION** (1 Blocker / 4 High / 3 Medium / 3 Low). All findings were accuracy/clarity gaps, not design flaws, and are addressed above: `TextField.onKeyDown` + `Badge.nat1` are now explicit TSX extensions; `test_response_schema` update + request-side back-compat pinned; `postChat`/`ChatMode` signatures pinned; `ingestion/test_retrieval.py` marked Create; F1→F2→F3 dependency clarified (transitive).
- **Turn 2 — SOUND** (0 Blocker / 0 High / 1 Medium / 1 Low). All six turn-1 corrections verified accurate against real code (`--aether-nat1` token confirmed in `colors.css:73`, `book_slug` index confirmed, `test_response_schema` exact-key assertion confirmed). The Medium (a duplicated `service/rag.py` row in the Files table) is fixed; the Low (`SourceList.tsx` "stale reference") was a false alarm — the file exists. Plan is **SOUND** for implementation.
