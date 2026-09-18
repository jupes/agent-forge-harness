# Self Hosted AI Agent Stack Integration Master Plan

Generated: 2026-09-13
Repository: agent-forge-harness
Beads epic: `agent-forge-harness-ulpz`
Phase: plan 2 of 4
Status: Revision 4 reviewed; no open plan findings; operator baseline decisions pending

## Executive decision

Build a small private hybrid stack around Agent Forge instead of turning the harness into a deployment runtime. Windows remains the human control and review surface. A dedicated Linux host runs privileged control-plane services. Ollama runs on the private host with suitable GPU capacity. Every external product sits behind an optional adapter, is disabled by default, and has a measurable stop or rollback point.

The rollout begins with decisions and a baseline, then proves one local SQLite execution-ledger tracer using existing council data. Harness RAG and Ollama embeddings proceed through existing workstream `agent-forge-harness-9n1`, after its conflicting storage and embedding assumptions are reconciled between the committed plan and Beads issue. Any ignored local draft is historical input only, never a third authority or a required deliverable. The private service substrate and a selected live-diff workflow follow. One constrained OpenHands worker in its own VM is the first remote execution pilot. Headroom, 9Router, and AgentFS remain evidence-gated and may be rejected without blocking the useful core.

## Product outcomes

1. An operator can inspect selected self-host services for configuration, privacy, health, version pinning, and recovery readiness without exposing secrets.
2. Harness retrieval can use an Ollama embedding adapter with the existing pgvector baseline and demonstrate cited top-K results on one pilot repository.
3. One Forge run can be queried by Beads issue, execution ID, checkout or worktree, worker, requested and response-reported or route-observed model, event sequence, artifact hashes, quality gate, typed evaluator verdict, latency, and available usage or cost.
4. A verified live-diff viewer can show worktree changes while Git diff, tests, evaluator evidence, and quality gates remain authoritative; if no candidate qualifies, the workflow falls back to ordinary Git and the existing dashboard.
5. One OpenHands worker can execute one bounded task in one worktree on a dedicated Linux host and stop before merge or push.
6. Headroom is adopted only for task classes where an A B comparison shows useful token savings without quality loss.
7. 9Router is adopted only if a fresh security review and measured routing pain justify the new privileged service.
8. AgentFS is evaluated on a disposable worktree without becoming the only copy of important work.

## Non-goals

- Replacing Beads, Git, worktrees, pgvector, the existing quality gate, or human merge approval in the MVP.
- Building a public or multi-tenant agent service.
- Installing every named product before the earlier checkpoints prove value.
- Automatically provisioning hardware, opening firewall ports, enabling paid calls, or enabling cloud synchronization.
- Copying raw prompts, model responses, source bodies, tool logs, credentials, or reversible compression caches into the new ledger or external services by default; existing council artifacts retain their current file policy.
- Routing a final evaluator through a weaker fallback.
- Adding adjacent products such as vLLM, LiteLLM, Open WebUI, n8n, Supabase, or Langfuse without a separate approved scope.
- Reopening closed product-specific D and D infrastructure work as harness implementation tasks.

## Binding architecture and security invariants

These are plan constraints, not optional implementation suggestions.

1. **Agent Forge remains the policy layer.** It owns work selection, phase rules, acceptance gates, and handoffs. It does not own model hosting or application data.
2. **Beads remains task intent.** The execution ledger may snapshot a task ID and acceptance context but does not duplicate issue status, dependencies, assignment, or planning logic.
3. **Git remains artifact authority.** Source, patches, commits, and reviewed deliverables remain ordinary Git data. The ledger stores hashes, paths, and provenance.
4. **Worktrees are the baseline workspace boundary.** They isolate Git checkouts but are not treated as a process, network, secret, or host filesystem sandbox.
5. **Every service is private by default.** Raw Ollama, OpenHands, Headroom, and 9Router ports bind to loopback or a private container network. A VPN may carry authenticated TLS; plain HTTP to a non-local VPN address is not accepted. Plain HTTP remote access uses a reviewed SSH port-forward so the client connects to loopback.
6. **Secrets remain outside Git and browser code.** Readiness output may name a missing environment variable or secret reference but never return its value.
7. **Telemetry is metadata-first.** Local hashes, identifiers, timings, counts, bounded summaries, and policy labels are the default. Raw content needs an explicit data class, retention limit, encryption and sync decision.
8. **Evaluation fails closed.** A human evaluator declares an explicit actor kind. A model evaluator records requested provider/model/tier plus provider and model verifiably evidenced by the selected direct transport and response or gateway route. Missing identity or a weaker fallback blocks completion; a council seat's transport evidence never substitutes for a separate model evaluator's evidence.
9. **Compression is bypass-first.** Exact diffs, evaluator evidence, security findings, licenses, credentials, cryptographic material, exact errors, and already dense inputs never pass through Headroom.
10. **External agents have least privilege.** One worker gets one intended worktree, narrowly scoped credentials, bounded egress, no operator home-directory mount, no cloud metadata access, and no default merge, push, or deploy authority.
11. **Optional means removable.** Disabling a provider, reducer, ledger, worker, viewer, or isolation adapter preserves the current harness behavior.
12. **Upstream freshness is a deployment gate.** Product versions, licenses, security advisories, ports, hardware guidance, and provider terms are revalidated from first-party sources immediately before a version is pinned.

## Verified current state and reuse map

| Existing asset | Current behavior | Planned reuse |
|---|---|---|
| `README.md` and `docs/HARNESS-GUIDE.md` | Define the harness as a workflow and convention layer, not a deployable product runtime | Keep self-host support optional and adapter-driven |
| Root `AGENTS.md` | Requires Beads for all task tracking and explicitly forbids Claude `TaskCreate` | Keep Beads authoritative and use an explicit Forge launcher correlation; host-task identity remains optional unless a future reviewed policy amendment permits a non-authoritative bridge |
| `.claude/settings.json` | Wires Claude-only session, dangerous-Git, stop, completion, and idle hooks | Use as the lifecycle behavior inventory |
| `.agents/CODEX-NOTES.md` | Records which Claude hooks do not automatically carry to Codex | Require host-neutral adapters to invoke underlying scripts explicitly |
| `.claude/hooks/quality-gate.ts` and `scripts/quality-gate-identity.ts` | Run typecheck, lint, tests, tree checks, acceptance checks, and optional evaluator verification; task and event currently depend on environment variables the hooks do not set. The same `taskId` is passed to Beads and evaluator paths even though Claude's stdin `task_id` belongs to a separate, task-list-scoped host namespace | Parse hook JSON from stdin, keep the canonical host task-list scope plus `hostTaskId` separate from `beadsIssueId`, and use only an explicit binding for Beads and evaluator operations |
| `scripts/worktree.ts` | Creates and manages Git worktrees | Retain as the first workspace backend and mount only the selected worktree into remote workers |
| `scripts/council/types.ts` and `scripts/council/engine.ts` | Model typed transports, ordered events, configured seat provider and model, optional observed routing, usage, cost, cancellation, and results; `SeatRecord` also carries full parsed output and free-text errors | Reuse the run contracts, supply execution identity explicitly, and map records into a metadata-only ledger shape that omits raw output and free-text errors |
| `scripts/council/providers.ts` | Implements provider readiness, local HTTP constraints, credential redaction, structured outputs, and hosted provider transports; only the gateway path maps a response-reported model into observed routing | Add fixture-backed response identity capture for every direct transport before requiring complete actual-model provenance; qualify Ollama and 9Router explicitly |
| `scripts/council/artifacts.ts` | Persists manifest, event, and report artifacts for replay and returns their paths, but does not compute artifact digests | Use the post-persistence result as the first producer boundary, preserve the files, and compute ledger artifact references there |
| `scripts/council/integrations.test.ts`, `provider-contract.test.ts`, and `safety.test.ts` | Test provider behavior, shared contracts, and secret boundaries | Extend behavior tests instead of creating parallel transport test infrastructure |
| `scripts/dashboard/forge-run-model.ts` and local dashboard APIs | Read structured quality-gate and run state for the UI | Add read-only ledger reporting only after the storage tracer is stable |
| `docs/plans/harness-rag-local-vector.md` | Describes Ollama embeddings but couples the harness to a pgvector container shared with `rag-chat` and mislabels closed D&D issues `7fx` and `c7v` as `9n1` slices | Reconcile the committed document under `ulpz.1`; preserve pgvector and Ollama-first direction without product-owned operational dependency, remove the stale issue links, and create new `9n1` children only if post-freeze decomposition is useful |
| Ignored local `9n1` draft | Contains superseded OpenAI-dimension and product-owned-database ideas | Treat only as non-binding historical input when explaining rejected alternatives; do not update, depend on, or cite it as an acceptance authority |
| `agent-forge-harness-3u6` | Tracks MCP-hosting practicality, secrets, sandboxing, packaging, and sync | Treat as related input for the OpenHands compatibility surface |
| `agent-forge-harness-t1b1` | Has delivered provider transports, safe context compilation, local MCP, artifacts, usage, cost, and dashboard surfaces | Reuse as prior art and the ledger tracer source |

## Decisions and provisional defaults

| ID | Decision | Status |
|---|---|---|
| D1 | One umbrella epic and one canonical shared plan; phase-level Beads issues; detailed subplans only when a risky phase becomes active | Accepted for planning because the user delegated the decomposition choice |
| D2 | Windows is the control surface; Linux is the preferred privileged worker and control-plane host; Ollama follows the usable GPU | Provisional until host inventory is recorded in `ulpz.1` |
| D3 | pgvector remains the harness retrieval baseline in an isolated `harness.*` namespace; a local SQLite database is a separate execution ledger | Recommended; schema and ownership locked by `ulpz.1` |
| D4 | Harness RAG owns its own Compose or documented database contract and never depends operationally on a product repository or the legacy port 5432 | Recommended; `9n1` plan must be updated before implementation |
| D5 | Ollama is the first self-host embedding provider; requested and returned dimensions, model identity, a required digest resolved from Ollama model inventory, chunk policy, and index version are explicit | Recommended; exact model waits for hardware and golden-set evidence |
| D6 | The first implementation tracer is a local `bun:sqlite` ledger dual-write from one deterministic fake-provider council run. Its already-reserved `CouncilRun.runId` is the execution ID and must equal `RunCorrelation.executionRunId`; gate and evaluator evidence arrive through a second producer with that same ID | Planned |
| D7 | New ledger and cache cloud sync is off; metadata-only local retention is the default. Existing Git and Beads remotes keep their current policies | Safe default pending operator retention approval |
| D8 | Live-diff viewer selection, OpenHands host access, any external installation, paid call, or firewall change is HITL; `Diffy` is a candidate name, not an assumed product identity | Binding |
| D9 | Headroom, 9Router, and AgentFS are optional experiments with explicit rejection paths | Binding |
| D10 | Run identity is never inferred from timestamps or a task-plus-checkout guess. The council tracer uses its atomically reserved council run ID; non-council workflows use one `beginExecutionRun` allocator backed by a unique ledger constraint. Every producer cross-checks the explicit execution ID, and uncorrelated evidence stays visibly unlinked | Binding |
| D11 | The required Forge path starts an explicit correlation with `beadsIssueId`, `executionRunId`, checkout, and worker; it does not call Claude `TaskCreate`. A Claude host task, when independently present, is optional metadata identified by canonical `{hostTaskScope, hostTaskId}` and never required for ledger completeness. Scope is an agent-team name, a configured named task-list ID, or—only for an unshared standalone list—the creating session ID. A future host-task bridge must first amend the governing Beads policy to allow a non-authoritative ephemeral execution handle; if enabled, it keys atomically by the scoped pair, records creator and completer sessions separately, and permits a different teammate session to finish a shared-list task. No host identity is ever sent to `bd` or used as an evaluator Beads ID | Binding default; optional bridge decision remains in `ulpz.1` |
| D12 | The MVP ledger uses Bun's built-in `bun:sqlite`; libSQL or Turso synchronization is a later adapter and remains disabled until retention policy and operational need justify it | Planned |
| D13 | A strict evaluator verdict is execution-scoped evidence, not a mutable property of a Beads issue. Schema v2 carries `executionRunId`, `beadsIssueId`, and typed evaluator identity. A human verdict names an actor kind; a model verdict carries requested provider/model/tier, observed provider/model, separate evidence sources for provider selection and response model, and the tier-policy decision. The active correlation declares the create-once, workspace-contained path. The gate reads once, cross-checks identity and both run IDs, applies policy, and hashes that same buffer into the gate record | Planned; current task-only schema is tracked by `empi` |

## Target topology

```text
Windows operator
  Codex or Claude Code + Beads + plans + selected diff viewer
                     |
 authenticated TLS over VPN or SSH loopback forward
                     |
Dedicated private Linux control plane
  readiness and policy adapters
  Headroom library or MCP adapter -> approved verbose inputs only
            |                              |
            |                       dedicated OpenHands VM
            |                       one selected Git worktree
            |
     optional isolated 9Router VM or container
     loopback-only authenticated routes; no host privilege
                     |
              model-provider adapter
            /                          \
private Ollama on GPU host       approved hosted providers

Execution facts from clients, workers, routes, gates, and evaluators
                     |
             local Bun SQLite run ledger
        optional libSQL or Turso adapter only later

Retrieval path remains separate:
repos and knowledge -> chunk -> Ollama embed -> harness pgvector -> cited top-K
```

## Proposed adapter boundaries

The phase plans may refine names, but implementations must preserve these small public surfaces.

```typescript
type EmbeddingRequest = {
  texts: readonly string[];
  model: string;
  expectedModelDigest: string;
  requestedDimensions: number;
};

type EmbeddingBatch = {
  vectors: number[][];
  provider: string;
  model: string;
  modelDigest: string;
  requestedDimensions: number;
  returnedDimensions: number;
};

interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingBatch>;
}

type HostTaskScope =
  | { kind: "agent-team"; id: string }
  | { kind: "named-list"; id: string }
  | { kind: "standalone-session"; id: string };

type RunCorrelation = {
  schemaVersion: 1;
  executionRunId: string;
  beadsIssueId: string;
  evaluatorVerdictPath?: string;
  hostTaskScope?: HostTaskScope;
  hostTaskId?: string;
  creatorHostSessionId?: string;
  creatorTeammateName?: string;
  completerHostSessionId?: string;
  completerTeammateName?: string;
  checkout: string;
  worktree?: string;
  worker: string;
};

type ArtifactReference = {
  kind: "manifest" | "events" | "report" | "evaluator-verdict";
  path: string;
  sha256: string;
  bytes: number;
};

type EvaluatorIdentity =
  | {
      kind: "human";
      actorKind: "operator" | "reviewer";
    }
  | {
      kind: "model";
      requestedProvider: string;
      requestedModel: string;
      requestedTier: string;
      observedProvider: string;
      observedModel: string;
      providerEvidence: "selected-direct-transport" | "gateway-routing";
      modelEvidence: "response-field" | "gateway-routing";
      tierPolicyDecision: "allowed" | "rejected";
      tierPolicyRule: string;
    };

type EvaluatorArtifactReference = ArtifactReference & {
  kind: "evaluator-verdict";
  verdictSchemaVersion: 2;
  executionRunId: string;
  beadsIssueId: string;
  evaluator: EvaluatorIdentity;
};

interface RunEventSink {
  beginExecutionRun(
    input: Omit<RunCorrelation, "executionRunId"> & {
      /** Only an upstream source that already reserved this ID may supply it. */
      executionRunId?: string;
    },
  ): Promise<RunCorrelation>;
  append(event: RunLedgerEvent): Promise<void>;
}

interface RunLedgerReader {
  readRun(runId: string): Promise<RunSnapshot | null>;
}

interface CouncilRunProducer {
  record(
    run: CouncilRun,
    artifacts: CouncilArtifactPaths,
    correlation: RunCorrelation,
  ): Promise<void>;
}

interface QualityGateProducer {
  record(
    gate: QualityGateResult & {
      evaluatorArtifact: EvaluatorArtifactReference | null;
    },
    correlation: RunCorrelation,
  ): Promise<void>;
}

interface ContextReducer {
  reduce(input: ReducerInput): Promise<ReducerResult>;
}

interface WorkerRuntime {
  execute(request: WorkerRequest): Promise<WorkerHandoff>;
}

interface ServiceProbe {
  inspect(): Promise<ServiceReadiness>;
}
```

Complex vendor behavior belongs behind these interfaces. Callers should not need to know SQLite details, Headroom cache rules, OpenHands container details, or router-specific response shapes. The council producer normalizes `CouncilRun.events` and `CouncilRun.records`, but the default ledger row never copies `SeatRecord.output` or a free-text `SeatRecord.error`; it stores metadata, an output hash, bounded status or error classification, and finding or recommendation counts. Configured provider and model remain the request identity. Every successful direct provider transport maps the model and response ID reported by its response into observed routing; the gateway path additionally records upstream provider when available. Missing required actual identity is explicit and fails the pilot completeness gate rather than being inferred. The OpenHands producer follows the same rule at the worker's actual LLM invocation boundary: configured SDK metrics remain requested-route evidence, while a tag-qualified adapter separately records response ID, provider evidenced by the selected direct transport plus response-reported model, or trusted gateway-routing provider/model. A configured model alone never satisfies observed worker provenance. Artifact references are hashed only after persistence succeeds. For strict evaluation, the quality gate selects an execution-scoped create-once verdict through the validated correlation, reads it once, cross-checks Beads, execution, evaluator, and tier-policy identity, then writes that same buffer's path, digest, and byte count into the gate-log entry. `councilChairVerdict`, `qualityGatePassed`, and `evaluatorVerdict` remain distinct facts.

## TDD strategy

Implementation follows the repository TDD skill: one observable failing behavior, minimal passing code, then the next vertical slice. Tests use public interfaces and fake or local boundaries. CI never requires a live model, external agent host, provider credential, or paid call.

The first tracer is behaviors 1 through 6, delivered as small red-green slices. It proves metadata-only council readback, gateway and direct-provider identity capture for council seats, host-neutral hook correlation, and immutable gate-to-human-evaluator provenance without provisioning new hardware. Model-evaluator schema paths are fixture-tested here, but a live model-evaluator claim waits for an invocation producer that owns that separate transport.

| # | Behavior as a specification | Proposed test file | Tracer |
|---|---|---|---|
| 1 | Given one deterministic fake `CouncilRun`, returned artifact paths, and correlation whose execution ID exactly equals the council's already-reserved `runId`, the adapter stores configured provider and model, ordered event metadata, output hashes, finding or recommendation counts, artifact hashes, and the council-chair verdict; serialized ledger rows contain neither parsed model output nor free-text model errors, and disabled mode leaves current artifacts unchanged | `scripts/run-ledger/council-sink.test.ts` | Yes |
| 2 | A gateway record fixture stores observed upstream provider and model separately from the configured request; absent optional gateway routing remains visibly missing and is never inferred | `scripts/run-ledger/council-sink.test.ts` | Yes |
| 3 | OpenAI Responses, Anthropic Messages, and direct OpenAI-compatible chat fixtures for DeepSeek and Qwen each map their response-reported model and response ID into observed identity; a successful response without required identity is flagged and cannot satisfy pilot completeness | Extend `scripts/council/provider-contract.test.ts` | Yes |
| 4 | The normal Forge launcher creates an explicit correlation containing Beads and execution identity and passes its path to the gate; it never invokes `TaskCreate`. Invoking the gate with TaskCompleted or TeammateIdle JSON on stdin and no identity environment variables still records the correct event and never treats a host ID as Beads identity. If a future policy-approved host bridge is enabled, TaskCompleted derives scope from `team_name`, an explicitly configured named task-list ID, or a standalone session and selects the scoped record. Tests prove the required path works with no host task, a lead-created optional team task can be completed by another teammate session, the same `task_id` in two scopes does not collide, and neither raw host identity nor malicious stdin can reach a command string or Beads lookup | Add `scripts/quality-gate-hook.test.ts` and `scripts/run-ledger/quality-gate-producer.test.ts` | Yes |
| 5 | A schema-v2 strict evaluator verdict carries `executionRunId`, `beadsIssueId`, and typed human or model evaluator identity and is created once at the normalized execution-scoped path declared by the active correlation. A model verdict includes requested provider/model/tier, verifiably observed provider/model with evidence source, and tier-policy decision. The gate reads it once, rejects either ID mismatch, missing evaluator identity, or weaker fallback, validates policy, hashes that exact buffer, and writes path, SHA-256, byte count, both IDs, and evaluator identity into the same gate-log entry. Tests reject stale evidence and two concurrent runs for one Beads issue; overwriting the file after validation cannot change the recorded evidence | Extend `scripts/eval-verdict.test.ts` and add `scripts/quality-gate-hook.test.ts` | Yes |
| 6 | A council correlation whose execution ID differs from `CouncilRun.runId` is rejected; a duplicate begin-run is rejected by the unique constraint; and non-council workflows obtain an ID through one `beginExecutionRun` allocator. A gate record carrying the same explicit execution ID enriches the run, while a missing or mismatched ID remains unlinked and visible and council-chair, gate, and evaluator verdicts remain distinct | `scripts/run-ledger/ledger.test.ts`, `scripts/run-ledger/council-sink.test.ts`, and `scripts/run-ledger/quality-gate-producer.test.ts` | Yes |
| 7 | The `bun:sqlite` ledger rejects invalid event ordering, redacts configured secrets, defaults to metadata-only content, and applies migrations idempotently without adding a database client dependency | `scripts/run-ledger/ledger.test.ts` | No |
| 8 | Readiness returns the standard JSON envelope, reports missing secret names without values, and fails closed for a raw service bound to `0.0.0.0` or another public interface | `scripts/self-host/doctor.test.ts` | No |
| 9 | A selected service profile can be rendered and validated without mutating the host, and backup metadata can be restored into a temporary target | `scripts/self-host/profile.test.ts` | No |
| 10 | The Ollama adapter verifies the requested model and expected digest against `/api/tags`, records requested dimensions and every returned vector length around `/api/embed`, and fails before pgvector upsert if the digest changes or any dimension differs | `scripts/harness-ingest/embedding-provider.test.ts` under `9n1` | No |
| 11 | An OpenHands request cannot start without an otherwise-empty single-purpose VM isolation boundary, exactly one validated worktree, permitted commands, a completion gate, a tag-verified loopback listener, and effective mount, environment, socket, and egress audits. The prebuilt Canvas runtime uses `AGENT_CANVAS_DISABLE_TELEMETRY=1` or its tag-verified `--disable-telemetry` equivalent, the agent-server exporter is `none`, and no pre-consent `canvas_install` event is observed. At the actual LLM invocation boundary, fixtures separate configured SDK route from response ID plus direct-transport provider/response-model or trusted gateway-routing evidence, exercise fallback divergence, and fail worker provenance when observed identity is missing | `scripts/openhands/adapter.test.ts` | No |
| 12 | The reducer bypasses exact and sensitive input classes, uses an explicit library or MCP call rather than transparent proxy interception, requires `HEADROOM_OFFLINE=1` or the tag-verified `--offline` master switch plus a probe that rejects Headroom product, update, license, beacon, and model-download egress while leaving only separately approved provider traffic, keeps beacon-off as defense in depth, disables CCR by default, and logs original-versus-reduced provenance. Any later CCR exception requires approved input classes, backend, filesystem protection, TTL, and deletion behavior | `scripts/context-reducer/headroom.test.ts` | No |
| 13 | An evaluator route refuses a weaker fallback and every gateway result records actual provider and model; an affected or unverified 9Router version is a hard no-go. For the exact tag and start mode, a live socket check rejects non-loopback binding and unauthenticated negative tests must reject requests across the tag's `/v1`, `/api/v1`, `/codex`, dashboard/admin, proxy, and locality-sensitive endpoint families. A `404` counts only when the tag-qualified route inventory proves that endpoint is absent; an existing route must return an authentication failure | Extend `scripts/council/integrations.test.ts` or add `scripts/council/self-host-gateway.test.ts` | No |
| 14 | An AgentFS experiment cannot write outside its disposable session and exports a reproducible Git-reviewable diff | Phase-specific integration test selected after current platform support is verified | No |

Refactor watch list after green:

- Keep ledger storage, redaction, and producer mapping behind one sink rather than adding SQLite calls throughout council and hook code.
- Extract only provider-neutral validation that is genuinely shared; do not destabilize the working council engine for a theoretical universal model layer.
- Keep deployment manifests separate from runtime policy so hardware and service placement can change without changing caller contracts.
- Prefer one event envelope with explicit versioning over parallel council, hook, OpenHands, and router schemas.
- Mock only upstream HTTP, process, filesystem-sandbox, and database boundaries. Do not mock internal mapping functions merely to assert call order.

## Build sequence and demo checkpoints

### Checkpoint A - Freeze the MVP contract and baseline

Beads: `agent-forge-harness-ulpz.1`
Type: HITL
Dependencies: none

Steps:

1. Record the real Windows, Linux, network, storage, and GPU inventory.
2. Classify identifiers, prompts, responses, tool output, source snippets, artifacts, execution-scoped evaluator files, reversible caches, and external-product analytics as local, sync-eligible, or never retained. The private default disables outbound product telemetry; any exception requires explicit endpoint, field, purpose, retention, and consent approval.
3. Freeze mandatory MVP components and optional experiments.
4. Select 10 to 20 representative tasks spanning mechanical work, routine fixes, retrieval, planning, and evaluation. Capture current tokens when available, elapsed time, retries, gate result, repair passes, and findings.
5. Resolve the `9n1` conflict in the two binding authorities before implementation: revise `docs/plans/harness-rag-local-vector.md` and update the `agent-forge-harness-9n1` description and acceptance criteria. The result uses a stack-owned pgvector contract, environment-selected connection, Ollama-first embedding adapter, required digest, explicit requested and returned dimensions, versioned index, and no operational dependency on `rag-chat` or legacy port 5432. Remove the stale `7fx` and `c7v` links because those are closed D&D work; if implementation decomposition is useful after the freeze, create new child issues under `9n1`. Superseded ideas from an ignored local draft may be named only as rejected historical alternatives.
6. Treat live-diff behavior as selection criteria. Confirm the exact `Diffy` project before installation, or record a no-go and use ordinary Git diff plus the existing dashboard.
7. Record version and advisory freshness checklists for each external component.
8. Record the execution-identity policy: the MVP follows root `AGENTS.md`, does not use Claude `TaskCreate`, and treats any host-task identity as optional metadata. A future bridge is out of scope unless the governing policy is explicitly amended to permit Claude tasks solely as ephemeral execution handles bound to an existing Beads issue, with no task intent or status authority.

Demo:

```powershell
bd show agent-forge-harness-ulpz.1
bd comments agent-forge-harness-9n1
```

The operator sees the resolved topology, data policy, golden-set definition, and RAG migration decision. No external service is started.

Stop point: if host inventory or retention cannot meet the binding invariants, stop after local ledger work and do not deploy remote services.

### Checkpoint B - Persist one local run end to end

Beads: prerequisite bugs `agent-forge-harness-0xxt` then `agent-forge-harness-empi`; ledger feature `agent-forge-harness-ulpz.3`
Type: AFK implementation in dependency order, then HITL for one live council-provider proof
Dependencies: `empi` depends on `0xxt`; `ulpz.3` depends on `ulpz.1` and `empi`

Steps:

1. **`0xxt` owns the correlation foundation.** Add the versioned `RunCorrelation` type, validation, normalized create/load helpers, and a launcher-init boundary that allocates a random execution ID unless an upstream workflow supplies its already-reserved ID. The normal launcher writes `beadsIssueId`, execution ID, checkout, worktree when present, worker, and declared evaluator path; it does not call `TaskCreate`.
2. **`0xxt` owns hook and gate-log identity.** Parse `TaskCompleted` and `TeammateIdle` JSON from stdin, keep any host task-list scope and ID optional and separate, invoke `bd` only through argument arrays with the validated Beads ID, and migrate the versioned quality-gate identity plus dashboard compatibility reader. Without an approved bridge, an unbound host event can run base gates but remains visibly unlinked and cannot satisfy strict Forge completion. A future policy-approved bridge uses canonical scoped keys, separate creator/completer actors, cross-session shared-list completion, and collision tests.
3. **`empi` consumes that correlation foundation and owns verdict v2.** Migrate the parser, protocol, every evaluator/feature/ship writer instruction, and generated mirror together to explicit `beadsIssueId`, `executionRunId`, and typed evaluator identity. Human verdicts carry actor kind. Model verdicts carry requested provider/model/tier, observed provider/model, separate provider/model evidence sources, and tier-policy decision. Values must be verifiably exposed by that evidence, never inferred from the request.
4. **`empi` owns strict selection and transient-file lifecycle.** Write only to the correlation-declared, normalized `.tmp/work/evaluations/<sha256(executionRunId)>/verdict.json` with create-once semantics. The gate reads one buffer, cross-checks both IDs and evaluator policy, rejects missing identity or weaker fallback, and appends that buffer's path, SHA-256, byte count and identity in the same gate record. Extend contained cleanup and tests for the `ulpz.1` retention; no later producer reopens the file for ledger evidence.
5. **`ulpz.3` consumes both prerequisites.** Add a versioned run-event contract, no-op sink, and `beginExecutionRun` registry adapter. The SQLite implementation atomically inserts the correlation execution ID under a unique constraint, uses forward-only idempotent migrations, and adds no database client dependency; a future libSQL or Turso adapter remains outside the MVP.
6. **`ulpz.3` owns the metadata-only projection.** Store runs, ordered event metadata, sanitized provider records, artifact references, gates, and evaluations. For each model record store identity, timings, usage, status, output hash, and counts only; never copy parsed output or free-text errors into the default ledger.
7. **`ulpz.3` owns council integration.** At the shared post-persistence boundary, map one deterministic fake-provider run and its correlation without changing manifest, events, or report artifacts. Require `CouncilRun.runId === RunCorrelation.executionRunId`, reject duplicate begin, and hash returned artifacts only after they exist rather than using the earlier `onResult` observer.
8. Treat configured council-seat provider/model as the request. Prove gateway-observed identity, then add response fixtures for OpenAI Responses, Anthropic Messages, and direct OpenAI-compatible DeepSeek and Qwen transports; missing response-reported model or response ID fails completeness instead of being filled from the request.
9. Add readback through a small library and JSON CLI or report. Unmatched evidence is reported, never joined heuristically; council-chair, gate, and evaluator verdicts remain separate. Instrument CLI and dashboard first at `executeCouncilReview`; mark calibration explicitly outside initial coverage while it bypasses that boundary.
10. Add redaction, output-omission, failure, retry, cancellation, verdict-overwrite, stale-verdict, concurrent-same-Beads-run, missing-evaluator-identity, weaker-fallback, run-ID mismatch, duplicate-begin, hook-stdin, task-scope collision, ambiguous-correlation, disabled-mode, compatibility-reader, and contained-cleanup tests.
11. Place the disposable database under ignored local state, verify `*.db`, add only necessary sidecar ignores, document backup, and leave ledger/cache cloud sync disabled.
12. After fixture-backed tests pass, require one operator-approved direct-provider council smoke run for council-seat response identity, paired with a schema-v2 human evaluator verdict carrying actor kind. Until recorded, code can be implementation-complete but the live ledger gate remains pending. Coding-worker and model-evaluator transport provenance require their own producers and live proofs in Checkpoint F and the first adopted model-evaluator route.

Demo:

Current council command, valid before ledger code exists:

```powershell
$runId = "self-host-ledger-demo-$([guid]::NewGuid().ToString('N'))"
bun run council -- plan docs/plans/self-hosted-ai-agent-stack.md --profile councils/default.json --run-id $runId --json
```

Target demo after this checkpoint lands:

```powershell
bun test scripts/run-ledger
bun run self-host:ledger -- run $runId --json
```

The target demo explicitly binds a real Beads issue to the council's reserved execution ID through the launcher correlation, with no Claude host task, then runs the quality gate with that correlation. It proves that `bd` and evaluator lookup receive only the Beads issue and that the execution-scoped human verdict contains actor-kind identity. Hook-shaped stdin fixtures separately prove event parsing and namespace separation; conditional bridge fixtures cover cross-session team completion and identical task IDs in two scopes without invoking `TaskCreate`. The default fake-profile command proves deterministic plumbing but does not satisfy the live council-model gate. After separate operator approval for credentials and spend, one direct-provider council smoke run proves that readback contains Beads and execution identity, checkout, requested and response-reported council-seat model, metadata-only event and artifact evidence, gate, council-chair verdict, and execution-bound human-evaluator provenance without secret values or model output. It does not prove coding-worker or model-evaluator transport identity. The phase plan finalizes the new ledger and correlation-init command names; the council command above already matches the current CLI.

Rollback: disable the sink and remove the disposable local database; existing council artifacts continue to work.

### Checkpoint C - Establish the private substrate

Beads: `agent-forge-harness-ulpz.2`
Type: HITL for host access
Dependencies: `ulpz.1`

Steps:

1. Define a versioned service profile for only the components selected by Checkpoint A.
2. Pin reviewed image or package versions and record source, license, advisory date, and rollback version.
3. Use internal container networks and loopback binds. A VPN address is not an exception to the existing non-local HTTP rejection: use authenticated TLS over the VPN or an SSH port-forward whose client endpoint is loopback.
4. Inject secrets at runtime and expose only missing secret names in readiness output.
5. Add health, dependency, storage-capacity, model-presence, version, and exposure probes with the standard JSON envelope.
6. Define persistent volumes and exercise backup, restore, restart, and version rollback in disposable storage.
7. Document Windows client and Linux host commands without committing machine-specific endpoints.

Demo:

Target demo after this checkpoint lands:

```powershell
bun run self-host:doctor -- --profile core --json
```

The report shows selected services healthy, private, pinned, and recoverable, or fails with actionable non-secret errors. A separate host-side check shows no raw service port reachable from the public interface.

Rollback: stop the profile and restore the prior pinned version and database backup.

### Checkpoint D - Deliver Ollama-first harness retrieval

Beads: existing peer feature `agent-forge-harness-9n1`
Type: AFK adapter and fixture work only after both blockers complete; HITL for the already-approved source, version, install, service start, and live golden-set proof
Relationship: tracked by `ulpz`; all work is blocked by `ulpz.1` and the operator-approved substrate in `ulpz.2`

Steps:

1. Consume the reconciled contract produced by `ulpz.1` in the committed `docs/plans/harness-rag-local-vector.md` and the `agent-forge-harness-9n1` issue. Preserve superseded OpenAI, Qdrant, and shared-product assumptions only as committed decision history; an ignored local draft is neither updated nor accepted as authority.
2. Make pgvector ownership stack-local and the connection explicit; keep data in `harness.*` and never require the `rag-chat` Compose project or database.
3. Add a provider-neutral embedding contract and Ollama adapter with model, required digest resolved from `/api/tags`, requested dimensions, returned vector length, chunk-policy, and index-version metadata. Do not expect `/api/embed` to return a digest or explicit dimension field.
4. Fail before upsert on dimension or index-version mismatch and document the migration path for changing models.
5. Preserve idempotent repo-plus-revision ingestion and structured citations.
6. After `ulpz.2` records approved, pinned Ollama and pgvector services and the operator authorizes their start, pilot one registered repository and score a reviewed golden set.
7. Keep a hosted embedding adapter optional; do not make a live hosted key a CI requirement.

Demo:

Target demo after this checkpoint lands:

```powershell
bun test scripts/harness-ingest
bun run harness:rag:ingest -- --repo <pilot> --dry-run
bun run harness:rag:eval -- --repo <pilot> --json
```

The evaluation returns cited files or symbols with at least the threshold approved in `ulpz.1`. Command names and the exact corpus are finalized in the refreshed `9n1` plan.

Rollback: retain the previous index until the new model and schema pass; switching the embedding provider never mutates an incompatible index in place.

### Checkpoint E - Select and validate an operator diff workflow

Beads: `agent-forge-harness-ulpz.4`
Type: HITL
Dependencies: `ulpz.1`

Steps:

1. Turn the source brief's desired behaviors into selection criteria: trustworthy project identity, license and release provenance, read-only monitoring, multiple repository or worktree roots, live change visibility, and clear scope labeling.
2. Confirm the intended `Diffy` repository before any installation. If no exact or qualified project exists, record a no-go and select a verified alternative or the ordinary Git diff plus existing dashboard fallback.
3. Configure only the chosen viewer's supported surfaces; do not promise tabs or automatic multi-worktree anomaly detection unless the pinned product demonstrates them.
4. Demonstrate live detection of an intentional change in an active worktree and verify the same change in ordinary `git diff`.
5. Document that revert, delete, merge, push, and acceptance remain deliberate human or harness actions.

Demo: make an intentional disposable file edit in a test worktree and confirm it appears in the selected viewer and ordinary `git diff`; if no viewer qualifies, demonstrate and document the fallback instead.

Rollback: uninstall or stop the selected viewer without changing any harness policy or repository data.

### Checkpoint F - Pilot one constrained OpenHands worker

Beads: `agent-forge-harness-ulpz.5`
Type: HITL
Dependencies: `ulpz.2`, `ulpz.3`
Related: `agent-forge-harness-3u6`, `agent-forge-harness-t1b1`

Steps:

1. Refresh official self-hosting, security, authentication, networking, model-compatibility, and telemetry evidence for the exact pinned version before installation approval.
2. Use an otherwise-empty, single-purpose, disposable Linux VM as the first pilot's isolation boundary, separate from the control plane and any credential-concentrating gateway. Direct Canvas is acceptable only because the entire VM is disposable and contains no unrelated files, environment secrets, identities, or services. If the pinned tag instead uses DockerWorkspace or RemoteWorkspace, approve the exact image tag and start mode, publish only `127.0.0.1:<port>:8000`, mount only the exact selected worktree and disposable scratch path, and expose no control-plane Docker socket or broad host path. In either mode, use a dedicated state directory and never mount an operator home or projects root.
3. Hard-disable prebuilt Agent Canvas analytics at runtime with `AGENT_CANVAS_DISABLE_TELEMETRY=1` or the pinned tag's verified `--disable-telemetry` equivalent. `VITE_DO_NOT_TRACK=1` is acceptable only when building Canvas from source and is not the prebuilt-runtime control. Set the agent-server exporter explicitly to `OH_TELEMETRY_EXPORTER=none`; require an egress probe that observes no pre-consent `canvas_install` event or other product analytics. Any outbound product metadata instead requires classification and consent in `ulpz.1`.
4. Deny cloud metadata and unrelated private networks; grant only required provider and Git destinations.
5. Use short-lived or narrowly scoped credentials and a command allowlist or sandbox policy.
6. Map Agent Forge lifecycle moments to explicit commands: session checks, task claim and run start, risky-operation policy, repo-specific quality gate, structured handoff, and run completion.
7. Add a pinned-tag producer at the actual worker LLM invocation boundary. Store configured SDK provider/model as requested-route evidence, then separately capture response ID, provider evidenced by the selected direct transport plus response-reported model, or trusted gateway-routing provider/model. Fixture-test direct success, missing response identity, and a fallback whose observed route differs from configuration; missing observed identity fails worker provenance instead of being filled from SDK metrics.
8. Run one bounded non-production task with no merge, push, deploy, or unrelated-repository authority.
9. Before credentials are injected, inspect the live socket table, effective mounts, environment exposure, container or VM boundary, and any Docker socket. Reject `0.0.0.0`, unintended listeners, broad mounts, or control-plane socket access. Verify Canvas analytics and agent-server export are disabled and fail if the egress probe observes `canvas_install` or another analytics request.
10. Record intervention rate, completion quality, repair passes, elapsed time, requested and observed worker provider/model plus evidence source and response ID, artifacts, gate, and evaluator result against the baseline.

Demo: execute the approved pilot task, inspect its ledger record and worktree diff, run the affected repository's gates, and show that the worker stops before merge or push.

Rollback: terminate the worker, revoke its credentials, discard its worktree, and preserve the ledger and review artifacts.

### Checkpoint G - Measure Headroom with a bypass-first reducer

Beads: `agent-forge-harness-ulpz.6`
Type: HITL for source, version, and install approval; then AFK experiment; then HITL adoption review
Dependencies: `ulpz.1`, `ulpz.3`

Steps:

1. Add a no-op reducer and typed bypass reasons before adding Headroom. After the operator approves the exact source, version, license, advisory state, and installation, integrate the pinned package through an explicit in-process library call or on-demand MCP tool so Agent Forge chooses which content classes are eligible; do not begin with a transparent all-traffic proxy.
2. Permit only approved verbose classes such as repetitive search results, test logs, retrieval context, and bounded handoff history.
3. Enforce hard bypass for exact and sensitive classes.
4. Require Headroom's master offline mode, `HEADROOM_OFFLINE=1` or the pinned proxy's verified `--offline` equivalent, and prove that Headroom product, update, license, beacon, and model-download egress is denied. Separately approved provider inference traffic may remain; the probe distinguishes it from Headroom-originated control-plane traffic. Set any version-specific upload beacon off as defense in depth, but never treat beacon state alone as offline readiness. Revalidate behavior rather than merely checking environment-variable presence because defaults and accepted values have changed across releases.
5. Disable Context Correlation and Retrieval by default with the tag-verified `--no-ccr` or equivalent, so the pilot does not retain original content in a reversible cache. A later CCR experiment first amends `ulpz.1` with the eligible data classes, exact backend, filesystem access protection, encryption and sync decision, TTL, deletion verification, and failure behavior; the readiness probe must then verify those effective settings.
6. Run matched golden tasks with and without reduction and write tokens, latency, retries, repair passes, gate result, evaluator findings, and bypass reason to the ledger.
7. Adopt only task classes that meet the approved savings threshold with no quality regression.

Demo:

Target demo after this checkpoint lands:

```powershell
bun test scripts/context-reducer
bun run self-host:benchmark -- --variant no-reducer
bun run self-host:benchmark -- --variant headroom
```

The commands run only after the installation approval. The comparison shows per-class outcomes and the operator can disable the reducer with one configuration change.

Rollback: select the no-op reducer; no caller or stored artifact format changes.

### Checkpoint H - Decide whether 9Router earns a gateway role

Beads: `agent-forge-harness-ulpz.7`
Type: HITL decision
Dependencies: `ulpz.2`, `ulpz.3`
Related: `agent-forge-harness-t1b1`

Steps:

1. Document the measured problem that direct adapters do not solve.
2. Refresh the maintainer and GitHub advisory record, release notes, authentication guidance, license, and provider terms. Explicitly account for critical CVE-2026-46339 and later authentication, RCE, and SSRF advisories; any affected, ambiguous, or unverified candidate version is a hard no-go.
3. Compare direct adapters with a private gateway for failure modes, secret concentration, logging, quotas, cost, maintenance, and evaluator guarantees.
4. Close as no-go if convenience is the only benefit or the service cannot meet the binding invariants.
5. If approved, isolate 9Router from the control plane, run it without root, sudo, a Docker socket, or unrelated filesystem access, pass the exact tag's loopback control, and fail readiness unless the live socket table shows only intended loopback listeners.
6. Treat authentication configuration as untrusted until exercised. Inventory the exact tag's route families, then send unauthenticated requests across its `/v1`, `/api/v1`, `/codex`, dashboard/admin, proxy, and locality-sensitive endpoints and require authentication rejection before adding credentials. A `404` counts only when the tag-qualified route inventory proves the route is absent; an existing route must return an authentication failure. Then pilot authenticated top, default, cheap, and embedding routes with actual-model logging.
7. Test provider failure, quota exhaustion, timeout, malformed response, route refusal, direct-provider escape, and evaluator fail-closed behavior.

Demo: a deterministic fake or local test exercises the routing matrix. Any live request requires explicit credentials and spend approval.

Rollback: disable the gateway endpoint and use the already-qualified direct provider adapter.

### Checkpoint I - Experiment with AgentFS below the worktree boundary

Beads: `agent-forge-harness-ulpz.8`
Type: HITL for source, version, and install approval; then AFK experiment; then HITL adoption review
Dependencies: `ulpz.2`, `ulpz.5`

Steps:

1. Refresh current platform support, beta status, source, version, license, advisory state, backup, export, and recovery behavior, then obtain operator approval before installing or running AgentFS.
2. Select a disposable read-mostly documentation or test-generation task with no production secret.
3. Keep the original checkout read-only and wrap only the disposable worktree.
4. Verify file and tool timeline completeness, write containment, diff export, discard, restore, and performance.
5. Export a reproducible diff into the ordinary Git review and quality-gate flow.
6. Record adopt, experiment further, or reject. Do not remove the worktree and backup baseline.

Demo: only after source, version, and installation approval, inspect the AgentFS timeline, export the diff, reproduce it in Git, run the relevant quality gate, then discard and restore the session.

Rollback: discard the AgentFS session, disable the adapter, remove the operator-approved package if requested, and continue with ordinary worktrees.

## Beads issue map

| Beads ID | Type | Priority | Role | Depends on |
|---|---|---:|---|---|
| `agent-forge-harness-ulpz` | Epic | P2 | Umbrella and canonical acceptance | Tracks `9n1` |
| `agent-forge-harness-ulpz.1` | Decision | P2 | MVP topology, policy, golden baseline, and RAG contract | None; in progress |
| `agent-forge-harness-0xxt` | Bug | P1 | Parse hook stdin and establish separate optional Claude host, Beads, and execution correlation | None; blocks `empi` |
| `agent-forge-harness-empi` | Bug | P1 | Bind strict evaluator verdicts to execution runs | `0xxt`; blocks `ulpz.3` |
| `agent-forge-harness-9n1` | Peer feature | P2 | Ollama-first harness RAG and cited retrieval | Blocked by `ulpz.1` and `ulpz.2`; tracked by `ulpz` |
| `agent-forge-harness-ulpz.2` | Feature | P2 | Private service substrate and recovery controls | `ulpz.1` |
| `agent-forge-harness-ulpz.3` | Feature | P2 | Local Bun SQLite run-ledger tracer | `ulpz.1` and `empi` (`0xxt` transitively); related to `t1b1` |
| `agent-forge-harness-ulpz.4` | Decision | P3 | Select and validate a live-diff workflow or fallback | `ulpz.1` |
| `agent-forge-harness-ulpz.5` | Feature | P2 | Constrained OpenHands worker | `ulpz.2`, `ulpz.3`; related to `3u6` and `t1b1` |
| `agent-forge-harness-ulpz.6` | Feature | P3 | Headroom A B evaluation | `ulpz.1`, `ulpz.3` |
| `agent-forge-harness-ulpz.7` | Decision | P3 | 9Router go or no-go and optional pilot | `ulpz.2`, `ulpz.3`; related to `t1b1` |
| `agent-forge-harness-ulpz.8` | Task | P4 | Disposable AgentFS experiment | `ulpz.2`, `ulpz.5` |

Dependency direction:

```text
0xxt ----> empi ----> ulpz.3

ulpz.1
  |----> ulpz.2 ----+----> ulpz.5 ----> ulpz.8
  |        |        |         ^
  |        +----> 9n1         |
  |----> ulpz.3 ----+---------+
  |       |         |
  |       +----> ulpz.6
  |       +----> ulpz.7 <----- ulpz.2
  |
  +----> ulpz.4
  |
  +----> 9n1 (contract freeze)

ulpz tracks 9n1 without moving the existing feature into this epic.
```

## Files and surfaces expected to change

Exact filenames for external-product phases are finalized by their phase plans after freshness review.

| Surface | Expected change |
|---|---|
| `docs/plans/self-hosted-ai-agent-stack.md` | Canonical shared master plan |
| Root `AGENTS.md` | No MVP change; its Beads-only task policy remains binding. A future host-task bridge must name and review an explicit non-authoritative exception before this file changes |
| `docs/plans/harness-rag-local-vector.md` | Remove the operational dependency on the `rag-chat` pgvector container, remove stale `7fx`/`c7v` ownership, and align the harness-owned contract |
| Beads `agent-forge-harness-9n1` | Replace stale Qdrant and generic collection wording with the approved pgvector, embedding provenance, and cited-retrieval contract; create new child issues only after the contract freeze if smaller implementation slices are needed |
| `package.json` | Named readiness, ledger, benchmark, and RAG commands as slices land |
| `.gitignore` | Existing `*.db` covers the local ledger; change only if SQLite sidecars, caches, generated secrets, or external runtime state are not already covered |
| `scripts/run-ledger/` | Versioned events, sink, local database, readback, and tests |
| `scripts/self-host/` | Profile validation, readiness, privacy and exposure checks, backup and restore helpers |
| `scripts/council/providers.ts` and provider contract tests | Capture response-reported model and response ID for each successful direct transport |
| `scripts/council/` | Thin metadata-only ledger mapping and explicitly qualified local or gateway transport behavior; calibration is either routed through the shared producer or marked outside initial coverage |
| `scripts/eval-verdict.ts`, `.claude/protocols/evaluation-verdict.md`, `scripts/tmp-work-cleanup.ts`, and parser or cleanup tests including `scripts/tmp-work-cleanup.test.ts` | Version strict verdict identity to include Beads issue, execution run, and typed evaluator identity; migrate parsing and bounded nested cleanup to execution-scoped create-once paths |
| `.claude/agents/evaluator.md`, `.claude/workflows/feature.md`, `.claude/commands/ship.md`, `.claude/molecules/README.md`, and `.claude/protocols/model-tier-policy.md` | Migrate every operational verdict writer or path instruction from task-only schema v1 to the correlation-declared execution path and required evaluator identity |
| `.agents/skills/forge-roles/references/evaluator.md`, `.agents/skills/ship/SKILL.md`, and any other generated mirror found by the migration assertion | Keep generated Agent Forge instructions synchronized with the authoritative evaluator and ship contracts |
| `.claude/hooks/quality-gate.ts`, `scripts/quality-gate-identity.ts`, and hook or identity tests under `scripts/` | Parse Claude hook stdin, cross-check explicit correlation, emit distinct execution/Beads/optional-host fields, validate evaluator IDs and identity from one read buffer, and capture its digest and byte count in the gate log |
| `scripts/dashboard/forge-run-model.ts` and dashboard API/model fixtures | Read versioned gate-log identity without losing or relabeling legacy records; show optional scoped host identity separately from required Beads and execution identity |
| `scripts/harness-ingest/` | Refreshed `9n1` embedding, ingestion, retrieval, and evaluation work |
| `scripts/openhands/` | Runtime adapter, policy, handoff, and behavior tests |
| `scripts/context-reducer/` | No-op reducer, Headroom adapter, bypass policy, and A B evaluation |
| `.claude/` and generated `.agents/` mirror | Only durable host-neutral instruction or lifecycle changes that survive client differences |
| Operator and deployment docs | Private topology, secrets, backup, restore, upgrade, rollback, selected diff-viewer or fallback workflow, and incident steps |

## Storage and data lifecycle

| Store | Authority | Default contents | Default sync |
|---|---|---|---|
| Beads | Task intent and dependency graph | Task IDs, AC, status, dependencies, comments | Existing Dolt workflow |
| Git and ordinary files | Source and reviewed artifacts | Plans, patches, commits, reports | Existing Git workflow |
| Harness pgvector | Retrieval index | Chunks, citations, embeddings, model and index metadata | Local stack only |
| Bun SQLite ledger | Execution evidence | Beads/execution/optional-host IDs, event metadata, output and artifact hashes, timings, requested/observed model routes, usage, gates, typed evaluator identity and verdicts; no raw model output or free-text error by default | Off; no remote adapter |
| Execution-scoped verdict files | Short-lived strict evaluator evidence | Create-once schema-v2 verdict under a hashed run path | Local only; contained cleanup after the `ulpz.1` retention window and durable ledger reference |
| Council artifacts | Detailed review replay | Existing manifest, event stream, report | Existing file policy |
| Headroom CCR cache | Reversible original content | Disabled in the default pilot. A later exception requires approved data classes, backend, filesystem protection, encryption/sync decision, TTL, verified deletion, and failure behavior | Never by default |
| AgentFS session | Experimental isolated workspace | Disposable filesystem and audit timeline | Never by default |

Raw content retention, including any Headroom CCR cache, and any cloud synchronization require an explicit update to `ulpz.1`, a tested backup and restore path, and a review of access control and deletion behavior.

## Success gates

| Area | Initial gate |
|---|---|
| Retrieval | Threshold set in `ulpz.1`; no schema or model switch without a versioned index and cited golden-set result |
| Ledger tracer | One real council run has complete Beads and execution identity, checkout, requested and response-reported council-seat model, event, artifact, gate, and execution-bound human-evaluator actor kind; optional host-task identity is present only when a host task actually participates; metadata completeness target at least 95 percent in pilot; model output and free-text errors are absent |
| Privacy | Zero committed secrets; zero secret values in readiness or ledger output; Headroom master offline mode blocks Headroom-originated product/control-plane egress while allowing only separately approved provider traffic; CCR and other raw-content retention are off unless an explicit `ulpz.1` exception qualifies the data lifecycle |
| Network | Zero raw service ports publicly reachable |
| Quality | Accepted tasks need no more repair passes than the recorded baseline |
| Compression | At least 20 percent input-token reduction on an enabled class with no measured quality loss |
| Routing and model evaluation | Every successful direct or gateway transport records response-reported or route-observed identity. A live model-evaluator proof comes only from its own invocation producer, records requested and observed provider/model/tier, and has zero weaker-fallback events; council-seat evidence cannot satisfy it |
| Worker | One otherwise-empty disposable VM and one worktree only; no unrelated host access; actual invocation-boundary evidence records response ID plus selected-direct-transport provider/response model or trusted gateway route separately from configured SDK metrics; merge and push remain outside worker authority |
| Recovery | Restore and rollback demonstrated for every stateful MVP component |
| Optional tools | A no-go decision is an acceptable outcome when evidence does not clear the gate |

## Validation commands

Planning and tracker validation:

```powershell
bd show agent-forge-harness-ulpz
bd children agent-forge-harness-ulpz
bd graph agent-forge-harness-ulpz
bd blocked
bd lint
rg -n '\.tmp/work/.+-verdict\.json|CLAUDE_TASK_ID|taskId' .claude .agents scripts
```

The final `rg` is a migration inventory, not a pass condition by itself. Before the schema-v2 checkpoint closes, every operational evaluator identity or task-only verdict-path match must be migrated or explicitly documented as a backward-compatible reader; historical artifacts may remain. Focused tests assert that no active writer or strict-gate instruction falls back to the v1 task-only path or treats `CLAUDE_TASK_ID` as a Beads identity.

Harness plan validation now, plus future implementation validation as the named scripts land:

```powershell
bun run typecheck
bun run lint
bun test
bun run dashboard:build
```

The base `typecheck`, `lint`, `test`, and `dashboard:build` commands exist today. Future `self-host:*` and `harness:rag:*` commands elsewhere in this plan are target interfaces, not current package scripts. Each phase adds focused tests and one observable demo command. Live provider calls, external installations, host mutations, credentials, paid usage, cloud sync, and firewall changes always require an explicit operator action.

## Primary evidence anchors

These sources support the current planning assumptions but do not replace the freshness gate immediately before pinning a version.

- Claude Code sends command-hook JSON on stdin; `TaskCreated` and `TaskCompleted` carry a Claude-assigned `task_id` plus optional team and teammate fields, while task creation returns an assigned ID distinct from external trackers. Agent-team members run in separate sessions over one shared task list, and named task lists can also be shared across sessions: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#taskcreated), [Agent SDK task tools](https://code.claude.com/docs/en/agent-sdk/typescript#taskcreate), [agent teams](https://code.claude.com/docs/en/agent-teams), and [named task lists](https://code.claude.com/docs/en/interactive-mode).
- Ollama `/api/embed` accepts `dimensions` but does not return a digest or explicit dimension field; `/api/tags` returns the installed model digest: [embed API](https://docs.ollama.com/api/embed) and [model inventory API](https://docs.ollama.com/api/tags).
- Current OpenHands V1 guidance says read-write sandbox mounts are mutable by the agent, documents a `0.0.0.0` sandbox binding default, and recommends firewall restriction plus loopback services for self-hosting: [Docker sandbox](https://docs.openhands.dev/openhands/usage/sandboxes/docker), [environment variables](https://docs.openhands.dev/openhands/usage/environment-variables), and [self-hosting](https://github.com/OpenHands/OpenHands/blob/main/docs/SELF_HOSTING.md). Agent Canvas documents a pre-consent `canvas_install` event and added a prebuilt runtime telemetry-disable path in [PR #16908](https://github.com/OpenHands/OpenHands/pull/16908), while the agent-server exporter defaults to `none`: [Canvas telemetry contract](https://github.com/OpenHands/OpenHands/blob/main/AGENTS.md) and [agent-server telemetry](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/README.md).
- Headroom supports library, MCP, and proxy modes. Its master offline switch disables outbound product behavior, while CCR may retain original content in memory or SQLite; beacon-off alone is not the offline control: [integration modes](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/agent-orchestration.mdx), [offline implementation](https://github.com/headroomlabs-ai/headroom/blob/main/headroom/offline.py), [proxy configuration](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/proxy.mdx), and [CCR data lifecycle](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/ccr.mdx). Beacon defaults have changed across [v0.27.0](https://raw.githubusercontent.com/headroomlabs-ai/headroom/v0.27.0/headroom/telemetry/beacon.py), [v0.31.0](https://raw.githubusercontent.com/headroomlabs-ai/headroom/v0.31.0/headroom/telemetry/beacon.py), and [v0.34.0](https://raw.githubusercontent.com/headroomlabs-ai/headroom/v0.34.0/headroom/telemetry/beacon.py), so the selected tag is revalidated.
- 9Router has a maintainer-published critical unauthenticated RCE advisory for affected versions and multiple later authentication or SSRF advisories. Its start and authentication controls have also varied, so configuration presence is never substituted for a live listener check and endpoint-level negative tests: [CVE-2026-46339 / GHSA-fhh6-4qxv-rpqj](https://github.com/advisories/GHSA-fhh6-4qxv-rpqj), [maintainer advisory list](https://github.com/decolua/9router/security/advisories), [tagged CLI source](https://raw.githubusercontent.com/decolua/9router/v0.5.75/cli/cli.js), and [configuration-drift issue](https://github.com/decolua/9router/issues/2834).
- Bun ships SQLite support in the runtime, so the local MVP needs no third-party database client: [Bun SQLite](https://bun.sh/docs/runtime/sqlite).

## Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Conflicting RAG model dimensions | Failed inserts or a silently invalid index | Version model, dimension and index; fail before upsert; never mutate incompatible indexes in place |
| Reusing product-owned infrastructure | Harness availability and data become coupled to another application | Stack-owned Compose or explicit independent database contract |
| Claude-only hooks do not run in other clients | Remote work can bypass start and completion policy | Explicit worker lifecycle manifest and direct invocation of underlying scripts |
| Execution ID is caller-reused or mismatched | Unrelated council, gate, or evaluator evidence joins into one run | Require council `runId` equality, one begin-run allocator for other workflows, a database unique constraint, and mismatch plus duplicate-start tests |
| Optional host identity is mistaken for Beads authority or keyed without task-list scope | The implementation violates repo policy, collides across task lists, rejects valid teammate completion, or sends a Claude-local ID to `bd` | Keep the required launcher path host-task-free; parse hook JSON but never treat host identity as Beads. Permit a bridge only after a governing policy amendment, then key canonical `{hostTaskScope, hostTaskId}`, retain creator/completer actors separately, and test team handoff, cross-scope duplicates, and command-boundary separation |
| Evaluator verdict is selected only by task, lacks evaluator identity, or is reopened after validation | A stale or weaker concurrent-run verdict can be attributed to the wrong execution, or later bytes can replace validated evidence | Require schema-v2 Beads, execution, and typed evaluator identity, select an execution-scoped create-once path from correlation, reject weaker fallback, validate from one read buffer, and atomically append that buffer's identity, path, digest, and byte count with the gate result |
| Worktree or OpenHands runtime mistaken for a sandbox | Worker can reach VM-wide secrets, networks, Docker control, or unrelated files | Use an otherwise-empty disposable VM as the first isolation boundary; verify the exact tag/start mode, loopback socket, mounts, environment, socket exposure, and egress before credentials |
| Ledger captures sensitive content | Durable secret or source leakage | Metadata-first schema, content classes, redaction, local-only default, bounded summaries |
| Gateway concentrates credentials or only appears authenticated | One service compromise affects every provider, or a route bypasses policy | Optional adoption, isolated unprivileged runtime, live loopback-socket verification, unauthenticated negative tests across every route family, minimal logging, direct-provider escape, and a hard no-go for affected or ambiguous advisory status |
| Compression removes decisive evidence or retains originals | Incorrect implementation, verdict, or unintended raw-content persistence | Hard bypass list, retained provenance, matched A B evaluation, master offline mode plus egress probe, CCR disabled by default, and an explicit lifecycle approval for any later CCR exception |
| Worker model provenance is copied from configuration | A fallback or gateway route is mislabeled as the requested model | At the actual LLM invocation boundary, capture response ID plus selected-direct-transport provider/response model or trusted gateway routing, store configured SDK metrics separately, test divergence, and fail on missing observed identity |
| Fast upstream change | Pinned plan becomes unsafe or incompatible | First-party freshness gate at each external-product checkpoint |
| An optional experiment installs before approval | Supply-chain or host mutation occurs outside operator scope | Require source, version, license, advisory, target, and installation approval before every external download or start; AFK work begins only afterward |
| Hardware cannot support useful local models | Poor latency and failed agent tasks | Benchmark before purchase; use Ollama first for embeddings and bounded tasks; retain hosted providers |
| Optional scope delays useful core | Stack never reaches a stable pilot | Every checkpoint can stop independently; ledger, retrieval and review remain useful without later products |

## Review record

Plan Review history:

- Turn 1: NEEDS REVISION - 0 Blocker, 3 High, 1 Medium, 0 Low. The revision made `9n1` a type-valid feature blocked by `ulpz.1`; introduced explicit execution correlation and separate council and gate/evaluator producers; distinguished configured from observed model identity and council-chair from evaluator verdicts; moved artifact hashing after persistence; corrected the council CLI example; and labeled future commands as target interfaces.
- Turn 2: SOUND - 0 Blocker, 0 High, 0 Medium, 0 Low. The evaluator rechecked the load-bearing code claims, command shape, and live Beads dependency graph.
- Turn 3: NEEDS REVISION - 0 Blocker, 2 High, 4 Medium, 7 Low. A deeper provenance review found that direct transports did not populate actual model identity, Claude hook identity was read from environment variables that the host does not set, raw `SeatRecord.output` could leak into the ledger, evaluator evidence could be rebound after validation, and several external-component and RAG assumptions were too loose. Revision 3 addressed those findings in the plan and Beads graph.
- Turn 4, first pass: NEEDS REVISION - 0 Blocker, 2 High, 0 Medium, 0 Low. The independent reviewer found (1) that `task_id` is scoped to a shared Claude task list rather than globally unique and a different teammate session can complete a lead-created task, and (2) that a task-only verdict path can bind stale evaluator evidence to another execution before hashing. Revision 4 keys optional host bindings by canonical task-list scope plus host task ID, records creator and completer actors separately, makes strict verdict schema and paths execution-scoped, and adds the corresponding cross-session, collision, stale-evidence, and concurrent-run tests.
- Turn 4, continuation: NEEDS REVISION. Further independent passes found that root policy forbids the proposed `TaskCreate` path; external installs and the `9n1` sequence were not uniformly gated; worker/model-evaluator claims exceeded their evidence producers; dependency ownership overlapped; OpenHands runtime isolation, telemetry and worker-model provenance were underspecified; Headroom beacon-off did not prove offline mode and CCR retained originals; 9Router configuration did not prove listener or endpoint authentication; and the RAG plan reused closed D&D issues. Revision 4 removed the host-task requirement, ordered `0xxt -> empi -> ulpz.3`, made every external mutation explicitly HITL, narrowed each live proof to its producer, selected a disposable-VM worker boundary, required runtime telemetry and invocation-boundary provenance probes, required Headroom master offline mode with CCR off, added 9Router route inventory and negative tests, demoted ignored drafts to history, and removed `7fx`/`c7v` from Harness RAG ownership.
- Turn 4, closure verification: SOUND - 0 Blocker, 0 High, 0 Medium, 0 Low. The primary closure pass rechecked the canonical plans, repository surfaces, current first-party evidence, live Beads graph, stale wording inventory, and all findings supplied by the independent reviewers. `git diff --check`, Beads cycle validation, typecheck, lint, 451 tests, and the production dashboard build pass. The only remaining work is the operator-owned `ulpz.1` baseline decision; no external installation or implementation is authorized by this review.

Revision 4 does not authorize external installation or host mutation. Checkpoint A and all other marked HITL choices still require operator input before their dependent work can start.

## Estimated scope

- Complexity: High and cross-cutting
- Shared master checkpoints: 9, including existing peer feature `9n1`
- Newly created phase issues: 8 plus the umbrella epic
- Separately discovered prerequisite bugs: `agent-forge-harness-0xxt` and `agent-forge-harness-empi`
- External infrastructure mutations: none during planning
- First implementation slice: local run-ledger tracer under `agent-forge-harness-ulpz.3`
