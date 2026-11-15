import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readBoundedNoticeFile, safeNoticeRelative } from "./native-notices";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const relativeSchema = z.string().max(512).refine(safeNoticeRelative);
const originalSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  revision: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  upstreamPath: relativeSchema,
  gitBlobSha1: z.string().regex(/^[a-f0-9]{40}$/),
  bunBuildDefinitionBlob: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  path: relativeSchema,
  bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runtime: z.literal("bun"),
  version: z.literal("1.4.2"),
  revisionPrefix: z.literal("744846f84"),
  scope: z.string().min(1).max(512),
  releaseDisposition: z.literal("hold"),
  holds: z.array(z.string().min(1).max(2048)).min(1).max(64),
  files: z.array(originalSchema).min(1).max(128),
});
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw Error("Invalid runtime original UTF8");
  }
}
export function collectRuntimeNotices(
  raw: unknown,
  version: string,
  revision: string,
  read: (path: string, max: number) => Uint8Array,
) {
  const manifest = manifestSchema.parse(raw);
  if (
    version !== manifest.version ||
    !revision.startsWith(manifest.revisionPrefix)
  )
    throw Error("Unexpected build runtime identity");
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw Error("Duplicate Windows runtime notice path");
    paths.add(key);
    total += file.bytes;
    if (total > 1024 * 1024) throw Error("Runtime original total size limit");
  }
  const files = manifest.files.map((file) => {
    const contents = Uint8Array.from(read(file.path, 256 * 1024));
    const blob = createHash("sha1")
      .update(new TextEncoder().encode("blob " + contents.length + "\0"))
      .update(contents)
      .digest("hex");
    if (
      contents.length !== file.bytes ||
      sha(contents) !== file.sha256 ||
      blob !== file.gitBlobSha1
    )
      throw Error("Original identity mismatch: " + file.path);
    utf8(contents);
    return { ...file, contents, output: "legal/bun/" + file.path };
  });
  return { manifest, files };
}
function readOriginal(directory: string, path: string, max: number) {
  if (!safeNoticeRelative(path)) throw Error("Invalid runtime source path");
  let current = directory;
  const root = lstatSync(current);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw Error("Linked runtime source root");
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error("Linked runtime original");
  }
  return readBoundedNoticeFile(current, max);
}
function createOutputParent(stage: string, relative: string) {
  let current = stage;
  const root = lstatSync(current);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw Error("Linked runtime output root");
  for (const part of dirname(relative).split(/[\\/]/)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Linked runtime output parent");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      mkdirSync(current);
    }
  }
}
export function writeRuntimeDistributionNotices(stage: string, root: string) {
  const source = join(root, "third-party", "bun-1.4.2");
  const bytes = readOriginal(source, "INVENTORY.json", 512 * 1024);
  let raw: unknown;
  try {
    raw = JSON.parse(utf8(bytes));
  } catch {
    throw Error("Invalid runtime notice manifest");
  }
  const inventory = collectRuntimeNotices(
    raw,
    Bun.version,
    Bun.revision,
    (path, max) => readOriginal(source, path, max),
  );
  for (const file of inventory.files) {
    createOutputParent(stage, file.output);
    writeFileSync(join(stage, file.output), file.contents, { flag: "wx" });
  }
  const manifest = {
    ...inventory.manifest,
    sourceManifestSha256: sha(bytes),
    files: inventory.files.map(({ contents: _contents, ...file }) => file),
  };
  writeFileSync(
    join(stage, "RUNTIME-DEPENDENCY-INVENTORY.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return manifest;
}
