# CONTEXT.md Format

Use this format when a target repo already keeps domain context in `CONTEXT.md` or `CONTEXT-MAP.md`, or when the user explicitly asks the domain-model session to create target-repo context docs.

For Agent Forge harness work, prefer durable `knowledge/` entries or Beads `design:` comments unless target-repo docs are already the repo convention.

## Single Context

```md
# {Context Name}

{One or two sentences describing what this context is and why it exists.}

## Language

**Order**:
{A concise description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account

## Relationships

- An **Order** produces one or more **Invoices**
- An **Invoice** belongs to exactly one **Customer**

## Example dialogue

> **Dev:** "When a **Customer** places an **Order**, do we create the **Invoice** immediately?"
> **Domain expert:** "No. An **Invoice** is only generated once a **Fulfillment** is confirmed."

## Flagged ambiguities

- "account" was used to mean both **Customer** and **User**. Resolved: these are distinct concepts.
```

## Rules

- Be opinionated. When multiple words name the same concept, choose the canonical term and list aliases to avoid.
- Flag conflicts explicitly in `Flagged ambiguities` with the final resolution.
- Keep definitions tight: one sentence, defining what the concept is rather than what it does.
- Show relationships with bold term names and cardinality where obvious.
- Include only terms meaningful to domain experts. General programming concepts, utility patterns, and implementation mechanisms do not belong.
- Group terms under subheadings when natural clusters emerge; keep a flat list when the context is cohesive.
- Include an example dialogue that demonstrates how terms interact and clarifies boundaries between related concepts.

Before adding a term, ask: "Is this concept unique to this domain context, or is it general engineering language?" Add only the former.

## Multiple Contexts

If the repo has multiple bounded contexts, keep a root `CONTEXT-MAP.md` that points to each context-specific `CONTEXT.md`.

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) - receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) - generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) - manages warehouse picking and shipping

## Relationships

- **Ordering -> Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment -> Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering <-> Billing**: Shared types for `CustomerId` and `Money`
```

Infer the structure this way:

- If `CONTEXT-MAP.md` exists, read it first and update the matching context.
- If only a root `CONTEXT.md` exists, treat the repo as a single context.
- If neither exists, do not create context docs unless the user requests target-repo docs or the first durable term must be recorded there.
- When multiple contexts exist and the current topic could belong to more than one, ask one clarifying question before writing.

## Harness Persistence Equivalent

When using Agent Forge persistence instead of target-repo docs, capture the same information in the closest durable home:

- `knowledge/repos/<repo>.yaml`: durable domain facts, canonical terms, relationships, and patterns useful across sessions.
- Beads `design:` comments: issue-scoped terminology decisions, ambiguity resolutions, and boundary choices.
- Beads `worklog:` comments: investigation notes and session progress.

Keep the same quality bar: canonical language, explicit ambiguities, concise definitions, and concrete relationships.
