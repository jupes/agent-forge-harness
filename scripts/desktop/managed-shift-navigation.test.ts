import { expect, test } from "bun:test";
import {
  managedShiftHref,
  managedShiftSelection,
} from "../../apps/desktop/src/managed-shift-navigation";
import {
  desktopRoute,
  observeDesktopRoute,
} from "../../apps/desktop/src/navigation";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId = "2230bb02-1119-4c69-adad-c44116b375c1",
  sessionId = "session-2d5ed741-5528-424c-a927-263348778dad";

test("exact managed attempt and original links survive recreation and back/forward without a replacement address", () => {
  const attempt = { projectId, requestId, sessionId },
    original = { projectId, requestId, sessionId: null };
  const attemptHref = managedShiftHref(attempt),
    originalHref = managedShiftHref(original);
  expect(managedShiftSelection(attemptHref)).toEqual({
    selection: attempt,
    error: "",
  });
  expect(managedShiftSelection(originalHref)).toEqual({
    selection: original,
    error: "",
  });
  let hash = attemptHref;
  const listener = { changed: () => {} },
    observed: string[] = [];
  const close = observeDesktopRoute(
    {
      hash: () => hash,
      listen: (changed) => {
        listener.changed = changed;
        return () => {};
      },
    },
    () => observed.push(managedShiftSelection(hash).selection?.requestId ?? ""),
  );
  hash = originalHref;
  listener.changed();
  hash = attemptHref;
  listener.changed();
  expect(observed).toEqual([requestId, requestId, requestId]);
  expect(desktopRoute(attemptHref).selection).toEqual({
    kind: "session",
    id: sessionId,
  });
  close();
});

test("malformed or widened original links refuse rather than selecting a different attempt", () => {
  const original = managedShiftHref({ projectId, requestId, sessionId: null });
  for (const hash of [
    `${original}&shiftRequestId=${requestId}`,
    original.replace(requestId, "../other"),
    original.replace(projectId, "external-project"),
    original.replace("workbench", "sessions"),
    `${original}&selectionKind=bead&selectionId=alpha-1`,
    managedShiftHref({ projectId, requestId, sessionId }).replace(
      sessionId,
      "external-session",
    ),
  ]) {
    const read = managedShiftSelection(hash);
    expect(read.selection).toBeNull();
    expect(read.error).not.toBe("");
  }
  expect(managedShiftSelection("#/desktop/projects")).toEqual({
    selection: null,
    error: "",
  });
});
