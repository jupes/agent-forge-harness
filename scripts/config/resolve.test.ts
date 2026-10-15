import { afterAll, describe, expect, test } from "bun:test";
import type { BenchName, Smith } from "../../types/hearth";
import { scratchDirs } from "../test-scratch";
import { loadConfig } from "./load";
import { pickFromBench, resolveSmith } from "./resolve";

// Made when the file loads, so it goes when the file is done.
const scratch = scratchDirs();
afterAll(() => scratch.cleanup());
const root = scratch.make("forge-resolve-");
const { config } = loadConfig({ harnessRoot: root, home: root, env: {} });

describe("resolveSmith", () => {
  test("explicit beats bead metadata beats bench beats default", () => {
    const base = { complexity: "high" as const, seed: "b-1" };
    expect(
      resolveSmith(config, {
        ...base,
        explicit: "codex-journeyman",
        beadSmith: "claude-master",
      }),
    ).toMatchObject({ ok: true, via: "explicit" });
    expect(
      resolveSmith(config, { ...base, beadSmith: "claude-apprentice" }),
    ).toMatchObject({ ok: true, via: "bead" });
    const bench = resolveSmith(config, base);
    expect(bench).toMatchObject({ ok: true, via: "bench" });
    expect(bench.ok && bench.smith.name).toBe("claude-master");
    const fallback = resolveSmith(config, {});
    expect(fallback.ok && fallback.smith.name).toBe("claude-journeyman");
  });

  test("an unknown or disabled smith is an error, not a fall-through", () => {
    expect(resolveSmith(config, { explicit: "ghost" })).toEqual({
      ok: false,
      error: 'unknown smith "ghost"',
    });
    const master = config.smiths["claude-master"] as Smith;
    const disabled = {
      ...config,
      smiths: {
        ...config.smiths,
        "claude-master": { ...master, enabled: false },
      },
    };
    expect(resolveSmith(disabled, { explicit: "claude-master" })).toEqual({
      ok: false,
      error: 'smith "claude-master" is disabled',
    });
  });

  test("a name every object has a key for is an unknown smith, whether named by flag or by bead", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const unknown = { ok: false as const, error: `unknown smith "${name}"` };
      expect(resolveSmith(config, { explicit: name })).toEqual(unknown);
      expect(resolveSmith(config, { beadSmith: name })).toEqual(unknown);
    }
  });

  test("a complexity every object has a key for is an unknown bench, returned rather than thrown", () => {
    // What a caller that skipped its own check could pass: typed as a bench, not one.
    for (const name of ["constructor", "__proto__", "toString"] as string[]) {
      expect(
        resolveSmith(config, { complexity: name as BenchName, seed: "b-1" }),
      ).toEqual({ ok: false, error: `unknown bench "${name}"` });
    }
  });

  test("the bench pick is stable per seed and respects weights", () => {
    const bench = config.benches.low;
    expect(pickFromBench(bench, "bead-7")).toBe(pickFromBench(bench, "bead-7"));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const pick = pickFromBench(bench, `bead-${i}`);
      counts[pick] = (counts[pick] ?? 0) + 1;
    }
    const share = (counts["claude-apprentice"] ?? 0) / 2000;
    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.8);
  });
});
