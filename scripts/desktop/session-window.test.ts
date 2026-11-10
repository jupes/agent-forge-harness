import { expect, test } from "bun:test";
import { DesktopFrame } from "../../apps/desktop/src/DesktopFrame";
import { desktopRoute } from "../../apps/desktop/src/navigation";
import {
  createSessionWindowClient,
  nativeSessionWindowInvoke,
  sessionWindowContext,
  sessionWindowHref,
  sessionWindowMatches,
  sessionWindowTargetSchema,
} from "../../apps/desktop/src/session-window";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const target = {
  projectId: "project-11111111-1111-4111-8111-111111111111",
  sessionId: "session-22222222-2222-4222-8222-222222222222",
};
test("a present invalid native target never becomes the main app context", () => {
  expect(sessionWindowContext({})).toEqual({ target: null, invalid: false });
  expect(
    sessionWindowContext({ __AF_SESSION_WINDOW_TARGET__: target }),
  ).toEqual({ target, invalid: false });
  for (const raw of [
    undefined,
    null,
    {},
    { ...target, shiftRequestId: "11111111-1111-0111-8111-111111111111" },
    {
      ...target,
      sessionId: "session-11111111-1111-4111-0111-111111111111",
      shiftRequestId: "11111111-1111-4111-8111-111111111111",
    },
  ])
    expect(sessionWindowContext({ __AF_SESSION_WINDOW_TARGET__: raw })).toEqual(
      { target: null, invalid: true },
    );
});
test("a valid exact session target creates only a scoped compact navigation address", () => {
  expect(sessionWindowTargetSchema.parse(target)).toEqual(target);
  expect(sessionWindowHref(target)).toBe(
    "#/desktop/project/" +
      target.projectId +
      "/sessions?selectionKind=session&selectionId=" +
      target.sessionId +
      "&sessionWindow=1",
  );
});
test("compact address cannot switch project, session, source original or duplicate query keys", () => {
  const href = sessionWindowHref(target);
  expect(sessionWindowMatches(target, href)).toBe(true);
  for (const bad of [
    href.replace(
      target.projectId,
      "project-33333333-3333-4333-8333-333333333333",
    ),
    href.replace(target.sessionId, "other"),
    href + "&selectionId=other",
    href + "&url=http://other",
    href.replace("sessionWindow=1", "sessionWindow=0"),
  ])
    expect(sessionWindowMatches(target, bad)).toBe(false);
  const managed = {
    ...target,
    shiftRequestId: "33333333-3333-4333-8333-333333333333",
  };
  expect(sessionWindowMatches(managed, sessionWindowHref(managed))).toBe(true);
  expect(sessionWindowMatches(target, sessionWindowHref(managed))).toBe(false);
  expect(sessionWindowMatches(managed, href)).toBe(false);
});
test("session target schema refuses paths, authority fields and malformed Shift originals", () => {
  for (const raw of [
    { ...target, url: "http://other" },
    { ...target, sessionId: "../other" },
    { ...target, sessionId: "a&b" },
    { ...target, projectId: "../other" },
    {
      ...target,
      sessionId: "observed-1",
      shiftRequestId: "33333333-3333-4333-8333-333333333333",
    },
  ])
    expect(sessionWindowTargetSchema.safeParse(raw).success).toBe(false);
});
test("popout client sends one validated native request while pending and never starts a provider", async () => {
  const calls: unknown[] = [];
  let finish: ((value: unknown) => void) | null = null;
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const client = createSessionWindowClient(
    async (command, args) => {
      calls.push({ command, args });
      return pending;
    },
    () => {},
  );
  const first = client.open(target);
  await client.open(target);
  expect(calls).toEqual([
    { command: "open_session_popout", args: { request: target } },
  ]);
  finish!({ state: "created", label: "session-popout-1" });
  await first;
  expect(client.state.message).toContain("Session window opened");
  expect(client.state.busy).toBe(false);
});
test("unknown native replies remain unconfirmed without automatic window retry", async () => {
  let count = 0;
  const client = createSessionWindowClient(
    async () => {
      count++;
      return { state: "created", label: "foreign", url: "http://other" };
    },
    () => {},
  );
  await client.open(target);
  expect(count).toBe(1);
  expect(client.state.message).toContain("could not be confirmed");
  expect(nativeSessionWindowInvoke(null)).toBeNull();
  expect(createSessionWindowClient(null, () => {}).available).toBe(false);
});
test("compact frame exposes only the current session outlet and lifecycle copy", () => {
  const view = DesktopFrame({
    compact: true,
    route: desktopRoute(sessionWindowHref(target)),
    project: { id: target.projectId, name: "Alpha", sessions: [] },
    connectionLabel: "Connected",
    inspectorOpen: true,
    onInspectorToggle() {},
    children: "Existing conversation and composer",
  });
  expect(findAll(view, "nav")).toHaveLength(0);
  expect(findAll(view, "aside")).toHaveLength(0);
  expect(
    findAll(view, "main").map((node) => attrs(node)["aria-label"]),
  ).toEqual(["Compact session"]);
  expect(textOf(view)).toContain("leaves the session running");
  expect(textOf(view)).toContain("Existing conversation and composer");
});
