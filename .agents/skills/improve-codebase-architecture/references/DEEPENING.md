# Deepening

How to assess and deepen a cluster of shallow **Modules** safely, given its dependencies. This reference assumes the vocabulary in [LANGUAGE.md](LANGUAGE.md): **Module**, **Interface**, **Implementation**, **Depth**, **Seam**, **Adapter**, **Leverage**, and **Locality**.

## Candidate Shape
A strong deepening candidate usually has:

- A shallow **Module** or cluster where the **Interface** exposes nearly as much complexity as the **Implementation**.
- Scattered caller knowledge that could be moved behind one **Interface**.
- Poor **Locality**: bugs, changes, and tests require edits in many places.
- Clear **Leverage**: callers would get more behavior from fewer facts.
- A better test surface: tests can assert behavior at the **Interface** instead of reaching through internal pieces.

Use the **deletion test** before recommending the candidate. If deleting the **Module** makes complexity disappear, it was probably a pass-through. If deleting it pushes complexity back into N callers, it was already carrying useful responsibility and may deserve a deeper **Interface**.

## Dependency Categories
When assessing a candidate, classify its dependencies. The category determines how the deepened **Module** is tested across its **Seam**.

### 1. In-process
Pure computation, in-memory state, no I/O. Always deepenable: merge the behavior into a deeper **Module** and test through the new **Interface** directly. No **Adapter** is needed unless something genuinely varies.

### 2. Local-substitutable
Dependencies with local test stand-ins, such as PGLite for Postgres or an in-memory filesystem. Deepenable when the stand-in exists. The deepened **Module** is tested with the stand-in in the suite. The **Seam** is internal; do not expose it through the external **Interface** just for tests.

### 3. Remote but owned
Your own services across a network **Seam**, such as internal HTTP APIs, queues, or RPC services. Define a port at the **Seam**. The deep **Module** owns the logic; transport is injected as an **Adapter**. Tests use an in-memory **Adapter**. Production uses the HTTP, queue, or RPC **Adapter**.

Recommendation shape: define a port at the **Seam**, implement a production **Adapter** and an in-memory test **Adapter**, so logic sits in one deep **Module** even though it crosses a network.

### 4. True external
Third-party systems you do not control, such as payment providers, messaging vendors, or hosted APIs. The deepened **Module** takes the external dependency as an injected port. Tests provide a mock or fake **Adapter** that exercises behavior through the same **Interface** callers use.

## Seam Discipline

- **One Adapter means a hypothetical Seam. Two Adapters means a real Seam.** Do not introduce a port unless at least two **Adapters** are justified, typically production and test. A single-**Adapter** **Seam** is often just indirection.
- **Internal Seams vs external Seams.** A deep **Module** can have internal **Seams** private to its **Implementation** and used by its own tests. Do not expose internal **Seams** through the external **Interface** just because tests need setup.
- **Keep variation honest.** If the only variation is a mock for one test, consider a local-substitutable dependency or a higher-level behavioral test before adding a new **Seam**.

## Testing Strategy: Replace, Do Not Layer
- Old unit tests on shallow **Modules** become waste once tests at the deepened **Module**'s **Interface** exist. Delete or retire them during the implementation task.
- Write new tests at the deepened **Module**'s **Interface**. The **Interface** is the test surface.
- Assert observable outcomes through the **Interface**, not internal state.
- Tests should survive internal refactors because they describe behavior, not **Implementation**. If a test must change whenever the **Implementation** changes, it is testing past the **Interface**.

## Agent Forge Follow-up
When deepening creates implementation work, file or suggest Beads tasks instead of inline task notes. Use `design:` comments for architectural decisions and `worklog:` comments for investigation evidence. If an existing ADR or Beads `design:` decision blocks a candidate, either respect it or ask whether the new friction justifies revisiting it.
