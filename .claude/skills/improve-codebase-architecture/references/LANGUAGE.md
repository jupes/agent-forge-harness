# Language

Shared vocabulary for every suggestion this skill makes. Use these terms exactly. Do not substitute "component," "service," "API," or "boundary." Consistent language is the point.

## Terms
- **Module** means anything with an **Interface** and an **Implementation**. Scale-agnostic: function, class, package, workflow slice, or tier-spanning capability. Avoid: unit, component, service.
- **Interface**: everything a caller must know to use the **Module** correctly, including type signature, invariants, ordering constraints, error modes, configuration, and performance characteristics. Avoid: API, signature.
- **Implementation**: the code inside a **Module**. Reach for **Adapter** when the **Seam** is the topic; use **Implementation** otherwise.
- **Depth**: **Leverage** at the **Interface**. A deep **Module** puts a lot of behavior behind a small **Interface**. A shallow **Module** has an **Interface** nearly as complex as its **Implementation**.
- **Seam**: a place where behavior can be altered without editing in that place; the location of a **Module**'s **Interface**. Avoid: boundary.
- **Adapter**: a concrete thing satisfying an **Interface** at a **Seam**. Describes role, not substance.
- **Leverage**: what callers get from **Depth**: more capability per unit of **Interface** they learn.
- **Locality**: what maintainers get from **Depth**: change, bugs, knowledge, and verification concentrated in one place.

## Principles

- **Depth is a property of the Interface, not the Implementation.** A deep **Module** can have internal seams that callers never learn.
- **The deletion test.** If deleting the **Module** makes complexity vanish, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The Interface is the test surface.** Callers and tests cross the same **Seam**.
- **One Adapter means a hypothetical Seam. Two Adapters means a real Seam.**

## Relationships

- A **Module** has exactly one **Interface**: the surface it presents to callers and tests.
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

## Rejected Framings

- **Depth as a ratio of Implementation lines to Interface lines** rewards padding the **Implementation**. Use **Depth** as **Leverage**.
- **Interface as the TypeScript `interface` keyword or public methods** is too narrow.
- **Boundary** is overloaded with DDD's bounded context. Say **Seam** or **Interface**.
