import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  inspectSmiths,
  metric,
  scoreboardKey,
} from "../../apps/desktop/src/smiths-model";
import {
  boundedSmithsValue,
  recordedScoreboardSchema,
  savedSmithConfigSchema,
  smithsViewSchema,
} from "../../apps/desktop/src/smiths-protocol";
import { loadConfig } from "../config/load";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { readScoreboard } from "../ledger/scoreboard";

test("inspection preserves saved layered values and normalizes bench weights without choosing a smith", () => {
  const loaded = loadConfig({
    harnessRoot: resolve("/fixture-workspace"),
    home: resolve("/fixture-machine"),
    env: {},
    contents: {
      user: '[smiths.claude-journeyman]\nmodel = "machine-model"\n',
      workspace:
        '[smiths.claude-journeyman]\neffort = "high"\nenabled = false\n[benches]\nmedium = ["claude-journeyman:2", "codex-journeyman:1"]\n',
    },
  });
  const view = inspectSmiths(loaded);
  const smith = view.smiths.find((row) => row.name === "claude-journeyman");
  expect(smith).toMatchObject({
    model: "machine-model",
    effort: "high",
    enabled: false,
    rank: "journeyman",
  });
  expect(
    smith?.fields.find((field) => field.key === "model")?.source,
  ).toContain("config.toml");
  expect(
    smith?.fields.find((field) => field.key === "effort")?.source,
  ).toContain("agent-forge.toml");
  expect(
    view.benches.find((bench) => bench.name === "medium")?.entries[0]?.percent,
  ).toBeCloseTo(66.666666667);
  expect(
    view.benches.find((bench) => bench.name === "medium")?.entries[1]?.percent,
  ).toBeCloseTo(33.333333333);
  expect(view.defaultSmith).toBe("claude-journeyman");
  expect(
    view.benches.find((bench) => bench.name === "medium")?.entries[0]?.enabled,
  ).toBe(false);
  expect(view).not.toHaveProperty("selectedSmith");
});

test("missing provenance and conflicting rank tags stay unknown, while reported unsaved or mismatched values refuse", () => {
  const loaded = loadConfig({
    harnessRoot: resolve("/fixture"),
    home: resolve("/machine"),
    env: {},
    contents: {
      workspace:
        '[smiths.custom]\nprovider="claude"\nmodel="reported"\neffort="low"\ntags=["rank:master", "rank:apprentice"]\n',
    },
  });
  const row = inspectSmiths(loaded).smiths.find(
    (smith) => smith.name === "custom",
  );
  expect(row?.rank).toBeNull();
  expect(
    row?.fields.find((field) => field.key === "enabled")?.source,
  ).toBeNull();
  for (const change of [
    {
      ...loaded,
      provenance: {
        ...loaded.provenance,
        "smiths.custom.model": {
          value: "not-the-saved-model",
          source: loaded.files[0],
        },
      },
    },
    {
      ...loaded,
      provenance: {
        ...loaded.provenance,
        "workflow.default_crew": {
          value: loaded.config.workflow.defaultCrew,
          source: "env",
        },
      },
    },
    {
      ...loaded,
      files: ["env"],
      provenance: {
        "workflow.default_crew": {
          value: loaded.config.workflow.defaultCrew,
          source: "env",
        },
      },
    },
  ])
    expect(savedSmithConfigSchema.safeParse(change).success).toBe(false);
  expect(() =>
    boundedSmithsValue({ oversized: "x".repeat(2 * 1024 * 1024) }),
  ).toThrow("limit");
  expect(
    smithsViewSchema.safeParse({
      smiths: [],
      benches: {},
      defaultSmith: "none",
      unexpected: true,
    }).success,
  ).toBe(false);
});

test("very large finite bench weights still render finite percentages", () => {
  const loaded = loadConfig({
    harnessRoot: resolve("/fixture"),
    home: resolve("/machine"),
    env: {},
  });
  loaded.config.benches.high = [{ smith: "claude-master", weight: 1e307 }];
  delete loaded.provenance["benches.high"];
  expect(
    inspectSmiths(loaded).benches.find((bench) => bench.name === "high")
      ?.entries[0]?.percent,
  ).toBe(100);
});

test("recorded rows preserve model changes and provider token names, null stays unknown and recorded zero stays zero", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-smiths-scoreboard-"));
  const path = join(home, "ledger.db");
  try {
    for (const [model, usage] of [
      ["old-model", {}],
      ["new-model", { costUsd: 0, outputTokens: 0, cacheReadInputTokens: 17 }],
    ] as const) {
      const result = appendEvent(
        {
          kind: "session.ended",
          workspace: "/fixture",
          executor: { provider: "claude", smith: "same-smith", model },
          payload: { reason: "completed", usage },
        },
        { path },
      );
      expect(result.ok).toBe(true);
    }
    const board = recordedScoreboardSchema.parse(
      readScoreboard({ workspace: "/fixture" }, { path }),
    );
    expect(new Set(board.rows.map(scoreboardKey)).size).toBe(2);
    const old = board.rows.find((row) => row.executor?.model === "old-model");
    const current = board.rows.find(
      (row) => row.executor?.model === "new-model",
    );
    expect(metric(old?.usage.costUsd, "usd")).toBe("—");
    expect(metric(current?.usage.costUsd, "usd")).toBe("$0.00");
    expect(metric(current?.usage.tokens.outputTokens)).toBe("0");
    expect(current?.usage.tokens.cacheReadInputTokens).toBe(17);
    expect(current?.usage.tokens).not.toHaveProperty("cachedInputTokens");
    expect(metric(old?.gates.passRate, "percent")).toBe("—");
    expect(
      recordedScoreboardSchema.safeParse({
        ...board,
        rows: [...board.rows, board.rows[0]],
      }).success,
    ).toBe(false);
    expect(
      recordedScoreboardSchema.safeParse({
        ...board,
        rows: [
          {
            ...current,
            usage: { ...current?.usage, tokens: { inventedTokens: 3 } },
          },
        ],
      }).success,
    ).toBe(false);
  } finally {
    closeLedger(path);
    rmSync(home, { recursive: true, force: true });
  }
});

test("the strict inspection codec bundles independently for a browser that forbids dynamic code generation", async () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-smiths-browser-"));
  try {
    const loaded = loadConfig({
      harnessRoot: resolve("/fixture"),
      home: resolve("/machine"),
      env: {},
    });
    const entry = join(folder, "entry.ts");
    const protocol = resolve(
      import.meta.dir,
      "../../apps/desktop/src/smiths-protocol.ts",
    ).replaceAll("\\", "/");
    writeFileSync(
      entry,
      `import { savedSmithConfigSchema } from ${JSON.stringify(protocol)}; globalThis.smithsVerified = savedSmithConfigSchema.safeParse(${JSON.stringify(loaded)}).success;`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "iife",
    });
    expect(built.success).toBe(true);
    const code = await built.outputs[0]?.text();
    if (!code) throw Error("Browser bundle missing");
    expect(code).not.toContain("node:fs");
    const context = { window: {}, TextEncoder, smithsVerified: false };
    runInNewContext(code, context, {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    });
    expect(context.smithsVerified).toBe(true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
