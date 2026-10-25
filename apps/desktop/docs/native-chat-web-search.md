# Native Chat web-search reports

This view presents supplied native Codex Chat `webSearch` snapshots from an
explicitly owned private journal. It does not execute a search, open a reported
page, fetch a result, or provide approval or tool controls. Query, action and
results stay literal, collapsed report text. Reported URLs are not links.

## Pinned source and retained contract

The pinned model-free local Codex CLI generation is `0.163.0-alpha.10.2`. Its
generated v2 `ThreadItem.ts` imports and intersects the root `WebSearchItem.ts`.
That item supplies `id`, `query`, nullable `action`, and nullable
`Array<JsonValue>` results. The v2 `WebSearchAction.ts` discriminates `search`
with required nullable `query` and `queries`, `openPage` with required nullable
`url`, `findInPage` with required nullable `url` and `pattern`, and `other`.
These are app-server camelCase variants and nullable fields; the separate exec
`web_search` query-only tool row is unchanged.

The retained family binds source, checked version, native thread, turn and item
identity. It stores each full replacement snapshot without merging queries,
actions, or results across updates. Item closure (`open`, `item-ended`, or
`turn-ended`) and an explicitly reported native turn status stay separate.
There is no synthesized search status or duration. Whole-history and protected
partial-page reads use the same native identity and closure fences as the other
rich report families; changed query identity, conflicting item kind, foreign
thread/turn/version, reopened completion, and stale post-close siblings are
refused.

Null action or results mean not reported. An empty JSON array, empty string,
clipped prefix, and omitted tail remain distinct supplied facts. Results remain
opaque JSON values; the renderer does not interpret their fields or promote
URLs to browser navigation. App, plugin, `_meta`, progress and presentation hints
are outside this report family.

## Shared bounds

Query, action JSON and result JSON share the existing 16 KiB retained UTF-8
text budget per report. Each JSON value is bounded to 32 KiB, depth 16 and
10,000 nodes; one report is limited to 64 KiB. The existing 2 MiB/4096-event
turn, 128-entry report lists, and 256 native rich-item limit remain shared with
the private activity boundary. The app-server reader's 1 MiB line bound and
private writer queue's 256-frame/1 MiB cap are unchanged.

The WebSearch presentation is grouped under Reported activity. Its disclosure
starts collapsed, query and JSON regions support keyboard scrolling, and the
view exposes only supplied text plus the explicit closure facts. It has no
button, anchor, form, image, fetch, or tool-invocation surface.

The masked [browser fixture capture](screenshots/native-chat-web-search.png)
shows only synthetic report values after the functional browser assertions.

Related boundaries: [private session activity](./private-session-activity.md)
and [native MCP tool-call reports](./native-chat-mcp-tool-calls.md).
