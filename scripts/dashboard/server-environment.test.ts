import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDashboardServerEnvironment } from "./server-environment";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dashboard server environment", () => {
  test("loads local provider credentials while preserving process overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-forge-dashboard-env-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, ".env"),
      [
        "DASHBOARD_TEST_FILE_VALUE=value-from-file",
        "DASHBOARD_TEST_OVERRIDE=value-from-file",
      ].join("\n"),
    );

    const environment = loadDashboardServerEnvironment({
      mode: "development",
      root,
      processEnvironment: {
        DASHBOARD_TEST_OVERRIDE: "value-from-process",
      },
    });

    expect(environment.DASHBOARD_TEST_FILE_VALUE).toBe("value-from-file");
    expect(environment.DASHBOARD_TEST_OVERRIDE).toBe("value-from-process");
  });
});
