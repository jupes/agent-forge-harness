# Deliberative council reviews

Agent Forge can review a pull request, plan, local file, or pasted text with a council of models. Council seats work in parallel, anonymously challenge the other candidates, and then a chair model synthesizes the final review. The same engine is available through a local CLI and a stdio MCP server.

The checked-in default profile uses deterministic fake agents, so the complete workflow can be tried without an account or API key. Use `councils/multi-provider.example.json` when you are ready to call hosted models.

## Install and try the CLI

```powershell
bun install --frozen-lockfile
bun run council -- file README.md
bun run council -- plan plans/drafts/example.md --dry-run
Get-Content plans/drafts/example.md | bun run council -- stdin
```

Review an authenticated GitHub pull request by number or URL:

```powershell
gh auth login
bun run council -- pr 123 --profile councils/multi-provider.example.json
bun run council -- pr https://github.com/owner/repo/pull/123 --profile councils/multi-provider.example.json
```

PR review captures the base and head commit SHAs, changed-file list, patch, and linked Agent Forge Beads acceptance criteria when available. Oversized patches are truncated at a UTF-8 boundary and the omission is recorded. The GitHub CLI is invoked with argument arrays rather than a shell, and only a PR number or an HTTPS pull-request URL is accepted.

Useful controls:

```powershell
# Validate the context, provider readiness, and estimated budget without model calls
bun run council -- pr 123 --profile councils/multi-provider.example.json --dry-run --json

# Apply a stricter per-run estimate ceiling
bun run council -- file architecture.md --profile councils/multi-provider.example.json --max-usd 1.00

# Read a preserved run without calling a model
bun run council -- replay <run-id>
```

Runs are written beneath `reports/council-runs/` by default. Source text is scanned for credential-like values before dispatch. The default behavior rejects the input; `--redact-secrets` replaces detected values when that is explicitly preferred.

## Provider credentials

You need a key only for providers assigned to a seat or chair in the selected profile. The four-provider example expects:

| Provider | Required environment variable | Optional base URL variable | Get a key |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | [OpenAI API keys](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | [Anthropic authentication](https://platform.claude.com/docs/en/manage-claude/authentication) |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | [DeepSeek API docs](https://api-docs.deepseek.com/) |
| Qwen through Alibaba Cloud Model Studio | `DASHSCOPE_API_KEY` | `QWEN_BASE_URL` | [Create a Model Studio API key](https://www.alibabacloud.com/help/en/model-studio/get-api-key) |

Set secrets in the process environment or your operating system's secret manager, never in council profiles, command arguments, MCP tool arguments, committed MCP configuration, or source documents:

```powershell
$env:OPENAI_API_KEY = '<from your secret manager>'
$env:ANTHROPIC_API_KEY = '<from your secret manager>'
$env:DEEPSEEK_API_KEY = '<from your secret manager>'
$env:DASHSCOPE_API_KEY = '<from your secret manager>'
```

The example Qwen profile defaults to Alibaba Cloud's Singapore OpenAI-compatible endpoint. A DashScope key must match its region. Set `QWEN_BASE_URL` to the matching [regional endpoint](https://www.alibabacloud.com/help/en/model-studio/base-url) when using a different region or workspace.

Readiness output exposes only provider names and missing environment-variable names. Provider errors are scrubbed before reaching the CLI, MCP response, logs, or artifacts. Profile costs are conservative estimates used to enforce the preflight and runtime budget; update each seat's `estimatedCostUsd` when models or prices change because provider usage responses do not include the final billed amount.

## Configure a council

A profile assigns each independent seat and the chair to a provider/model pair. Copy the example and adjust the roster, thresholds, timeouts, and cost estimates:

```powershell
Copy-Item councils/multi-provider.example.json councils/my-council.json
bun run council -- file design.md --profile councils/my-council.json --dry-run
```

Supported built-in provider identifiers are `fake`, `openai`, `anthropic`, `deepseek`, and `qwen`. OpenAI uses the Responses API; Anthropic uses Messages with structured output; DeepSeek and Qwen use their OpenAI-compatible chat-completions JSON modes. A provider is resolved independently for every seat, so a single run can mix all four hosted providers.

## Run as an MCP server

Start the stdio server directly:

```powershell
bun run council:mcp
```

Or register it with an MCP client. Use absolute paths and keep actual secrets outside checked-in configuration:

```json
{
  "mcpServers": {
    "agent-forge-council": {
      "command": "bun",
      "args": [
        "run",
        "C:\\absolute\\path\\to\\agent-forge-harness\\scripts\\council\\mcp.ts"
      ],
      "env": {
        "COUNCIL_WORKSPACE_ROOT": "C:\\absolute\\path\\to\\project",
        "COUNCIL_RUNS_DIR": "C:\\absolute\\path\\to\\project\\reports\\council-runs"
      }
    }
  }
}
```

The MCP process inherits provider credentials from its environment. Configure those through the client host's secure environment or secret store rather than adding them to the JSON above.

The server exposes three tools:

| Tool | Purpose |
|---|---|
| `council_readiness` | Resolve a profile and report missing environment-variable names without making model calls. |
| `council_review` | Review a `pr`, `plan`, `file`, or inline `text` source and persist the run artifacts. |
| `council_replay` | Retrieve the preserved result of a prior run by its safe run ID. |

File and profile paths are restricted to the configured workspace or harness roots. MCP inputs intentionally have no credential fields. This makes the stdio server suitable for local editors, coding agents, CI wrappers, and other systems that can launch an MCP subprocess.
