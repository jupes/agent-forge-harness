# Native Chat MCP tool-call reports

This view renders bounded app-server MCP tool-call snapshots from an explicitly
owned Codex Chat journal. It is a historical report, not a tool invocation,
resource link, approval, or permission to repeat an operation. Arguments,
results, structured content and error text remain literal inert text. The
renderer does not fetch reported URIs, images, resources, or links.

The report preserves native distinctions: a null result differs from a result
whose content is `[]`; null structured content differs from an empty JSON value;
missing error text differs from explicit empty or clipped text; item status is
independent from turn closure. Clipped and omitted JSON stays marked incomplete.
The protected whole-state and partial-page codecs bind reports to the checked
Codex version, saved session, and one native turn before projection.

The packaged smoke seeds only synthetic, completed historical reports in its
private home. It verifies literal text, keyboard focus, the collapsed-by-default
disclosure, zero POST requests during inspection, and byte-for-byte journal
stability, then restores the original route and removes its request observer.
Its dedicated screenshot is captured after those assertions and masks report
identity text. The fixture never launches a provider or acts on a reported tool.

Related boundary and first-party format notes: [private session activity](./private-session-activity.md).
