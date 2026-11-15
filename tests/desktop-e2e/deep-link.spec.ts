import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { desktopRoute } from "../../apps/desktop/src/navigation";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { seedObservationEvents } from "./observed-session-fixtures";
import {
  alpha,
  beta,
  catalog,
  catalogFile,
  seedProjects,
  workspace,
} from "./project-fixtures";

const generation = "hosted-deep-link-fixture";
let sequence = 0;
test.beforeEach(() => {
  sequence = 0;
  seedProjects();
});
function starts() {
  return ["coding-fixture-starts.jsonl", "keeper-fixture-starts.jsonl"].map(
    (name) => {
      const path = join(HEARTH_HOME, name);
      return existsSync(path)
        ? readFileSync(path, "utf8").split("\n").filter(Boolean).length
        : 0;
    },
  );
}
function mutations(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      path.startsWith("/__agent-forge/projects/")
    )
      paths.push(path);
  });
  return paths;
}
async function activate(page: Page, uri: string) {
  const data = { version: 1, generation, sequence: ++sequence, uri };
  await page.evaluate(
    (detail) =>
      window.dispatchEvent(
        new CustomEvent("agent-forge-deep-link", { detail }),
      ),
    data,
  );
}
const selected = (page: Page) => desktopRoute(new URL(page.url()).hash);

test("cold delivery waits for the connected catalog and opens the actual project without a write", async ({
  page,
}) => {
  const before = starts(),
    posts = mutations(page);
  await page.addInitScript(
    (value) => {
      window.__AGENT_FORGE_DEEP_LINK__ = value;
    },
    {
      version: 1,
      generation,
      sequence: ++sequence,
      uri: "agent-forge://project/" + encodeURIComponent(alpha.id),
    },
  );
  await openSettled(page, "/index.html#/desktop/projects");
  await expect
    .poll(() => selected(page))
    .toEqual({ destination: "overview", projectId: alpha.id, selection: null });
  const notice = page.getByRole("region", { name: "Forge link", exact: true });
  await expect(notice).toContainText("Opened the linked project.");
  await expect(notice).toBeFocused();
  const presentation = await notice.evaluate((element) => ({
    outline: getComputedStyle(element).outlineWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(presentation).toEqual({ outline: "2px", overflow: false });
  expect(posts).toEqual([]);
  expect(starts()).toEqual(before);
});

test("warm bead and session activation uses canonical owners and never starts a turn", async ({
  page,
}) => {
  const sessionId = "deep-link-observed-" + randomUUID();
  seedObservationEvents([
    {
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      sessionId,
      executor: {
        provider: "codex",
        model: "fixture-model",
        smith: "fixture-smith",
      },
      payload: { kind: "interactive" },
    },
  ]);
  const before = starts(),
    posts = mutations(page);
  await openSettled(page, "/index.html#/desktop/projects");
  await activate(page, "agent-forge://bead/alpha-epic");
  await expect
    .poll(() => selected(page))
    .toEqual({
      destination: "beads",
      projectId: alpha.id,
      selection: { kind: "bead", id: "alpha-epic" },
    });
  await activate(
    page,
    "agent-forge://session/" + encodeURIComponent(sessionId),
  );
  await expect
    .poll(() => selected(page))
    .toEqual({
      destination: "sessions",
      projectId: alpha.id,
      selection: { kind: "session", id: sessionId },
    });
  await expect(
    page.getByRole("region", { name: "Observed session details", exact: true }),
  ).toContainText(sessionId);
  await activate(
    page,
    "agent-forge://session/" + encodeURIComponent(sessionId),
  );
  await expect(
    page.getByRole("region", { name: "Forge link", exact: true }),
  ).toContainText("Opened the linked session.");
  expect(posts).toEqual([]);
  expect(starts()).toEqual(before);
});

test("invalid, missing and archived targets provide keyboard recovery without granting link fields", async ({
  page,
}) => {
  const before = starts(),
    posts = mutations(page);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/projects");
  const notice = page.getByRole("region", { name: "Forge link", exact: true });
  await activate(
    page,
    "agent-forge://project/" + alpha.id + "?operator=private-link-marker",
  );
  await expect(notice).toContainText("This Forge link is invalid.");
  await expect(
    page.getByText("private-link-marker", { exact: false }),
  ).toHaveCount(0);
  expect(selected(page).destination).toBe("projects");
  await activate(page, "agent-forge://bead/absent-object");
  await expect(notice).toContainText(
    "This item is not available in the connected project catalog.",
  );
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...catalog,
      revision: 2,
      projects: [{ ...alpha, archived: true }, beta],
    }),
  );
  await activate(page, "agent-forge://project/" + alpha.id);
  await expect(notice).toContainText(
    "This item belongs to an archived project.",
  );
  const recover = notice.getByRole("button", {
    name: "Open Projects",
    exact: true,
  });
  await recover.focus();
  await expect(recover).toBeFocused();
  expect(
    await recover.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  await page.keyboard.press("Enter");
  await expect(notice).toHaveCount(0);
  expect(selected(page).destination).toBe("projects");
  expect(posts).toEqual([]);
  expect(starts()).toEqual(before);
});

test("canonical ownership in two projects offers recovery instead of choosing the first", async ({
  page,
}) => {
  const sharedBeta = {
    ...beta,
    workspaces: [
      {
        root: workspace,
        repositories: [workspace],
        epicIds: ["beta-epic", "alpha-epic"],
      },
    ],
  };
  writeFileSync(
    catalogFile,
    JSON.stringify({ ...catalog, revision: 2, projects: [alpha, sharedBeta] }),
  );
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    const shared = state["alpha-epic"];
    if (!shared) throw Error("Missing scoped shared bead fixture");
    shared.labels = ["project:alpha", "project:beta"];
    writeState(BD_STAND_IN_STATE, state);
  });
  const before = starts(),
    posts = mutations(page);
  await openSettled(page, "/index.html#/desktop/projects");
  await activate(page, "agent-forge://bead/alpha-epic");
  await expect(
    page.getByRole("region", { name: "Forge link", exact: true }),
  ).toContainText("This item belongs to more than one project.");
  expect(selected(page).destination).toBe("projects");
  expect(posts).toEqual([]);
  expect(starts()).toEqual(before);
});
