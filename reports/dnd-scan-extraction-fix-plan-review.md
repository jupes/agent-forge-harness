# Plan Review: dnd-scan-extraction-fix — Scan Extraction Fix (monster-name binding)
Source: plans/drafts/dnd-scan-extraction-fix.md · Reviewed: 2026-06-08

## Verdict: NEEDS REVISION — 0 Blocker / 1 High / 1 Medium / 0 Low

The diagnosis (VGM/MTF monster names are mis-bound) and the goal (use the bold/size signal to find
the name) are correct and the recovery is real. But the *mechanism* the plan specifies — a
`find_statblock_name(prior_lines: list[LineItem])` that looks back through the accumulated body lines
— cannot be implemented as written: the accumulator holds **plain strings, not LineItems**, and the
bold name line never reaches it anyway because `is_heading` consumes it first. The fix needs a
redesign around the actual control flow before coding.

## Findings

### [High] The bold/size signal isn't where the planned helper looks — `cur_lines` is `list[str]`, and bold name/type lines are consumed as headings — Checkpoint 1
**What:** The plan adds `find_statblock_name(prior_lines: list[LineItem])` to "look back ≤4 lines for
the nearest bold ≥11.5pt line." Two facts break this:
1. `cur_lines` is declared `list[str]` and only ever gets `li.text` appended — it carries **no bold
   or size**, so a helper typed `list[LineItem]` has nothing to consume.
2. The monster name (e.g. `BANDBRHOBB`, bold 12.3pt) and the type line (`Largemonstrosity, neutral
   evil`, bold 10.1pt) **both** satisfy `is_heading` (bold + 3–60 chars + alpha), so each is taken in
   the `is_heading` branch as `cur_entity` — they are never appended to `cur_lines`. When the
   `Armor Class` anchor fires, `cur_lines` is empty and `open_anchored` falls back to
   `cur_entity`, which by then is the **type line** (the name was overwritten and lost).
**Why it's an issue:** Implemented literally, `find_statblock_name` would scan an empty/strings-only
`cur_lines`, never find the bold name, and change nothing. The recovery would silently no-op.
**Evidence:** `extract_scan.py:590` (`cur_lines: list[str] = []`), `:654` (`cur_lines.append(li.text)`),
`:593-596` (`is_heading`: bold short alpha → True), `:639-644` (heading branch sets `cur_entity`, not
`cur_lines`), `:619-628` (`open_anchored` pops `cur_lines` else uses `cur_entity`). Confirmed live:
both `BANDBRHOBB` and the type line return `is_heading == True`. — Confidence: Confirmed
**Suggested correction:** Redesign C1 around the real flow: keep a short history of the **last N
heading LineItems** (text + size + bold) as they're seen; on a stat-block anchor, set the name to the
most-recent heading that is **not** a type line (skip via `_TYPE_LINE_RE`), preferring the larger/bold
one. This requires retaining size/bold for those lines (a small `LineItem` history list), not
re-typing `cur_lines`. Also fold the skipped type line into the body. Leave the spell/feat anchors on
the existing `cur_lines.pop()` path (their names are non-bold and *do* land in `cur_lines`).

### [Medium] Root-cause description is mechanically inaccurate (affects the recovery design) — "Root cause" / Checkpoint 1
**What:** Research and plan state the name is "bound to the type line (the line directly above the
anchor in `cur_lines`)." The actual failure is different: the bold name is consumed as a heading and
then **overwritten** by the bold type line (also a heading); `open_anchored` then names the block
after `cur_entity` (the type line) with an empty `cur_lines`. The name isn't "the previous body
line" — it was already gone.
**Why it's an issue:** A fix built on "pop the right body line" misses that the name never reaches
the body. The correct recovery is from the heading history, per the High finding. The measured
"71%/37% have a bold name within 4 lines above" is still valid as a recoverability ceiling, but the
*path* to that line is the heading stream, not `cur_lines`.
**Evidence:** Same control-flow trace as above (`extract_scan.py:639-644`, `:619-628`). — Confidence:
Confirmed
**Suggested correction:** Update the C1 description to "recover the name from the recent heading
history, skipping the type line" and keep the measurement as the recoverability estimate.

## Verified as accurate (spot-checks)
- `LineItem.bold` exists and the fitz reader populates it — `extract_scan.py` LineItem dataclass
  (F1) ✓
- The `Armor Class` stat-block anchor and `open_anchored` flow exist as described —
  `extract_scan.py:529-530, 619-638` ✓
- Spell/feat names *do* sit directly above their anchors and are non-bold (so they correctly land in
  `cur_lines` and the existing pop works) — consistent with the XGE spike (spells 8→53) ✓
- `_TYPE_LINE_RE`-style detection is viable (type line = size word + creature type + alignment) —
  the live VGM sample matches ✓
- Recovery estimate (~84 VGM + ~51 MTF) — from the live anchor scan ✓

## Not verified
- **Realized monster Hit@1 delta** — only the C2/C3 re-ingest + A/B will settle it; depends on the
  redesigned name recovery actually firing.
- **MTF dotted-leader appendix tables** — acknowledged out-of-scope; not analyzed in depth.
- **Whether tce/eberron/ravnica need the same fix** — deferred to a post-fix spot-check per the plan.
