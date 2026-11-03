# Claude Design prompts — Agent Forge Desktop

Paste **Prompt 1** with the brief attached (see [`README.md`](README.md) for how). Then send the follow-ups one at a
time, reviewing each batch before the next: Claude Design does better with incremental requests than with everything at
once, and it has no version history, so ask it to keep a page before trying a different direction.

---

## Prompt 1: kickoff (foundations and the core screens)

```text
Design "Agent Forge Desktop": a local-first desktop app (Windows first, then macOS) that is one
command center for a developer who runs many AI coding agents at once. The attached design brief is
the source of truth. Follow its vocabulary, screens, states and sample data exactly; where this prompt
and the brief disagree, the brief wins.

What the app is, in short:
- Work is grouped into PROJECTS (cards on the home screen).
- Every project has a FORGE KEEPER: a standing chat with the project's owner agent. It sees the whole
  project (beads, approval queue, forge runs, every session, reviews, usage), summarizes what is going
  on when asked, and proposes actions as cards the user approves. It never acts on its own.
- Beside the Keeper, the user opens SESSIONS with five providers (Claude, Codex, Gemini, Grok,
  OpenRouter) and prompts each one with the options its own CLI offers, on the user's own
  subscriptions. A per-provider composer exposes those options.
- One window shows every session from every provider in every project, plus the existing harness
  features: beads, the Workbench (approval queue and unattended shifts), forge runs, council reviews,
  activity, smiths, and providers & usage.

Visual direction (do not substitute your defaults):
- Extend the existing "Nocturne" design system described in brief section 10: dark by default,
  ground #161826, surfaces #232532, text #e9e9ed, ONE lavender accent #9184d9 used as a line and a
  glow, never a flood; tonal ramps rather than saturation for contrast.
- Typeface: Inter at weights 400 and 500 only (headings never bolder than 500), plus a monospace
  face for ids, code and commands. Yes, Inter, deliberately.
- Compact pro-tool density (spacing 2.8 to 22.4 px), 8 px radii (4/8/14), elevation as a hairline
  edge plus ambient darkness, Phosphor-style line icons, 2 px accent focus ring.
- Not cream, not serif, no illustrations, no gradient floods, no glassmorphism.
- Add what Nocturne lacks: success / warning / danger / info roles, five provider colors (always
  paired with a neutral monogram and the name; no vendor logos), and later a light theme.

Canvas and format:
- Desktop artboards at 1440x900 with a custom title bar and native Windows window controls.
- Organize the canvas into pages named after brief sections. Fill every screen with the sample data
  in brief section 12: real names, ids, numbers. No lorem ipsum.
- Make the main navigation and the key buttons interactive, so the screens link into a prototype.

For this first pass, design only these pages:
1. "Foundations": the color tokens (existing plus the new roles and provider colors), the type scale,
   spacing, the provider monograms, and the components in brief section 8 that the screens below use
   (bead chip, session chip, status glyphs, chat message, tool activity row, Keeper action card,
   brief card, usage meter, composer).
2. "Projects home" (brief 6.1). Give me 3 distinct variations of the layout.
3. "Project overview" (brief 6.4), with the project sidebar from 5.1 and 6.3.
4. "Forge Keeper" (brief 6.5): the full view with a conversation that shows a brief card, a reply
   with bead and session chips, a "what the Keeper looked at" trace, and two action cards (approve
   beads; start a session), one pending and one approved. Also the docked drawer variant.
5. "New session: Claude" (brief 6.7 with Appendix A's Claude options), including the
   equivalent-command preview and one locked option.

Before you draw, list the assumptions you are making and any question whose answer would change the
layout. Then proceed without waiting for answers. Afterwards, tell me which parts of the brief you
could not fit or found contradictory.
```

---

## Follow-up prompts

Send each after reviewing the previous batch. Adjust the wording to what you saw.

### Prompt 2: sessions and the other providers

```text
Next pages, same system and sample data:
6. "Sessions" (brief 6.6): the table grouped by state, with a teammate nested under its parent.
7. "Session view" (brief 6.8): a running Codex session bound to bead x1gs.4.4 showing streaming text,
   a collapsed reasoning block, tool rows (read, search, edit with an inline diff, run command with
   output), a files-changed card, and a pending permission request card. Add three variants as
   separate artboards: an observed terminal session (read-only), a shift session, and a turn that
   hit "usage limit reached" with "Continue on another provider".
8. "New session: Codex", "New session: Gemini", "New session: Grok", "New session: OpenRouter"
   (brief 6.7 with Appendix A). Same layout as the Claude composer; show how the options panel
   changes, including a provider that is signed out and one that is not installed.
```

### Prompt 3: beads and the workbench

```text
Next pages:
9. "Beads" (brief 6.9): the Ready view with the bead panel open in the inspector, the Epics tab,
   an epic detail with a small dependency graph, and the New bead dialog.
10. "Workbench" (brief 6.10): the board with every queue state populated from the sample data,
    "may start" and "waits because" cards, a halted card, the shift panel with one running shift,
    and the Start shift dialog showing where each default comes from.
```

### Prompt 4: providers, smiths, inbox and palette

```text
Next pages:
11. "Providers & usage" (brief 6.14): five provider cards in their real states (see Appendix A):
    subscription windows with reset countdowns, a credit balance, monthly API spend, and a
    "not reported by this CLI" meter that shows locally counted usage instead. Include the
    "Where you have room" summary and the title-bar usage chip expanded.
12. "Smiths" (brief 6.15): smiths with provenance badges, the benches editor, and the scoreboard.
13. "Inbox" (brief 6.16) and the "Command palette" (brief 6.17) over the Project overview.
```

### Prompt 5: runs, reviews and activity

```text
Next pages:
14. "Runs" (brief 6.11): the run list and the run detail with the phase stepper, checkpoints with
    the review box, and the quality-gate tiles (one failing).
15. "Reviews" (brief 6.12): new review setup with seats, a live review with per-seat progress, and
    a finished result with findings by severity and resolution.
16. "Activity" (brief 6.13): the project feed with filters, and the event detail in the inspector.
```

### Prompt 6: setup, settings and the desktop shell

```text
Next pages:
17. "New project" (brief 6.2): the four steps.
18. "Onboarding" (brief 6.20): provider checks with found / not found / signed out rows.
19. "Project settings" (brief 6.18) and "App settings" (brief 6.19).
20. "Desktop shell" (brief 6.21, 6.22): the tray menu, five Windows toast notifications with
    actions, and a popped-out session window.
```

### Prompt 7: states and the light theme

```text
Go through brief section 9 and add the missing states as artboards on a "States" page: hearth
reconnecting and stopped, provider signed out and usage exhausted, empty / loading / error for the
Sessions, Beads and Workbench views, a write with an unknown outcome, a Keeper whose smith is
unavailable. Then add a light theme derived from the same ramps and show the Projects home, Forge
Keeper and Session view in it. Check every text pair for WCAG 2.2 AA contrast and list any that fail.
```

### Prompt 8: wire the flows and hand off

```text
Link the screens into a clickable prototype for the five flows in brief section 7, starting from
Projects home. Then review the whole canvas against the brief: list screens, states or components
that are still missing, and any place where the vocabulary in brief section 4 is not used. When I
confirm, prepare the handoff to Claude Code.
```

---

## Asking for alternatives

Use these when a page is close but not right:

- "Keep this page as is. On a new page, try a completely different approach to the same screen."
- "Give me sliders for density, sidebar width and accent strength on this page."
- "Show 3 options for the provider monogram set and the provider colors, checked for color-blind
  safety."
- "Make the Forge Keeper feel more like a person the project belongs to and less like a log viewer,
  without adding illustrations."
