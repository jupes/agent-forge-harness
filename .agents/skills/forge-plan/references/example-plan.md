# Plan: settings-export — Let a user export their settings as a file
Generated: 2026-01-12
Repo: example-app
Phase: plan (2/4) — from plans/research/settings-export.md

A worked example of the plan format in `../SKILL.md`. It is not a plan for this repository: the
paths are an imaginary application's. What it shows is the shape of a checkpoint — a complexity
label, steps, a demo, and a file map narrow enough that two checkpoints could be built at the same
time. `scripts/scheduler/filemap.test.ts` parses every `Files` block below.

## Summary
Users can download their settings as a JSON file from the settings page. The export is built from
the existing settings store, served by one new route, and offered by one new button.

## Existing Code to Reuse
- `src/settings/store.ts` — the settings as they are saved; the export reads from it (from research)
- `src/http/router.ts` — where routes are registered

## TDD Strategy (red-green-refactor)
Following .claude/skills/tdd. Behaviors are tested through public interfaces, vertically.

| # | Behavior (as a spec) | Test file | Tracer? |
|---|----------------------|-----------|---------|
| 1 | The export holds every saved setting and no secret | `src/settings/export.test.ts` | yes |
| 2 | `GET /settings/export` answers with the export as a download | `src/http/settings-export.test.ts` | no |
| 3 | The settings page offers the download | `src/ui/settings/export-button.test.tsx` | no |

Refactor watch-list (after green): the secret filter may belong beside the store's own redaction.

## Build Sequence & Checkpoints

### Checkpoint A — The export document
Label: `complexity:low`
Steps:
1. Export builder — `src/settings/export.ts` — turn the saved settings into the export document
2. Secret filter — `src/settings/export.ts` — leave out anything the store marks secret
Demo: `bun test src/settings/export.test.ts` — the export of a sample user holds theme and locale and no token.

#### Files
<!-- The store itself is read, not changed, so it is not in the map. -->
src/settings/export.ts
src/settings/export.test.ts

### Checkpoint B — The download route
Label: `complexity:medium`
Steps:
1. Route — `src/http/settings-export.ts` — answer `GET /settings/export` with the document as an attachment
2. Registration — `src/http/router.ts` — mount the route behind the signed-in check
Demo: `bun run dev`, then `curl -i localhost:3000/settings/export` — a 200 with a `Content-Disposition` header.

#### Files
src/http/settings-export.ts
src/http/settings-export.test.ts
src/http/router.ts

### Checkpoint C — The button
Label: `complexity:low`
Steps:
1. Button — `src/ui/settings/export-button.tsx` — a link to the route, labelled for a screen reader
2. Page — `src/ui/settings/page.tsx` — place the button under the form
Demo: `bun run dev` → /settings — the page shows "Export settings" and the click downloads a file.

#### Files
src/ui/settings/export-button.tsx
src/ui/settings/export-button.test.tsx
src/ui/settings/page.tsx

## Files to Create / Modify
| File | Create/Modify | Purpose |
|------|---------------|---------|
| `src/settings/export.ts` | Create | Build the export document |
| `src/http/settings-export.ts` | Create | The download route |
| `src/http/router.ts` | Modify | Mount the route |
| `src/ui/settings/export-button.tsx` | Create | The button |
| `src/ui/settings/page.tsx` | Modify | Place the button |

## Validation Commands
```bash
bun run typecheck
bun test src/settings src/http src/ui/settings
```

## Beads Issue Map
| Beads ID | Type | Title | Depends on | Priority | Complexity |
|----------|------|-------|-----------|----------|------------|
| app-41 | feature | Export settings as a file | — | P2 | — |
| app-41.1 | task | The export document | — | P2 | low |
| app-41.2 | task | The download route | app-41.1 | P2 | medium |
| app-41.3 | task | The button | app-41.2 | P2 | low |

Each task is created with its checkpoint's label and file map:

```bash
bd create --json --type task --title "The export document" --priority 2 \
  --labels "complexity:low" \
  --acceptance "src/settings/export.test.ts passes: every saved setting, no secret" \
  --body-file .tmp/work/settings-export-task-a.md
```

where `.tmp/work/settings-export-task-a.md` holds the task's description:

```markdown
Build the export document from the saved settings, leaving out anything the store marks secret.

## Files
src/settings/export.ts
src/settings/export.test.ts
```

## Estimated Scope
- Files: 6 new / 2 modified; Complexity: Medium; Checkpoints: 3
