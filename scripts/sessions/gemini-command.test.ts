import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scratchDirs } from "../test-scratch";
import { resolveGeminiCommand } from "./gemini-command";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

function installation() {
  const root = scratch.make("gemini-install-");
  const shim = join(root, "gemini.cmd"),
    nativeNode = join(root, "node.exe");
  const packageRoot = join(root, "node_modules", "@google", "gemini-cli");
  const entry = join(packageRoot, "dist", "index.js"),
    packageFile = join(packageRoot, "package.json");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(shim, "DO_NOT_EXECUTE_THIS_SHELL_SHIM");
  writeFileSync(nativeNode, "native resolver fixture only; never executed");
  writeFileSync(entry, "// inert vendor entry fixture");
  const data = {
    name: "@google/gemini-cli",
    version: "0.65.0",
    bin: { gemini: "dist/index.js" },
  };
  writeFileSync(packageFile, JSON.stringify(data));
  const which = (name: string) =>
    name === "gemini" ? shim : name === "node" ? nativeNode : null;
  return {
    root,
    shim,
    nativeNode,
    packageRoot,
    packageFile,
    entry,
    data,
    which,
  };
}

test("a Windows npm Gemini shim resolves the official fixed package entry and native Node without executing the shim", () => {
  const { shim, nativeNode, entry, which } = installation();
  const calls: string[] = [];
  const command = resolveGeminiCommand({
    platform: "win32",
    which(name) {
      calls.push(name);
      return which(name);
    },
  });
  expect(command).toEqual([nativeNode, entry]);
  expect(command).not.toContain(shim);
  expect(calls).toEqual(["gemini", "node"]);
});

test("invalid package metadata, oversized metadata and absent native Node never fall back to executing a Windows shell shim", () => {
  const fixture = installation();
  for (const data of [
    { ...fixture.data, name: "unofficial-gemini-cli" },
    { ...fixture.data, version: "0.64.0" },
    { ...fixture.data, bin: { gemini: "../../elsewhere.js" } },
    { ...fixture.data, bin: "dist/index.js" },
    null,
  ]) {
    writeFileSync(fixture.packageFile, JSON.stringify(data));
    expect(() => {
      resolveGeminiCommand({ platform: "win32", which: fixture.which });
    }).toThrow("no shell shim was executed");
  }
  writeFileSync(fixture.packageFile, "x".repeat(65_537));
  expect(() => {
    resolveGeminiCommand({ platform: "win32", which: fixture.which });
  }).toThrow();
  writeFileSync(fixture.packageFile, JSON.stringify(fixture.data));
  expect(() => {
    resolveGeminiCommand({
      platform: "win32",
      which: (name) => (name === "gemini" ? fixture.shim : null),
    });
  }).toThrow();
  expect(() => {
    resolveGeminiCommand({ platform: "win32", which: () => fixture.shim });
  }).toThrow();
});

test.skipIf(process.platform === "win32")(
  "the Unix npm executable symlink is followed as a CLI, while metadata remains a bounded regular file",
  () => {
    const fixture = installation();
    const link = join(fixture.root, "gemini");
    symlinkSync(fixture.entry, link);
    expect(
      resolveGeminiCommand({ platform: "linux", which: () => link }),
    ).toEqual([fixture.entry]);
  },
);

test("the fixed package entry cannot be redirected through a directory link outside the verified package", () => {
  const fixture = installation();
  const outside = join(fixture.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "index.js"), "DO_NOT_EXECUTE_OUTSIDE_PACKAGE");
  unlinkSync(fixture.entry);
  rmdirSync(dirname(fixture.entry));
  symlinkSync(
    outside,
    dirname(fixture.entry),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => {
    resolveGeminiCommand({ platform: "win32", which: fixture.which });
  }).toThrow();
});
