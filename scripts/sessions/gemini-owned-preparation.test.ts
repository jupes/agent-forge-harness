import { expect, test } from "bun:test";
import type { GeminiTaskStartRequest } from "../../types/gemini-owned-task";
import type { PreparedGeminiTask } from "../../types/gemini-task-runtime";
import {
  geminiTaskLaunchFromStart,
  prepareReviewedGeminiTask,
} from "./gemini-owned-preparation";
import { serializeGeminiTask } from "./gemini-task";

const project = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const request = {
  provider: "gemini",
  smith: "gemini-example",
  repository: "/fixture",
  worktree: "/fixture/tree",
  beadId: "alpha-1",
  about: [
    { kind: "bead", id: "alpha-1" },
    { kind: "session", id: "selected-session" },
  ],
  launch: {
    route: "gemini-cli",
    mode: "task",
    prompt: "Exact private prompt 🌱\n",
    attachments: [{ kind: "text", name: "note", text: "@private context" }],
  },
} satisfies Omit<GeminiTaskStartRequest, "requestId">;
function snapshot(
  launch: ReturnType<typeof geminiTaskLaunchFromStart>,
): PreparedGeminiTask {
  return {
    version: 1,
    provider: "gemini",
    smith: request.smith,
    canonicalRoot: "/fixture",
    canonicalCwd: "/fixture/tree",
    command: ["/native/gemini"],
    paths: ["/fixture", "/fixture/tree"],
    launch,
    capabilities: { version: "0.65.0", flags: ["--output-format"] },
  };
}

test("reviewed owned Gemini preparation preserves exact selected scope/about and private native defaults", async () => {
  const launch = geminiTaskLaunchFromStart(project, request),
    input = { smith: request.smith, launch };
  expect(launch).toEqual({
    ...request.launch,
    cwd: request.worktree,
    context: {
      projectId: project,
      repository: request.repository,
      worktree: request.worktree,
      beadId: request.beadId,
      about: request.about,
    },
  });
  const prepared = await prepareReviewedGeminiTask(
    { prepare: async (selected) => snapshot(selected.launch) },
    input,
  );
  expect(prepared.launch).toEqual(launch);
  const serialized = serializeGeminiTask(
    prepared.launch,
    prepared.capabilities,
  );
  expect(serialized.argv).toEqual(["--output-format", "stream-json"]);
  expect(serialized.stdin).toContain(
    '"about":[{"kind":"bead","id":"alpha-1"},{"kind":"session","id":"selected-session"}]',
  );
  expect(serialized.stdin).toContain("\\u0040private context");
  expect(serialized.equivalentCommand).not.toContain(request.launch.prompt);
  expect(prepared.launch).not.toHaveProperty("effort");
});

test("a changed, unsupported or failed Gemini preparation cannot replace reviewed private intent", async () => {
  const launch = geminiTaskLaunchFromStart(project, request),
    input = { smith: request.smith, launch };
  for (const change of ["prompt", "smith", "scope", "about", "capability"])
    await expect(
      prepareReviewedGeminiTask(
        {
          prepare: async (selected) => {
            const value = snapshot(selected.launch);
            if (change === "prompt") value.launch.prompt = "Changed prompt";
            if (change === "smith") value.smith = "gemini-other";
            if (change === "scope") value.launch.cwd = "/other";
            if (change === "about" && value.launch.context)
              value.launch.context.about = [];
            if (change === "capability")
              value.capabilities = { version: "0.65.0", flags: [] };
            return value;
          },
        },
        input,
      ),
    ).rejects.toThrow("prepared");
  await expect(
    prepareReviewedGeminiTask(
      {
        prepare: async () => {
          throw Error("Synthetic native probe refusal");
        },
      },
      input,
    ),
  ).rejects.toThrow("unavailable");
  expect(input.launch.prompt).toBe(request.launch.prompt);
  expect(input.launch.context?.about).toEqual(request.about);
});
