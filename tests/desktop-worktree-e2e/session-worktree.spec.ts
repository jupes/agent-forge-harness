import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { workspaceKey } from "../../scripts/projects/scope";
import { FIXTURE_PROJECT_ID } from "../../scripts/projects/testing";
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
      (call) =>
        call.args[0] === "worktree" &&
        call.args[1] === "add" &&
        call.args[3] === "feat/browser-created",
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
