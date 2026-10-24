import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { workspaceKey } from "../../scripts/projects/scope";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
import { ownedCodingStateSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingSessionSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { sessionWorktreeReceiptSchema } from "../../scripts/sessions/worktree-protocol";
import type { ConversationState } from "../../types/conversation";
import type { OwnedSessionRecord } from "../../types/owned-session";
import type { SessionWorktreeReceipt } from "../../types/session-worktrees";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { CALLS, fixturePlan } from "./environment";

test("a lost explicit creation is reconciled once before Preview and Start run in the actual new branch and directory", async ({
  page,
}) => {
  const plan = fixturePlan(),
    bodies: string[] = [];
  const observed: { created: SessionWorktreeReceipt | null } = {
    created: null,
  };
  await openSettled(
    page,
    `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/sessions`,
  );
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await expect(
    dialog.getByRole("combobox", { name: "Session smith" }),
  ).toHaveValue("claude-journeyman");
  await dialog
    .getByRole("textbox", { name: "Session prompt" })
    .fill("Only start after the new worktree is confirmed");
  await dialog
    .getByRole("combobox", { name: "Session effort" })
    .selectOption("");
  await dialog
    .getByRole("combobox", { name: "Where the session runs" })
    .selectOption("new");
  await dialog
    .getByRole("textbox", { name: "New session worktree base ref" })
    .fill(plan.base);
  await dialog
    .getByRole("textbox", { name: "New session worktree branch" })
    .fill("feat/browser-created");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await page.route(
    `**/projects/${FIXTURE_PROJECT_ID}/session-worktrees`,
    async (route) => {
      bodies.push(route.request().postData() ?? "");
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new Error("The real worktree endpoint did not answer JSON.");
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        !("ok" in raw) ||
        raw.ok !== true ||
        !("data" in raw)
      )
        throw new Error("The real worktree creation was refused.");
      const parsed = sessionWorktreeReceiptSchema.safeParse(raw.data);
      if (!parsed.success)
        throw new Error("The real worktree receipt was invalid.");
      observed.created = parsed.data;
      await route.abort("failed");
    },
  );
  await dialog
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Check original worktree",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  // Explicit retry carries the original UUID and body; the server reconciles,
  // rather than executing the Git worktree add again.
  await dialog
    .getByRole("button", { name: "Retry original worktree", exact: true })
    .click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toBe(bodies[0]);
  await dialog
    .getByRole("button", { name: "Check original worktree", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Worktree created. Review its path before checking session options.",
      { exact: true },
    ),
  ).toBeVisible();
  if (
    !observed.created ||
    observed.created.state !== "created" ||
    !observed.created.worktree
  )
    throw new Error("The isolated real Git worktree was not created.");
  const confirmed = observed.created as SessionWorktreeReceipt & {
    worktree: NonNullable<SessionWorktreeReceipt["worktree"]>;
  };
  expect(confirmed.resolvedCommit).toBe(plan.base);
  const calls = readFileSync(CALLS, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as { cwd: string; args: string[] };
      } catch {
        throw new Error("Invalid fixture Git call");
      }
    });
  expect(
    calls.filter(
      (call) => call.args[0] === "worktree" && call.args[1] === "add",
    ),
  ).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Equivalent session command" }),
  ).toContainText("--model");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Coding reply 🌱");
  let registry: { records: OwnedSessionRecord[] },
    input: { argv: string[]; cwd: string; id: string };
  try {
    registry = JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    );
    input = JSON.parse(
      readFileSync(join(HEARTH_HOME, "coding-fixture-record.json"), "utf8"),
    );
  } catch {
    throw new Error("The private session fixture receipts are unavailable.");
  }
  expect(registry.records).toHaveLength(1);
  const session = registry.records[0];
  if (!session) throw new Error("Missing owned session");
  expect(workspaceKey(input.cwd)).toBe(workspaceKey(confirmed.worktree.path));
  expect(workspaceKey(session.worktree)).toBe(
    workspaceKey(confirmed.worktree.path),
  );
  const gitBranches = readFileSync(
    join(plan.root, ".git", "refs", "heads", "feat", "browser-created"),
    "utf8",
  ).trim();
  expect(gitBranches).toBe(plan.base);
  expect(
    readFileSync(join(confirmed.worktree.path, "README.md"), "utf8"),
  ).toContain("Temporary session worktree browser fixture");
  expect(
    readFileSync(join(HEARTH_HOME, "coding-fixture-starts.jsonl"), "utf8")
      .trim()
      .split("\n"),
  ).toHaveLength(1);
  await expect
    .poll(() => {
      try {
        const journal: ConversationState = JSON.parse(
          readFileSync(
            join(HEARTH_HOME, "conversations", `${session.id}.json`),
            "utf8",
          ),
        );
        return journal.turns.at(-1)?.phase;
      } catch {
        return "unavailable";
      }
    })
    .toBe("completed");
});

test("an explicit Codex Task runs only in its confirmed new worktree and keeps the actual provider identity private", async ({
  page,
}) => {
  const plan = fixturePlan();
  await openSettled(
    page,
    `/index.html#/desktop/project/${FIXTURE_PROJECT_ID}/sessions`,
  );
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await dialog.getByRole("button", { name: /Cx · Codex/ }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  const prompt = "PRIVATE Codex new-worktree task";
  await dialog
    .getByRole("textbox", { name: "Session prompt", exact: true })
    .fill(prompt);
  await dialog
    .getByRole("combobox", { name: "Session effort", exact: true })
    .selectOption("");
  await dialog
    .getByRole("combobox", { name: "Where the session runs", exact: true })
    .selectOption("new");
  await dialog
    .getByRole("textbox", {
      name: "New session worktree base ref",
      exact: true,
    })
    .fill(plan.base);
  await dialog
    .getByRole("textbox", { name: "New session worktree branch", exact: true })
    .fill("feat/browser-codex-task");
  await expect(
    dialog.getByRole("button", { name: "Start", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Worktree created. Review its path before checking session options.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Check supported options", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", {
      name: "Equivalent session command",
      exact: true,
    }),
  ).toContainText("--sandbox");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Session reply", exact: true }),
  ).toContainText("Codex Task reply 🌱");
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(HEARTH_HOME, "sessions", "registry.json"), "utf8"),
    );
  } catch {
    throw Error("Missing isolated registry.");
  }
  if (!raw || typeof raw !== "object" || !("records" in raw))
    throw Error("Invalid isolated registry.");
  const record = ownedCodingSessionSchema
    .array()
    .parse(raw.records)
    .find((item) => item.provider === "codex");
  if (!record) throw Error("Missing explicit Codex Task.");
  const log = readFileSync(
    join(HEARTH_HOME, "codex-fixture-calls.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as {
          kind: string;
          cwd: string;
          argv: string[];
          stdin: string;
          id: string;
        };
      } catch {
        throw Error("Invalid native fixture recording.");
      }
    });
  const native = log.filter((call) => call.kind === "task");
  expect(native).toHaveLength(1);
  const actual = native[0];
  if (!actual) throw Error("Missing native Task process.");
  expect(workspaceKey(realpathSync.native(actual.cwd))).toBe(
    workspaceKey(realpathSync.native(record.worktree)),
  );
  expect(workspaceKey(record.worktree)).not.toBe(workspaceKey(plan.root));
  expect(actual.stdin).toContain(prompt);
  expect(actual.argv.join(" ")).not.toContain(prompt);
  expect(actual.argv).toContain(record.worktree);
  expect(
    readFileSync(
      join(plan.root, ".git", "refs", "heads", "feat", "browser-codex-task"),
      "utf8",
    ).trim(),
  ).toBe(plan.base);
  expect(readFileSync(join(record.worktree, "README.md"), "utf8")).toContain(
    "Temporary session worktree browser fixture",
  );
  const saved = () => {
    try {
      return ownedCodingStateSchema.parse(
        JSON.parse(
          readFileSync(
            join(HEARTH_HOME, "conversations", `${record.id}.json`),
            "utf8",
          ),
        ),
      );
    } catch {
      throw Error("Missing private Task journal.");
    }
  };
  await expect.poll(() => saved().turns[0]?.phase).toBe("completed");
  expect(saved().binding?.sessionId).toBe(actual.id);
  expect(saved().frames.some((frame) => frame.event.kind === "model")).toBe(
    false,
  );
});
