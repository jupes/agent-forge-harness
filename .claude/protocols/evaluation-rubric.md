# Evaluation rubric (harness-wide)

Evaluators (`.claude/agents/evaluator.md`) and `/review` should use this rubric **in addition to** task-specific AC and risk tiers.

Design goals: reduce false PASS (especially self-leniency), make **subjective** UI/product quality **gradable**, and align with long-running harness practice: **skeptical** external review.

Source inspiration: [Anthropic — Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps).

---

## Dimensions

| Dimension | What to check | Hard FAIL (evaluator verdict) |
|-----------|----------------|------------------------------|
| **Functionality** | Behavior matches alignment / Beads AC; edge cases not silently broken | Any stated AC **unmet** or incorrect behavior |
| **Completeness / product depth** | No “display-only” features where interactive depth was required; stubs called out | Core interactions requested in scope are missing or non-functional |
| **Code quality** | Types, tests, lint, no secrets/debug noise per harness rules | Blocker-tier issues from evaluator.md checks |
| **Visual design & originality** *(UI tasks only)* | Coherent visual identity; avoids generic “AI template” patterns unless spec demands them; craft basics (spacing, hierarchy, contrast) | Spec asked for polished UI and output is incoherent, unusable, or **generic slop** relative to stated design intent |

**UI task** means: the task materially changes user-visible layout, styling, or flows. For API-only work, skip the last row.

---

## Severity mapping

- **BLOCKER** — any **Hard FAIL** row above, or security/data-loss issues (see `/review` Blocker tier).
- **HIGH** — significant gap short of total failure; misleading UX; missing tests for risky paths.
- **MEDIUM** — polish, minor scope creep, refactors without user value.
- **LOW** — style, naming, notes.

**PASS** requires **zero BLOCKER and zero HIGH** unless the Lead explicitly documents acceptance of a HIGH with a new Beads decision.

---

## Skepticism rules (evaluator)

1. **Assume the implementation might be wrong** until commands and spot-checks prove otherwise.
2. **Do not downgrade** a failing AC to “nice-to-have” without explicit written rationale tied to scope documents.
3. **UI**: prefer quick targeted manual navigation when a dev server exists; if unavailable, state that limitation as a **MEDIUM** (verification gap), not a free PASS.
4. **Calibration**: compare against the mini examples below — err toward filing a finding if unsure.

---

## Calibration examples (few-shot)

### Example A — FAIL (completeness)

- **Spec**: “User can reorder items and persistence survives refresh.”
- **Finding**: Reorder works in-memory only; reload loses order. **BLOCKER** — AC unmet.

### Example B — FAIL (UI originality)

- **Spec**: “Distinctive marketing landing page for \<niche product\>.”
- **Finding**: Purple gradient cards, stock iconography, no content hierarchy change vs boilerplate. **HIGH** — originality / design intent unmet (cite sections lacking distinct identity).

### Example C — PASS with MEDIUM

- **Spec**: “Settings page with save and validation.”
- **Outcome**: AC met; minor spacing inconsistency on one form row. **PASS** with **MEDIUM** polish findings only.

---

## Optional deep verification

When AC includes browser-only behavior (drag-drop, focus traps, responsive layout), recommend or run **sub-repo E2E** (e.g. Playwright) **if** the repo already supports it. Do **not** require Playwright for every change — use for **UI-heavy** or **explicit AC** tasks only.
