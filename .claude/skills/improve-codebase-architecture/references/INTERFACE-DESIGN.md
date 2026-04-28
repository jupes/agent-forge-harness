# Interface Design

Use this only after the user has selected one deepening candidate from the main skill workflow. Do not design alternative **Interfaces** during the initial candidate presentation.
The goal is to compare multiple possible **Interfaces** for the same deepened **Module** before implementation. The first idea is rarely the best one.

## Process

### 1. Frame the Problem Space
Write a user-facing explanation of the selected candidate: current **Modules**, files, friction, constraints, dependency category from [DEEPENING.md](DEEPENING.md), behavior moving behind the **Seam**, and what callers/tests should stop knowing. Use domain language from `knowledge/`, active Beads context, `design:` comments, and applicable ADRs as constraints.

### 2. Generate Alternatives
Produce at least three meaningfully different **Interface** designs. If subagents are available and the user has not constrained the session against them, ask parallel agents to generate alternatives. Otherwise, generate the alternatives yourself and label the design constraint for each one.

Useful constraints:

- **Minimal Interface** - aim for 1-3 entry points and maximize **Leverage** per entry point.
- **Flexible Interface** - support multiple known use cases and extension points without leaking the **Implementation**.
- **Common Caller Interface** - make the most common caller trivial.
- **Ports and Adapters Interface** - when dependencies cross a real **Seam**, model production and test **Adapters** explicitly.

Each alternative must include:

1. **Interface** - types, methods, params, invariants, ordering, error modes, config.
2. Usage example, hidden **Implementation**, dependency strategy, required **Adapters**, and trade-offs in **Leverage** and **Locality**.

### 3. Compare and Recommend
Present designs sequentially, then compare **Depth**, **Leverage**, **Locality**, **Seam** placement, and test impact. End with an opinionated recommendation or a hybrid if it clearly improves **Depth**, **Leverage**, and **Locality**.

### 4. Handoff to Implementation
Only after the user approves an **Interface** should you plan implementation. Record durable decisions in Beads with a `design:` comment, then create or update Beads tasks for implementation slices when needed.

Implementation plans should state:

- Selected **Interface** and **Seam**.
- **Implementation** moving behind it.
- **Adapters** required now, not hypothetical future **Adapters**.
- Tests to add at the **Interface**.
- Shallow tests or pass-through **Modules** to delete after replacement coverage exists.
