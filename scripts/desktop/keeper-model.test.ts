import { expect, test } from "bun:test";
import { KeeperMarkdown } from "../../apps/desktop/src/KeeperMarkdown";
import {
  keeperContext,
  keeperTurns,
} from "../../apps/desktop/src/keeper-model";
import type { ConversationPage } from "../../types/conversation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

test("reply Markdown renders tables/code/lists while hostile HTML, images and non-web links stay inert", () => {
  const view = KeeperMarkdown({
    text: "# Heading\n- first\n- **second**\n\n| Bead | Status |\n| --- | --- |\n| `alpha` | Open |\n\n```js\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>\n[unsafe](javascript:alert) ![image](data:bad)\n[safe](https://example.com/read)",
  });
  expect(findAll(view, "table")).toHaveLength(1);
  expect(findAll(view, "li")).toHaveLength(2);
  expect(findAll(view, "script")).toEqual([]);
  expect(findAll(view, "img")).toEqual([]);
  expect(findAll(view, "a").map((node) => attrs(node).href)).toEqual([
    "https://example.com/read",
  ]);
  expect(textOf(view)).toContain("<script>alert(1)</script>");
  expect(textOf(view)).toContain("javascript:alert");
});

test("ordered lists and quotes retain structure, while image URLs remain inert text", () => {
  const view = KeeperMarkdown({
    text: "1. First\n2. Second\n> Quoted source\n![image](https://example.com/pixel.png)",
  });
  expect(findAll(view, "ol")).toHaveLength(1);
  expect(findAll(view, "blockquote").map(textOf)).toEqual(["Quoted source"]);
  expect(findAll(view, "img")).toEqual([]);
  expect(findAll(view, "a")).toEqual([]);
});

const page: ConversationPage = {
  version: 1,
  projectId: "fixture",
  conversationId: "keeper-fixture",
  revision: 0,
  binding: null,
  frames: [],
  turns: [],
  more: false,
  nextCursor: 0,
  lastSequence: 0,
  request: null,
  controllable: false,
};
test("missing context is unknown and reported near-full occupancy retains its source", () => {
  expect(keeperContext(page)).toMatchObject({
    percent: null,
    nearlyFull: false,
  });
  const state: ConversationPage = {
    ...page,
    binding: { provider: "claude", sessionId: "fixture", version: "fixture" },
    frames: [
      {
        seq: 1,
        turnId: "fixture",
        at: "2026-10-22T00:00:00Z",
        event: {
          kind: "identity",
          provider: "claude",
          sessionId: "fixture",
          version: "fixture",
        },
      },
      {
        seq: 2,
        turnId: "fixture",
        at: "2026-10-22T00:00:00Z",
        event: {
          kind: "context",
          used: 90,
          capacity: 100,
          basis: "reported",
          source: "Reported fixture occupancy",
          asOf: "2026-10-22T00:00:00Z",
        },
      },
    ],
  };
  expect(keeperContext(state)).toMatchObject({
    percent: 90,
    nearlyFull: true,
    label: "Context 90%",
  });
  expect(keeperContext(state).detail).toContain("Reported fixture");
  expect(
    keeperTurns({
      ...state,
      frames: [
        ...state.frames,
        {
          seq: 3,
          turnId: "fixture",
          at: "2026-10-22T00:00:00Z",
          event: { kind: "text", text: "A" },
        },
        {
          seq: 4,
          turnId: "fixture",
          at: "2026-10-22T00:00:00Z",
          event: { kind: "text", text: "🌱" },
        },
      ],
    })[0]?.reply,
  ).toBe("A🌱");
});

test("a resumed smith switch cannot resurrect context from before a native identity reset", () => {
  const at = "2026-10-22T00:00:00.000Z";
  const oldBinding = {
    provider: "claude" as const,
    sessionId: "a73dbf8f-4cc6-43a0-a25d-77aec09cb21a",
    version: "fixture",
  };
  const binding = {
    ...oldBinding,
    sessionId: "e2178359-6083-4445-9944-be1e273d3f44",
  };
  const state: ConversationPage = {
    ...page,
    binding,
    frames: [
      { seq: 1, turnId: "old", at, event: { kind: "identity", ...oldBinding } },
      {
        seq: 2,
        turnId: "old",
        at,
        event: {
          kind: "context",
          used: 90,
          capacity: 100,
          basis: "reported",
          source: "Prior native conversation",
          asOf: at,
        },
      },
      { seq: 3, turnId: "new", at, event: { kind: "identity", ...binding } },
    ],
    keeperRecovery: {
      smith: "other-claude",
      generation: 2,
      continuation: {
        requestId: "ee8e318b-2cfd-4c24-8e0e-ef80da796b7e",
        expectedRevision: 4,
        mode: "switch",
        smith: "other-claude",
        summary: "",
        hash: "a".repeat(64),
        revision: 5,
        generation: 2,
        sourceSequence: 3,
        at,
        previousBinding: binding,
        resumed: true,
      },
    },
  };
  expect(keeperContext(state)).toMatchObject({
    percent: null,
    nearlyFull: false,
    label: "Context unknown",
  });
  state.frames.push({
    seq: 4,
    turnId: "new",
    at,
    event: {
      kind: "context",
      used: 20,
      capacity: 100,
      basis: "reported",
      source: "Current native conversation",
      asOf: at,
    },
  });
  expect(keeperContext(state)).toMatchObject({ percent: 20 });
  expect(keeperContext(state).detail).toContain("Current native conversation");
  expect(keeperContext({ ...state, binding: null })).toMatchObject({
    percent: null,
    nearlyFull: false,
  });
});
