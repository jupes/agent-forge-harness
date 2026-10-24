import { expect, test } from "bun:test";
import { SessionActivity } from "../../apps/desktop/src/SessionActivity";
import { ownedSessionTurn } from "../../apps/desktop/src/session-activity";
import type {
  CodexChatEvent,
  CodexChatFileChange,
} from "../../types/codex-chat";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../types/conversation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
  nativeTurn = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  appTurn = "accepted-file-turn",
  version = "0.163.0-alpha.10.2";
const report: CodexChatFileChange = {
  kind: "file-change",
  source: "item/started",
  threadId,
  turnId: nativeTurn,
  itemId: "files-a",
  status: "inProgress",
  changes: [
    {
      path: { text: "old/<script>.ts", truncated: false },
      kind: {
        type: "update",
        move_path: { text: "new/<img>.ts", truncated: false },
      },
      diff: { text: "-old\n+<script>inert()</script>", truncated: false },
    },
  ],
  truncated: false,
  partial: true,
  closure: "open",
  turnStatus: null,
};
const event = (report: CodexChatEvent): ConversationEvent => ({
  kind: "coding-chat",
  provider: "codex",
  version,
  event: report,
});
function page(events: ConversationEvent[]): ConversationPage {
  return {
    version: 1,
    projectId: "fixture",
    conversationId: "session-fixture",
    revision: events.length,
    binding: { provider: "codex", sessionId: threadId, version },
    turns: [],
    frames: events.map((event, index) => ({
      seq: index + 1,
      turnId: appTurn,
      at: "2026-10-23T00:00:00Z",
      event,
    })),
    more: false,
    nextCursor: events.length,
    lastSequence: events.length,
    request: null,
    controllable: false,
  };
}

test("native file changes select the last full snapshot without concatenating paths or patches, and empty changes clear it", () => {
  const revised: CodexChatFileChange = {
      ...report,
      source: "item/fileChange/patchUpdated",
      changes: [
        {
          path: { text: "replacement.ts", truncated: false },
          kind: { type: "add" },
          diff: { text: "+replacement only", truncated: false },
        },
      ],
    },
    current = page([
      event({ kind: "turn", threadId, turnId: nativeTurn }),
      event(report),
      event(revised),
      event(revised),
    ]),
    before = structuredClone(current),
    value = ownedSessionTurn(current, appTurn),
    view = SessionActivity({ value });
  expect(value).toHaveProperty("nativeFileChanges", [
    { version, report: revised },
  ]);
  expect(textOf(view)).toContain("+replacement only");
  expect(textOf(view)).not.toContain("old/<script>.ts");
  expect(textOf(view)).not.toContain("inert()");
  expect(textOf(view)).toContain("last observed item status");
  const cleared = SessionActivity({
    value: ownedSessionTurn(
      page([event(report), event({ ...revised, changes: [] })]),
      appTurn,
    ),
  });
  expect(textOf(cleared)).toContain(
    "Provider reported no file changes in this snapshot",
  );
  expect(textOf(cleared)).not.toContain("replacement.ts");
  expect(current).toEqual(before);
});

test("native diff and move text stay literal, collapsed and keyboard-scrollable without filesystem or approval controls", () => {
  const view = SessionActivity({
    value: ownedSessionTurn(page([event(report)]), appTurn),
  });
  expect(textOf(view)).toContain("old/<script>.ts");
  expect(textOf(view)).toContain("new/<img>.ts");
  expect(textOf(view)).toContain("-old\n+<script>inert()</script>");
  expect(textOf(view)).toContain("Update");
  expect(textOf(view)).toContain("Partial report");
  expect(textOf(view)).toContain(
    "does not authorize applying a patch or deciding a permission",
  );
  expect(textOf(view)).toContain("item/started");
  expect(textOf(view)).toContain(threadId);
  const disclosures = findAll(view, "details");
  expect(disclosures).toHaveLength(1);
  expect(attrs(disclosures[0]).open).toBeUndefined();
  const regions = findAll(view, "pre");
  expect(regions).toHaveLength(1);
  expect(attrs(regions[0])).toMatchObject({
    tabIndex: 0,
    role: "region",
    "aria-label": "Reported native diff",
  });
  for (const tag of ["button", "a", "script", "iframe", "img", "form"])
    expect(findAll(view, tag)).toHaveLength(0);
});

test("explicit native empty diff is distinct from a truncated empty diff, and truncation never invents missing text", () => {
  const change = report.changes[0];
  if (!change) throw Error("Missing fixture change");
  const empty = SessionActivity({
    value: ownedSessionTurn(
      page([
        event({
          ...report,
          changes: [{ ...change, diff: { text: "", truncated: false } }],
        }),
      ]),
      appTurn,
    ),
  });
  expect(textOf(empty)).toContain("Provider reported an empty diff");
  expect(textOf(empty)).not.toContain("Diff text truncated");
  const clipped = SessionActivity({
    value: ownedSessionTurn(
      page([
        event({
          ...report,
          truncated: true,
          changes: [
            {
              path: { text: "", truncated: true },
              kind: {
                type: "update",
                move_path: { text: "", truncated: true },
              },
              diff: { text: "", truncated: true },
            },
          ],
        }),
      ]),
      appTurn,
    ),
  });
  expect(textOf(clipped)).toContain(
    "Diff text truncated before any content was retained",
  );
  expect(textOf(clipped)).toContain("Path text truncated");
  expect(textOf(clipped)).toContain("Move destination text truncated");
  expect(textOf(clipped)).toContain("Snapshot truncated");
  expect(textOf(clipped)).not.toContain("Provider reported an empty diff");
  const omittedList = SessionActivity({
    value: ownedSessionTurn(
      page([event({ ...report, changes: [], truncated: true })]),
      appTurn,
    ),
  });
  expect(textOf(omittedList)).toContain(
    "No file changes were retained in this truncated snapshot",
  );
  expect(textOf(omittedList)).not.toContain(
    "Provider reported no file changes",
  );
});

test("native file statuses and item versus turn closure remain independent, including failed and declined reports", () => {
  for (const status of ["completed", "failed", "declined"] as const) {
    const ended: CodexChatFileChange = {
        ...report,
        source: "item/completed",
        status,
        partial: false,
        closure: "item-ended",
      },
      final: CodexChatFileChange = {
        ...ended,
        source: "turn/completed",
        closure: "turn-ended",
        turnStatus: "interrupted",
        partial: true,
      },
      value = ownedSessionTurn(
        page([event(report), event(ended), event(final)]),
        appTurn,
      ),
      view = SessionActivity({ value });
    expect(value).toHaveProperty("nativeFileChanges", [
      { version, report: final },
    ]);
    expect(textOf(view)).toContain(`Reported ${status}`);
    expect(textOf(view)).toContain("Native turn reported interrupted");
    expect(textOf(view)).not.toContain("applied successfully");
    expect(textOf(view)).toContain("Partial report");
    const itemView = SessionActivity({
      value: ownedSessionTurn(page([event(ended)]), appTurn),
    });
    expect(textOf(itemView)).toContain(
      "Item report ended; native turn completion is not established by this report",
    );
    expect(textOf(itemView)).not.toContain("Native turn reported interrupted");
  }
});

test("native file projection cannot borrow another app turn, native thread, version or conflicting native turn", () => {
  const current = page([
    event({ kind: "turn", threadId, turnId: nativeTurn }),
    event(report),
  ]);
  expect(ownedSessionTurn(current, "other-app-turn")).toHaveProperty(
    "nativeFileChanges",
    [],
  );
  for (const binding of [
    null,
    { provider: "claude" as const, sessionId: threadId, version },
    { provider: "codex" as const, sessionId: nativeTurn, version },
    { provider: "codex" as const, sessionId: threadId, version: "other" },
  ])
    expect(ownedSessionTurn({ ...current, binding }, appTurn)).toHaveProperty(
      "nativeFileChanges",
      [],
    );
  expect(
    ownedSessionTurn(
      page([
        event({ kind: "turn", threadId, turnId: nativeTurn }),
        event({ ...report, turnId: threadId }),
      ]),
      appTurn,
    ),
  ).toHaveProperty("nativeFileChanges", []);
  expect(
    ownedSessionTurn(
      page([
        event(report),
        event({ ...report, itemId: "second", turnId: threadId }),
      ]),
      appTurn,
    ),
  ).toHaveProperty("nativeFileChanges", []);
  const partial = page([
    event({ ...report, source: "item/fileChange/patchUpdated" }),
  ]);
  if (!partial.frames[0]) throw Error("Missing partial fixture");
  partial.frames[0].seq = 201;
  expect(ownedSessionTurn(structuredClone(partial), appTurn)).toHaveProperty(
    "nativeFileChanges",
    [
      {
        version,
        report: { ...report, source: "item/fileChange/patchUpdated" },
      },
    ],
  );
});

test("closed or terminal reports cannot be reopened by later file snapshots, while matching final turn reports remain visible", () => {
  const ended: CodexChatFileChange = {
      ...report,
      source: "item/completed",
      status: "completed",
      partial: false,
      closure: "item-ended",
    },
    final: CodexChatFileChange = {
      ...ended,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "completed",
    },
    late: CodexChatFileChange = {
      ...report,
      source: "item/fileChange/patchUpdated",
      changes: [],
    };
  for (const reports of [
    [report, ended, late],
    [report, ended, final, late],
    [report, ended, { ...final, changes: [] }],
  ]) {
    const value = ownedSessionTurn(page(reports.map(event)), appTurn);
    expect(value).toHaveProperty("nativeFileChanges", [
      { version, report: reports.includes(final) ? final : ended },
    ]);
    expect(textOf(SessionActivity({ value }))).not.toContain(
      "Provider reported no file changes in this snapshot",
    );
  }
  const terminal = event({
    kind: "outcome",
    outcome: {
      phase: "failed",
      reason: "actual failure",
      threadId,
      turnId: nativeTurn,
      observedModel: null,
      usage: null,
      exitCode: 1,
      stopped: false,
      timedOut: false,
    },
  });
  expect(
    ownedSessionTurn(page([event(report), terminal, event(late)]), appTurn),
  ).toHaveProperty("nativeFileChanges", [{ version, report }]);
  const absent = ownedSessionTurn(page([]), appTurn);
  expect(absent).toHaveProperty("nativeFileChanges", []);
  expect(SessionActivity({ value: absent })).toBeNull();
});
