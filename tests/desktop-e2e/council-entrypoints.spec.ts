import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import type { ForgeState } from "../../scripts/forge/phases";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { seedCouncilProject } from "./council-fixtures";
import { alpha as fixtureAlpha } from "./project-fixtures";

const originals: Array<{ path: string; root: string; bytes: Buffer }> = [];
let project: ReturnType<typeof seedCouncilProject>;
let councilPosts: string[] = [];
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function assertInside(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw Error("Council fixture path escaped its owned root");
}
function writeOriginal(root: string, path: string, text: string) {
  assertInside(root, path);
  mkdirSync(resolve(path, ".."), { recursive: true });
  const bytes = Buffer.from(text, "utf8");
  writeFileSync(path, bytes, { flag: "wx" });
  originals.push({ path, root, bytes });
  return bytes;
}
function archiveRunFixture(slug: string, state: Buffer, artifact: Buffer) {
  const checkout = realpathSync.native(process.cwd());
  const root = join(checkout, ".tmp", "work", "council-entry-proof", slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${slug}.json`), state, { flag: "wx" });
  writeFileSync(join(root, `${slug}.md`), artifact, { flag: "wx" });
  writeFileSync(
    join(root, "sha256.json"),
    JSON.stringify({ state: hash(state), artifact: hash(artifact) }),
    { flag: "wx" },
  );
}
function seedRecordedResearch() {
  const checkout = realpathSync.native(process.cwd());
  const slug = `e2e-council-entry-${randomUUID()}`;
  const runRoot = resolve(checkout, ".tmp", "work", "forge-runs");
  const artifactRoot = resolve(checkout, "plans", "research");
  const statePath = resolve(runRoot, `${slug}.json`);
  const artifactPath = resolve(artifactRoot, `${slug}.md`);
  const state: ForgeState = {
    schemaVersion: 2,
    slug,
    feature: "Recorded Council entrypoint research",
    epic: "alpha-epic",
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: { research: `plans/research/${slug}.md` },
    mode: "gated",
    checkout,
    updatedAt: "2026-10-29T12:00:00.000Z",
    reviews: [],
  };
  const artifact =
    "Recorded research artifact for the Council source-entry fixture.\n";
  const stateBytes = writeOriginal(runRoot, statePath, JSON.stringify(state));
  const artifactBytes = writeOriginal(artifactRoot, artifactPath, artifact);
  archiveRunFixture(slug, stateBytes, artifactBytes);
  return { slug, artifactPath };
}
test.beforeEach(({ page }) => {
  originals.length = 0;
  councilPosts = [];
  project = seedCouncilProject();
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    state["alpha-council-first"] = {
      id: "alpha-council-first",
      title: "Council entry bead",
      issue_type: "task",
      status: "open",
      priority: 2,
      created_at: fixtureAlpha.createdAt,
      updated_at: fixtureAlpha.updatedAt,
      labels: ["project:alpha", "queue:approved", "complexity:low"],
      metadata: { queue_state: "approved" },
      description: "## Files\napps/desktop/**",
      dependencies: [
        {
          issue_id: "alpha-council-first",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
      ],
    };
    writeState(BD_STAND_IN_STATE, state);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.includes("/council/"))
      councilPosts.push(url.pathname);
  });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const owned of originals.splice(0)) {
    assertInside(realpathSync.native(process.cwd()), owned.path);
    assertInside(realpathSync.native(owned.root), owned.path);
    if (existsSync(owned.path)) {
      const stat = lstatSync(owned.path);
      const bytes = readFileSync(owned.path);
      expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
      expect(hash(bytes)).toBe(hash(owned.bytes));
      expect(bytes.equals(owned.bytes)).toBe(true);
      unlinkSync(owned.path);
    }
    expect(existsSync(owned.path)).toBe(false);
  }
  expect(councilPosts).toEqual([]);
});

test("approved Workbench bead opens the exact Council source without posting", async ({
  page,
}) => {
  await openSettled(
    page,
    `/index.html#/desktop/project/${project.id}/workbench`,
  );
  const card = page.locator('[data-bead="alpha-council-first"]');
  await expect(card).toBeVisible();
  await card
    .getByRole("button", { name: "Review bead in Council", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${project.id}/reviews$`),
  );
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(
    "alpha-council-first",
  );
  expect(councilPosts).toEqual([]);
});

test("verified recorded research artifact opens a Council source draft without posting", async ({
  page,
}) => {
  const run = seedRecordedResearch();
  await openSettled(page, `/index.html${runsHref(project.id, run.slug)}`);
  const detail = page.getByRole("article", { name: "Selected forge run" });
  await expect(
    detail.getByRole("heading", {
      name: "Recorded Council entrypoint research",
      exact: true,
    }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "Read research artifact", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Verified run artifact" }),
  ).toContainText(
    "Recorded research artifact for the Council source-entry fixture.",
  );
  await detail
    .getByRole("button", {
      name: "Review research artifact in Council",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${project.id}/reviews$`),
  );
  await expect(page.getByLabel("Source type")).toHaveValue("file");
  await expect(page.getByLabel("Workspace-relative file")).toHaveValue(
    `plans/research/${run.slug}.md`,
  );
  await expect(
    page.getByText(
      "This opens a draft from the recorded artifact; it does not complete or change a checkpoint.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(councilPosts).toEqual([]);
});
