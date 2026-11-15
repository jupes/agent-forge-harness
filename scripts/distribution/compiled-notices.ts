import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readBoundedNoticeFile, safeNoticeRelative } from "./native-notices";

export interface CompiledPackageSource {
  name: string;
  version: string;
  license: string | null;
  files: { path: string; contents: Uint8Array }[];
}
export interface CompiledNoticeInput {
  graphs: { name: "desktop-host" | "hearth"; metadata: unknown }[];
  lock: unknown;
  readPackage: (root: string) => CompiledPackageSource;
}
export interface CompiledNoticeInventory {
  scope: string;
  packages: {
    name: string;
    version: string;
    license: string | null;
    integrity: string;
    graphs: string[];
    files: {
      path: string;
      contents: Uint8Array;
      bytes: number;
      sha256: string;
    }[];
  }[];
  holds: string[];
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const packageName = z
  .string()
  .max(200)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/);
const sourceSchema = z.object({
  name: packageName,
  version,
  license: z.string().max(512).nullable(),
  files: z
    .array(
      z.object({
        path: z.string().max(512),
        contents: z.instanceof(Uint8Array),
      }),
    )
    .max(256),
});
const lockSchema = z.object({
  packages: z.record(z.string(), z.array(z.unknown()).min(2).max(8)),
});
const graphImports = z
  .array(
    z.object({ path: z.string().max(4096), external: z.boolean().optional() }),
  )
  .max(10000);
const metadataSchema = z.object({
  inputs: z.record(
    z.string(),
    z.object({
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
      imports: graphImports.optional(),
    }),
  ),
  outputs: z
    .record(z.string(), z.object({ imports: graphImports.optional() }))
    .optional(),
});
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);
export function parseCompiledLock(source: string): unknown {
  if (Buffer.byteLength(source) > 2 * 1024 * 1024)
    throw Error("Compiled dependency lock size limit");
  try {
    return Bun.JSONC.parse(source);
  } catch {
    throw Error("Invalid compiled dependency lock");
  }
}
function legalFile(path: string): boolean {
  return (
    /^(LICENSE|LICENCE|COPYING|NOTICE)(?:[-_.].*)?$/i.test(
      path.split("/").at(-1) ?? "",
    ) || /^(licenses?|licences?)\//i.test(path)
  );
}
function packageRoot(id: string): { name: string; root: string } | null {
  if (id.length > 4096) throw Error("Compiled input path limit");
  const path = "/" + id.replaceAll("\\", "/"),
    marker = "/node_modules/",
    at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split("/");
  const name = parts[0]?.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  const checked = packageName.safeParse(name);
  if (!checked.success) throw Error("Unclassified installed package");
  return {
    name: checked.data,
    root: path.slice(1, at + marker.length) + checked.data,
  };
}
function sameOriginals(
  a: CompiledNoticeInventory["packages"][number],
  b: CompiledNoticeInventory["packages"][number],
): boolean {
  return (
    a.license === b.license &&
    a.integrity === b.integrity &&
    JSON.stringify(
      a.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    ) ===
      JSON.stringify(
        b.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      )
  );
}
function runtimeBuiltin(path: string): boolean {
  return (
    path === "bun" ||
    path.startsWith("bun:") ||
    builtins.has(path.replace(/^node:/, ""))
  );
}
function capturedRelative(
  path: string,
  importer: string,
  inputs: Set<string>,
): boolean {
  if (!path.startsWith("./") && !path.startsWith("../")) return false;
  const target = posix.normalize(
    posix.join(posix.dirname(importer.replaceAll("\\", "/")), path),
  );
  return [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    "/index.ts",
    "/index.js",
  ].some((suffix) => inputs.has(target + suffix));
}
export function collectCompiledNotices(
  input: CompiledNoticeInput,
): CompiledNoticeInventory {
  if (
    input.graphs.length !== 2 ||
    new Set(input.graphs.map((graph) => graph.name)).size !== 2 ||
    input.graphs.some(
      (graph) => graph.name !== "desktop-host" && graph.name !== "hearth",
    )
  )
    throw Error("Incomplete compiled graph set");
  const lock = lockSchema.parse(input.lock),
    identities = new Map<string, CompiledNoticeInventory["packages"][number]>(),
    roots = new Map<string, CompiledNoticeInventory["packages"][number]>();
  let totalBytes = 0;
  for (const graph of input.graphs) {
    const metadata = metadataSchema.parse(graph.metadata),
      entries = Object.entries(metadata.inputs);
    if (entries.length === 0 || entries.length > 10000)
      throw Error("Compiled graph input count");
    const inputs = new Set(
      entries.map(([id]) => posix.normalize(id.replaceAll("\\", "/"))),
    );
    for (const output of Object.values(metadata.outputs ?? {}))
      for (const imported of output.imports ?? []) {
        if (imported.external && !runtimeBuiltin(imported.path))
          throw Error("Unclassified emitted external dependency");
      }
    for (const [id, meta] of entries) {
      for (const imported of meta.imports ?? []) {
        if (
          imported.external &&
          !runtimeBuiltin(imported.path) &&
          !capturedRelative(imported.path, id, inputs)
        )
          throw Error("Unclassified external compiled dependency");
      }
      const parsed = packageRoot(id);
      if (!parsed) continue;
      const priorRoot = roots.get(parsed.root);
      if (priorRoot) {
        if (!priorRoot.graphs.includes(graph.name))
          priorRoot.graphs.push(graph.name);
        continue;
      }
      const source = sourceSchema.parse(input.readPackage(parsed.root));
      if (source.name !== parsed.name)
        throw Error("Compiled package root identity mismatch");
      const identity = source.name + "@" + source.version;
      const locked = Object.values(lock.packages).filter(
        (entry) => entry[0] === identity,
      );
      if (!locked.length || locked.some((entry) => entry[1] !== ""))
        throw Error("Unqualified compiled package source");
      const checksums = new Set(locked.map((entry) => entry.at(-1)));
      const integrity = [...checksums][0];
      if (
        checksums.size !== 1 ||
        typeof integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
      )
        throw Error("Missing or ambiguous compiled package integrity");
      const paths = new Set<string>(),
        files: CompiledNoticeInventory["packages"][number]["files"] = [];
      for (const file of [...source.files].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      )) {
        if (
          !safeNoticeRelative(file.path) ||
          !legalFile(file.path) ||
          paths.has(file.path) ||
          file.contents.length === 0 ||
          file.contents.length > 1024 * 1024
        )
          throw Error("Invalid original compiled legal file");
        paths.add(file.path);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          file.contents,
        );
        if (text.includes("\0")) throw Error("Non-text compiled legal file");
        totalBytes += file.contents.length;
        if (totalBytes > 16 * 1024 * 1024)
          throw Error("Compiled legal inventory size limit");
        files.push({
          path: file.path,
          contents: Uint8Array.from(file.contents),
          bytes: file.contents.length,
          sha256: sha(file.contents),
        });
      }
      const current = {
        name: source.name,
        version: source.version,
        license: source.license,
        integrity,
        graphs: [graph.name],
        files,
      };
      const existing = identities.get(identity);
      if (existing) {
        if (!sameOriginals(existing, current))
          throw Error("Conflicting installed package originals");
        if (!existing.graphs.includes(graph.name))
          existing.graphs.push(graph.name);
        roots.set(parsed.root, existing);
      } else {
        identities.set(identity, current);
        roots.set(parsed.root, current);
      }
      if (identities.size > 500) throw Error("Compiled package count limit");
    }
  }
  const packages = [...identities.values()].sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : a.version < b.version
            ? -1
            : a.version > b.version
              ? 1
              : 0,
    ),
    holds: string[] = [];
  for (const pkg of packages) {
    pkg.graphs.sort();
    if (!pkg.files.length)
      holds.push(pkg.name + "@" + pkg.version + ": no original legal files");
    if (!pkg.license?.trim())
      holds.push(
        pkg.name + "@" + pkg.version + ": no declared license expression",
      );
  }
  return {
    scope:
      "Observed Bun compile input graphs; conservative package set under a frozen install",
    packages,
    holds,
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(text(bytes));
  } catch {
    throw Error("Invalid compiled notice JSON");
  }
}
export function readCompiledPackage(
  root: string,
  repositoryRoot: string,
): CompiledPackageSource {
  const repository = resolve(repositoryRoot),
    lexical = resolve(repository, root),
    rel = relative(repository, lexical);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw Error("Foreign compiled package root");
  const source = realpathSync(lexical),
    stat = lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Invalid compiled package directory");
  const manifest = z
    .object({ name: packageName, version, license: z.unknown().optional() })
    .parse(
      json(readBoundedNoticeFile(join(source, "package.json"), 256 * 1024)),
    );
  const files: CompiledPackageSource["files"] = [];
  let visited = 0;
  const scan = (directory: string, prefix: string, depth: number) => {
    if (depth > 3) throw Error("Compiled legal directory depth limit");
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > 20000)
      throw Error("Compiled package directory size limit");
    for (const entry of entries) {
      const path = prefix + entry.name;
      const legal = legalFile(path),
        legalDirectory =
          /^(licenses?|licences?)$/i.test(entry.name) || prefix !== "";
      if (!legal && !legalDirectory) continue;
      if (++visited > 512 || !safeNoticeRelative(path))
        throw Error("Compiled legal path limit");
      const location = join(directory, entry.name),
        info = lstatSync(location);
      if (info.isSymbolicLink()) throw Error("Linked compiled legal source");
      if (info.isDirectory()) {
        if (legalDirectory) scan(location, path + "/", depth + 1);
      } else if (info.isFile() && legal) {
        if (files.length >= 256) throw Error("Compiled legal file count limit");
        files.push({
          path,
          contents: readBoundedNoticeFile(location, 1024 * 1024),
        });
      } else if (legal) throw Error("Invalid compiled legal source");
    }
  };
  scan(source, "", 0);
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === "string" ? manifest.license : null,
    files,
  };
}
type Provenance = {
  bunLockSha256: string;
  graphs: { name: string; sha256: string }[];
};
export function writeCompiledNoticeInventory(
  stage: string,
  inventory: CompiledNoticeInventory,
  provenance: Provenance,
): void {
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  hash.parse(provenance.bunLockSha256);
  if (
    provenance.graphs.length !== 2 ||
    new Set(provenance.graphs.map((graph) => graph.name)).size !== 2 ||
    provenance.graphs.some(
      (graph) => graph.name !== "desktop-host" && graph.name !== "hearth",
    )
  )
    throw Error("Invalid staged compiled graph set");
  for (const graph of provenance.graphs) hash.parse(graph.sha256);
  const stat = lstatSync(stage);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Invalid compiled notice stage");
  for (const pkg of inventory.packages) {
    packageName.parse(pkg.name);
    version.parse(pkg.version);
    for (const file of pkg.files)
      if (
        !safeNoticeRelative(file.path) ||
        !legalFile(file.path) ||
        file.contents.length !== file.bytes ||
        sha(file.contents) !== file.sha256
      )
        throw Error("Invalid staged compiled legal source");
  }
  const packages = inventory.packages.map((pkg) => ({
    ...pkg,
    files: pkg.files.map(({ contents, ...file }) => {
      const artifact =
        "legal/npm/" + pkg.name + "-" + pkg.version + "/" + file.path;
      const parts = artifact.split("/");
      let directory = resolve(stage);
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        try {
          mkdirSync(directory);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        }
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw Error("Linked compiled notice destination");
      }
      writeFileSync(join(stage, artifact), contents, { flag: "wx" });
      return { ...file, artifact };
    }),
  }));
  writeFileSync(
    join(stage, "COMPILED-DEPENDENCY-INVENTORY.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceVerification: "frozen-install-and-observed-bun-graphs",
        scope: inventory.scope,
        bunVersion: Bun.version,
        bunLockSha256: provenance.bunLockSha256,
        graphs: provenance.graphs,
        packages,
        coverage: inventory.holds.length ? "incomplete" : "recorded",
        releaseDisposition: "hold",
        holds: [
          ...inventory.holds,
          "Bun runtime notice and source-obligation qualification remains pending.",
          "Installer/NSIS notice qualification remains pending.",
        ],
        provenance:
          "Declared npm tarball integrity comes from Bun.lock; copied file hashes describe the frozen installed originals, not independent tarball re-attestation.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
export function writeCompiledDistributionNotices(
  stage: string,
  repositoryRoot: string,
  graphPaths: { name: "desktop-host" | "hearth"; path: string }[],
): void {
  const lockBytes = readBoundedNoticeFile(
    join(repositoryRoot, "bun.lock"),
    2 * 1024 * 1024,
  );
  const graphs = graphPaths.map((graph) => ({
    ...graph,
    bytes: readBoundedNoticeFile(graph.path, 10 * 1024 * 1024),
  }));
  const inventory = collectCompiledNotices({
    graphs: graphs.map((graph) => ({
      name: graph.name,
      metadata: json(graph.bytes),
    })),
    lock: parseCompiledLock(text(lockBytes)),
    readPackage: (root) => readCompiledPackage(root, repositoryRoot),
  });
  writeCompiledNoticeInventory(stage, inventory, {
    bunLockSha256: sha(lockBytes),
    graphs: graphs.map((graph) => ({
      name: graph.name,
      sha256: sha(graph.bytes),
    })),
  });
}
