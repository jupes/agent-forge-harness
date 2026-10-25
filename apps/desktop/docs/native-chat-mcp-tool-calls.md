# Native Chat MCP tool-call reports

This view renders bounded app-server MCP tool-call snapshots from an explicitly
owned Codex Chat journal. It is a historical report, not a tool invocation,
resource link, approval, or permission to repeat an operation. Arguments,
results, structured content and error text remain literal inert text. The
renderer does not fetch reported URIs, images, resources, or links.

## Native source and retained shape

The pinned model-free local Codex CLI generation is `0.163.0-alpha.10.2`. Its
generated contract is in `.tmp/work/codex-protocol-0.163/v2/ThreadItem.ts`,
`McpToolCallStatus.ts`, `McpToolCallResult.ts`, `McpToolCallError.ts`, and
`McpToolCallProgressNotification.ts`. A `mcpToolCall` item supplies its native
item id, server, tool, status (`inProgress`, `completed`, or `failed`), JSON
arguments, nullable result/error/duration and optional presentation/context
metadata. Results distinguish the content array, nullable structured content,
and nullable `_meta`. Progress is a separate thread/turn/item-bound notification
with supplied text. This snapshot view retains full item snapshots only;
progress, `_meta`, app/plugin/context hints and resource bodies are omitted.

The private family carries source, checked version, thread/turn/item identity,
reported status, arguments, result, error, duration, partial state and item/turn
closure separately. Full replacement snapshots are never combined with
progress text or interpreted as commands. Whole-history and protected
partial-page admission bind the snapshot to the saved Codex Chat version,
session, and a single native turn before the UI sees it.

The report preserves native distinctions: a null result differs from a result
whose content is `[]`; null structured content differs from an empty JSON value;
missing error text differs from explicit empty or clipped text; item status is
independent from turn closure. Clipped and omitted JSON stays marked incomplete.
Each report shares a 16 KiB retained UTF-8 text budget; JSON values are bounded
to 32 KiB, depth 16 and 10,000 nodes. The 64 KiB event, 2 MiB/4096-event turn,
128-item lists, and 256 native rich-item limit remain shared with the existing
private activity boundary. The app-server reader retains its 1 MiB native
line bound and the private writer queue remains capped at 256 frames/1 MiB;
these shared wire and queue limits are unchanged.

The packaged smoke seeds only synthetic, completed historical reports in its
private home. It verifies literal text, keyboard focus, the collapsed-by-default
disclosure, zero POST requests during inspection, and byte-for-byte journal
stability, then restores the original route and removes its request observer.
Its dedicated screenshot is captured after those assertions and masks report
identity text. The fixture never launches a provider or acts on a reported tool.

Related boundary and first-party format notes: [private session activity](./private-session-activity.md).
