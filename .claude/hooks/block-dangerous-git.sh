#!/bin/bash
# Blocks destructive git commands via Claude Code PreToolUse hook.
# Plain 'git push' is allowed; force-push and hard-reset are blocked.
# Installed by the git-guardrails-claude-code skill.
#
# The command is read from the payload with jq when jq is on PATH, and with
# read-tool-command.ts (run by bun) beside this script when it is not. A
# command that cannot be read is blocked, since nothing here can check it.

refuse() {
  echo "BLOCKED: $1 The command cannot be checked, so it is refused." >&2
  exit 2
}

INPUT=$(cat)

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command') ||
    refuse "jq could not read tool_input.command from the hook payload."
elif command -v bun >/dev/null 2>&1; then
  case "${BASH_SOURCE[0]}" in
    */* | *\\*) HOOK_DIR=${BASH_SOURCE[0]%[/\\]*} ;;
    *) HOOK_DIR=. ;;
  esac
  COMMAND=$(printf '%s' "$INPUT" | bun run "$HOOK_DIR/read-tool-command.ts") ||
    refuse "read-tool-command.ts could not read tool_input.command from the hook payload."
else
  refuse "neither jq nor bun is on PATH to read tool_input.command from the hook payload."
fi

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
