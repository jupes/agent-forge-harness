# Harness RAG - Local Vector DB Integration Plan

> **Status**: Reconciliation candidate; implementation blocked by `agent-forge-harness-ulpz.1` and `agent-forge-harness-ulpz.2`
> **Last updated**: 2026-09-16
> **Scope**: Agent Forge retrieval over registered development repositories and selected harness knowledge
> **Canonical stack context**: [self-hosted-ai-agent-stack.md](./self-hosted-ai-agent-stack.md)

**Beads authority**: `agent-forge-harness-9n1` is the existing feature. No implementation child issues are currently assigned by this plan. Closed issues `agent-forge-harness-7fx` and `agent-forge-harness-c7v` belong to the separate D&D product work and must not be reopened or reused as Harness RAG slices. If decomposition is useful after the contract freeze, create new child issues under `9n1`.

## Scope boundary

Harness RAG indexes registered repositories and approved harness knowledge so agents can retrieve chunk-grounded context with structured citations. D&D rules and spell retrieval remain a separate product concern in `rag-chat`.

The projects do not share operational ownership. Harness RAG must not depend on the `rag-chat` Compose project, database lifecycle, credentials, legacy port 5432, schemas, or release schedule. A deployment may use the same physical host only after the operator approves that placement; the Harness stack still owns an independent service contract, credentials, backup, restore, and rollback.

## Preconditions

All adapter, schema, fixture, and live work waits for both blockers:

1. `agent-forge-harness-ulpz.1` approves host placement, data retention, corpus, embedding and index contract, golden set, and success thresholds.
2. `agent-forge-harness-ulpz.2` approves the exact Ollama and pgvector sources, licenses, pinned versions or image digests, target host, private networking, backup, restore, rollback, and service start.

No download, installation, schema mutation, or service start is authorized by this plan alone.

## Target contract

### Storage

- PostgreSQL with pgvector remains the retrieval baseline.
- The Harness stack owns the connection contract and lifecycle. Connection details are selected through environment or an approved secret reference, never a product repository or hard-coded host port.
- Harness data lives in an isolated `harness.*` namespace or an operator-approved dedicated database. The approved choice is recorded by `ulpz.1` before migrations are written.
- Migrations are forward-only and idempotent. Backup and restore are proven before a schema or index upgrade.
- Changing embedding model, dimensions, chunk policy, or index version creates a compatible new index; it never mutates an incompatible index in place.

### Embedding provider

Ollama is the first provider behind a provider-neutral adapter. Each batch records:

- requested provider and model;
- required model digest resolved from Ollama model inventory;
- requested dimensions and every returned vector length;
- chunk-policy version and index version;
- latency, status, and bounded non-secret error classification.

`/api/embed` output is not treated as proof of model digest or an explicit dimension field. The adapter resolves the expected digest from `/api/tags`, counts the returned vectors itself, and fails before pgvector upsert on digest, count, dimension, or index-version mismatch.

A hosted embedding adapter may remain optional, but CI never requires a live hosted credential or paid call.

### Ingestion and retrieval

- Inputs are explicit registered repository revisions and approved harness knowledge paths.
- Chunking has a versioned policy and a stable natural key containing repository, revision, path, and chunk identity.
- Re-ingestion is idempotent by repository plus revision and does not duplicate unchanged chunks.
- Retrieval is scoped to the Harness namespace and returns structured source citations containing repository, revision, source path or symbol, and chunk identity.
- Raw source retention, deletion, and backup follow the data policy approved in `ulpz.1`.

## Implementation sequence after both blockers complete

1. Add the provider-neutral embedding contract, Ollama adapter, and fixture tests for digest, vector count, dimensions, mismatch, and unavailable-model behavior.
2. Add the approved pgvector connection and migration boundary, then implement idempotent ingestion for one registered repository revision.
3. Add cited top-K retrieval and a reviewed golden set covering expected files or symbols, required citations, and must-not-return cases.
4. After explicit service-start approval, run one live Ollama and pgvector proof on the pilot repository and record the model digest, dimensions, chunk/index versions, retrieval metrics, backup, restore, and rollback evidence.
5. Only if the work is too large for one feature, create new vertical-slice child issues under `agent-forge-harness-9n1` with explicit dependencies. Do not attach Harness work to closed D&D issues.

## TDD slices

1. A fixture resolves the required digest from model inventory and rejects a response from a changed digest.
2. A batch with a wrong vector count or any wrong vector length fails before database interaction.
3. Re-ingesting the same repository revision produces no duplicate chunks.
4. A model, dimension, chunk-policy, or index-version change selects a new compatible index rather than overwriting the old one.
5. Retrieval returns structured citations and never crosses into a non-Harness namespace.
6. A fixture-only test suite passes without Docker, Ollama, a hosted key, or network access.
7. The operator-approved live proof meets the golden-set threshold and demonstrates backup, restore, and rollback.

## Decisions owned by `ulpz.1`

- target host and whether Harness receives an isolated database or schema;
- retention, deletion, backup, encryption, and sync policy for chunks and embeddings;
- pilot repository and approved knowledge paths;
- exact Ollama model, required digest, dimensions, and acceptable hardware/latency;
- chunk policy, index version, top-K settings, and golden-set pass threshold;
- whether post-freeze child Beads are warranted.

## Acceptance

The plan, `agent-forge-harness-9n1`, and the approved `ulpz.1` decision agree on one Harness-owned pgvector and Ollama-first contract. Both blockers are complete before implementation begins. One approved pilot repository is ingested idempotently and passes a cited top-K golden set. Provenance includes digest, requested and returned dimensions, chunk policy, and index version. The Harness database lifecycle is independent of `rag-chat`; closed D&D issues are not reused; CI needs no live hosted key; and backup, restore, migration, and rollback are demonstrated.
