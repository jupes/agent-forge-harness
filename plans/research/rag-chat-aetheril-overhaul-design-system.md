# Research: rag-chat-aetheril-overhaul — Design System Port (frontend)
Generated: 2026-06-21
Repo: rag-chat (UI) ; Source: aetheril-design-system
Phase: research (1/4) — workstream doc

## Goal

Map exactly how to port the aetheril-design-system into the rag-chat React+Vite+TS UI.
Workstream scope: design-system foundation + component library + app-shell layout.
Multi-mode contract: `mode: 'sage'|'spell'|'rules'|'gm'` — left nav switches modes, each is a chat surface.

---

## What the Code Says (answered by exploration)

### Current UI inventory (keep vs replace)

**Entry points / wiring**
- `repos/rag-chat/ui/index.html` — barebones; no font links, no theme attribute; loads `/src/main.tsx`.
- `repos/rag-chat/ui/src/main.tsx` — StrictMode root render, imports `./index.css` then `App`.
- `repos/rag-chat/ui/src/App.tsx` — monolithic: header + scrollable exchange list + sticky footer with ChatForm. Single-mode, no nav, no sidebar.
- `repos/rag-chat/ui/src/App.css` — 235 lines of hand-rolled dark grimoire CSS; all scoped to `.app`, `header`, `footer`, `.exchange`, `.prompt`, `.answer`, `.sources`, `.chat-form`. Pure CSS with local custom properties.
- `repos/rag-chat/ui/src/index.css` — 39 lines; defines the grimoire palette as `:root` custom properties (`--page-bg`, `--ink`, `--ink-dim`, `--gold`, `--gold-dim`, `--blood`, `--rule`, `--prompt-bg`, etc.); sets `font-family: 'Segoe UI', system-ui` and `color-scheme: dark`.

**KEEP (pure logic, zero styling)**
- `repos/rag-chat/ui/src/api.ts` — discriminated-union `ChatResult` pattern, `postChat(prompt, fetchImpl?)`. Keep 100% as-is. The multi-mode contract only needs `prompt` extended or wrapped; the union pattern is ideal.
- `repos/rag-chat/ui/src/useChat.ts` — `useChat(postFn?)` hook; manages `Exchange[]` state, pending gate, retry. Keep as-is; the new multi-mode shell will compose one `useChat` instance per active chat surface.
- `repos/rag-chat/ui/src/exportChat.ts` — `buildExportPayload` + `exportChat`. Keep; UI hook just needs a new icon-button trigger.

**REPLACE (styling + layout)**
- `repos/rag-chat/ui/src/App.tsx` — replace entirely with a new multi-mode `App` that renders `AppShell`.
- `repos/rag-chat/ui/src/App.css` — delete; all styles come from the design-system tokens + component inline styles.
- `repos/rag-chat/ui/src/index.css` — replace body/reset with the DS `base.css` import chain; remove grimoire palette.
- `repos/rag-chat/ui/src/components/ChatForm.tsx` — replace with composer using DS `TextField` (multiline, outlined) + `IconButton` (send, filled) + `Chip` quick-actions. Keep the Enter-submits / Shift+Enter logic.
- `repos/rag-chat/ui/src/components/ExchangeView.tsx` — replace with DS `ChatMessage` (role=player/dm/system). Pending state becomes the three-dot bounce indicator from ChatView.jsx. Error state maps to a `system` role ChatMessage with a retry Button.
- `repos/rag-chat/ui/src/components/SourceList.tsx` — keep or lightly restyle; the `<details>/<summary>` pattern is still fine. Can be wrapped in a `Card` (outlined, not padded).

---

### Token layer (how to adopt + theming + fonts/icons)

**Adoption strategy — plain CSS import, no transform needed**

All tokens in `repos/aetheril-design-system/source/tokens/*.css` are plain CSS custom properties in `:root` and `[data-theme="dark"]`. They can be imported directly into the Vite app with zero pre-processing.

`repos/aetheril-design-system/source/styles.css` is a single file of `@import url(...)` statements that pulls in all 8 token files. In the Vite app, copy this file or inline its imports into `index.css`.

**Recommended import order in `src/index.css`:**
```css
/* 1. Google Fonts CDN (fonts.css — must be first; CDN @imports must precede all rules) */
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700;800&...');
@import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0&display=swap');
/* 2. Token files (can be relative paths or copy-pasted) */
@import url('../design-system/tokens/colors.css');
@import url('../design-system/tokens/typography.css');
/* ... etc */
```

**Two strategies for token file location:**
- Option A: Copy `tokens/` directory into `ui/src/design-system/tokens/` and import relatively. Clean, no runtime CDN deps for tokens.
- Option B: Reference tokens from `repos/aetheril-design-system/source/` via relative paths from `ui/src/`. Works locally; breaks in CI/docker unless both repos are present.
- **Recommendation: Option A** — copy the 8 token CSS files into `ui/src/design-system/tokens/` and `styles.css` as the entry point. Add `ui/src/design-system/components/` for the JSX components.

**Dark mode switching**

`repos/aetheril-design-system/source/tokens/colors.css` line 81: `[data-theme="dark"]` on the document root flips all `--md-sys-color-*` and `--aether-*` roles. The light theme is the `:root` default (parchment ground). The `AppShell.jsx` reference shows: `document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')`.

In the React app, store a `isDark: boolean` in React state at the `App` level (or a context), and call `document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')` in a `useEffect`. Expose it via a `Switch` component in the left nav footer.

**Fonts — CDN vs self-host**

The current `index.html` has NO font links. The design system loads fonts via `@import url('https://fonts.googleapis.com/...')` inside `tokens/fonts.css`. In a Vite app, this is fine: CSS `@import` for Google Fonts CDN works when the CSS file is imported by a JS module.

The `fonts.css` loads:
- Cinzel (400–800) — display/headlines
- Cinzel Decorative (400, 700, 900) — wordmark only
- Spectral (300–700, italic variants) — body/chat text
- Mulish (300–800, italic) — UI chrome
- JetBrains Mono (400–600) — dice/stats
- Material Symbols Rounded (variable font) — icon system

**For production** (nginx-served docker build), self-hosting fonts avoids CDN dependency and eliminates FOUC/layout-shift. Use `vite-plugin-webfont-dl` or download the font files and place them in `ui/public/fonts/`. This is a friction point (see Risks).

**Icon system**

Material Symbols Rounded is loaded as a Google Fonts variable font. Usage: `<span class="material-symbols-rounded">casino</span>`. The DS `.material-symbols-rounded` utility class is defined in `fonts.css` (lines 16–31). Components use `className="material-symbols-rounded"` directly on spans — this class must be present in the page.

In TSX, wrap it as a typed helper: `export const Icon = ({ name }: { name: string }) => <span className="material-symbols-rounded">{name}</span>` — prevents typos and makes icons grepable.

**Custom properties used by the components — complete map**

Colors: `--md-sys-color-primary`, `--md-sys-color-on-primary`, `--md-sys-color-primary-container`, `--md-sys-color-on-primary-container`, `--md-sys-color-secondary`, `--md-sys-color-on-secondary`, `--md-sys-color-secondary-container`, `--md-sys-color-on-secondary-container`, `--md-sys-color-tertiary`, `--md-sys-color-on-tertiary`, `--md-sys-color-tertiary-container`, `--md-sys-color-on-tertiary-container`, `--md-sys-color-error`, `--md-sys-color-on-error`, `--md-sys-color-error-container`, `--md-sys-color-background`, `--md-sys-color-surface`, `--md-sys-color-on-surface`, `--md-sys-color-surface-variant`, `--md-sys-color-on-surface-variant`, `--md-sys-color-surface-container-lowest`, `--md-sys-color-surface-container-low`, `--md-sys-color-surface-container`, `--md-sys-color-surface-container-high`, `--md-sys-color-surface-container-highest`, `--md-sys-color-outline`, `--md-sys-color-outline-variant`, `--aether-arcane`, `--aether-on-arcane`, `--aether-arcane-container`, `--aether-on-arcane-container`, `--aether-nat20`, `--aether-nat20-container`, `--aether-nat1`, `--aether-nat1-container`, `--aether-gold-leaf`

Shape: `--aether-radius-button` (full/9999px), `--aether-radius-card` (16px), `--aether-radius-chip` (8px), `--aether-radius-field` (4px), `--aether-radius-sheet` (28px), `--md-sys-shape-corner-*` (none/xs/sm/md/lg/xl/full)

Elevation: `--md-sys-elevation-level0` through `--level5`; `--aether-elevation-rest/raised/floating/overlay`

Spacing: `--aether-space-0` through `--aether-space-24`; `--aether-gutter` (16px), `--aether-card-padding` (24px), `--aether-touch-min` (44px), `--aether-measure` (68ch)

Typography families: `--aether-font-display`, `--aether-font-body`, `--aether-font-ui`, `--aether-font-mono`, `--aether-font-flourish`

Motion: `--md-sys-motion-easing-standard`, `--md-sys-motion-easing-emphasized`, `--md-sys-motion-duration-short3` (150ms), `--aether-transition-button`, `--aether-transition-surface`

Z-index: `--aether-z-base/sticky/drawer/overlay/toast/tooltip` (0/100/200/300/400/500)

---

### Component contracts (all 10, prop surfaces)

All components live in JSX files. They need to be **converted to TSX** with the `.d.ts` contracts already provided as the source of truth. Components use **inline styles only** (no CSS classes beyond `material-symbols-rounded`), so they are portable with zero CSS conflicts.

**1. Button** (`components/actions/Button.d.ts` + `.jsx`)
```ts
interface ButtonProps {
  children?: ReactNode
  variant?: 'filled' | 'tonal' | 'elevated' | 'outlined' | 'text'  // default: 'filled'
  size?: 'small' | 'medium' | 'large'                                // default: 'medium'
  icon?: string          // Material Symbol ligature (leading)
  trailingIcon?: string  // Material Symbol ligature (trailing)
  disabled?: boolean
  fullWidth?: boolean
  type?: 'button' | 'submit' | 'reset'
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  style?: CSSProperties
}
```
**Used in rag-chat overhaul:** Yes. Composer send (but replaced by IconButton per ChatView pattern), retry in error state, export button.

**2. IconButton** (`components/actions/IconButton.d.ts` + `.jsx`)
```ts
interface IconButtonProps {
  icon: string           // required Material Symbol ligature
  variant?: 'standard' | 'filled' | 'tonal' | 'outlined'  // default: 'standard'
  size?: 'small' | 'medium' | 'large'                      // default: 'medium'
  selected?: boolean     // toggle — colors standard variant with primary
  disabled?: boolean
  ariaLabel?: string     // required for a11y (no visible label)
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  style?: CSSProperties
}
```
**Used:** Yes — send button (`icon="send"` variant=filled), dice button (`icon="casino"` variant=tonal), export (`icon="download"` standard), mode-nav buttons in left nav, three-dot menu in header.

**3. TextField** (`components/forms/TextField.d.ts` + `.jsx`)
```ts
interface TextFieldProps {
  label?: string
  value?: string
  onChange?: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  placeholder?: string
  variant?: 'filled' | 'outlined'   // default: 'outlined'
  type?: string
  leadingIcon?: string
  trailingIcon?: string
  supportingText?: string
  error?: boolean
  disabled?: boolean
  multiline?: boolean
  rows?: number
  fullWidth?: boolean
  style?: CSSProperties
}
```
**Used:** Yes — composer textarea (multiline=true, rows=2, outlined, fullWidth). Replaces the raw `<textarea>` in ChatForm. Note: the DS TextField does NOT forward an `onKeyDown` prop explicitly — the `...rest` spread in the JSX means it will work, but TypeScript types need to be extended to allow `onKeyDown`.

**4. Switch** (`components/forms/Switch.d.ts` + `.jsx`)
```ts
interface SwitchProps {
  checked?: boolean
  onChange?: (next: boolean) => void  // note: receives the new value, not an event
  disabled?: boolean
  icons?: boolean       // render check/close inside the handle
  ariaLabel?: string
  style?: CSSProperties
}
```
**Used:** Yes — dark/light theme toggle in nav footer. Note the `onChange` signature receives `boolean` directly (not a React event), which differs from standard `<input onChange>`.

**5. Card** (`components/containment/Card.d.ts` + `.jsx`)
```ts
interface CardProps {
  children?: ReactNode
  variant?: 'elevated' | 'filled' | 'outlined'  // default: 'elevated'
  interactive?: boolean   // hover elevation + state layer; pair with onClick
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
  padded?: boolean        // default 24px padding; default: true
  style?: CSSProperties
}
```
**Used:** Yes — mode/conversation list items (interactive, elevated), source citations (outlined, padded=false).

**6. Chip** (`components/containment/Chip.d.ts` + `.jsx`)
```ts
interface ChipProps {
  label: string        // required
  type?: 'assist' | 'filter' | 'input' | 'suggestion'  // default: 'assist'
  icon?: string
  selected?: boolean   // filter chips only
  onClick?: () => void
  onRemove?: () => void  // input chips only
  disabled?: boolean
  style?: CSSProperties
}
```
**Used:** Yes — mode-switcher nav (filter chips, one selected per active mode), quick-action suggestions in composer.

**7. Avatar** (`components/communication/Avatar.d.ts` + `.jsx`)
```ts
interface AvatarProps {
  src?: string          // image URL; fallback to icon or initials
  name?: string         // full name; split to initials
  icon?: string         // Material Symbol fallback
  size?: number         // pixel diameter; default: 40
  tone?: 'gold' | 'ember' | 'verdigris' | 'arcane'  // default: 'gold'
  ring?: boolean        // gilt ring (active speaker / DM)
  style?: CSSProperties
}
```
**Used:** Yes — DM avatar in chat header (tone=ember, ring=true, icon=auto_stories), user stub avatar in nav footer (tone=arcane, initials from name). The `ring` prop uses `--aether-gold-leaf` for the halo.

**8. Badge** (`components/communication/Badge.d.ts` + `.jsx`)
```ts
interface BadgeProps {
  children?: ReactNode
  tone?: 'primary' | 'neutral' | 'gold' | 'verdigris' | 'arcane' | 'error' | 'nat20'
  dot?: boolean         // 8px dot, ignores children
  style?: CSSProperties
}
```
**Used:** Marginally — `dot` variant for online/offline presence indicators in any party sidebar; `tone='nat20'` for a LIVE badge if needed. May not be used prominently in the MVP overhaul.

**9. DiceRoll** (`components/dnd/DiceRoll.d.ts` + `.jsx`)
```ts
interface DiceRollProps {
  die?: number          // sides (default: 20)
  value?: number        // face value rolled
  modifier?: number     // flat modifier (default: 0)
  label?: string        // caption above total, e.g. "Stealth check"
  rolling?: boolean     // spinning placeholder state
  size?: 'small' | 'medium' | 'large'  // default: 'medium'
  style?: CSSProperties
}
```
Crit coloring: nat20 = `--aether-nat20-container` bg + text; nat1 = `--aether-nat1-container` bg + text. Renders a `@keyframes aether-dice-spin` via an inline `<style>` tag — this is a self-contained component, no external keyframe needed.
**Used:** Yes — when the service returns a dice result in a system message (for `spell`/`gm` modes that might include rolls). In `sage`/`rules` mode, DiceRoll may not appear, but the component ships either way.

**10. ChatMessage** (`components/dnd/ChatMessage.d.ts` + `.jsx`)
```ts
interface ChatMessageProps {
  role?: 'dm' | 'player' | 'system'  // default: 'dm'
  author?: string       // display name; defaults to 'Dungeon Master' / 'You'
  avatar?: string       // image URL
  avatarIcon?: string   // Material Symbol for avatar fallback
  time?: string         // timestamp label
  children?: ReactNode  // the message body (text or DiceRoll or any node)
  style?: CSSProperties
}
```
Structure: DM = left-aligned, Spectral serif, `surface-container-low` bubble, border, level-1 shadow; Player = right-aligned, ember-filled bubble, no border; System = centered pill on `surface-container-high`, Mulish, full-radius.
Asymmetric bubble radius: player tail corner `extra-small` (4px), other corners `large` (16px); DM: top-left `extra-small`, other `large`.
**Used:** Yes — replaces both `ExchangeView` and the pending state. Map: `exchange.status==='pending'` → role=dm with three-dot indicator children; `exchange.status==='done'` → role=dm for response + role=player for prompt; `exchange.status==='error'` → role=system with error text + retry Button. The current `ExchangeView` section wrapper is replaced entirely by this component.

---

### App shell layout (regions + nav + user menu + conversation list)

**Reference: `ChatView.jsx` in the aetheril ui kit is the direct model for the rag-chat overhaul.**

The full two-panel layout:

```
┌──────────────────────────────────────────────────────┐
│ [logo] Aetheril                             [header] │
├─────────────┬────────────────────────────────────────┤
│ Left Nav    │  Chat Feed (scrollable)                │
│  268px      │                                        │
│  [mode nav] │  ChatMessage (dm) ...                  │
│  [conv list]│  ChatMessage (player) ...              │
│             │  ChatMessage (system/dice) ...         │
│             │────────────────────────────────────────│
│  [footer]   │  Composer                              │
│  [avatar]   │  [chips] [dice btn] [field] [send]    │
└─────────────┴────────────────────────────────────────┘
```

**Left sidebar (`aside`, 268px fixed, `surface-container-low`, border-right `outline-variant`)**

Top: logo-mark + wordmark (Cinzel Decorative, primary color) + back/close control.
Mode switcher (replacing "The Party" section from ChatView): four filter `Chip` rows for `sage | spell | rules | gm`. Only one selected at a time. Active mode is highlighted with secondary-container fill.
Conversation list: a scrollable list of `Card` (interactive, elevated) items showing past conversations per mode. This maps to the CampaignList pattern but inline in the sidebar. For MVP, this can be a stub list.
Footer: user stub (Avatar with initials, tone=arcane) + Mulish name label + theme Switch (`Candlelight` toggle, same as ChatView).

**Chat header (`header`, sticky top, `surface`, border-bottom `outline-variant`)**

Left: DM `Avatar` (ember, ring, icon=auto_stories, 36px) + campaign/session title (Cinzel, 18px) + subtitle (Mulish 12px, on-surface-variant).
Right: 2–3 `IconButton` (standard) — e.g. `auto_stories` (recap), `download` (export), `more_vert` (menu). The export function from `exportChat.ts` wires to the download button.

**Feed (`div.aether-parchment`, flex:1, overflow-y:auto)**

`max-width: 760px; margin: 0 auto` — constrained reading measure, matching `--aether-measure` (68ch).
`padding: 18px clamp(16px, 5vw, 56px)`.
Scrolls to bottom on new exchanges (same `useEffect` + `endRef` pattern as current `App.tsx:13`).

**Composer (sticky bottom, `surface`, border-top `outline-variant`)**

Same max-width constraint as feed.
Row 1 (optional): quick-action `Chip` row (suggestion type): e.g., "Ask the Sage", "Cast a Spell", "Check the Rules". These can insert placeholder text into the TextField.
Row 2: `IconButton` (casino/tonal, dice roll) + `TextField` (multiline outlined, fullWidth) + `IconButton` (send/filled/large).
Enter submits, Shift+Enter newline — same logic as current `ChatForm.tsx:27`.

**View routing**

The rag-chat overhaul does NOT need the Landing or CampaignList screens — the app goes straight to the chat shell. The `AppShell.jsx` reference has `screen` state; the rag-chat version just needs `mode` state: `'sage' | 'spell' | 'rules' | 'gm'`. Switching mode resets the visible exchange list (or keeps per-mode history if desired).

**User menu / avatar stub**

Per the cross-cutting contract, auth is a stub this run. The Avatar in the nav footer triggers no real menu — a `title` attribute or a placeholder `Card` popover is sufficient. No real auth flow.

---

### Build / test / lint setup

**Test runner**
Vitest 4.x (`devDependencies: "vitest": "^4.1.8"`). Configured in `vite.config.ts` under the `test` key:
```ts
test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.ts' }
```
`test-setup.ts` is a single line: `import '@testing-library/jest-dom/vitest'`. This loads the `toBeInTheDocument()` / `toHaveClass()` etc. matchers.

**Testing libraries**
- `@testing-library/react` 16.x + `@testing-library/user-event` 14.x — render + interaction.
- `@testing-library/jest-dom` 6.x — DOM matchers.
- `jsdom` 29.x — browser environment.
- Vitest globals (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`) are available without import because `globals: true`.

**How tests are written (pattern from existing tests)**
- Pure logic: plain `describe`/`it` with no mocks (e.g. `api.test.ts`, `exportChat.test.ts`).
- Hook tests: `renderHook` + `act` + `waitFor` (e.g. `useChat.test.tsx`).
- Component tests: `render` + `screen.getBy*` + `userEvent.*` (e.g. `components.test.tsx`).
- Integration: `vi.stubGlobal('fetch', vi.fn(...))` for full App flow.
- File naming: `*.test.ts` (pure) or `*.test.tsx` (JSX involved).

**`bun run` scripts**
```json
"dev": "vite",
"build": "tsc -b && vite build",
"lint": "eslint .",
"preview": "vite preview"
```
There is NO `test` script in `package.json` as written. Add: `"test": "vitest run"` and `"test:watch": "vitest"`.

**TypeScript**
- `tsconfig.app.json`: strict mode implied by `noUnusedLocals: true`, `noUnusedParameters: true`, `erasableSyntaxOnly: true`, `noFallthroughCasesInSwitch: true`. Target: ES2023. JSX: `react-jsx`.
- `moduleResolution: "bundler"` — Vite-native; import extensions like `.tsx` are allowed.
- `skipLibCheck: true` — won't validate `node_modules` types.

**ESLint**
`eslint.config.js` uses the flat-config API. Plugins: `eslint-plugin-react-hooks` (recommended), `eslint-plugin-react-refresh` (vite), `typescript-eslint` (recommended). Targets `**/*.{ts,tsx}` only. No CSS linting is configured.

**TypeScript for DS components**
The DS JSX components will need to be converted to TSX. The `.d.ts` files are the exact type contracts to use. Two approaches:
- A: Copy JSX → rename to TSX → add type annotations → import directly. No bundler-special handling needed.
- B: Leave as JSX, add `allowJs: true` to tsconfig, but this weakens strict-mode enforcement.
- **Recommendation: A** — convert to TSX. The components are small (40–115 lines each).

---

## Recommended Port Approach (concrete, ordered)

### Step 0 — Prep (no code changes)
1. Copy `repos/aetheril-design-system/source/tokens/` (8 CSS files) + `styles.css` into `repos/rag-chat/ui/src/design-system/tokens/` and `src/design-system/styles.css`.
2. Copy `repos/aetheril-design-system/source/assets/logo-mark.svg` into `repos/rag-chat/ui/public/logo-mark.svg`.

### Step 1 — Token layer
1. Replace `src/index.css` contents:
   - Keep `* { box-sizing: border-box }` and the `html, body { margin: 0 }` resets (will come from `base.css` anyway).
   - Remove all grimoire custom properties.
   - Add `@import './design-system/styles.css'` as the ONLY rule (styles.css chain imports fonts then all tokens).
2. Add `data-theme="light"` to `<html>` in `index.html` so the `:root` light theme is explicit. (Without it the DS `color-scheme: light` still applies, but explicit is cleaner.)
3. Delete `src/App.css`.

### Step 2 — Component library (TSX conversion)
For each of the 10 components, create `src/design-system/components/<Category>/<Name>.tsx`:
- Copy the JSX source.
- Add TypeScript types from the `.d.ts` file.
- Change `import React from 'react'` to named imports: `import { useState } from 'react'` etc.
- Export from a barrel: `src/design-system/components/index.ts`.
- Add the `Icon` helper: `export const Icon = ({ name, style }: { name: string; style?: React.CSSProperties }) => <span className="material-symbols-rounded" style={style}>{name}</span>`.

Priority order: `ChatMessage` → `Avatar` → `TextField` → `IconButton` → `Button` → `Chip` → `Card` → `DiceRoll` → `Badge` → `Switch`.

### Step 3 — App shell scaffold
Create `src/components/AppShell.tsx`:
```
AppShell (mode state + dark state + exchanges per mode)
├── LeftNav (aside 268px)
│   ├── NavHeader (logo + wordmark)
│   ├── ModeNav (Chip × 4: sage|spell|rules|gm — filter type, one selected)
│   ├── ConvList (scrollable, Card items — can be stub for MVP)
│   └── NavFooter (Avatar stub + theme Switch)
└── MainPanel (flex:1)
    ├── ChatHeader (Avatar DM + title + IconButtons)
    ├── ChatFeed (scrollable, max-width 760, aether-parchment)
    │   └── ChatMessage × n (player/dm/system roles)
    └── Composer
        ├── QuickChips (Chip × 4 suggestion type)
        └── ComposerRow (IconButton dice + TextField + IconButton send)
```

### Step 4 — Wire useChat per mode
Each mode gets its own `useChat` instance (or a shared one that resets on mode change). The `postChat` function in `api.ts` sends `{ prompt }` to `/chat` — for multi-mode, extend the request body to include `{ prompt, mode }` and update the FastAPI endpoint accordingly. The `ChatResult` discriminated union stays unchanged.

### Step 5 — Re-wire existing logic
- `ExchangeView` → delete; render `ChatMessage` role=player for prompt + role=dm for response in `ChatFeed`.
- `ChatForm` → delete; replace with `Composer` component using DS `TextField` + `IconButton`.
- `SourceList` → keep the logic; wrap content in an outlined `Card` (padded=false) instead of `<details>`.
- `exportChat` → wire to `IconButton` (icon="download", standard) in `ChatHeader`.

### Step 6 — Tests
- Convert `components.test.tsx` to test the new DS-powered components: test ChatMessage role rendering, Composer submit behavior, AppShell mode switching.
- Keep `api.test.ts`, `useChat.test.tsx`, `exportChat.test.ts` unchanged — zero coupling to UI layer.
- Add `"test": "vitest run"` to `package.json` scripts.
- Verify `bun run build` passes (tsc strict + vite).

### Step 7 — Theme toggle
Add a `useDarkMode` hook that sets `document.documentElement.setAttribute('data-theme', ...)` and persists to `localStorage`. Wire to the `Switch` in `NavFooter`.

---

## Risks / Friction

**1. Google Fonts CDN in production**
The `tokens/fonts.css` `@import url('https://fonts.googleapis.com/...')` will work in dev but adds a CDN round-trip in production. The FastAPI `StaticFiles` mount (`service/app.py:64–66`) serves `ui/dist` — this is purely static, no server-side rendering. CDN fonts require internet connectivity in the docker container / nginx context. If the deployment is air-gapped or has CSP restrictions, fonts will silently fail.
**Fix**: Before shipping, run `npx fontsource-install` (or vite-plugin-webfont-dl) to self-host the 5 families + Material Symbols. Material Symbols is ~2MB as a variable font; pre-subsetting is recommended.

**2. Material Symbols not tree-shaken**
The full Material Symbols Rounded variable font loads ~400 icons but only ~15–20 are used. In production, subsetting the variable font to used icon names reduces the download from ~2MB to ~100KB.
**Fix**: After Step 6, audit icon names used in the codebase and generate a subset. Low priority for MVP but important for perceived performance.

**3. Asymmetric bubble radius and `clip-path` on DiceRoll**
`DiceRoll.jsx:44` uses `clip-path: polygon(50% 0%, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)` for the d20 hex shape. `clip-path` combined with `border` produces no visible border — the border is clipped. The source code sets the border but it won't render. This is a cosmetic issue in the reference implementation itself; not a blocker but worth noting if pixel-perfect die chrome matters.

**4. TextField lacks typed `onKeyDown`**
`TextField.d.ts` does not declare `onKeyDown` in its prop interface. The JSX uses `...rest` spread on the underlying `<textarea>`, so `onKeyDown` passes through at runtime. In TSX with strict types, TypeScript will error on `<TextField onKeyDown={...} />`.
**Fix**: When converting `TextField.jsx` to `TextField.tsx`, add `onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement | HTMLInputElement>` to `TextFieldProps`. This is a 1-line addition.

**5. `Switch.onChange` receives `boolean`, not a React event**
The DS `Switch` component fires `onChange(newValue: boolean)` — not a standard `ChangeEvent`. This is intentional and correct for a toggle, but callers must not use `e.target.checked` style patterns. Already captured in the contract above; just don't forget when wiring the dark mode toggle.

**6. `window.AetherilDesignSystem_81a390` namespace in UI kit source**
The UI kit JSX files (`Landing.jsx`, `CampaignList.jsx`, `ChatView.jsx`) pull components from a global namespace (`window.AetherilDesignSystem_81a390`) because they're loaded via Babel UMD in a plain HTML context. In the Vite+React+TSX app, this pattern is replaced by ES module imports. Do NOT copy these JSX files directly; use them as structural/layout reference only.

**7. `data-theme` initial value**
If `index.html` does not set `data-theme` on `<html>`, the DS falls back to light mode via `:root` (which is correct), but a flash may occur if JS sets dark mode before first paint. Apply `data-theme` synchronously in a `<script>` before the React bundle loads, reading from `localStorage`.

**8. No `test` script in `package.json`**
The current `package.json` has no `test` script. CI or `bun run` test invocations will fail until it's added. Add `"test": "vitest run"` and optionally `"typecheck": "tsc -b --noEmit"` alongside `"lint": "eslint ."`.

**9. FastAPI static mount ordering**
`service/app.py:65–66`: the `/` static mount is added AFTER route decorators, so `/chat` and `/healthz` always win. The multi-mode `/chat` extension (adding `mode` to request body) is purely additive to the existing endpoint — no routing change needed in the service.

**10. `prefers-reduced-motion` handling**
`tokens/motion.css:32–43` collapses all duration tokens to `0ms` under `@media (prefers-reduced-motion: reduce)`. The `DiceRoll` spin animation uses `animation: aether-dice-spin 600ms ...` directly (not via a token), so it is NOT automatically suppressed. The `ChatView.jsx` bounce dots also use a hardcoded `@keyframes aether-bounce`.
**Fix**: When converting these components to TSX, add `@media (prefers-reduced-motion: reduce) { animation: none }` to the inline `<style>` blocks, or conditionally set `animation: undefined` based on a `window.matchMedia('(prefers-reduced-motion: reduce)').matches` check.

---

## Open Questions for the User (only what code cannot answer)

1. **Multi-mode API contract**: Does each `mode` (`sage|spell|rules|gm`) call the same `/chat` endpoint with an added `mode` field, or are there separate endpoints per mode? The current endpoint is `POST /chat` with `{ prompt }`. The service's `RagService.answer()` is mode-unaware today. This needs a backend decision before the frontend can wire the correct payload.

2. **Conversation history persistence**: Should switching modes preserve per-mode conversation history within a session (i.e., switching from `sage` to `spell` and back shows the sage history again)? Or does mode-switch wipe the active feed? The `useChat` hook is pure in-memory; no session storage is currently used.

3. **Font self-hosting timing**: Is self-hosting fonts (to avoid Google Fonts CDN dependency) a requirement for this sprint, or is CDN acceptable for the overhaul pass and deferred to a hardening sprint?

4. **Left nav conversation list**: For the MVP overhaul, is the conversation list (past sessions per mode) a real feature (backed by service persistence) or a static stub? The current service is stateless. A stub is safe for this sprint, but the IA should be confirmed.

5. **Logo mark**: The aetheril logo (`logo-mark.svg`) is a d20-seal with the Aetheril brand name baked in. The rag-chat product is "D&D 5e Sage" not "Aetheril". Should the logo be used as-is (re-branding the product to Aetheril), replaced by the existing `favicon.svg`, or should a new logo be commissioned?
