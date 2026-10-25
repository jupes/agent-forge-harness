import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ProjectShiftStartRequest } from "../../types/project-shifts";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { scratchDirs } from "../test-scratch";
import {
  canonicalKeeperProofRoot,
  keeperStartFailureDiagnostic,
} from "./keeper-compiled-proof";
import { projectShiftRequestHash } from "./registry";

test("compiled Keeper fixture shares the disk-canonical workspace for scope and request hashes", () => {
  const scratch = scratchDirs();
  try {
    const parent = scratch.make("compiled Keeper path alias "),
      actual = join(parent, "actual workspace"),
      alias = join(parent, "alias workspace");
    mkdirSync(join(actual, ".git"), { recursive: true });
    symlinkSync(actual, alias, "junction");

    const canonical = canonicalKeeperProofRoot(alias),
      served = resolveCheckout(alias).workspace,
      catalogRoot =
        projectCatalogFixture(canonical).projects[0]?.workspaces[0]?.root;
    expect(canonical).toBe(served);
    expect(workspaceKey(alias)).not.toBe(workspaceKey(canonical));
    expect(catalogRoot).toBe(canonical);
    expect(workspaceKey(catalogRoot ?? "")).toBe(workspaceKey(served));

    const request: ProjectShiftStartRequest = {
      requestId: "913c01ee-e854-4d0e-8d6c-a246304d74a1",
      expectedCatalogRevision: 1,
      options: {
        for: "1m",
        concurrency: 1,
        maxBeads: 1,
        maxUsd: 5,
        repairs: 1,
        base: "main",
      },
    };
    expect(
      projectShiftRequestHash(FIXTURE_PROJECT_ID, catalogRoot!, request),
    ).toBe(projectShiftRequestHash(FIXTURE_PROJECT_ID, served, request));

    if (process.platform === "win32") {
      const extended = `\\\\?\\${alias}`;
      expect(workspaceKey(extended)).not.toBe(workspaceKey(canonical));
      expect(canonicalKeeperProofRoot(extended)).toBe(canonical);
    }
  } finally {
    scratch.cleanup();
  }
});

test("Keeper compiled proof reports only a strict bounded public refusal error", async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      data: null,
      error: "The original Shift review could not be verified.",
    }),
    { status: 503 },
  );
  expect(await keeperStartFailureDiagnostic(response)).toBe(
    'status=503; refusal="The original Shift review could not be verified."',
  );
});

test("Keeper compiled proof hides malformed, oversized and nonstandard refusal bodies", async () => {
  const malformed = new Response(
      JSON.stringify({ ok: false, data: null, error: "bad", extra: "private" }),
      { status: 400 },
    ),
    tooLong = new Response(
      JSON.stringify({ ok: false, data: null, error: "x".repeat(513) }),
      { status: 409 },
    );
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 503 },
  );
  expect(await keeperStartFailureDiagnostic(malformed)).toBe(
    "status=400; refusal=malformed",
  );
  expect(await keeperStartFailureDiagnostic(tooLong)).toBe(
    "status=409; refusal=malformed",
  );
  expect(await keeperStartFailureDiagnostic(oversized)).toBe(
    "status=503; refusal=oversized",
  );
  expect(cancelled).toBe(true);
});
