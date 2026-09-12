# Nocturne — the Agent Forge design system

One dark, compact interface shared by every dashboard page: a near-neutral blue-grey ground, Inter
at medium weight, 8px radii, and a single lavender accent used as a line and a glow rather than a
flood. Contrast comes from the tonal ramps, not from saturation.

Before this system, three separate visual languages shipped side by side — a NASA-retro theme inline
in `index.html`, a near-copy of it in `plan-review.html`, and a teal/mint theme in `css/council.css`.
Everything now reads from one token sheet.

## Using it

Link the one entry point from every page:

```html
<link rel="stylesheet" href="js/ds/ds.css" />
```

`ds.css` pulls in `tokens.css` (the variables) and `components.css` (the classes the primitives
emit). Never link only one of them.

Then compose with the primitives rather than hand-rolled markup:

```tsx
import { Button } from "./ds/Button";
import { Card } from "./ds/Card";

<Card title="Seats" actions={<Button variant="primary">Convene council</Button>}>
  …
</Card>;
```

**Take every color, font, space, radius and shadow from a token.** If a value you need is not a
token, add the token — do not write a literal hex or px into a component. The token test
(`scripts/dashboard/ds/tokens.test.ts`) enforces the sheet's shape; code review enforces the rest.

## Tokens

| Group | Tokens | Notes |
| --- | --- | --- |
| Roles | `--color-bg`, `--color-surface`, `--color-text`, `--color-accent`, `--color-divider` | The ground is `#161826`; the accent is `#9184d9` |
| Ramps | `--color-neutral-100…900`, `--color-accent-100…900` | Generated in OKLCH on one shared lightness scale, so the same step of any role carries the same visual weight |
| Type | `--font-heading`, `--font-heading-weight`, `--font-body`, `--font-mono` | Inter over Inter; headings stay at weight 500 |
| Space | `--space-1,2,3,4,6,8` (2.8–22.4px) | Density 0.70×, deliberately compact |
| Radius | `--radius-sm/md/lg` (4/8/14px) | |
| Elevation | `--shadow-sm/md/lg` | On a dark ground, elevation is a hairline edge plus ambient darkness |

On this dark ground use ramp steps **700–900** for tinted fills, hovers and subtle borders, **500**
as a role's base, and **100–300** for text on those tints. Prefer a ramp step over an ad-hoc
`color-mix()`.

## Components

| Import | What it is |
| --- | --- |
| `Button` | Actions. `primary` is an accent **outline**, never a fill. Renders an `<a>` when given `href`. |
| `Tag` | Small tinted label — statuses, priorities, counts. |
| `Card` | A surface panel with optional kicker, title (heading level is yours to choose) and actions. |
| `Table` | Data table inside a focusable, labelled scroll region; supports per-row detail rows. |
| `Field`, `Input`, `Textarea`, `Select` | Native controls wired to their label and hint by id. |
| `StatCard` | One headline number with its label and an optional note. |
| `ProgressBar` | Determinate track that exposes `aria-valuenow/min/max`. |
| `EmptyState` | "Nothing here yet, and here's what to do about it." |
| `Dialog` | Modal over a dismissing backdrop; closes on Escape and backdrop click. |
| `Icon` | A Phosphor glyph from committed path data. |
| `AppShell` | The page frame: nav, global actions, header, content slot. |

## Interaction states

States are built into the token sheet — do not restyle them per page:

- Keyboard focus is always `outline: 2px solid var(--color-accent)` at `2px` offset. Never remove it.
- Hover and pressed states come from the accent ramp (or a `color-mix` tint for outlined variants).
- Disabled controls drop to 45% opacity.
- `::selection` is an accent tint.

The accent-to-ground pair is tuned to roughly 3:1 — enough for icons, large text and interface
chrome, **not** for body copy. For paragraph-size text in the accent, use `--color-accent-300`.

## Dependency policy

Production pages load **no external font or icon CDN**. Both dependencies are bundled and committed:

- **Inter** is self-hosted from `docs/fonts/` (latin subset, weights 400 and 500) under the
  [SIL Open Font License 1.1](../../fonts/LICENSE-Inter.txt). It is vendored from the
  `@fontsource/inter` package so its provenance is reproducible. `@font-face` lives in `tokens.css`
  with `font-display: swap`, and `--font-body`/`--font-heading` fall back to `system-ui` if a font
  file ever fails to load.
- **Icons** come from `@phosphor-icons/core` (MIT). `scripts/dashboard/ds/generate-icons.ts` extracts
  only the glyphs listed in its `MANIFEST` into `icon-paths.ts`, which is committed. The browser
  gets inline `<path>` data — no icon font, no runtime fetch, no build step.

To add a glyph: add its name to `MANIFEST`, run `bun run scripts/dashboard/ds/generate-icons.ts`, and
commit the regenerated file. Do not paste path data by hand — it goes stale silently.

The reference design also defined deck-only `--color-section*` fills. Those are slide-scale grounds,
not interface colors, and are intentionally absent here.

## Testing

Primitives are tested by calling them as plain functions and walking the returned vnode tree — see
`scripts/dashboard/ds/vnode.ts` and the specs beside it. No jsdom, no testing-library.

That layer asserts **structure**: elements, props, ARIA. It cannot see computed styles, focus rings,
layout at a viewport, or console errors. Anything in that category belongs to the Playwright suite in
`tests/e2e/` (`bun run verify:ui`) — do not assert it structurally and call it verified.
