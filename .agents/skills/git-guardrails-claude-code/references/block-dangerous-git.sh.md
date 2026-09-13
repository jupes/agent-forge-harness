# block-dangerous-git.sh Reference

This is a non-executable reference copy of the upstream `block-dangerous-git.sh` hook script for the `git-guardrails-claude-code` skill.

Do not place this markdown file in Claude Code hook settings. If the user explicitly asks to install the guardrail, copy only the shell script content into the chosen hook path and make that copied `.sh` file executable.

## Script

```bash
#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

DANGEROUS_PATTERNS=(
  "git push"
  "git reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

exit 0
```

## Hook input shape

The script reads a Claude Code hook payload from stdin and extracts:

```json
{
  "tool_input": {
    "command": "git push origin main"
  }
}
```

The script depends on `jq` for JSON parsing and `grep -E` for pattern matching.

## Verification examples

Blocked command:

```bash
echo '{"tool_input":{"command":"git push origin main"}}' | .claude/hooks/block-dangerous-git.sh
```

Expected behavior:

- Exits with code `2`
- Prints `BLOCKED: 'git push origin main' matches dangerous pattern 'git push'. The user has prevented you from doing this.` to stderr

Allowed command:

```bash
echo '{"tool_input":{"command":"git status --short"}}' | .claude/hooks/block-dangerous-git.sh
```

Expected behavior:

- Exits with code `0`
- Prints no block message

## Customization notes

Edit `DANGEROUS_PATTERNS` in the installed script copy to match the user's policy. Keep broad destructive defaults unless the user explicitly requests a narrower set.

