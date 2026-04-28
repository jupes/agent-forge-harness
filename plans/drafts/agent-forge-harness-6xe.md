# Plan: agent-forge-harness-6xe - Add close-time testing prompt for feature/epic beads

## Scope
- In scope:
  - Add a close-guard check in the existing TaskCompleted quality gate for feature/epic issues.
  - Require explicit testing attestation in Beads comments (automation + unit fields) before gate passes.
  - Provide clear remediation text with exact `bd comments add` command.
  - Add focused unit tests for attestation parsing and gate decision behavior.
- Out of scope:
  - Changing Beads CLI behavior itself.
  - Forcing attestation on task/bug/chore issue types.
  - Modifying PR workflows outside the quality-gate hook path.

## File Plan
| File | Change |
|------|--------|
| `scripts/close-testing-attestation.ts` | New pure helpers to parse/validate testing attestations from Beads comments. |
| `scripts/close-testing-attestation.test.ts` | Unit tests for parser and decision logic. |
| `.claude/hooks/quality-gate.ts` | Integrate attestation check for TaskCompleted when issue type is feature/epic. |

## TDD Plan
### AC -> test mapping
| Acceptance Criterion | Test File | Test Name |
|----------------------|-----------|-----------|
| Feature/epic close path prompts for automation/unit evidence | `scripts/close-testing-attestation.test.ts` | `requires attestation for feature and epic` |
| Attestation supports explicit yes/no values for both fields | `scripts/close-testing-attestation.test.ts` | `parses automation/unit values` |
| Missing/invalid attestation yields actionable remediation command | `scripts/close-testing-attestation.test.ts` | `returns remediation guidance when missing` |

### First red test
- Add parser tests for attestation extraction from realistic comment text.
- Safest first slice: pure function behavior with no shell dependencies.

## Execution Order
1. Add failing tests for attestation parser and decision helper.
2. Implement parser/helper until tests pass.
3. Wire helper into quality gate with feature/epic issue-type detection from `bd show --json` and comments from `bd comments --json`.
4. Run focused tests, then full `bun run typecheck` and `bun test scripts`.

## Validation Commands
```bash
bun test scripts/close-testing-attestation.test.ts
bun run typecheck
bun test scripts
```
