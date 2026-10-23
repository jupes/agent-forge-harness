import { expect, test } from "bun:test";
import {
  chooseSessionSmith,
  newSessionDraft,
  sessionAttachments,
  sessionStartBody,
} from "../../apps/desktop/src/session-composer";

test("smith defaults retain unsupported effort until the user explicitly selects CLI default, and Chat omits Task-only limits", () => {
  const selected = chooseSessionSmith(newSessionDraft(), {
    name: "configured",
    provider: "claude",
    model: "full-model",
    effort: "future-effort",
    enabled: true,
    tags: [],
  });
  expect(selected.effort).toBe("future-effort");
  const draft = {
    ...selected,
    prompt: "  Exact prompt\n",
    repository: "/repo",
    worktree: "/repo",
    outputSchema: "not JSON",
    maxBudgetUsd: "2.50",
  };
  expect(() => sessionStartBody(draft)).toThrow(/explicitly choose/i);
  const body = sessionStartBody({ ...draft, effort: "" });
  expect(body.smith).toBe("configured");
  expect(body.launch.prompt).toBe("  Exact prompt\n");
  expect(body.launch.effort).toBeUndefined();
  expect(body.launch.maxBudgetUsd).toBeUndefined();
  expect(body.launch.outputSchema).toBeUndefined();
  expect(() =>
    sessionStartBody({ ...draft, effort: "", mode: "task" }),
  ).toThrow("JSON object");
});

test("selected text and image files remain exact inline input and binary or oversized attachments refuse", async () => {
  const text = new File(["  Exact text 🌱\n"], "notes.txt", {
      type: "text/plain",
    }),
    image = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      "tiny.png",
      { type: "image/png" },
    );
  expect(await sessionAttachments([text, image])).toEqual([
    { kind: "text", name: "notes.txt", text: "  Exact text 🌱\n" },
    {
      kind: "image",
      name: "tiny.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    },
  ]);
  await expect(
    sessionAttachments([new File([new Uint8Array([0, 255])], "binary.bin")]),
  ).rejects.toThrow("UTF-8");
  await expect(
    sessionAttachments([new File([new Uint8Array(1_000_001)], "large.txt")]),
  ).rejects.toThrow("1 MB");
});
