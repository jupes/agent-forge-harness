#!/bin/bash
# Blocks destructive git commands via Claude Code PreToolUse hook.
# Plain 'git push' is allowed; force-push and hard-reset are blocked.
# Installed by the git-guardrails-claude-code skill.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

DANGEROUS_PATTERNS=(
  "push --force"
  "push -f"
  "reset --hard"
  "git clean -fd"
  "git clean -f "
  "git branch -D"
  "git checkout \."
  "git restore \."
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from running this command." >&2
    exit 2
  fi
done

exit 0
