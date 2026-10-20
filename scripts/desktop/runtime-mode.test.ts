import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RollupOutput } from "rollup";
import { build } from "vite";

const root = resolve(import.meta.dir, "../..");
const entry = join(root, "docs", "js", "hearth-read.ts");

test("Vite production modes compile the live/static switch into their built module", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-forge-runtime-mode-"));
  const envDir = join(temp, "env");
  mkdirSync(envDir);
  try {
    const desktop = await buildModule("desktop", envDir);
    const production = await buildModule("production", envDir);
    expect(desktop).toBe(false);
    expect(production).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

async function buildModule(mode: string, envDir: string): Promise<boolean> {
  const result = await build({
    configFile: false,
    root,
    mode,
    envDir,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "runtime-mode" },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result) as RollupOutput;
  const chunk = output.output.find(
    (item) => item.type === "chunk" && item.isEntry,
  );
  if (!chunk || chunk.type !== "chunk")
    throw new Error("Vite did not emit the runtime-mode module.");
  if (chunk.code.includes("import.meta.env"))
    throw new Error(
      "Vite left a runtime environment lookup in the built module.",
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
  const module = (await import(moduleUrl)) as {
    servedStatically: () => boolean;
  };
  return module.servedStatically();
}
