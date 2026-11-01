import { expect, test } from "bun:test";
import { createInboxClient } from "../../apps/desktop/src/inbox-client";
import {
  desktopRoute,
  observeDesktopRoute,
} from "../../apps/desktop/src/navigation";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../scripts/projects/testing";
import type { GeminiChatOwnedRecord } from "../../types/gemini-owned-chat";
import type { ProjectsHome } from "../../types/project-summary";

const workspace = "C:/workspaces/inbox-fixture",
  sessionId = "session-4126bd68-13ab-4a9c-a517-4ce1215b0ef8",
  sessionRequestId = "e39562de-18b4-4e39-a22a-4913e9fdc0f2",
  turnRequestId = "49972ff7-901c-4ec7-a5e2-9368825eb4c1",
  approvalId = "d22b8844-2e09-458c-9d54-50719c03dc54";

const record: GeminiChatOwnedRecord = {
  id: sessionId,
  requestId: sessionRequestId,
  projectId: FIXTURE_PROJECT_ID,
  requestHash: "a".repeat(64),
  createdAt: "2026-10-31T00:00:00.000Z",
  provider: "gemini",
  route: "gemini-cli",
  mode: "chat",
  smith: "gemini",
  requestedModel: null,
  requestedEffort: null,
  workspace,
  repository: workspace,
  worktree: workspace,
};

const home: ProjectsHome = {
  catalog: projectCatalogFixture(workspace),
  asOf: "2026-10-31T00:00:00.000Z",
  summaries: [
    {
      projectId: FIXTURE_PROJECT_ID,
      workspace,
      asOf: "2026-10-31T00:00:00.000Z",
      complete: true,
      problems: [],
      beads: null,
      queue: null,
      needsYou: [],
      sessions: [],
      sessionsComplete: true,
      runs: [],
      lastActivity: null,
    },
  ],
};

const approvalPage = {
  pending: [
    {
      turnRequestId,
      actionable: true as const,
      approval: {
        id: approvalId,
        detail: { json: "{}", truncated: false },
        detailsComplete: true,
        options: [
          {
            optionId: "allow",
            name: "Allow once",
            kind: "allow_once" as const,
          },
        ],
      },
    },
  ],
  receipt: null,
};

function sessionsSource() {
  return {
    async refresh() {},
    project() {
      return { records: [record], loaded: true, loading: false, error: "" };
    },
  };
}

test("Inbox permission discovery stays read-only and synchronously invalidates selection on refresh", async () => {
  let blockRead = false,
    announceRead: (() => void) | null = null,
    heldReads = 0;
  const approvalPath = `/projects/${encodeURIComponent(FIXTURE_PROJECT_ID)}/sessions/${encodeURIComponent(sessionId)}/approvals`;
  const historyPath = `/projects/${encodeURIComponent(FIXTURE_PROJECT_ID)}/sessions/${encodeURIComponent(sessionId)}?after=0&limit=100&requestId=${encodeURIComponent(turnRequestId)}`;
  const approvalReadUrls: string[] = [];
  const approvalDtos: unknown[] = [];
  const historyReadUrls: string[] = [];
  const approvalGate: { resolve?: (value: unknown) => void } = {};
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  const client = createInboxClient({
    now: () => "2026-10-31T00:00:01.000Z",
    heldOriginal: () => {
      heldReads++;
      return null;
    },
    read: async (path) => {
      if (path === approvalPath) {
        approvalReadUrls.push(path);
        if (!blockRead) {
          approvalDtos.push(approvalPage);
          return approvalPage;
        }
        announceRead?.();
        return new Promise((resolve) => {
          approvalGate.resolve = (value) => {
            approvalDtos.push(value);
            resolve(value);
          };
        });
      }
      historyReadUrls.push(path);
      throw Error("The historical permission fixture is unavailable.");
    },
  });
  const input = { home, homeCurrent: true, sessions: sessionsSource() };
  try {
    await client.refresh(input);
    const [item] = client.snapshot().items;
    const priorItemKey = item!.key;
    expect(item).toMatchObject({
      state: "current",
      projectId: FIXTURE_PROJECT_ID,
      workspace,
      provider: "gemini",
      sessionId,
      acceptedTurnId: turnRequestId,
      offerId: approvalId,
      actionable: true,
    });
    expect(heldReads).toBe(1);
    expect(client.selectPermission(item!.key)).toBe(true);
    expect(client.currentSelection()).toMatchObject({
      selectionGeneration: 2,
      currentSelectionGeneration: 2,
      snapshotGeneration: client.snapshot().generation,
    });
    expect(client.selectedActivation()).toMatchObject({
      projectId: FIXTURE_PROJECT_ID,
      sessionId,
      requestId: approvalId,
      inboxSelectionGeneration: 2,
      actionable: true,
    });

    blockRead = true;
    const refreshing = client.refresh(input);
    expect(client.snapshot().loading).toBe(true);
    expect(client.currentSelection()).toBeNull();
    await readStarted;
    const resolveApprovalRead = approvalGate.resolve;
    if (!resolveApprovalRead)
      throw Error("The protected approval read was not pending.");
    const noPendingApprovals = { pending: [], receipt: null };
    resolveApprovalRead(noPendingApprovals);
    await refreshing;
    expect(noPendingApprovals.pending).toEqual([]);
    expect(approvalReadUrls).toEqual([approvalPath, approvalPath]);
    expect(approvalDtos).toEqual([approvalPage, noPendingApprovals]);
    expect(historyReadUrls).toEqual([historyPath]);
    expect(client.snapshot()).toMatchObject({ loading: false });
    expect(client.snapshot().items.map((entry) => entry.key)).toEqual([priorItemKey]);
    expect(client.snapshot().coverage).toContainEqual(expect.objectContaining({
      projectId: FIXTURE_PROJECT_ID,
      workspace,
      sessionId,
      provider: "gemini",
      state: "unavailable",
      reason: "The exact original permission history could not be verified; the prior row remains visible without Done authority.",
    }));
    expect(client.permissionResolutions()).toEqual([]);
    expect(client.currentSelection()).toBeNull();
  } finally {
    client.dispose();
  }
});

test("Inbox keeps the exact held original visible when the current approvals read is unavailable", async () => {
  const identity = {
    requestId: "4ed0a0c0-32da-4d6d-972f-616f2489556e",
    turnRequestId,
    approvalId,
    optionId: "allow",
    projectId: FIXTURE_PROJECT_ID,
    sessionId,
  };
  const client = createInboxClient({
    now: () => "2026-10-31T00:00:02.000Z",
    heldOriginal: () => identity,
    read: async () => {
      throw Error("The current approvals page is unavailable.");
    },
  });
  try {
    await client.refresh({
      home,
      homeCurrent: true,
      sessions: sessionsSource(),
    });
    const [item] = client.snapshot().items;
    expect(item).toMatchObject({
      state: "held",
      complete: true,
      actionable: false,
      projectId: FIXTURE_PROJECT_ID,
      workspace,
      provider: "gemini",
      sessionId,
      acceptedTurnId: turnRequestId,
      offerId: approvalId,
      identity,
    });
    expect(client.snapshot().coverage).toContainEqual(
      expect.objectContaining({
        projectId: FIXTURE_PROJECT_ID,
        sessionId,
        provider: "gemini",
        state: "unavailable",
      }),
    );
    expect(client.selectPermission(item!.key)).toBe(true);
    expect(client.currentSelection()).toMatchObject({
      state: "held",
      actionable: false,
    });
    expect(client.selectedActivation()).toMatchObject({
      requestId: approvalId,
      turnRequestId,
      actionable: false,
    });
  } finally {
    client.dispose();
  }
});

test("Inbox route identity changes invalidate selection even when returning to the same route", async () => {
  const client = createInboxClient({
    heldOriginal: () => null,
    read: async () => approvalPage,
  });
  try {
    await client.refresh({
      home,
      homeCurrent: true,
      sessions: sessionsSource(),
    });
    const key = client.snapshot().items[0]!.key;
    client.syncRoute(desktopRoute("#/desktop/inbox?project=alpha"));
    expect(client.selectPermission(key)).toBe(true);
    expect(client.currentSelection()).not.toBeNull();
    client.syncRoute(desktopRoute("#/desktop/inbox?project=beta"));
    expect(client.currentSelection()).toBeNull();
    client.selectPermission(key);
    expect(client.currentSelection()).not.toBeNull();
    client.syncRoute(desktopRoute("#/desktop/inbox?project=alpha"));
    expect(client.currentSelection()).toBeNull();
  } finally {
    client.dispose();
  }
});

test("route observer invalidates A→B→A from each event URL when location already returned to A", async () => {
  const client = createInboxClient({
    heldOriginal: () => null,
    read: async () => approvalPage,
  });
  let currentHash = "#/desktop/inbox?project=alpha",
    listener = { changed: (_newUrl?: string) => {} };
  const stop = observeDesktopRoute(
    {
      hash: () => currentHash,
      listen: (changed) => {
        listener.changed = changed;
        return () => {
          listener.changed = () => {};
        };
      },
    },
    (nextRoute) => client.syncRoute(nextRoute),
  );
  try {
    await client.refresh({
      home,
      homeCurrent: true,
      sessions: sessionsSource(),
    });
    const key = client.snapshot().items[0]!.key;
    expect(client.selectPermission(key)).toBe(true);
    expect(client.currentSelection()).not.toBeNull();

    // The browser has already returned to A when both queued events arrive.
    currentHash = "#/desktop/inbox?project=alpha";
    listener.changed("http://127.0.0.1/#/desktop/inbox?project=beta");
    expect(client.currentSelection()).toBeNull();
    listener.changed("http://127.0.0.1/#/desktop/inbox?project=alpha");
    expect(client.currentSelection()).toBeNull();
    expect(client.selectPermission(key)).toBe(true);
    expect(client.currentSelection()).not.toBeNull();
  } finally {
    stop();
    client.dispose();
  }
});

test("Inbox maps a same-store held identity read failure to unavailable coverage", async () => {
  const client = createInboxClient({
    heldOriginal: () => {
      throw Error("private decision store is unreadable");
    },
    read: async () => approvalPage,
  });
  try {
    await client.refresh({
      home,
      homeCurrent: true,
      sessions: sessionsSource(),
    });
    expect(client.snapshot().items).toEqual([]);
    expect(client.snapshot().coverage).toContainEqual(
      expect.objectContaining({
        projectId: FIXTURE_PROJECT_ID,
        sessionId,
        provider: "gemini",
        state: "unavailable",
        reason:
          "The current protected approval or held decision could not be verified.",
      }),
    );
  } finally {
    client.dispose();
  }
});

test("Inbox serializes overlapping refresh reads, suppresses stale queues, and keeps the latest snapshot", async () => {
  const records = Array.from({ length: 9 }, (_, index) => ({
    ...record,
    id: `session-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }));
  let active = 0,
    peak = 0,
    calls = 0,
    announceFour: (() => void) | null = null;
  const firstFourStarted = new Promise<void>((resolve) => {
      announceFour = resolve;
    }),
    releases: Array<(value: unknown) => void> = [];
  const client = createInboxClient({
    heldOriginal: () => null,
    read: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 4) announceFour?.();
      try {
        return await new Promise((resolve) => releases.push(resolve));
      } finally {
        active--;
      }
    },
  });
  const sessions = {
    async refresh() {},
    project() {
      return { records, loaded: true, loading: false, error: "" };
    },
  };
  try {
    const obsolete = client.refresh({ home, homeCurrent: true, sessions });
    await firstFourStarted;
    const latest = client.refresh({ home: null, homeCurrent: false, sessions });
    await latest;
    const latestSnapshot = client.snapshot();
    expect(latestSnapshot).toMatchObject({ loading: false, items: [] });
    expect(latestSnapshot.coverage[0]?.state).toBe("unavailable");
    expect(calls).toBe(4);
    client.dispose();
    for (const release of releases)
      release({ pending: [approvalPage.pending[0]], receipt: null });
    await obsolete;
    expect(peak).toBe(4);
    expect(calls).toBe(4);
    expect(client.snapshot().items).toEqual([]);
  } finally {
    client.dispose();
  }
});

test("Two valid competing Inbox refresh pools share four read slots and only the latest publishes", async () => {
  const records = Array.from({ length: 9 }, (_, index) => ({
    ...record,
    id: `session-00000000-0000-4000-8000-${String(index + 21).padStart(12, "0")}`,
  }));
  let active = 0,
    peak = 0,
    calls = 0,
    announceFour: (() => void) | null = null;
  const firstFourStarted = new Promise<void>((resolve) => {
      announceFour = resolve;
    }),
    releases: Array<(value: unknown) => void> = [];
  const client = createInboxClient({
    heldOriginal: () => null,
    read: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 4) announceFour?.();
      try {
        if (calls <= 4)
          return await new Promise((resolve) => releases.push(resolve));
        return approvalPage;
      } finally {
        active--;
      }
    },
  });
  const sessions = {
    async refresh() {},
    project() {
      return { records, loaded: true, loading: false, error: "" };
    },
  };
  try {
    const obsolete = client.refresh({ home, homeCurrent: true, sessions });
    await firstFourStarted;
    const latest = client.refresh({ home, homeCurrent: true, sessions });
    const latestGeneration = client.snapshot().generation;
    for (const release of releases)
      release({ pending: [approvalPage.pending[0]], receipt: null });
    await Promise.all([obsolete, latest]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(calls).toBe(13);
    expect(client.snapshot()).toMatchObject({
      generation: latestGeneration,
      loading: false,
    });
    expect(client.snapshot().items).toHaveLength(9);
  } finally {
    client.dispose();
  }
});
