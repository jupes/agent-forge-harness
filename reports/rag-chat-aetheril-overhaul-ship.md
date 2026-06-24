# Ship Report: rag-chat-aetheril-overhaul — Aetheril design system + multi-mode D&D assistant
Shipped: 2026-06-24
Epic: agent-forge-harness-4wu · Branch: `feat/aetheril-overhaul` (jupes/rag-chat) · PR: https://github.com/jupes/rag-chat/pull/1

## What Shipped
rag-chat went from a single dark-"grimoire" Q&A page into a full **Aetheril**-themed app: a Landing
screen, a left-nav workspace, light *Parchment* / dark *Tavern* themes, and **four chat modes** —
**Sage** (general), **Spell**, **Rules**, and **GM** (creative). Modes are personas + retrieval
scopes over the existing RAG backend; GM runs a relaxed "creative" gate and carries a stubbed seam
for a future second "world" retrieval source. Users and conversation history are stubbed this run
(no real auth/persistence), behind clean seams for later.

## Before → After
| Area | Before | After |
|------|--------|-------|
| Visual identity | Hand-rolled dark "grimoire" CSS | Aetheril design system — token layer (light Parchment + dark Tavern), 10 components, Cinzel/Spectral/Mulish/JetBrains fonts, d20 brand |
| App structure | One stateless chat page | Landing → workspace shell (left nav, top bar, user menu); client view-router |
| Chat modes | One general "Sage" over all 12 books | Sage **+** Spell **+** Rules **+** GM, switchable in the nav |
| Retrieval | Whole corpus, every query | Per-mode scoping (`book_slugs` + `_scope_for_mode`): Spell→spell books/types, Rules→rule types, GM→monster/dm/magic-item |
| Generation | One grounded prompt (user message) | Per-mode **system** personas; GM is creative (relaxed gate, may invent, flags it) |
| Theme | Dark only | Light Parchment default + dark Tavern toggle, persisted |
| Users / history | None | Stub user menu (Avatar) + per-mode conversation list (localStorage), seams for real auth/persistence |
| Theme toggle / a11y | — | 44px touch floor, focus rings, accessible names, `prefers-reduced-motion` honored |

## Work Done
- **F1 — Design-system foundation** (`28c8db6`): adopt 8 token CSS files, `ThemeProvider`/`useTheme`, parchment, brand/favicon.
- **F4 — Multi-mode backend** (`6e82018`): `ChatMode` enum + backward-compatible API; per-mode personas; `_scope_for_mode` + `book_slugs` retrieval filter; GM relaxed gate; `StubSecondaryRetriever` + `_merge_results`.
- **F2 — Component library** (`cc89d56`): 10 components as TSX wired to tokens (Button, IconButton, TextField+onKeyDown, Switch, Card, Chip, Avatar, Badge+nat1, DiceRoll, ChatMessage).
- **F3 — App shell & nav** (`6add9cb`): `AppNav` view machine, Landing, WorkspaceShell, LeftNav (4 modes), TopBar theme toggle, stub `CurrentUser` + UserMenu.
- **F5 — Chat integration** (`018ee4c`): mode+conversation-aware `useChat`/`postChat`, `ConversationStore` (localStorage + memory), `ChatPane` feed/composer/sources/DiceRoll, LeftNav conversation list.
- **F6 — Polish & QA** (`703eddf`): a11y + reduced-motion pass, full e2e smoke, dead-code removal (ExchangeView/ChatForm), README + ui/README refresh.

Churn: 81 files, +7,366 / −356.

## Beads Completed
| Beads ID | Title | Status |
|----------|-------|--------|
| 4wu | Epic — Aetheril design system + multi-mode assistant | closed at ship |
| 4wu.1 | Design-system foundation (tokens + theming) | closed |
| 4wu.2 | Aetheril component library (10 components) | closed |
| 4wu.3 | App shell & navigation (+ stub user) | closed |
| 4wu.4 | Multi-mode chat backend (Sage/Spell/Rules/GM) | closed |
| 4wu.5 | Chat experience integration | closed |
| 4wu.6 | Polish & QA (a11y, reduced-motion, docs) | closed |

All 21 child tasks (4wu.1.1 … 4wu.6.2) closed with test evidence — none deferred.

## Test It Yourself (walkthrough)
1. **Automated (no services needed):**
   ```bash
   cd repos/rag-chat/ui && bunx vitest run        # 267 passed
   cd repos/rag-chat && uv run --with pytest --with fastapi --with "psycopg[binary]" --with httpx python -m pytest service ingestion -q   # 199 passed
   ```
2. **The app UI:**
   ```bash
   cd repos/rag-chat/ui && bun run dev            # http://localhost:5173
   ```
   - Landing renders with the Aetheril brand → click **Enter the Tavern**.
   - Workspace: switch between **Sage / Spell / Rules / GM** in the left nav; toggle **light/dark** in the top bar; open the **user menu** (stub Avatar).
   - Start a conversation per mode (listed per-mode in the nav).
3. **Full stack with real answers** (needs `repos/rag-chat/.env` with `OPENAI_API_KEY`):
   ```bash
   cd repos/rag-chat && docker compose up --build   # http://localhost:5173
   ```
   - Ask Spell mode about a spell, GM mode to invent an NPC — note GM may invent (creative), others stay grounded with citations.

## Follow-ups / Known Gaps
- **Stubbed by design (this run):** real authentication, DB-backed conversation persistence, and the real second "world" retrieval source for GM (only the `StubSecondaryRetriever` seam exists). All behind clean seams.
- **Fonts** load from the Google Fonts CDN (self-hosting deferred — needs network in prod).
- **Minor:** size-prop naming differs across components (Button `small|medium|large` vs DiceRoll `sm|md|lg`) — standardize later.
- File new Beads issues under a follow-up epic when these are picked up.
