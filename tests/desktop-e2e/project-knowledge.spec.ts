import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  canonicalKnowledgeRefresh,
  type KnowledgeReceipt,
  knowledgeRefreshRequestSchema,
} from "../../scripts/projects/knowledge-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { alpha, catalog, catalogFile, seedProjects } from "./project-fixtures";

test("knowledge controls show canonical age and recover a controlled lost refresh through the exact read-only original", async ({
  page,
}) => {
  seedProjects();
  const id = `project-${randomUUID()}`;
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...catalog,
      projects: catalog.projects.map((project) =>
        project.id === alpha.id ? { ...project, id } : project,
      ),
    }),
  );
  const path = `/__agent-forge/projects/${id}/settings/knowledge`,
    repositoryKey = "a".repeat(64);
  let refreshes = 0,
    receiptReads = 0,
    original: KnowledgeReceipt | null = null;
  await page.route(`**${path}**`, async (route) => {
    try {
      const url = new URL(route.request().url()),
        method = route.request().method();
      if (method === "POST" && url.pathname === path) {
        const request = knowledgeRefreshRequestSchema.parse(
          route.request().postDataJSON(),
        );
        refreshes++;
        original = {
          projectId: id,
          requestId: request.requestId,
          requestHash: createHash("sha256")
            .update(canonicalKnowledgeRefresh(id, request))
            .digest("hex"),
          repositoryKey,
          state: "confirmed",
          sourceCommit: "b".repeat(40),
          evidenceHash: "c".repeat(64),
          candidateHash: "d".repeat(64),
          confirmedAt: new Date().toISOString(),
          message: "Controlled candidate bytes are present.",
          retainedExtensions: ["overview.upstream"],
        };
        await route.abort("failed");
        return;
      }
      if (
        method === "GET" &&
        original &&
        url.pathname === path + "/" + original.requestId
      ) {
        receiptReads++;
        await route.fulfill({
          status: 200,
          json: { ok: true, data: original, error: null },
        });
        return;
      }
      if (method === "GET" && url.pathname === path) {
        await route.fulfill({
          status: 200,
          json: {
            ok: true,
            data: {
              projectId: id,
              catalogRevision: 1,
              repositoryKey,
              name: "controlled-fixture",
              state: "present",
              ageDays: original ? 0 : 31,
              freshness: original ? "current" : "stale",
              asOf: new Date().toISOString(),
              archived: false,
            },
            error: null,
          },
        });
        return;
      }
      throw Error("Unexpected knowledge fixture operation");
    } catch (error) {
      await route.abort("failed").catch(() => {});
      throw error;
    }
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${id}/project-settings`,
  );
  const section = page.getByRole("region", {
      name: "Repository knowledge",
      exact: true,
    }),
    refresh = section.getByRole("button", {
      name: "Refresh knowledge",
      exact: true,
    });
  await expect(section).toContainText("stale · 31 days old");
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(section).toContainText("outcome is unconfirmed");
  await expect(refresh).toBeDisabled();
  expect(refreshes).toBe(1);
  await reloadSettled(page);
  await expect(section).toContainText("Retained refresh original");
  await section
    .getByRole("button", {
      name: "Check original knowledge refresh",
      exact: true,
    })
    .click();
  await expect(section).toContainText("Saved original state: confirmed");
  await expect(section).toContainText("current · 0 days old");
  await expect(
    section.getByText("Retained refresh original", { exact: false }),
  ).toHaveCount(0);
  expect(refreshes).toBe(1);
  expect(receiptReads).toBe(1);
});
