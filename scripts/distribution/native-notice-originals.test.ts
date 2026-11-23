import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { collectPinnedNativeOriginals } from "./native-notice-originals";
import {
  collectNativeNotices,
  writeNativeNoticeInventory,
} from "./native-notices";

const root = join(import.meta.dir, "../../third-party/native-originals");
const checksum =
  "67fb21a77e8f94e8beb3325e583102488659365af0a3948b7ea244c5b779c291";
const origin = {
  sourceUrl:
    "https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/LICENSE-MIT",
  gitBlobSha1: "b08530d59433b3060f4fad8751ac2610c0b0aff3",
  crateRevision: "59b63ab500da9859f12d8888c3298bc29bba0b92",
  archiveChecksum: checksum,
};
function catalog(): unknown {
  try {
    return JSON.parse(readFileSync(join(root, "INVENTORY.json"), "utf8"));
  } catch {
    throw Error("Invalid original catalog fixture");
  }
}
const tauri = {
  name: "tauri-plugin",
  version: "2.7.2",
  checksum,
  license: "Apache-2.0 OR MIT",
};
const read = (path: string) => readFileSync(join(root, path));

test("native inventory preserves pinned upstream-original provenance instead of claiming archive origin", () => {
  const contents = readFileSync(join(root, "tauri/LICENSE-MIT"));
  const source = new TextEncoder().encode(
    JSON.stringify({
      package: checksum,
      files: {
        "upstream/LICENSE-MIT": createHash("sha256")
          .update(contents)
          .digest("hex"),
      },
      originals: { "upstream/LICENSE-MIT": origin },
    }),
  );
  const registry = "registry+https://github.com/rust-lang/crates.io-index";
  const inventory = collectNativeNotices({
    metadata: {
      version: 1,
      workspace_members: ["root"],
      packages: [
        {
          id: "root",
          name: "agent-forge-desktop",
          version: "1.0.0-rc.1",
          source: null,
          license: null,
          license_file: null,
          manifest_path: "/checkout/Cargo.toml",
        },
        {
          id: "tauri",
          name: "tauri-plugin",
          version: "2.7.2",
          source: registry,
          license: "Apache-2.0 OR MIT",
          license_file: null,
          manifest_path: "/registry/tauri-plugin/Cargo.toml",
        },
      ],
      resolve: {
        root: "root",
        nodes: [
          {
            id: "root",
            deps: [{ pkg: "tauri", dep_kinds: [{ kind: "build" }] }],
          },
          { id: "tauri", deps: [] },
        ],
      },
    },
    lock: {
      version: 4,
      package: [
        { name: "tauri-plugin", version: "2.7.2", source: registry, checksum },
      ],
    },
    read: (_pkg, path) => {
      if (path === "NOTICE-SOURCE.json") return source;
      if (path === "upstream/LICENSE-MIT") return contents;
      throw Error("Unexpected notice read");
    },
  });
  expect(inventory.holds).toEqual([]);
  expect(inventory.packages[0]?.files[0]).toMatchObject({
    path: "upstream/LICENSE-MIT",
    origin,
  });
  const stage = mkdtempSync(join(tmpdir(), "forge-original-notices-"));
  if (
    dirname(resolve(stage)) !== resolve(tmpdir()) ||
    !basename(stage).startsWith("forge-original-notices-")
  )
    throw Error("Unsafe original notice fixture cleanup");
  try {
    writeNativeNoticeInventory(stage, inventory, {
      cargoLockSha256: "a".repeat(64),
      cargoMetadataSha256: "b".repeat(64),
    });
    expect(
      readFileSync(
        join(stage, "legal/cargo/tauri-plugin-2.7.2/upstream/LICENSE-MIT"),
      ),
    ).toEqual(contents);
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        readFileSync(join(stage, "DISTRIBUTION-INVENTORY.json"), "utf8"),
      );
    } catch {
      throw Error("Invalid staged notice fixture");
    }
    expect(manifest).toMatchObject({
      sourceVerification:
        "sha256-locked-crate-archive-and-pinned-upstream-originals",
      releaseDisposition: "hold",
      packages: [{ files: [{ origin }] }],
    });
    expect(JSON.stringify(manifest)).toContain(
      "Bun runtime notice closure remains unqualified",
    );
    expect(JSON.stringify(manifest)).toContain(
      "Installer/NSIS notice qualification remains pending",
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("the five exact locked bindings preserve original bytes and their reviewed source identities", () => {
  const cases = [
    { ...tauri, count: 3 },
    {
      name: "selectors",
      version: "0.38.0",
      checksum:
        "8adfa1c298912827b8a28b223b3b874357397ae706e6190acd9bf28cee99114d",
      license: "MPL-2.0",
      count: 1,
    },
    {
      name: "webview2-com",
      version: "0.39.1",
      checksum:
        "3f89fca7a704cee10dcb3654c1dbb8941d1783132f1917358af75bec37a7d7e6",
      license: "MIT",
      count: 1,
    },
    {
      name: "webview2-com-macros",
      version: "0.8.1",
      checksum:
        "67a921c1b6914c367b2b823cd4cde6f96beec77d30a939c8199bb377cf9b9b54",
      license: "MIT",
      count: 1,
    },
    {
      name: "webview2-com-sys",
      version: "0.39.1",
      checksum:
        "b3a07132775117d6065853d9d1178157b8c90e228de47129d6bce2c7edebedfb",
      license: "MIT",
      count: 1,
    },
  ];
  for (const identity of cases) {
    const originals = collectPinnedNativeOriginals(catalog(), identity, read);
    expect(originals).toHaveLength(identity.count);
    for (const original of originals) {
      expect(original.origin.archiveChecksum).toBe(identity.checksum);
      expect(original.origin.crateRevision).toMatch(/^[a-f0-9]{40}$/);
      expect(original.origin.sourceUrl).toStartWith("https://");
      expect(original.contents.length).toBeGreaterThan(0);
    }
  }
});

test("changed originals and changed reviewed bindings refuse rather than silently claiming coverage", () => {
  expect(() =>
    collectPinnedNativeOriginals(catalog(), tauri, (path) => {
      const bytes = Uint8Array.from(read(path));
      bytes[0] = bytes[0]! ^ 1;
      return bytes;
    }),
  ).toThrow("Native original identity mismatch");
  for (const identity of [
    { ...tauri, checksum: "f".repeat(64) },
    { ...tauri, license: "MIT" },
  ])
    expect(() =>
      collectPinnedNativeOriginals(catalog(), identity, read),
    ).toThrow("Unreviewed native original binding");
  let reads = 0;
  expect(
    collectPinnedNativeOriginals(
      catalog(),
      { ...tauri, version: "999.0.0" },
      () => {
        reads++;
        throw Error("Unknown versions must not read an original");
      },
    ),
  ).toEqual([]);
  expect(reads).toBe(0);
});

test("catalog traversal is rejected before reading and Git blob identity is independently verified", () => {
  const text = readFileSync(join(root, "INVENTORY.json"), "utf8");
  for (const [before, after, expectedReads] of [
    ["tauri/LICENSE-MIT", "../private", 0],
    [origin.gitBlobSha1, "f".repeat(40), 1],
  ] as const) {
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(before, after));
    } catch {
      throw Error("Invalid changed catalog fixture");
    }
    let reads = 0;
    expect(() =>
      collectPinnedNativeOriginals(raw, tauri, (path) => {
        reads++;
        return read(path);
      }),
    ).toThrow();
    expect(reads).toBe(expectedReads);
  }
});
