# Self Hosted AI Agent Stack Integration Master Plan

Generated: 2026-09-13
Repository: agent-forge-harness
Beads epic: `agent-forge-harness-ulpz`
Research: `plans/research/agent-forge-harness-ulpz.md`
Phase: plan 2 of 4
Status: Plan Review SOUND; operator baseline decisions pending

## Executive decision

Build a small private hybrid stack around Agent Forge instead of turning the harness into a deployment runtime. Windows remains the human control and review surface. A dedicated Linux host runs privileged control-plane services. Ollama runs on the private host with suitable GPU capacity. Every external product sits behind an optional adapter, is disabled by default, and has a measurable stop or rollback point.

The rollout begins with decisions and a baseline, then proves one local execution-ledger tracer using existing council data. Harness RAG and Ollama embeddings proceed through existing workstream `agent-forge-harness-9n1`, after its stale storage and embedding assumptions are reconciled. The private service substrate and Diffy workflow follow. One constrained OpenHands worker is the first remote execution pilot. Headroom, 9Router, and AgentFS remain evidence-gated and may be rejected without blocking the useful core.

## Product outcomes

1. An operator can inspect selected self-host services for configuration, privacy, health, version pinning, and recovery readiness without exposing secrets.
2. Harness retrieval can use an Ollama embedding adapter with the existing pgvector baseline and demonstrate cited top-K results on one pilot repository.
3. One Forge run can be queried by Beads task, checkout or worktree, worker, requested and actual model, event sequence, artifact hashes, quality gate, evaluator verdict, latency, and available usage or cost.
4. Diffy can show live worktree changes while Git diff, tests, evaluator evidence, and quality gates remain authoritative.
5. One OpenHands worker can execute one bounded task in one worktree on a dedicated Linux host and stop before merge or push.
6. Headroom is adopted only for task classes where an A B comparison shows useful token savings without quality loss.
7. 9Router is adopted only if a fresh security review and measured routing pain justify the new privileged service.
8. AgentFS is evaluated on a disposable worktree without becoming the only copy of important work.

## Non-goals

- Replacing Beads, Git, worktrees, pgvector, the existing quality gate, or human merge approval in the MVP.
- Building a public or multi-tenant agent service.
- Installing every named product before the earlier checkpoints prove value.
- Automatically provisioning hardware, opening firewall ports, enabling paid calls, or enabling cloud synchronization.
- Storing raw prompts, model responses, source bodies, tool logs, credentials, or reversible compression caches by default.
- Routing a final evaluator through a weaker fallback.
- Adding adjacent products such as vLLM, LiteLLM, Open WebUI, n8n, Supabase, or Langfuse without a separate approved scope.
- Reopening closed product-specific D and D infrastructure work as harness implementation tasks.

## Binding architecture and security invariants

These are plan constraints, not optional implementation suggestions.

1. **Agent Forge remains the policy layer.** It owns work selection, phase rules, acceptance gates, and handoffs. It does not own model hosting or application data.
2. **Beads remains task intent.** The execution ledger may snapshot a task ID and acceptance context but does not duplicate issue status, dependencies, assignment, or planning logic.
3. **Git remains artifact authority.** Source, patches, commits, and reviewed deliverables remain ordinary Git data. The ledger stores hashes, paths, and provenance.
4. **Worktrees are the baseline workspace boundary.** They isolate Git checkouts but are not treated as a process, network, secret, or host filesystem sandbox.
5. **Every service is private by default.** Raw Ollama, OpenHands, Headroom, and 9Router ports bind to loopback or a private container network. Remote access uses a reviewed VPN, SSH tunnel, or authenticated TLS endpoint.
6. **Secrets remain outside Git and browser code.** Readiness output may name a missing environment variable or secret reference but never return its value.
7. **Telemetry is metadata-first.** Local hashes, identifiers, timings, counts, bounded summaries, and policy labels are the default. Raw content needs an explicit data class, retention limit, encryption and sync decision.
8. **Evaluation fails closed.** The actual evaluator provider and model are recorded. A router may fall back only to an equally approved evaluator model.
9. **Compression is bypass-first.** Exact diffs, evaluator evidence, security findings, licenses, credentials, cryptographic material, exact errors, and already dense inputs never pass through Headroom.
10. **External agents have least privilege.** One worker gets one intended worktree, narrowly scoped credentials, bounded egress, no operator home-directory mount, no cloud metadata access, and no default merge, push, or deploy authority.
11. **Optional means removable.** Disabling a provider, reducer, ledger, worker, viewer, or isolation adapter preserves the current harness behavior.
12. **Upstream freshness is a deployment gate.** Product versions, licenses, security advisories, ports, hardware guidance, and provider terms are revalidated from first-party sources immediately before a version is pinned.

## Verified current state and reuse map

| Existing asset | Current behavior | Planned reuse |
|---|---|---|
| `README.md` and `docs/HARNESS-GUIDE.md` | Define the harness as a workflow and convention layer, not a deployable product runtime | Keep self-host support optional and adapter-driven |
| `.claude/settings.json` | Wires Claude-only session, dangerous-Git, stop, completion, and idle hooks | Use as the lifecycle behavior inventory |
| `.agents/CODEX-NOTES.md` | Records which Claude hooks do not automatically carry to Codex | Require host-neutral adapters to invoke underlying scripts explicitly |
| `.claude/hooks/quality-gate.ts` and `scripts/quality-gate-identity.ts` | Run typecheck, lint, tests, tree checks, acceptance checks, and optional evaluator verification; the log identifies checkout, branch, task, and Forge slug but not a council execution | Preserve completion authority, add an explicit execution correlation ID, and emit gate and evaluator evidence through a separate ledger producer |
| `scripts/worktree.ts` | Creates and manages Git worktrees | Retain as the first workspace backend and mount only the selected worktree into remote workers |
| `scripts/council/types.ts` and `scripts/council/engine.ts` | Model typed transports, ordered events, configured seat provider and model, optional observed routing, usage, cost, cancellation, and results; they do not contain Beads, checkout, worktree, or gate identity | Reuse the run and record contracts, and supply execution identity explicitly at the adapter boundary |
| `scripts/council/providers.ts` | Implements provider readiness, local HTTP constraints, credential redaction, structured outputs, and hosted provider transports | Reuse its validation and safety patterns; qualify Ollama and 9Router explicitly |
| `scripts/council/artifacts.ts` | Persists manifest, event, and report artifacts for replay and returns their paths, but does not compute artifact digests | Use the post-persistence result as the first producer boundary, preserve the files, and compute ledger artifact references there |
| `scripts/council/integrations.test.ts`, `provider-contract.test.ts`, and `safety.test.ts` | Test provider behavior, shared contracts, and secret boundaries | Extend behavior tests instead of creating parallel transport test infrastructure |
| `scripts/dashboard/forge-run-model.ts` and local dashboard APIs | Read structured quality-gate and run state for the UI | Add read-only ledger reporting only after the storage tracer is stable |
| `docs/plans/harness-rag-local-vector.md` | Describes a local pgvector baseline and Ollama embeddings | Preserve pgvector and the Ollama-first direction, subject to `ulpz.1` |
| `plans/drafts/agent-forge-harness-9n1.md` | Later local draft hard-codes OpenAI 1536-dimensional embeddings and another product repository's database | Reconcile in place; do not silently discard its design history |
| `agent-forge-harness-3u6` | Tracks MCP-hosting practicality, secrets, sandboxing, packaging, and sync | Treat as related input for the OpenHands compatibility surface |
| `agent-forge-harness-t1b1` | Has delivered provider transports, safe context compilation, local MCP, artifacts, usage, cost, and dashboard surfaces | Reuse as prior art and the ledger tracer source |

## Decisions and provisional defaults

| ID | Decision | Status |
|---|---|---|
| D1 | One umbrella epic and one canonical shared plan; phase-level Beads issues; detailed subplans only when a risky phase becomes active | Accepted for planning because the user delegated the decomposition choice |
| D2 | Windows is the control surface; Linux is the preferred privileged worker and control-plane host; Ollama follows the usable GPU | Provisional until host inventory is recorded in `ulpz.1` |
| D3 | pgvector remains the harness retrieval baseline in an isolated `harness.*` namespace; Turso or libSQL is a separate execution ledger | Recommended; schema and ownership locked by `ulpz.1` |
| D4 | Harness RAG owns its own Compose or documented database contract and never depends operationally on a product repository or the legacy port 5432 | Recommended; `9n1` plan must be updated before implementation |
| D5 | Ollama is the first self-host embedding provider; vector dimension, model identity, digest, chunk policy, and index version are explicit | Recommended; exact model waits for hardware and golden-set evidence |
| D6 | The first implementation tracer is a local ledger dual-write from one deterministic fake-provider council run, using a caller-supplied correlation envelope; gate and evaluator evidence arrive through a second producer with the same execution ID | Planned |
| D7 | Cloud sync is off; metadata-only local retention is the default | Safe default pending operator retention approval |
| D8 | Diffy identity, OpenHands host access, any external installation, paid call, or firewall change is HITL | Binding |
| D9 | Headroom, 9Router, and AgentFS are optional experiments with explicit rejection paths | Binding |
| D10 | Run identity is never inferred from timestamps or a task-plus-checkout guess; producers share an explicit execution ID, and uncorrelated evidence stays visibly unlinked | Binding |

## Target topology

```text
Windows operator
  Codex or Claude Code + Beads + plans + Diffy
                     |
              VPN or SSH tunnel
                     |
Dedicated private Linux control plane
  readiness and policy adapters
  OpenHands worker -> one Git worktree
  optional Headroom -> approved verbose inputs only
  optional 9Router -> authenticated private routes only
                     |
              model-provider adapter
            /                          \
private Ollama on GPU host       approved hosted providers

Execution facts from clients, workers, routes, gates, and evaluators
                     |
          local Turso or libSQL run ledger
          optional sync only after policy approval

Retrieval path remains separate:
repos and knowledge -> chunk -> Ollama embed -> harness pgvector -> cited top-K
```

## Proposed adapter boundaries

The phase plans may refine names, but implementations must preserve these small public surfaces.

```typescript
type EmbeddingBatch = {
  vectors: number[][];
  provider: string;
  model: string;
  dimensions: number;
  modelDigest?: string;
};

interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<EmbeddingBatch>;
}

type RunCorrelation = {
  executionRunId: string;
  taskId?: string;
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

interface RunEventSink {
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
    gate: QualityGateResult,
    evaluator: ArtifactReference | null,
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

Complex vendor behavior belongs behind these interfaces. Callers should not need to know Turso SQL, Headroom cache rules, OpenHands container details, or router-specific response shapes. The council producer normalizes both `CouncilRun.events` and `CouncilRun.records`: configured provider and model come from each seat record, observed upstream identity comes only from optional routing fields, and missing actual identity remains null. Artifact references are hashed only after council persistence succeeds. `councilChairVerdict`, `qualityGatePassed`, and `evaluatorVerdict` remain distinct facts.

## TDD strategy

Implementation follows the repository TDD skill: one observable failing behavior, minimal passing code, then the next vertical slice. Tests use public interfaces and fake or local boundaries. CI never requires a live model, external agent host, provider credential, or paid call.

The first tracer bullet is behaviors 1 through 3, delivered as three separate red-green slices. It first proves council-to-ledger readback, then observed routing, then explicit gate and evaluator correlation without provisioning new hardware.

| # | Behavior as a specification | Proposed test file | Tracer |
|---|---|---|---|
| 1 | Given one deterministic fake `CouncilRun`, its returned artifact paths, and caller-supplied task, checkout, worktree, worker, and execution ID, the enabled adapter stores configured seat provider and model, ordered events and normalized records, computed artifact hashes, and the council-chair verdict; observed provider and model remain null rather than invented, and disabled mode leaves current artifacts unchanged | `scripts/run-ledger/council-sink.test.ts` | Yes |
| 2 | A council record fixture with optional routing stores the observed upstream provider and model separately from the configured request; absent routing remains null | `scripts/run-ledger/council-sink.test.ts` | Yes |
| 3 | A quality-gate record carrying the same explicit execution ID enriches the run with gate results and a path, hash, or normalized copy of the validated strict evaluator verdict; a missing or mismatched ID remains unlinked and visible | `scripts/run-ledger/quality-gate-producer.test.ts` | Yes |
| 4 | The ledger rejects invalid event ordering, redacts configured secrets, defaults to metadata-only content, and applies migrations idempotently | `scripts/run-ledger/ledger.test.ts` | No |
| 5 | Readiness returns the standard JSON envelope, reports missing secret names without values, and fails closed for a public raw-service endpoint | `scripts/self-host/doctor.test.ts` | No |
| 6 | A selected service profile can be rendered and validated without mutating the host, and backup metadata can be restored into a temporary target | `scripts/self-host/profile.test.ts` | No |
| 7 | An Ollama embedding response records provider, model and dimension; a dimension mismatch fails before pgvector upsert | `scripts/harness-ingest/embedding-provider.test.ts` under `9n1` | No |
| 8 | An OpenHands request cannot start without exactly one validated worktree, a permitted command policy, and a completion gate; its handoff records the actual model and result | `scripts/openhands/adapter.test.ts` | No |
| 9 | The reducer bypasses exact and sensitive input classes and logs original-versus-reduced provenance for approved verbose inputs | `scripts/context-reducer/headroom.test.ts` | No |
| 10 | An evaluator route refuses a weaker fallback and every gateway result records the actual provider and model | Extend `scripts/council/integrations.test.ts` or add `scripts/council/self-host-gateway.test.ts` | No |
| 11 | An AgentFS experiment cannot write outside its disposable session and exports a reproducible Git-reviewable diff | Phase-specific integration test selected after current platform support is verified | No |

Refactor watch list after green:

- Keep ledger storage, redaction, and producer mapping behind one sink rather than adding Turso calls throughout council and hook code.
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
2. Classify identifiers, prompts, responses, tool output, source snippets, artifacts, evaluator evidence, and reversible caches as local, sync-eligible, or never retained.
3. Freeze mandatory MVP components and optional experiments.
4. Select 10 to 20 representative tasks spanning mechanical work, routine fixes, retrieval, planning, and evaluation. Capture current tokens when available, elapsed time, retries, gate result, repair passes, and findings.
5. Resolve the `9n1` conflict: stack-owned pgvector contract, environment-selected connection, Ollama-first embedding adapter, explicit dimensions and index version, and no dependency on legacy port 5432.
6. Confirm the exact Diffy project before installation.
7. Record version and advisory freshness checklists for each external component.

Demo:

```powershell
bd show agent-forge-harness-ulpz.1
bd comments agent-forge-harness-9n1
```

The operator sees the resolved topology, data policy, golden-set definition, and RAG migration decision. No external service is started.

Stop point: if host inventory or retention cannot meet the binding invariants, stop after local ledger work and do not deploy remote services.

### Checkpoint B - Persist one local run end to end

Beads: `agent-forge-harness-ulpz.3`
Type: AFK
Dependencies: `ulpz.1`

Steps:

1. Add a versioned run-event contract and a no-op sink.
2. Add a local Turso or libSQL implementation with forward-only idempotent migrations.
3. Store runs, ordered events, normalized provider records, artifact references, gates, and evaluations; keep large content out by default.
4. At the shared post-persistence council boundary, map one deterministic fake-provider run plus a caller-supplied `RunCorrelation` into the sink without changing its manifest, events, or report artifacts. Hash the returned files after they exist; do not use the earlier `onResult` observer for artifact evidence.
5. Treat configured seat provider and model as the request and optional routing provider and model as observed execution. Prove the latter with a routing fixture because the fake transport does not emit routing.
6. Extend quality-gate output with the same explicit execution ID and ingest it separately. Retain a path and digest or normalized copy of the validated strict evaluator verdict rather than conflating it with the council-chair verdict.
7. Add readback through a small library and a JSON CLI or report. Unmatched evidence is reported, never joined heuristically.
8. Add redaction, failure, retry, cancellation, ambiguous-correlation, and disabled-mode tests.
9. Add the local database path to ignore and backup guidance. Leave cloud sync disabled.

Demo:

Current council command, valid before ledger code exists:

```powershell
bun run council -- plan docs/plans/self-hosted-ai-agent-stack.md --profile councils/default.json --run-id self-host-ledger-demo --json
```

Target demo after this checkpoint lands:

```powershell
bun test scripts/run-ledger
bun run self-host:ledger -- run self-host-ledger-demo --json
```

The target demo also runs the current quality gate with the same explicit execution ID once that optional correlation field exists. Readback returns one bounded record containing task, checkout, model, event, artifact, gate, council-chair verdict, and evaluator-verdict provenance without secret values. The phase plan finalizes the new ledger command name and correlation injection mechanism; the council command above already matches the current CLI.

Rollback: disable the sink and remove the disposable local database; existing council artifacts continue to work.

### Checkpoint C - Establish the private substrate

Beads: `agent-forge-harness-ulpz.2`
Type: HITL for host access
Dependencies: `ulpz.1`

Steps:

1. Define a versioned service profile for only the components selected by Checkpoint A.
2. Pin reviewed image or package versions and record source, license, advisory date, and rollback version.
3. Use internal container networks and loopback binds. Treat remote private HTTP as invalid unless it arrives through a reviewed tunnel or authenticated TLS endpoint.
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
Relationship: tracked by `ulpz`; blocked by `ulpz.1`

Steps:

1. Update the `9n1` canonical design without erasing the historical OpenAI and shared-product assumptions.
2. Make pgvector ownership stack-local and the connection explicit; keep data in `harness.*`.
3. Add a provider-neutral embedding contract and Ollama adapter with model, digest, dimension, chunk-policy, and index-version metadata.
4. Fail before upsert on dimension or index-version mismatch and document the migration path for changing models.
5. Preserve idempotent repo-plus-revision ingestion and structured citations.
6. Pilot one registered repository and score a reviewed golden set.
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

### Checkpoint E - Establish the Diffy operator workflow

Beads: `agent-forge-harness-ulpz.4`
Type: HITL
Dependencies: `ulpz.1`

Steps:

1. Confirm the intended project, repository, license, release, and safe installation path.
2. Configure tabs for the harness, relevant local repositories, and active worktrees.
3. Demonstrate live detection of an intentional change and a multi-worktree scope anomaly.
4. Document that revert, delete, merge, push, and acceptance remain deliberate human or harness actions.

Demo: make an intentional disposable file edit in a test worktree and confirm it appears in Diffy and ordinary `git diff`.

Rollback: uninstall or stop Diffy without changing any harness policy or repository data.

### Checkpoint F - Pilot one constrained OpenHands worker

Beads: `agent-forge-harness-ulpz.5`
Type: HITL
Dependencies: `ulpz.2`, `ulpz.3`
Related: `agent-forge-harness-3u6`, `agent-forge-harness-t1b1`

Steps:

1. Refresh official self-hosting, security, authentication, networking, and model-compatibility evidence.
2. Deploy on a dedicated Linux host or VM with only the selected worktree and scratch storage mounted.
3. Deny cloud metadata and unrelated private networks; grant only required provider and Git destinations.
4. Use short-lived or narrowly scoped credentials and a command allowlist or sandbox policy.
5. Map Agent Forge lifecycle moments to explicit commands: session checks, task claim and run start, risky-operation policy, repo-specific quality gate, structured handoff, and run completion.
6. Run one bounded non-production task with no merge, push, deploy, or unrelated-repository authority.
7. Record intervention rate, completion quality, repair passes, elapsed time, actual model, artifacts, gate, and evaluator result against the baseline.

Demo: execute the approved pilot task, inspect its ledger record and worktree diff, run the affected repository's gates, and show that the worker stops before merge or push.

Rollback: terminate the worker, revoke its credentials, discard its worktree, and preserve the ledger and review artifacts.

### Checkpoint G - Measure Headroom with a bypass-first reducer

Beads: `agent-forge-harness-ulpz.6`
Type: AFK after baseline
Dependencies: `ulpz.1`, `ulpz.3`

Steps:

1. Add a no-op reducer and typed bypass reasons before adding Headroom.
2. Permit only approved verbose classes such as repetitive search results, test logs, retrieval context, and bounded handoff history.
3. Enforce hard bypass for exact and sensitive classes.
4. Use the strictest local privacy mode supported by the pinned version, disable optional telemetry, and protect reversible caches.
5. Run matched golden tasks with and without reduction and write tokens, latency, retries, repair passes, gate result, evaluator findings, and bypass reason to the ledger.
6. Adopt only task classes that meet the approved savings threshold with no quality regression.

Demo:

Target demo after this checkpoint lands:

```powershell
bun test scripts/context-reducer
bun run self-host:benchmark -- --variant no-reducer
bun run self-host:benchmark -- --variant headroom
```

The comparison shows per-class outcomes and the operator can disable the reducer with one configuration change.

Rollback: select the no-op reducer; no caller or stored artifact format changes.

### Checkpoint H - Decide whether 9Router earns a gateway role

Beads: `agent-forge-harness-ulpz.7`
Type: HITL decision
Dependencies: `ulpz.2`, `ulpz.3`
Related: `agent-forge-harness-t1b1`

Steps:

1. Document the measured problem that direct adapters do not solve.
2. Refresh official security advisories, release notes, authentication guidance, license, and provider terms.
3. Compare direct adapters with a private gateway for failure modes, secret concentration, logging, quotas, cost, maintenance, and evaluator guarantees.
4. Close as no-go if convenience is the only benefit or the service cannot meet the binding invariants.
5. If approved, pilot authenticated private routes for top, default, cheap, and embedding tiers with actual-model logging.
6. Test provider failure, quota exhaustion, timeout, malformed response, route refusal, direct-provider escape, and evaluator fail-closed behavior.

Demo: a deterministic fake or local test exercises the routing matrix. Any live request requires explicit credentials and spend approval.

Rollback: disable the gateway endpoint and use the already-qualified direct provider adapter.

### Checkpoint I - Experiment with AgentFS below the worktree boundary

Beads: `agent-forge-harness-ulpz.8`
Type: AFK experiment followed by HITL adoption review
Dependencies: `ulpz.2`, `ulpz.5`

Steps:

1. Refresh current platform support, beta status, backup, export, and recovery behavior.
2. Select a disposable read-mostly documentation or test-generation task with no production secret.
3. Keep the original checkout read-only and wrap only the disposable worktree.
4. Verify file and tool timeline completeness, write containment, diff export, discard, restore, and performance.
5. Export a reproducible diff into the ordinary Git review and quality-gate flow.
6. Record adopt, experiment further, or reject. Do not remove the worktree and backup baseline.

Demo: inspect the AgentFS timeline, export the diff, reproduce it in Git, run the relevant quality gate, then discard and restore the session.

Rollback: discard the AgentFS session and continue with ordinary worktrees.

## Beads issue map

| Beads ID | Type | Priority | Role | Depends on |
|---|---|---:|---|---|
| `agent-forge-harness-ulpz` | Epic | P2 | Umbrella and canonical acceptance | Tracks `9n1` |
| `agent-forge-harness-ulpz.1` | Decision | P2 | MVP topology, policy, golden baseline, and RAG contract | None; in progress |
| `agent-forge-harness-9n1` | Peer feature | P2 | Ollama-first harness RAG and cited retrieval | Blocked by `ulpz.1`; tracked by `ulpz` |
| `agent-forge-harness-ulpz.2` | Feature | P2 | Private service substrate and recovery controls | `ulpz.1` |
| `agent-forge-harness-ulpz.3` | Feature | P2 | Local Turso or libSQL run-ledger tracer | `ulpz.1`; related to `t1b1` |
| `agent-forge-harness-ulpz.4` | Task | P3 | Diffy-assisted operator review | `ulpz.1` |
| `agent-forge-harness-ulpz.5` | Feature | P2 | Constrained OpenHands worker | `ulpz.2`, `ulpz.3`; related to `3u6` and `t1b1` |
| `agent-forge-harness-ulpz.6` | Feature | P3 | Headroom A B evaluation | `ulpz.1`, `ulpz.3` |
| `agent-forge-harness-ulpz.7` | Decision | P3 | 9Router go or no-go and optional pilot | `ulpz.2`, `ulpz.3`; related to `t1b1` |
| `agent-forge-harness-ulpz.8` | Task | P4 | Disposable AgentFS experiment | `ulpz.2`, `ulpz.5` |

Dependency direction:

```text
ulpz.1
  |----> ulpz.2 ----+----> ulpz.5 ----> ulpz.8
  |                 |         ^
  |----> ulpz.3 ----+---------+
  |       |         |
  |       +----> ulpz.6
  |       +----> ulpz.7 <----- ulpz.2
  |
  +----> ulpz.4
  |
  +----> blocks peer feature 9n1

ulpz tracks 9n1 without moving the existing feature into this epic.
```

## Files and surfaces expected to change

Exact filenames for external-product phases are finalized by their phase plans after freshness review.

| Surface | Expected change |
|---|---|
| `docs/plans/self-hosted-ai-agent-stack.md` | Canonical shared master plan |
| `plans/research/agent-forge-harness-ulpz.md` | Local research and decision evidence |
| `plans/drafts/agent-forge-harness-ulpz.md` | Local Plan Review copy of this master plan |
| `plans/drafts/agent-forge-harness-ulpz-product-spec.md` | Local product-facing scope |
| `package.json` | Named readiness, ledger, benchmark, and RAG commands as slices land |
| `.gitignore` | Local ledger, caches, generated secrets, and external runtime state |
| `scripts/run-ledger/` | Versioned events, sink, local database, readback, and tests |
| `scripts/self-host/` | Profile validation, readiness, privacy and exposure checks, backup and restore helpers |
| `scripts/council/` | Thin ledger mapping and explicitly qualified local or gateway transport behavior |
| `scripts/harness-ingest/` | Refreshed `9n1` embedding, ingestion, retrieval, and evaluation work |
| `scripts/openhands/` | Runtime adapter, policy, handoff, and behavior tests |
| `scripts/context-reducer/` | No-op reducer, Headroom adapter, bypass policy, and A B evaluation |
| `.claude/` and generated `.agents/` mirror | Only durable host-neutral instruction or lifecycle changes that survive client differences |
| Operator and deployment docs | Private topology, secrets, backup, restore, upgrade, rollback, Diffy, and incident steps |

## Storage and data lifecycle

| Store | Authority | Default contents | Default sync |
|---|---|---|---|
| Beads | Task intent and dependency graph | Task IDs, AC, status, dependencies, comments | Existing Dolt workflow |
| Git and ordinary files | Source and reviewed artifacts | Plans, patches, commits, reports | Existing Git workflow |
| Harness pgvector | Retrieval index | Chunks, citations, embeddings, model and index metadata | Local stack only |
| Turso or libSQL ledger | Execution evidence | IDs, events, hashes, timings, model routes, usage, gates, verdicts | Off |
| Council artifacts | Detailed review replay | Existing manifest, event stream, report | Existing file policy |
| Headroom cache | Reversible reduction data | Only when approved; treated as sensitive | Never by default |
| AgentFS session | Experimental isolated workspace | Disposable filesystem and audit timeline | Never by default |

Raw content retention and any cloud synchronization require an explicit update to `ulpz.1`, a tested backup and restore path, and a review of access control and deletion behavior.

## Success gates

| Area | Initial gate |
|---|---|
| Retrieval | Threshold set in `ulpz.1`; no schema or model switch without a versioned index and cited golden-set result |
| Ledger | One real run has complete task, checkout, model, event, artifact, gate, and verdict identity; metadata completeness target at least 95 percent in pilot |
| Privacy | Zero committed secrets; zero secret values in readiness or ledger output; raw-content retention off |
| Network | Zero raw service ports publicly reachable |
| Quality | Accepted tasks need no more repair passes than the recorded baseline |
| Compression | At least 20 percent input-token reduction on an enabled class with no measured quality loss |
| Routing | Actual model matches policy; evaluator downgrade count is zero |
| Worker | One worktree only; no unrelated host access; merge and push remain outside worker authority |
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
bd preflight
```

Harness plan validation now, plus future implementation validation as the named scripts land:

```powershell
bun run typecheck
bun run lint
bun test
bun run dashboard:build
```

The base `typecheck`, `lint`, `test`, and `dashboard:build` commands exist today. Future `self-host:*` and `harness:rag:*` commands elsewhere in this plan are target interfaces, not current package scripts. Each phase adds focused tests and one observable demo command. Live provider calls, external installations, host mutations, credentials, paid usage, cloud sync, and firewall changes always require an explicit operator action.

## Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Conflicting RAG model dimensions | Failed inserts or a silently invalid index | Version model, dimension and index; fail before upsert; never mutate incompatible indexes in place |
| Reusing product-owned infrastructure | Harness availability and data become coupled to another application | Stack-owned Compose or explicit independent database contract |
| Claude-only hooks do not run in other clients | Remote work can bypass start and completion policy | Explicit worker lifecycle manifest and direct invocation of underlying scripts |
| Worktree mistaken for a sandbox | Worker can reach secrets, networks, or unrelated files | Dedicated host or VM, narrow mounts, egress rules, least-privilege credentials |
| Ledger captures sensitive content | Durable secret or source leakage | Metadata-first schema, content classes, redaction, local-only default, bounded summaries |
| Gateway concentrates credentials | One service compromise affects every provider | Optional adoption, private auth, minimal logging, direct-provider escape, fresh advisory review |
| Compression removes decisive evidence | Incorrect implementation or verdict | Hard bypass list, retained provenance, matched A B evaluation |
| Fast upstream change | Pinned plan becomes unsafe or incompatible | First-party freshness gate at each external-product checkpoint |
| Hardware cannot support useful local models | Poor latency and failed agent tasks | Benchmark before purchase; use Ollama first for embeddings and bounded tasks; retain hosted providers |
| Optional scope delays useful core | Stack never reaches a stable pilot | Every checkpoint can stop independently; ledger, retrieval and review remain useful without later products |

## Review record

Plan Review completed in two fresh evaluator turns:

- Turn 1: NEEDS REVISION - 0 Blocker, 3 High, 1 Medium, 0 Low. The revision made `9n1` a type-valid feature blocked by `ulpz.1`; introduced explicit execution correlation and separate council and gate/evaluator producers; distinguished configured from observed model identity and council-chair from evaluator verdicts; moved artifact hashing after persistence; corrected the council CLI example; and labeled future commands as target interfaces.
- Turn 2: SOUND - 0 Blocker, 0 High, 0 Medium, 0 Low. The evaluator rechecked the load-bearing code claims, command shape, and live Beads dependency graph.

The plan is implementation-grade, but SOUND does not authorize external installation or host mutation. Checkpoint A and all other marked HITL choices still require operator input before their dependent work can start.

## Estimated scope

- Complexity: High and cross-cutting
- Shared master checkpoints: 9, including existing peer feature `9n1`
- Newly created phase issues: 8 plus the umbrella epic
- External infrastructure mutations: none during planning
- First implementation slice: local run-ledger tracer under `agent-forge-harness-ulpz.3`
