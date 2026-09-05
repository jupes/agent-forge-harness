# Deliberative council reviews

Agent Forge can review a pull request, plan, local research/text file, or pasted text with a council of models. Council seats work in parallel, anonymously challenge the other candidates, and then a chair model synthesizes the final review. The same engine serves the local dashboard, CLI, and stdio MCP server.

The checked-in default profile uses deterministic fake agents, so the complete workflow can be tried without an account or API key. Use `councils/multi-provider.example.json` when you are ready to call hosted models.

## Local dashboard

Run `bun run dashboard` and open [the council page](http://127.0.0.1:8787/council.html). Select a source and profile, inspect the provider/model roster and configuration status, set a budget, and choose **Convene council**. The page shows round progress, independent findings, objections and revisions, synthesis, limitations, costs, and the full transcript. Stop a running review, reopen saved history, or download its JSON report. The existing Plan review page can send its selected working-tree plan to the council; historical Git revisions must first be exported as text.

Keys stay in the local server's environment. The execution API accepts only loopback connections and same-origin browser requests. Do not expose this development server publicly or tunnel it to other users. Static hosting displays instructions instead of attempting execution. `DASHBOARD_NO_BUILD=1` skips the unrelated initial Beads dashboard refresh when only the council is needed.

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

Runs are written beneath `reports/council-runs/` by default. Each run reserves a unique directory before calling models; duplicate or unsafe run IDs are rejected, never overwritten. Saved manifests include the sanitized, bounded evidence, full discussion, costs, failures, and ordered events; `report.md` is readable without the UI. These artifacts may contain private source material and are ignored by Git. Restrict access to the artifact directory and delete old runs according to your retention policy.

Source text, labels, and PR metadata are scanned for credential-like values before truncation or dispatch. The default behavior rejects the input; `--redact-secrets` replaces detected values when explicitly preferred. Credential-file patches (including renames) are omitted and recorded. Detection is heuristic, not a guarantee that arbitrary sensitive data is removed: review the material before sending it to external providers.

The source is a bounded evidence packet, not an autonomous research session. Models cannot browse linked sites, execute repository tools, or retrieve additional code. Supply relevant excerpts and acceptance criteria alongside plans or research. `pr` accepts a GitHub PR URL; arbitrary webpage fetching and native PDF/Word parsing are not implemented. Export those documents to text/Markdown or paste their relevant contents. PR capture verifies that head/base SHAs did not change while metadata and diff were retrieved and refuses a moving snapshot.

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

Readiness checks local credential presence and endpoint configuration only; they do not verify key validity, account credit, regional access, model availability, or live API behavior. It reports variable names and configuration errors, never key values. Provider errors and outputs are scrubbed before reaching the CLI, MCP response, logs, or artifacts. Set credentials in the environment of the process actually launching the dashboard/MCP server; a key configured in another terminal will not automatically reach an already-running process. Provider API access/billing is separate from this harness; obtain keys only for the providers you select.

`estimatedCostUsd` is a per-call reserve. Optional `tokenRatesUsdPerMillion` supplies input/output rates for conservative pre-dispatch reservations and usage-derived estimates. The engine reserves each whole parallel round before launching it, then stops before a subsequent round if remaining budget is insufficient. Failed calls retain reported usage and a conservative charge. `actualCostUsd: null` means billing was not reported, not zero. `accountedCostUsd` is the conservative budget ledger, which may exceed token-based estimates.

This is an estimated-cost guard, not a guaranteed billing cap: unknown provider surcharges, inaccurate custom rates, or already-dispatched calls can exceed it. Also set provider-side spending controls. The hosted example rates were checked September 4, 2026, and exclude discounts, promotions, and surcharges; DeepSeek uses peak uncached rates and Qwen uses Singapore rates. Check the provider's pricing before running large inputs.

## Configure a council

A profile assigns each independent seat and the chair to a provider/model pair. Copy the example and adjust the roster, thresholds, timeouts, and cost estimates:

```powershell
Copy-Item councils/multi-provider.example.json councils/my-council.json
bun run council -- file design.md --profile councils/my-council.json --dry-run
```

Supported built-in provider identifiers are `fake`, `openai`, `anthropic`, `deepseek`, and `qwen`. OpenAI uses the Responses API; Anthropic uses Messages with structured output; DeepSeek and Qwen use their OpenAI-compatible chat-completions JSON modes. A provider is resolved independently for every seat, so a single run can mix all four hosted providers.

Profiles can assign different roles as well as models. For a PR, use correctness/security/testing/architecture; for a plan, use feasibility/migration/operations/acceptance criteria; for research, use methods/source quality/counterarguments/generalizability. Save JSON profiles in `councils/` to have them appear in the UI and MCP profile list. Schema validation reports invalid thresholds and duplicate seat IDs before any model call.

| Depth | Protocol |
|---|---|
| `quick` | Parallel independent reviews, then chair; no peer discussion. |
| `balanced` | Independent reviews, parallel peer challenges, then chair. |
| `deep` | Independent reviews, peer challenges, then 1–3 parallel revision rounds before chair. `maxDiscussionRounds` defaults to 1. |

Each round has a barrier: all participating calls settle before the next round sees their results. This is simultaneous, bounded deliberation, not free-running chat. Revisions include earlier objections and can change judgments without multiplying votes. Authors cannot vote on their own proposals. Independent corroboration is counted separately from external ballots; late discoveries remain unreviewed until others assess them. The chair sees the source evidence, original uncertainty and strengths, and substantive reasons. Unsupported consensus labels are rejected; uncertainty, reduced participation, unresolved serious findings, or truncated evidence cannot silently turn into PASS. Confidence is a model-reported signal, not a calibrated probability.

Council output is advisory: it never automatically edits code, approves a plan, merges a PR, closes an issue, or posts a review. `/council`, `/review --council <profile>`, and `/review-plan --council <profile>` integrate deliberation into the existing harness commands without changing their default behavior.

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

The server exposes eight tools:

| Tool | Purpose |
|---|---|
| `council_profiles` | List discovered profiles, rosters, and local readiness. |
| `council_readiness` | Resolve a profile and report missing environment-variable names without making model calls. |
| `council_start` | Start a `pr`, `plan`, `file`, or inline `text` review and immediately return a run ID. Recommended for hosted models. |
| `council_status` | Get the job status, events, and final result without keeping a long request open. |
| `council_cancel` | Request cancellation; use status to read the terminal outcome. |
| `council_list` | List up to 100 recent jobs. |
| `council_review` | Synchronous convenience tool. Use only when the client's timeout covers the entire deliberation. |
| `council_replay` | Retrieve the preserved result of a prior run by its safe run ID. |

File and profile paths are restricted to the configured workspace or harness roots. MCP inputs intentionally have no credential fields. This makes the stdio server suitable for local editors, coding agents, CI wrappers, and other systems that can launch an MCP subprocess.

Example tool sequence:

```json
{"name":"council_start","arguments":{"sourceType":"text","source":"Review this design and its supplied evidence...","profile":"C:\\absolute\\harness\\councils\\multi-provider.example.json","maxUsd":3}}
```

Then call `council_status` with `{"runId":"<returned ID>"}` until its status is `completed`, `failed`, or `cancelled`. Read both the transport envelope and the job status: a successful status lookup can describe a failed review. Failed synchronous reviews retain their run ID, diagnostics, and artifact paths in `data` even when `ok` is false.

Async jobs survive a request timeout, **not termination of the server process**. Keep the MCP subprocess alive. Completed and failed results survive restarts; interrupted in-flight runs are reported as failed, never silently resumed or rebilled. A service instance permits at most four concurrent council runs. It does not share active in-memory progress with a separate CLI/dashboard process, although persisted results can be reopened from a common runs directory.

## Calibration and verification

Run `bun run council:calibrate` for a no-call comparison plan covering golden PR, plan, and research fixtures. To exercise the full measurement pipeline with simulated providers, run `bun run council:calibrate -- --live --max-usd 0`; `--live` means execute, but the default profile remains fake. Hosted calibration is explicitly opt-in:

```powershell
bun run council:calibrate -- --profile councils/multi-provider.example.json
bun run council:calibrate -- --profile councils/multi-provider.example.json --live --max-usd 30
```

The runner compares a single evaluator with quick, balanced, and deep councils, preserves reports, and records latency, tokens, costs, dissent counts, keyword-recall proxies, and severity matches. The budget applies to the entire matrix. Human false-positive, usefulness, and dissent-quality ratings intentionally remain blank for adjudication. Keywords are not proof that a finding is correct. Fake runs and contract tests validate the machinery, **not** a claim that councils outperform a single model. Live hosted access and human quality calibration still require your credentials and judgment. Four seats, quorum three, two external ballots, and one revision are provisional defaults, not benchmark-proven optimal settings.

## Prior art and design choices

[Karpathy's LLM Council](https://github.com/karpathy/llm-council) is the closest simple precedent: parallel opinions, anonymous peer review, and a chair. [amiable's LLM Council](https://github.com/amiable-dev/llm-council) is a broader implementation worth evaluating if a standalone Python service is preferred. This implementation keeps council state and artifacts native to the existing Bun harness and adds explicit rebuttals, conservative verdict validation, local UI, and MCP jobs. Provider adapters deliberately remain narrow and have API-specific request/response contract tests, including Anthropic's restricted schema support.

Claude Agent Teams is an optional alternative orchestration approach for an all-Claude workflow, not a mixed-provider backend shipped here. An adapter would need to preserve this engine's typed review, ballot, cancellation, and accounting contracts; existing provider seats use API keys rather than reusing a coding-agent subscription session.
