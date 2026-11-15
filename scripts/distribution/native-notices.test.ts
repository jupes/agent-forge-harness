import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  collectNativeNotices,
  readCargoPackageFile,
  writeNativeNoticeInventory,
} from "./native-notices";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const registry = "registry+https://github.com/rust-lang/crates.io-index";
function fixture() {
  const packages = [
    {
      id: "root",
      name: "agent-forge-desktop",
      version: "1.0.0-rc.1",
      source: null,
      license: null,
      license_file: null,
      manifest_path: "/checkout/Cargo.toml",
    },
    ...["alpha", "beta", "dev-only"].map((name) => ({
      id: name,
      name,
      version: "1.2.3",
      source: registry,
      license: "MIT OR Apache-2.0",
      license_file: null as string | null,
      manifest_path: "/registry/" + name + "/Cargo.toml",
    })),
  ];
  const metadata = {
    version: 1,
    workspace_members: ["root"],
    packages,
    resolve: {
      root: "root",
      nodes: [
        {
          id: "root",
          deps: [
            { pkg: "beta", dep_kinds: [{ kind: null, target: null }] },
            { pkg: "alpha", dep_kinds: [{ kind: "build", target: null }] },
            { pkg: "dev-only", dep_kinds: [{ kind: "dev", target: null }] },
          ],
        },
        ...["alpha", "beta", "dev-only"].map((id) => ({ id, deps: [] })),
      ],
    },
  };
  const lock = {
    version: 4,
    package: ["alpha", "beta", "dev-only"].map((name) => ({
      name,
      version: "1.2.3",
      source: registry,
      checksum: digest(name),
    })),
  };
  const files = new Map<string, string>();
  for (const name of ["alpha", "beta", "dev-only"]) {
    const contents = name + " exact original notice\r\n";
    files.set(name + "/LICENSE-MIT", contents);
    files.set(name + "/NOTICE", "Original attribution for " + name + "\n");
    files.set(
      name + "/.cargo-checksum.json",
      JSON.stringify({
        package: digest(name),
        files: {
          "LICENSE-MIT": digest(contents),
          NOTICE: digest("Original attribution for " + name + "\n"),
          "src/lib.rs": digest("code"),
        },
      }),
    );
  }
  const reads: string[] = [];
  const read = (pkg: { name: string }, path: string) => {
    reads.push(pkg.name + "/" + path);
    const text = files.get(pkg.name + "/" + path);
    if (text === undefined) throw Error("Unexpected package file");
    return new TextEncoder().encode(text);
  };
  return { metadata, lock, files, reads, read };
}
test("native inventory follows normal/build closure, excludes dev-only and preserves original bytes deterministically", () => {
  const f = fixture();
  const result = collectNativeNotices(f);
  expect(result.packages.map((pkg) => pkg.name)).toEqual(["alpha", "beta"]);
  expect(result.packages[0]?.files.map((file) => file.path)).toEqual([
    "LICENSE-MIT",
    "NOTICE",
  ]);
  expect(new TextDecoder().decode(result.packages[0]?.files[0]?.contents)).toBe(
    "alpha exact original notice\r\n",
  );
  expect(result.packages[0]?.files[0]?.sha256).toBe(
    digest("alpha exact original notice\r\n"),
  );
  expect(result.packages[0]?.license).toBe("MIT OR Apache-2.0");
  expect(f.reads.some((path) => path.startsWith("dev-only/"))).toBe(false);
  expect(JSON.stringify(result)).not.toContain("/checkout");
  expect(JSON.stringify(result)).not.toContain("/registry");
  expect(result.holds).toEqual([]);
});
test("a Cargo package or legal-file checksum mismatch refuses the inventory", () => {
  const changedLock = fixture();
  changedLock.lock.package[0]!.checksum = "f".repeat(64);
  expect(() => collectNativeNotices(changedLock)).toThrow();
  const changedFile = fixture();
  changedFile.files.set("alpha/LICENSE-MIT", "Changed legal text");
  expect(() => collectNativeNotices(changedFile)).toThrow();
});
test("legal paths cannot escape package roots and unsafe checksum paths are rejected before a read", () => {
  const outside = fixture();
  outside.metadata.packages[1]!.license_file = "../private";
  expect(() => collectNativeNotices(outside)).toThrow();
  expect(outside.reads.some((path) => path.includes("../"))).toBe(false);
  const malformed = fixture();
  malformed.files.set(
    "alpha/.cargo-checksum.json",
    JSON.stringify({
      package: digest("alpha"),
      files: { "../LICENSE": digest("private") },
    }),
  );
  expect(() => collectNativeNotices(malformed)).toThrow();
  expect(malformed.reads.some((path) => path.includes("../"))).toBe(false);
});
test("missing legal files and missing declared terms are explicit holds, never claimed coverage", () => {
  const absent = fixture();
  absent.files.set(
    "alpha/.cargo-checksum.json",
    JSON.stringify({
      package: digest("alpha"),
      files: { "src/lib.rs": digest("code") },
    }),
  );
  absent.metadata.packages[2]!.license = null;
  const result = collectNativeNotices(absent);
  expect(result.holds).toContain("alpha@1.2.3: no original legal files");
  expect(result.holds).toContain("beta@1.2.3: no declared license expression");
  expect(result.packages).toHaveLength(2);
});
test("missing or duplicate graph identities, foreign sources and absent locked packages refuse", () => {
  const missing = fixture();
  missing.metadata.resolve.nodes = missing.metadata.resolve.nodes.filter(
    (node) => node.id !== "alpha",
  );
  expect(() => collectNativeNotices(missing)).toThrow();
  const duplicate = fixture();
  duplicate.metadata.packages.push(duplicate.metadata.packages[1]!);
  expect(() => collectNativeNotices(duplicate)).toThrow();
  const foreign = fixture();
  foreign.metadata.packages[1]!.source = "git+https://example.invalid/foreign";
  expect(() => collectNativeNotices(foreign)).toThrow();
  const unlocked = fixture();
  unlocked.lock.package = unlocked.lock.package.filter(
    (pkg) => pkg.name !== "alpha",
  );
  expect(() => collectNativeNotices(unlocked)).toThrow();
});

function withScratch(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "forge-native-notices-"));
  if (
    dirname(resolve(dir)) !== resolve(tmpdir()) ||
    !basename(dir).startsWith("forge-native-notices-")
  )
    throw Error("Unsafe scratch cleanup");
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("nonlegal Unicode source names do not prevent original legal notice coverage", () => {
  const f = fixture();
  const checksum = {
    package: digest("alpha"),
    files: {
      "LICENSE-MIT": digest("alpha exact original notice\r\n"),
      "tests/naïve.rs": digest("fixture"),
    },
  };
  f.files.set("alpha/.cargo-checksum.json", JSON.stringify(checksum));
  expect(
    collectNativeNotices(f).packages[0]?.files.map((file) => file.path),
  ).toEqual(["LICENSE-MIT"]);
});
test("Cargo source reader bounds regular files and refuses traversal outside the fixed registry package", () =>
  withScratch((dir) => {
    const root = join(
      dir,
      "registry",
      "src",
      "index.crates.io-abcd",
      "alpha-1.2.3",
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "LICENSE"), "exact bytes\r\n");
    const pkg = {
      name: "alpha",
      version: "1.2.3",
      manifest_path: join(root, "Cargo.toml"),
    };
    expect(
      new TextDecoder().decode(readCargoPackageFile(pkg, "LICENSE", 1024)),
    ).toBe("exact bytes\r\n");
    expect(() => readCargoPackageFile(pkg, "LICENSE", 3)).toThrow();
    expect(() => readCargoPackageFile(pkg, "../private", 1024)).toThrow();
    expect(() =>
      readCargoPackageFile({ ...pkg, name: "different" }, "LICENSE", 1024),
    ).toThrow();
  }));
test.skipIf(process.platform === "win32")(
  "Cargo legal reader refuses symbolic links",
  () =>
    withScratch((dir) => {
      const root = join(
        dir,
        "registry",
        "src",
        "index.crates.io-abcd",
        "alpha-1.2.3",
      );
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "original"), "notice");
      symlinkSync(join(root, "original"), join(root, "LICENSE"));
      expect(() =>
        readCargoPackageFile(
          {
            name: "alpha",
            version: "1.2.3",
            manifest_path: join(root, "Cargo.toml"),
          },
          "LICENSE",
          1024,
        ),
      ).toThrow();
    }),
);
test("staged native notices preserve bytes and expose explicit remaining release holds without source paths", () =>
  withScratch((dir) => {
    const inventory = collectNativeNotices(fixture());
    writeNativeNoticeInventory(dir, inventory, {
      cargoLockSha256: "a".repeat(64),
      cargoMetadataSha256: "b".repeat(64),
    });
    expect(
      readFileSync(join(dir, "legal/cargo/alpha-1.2.3/LICENSE-MIT"), "utf8"),
    ).toBe("alpha exact original notice\r\n");
    const text = readFileSync(join(dir, "DISTRIBUTION-INVENTORY.json"), "utf8");
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw Error("Invalid inventory fixture JSON");
    }
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      target: "x86_64-pc-windows-msvc",
      releaseDisposition: "hold",
      cargoLockSha256: "a".repeat(64),
    });
    expect(text).toContain("Bun runtime and compiled-sidecar NPM");
    expect(text).not.toContain("/registry");
    expect(text).not.toContain("/checkout");
    expect(text).not.toContain('"contents"');
  }));
