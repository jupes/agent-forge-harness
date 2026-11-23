import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type CompiledNoticeInput,
  type CompiledPackageSource,
  collectCompiledNotices,
  parseCompiledLock,
  readCompiledPackage,
  writeCompiledNoticeInventory,
} from "./compiled-notices";

const encode = (text: string) => new TextEncoder().encode(text);
const integrity = "sha512-" + Buffer.alloc(64).toString("base64");
function fixture() {
  const source = (name: string): CompiledPackageSource => ({
    name,
    version: "1.2.3",
    license: "MIT",
    files: [
      { path: "LICENSE", contents: encode(name + " original legal bytes\r\n") },
    ],
  });
  const packages = new Map([
    ["node_modules/zod", source("zod")],
    ["node_modules/@fixture/helper", source("@fixture/helper")],
  ]);
  const graphs: CompiledNoticeInput["graphs"] = [
    {
      name: "desktop-host",
      metadata: {
        inputs: {
          "scripts/desktop/entry.ts": {
            bytes: 3,
            imports: [{ path: "node:fs", external: true }],
          },
          "node_modules/zod/index.js": { bytes: 20, imports: [] },
        },
        outputs: {},
      },
    },
    {
      name: "hearth",
      metadata: {
        inputs: {
          "node_modules/zod/index.js": { bytes: 20, imports: [] },
          "node_modules/@fixture/helper/index.js": {
            bytes: 10,
            imports: [{ path: "bun:sqlite", external: true }],
          },
        },
        outputs: {},
      },
    },
  ];
  const lock = {
    lockfileVersion: 1,
    packages: {
      zod: ["zod@1.2.3", "", {}, integrity],
      "@fixture/helper": ["@fixture/helper@1.2.3", "", {}, integrity],
    },
  };
  const reads: string[] = [];
  const readPackage = (root: string) => {
    reads.push(root);
    const pkg = packages.get(root);
    if (!pkg) throw Error("Unexpected package root");
    return pkg;
  };
  return { graphs, lock, readPackage, packages, reads };
}
test("compiled inventory maps actual graph packages to pinned identities and preserves exact original legal bytes", () => {
  const f = fixture(),
    result = collectCompiledNotices(f);
  expect(result.packages.map((pkg) => pkg.name)).toEqual([
    "@fixture/helper",
    "zod",
  ]);
  const zod = result.packages.find((pkg) => pkg.name === "zod")!;
  expect(zod.graphs).toEqual(["desktop-host", "hearth"]);
  expect(new TextDecoder().decode(zod.files[0]?.contents)).toBe(
    "zod original legal bytes\r\n",
  );
  expect(zod.files[0]?.sha256).toBe(
    createHash("sha256").update("zod original legal bytes\r\n").digest("hex"),
  );
  expect(zod.integrity).toBe(integrity);
  expect(result.holds).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("node_modules");
});
test("Bun JSONC lock parsing accepts generated comments and trailing commas and refuses malformed data", () => {
  expect(
    parseCompiledLock('{"packages":{/* comment */"x":["x@1.0.0","",{},],},}'),
  ).toEqual({ packages: { x: ["x@1.0.0", "", {}] } });
  expect(() => parseCompiledLock('{"packages":')).toThrow();
});
test("missing original files and terms remain explicit named holds", () => {
  const f = fixture();
  f.packages.get("node_modules/zod")!.files = [];
  f.packages.get("node_modules/zod")!.license = null;
  const result = collectCompiledNotices(f);
  expect(result.holds).toContain("zod@1.2.3: no original legal files");
  expect(result.holds).toContain("zod@1.2.3: no declared license expression");
});
test("unlocked package versions and conflicting lock integrities refuse", () => {
  const f = fixture();
  f.packages.get("node_modules/zod")!.version = "1.2.4";
  expect(() => collectCompiledNotices(f)).toThrow();
  const other = fixture();
  Reflect.set(other.lock.packages, "alias", [
    "zod@1.2.3",
    "",
    {},
    "sha512-" + Buffer.alloc(64, 1).toString("base64"),
  ]);
  expect(() => collectCompiledNotices(other)).toThrow();
});
test("unclassified external imports, duplicate graphs and unsafe legal paths cannot claim a complete inventory", () => {
  const external = fixture();
  external.graphs[0]!.metadata = {
    inputs: {
      "scripts/entry.ts": {
        bytes: 1,
        imports: [{ path: "foreign-native-addon", external: true }],
      },
    },
  };
  expect(() => collectCompiledNotices(external)).toThrow();
  const duplicate = fixture();
  duplicate.graphs[1] = duplicate.graphs[0]!;
  expect(() => collectCompiledNotices(duplicate)).toThrow();
  const unsafe = fixture();
  unsafe.packages.get("node_modules/zod")!.files[0]!.path = "../private";
  expect(() => collectCompiledNotices(unsafe)).toThrow();
});
test("nested installed roots may deduplicate only byte-identical original notices", () => {
  const f = fixture();
  f.graphs[1]!.metadata = {
    inputs: {
      "node_modules/outer/node_modules/zod/index.js": {
        bytes: 10,
        imports: [],
      },
    },
  };
  const original = f.packages.get("node_modules/zod")!;
  f.packages.set("node_modules/outer/node_modules/zod", original);
  expect(collectCompiledNotices(f).packages).toHaveLength(1);
  f.packages.set("node_modules/outer/node_modules/zod", {
    ...original,
    files: [{ path: "LICENSE", contents: encode("different bytes") }],
  });
  expect(() => collectCompiledNotices(f)).toThrow();
});

async function withScratch(run: (path: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "forge-compiled-notices-"));
  if (
    dirname(resolve(dir)) !== resolve(tmpdir()) ||
    !basename(dir).startsWith("forge-compiled-notices-")
  )
    throw Error("Unsafe compiled notice scratch root");
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("installed package originals are bounded and a staged inventory preserves exact bytes without machine paths", async () =>
  withScratch((dir) => {
    const root = join(dir, "node_modules", "zod");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "zod", version: "1.2.3", license: "MIT" }),
    );
    writeFileSync(join(root, "LICENSE"), "actual installed original\r\n");
    const source = readCompiledPackage("node_modules/zod", dir);
    expect(source.name).toBe("zod");
    expect(new TextDecoder().decode(source.files[0]?.contents)).toBe(
      "actual installed original\r\n",
    );
    const f = fixture();
    f.packages.set("node_modules/zod", source);
    const inventory = collectCompiledNotices(f);
    writeCompiledNoticeInventory(dir, inventory, {
      bunLockSha256: "a".repeat(64),
      graphs: [
        { name: "desktop-host", sha256: "b".repeat(64) },
        { name: "hearth", sha256: "c".repeat(64) },
      ],
    });
    expect(readFileSync(join(dir, "legal/npm/zod-1.2.3/LICENSE"), "utf8")).toBe(
      "actual installed original\r\n",
    );
    const contents = readFileSync(
      join(dir, "COMPILED-DEPENDENCY-INVENTORY.json"),
      "utf8",
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(contents);
    } catch {
      throw Error("Invalid compiled inventory fixture JSON");
    }
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      releaseDisposition: "hold",
      coverage: "recorded",
      bunLockSha256: "a".repeat(64),
    });
    expect(contents).not.toContain("node_modules");
    expect(contents).not.toContain(dir);
    expect(contents).not.toContain('"contents"');
  }));
test("the collector accepts a real in-memory Bun graph and the actual frozen package metadata", async () => {
  const root = resolve(import.meta.dir, "../..");
  const built = await Bun.build({
    entrypoints: ["notice-fixture:entry"],
    target: "bun",
    metafile: true,
    plugins: [
      {
        name: "notice-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^notice-fixture:entry$/ }, () => ({
            path: "entry",
            namespace: "notice-fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "notice-fixture" }, () => ({
            contents:
              'import { z } from "zod"; export const read = (x: unknown) => z.string().parse(x);',
            loader: "ts",
            resolveDir: root,
          }));
        },
      },
    ],
  });
  expect(built.success).toBe(true);
  if (!built.metafile) throw Error("No emitted Bun metadata");
  const lock = parseCompiledLock(readFileSync(join(root, "bun.lock"), "utf8"));
  const inventory = collectCompiledNotices({
    graphs: [
      { name: "desktop-host", metadata: built.metafile },
      { name: "hearth", metadata: built.metafile },
    ],
    lock,
    readPackage: (sourceRoot) => readCompiledPackage(sourceRoot, root),
  });
  const zod = inventory.packages.find((pkg) => pkg.name === "zod");
  expect(zod?.version).toBe("4.5.4");
  expect(zod?.files.length).toBeGreaterThan(0);
  expect(zod?.graphs).toEqual(["desktop-host", "hearth"]);
  expect(inventory.holds).toEqual([]);
}, 15000);

test("captured relative cycle edges are classified while missing or emitted externals refuse", () => {
  const graph = (include: boolean, emitted = false) => ({
    inputs: {
      "scripts/entry.ts": {
        bytes: 1,
        imports: [{ path: "./captured", external: true }],
      },
      ...(include ? { "scripts/captured.ts": { bytes: 1, imports: [] } } : {}),
    },
    outputs: {
      "entry.js": {
        imports: emitted ? [{ path: "./captured", external: true }] : [],
      },
    },
  });
  const f = fixture();
  f.graphs[0]!.metadata = graph(true);
  expect(() => collectCompiledNotices(f)).not.toThrow();
  f.graphs[0]!.metadata = graph(false);
  expect(() => collectCompiledNotices(f)).toThrow();
  f.graphs[0]!.metadata = graph(true, true);
  expect(() => collectCompiledNotices(f)).toThrow();
});
