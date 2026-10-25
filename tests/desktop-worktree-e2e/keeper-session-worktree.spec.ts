import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { projectFixture } from "../../scripts/projects/testing";
import { sessionWorktreeReceiptSchema } from "../../scripts/sessions/worktree-protocol";
import type { SessionWorktreeReceipt } from "../../types/session-worktrees";
import { withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE, bunPath, HEARTH_HOME } from "../e2e/servers";
import { CALLS, fixturePlan } from "./environment";

test("a real worktree confirmed during a protected Keeper read remains selectable after the read and Cancel", async ({
  page,
}) => {
  const plan = fixturePlan(),
    repository = resolveCheckout(plan.root).workspace,
    project = projectFixture(repository),
    branch = "feat/keeper-pending";
  const providerStarts = () => {
    const file = join(HEARTH_HOME, "coding-fixture-starts.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
      : 0;
  };
  const beforeStarts = providerStarts();
  withStateLock(BD_STAND_IN_STATE, () =>
    writeState(BD_STAND_IN_STATE, {
      "alpha-epic": {
        id: "alpha-epic",
        title: "Keeper worktree fixture epic",
        issue_type: "epic",
        status: "open",
        priority: 2,
        labels: ["project:alpha"],
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      },
    }),
  );
  const seeded = spawnSync(
    bunPath(),
    [
      "-e",
      `import { randomUUID } from "node:crypto";
      import { createConversationStore } from "./scripts/conversations/store";
      const store=createConversationStore(process.env.AGENT_FORGE_HOME), id=process.argv[1], repository=process.argv[2], requestId=randomUUID(), owner=randomUUID();
      await store.accept(id,{requestId,expectedRevision:0,text:"Recorded worktree fixture question",about:[]});
      await store.start(id,requestId,owner);
      await store.append(id,requestId,owner,{kind:"identity",provider:"claude",sessionId:randomUUID(),version:"recorded-fixture"});
      await store.append(id,requestId,owner,{kind:"text",text:JSON.stringify({kind:"keeper.proposals.v1",message:"Review before Start",proposals:[{title:"Review a pending worktree",detail:"Retain a real explicit creation across a protected read",action:{kind:"start-session",provider:"claude",smith:"claude-journeyman",beadId:"alpha-epic",repository,worktree:"new",prompt:"Investigate the proposed bead"}}]})});
      await store.finish(id,requestId,owner,"completed",null);`,
      project.id,
      repository,
    ],
    {
      env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  if (seeded.status !== 0)
    throw new Error(`Private worktree fixture failed: ${seeded.stderr}`);
  let releaseCreate = () => {},
    releaseRead = () => {};
  const observed: { created: SessionWorktreeReceipt | null } = {
    created: null,
  };
  const createHeld = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    }),
    readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/sessions(?:\/|$)|\/keeper\/proposals\//.test(
        new URL(request.url()).pathname,
      )
    )
      writes.push(new URL(request.url()).pathname);
  });
  try {
    await openSettled(
      page,
      `/index.html#/desktop/project/${project.id}/keeper`,
    );
    const opener = page.getByRole("button", {
        name: "Review & start",
        exact: true,
      }),
      dialog = page.getByRole("dialog", {
        name: "Review Keeper session · Alpha",
        exact: true,
      }),
      prompt = dialog.getByRole("textbox", { name: "Session prompt" });
    await opener.click();
    await expect(prompt).toBeEditable();
    await dialog
      .getByRole("combobox", { name: "Session effort" })
      .selectOption("");
    await dialog
      .getByRole("textbox", { name: "New session worktree base ref" })
      .fill(plan.base);
    await dialog
      .getByRole("textbox", { name: "New session worktree branch" })
      .fill(branch);
    await page.route(
      `**/projects/${project.id}/session-worktrees`,
      async (route) => {
        const response = await route.fetch({
          headers: {
            ...(await route.request().allHeaders()),
            Origin: new URL(route.request().url()).origin,
            "Sec-Fetch-Site": "same-origin",
          },
        });
        const raw: unknown = await response.json();
        if (
          !raw ||
          typeof raw !== "object" ||
          !("ok" in raw) ||
          raw.ok !== true ||
          !("data" in raw)
        )
          throw new Error("Missing real worktree response.");
        observed.created = sessionWorktreeReceiptSchema.parse(raw.data);
        await createHeld;
        await route.fulfill({ response });
      },
    );
    await dialog
      .getByRole("button", { name: "Create worktree", exact: true })
      .click();
    await expect.poll(() => observed.created?.state).toBe("created");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    let heldRead = false;
    await page.route(
      `**/projects/${project.id}/keeper/proposals/*/session-start*`,
      async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        heldRead = true;
        await readHeld;
        await route.continue();
      },
    );
    await opener.click();
    await expect.poll(() => heldRead).toBe(true);
    await expect(prompt).not.toBeEditable();
    releaseCreate();
    await expect(
      dialog.getByText(
        "Worktree created. Review its path before checking session options.",
        { exact: true },
      ),
    ).toBeVisible();
    releaseRead();
    await expect(prompt).toBeEditable();
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect(
      dialog.getByRole("region", { name: "Equivalent session command" }),
    ).toContainText("--model");
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await opener.click();
    await expect(prompt).toBeEditable();
    await dialog
      .getByRole("button", { name: "Check supported options", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    if (!observed.created?.worktree)
      throw new Error("Missing real created worktree.");
    expect(
      readFileSync(join(observed.created.worktree.path, "README.md"), "utf8"),
    ).toContain("Temporary session worktree browser fixture");
    expect(
      readFileSync(
        join(plan.root, ".git", "refs", "heads", branch),
        "utf8",
      ).trim(),
    ).toBe(plan.base);
    const calls = readFileSync(CALLS, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { args: string[] };
        } catch {
          throw new Error("Invalid fixture Git call.");
        }
      });
    expect(
      calls.filter(
        (call) =>
          call.args[0] === "worktree" &&
          call.args[1] === "add" &&
          call.args[3] === branch,
      ),
    ).toHaveLength(1);
    expect(
      writes.filter((path) => !path.endsWith("/sessions/preview")),
    ).toEqual([]);
    expect(providerStarts()).toBe(beforeStarts);
  } finally {
    releaseCreate();
    releaseRead();
    await page.unrouteAll({ behavior: "wait" });
  }
});
