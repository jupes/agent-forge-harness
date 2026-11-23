import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  collectRuntimeNotices,
  writeRuntimeDistributionNotices,
} from "./runtime-notices";

const contents = new TextEncoder().encode("Original copyright — test\n");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fixture() {
  return {
    schemaVersion: 1,
    runtime: "bun",
    version: "1.4.2",
    revisionPrefix: "744846f84",
    scope: "Selected upstream originals; not a binary link map.",
    releaseDisposition: "hold",
    holds: ["Unmapped runtime components and source/relink obligations."],
    files: [
      {
        name: "example",
        repository: "owner/project",
        revision: "a".repeat(40),
        upstreamPath: "LICENSE",
        gitBlobSha1: createHash("sha1")
          .update(Buffer.from("blob " + contents.length + "\0"))
          .update(contents)
          .digest("hex"),
        bunBuildDefinitionBlob: "b".repeat(40),
        path: "example/LICENSE",
        bytes: contents.length,
        sha256: hash(contents),
      },
    ],
  };
}
const collect = (raw: unknown, read = () => contents) =>
  collectRuntimeNotices(raw, "1.4.2", "744846f84abcdef", read);

test("runtime originals retain their exact bytes and explicit coverage holds", () => {
  const result = collect(fixture());
  expect(result.manifest.releaseDisposition).toBe("hold");
  expect(result.manifest.holds).toEqual(fixture().holds);
  expect(result.files[0]?.contents).toEqual(contents);
  expect(result.files[0]?.output).toBe("legal/bun/example/LICENSE");
});
test("runtime identity, unsafe members and duplicate Windows names refuse", () => {
  expect(() =>
    collectRuntimeNotices(fixture(), "1.4.3", "744846f84", () => contents),
  ).toThrow("runtime identity");
  expect(() =>
    collectRuntimeNotices(fixture(), "1.4.2", "different", () => contents),
  ).toThrow("runtime identity");
  const unsafe = fixture();
  unsafe.files[0]!.path = "../escape";
  let reads = 0;
  expect(() =>
    collect(unsafe, () => {
      reads++;
      return contents;
    }),
  ).toThrow();
  expect(reads).toBe(0);
  const duplicate = fixture();
  duplicate.files.push({ ...duplicate.files[0]!, path: "EXAMPLE/license" });
  expect(() => collect(duplicate)).toThrow("Duplicate");
});
test("original length, SHA256, Git blob and UTF8 are independently checked", () => {
  const changed = fixture();
  changed.files[0]!.bytes++;
  expect(() => collect(changed)).toThrow("Original identity");
  const wrongHash = fixture();
  wrongHash.files[0]!.sha256 = "0".repeat(64);
  expect(() => collect(wrongHash)).toThrow("Original identity");
  const wrongBlob = fixture();
  wrongBlob.files[0]!.gitBlobSha1 = "0".repeat(40);
  expect(() => collect(wrongBlob)).toThrow("Original identity");
  const invalid = Uint8Array.of(255);
  const badText = fixture();
  Object.assign(badText.files[0]!, {
    bytes: 1,
    sha256: hash(invalid),
    gitBlobSha1: createHash("sha1")
      .update(Buffer.from("blob 1\0"))
      .update(invalid)
      .digest("hex"),
  });
  expect(() => collect(badText, () => invalid)).toThrow("UTF8");
  const cleared = fixture();
  cleared.holds = [];
  expect(() => collect(cleared)).toThrow();
});
test("the actual pinned source set stages exact originals and remains held", () => {
  const root = resolve(import.meta.dir, "../..");
  const stage = mkdtempSync(join(tmpdir(), "forge-runtime-notices-"));
  if (
    dirname(resolve(stage)) !== resolve(tmpdir()) ||
    !basename(stage).startsWith("forge-runtime-notices-")
  )
    throw Error("Unsafe runtime notice fixture cleanup");
  try {
    const manifest = writeRuntimeDistributionNotices(stage, root);
    expect(manifest.files).toHaveLength(34);
    expect(manifest.files.find((file) => file.name === "zstd")).toMatchObject({
      path: "zstd/LICENSE",
      sha256:
        "7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8",
      gitBlobSha1: "75800288cc243f164b9d130f125e2ffae28f8e39",
    });
    expect(manifest.releaseDisposition).toBe("hold");
    expect(manifest.holds.length).toBeGreaterThanOrEqual(7);
    expect(
      manifest.files.find((file) => file.path === "sqlite/LICENSE.md"),
    ).toMatchObject({
      name: "sqlite",
      repository: "sqlite/sqlite",
      revision: "3ee9f4064e0025a029d648c5374a4d9db10aaa32",
      upstreamPath: "LICENSE.md",
      gitBlobSha1: "aa439fce58d0cfc4d21f0bdfbb48e09d3eda3a67",
      bunBuildDefinitionBlob: "6d6eec0375d67bfee4f227ddc7f8015ffa98951c",
      bytes: 3829,
      sha256:
        "c9053892d578840a196d588ff68baa9bc0f5240eb215fb9cf91cd6b0b3209305",
      output: "legal/bun/sqlite/LICENSE.md",
    });
    for (const file of manifest.files) {
      const source = readFileSync(
        join(root, "third-party/bun-1.4.2", file.path),
      );
      const staged = readFileSync(join(stage, "legal/bun", file.path));
      expect(staged.equals(source)).toBe(true);
      expect(hash(staged)).toBe(file.sha256);
    }
    let saved: unknown;
    try {
      saved = JSON.parse(
        readFileSync(join(stage, "RUNTIME-DEPENDENCY-INVENTORY.json"), "utf8"),
      );
    } catch {
      throw Error("Invalid staged runtime inventory fixture");
    }
    expect(saved).toEqual(manifest);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
