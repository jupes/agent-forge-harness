# Research: rag-chat-aetheril-overhaul — App Shell, Users (stub) & Navigation
Generated: 2026-06-21
Repo: rag-chat (UI)
Phase: research (1/4) — workstream doc

---

## Goal

Wire the rag-chat React+Vite+TS UI with full Aetheril app-shell structure: a
Landing screen, a workspace with left-nav switching between chat modes (sage /
spell / rules / gm), a stubbed current-user context with an avatar/user-menu,
and a stubbed conversation history store (localStorage-persisted) with a clean
seam for a real backend later. No real auth, no server-side persistence this
run.

---

## What the Code Says (answered by exploration)

### Current app structure (no router, single page)

**Entry:** `repos/rag-chat/ui/src/main.tsx:1-10` — bare `createRoot` wrapping
`<App />`. No router, no provider tree.

**App component:** `repos/rag-chat/ui/src/App.tsx:8-51`
- Single screen: a `<div className="app">` with `<header>`, `<main
  className="exchanges">`, `<footer>` (sticky composer).
- State ownership: `const { exchanges, send, pending } = useChat()` — all chat
  state lives in `useChat`.
- Header carries a hardcoded title "D&D 5e Sage" and an `<Export ↓>` button.
- No concept of mode, conversation, or user.

**useChat hook:** `repos/rag-chat/ui/src/useChat.ts:22-54`
- Receives an injectable `post` function (defaults to `postChat`), returns
  `{ exchanges, send, pending }`.
- `exchanges: Exchange[]` is a flat in-memory array owned by hook-local state.
- `nextId` is a local `useRef` counter; no stable conversation ID.
- The `pendingRef` guard blocks double-submit but is purely in-memory, not
  serializable.
- The `post` injection is the key testability seam — tests pass a fake
  `PostFn` directly without mocking the module (`useChat.test.tsx:15-46`).

**API client:** `repos/rag-chat/ui/src/api.ts:28-55`
- `postChat(prompt, fetchImpl?)` — POSTs `{ prompt }` to `/chat`.
- Returns `ChatResult` (discriminated union: `{kind:'ok',response}` |
  `{kind:'error',message}`).
- No `mode`, no `conversationId` in the body today.

**Test setup:** vitest + jsdom + @testing-library/react + jest-dom (via
`src/test-setup.ts`). Vitest config at `vite.config.ts:15-19`. Tests in
`src/*.test.ts(x)` and `src/components/components.test.tsx`.

**Dependencies today** (`package.json:12-35`):
- Runtime: `react@^19.2.6`, `react-dom@^19.2.6` — nothing else.
- No router (`react-router-dom` absent), no state-management lib, no design-system package.

**CSS:** Custom hand-rolled dark grimoire theme (`index.css`, `App.css`). The
Aetheril design system is not installed; its tokens live under
`repos/aetheril-design-system/source/tokens/`. All Aetheril components are raw
`.jsx` + `.d.ts` source files — no npm package exists.

**Deployment:** `repos/rag-chat/service/app.py:62-66` — FastAPI mounts
`ui/dist/` at `/` with `StaticFiles(html=True)` after its own `/chat` and
`/healthz` routes. The Vite dev server proxy (`vite.config.ts:8-13`) forwards
`/chat` and `/healthz` to `localhost:8000`. The static-file mount uses
`html=True` which serves `index.html` for any unmatched path — this is a
**catch-all SPA fallback**, equivalent to nginx `try_files $uri
/index.html`. Deep links will work correctly for hash-based or state-based
navigation but will also work with `BrowserRouter` if index.html is always
returned.

---

### Design-system app shell composition (regions/nav/user menu/conversation list)

**AppShell** (`repos/aetheril-design-system/source/ui_kits/aetheril-app/AppShell.jsx:1-18`):
- Three-screen state machine: `screen ∈ {landing, campaigns, chat}`.
- Dark/light toggle via `document.documentElement.setAttribute('data-theme', …)`.
- No URL, no router — pure React state.

**Landing** (`Landing.jsx:1-27`):
- Centered hero: logo, tagline, email field, "Enter the Tavern" + "Continue as
  guest" buttons. The email field and buttons both call `onBegin()` — no real
  auth, just navigation to campaigns.

**CampaignList** (`CampaignList.jsx:1-45`):
- Header row: "Your Campaigns" title + "New Campaign" button.
- Grid of `Card`s, each using `Avatar` (icon + tone), `Badge` (LIVE), `Chip`
  (system + player count).
- Cards navigate to `chat` screen on click.

**ChatView** (`ChatView.jsx:40-163`):
- Two-column: `<aside>` (left sidebar, 268px fixed) + `<main>` (flex-1).
- **Sidebar** regions (top to bottom):
  - Top bar: `IconButton` (back), logo mark, wordmark.
  - "The Party" label + list of `PartyMember` rows (Avatar, name, class, HP).
  - "Scene" label + filter Chips.
  - Bottom: dark-mode Switch.
- **Main** regions:
  - `<header>`: Avatar (DM icon) + campaign title/session subtitle + three
    `IconButton`s (Recap, Inventory, More).
  - Feed: scrollable div with `ChatMessage` + `DiceRoll` rows.
  - Composer: suggestion Chips + roll button + `TextField` + send `IconButton`.

**Design-system components used in shell (all have `.d.ts` + `.jsx` source):**
- `Avatar` (`Avatar.d.ts:4-19`) — `src?`, `name?`, `icon?`, `size?`, `tone?`,
  `ring?`. Falls back initials → icon. Tone maps to CSS token pairs.
- `IconButton` (`IconButton.d.ts:4-18`) — `icon`, `variant?`, `size?`,
  `selected?`, `ariaLabel`, `onClick`.
- `Chip` (`Chip.d.ts:4-18`) — `label`, `type?` (assist/filter/input/suggestion),
  `icon?`, `selected?`, `onClick`.
- `Card` (`Card.d.ts:4-16`) — `variant?`, `interactive?`, `onClick`.

**Distribution:** The design system has NO npm package. Components are
individual `.jsx` files with named ES-module exports (`export function Avatar`)
and matching `.d.ts` declarations. The consuming project must copy or path-alias
the source files. The ui-kit's `index.html` uses a compiled `_ds_bundle.js` via
CDN/UMD — that mechanism does not apply to a Vite build. **The right strategy
for Vite: copy (or symlink) the component source directory into
`ui/src/ds/` and import directly**, e.g.
`import { Avatar } from './ds/communication/Avatar'`.

---

## Recommended Design

### Routing / navigation approach (with justification)

**Recommendation: state/context view-switcher — no new dependency.**

Rationale:
1. **No router in `package.json` today.** Adding `react-router-dom` (~50 kB
   gzipped after tree-shaking) is the only way to get URL-synced navigation,
   but the Aetheril reference app (`AppShell.jsx`) itself uses a plain
   `React.useState` state machine with three screens — proof the design system
   is built for this pattern.
2. **URL deep-linking is a nice-to-have, not a requirement this run.** The
   brief says "Landing → workspace → per-mode chat navigation". None of these
   need bookmarkable URLs for the stub run; modes are short-lived UI state.
3. **FastAPI `StaticFiles(html=True)` does serve `index.html` as a fallback**
   for unknown paths, so a future switch to `BrowserRouter` is safe when the
   team wants URLs. The seam cost is low.
4. **Fewer moving parts = easier to test.** The view-switcher is a plain
   context value; no `MemoryRouter` wrapper needed in test renders.

**Implementation sketch:**

```tsx
// src/navigation/AppNavContext.tsx
export type Screen = 'landing' | 'workspace'
export type ChatMode = 'sage' | 'spell' | 'rules' | 'gm'

export interface AppNavState {
  screen: Screen
  mode: ChatMode
  conversationId: string | null
  goToWorkspace: (mode?: ChatMode) => void
  setMode: (mode: ChatMode) => void
  setConversationId: (id: string | null) => void
  goToLanding: () => void
}

export const AppNavContext = React.createContext<AppNavState>(…defaultStub…)

export function AppNavProvider({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = React.useState<Screen>('landing')
  const [mode, setMode] = React.useState<ChatMode>('sage')
  const [conversationId, setConversationId] = React.useState<string | null>(null)
  …
  return <AppNavContext.Provider value={…}>{children}</AppNavContext.Provider>
}

export const useAppNav = () => React.useContext(AppNavContext)
```

`main.tsx` wraps `<App>` with `<AppNavProvider>` (and `<CurrentUserProvider>`,
`<ConversationStoreProvider>`). `App.tsx` becomes a thin router:

```tsx
export default function App() {
  const { screen } = useAppNav()
  return screen === 'landing' ? <LandingScreen /> : <WorkspaceShell />
}
```

**If URLs are added later:** swap `AppNavProvider` for a `BrowserRouter`-based
provider that reads/writes `window.location`. The context API (`useAppNav`)
stays identical to callers.

---

### Stub current-user context (+ seam for real auth)

**File:** `src/identity/CurrentUserContext.tsx`

```ts
// The shape callers consume — never changes regardless of auth impl.
export interface CurrentUser {
  id: string            // stub: 'guest'
  displayName: string   // stub: 'Adventurer'
  initials: string      // derived from displayName
  avatarUrl?: string    // stub: undefined → Avatar falls back to initials
}

export interface CurrentUserContextValue {
  user: CurrentUser
  // Stub: no-ops. Real auth swaps these implementations.
  signOut: () => void
  editProfile: () => void
}
```

**Provider implementation (stub):**

```tsx
const STUB_USER: CurrentUser = { id: 'guest', displayName: 'Adventurer',
  initials: 'AV' }

export function CurrentUserProvider({ children }: { children: React.ReactNode }) {
  // Real auth: replace useState with useAuth() hook from your auth library.
  const [user] = React.useState<CurrentUser>(STUB_USER)
  return (
    <CurrentUserContext.Provider value={{ user, signOut: noop, editProfile: noop }}>
      {children}
    </CurrentUserContext.Provider>
  )
}
export const useCurrentUser = () => React.useContext(CurrentUserContext)
```

**User menu placement:** Bottom of the left nav sidebar (same slot as
ChatView's dark-mode Switch row). Render `<Avatar name={user.displayName}
tone="gold" size={36} />` as a trigger button, with a popover/dropdown showing
"Profile" (stub) and "Sign Out" (stub `signOut()` no-op). Use the Aetheril
`Avatar` component (`ds/communication/Avatar.jsx`) — initials fallback renders
automatically when `src` is absent and `icon` is absent.

**Auth seam contract:** `CurrentUserProvider` is the only place that knows
where the user comes from. Swap in a real provider (OAuth callback, JWT
decode, session cookie) without touching any consumer. The `CurrentUser`
interface is the stable boundary.

---

### Stubbed conversation store (+ seam for real persistence)

**Concept:** Each chat mode has its own list of conversations. A "conversation"
is a named bucket that holds a sequence of exchanges. The active conversation
is selected by `conversationId`. On first use per mode, a default conversation
is auto-created.

**Interface (the persistence seam):**

```ts
// src/conversations/types.ts
export interface Conversation {
  id: string               // uuid or timestamp-based
  mode: ChatMode
  title: string            // user-editable; default: "New conversation"
  createdAt: string        // ISO timestamp
  updatedAt: string
}

// The backend adapter interface — implement LocalStorageConversationStore now,
// swap for ApiConversationStore later.
export interface ConversationStore {
  list(mode: ChatMode): Conversation[]
  create(mode: ChatMode, title?: string): Conversation
  rename(id: string, title: string): void
  remove(id: string): void
}
```

**LocalStorage implementation:**

```ts
// src/conversations/LocalStorageConversationStore.ts
const KEY = 'rag-chat:conversations'

export class LocalStorageConversationStore implements ConversationStore {
  private load(): Conversation[] {
    try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
  }
  private save(rows: Conversation[]) {
    localStorage.setItem(KEY, JSON.stringify(rows))
  }
  list(mode: ChatMode) { return this.load().filter(c => c.mode === mode) }
  create(mode: ChatMode, title = 'New conversation') {
    const c: Conversation = { id: crypto.randomUUID(), mode, title,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    this.save([...this.load(), c])
    return c
  }
  rename(id: string, title: string) {
    this.save(this.load().map(c => c.id === id
      ? { ...c, title, updatedAt: new Date().toISOString() } : c))
  }
  remove(id: string) { this.save(this.load().filter(c => c.id !== id)) }
}
```

**React context wrapper:**

```tsx
// src/conversations/ConversationStoreContext.tsx
const ConversationStoreContext = React.createContext<ConversationStore>(…)

export function ConversationStoreProvider({ store = new LocalStorageConversationStore(),
    children }: { store?: ConversationStore; children: React.ReactNode }) {
  return <ConversationStoreContext.Provider value={store}>{children}</ConversationStoreContext.Provider>
}
export const useConversationStore = () => React.useContext(ConversationStoreContext)
```

The `store` prop default makes the stub plug in automatically in production;
tests inject a `MemoryConversationStore` (or a `vi.fn()` mock) without touching
localStorage.

**Exchange persistence (stub):** Conversation *metadata* (list, titles) goes to
localStorage. The *exchange list* (messages) stays in `useChat` in-memory for
now. They are linked by `conversationId` in `useChat`'s state; when the user
switches conversation the exchange list clears (or could be seeded from
localStorage if you add a second storage key). For the stub run: clear on
switch, note the seam clearly in comments.

---

### How useChat evolves (conversation-aware, still testable)

**Current signature:** `useChat(post?: PostFn)` → `{ exchanges, send, pending }`

**Evolved signature:**

```ts
// src/useChat.ts
export interface UseChatOptions {
  post?: PostFn
  mode: ChatMode
  conversationId: string | null
}

export function useChat({ post = postChat, mode, conversationId }: UseChatOptions)
  : { exchanges: Exchange[]; send: (prompt: string) => void; pending: boolean }
```

**Key changes:**
1. `mode` and `conversationId` are passed in (from `useAppNav`), not owned by
   the hook. The hook is a pure executor, not a router.
2. When `conversationId` changes, clear `exchanges` (via a `useEffect` keyed on
   `conversationId`). This is the "switch conversation = fresh view" behavior for
   the stub.
3. The `PostFn` type widens to accept mode + conversationId:

```ts
type PostFn = (
  prompt: string,
  mode: ChatMode,
  conversationId: string | null,
) => Promise<ChatResult>
```

The default `postChat` implementation gains these params and passes them to the
API (see next section). Tests inject a `PostFn` stub that ignores them (or
asserts on them) — the injection seam is unchanged.

**Backwards compatibility for existing tests:** The existing `useChat.test.tsx`
passes a `post` function and calls `send`. After the refactor, the hook factory
requires `{ post, mode, conversationId }` — existing tests just need to be
updated to pass `{ post: myPost, mode: 'sage', conversationId: null }`. This is
a mechanical change, not a design break.

**No global store needed.** Exchanges are ephemeral per conversation session.
The `ExchangeView`, `ChatForm`, and `SourceList` components are pure — no
changes needed.

---

### Wiring mode + conversationId to postChat

**Updated API function:**

```ts
// src/api.ts
export async function postChat(
  prompt: string,
  mode: ChatMode,
  conversationId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  let res: Response
  try {
    res = await fetchImpl('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode, conversationId }),
    })
  } catch { … }
  …
}
```

The discriminated-union `ChatResult` return type is unchanged. The backend
`ChatRequest` model (`service/models.py:8-10`) gains optional fields:

```python
class ChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    mode: str = Field(default='sage')
    conversation_id: str | None = None
```

The existing `api.test.ts` test "POSTs the prompt as JSON to /chat" will need
to assert the new body shape. The test at `api.test.ts:62-74` captures the
request body — update the expectation to include `mode` and `conversationId`.

**Shell wiring:** `WorkspaceShell` calls `useAppNav()` to get `mode` and
`conversationId`, then passes them to `useChat`:

```tsx
// inside WorkspaceShell
const { mode, conversationId } = useAppNav()
const { exchanges, send, pending } = useChat({ mode, conversationId })
```

`ChatPane` (the mode's view) receives `exchanges`, `send`, `pending` as props —
same as today, no prop drilling of mode into leaf components.

---

### App shell composition — React/TS component map

The following files need to be created (all under `ui/src/`):

```
ui/src/
  ds/                          ← copy of aetheril-design-system/source/components/ 
    actions/IconButton.jsx + .d.ts
    communication/Avatar.jsx + .d.ts
    containment/Card.jsx + .d.ts  (ConversationList cards)
    containment/Chip.jsx + .d.ts  (mode nav chips)
    forms/TextField.jsx + .d.ts   (composer)
    (+ any token CSS imported once in index.css)

  identity/
    CurrentUserContext.tsx        ← stub user + context

  navigation/
    AppNavContext.tsx             ← screen + mode + conversationId state

  conversations/
    types.ts                     ← Conversation + ConversationStore interfaces
    LocalStorageConversationStore.ts
    ConversationStoreContext.tsx

  components/
    LandingScreen.tsx            ← hero, "Enter as guest" → goToWorkspace()
    WorkspaceShell.tsx           ← two-col layout: LeftNav + ChatPane
    LeftNav.tsx                  ← logo, mode list, conversation list, user menu
    ModeNavItem.tsx              ← single nav row (Chip or custom item)
    ConversationList.tsx         ← per-mode convo list (uses ConversationStore)
    UserMenu.tsx                 ← Avatar trigger + popover (Profile/Sign Out stubs)
    ChatPane.tsx                 ← header + exchanges feed + composer (wraps existing)
    (existing: ChatForm, ExchangeView, SourceList — unchanged)
```

**Region breakdown for WorkspaceShell:**

```
┌────────────────────────────────────────────┐
│ LeftNav (268px fixed, surface-container)   │
│  ┌──────────────────────────────────────┐  │
│  │ Logo + app name                      │  │
│  │ Mode nav: Sage / Spell / Rules / GM  │  │  ← Chip[filter] or custom rows
│  │ ── Conversations (per active mode) ── │  │
│  │  [+ New] button                      │  │
│  │  ConversationList (Card rows)        │  │
│  │  (title, date, active indicator)     │  │
│  │                                      │  │
│  │ [bottom] Avatar + name → UserMenu    │  │
│  └──────────────────────────────────────┘  │
│                                             │
│ ChatPane (flex-1)                           │
│  ┌──────────────────────────────────────┐  │
│  │ Top bar: mode title + action btns   │  │
│  │ Exchange feed (ExchangeView list)   │  │
│  │ Composer (ChatForm)                 │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

**State ownership:**
- `AppNavContext`: `screen`, `mode`, `conversationId` — the navigation layer.
- `ConversationStoreContext`: CRUD ops on the store — the data layer.
- `useChat({ mode, conversationId })`: the exchange list — ephemeral per conversation view.
- `CurrentUserContext`: current user identity.
- All four are provided at the `main.tsx` / `App.tsx` boundary.

---

### Test plan (vitest + Testing Library)

**No new test infrastructure needed.** Existing `jsdom` + `@testing-library/react` + `vitest` + jest-dom setup handles everything.

**1. AppNavContext (`src/navigation/AppNavContext.test.tsx`)**
- Render `<AppNavProvider>` + a consumer, assert default screen is `'landing'`.
- Call `goToWorkspace('spell')`, assert screen switches and mode is `'spell'`.
- Call `setConversationId('abc')`, assert conversationId updates.

**2. CurrentUserContext (`src/identity/CurrentUserContext.test.tsx`)**
- Render provider, `useCurrentUser()` returns stub user with `id: 'guest'`.
- `signOut` and `editProfile` are callable without throwing.

**3. ConversationStore — unit tests (`src/conversations/LocalStorageConversationStore.test.ts`)**
- Test against a `MemoryConversationStore` (same interface, Map-backed) so no
  localStorage mock needed for the interface tests.
- LocalStorage impl: use `vi.stubGlobal` on `localStorage` if needed, or
  vitest's jsdom provides a real `localStorage`.
- Assert: `create` returns a conversation with `id` and correct `mode`; `list`
  filters by mode; `rename` updates title; `remove` deletes.

**4. useChat evolution (`src/useChat.test.tsx` — update existing)**
- Add `mode` and `conversationId` to all `renderHook(() => useChat({post, mode: 'sage', conversationId: null}))` calls.
- Add test: switching `conversationId` clears exchanges (use `rerender`).
- Existing send/pending/error/double-submit/empty tests remain structurally identical.

**5. LandingScreen (`src/components/LandingScreen.test.tsx`)**
- Render with a mock `AppNavContext` that captures `goToWorkspace` calls.
- Click "Enter as Guest" → `goToWorkspace` called.

**6. WorkspaceShell + LeftNav (`src/components/WorkspaceShell.test.tsx`)**
- Render shell with navigation in `workspace` state, mode `'sage'`.
- Assert left nav shows all four mode items.
- Click "Spell" → `setMode('spell')` called.
- Assert ConversationList renders conversations for the active mode.

**7. UserMenu (`src/components/UserMenu.test.tsx`)**
- Render with a stub `CurrentUserContext` (user = `{displayName: 'Test User', initials: 'TU'}`).
- Assert Avatar with initials "TU" is visible.
- Open the menu, assert "Sign Out" item present.
- Click "Sign Out" → stub `signOut` called.

**8. Wiring test (integration, `src/components/ChatPane.test.tsx`)**
- Replace `components.test.tsx` App integration test with a `ChatPane` test.
- Wrap with all providers (or use the context default stubs).
- `vi.stubGlobal('fetch', …)` as today.
- Assert full round-trip: submit → loading → answer, same as `components.test.tsx:87-96`.

**9. Updated api.test.ts**
- "POSTs the prompt as JSON to /chat" test: assert body includes
  `{ prompt, mode: 'sage', conversationId: null }`.

**Pattern for provider wrapping in tests (DRY helper):**

```tsx
// src/test-utils.tsx
export function renderWithProviders(ui: React.ReactElement, options?: {
  navState?: Partial<AppNavState>
  user?: CurrentUser
  store?: ConversationStore
}) {
  return render(
    <AppNavProvider initialState={options?.navState}>
      <CurrentUserProvider initialUser={options?.user}>
        <ConversationStoreProvider store={options?.store}>
          {ui}
        </ConversationStoreProvider>
      </CurrentUserProvider>
    </AppNavProvider>
  )
}
```

Providers accept optional `initial*` props for test injection (just like `useChat` accepts `post`).

---

## Risks / Friction

1. **Design-system CSS token loading.** The Aetheril CSS tokens
   (`repos/aetheril-design-system/source/tokens/*.css`) and Google Font
   imports (`tokens/fonts.css`) must be loaded in `index.html` or imported in
   `index.css`. The existing dark grimoire CSS (`index.css`, `App.css`) uses
   completely different custom properties (`--page-bg`, `--gold`, etc.) and will
   conflict with Aetheril's `--md-sys-color-*` and `--aether-*` tokens. **This
   is a full CSS migration.** Plan: delete/replace `index.css` + `App.css` with
   Aetheril tokens; update `ExchangeView` and `ChatForm` className references
   accordingly.

2. **Design-system component distribution — no npm package.** The `.jsx`
   components use `import React from 'react'` (default import). React 19 (the
   current dep) removed the default export in some configurations. The Aetheril
   JSX files may need `import * as React from 'react'` adjustments, or
   Vite's JSX auto-runtime must be confirmed active (it is, via `@vitejs/plugin-react`).
   Copy the components to `ui/src/ds/` and fix imports during copy.

3. **Exchange list clearing on conversation switch.** The stub clears exchanges
   when `conversationId` changes (`useEffect` dependency). If a user accidentally
   clicks a different conversation, messages are lost. For the stub run this is
   acceptable — but document it prominently in comments as a known regression
   vs. a real backend that would reload history.

4. **`crypto.randomUUID()` in test environment.** jsdom 29 (the version in
   devDeps) supports `crypto.randomUUID()`, but double-check; if not, polyfill
   with a simple `Math.random().toString(36)` for the stub. Vitest 4 + jsdom 29
   should be fine.

5. **`postChat` signature change breaks api.test.ts.** The test at
   `api.test.ts:62-74` asserts `body === { prompt }`. Adding `mode` and
   `conversationId` to the body is a simple extension but requires test updates —
   flag this for the implement phase.

6. **Left-nav responsive behavior.** The design system's ChatView uses a fixed
   268px sidebar. On narrow viewports (mobile) this will overflow. For the stub
   run, accept the min-width constraint; note it as a follow-up.

7. **The `App` integration test in `components.test.tsx:87-96`** renders
   `<App />` directly and stubs `fetch`. After the shell refactor, `<App>` wraps
   providers and renders a `LandingScreen` first — the test will need to
   navigate to workspace before submitting. Update test or replace with
   `ChatPane` test.

---

## Open Questions for the User (only what code cannot answer)

1. **Landing screen required or skip-able?** The Aetheril ref has a Landing
   screen. For a tool used internally (no real auth), should the app open
   directly to the workspace (last-used mode), or always show the Landing first?
   If Landing is skipped, `AppNavProvider` initializes to `'workspace'` and
   `LandingScreen` is deferred to later.

2. **Conversation history scope: per-mode or global?** The current design stores
   conversations keyed by mode (`list(mode)`). An alternative is a flat list
   with a mode tag, letting users see all conversations in one list. Which
   matches the intended UX?

3. **Default conversation behavior on first load:** When a user visits the app
   for the first time (no localStorage), should a "default" conversation be
   auto-created, or should the conversation list be empty with a "New" CTA
   prominent?

4. **Conversation title auto-generation:** Should the title default to "New
   conversation" and require manual rename, or auto-generate from the first
   prompt (e.g., first 40 chars)? Auto-generation from first prompt is easy
   (update title after first `send`) but adds a `rename` side-effect to
   `useChat`.

5. **Dark/light theme toggle:** The current app is dark-only. Aetheril supports
   both via `[data-theme="dark"]`. Should the Candlelight toggle be part of this
   run, or dark-only for now?
