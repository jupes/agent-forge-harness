import { expect, test } from "bun:test";
import {
  compatibilityFromHealth,
  desktopConnection,
} from "../../apps/desktop/src/connection-state";
import { MAX_FAILURES, type StreamDiagnostics } from "../../docs/js/use-stream";

const initial: StreamDiagnostics = {
  consecutiveFailures: 0,
  retryLimit: MAX_FAILURES - 1,
  lastDataAt: null,
};
const compatible = {
  state: "compatible",
  appVersion: "1",
  hearthVersion: "1",
} as const;

test("health compatibility is explicit, and malformed or missing versions stay unknown", () => {
  expect(compatibilityFromHealth({ apiVersion: 1 })).toEqual(compatible);
  expect(compatibilityFromHealth({ apiVersion: 2 })).toEqual({
    state: "mismatch",
    appVersion: "1",
    hearthVersion: "2",
  });
  for (const data of [
    null,
    {},
    { apiVersion: "1" },
    { apiVersion: 0 },
    { apiVersion: 1.1 },
    { apiVersion: Number.NaN },
  ])
    expect(compatibilityFromHealth(data).state).toBe("unknown");
});

test("connecting has no invented data time and no available writes", () => {
  expect(desktopConnection("connecting", initial, compatible)).toMatchObject({
    phase: "connecting",
    label: "Connecting",
    lastDataAt: null,
    lastKnown: false,
    retry: null,
    writesAllowed: false,
    action: "none",
  });
});

test("only an explicit compatible live connection makes writes available", () => {
  expect(
    desktopConnection("live", { ...initial, lastDataAt: 0 }, compatible),
  ).toMatchObject({
    phase: "connected",
    label: "Connected",
    writesAllowed: true,
    lastDataAt: 0,
    lastKnown: false,
  });
  const unknown = desktopConnection("live", initial, {
    state: "unknown",
    reason: "The hearth does not report its compatibility version.",
  });
  expect(unknown.phase).toBe("connected");
  expect(unknown.writesAllowed).toBe(false);
  expect(unknown.detail).toContain("does not report");
});

test("reconnecting reports the real bounded retry and keeps last stream data marked stale", () => {
  const view = desktopConnection(
    "reconnecting",
    { ...initial, consecutiveFailures: 3, lastDataAt: 42 },
    compatible,
  );
  expect(view).toMatchObject({
    phase: "reconnecting",
    retry: { attempt: 3, total: MAX_FAILURES - 1 },
    lastKnown: true,
    lastDataAt: 42,
    writesAllowed: false,
    action: "restart",
  });
  expect(view.detail).toContain("last stream data");
  expect(
    desktopConnection("reconnecting", initial, compatible).retry,
  ).toBeNull();
  const stopped = desktopConnection(
    "off",
    { ...initial, consecutiveFailures: MAX_FAILURES, lastDataAt: 42 },
    compatible,
  );
  expect(stopped).toMatchObject({
    phase: "stopped",
    label: "Stopped",
    retry: null,
    lastKnown: true,
    lastDataAt: 42,
    writesAllowed: false,
    action: "restart",
  });
});

test("version mismatch requires an explicit live compatibility signal", () => {
  const mismatch = {
    state: "mismatch",
    appVersion: "2",
    hearthVersion: "1",
  } as const;
  const view = desktopConnection(
    "live",
    { ...initial, lastDataAt: 10 },
    mismatch,
  );
  expect(view).toMatchObject({
    phase: "version-mismatch",
    label: "Version mismatch",
    writesAllowed: false,
    action: "restart",
  });
  expect(view.detail).toContain("app 2");
  expect(view.detail).toContain("hearth 1");
  expect(desktopConnection("off", initial, mismatch).phase).toBe("stopped");
  expect(desktopConnection("live", initial, mismatch).lastKnown).toBe(false);
});
