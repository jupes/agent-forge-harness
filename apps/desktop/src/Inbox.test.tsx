import { expect, test } from "bun:test";
import { toChildArray, type VNode } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import {
  InboxDispositionHistoryActions,
  type InboxProps,
  PermissionOrDispositionCard,
} from "./Inbox";
import type {
  InboxCurrentPermissionItem,
  InboxHeldPermissionItem,
  InboxPermissionItem,
} from "./inbox-model";
import type { InboxCard, InboxFilters } from "./inbox-view";
import { desktopHref } from "./navigation";

const currentPermission: InboxCurrentPermissionItem = {
  kind: "permission",
  state: "current",
  complete: true,
  key: "permission-offer",
  actionable: true,
  snapshotGeneration: 4,
  observedAt: "2026-10-31T12:00:00.000Z",
  projectId: "project-a",
  workspace: "C:/work/a",
  provider: "codex",
  sessionId: "session-a",
  acceptedTurnId: "turn-a",
  offerId: "offer-a",
  approval: {
    provider: "codex",
    value: {
      id: "offer-a",
      kind: "command",
      command: "bun test",
      cwd: "C:/work/a",
      reason: "Run the focused checks.",
      availableDecisions: ["accept", "decline"],
    },
  },
};
const currentGeminiPermission: InboxCurrentPermissionItem = {
  ...currentPermission,
  key: "gemini-offer",
  provider: "gemini",
  offerId: "gemini-offer",
  approval: {
    provider: "gemini",
    value: {
      id: "gemini-offer",
      detail: { json: '{"tool":"read_file"}', truncated: false },
      detailsComplete: true,
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    },
  },
};
const incompleteGeminiPermission: InboxCurrentPermissionItem = {
  ...currentGeminiPermission,
  key: "gemini-incomplete",
  offerId: "gemini-incomplete",
  approval: {
    provider: "gemini",
    value: {
      id: "gemini-incomplete",
      detail: {
        json: '{"tool":"read_file"}',
        truncated: true,
        omitted: "size",
      },
      detailsComplete: false,
      options: [
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    },
  },
};
const heldPermission: InboxHeldPermissionItem = {
  kind: "permission",
  state: "held",
  complete: false,
  actionable: false,
  key: "permission-held",
  snapshotGeneration: 3,
  observedAt: "2026-10-31T11:00:00.000Z",
  projectId: "project-a",
  workspace: "C:/work/a",
  provider: "codex",
  sessionId: "session-a",
  acceptedTurnId: "turn-held",
  offerId: "offer-held",
  identity: {
    requestId: "request-held",
    turnRequestId: "turn-held",
    approvalId: "offer-held",
    decision: "decline",
    projectId: "project-a",
    sessionId: "session-a",
  },
};
const filters: InboxFilters = {
  projectId: "",
  sourceKind: "all",
  bucket: "needs-you",
};
const acknowledged: Array<{
  card: InboxCard;
  operation: "done" | "snooze-1h";
}> = [];
const props: Pick<InboxProps, "dispositionLoading" | "onAcknowledge"> = {
  dispositionLoading: false,
  onAcknowledge: async (item, operation) => {
    acknowledged.push({ card: item, operation });
  },
};
const card = (
  permission?: InboxPermissionItem,
  sourceKind: InboxCard["sourceKind"] = permission
    ? "permission"
    : "unknown-bead-write",
  patch: Partial<InboxCard> = {},
): InboxCard => ({
  key: permission?.key ?? "write-a",
  projectId: "project-a",
  workspace: "C:/work/a",
  projectName: "Alpha",
  sourceKind,
  stableItemId: permission?.offerId ?? "write-a",
  sourceRevision: permission?.acceptedTurnId ?? "write:comment:a",
  title: "Permission request",
  detail: "Source details stay visible.",
  observedAt: "2026-10-31T12:00:00.000Z",
  sourceState: permission?.state === "held" ? "unavailable" : "current",
  resolved: true,
  canSnooze: true,
  canCheck: false,
  notice: false,
  ...(permission ? { permission, permissionKey: permission.key } : {}),
  ...patch,
});
const view = (item: InboxCard) =>
  PermissionOrDispositionCard({
    card: item,
    props,
    filters,
    canAcknowledge: true,
  });
function isVNode(value: unknown): value is VNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value
  );
}
function nodes(node: VNode): VNode[] {
  return [
    node,
    ...toChildArray(node.props.children).flatMap((child) =>
      isVNode(child) ? nodes(child) : [],
    ),
  ];
}
function text(node: VNode): string {
  return toChildArray(node.props.children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isVNode(child)
          ? text(child)
          : "",
    )
    .join("");
}
const buttons = (node: VNode) =>
  nodes(node).filter((item) => item.type === Button);
const property = (node: VNode, name: string): unknown =>
  Object.entries(node.props).find(([key]) => key === name)?.[1];
const stringProperty = (node: VNode, name: string): string | undefined => {
  const value = property(node, name);
  return typeof value === "string" ? value : undefined;
};
const booleanProperty = (node: VNode, name: string): boolean | undefined => {
  const value = property(node, name);
  return typeof value === "boolean" ? value : undefined;
};
const sessionHref = (item: InboxPermissionItem) =>
  desktopHref({
    destination: "sessions",
    projectId: item.projectId,
    selection: { kind: "session", id: item.sessionId },
  });

test("current and retained permission rows show exact session navigation without actions", () => {
  for (const permission of [
    currentPermission,
    currentGeminiPermission,
    heldPermission,
  ]) {
    const row = view(card(permission));
    expect(text(row)).toContain("Open session");
    expect(buttons(row)).toHaveLength(0);
    expect(
      (() => {
        const anchor = nodes(row).find((item) => item.type === "a");
        return anchor ? stringProperty(anchor, "href") : undefined;
      })(),
    ).toBe(sessionHref(permission));
  }
  expect(text(view(card(currentPermission)))).toContain("bun test");
  const gemini = view(card(currentGeminiPermission));
  expect(text(gemini)).toContain("Review native permission details");
  expect(text(gemini)).toContain('{"tool":"read_file"}');
  expect(buttons(gemini)).toHaveLength(0);
  const incompleteGemini = view(card(incompleteGeminiPermission));
  expect(text(incompleteGemini)).toContain("Complete details are unavailable.");
  expect(buttons(incompleteGemini)).toHaveLength(0);
  expect(text(view(card(heldPermission)))).toContain(
    "Original permission is held",
  );
  expect(text(view(card(heldPermission)))).toContain(
    "No replacement decision will be sent.",
  );
});

test("permission source kind remains read-only when its optional payload is absent", () => {
  const sourceKindOnly = view(card(undefined, "permission"));
  expect(buttons(sourceKindOnly)).toHaveLength(0);
  expect(nodes(sourceKindOnly).some((item) => item.type === "a")).toBe(false);

  const payloadOnly = view(card(currentPermission, "unknown-bead-write"));
  expect(buttons(payloadOnly)).toHaveLength(0);
  expect(
    (() => {
      const anchor = nodes(payloadOnly).find((item) => item.type === "a");
      return anchor ? stringProperty(anchor, "href") : undefined;
    })(),
  ).toBe(sessionHref(currentPermission));
});

test("permission history has no recovery controls while generic recovery stays available", async () => {
  const permission = InboxDispositionHistoryActions({
    sourceKind: "permission",
    requestId: "request-permission",
    state: "persisted-reserved",
    reserved: true,
    checked: true,
    loading: false,
    onCheck: async () => false,
    onDiscard: async () => {},
    onReview: async () => {},
  });
  expect(text(permission)).toContain(
    "This original permission record remains retained and read-only.",
  );
  expect(buttons(permission)).toHaveLength(0);

  const calls: string[] = [];
  const callbacks = {
    onCheck: async (id: string) => {
      calls.push("check:" + id);
      return false;
    },
    onDiscard: async (id: string) => {
      calls.push("discard:" + id);
    },
    onReview: async (id: string) => {
      calls.push("review:" + id);
    },
  };
  const unknown = InboxDispositionHistoryActions({
    sourceKind: "unknown-bead-write",
    requestId: "request-unknown",
    state: "reserve-unknown",
    reserved: false,
    checked: false,
    loading: false,
    ...callbacks,
  });
  const unknownButtons = buttons(unknown);
  expect(unknownButtons.map(text)).toEqual([
    "Check exact original",
    "Review unconfirmed reservation",
  ]);
  for (const button of unknownButtons) {
    const click = property(button, "onClick");
    expect(typeof click).toBe("function");
    if (typeof click === "function") await Reflect.apply(click, undefined, []);
  }
  expect(calls).toEqual(["check:request-unknown", "review:request-unknown"]);

  calls.length = 0;
  const reserved = InboxDispositionHistoryActions({
    sourceKind: "unknown-bead-write",
    requestId: "request-reserved",
    state: "persisted-reserved",
    reserved: true,
    checked: true,
    loading: false,
    ...callbacks,
  });
  const reservedButtons = buttons(reserved);
  expect(reservedButtons.map(text)).toEqual([
    "Check exact original",
    "Discard checked reservation",
  ]);
  for (const button of reservedButtons) {
    const click = property(button, "onClick");
    expect(typeof click).toBe("function");
    if (typeof click === "function") await Reflect.apply(click, undefined, []);
  }
  expect(calls).toEqual(["check:request-reserved", "discard:request-reserved"]);
});

test("unresolved unknown writes keep Snooze but disable Done", async () => {
  acknowledged.length = 0;
  const item = card(undefined, "unknown-bead-write", { resolved: false });
  const controls = buttons(view(item));
  expect(controls.map(text)).toEqual([
    "Snooze 1 hour",
    "Mark done · source unresolved",
  ]);
  expect(
    controls[1] ? booleanProperty(controls[1], "disabled") : undefined,
  ).toBe(true);
  expect(
    controls[1] ? property(controls[1], "onClick") : undefined,
  ).toBeUndefined();
  const snooze = controls[0] ? property(controls[0], "onClick") : undefined;
  expect(typeof snooze).toBe("function");
  if (typeof snooze === "function") await Reflect.apply(snooze, undefined, []);
  expect(acknowledged).toEqual([{ card: item, operation: "snooze-1h" }]);
});

test("resolved generic Done forwards the exact card and operation", async () => {
  acknowledged.length = 0;
  const item = card(undefined, "bead-approval", { resolved: true });
  const done = buttons(view(item)).find(
    (button) => text(button) === "Mark done",
  );
  expect(done).toBeDefined();
  const click = done ? property(done, "onClick") : undefined;
  expect(typeof click).toBe("function");
  if (typeof click === "function") await Reflect.apply(click, undefined, []);
  expect(acknowledged).toEqual([{ card: item, operation: "done" }]);
});
