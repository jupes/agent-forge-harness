import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";

export interface NativeNoticeInput {
  metadata: unknown;
  lock: unknown;
  read: (
    pkg: { name: string; version: string; manifest_path: string },
    file: string,
    maxBytes: number,
  ) => Uint8Array;
}
export interface NativeNoticeFile {
  path: string;
  bytes: number;
  sha256: string;
  contents: Uint8Array;
}
export interface NativeNoticePackage {
  name: string;
  version: string;
  source: string;
  checksum: string;
  license: string | null;
  files: NativeNoticeFile[];
}
export interface NativeNoticeInventory {
  scope: string;
  packages: NativeNoticePackage[];
  holds: string[];
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const versionSchema = z.string().regex(/^[0-9A-Za-z.+-]{1,100}$/);
const idSchema = z.string().min(1).max(2048);
const registry = "registry+https://github.com/rust-lang/crates.io-index";
const packageSchema = z.object({
  id: idSchema,
  name: nameSchema,
  version: versionSchema,
  source: z.string().max(2048).nullable(),
  license: z.string().max(512).nullable(),
  license_file: z.string().max(512).nullable(),
  manifest_path: z.string().min(1).max(4096),
});
const metadataSchema = z.object({
  version: z.literal(1),
  workspace_members: z.array(idSchema).max(2048),
  packages: z.array(packageSchema).max(2048),
  resolve: z.object({
    root: idSchema,
    nodes: z
      .array(
        z.object({
          id: idSchema,
          deps: z
            .array(
              z.object({
                pkg: idSchema,
                dep_kinds: z
                  .array(
                    z.object({ kind: z.enum(["build", "dev"]).nullable() }),
                  )
                  .min(1)
                  .max(8),
              }),
            )
            .max(2048),
        }),
      )
      .max(2048),
  }),
});
const lockSchema = z.object({
  version: z.literal(4),
  package: z
    .array(
      z.object({
        name: nameSchema,
        version: versionSchema,
        source: z.string().optional(),
        checksum: hashSchema.optional(),
      }),
    )
    .max(4096),
});
function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw Error("Invalid native notice JSON");
  }
}
function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !/[<>?"*|]/.test(path) &&
    [...path].every((char) => char.codePointAt(0)! >= 32) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !part.endsWith(".") &&
          part === part.trimEnd(),
      )
  );
}
function bounded(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length === 0 || bytes.length > max)
    throw Error("Native notice size limit");
  return bytes;
}
function legalFile(path: string): boolean {
  return (
    /^(LICENSE|LICENCE|COPYING|NOTICE)(?:[-_.].*)?$/i.test(
      path.split("/").at(-1) ?? "",
    ) || /^(licenses?|licences?)\//i.test(path)
  );
}
export function collectNativeNotices(
  input: NativeNoticeInput,
): NativeNoticeInventory {
  const metadata = metadataSchema.parse(input.metadata),
    lock = lockSchema.parse(input.lock);
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  if (
    packages.size !== metadata.packages.length ||
    nodes.size !== metadata.resolve.nodes.length ||
    !metadata.workspace_members.includes(metadata.resolve.root)
  )
    throw Error("Ambiguous native dependency identity");
  const root = packages.get(metadata.resolve.root);
  if (!root || root.name !== "agent-forge-desktop" || root.source !== null)
    throw Error("Unexpected native dependency root");
  const selected = new Set<string>(),
    pending = [root.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    const node = nodes.get(id);
    if (!node || !packages.has(id))
      throw Error("Incomplete native dependency graph");
    selected.add(id);
    for (const dep of node.deps) {
      if (dep.dep_kinds.some((kind) => kind.kind !== "dev"))
        pending.push(dep.pkg);
    }
  }
  const result: NativeNoticeInventory = {
    scope:
      "Windows x64 resolved normal/build dependency closure; conservative source/build superset, not a binary link map",
    packages: [],
    holds: [],
  };
  let totalBytes = 0;
  for (const pkg of [...selected]
    .filter((id) => id !== root.id)
    .map((id) => packages.get(id)!)
    .sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : a.version < b.version
            ? -1
            : a.version > b.version
              ? 1
              : 0,
    )) {
    if (pkg.source !== registry)
      throw Error("Unqualified native dependency source");
    const locked = lock.package.filter(
      (entry) =>
        entry.name === pkg.name &&
        entry.version === pkg.version &&
        entry.source === pkg.source,
    );
    if (locked.length !== 1 || !locked[0]!.checksum)
      throw Error("Missing or ambiguous locked native package");
    const checksum = z
      .object({ package: hashSchema, files: z.record(z.string(), hashSchema) })
      .parse(
        json(
          bounded(
            input.read(pkg, ".cargo-checksum.json", 4 * 1024 * 1024),
            4 * 1024 * 1024,
          ),
        ),
      );
    if (
      checksum.package !== locked[0]!.checksum ||
      Object.keys(checksum.files).length > 30000 ||
      Object.keys(checksum.files).some((path) => !safeRelative(path)) ||
      (pkg.license_file !== null &&
        (!safeRelative(pkg.license_file) ||
          !(pkg.license_file in checksum.files)))
    ) {
      throw Error("Unverified native package source");
    }
    const paths = Object.keys(checksum.files)
      .filter((path) => legalFile(path) || path === pkg.license_file)
      .sort();
    const files: NativeNoticeFile[] = [];
    for (const path of paths) {
      const contents = bounded(input.read(pkg, path, 1024 * 1024), 1024 * 1024);
      totalBytes += contents.length;
      if (
        totalBytes > 16 * 1024 * 1024 ||
        sha(contents) !== checksum.files[path]
      )
        throw Error("Unverified native legal file");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      if (text.includes("\0")) throw Error("Non-text native legal file");
      files.push({
        path,
        bytes: contents.length,
        sha256: sha(contents),
        contents,
      });
    }
    const identity = pkg.name + "@" + pkg.version;
    if (!files.length)
      result.holds.push(identity + ": no original legal files");
    if (!pkg.license?.trim())
      result.holds.push(identity + ": no declared license expression");
    result.packages.push({
      name: pkg.name,
      version: pkg.version,
      source: pkg.source,
      checksum: checksum.package,
      license: pkg.license,
      files,
    });
  }
  if (!result.packages.length) throw Error("Empty native dependency inventory");
  return result;
}
function readBoundedRegular(path: string, maxBytes: number): Uint8Array {
  if (lstatSync(path).isSymbolicLink()) throw Error("Linked legal source");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes)
      throw Error("Invalid native legal file");
    const buffer = new Uint8Array(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    return bounded(Uint8Array.from(buffer.subarray(0, used)), maxBytes);
  } finally {
    closeSync(fd);
  }
}
export function readCargoPackageFile(
  pkg: { name: string; version: string; manifest_path: string },
  file: string,
  maxBytes: number,
): Uint8Array {
  if (!safeRelative(file) || basename(pkg.manifest_path) !== "Cargo.toml")
    throw Error("Invalid native package path");
  const root = dirname(resolve(pkg.manifest_path)),
    index = dirname(root);
  if (
    basename(root) !== pkg.name + "-" + pkg.version ||
    !/^(index\.crates\.io|github\.com)-[a-f0-9]+$/.test(basename(index)) ||
    basename(dirname(index)) !== "src" ||
    basename(dirname(dirname(index))) !== "registry"
  ) {
    throw Error("Native source is outside the Cargo registry");
  }
  let current = root;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw Error("Linked native package");
  for (const part of file.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error("Linked native legal file");
  }
  const target = resolve(root, file);
  if (!target.startsWith(root + sep)) throw Error("Native legal path escaped");
  return readBoundedRegular(target, maxBytes);
}
async function readStream(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > max) throw Error("Cargo metadata output limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function writeNativeDistributionNotices(
  stage: string,
  repositoryRoot: string,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [
      "cargo",
      "metadata",
      "--locked",
      "--quiet",
      "--format-version",
      "1",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--manifest-path",
      join(repositoryRoot, "apps/desktop/src-tauri/Cargo.toml"),
    ],
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 120000);
  let bytes: Uint8Array;
  try {
    const [code, output] = await Promise.all([
      child.exited,
      readStream(child.stdout, 10 * 1024 * 1024),
      readStream(child.stderr, 64 * 1024),
    ]);
    if (code !== 0 || timedOut)
      throw Error("Locked Cargo metadata unavailable");
    bytes = output;
  } catch {
    child.kill();
    throw Error("Locked Cargo metadata unavailable");
  } finally {
    clearTimeout(timer);
  }
  const lockBytes = readBoundedRegular(
    join(repositoryRoot, "apps/desktop/src-tauri/Cargo.lock"),
    1024 * 1024,
  );
  let lock: unknown;
  try {
    lock = Bun.TOML.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(lockBytes),
    );
  } catch {
    throw Error("Invalid native lock metadata");
  }
  const inventory = collectNativeNotices({
    metadata: json(bytes),
    lock,
    read: readCargoPackageFile,
  });
  writeNativeNoticeInventory(stage, inventory, {
    cargoLockSha256: sha(lockBytes),
    cargoMetadataSha256: sha(bytes),
  });
}
export function writeNativeNoticeInventory(
  stage: string,
  inventory: NativeNoticeInventory,
  provenance: { cargoLockSha256: string; cargoMetadataSha256: string },
): void {
  hashSchema.parse(provenance.cargoLockSha256);
  hashSchema.parse(provenance.cargoMetadataSha256);
  const stats = lstatSync(stage);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw Error("Invalid native notice stage");
  for (const pkg of inventory.packages) {
    nameSchema.parse(pkg.name);
    versionSchema.parse(pkg.version);
    for (const file of pkg.files) {
      if (
        !safeRelative(file.path) ||
        file.contents.length !== file.bytes ||
        sha(file.contents) !== file.sha256
      )
        throw Error("Invalid staged legal source");
    }
  }
  const packages = inventory.packages.map((pkg) => ({
    ...pkg,
    files: pkg.files.map(({ contents, ...file }) => {
      const artifact =
        "legal/cargo/" + pkg.name + "-" + pkg.version + "/" + file.path;
      const destination = join(stage, artifact);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
      return { ...file, artifact };
    }),
  }));
  const manifest = {
    schemaVersion: 1,
    target: "x86_64-pc-windows-msvc",
    scope: inventory.scope,
    cargoLockSha256: provenance.cargoLockSha256,
    cargoMetadataSha256: provenance.cargoMetadataSha256,
    packages,
    releaseDisposition: "hold",
    holds: [
      ...inventory.holds,
      "Bun runtime and compiled-sidecar NPM notice closure remains unqualified.",
      "Installer/NSIS notice qualification remains pending.",
    ],
  };
  writeFileSync(
    join(stage, "DISTRIBUTION-INVENTORY.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
