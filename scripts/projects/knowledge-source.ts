import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { windowsConfigLeafKind } from "../config/transaction-windows";
import { isSensitivePath, sanitizeContent } from "../council/context";
import { ageInDays, freshnessFor } from "../dashboard/repos-knowledge-model";
import { buildChildEnv } from "../executors/env";
import { type GitRun, mainCheckoutOf } from "../scheduler/worktrees";
import { canonicalTrustedDirectory } from "../trusted-directory";
import { checkedKnowledgeData, KNOWLEDGE_LIMITS } from "./knowledge-protocol";
import { workspaceKey } from "./scope";

type KnowledgeGitSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    windowsHide: true;
    timeout: number;
    maxBuffer: number;
    encoding: "utf8";
  },
) => { status: number | null; stdout: string; stderr: string; error?: unknown };
const READ_COMMANDS = new Set(
  [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["rev-parse", "--verify", "HEAD"],
    ["ls-files", "--cached", "-z"],
    [
      "log",
      "-10",
      "--no-show-signature",
      "--no-decorate",
      "--format=%H%x09%aI%x09%s",
    ],
  ].map((args) => JSON.stringify(args)),
);
/** Fixed metadata commands, without ambient Git redirects, fsmonitor, hooks, paging or auto maintenance. */
export function createKnowledgeGit(
  options: {
    environment?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    spawn?: KnowledgeGitSpawn;
  } = {},
): GitRun {
  const platform = options.platform ?? process.platform,
    env = buildChildEnv(options.environment ?? process.env, []),
    nullFile = platform === "win32" ? "NUL" : "/dev/null";
  for (const key of Object.keys(env))
    if (/^git_|^agent_forge_/i.test(key)) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullFile,
    GIT_CONFIG_GLOBAL: nullFile,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  });
  const spawn: KnowledgeGitSpawn =
    options.spawn ??
    ((command, args, input) => spawnSync(command, [...args], input));
  return (args, cwd, timeoutMs = 5000) => {
    if (!READ_COMMANDS.has(JSON.stringify(args)))
      return {
        status: null,
        stdout: "",
        stderr: "Unsupported knowledge metadata command",
      };
    const result = spawn(
      "git",
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${nullFile}`,
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      {
        cwd,
        env: { ...env },
        windowsHide: true,
        timeout: Math.min(5000, timeoutMs),
        maxBuffer: 512 * 1024,
        encoding: "utf8",
      },
    );
    return {
      status: result.error ? null : result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
const knowledgeGit = createKnowledgeGit();

export const knowledgeDigest = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const identity = (info: { dev: bigint; ino: bigint }) => ({
  dev: String(info.dev),
  ino: String(info.ino),
});
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const safeRelative = (path: string) =>
  path.length > 0 &&
  path.length <= 1024 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !/^[a-z]:/i.test(path) &&
  !/[\p{Cc}\p{Cs}]/u.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
function directory(path: string) {
  const checked = canonicalTrustedDirectory(path),
    info = lstatSync(checked, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("The trusted knowledge directory is unavailable");
  return { path: checked, ...identity(info) };
}
function parentAnchor(path: string) {
  let cursor = dirname(path);
  for (;;) {
    try {
      return directory(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}
function leaf(path: string) {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    (process.platform === "win32" && windowsConfigLeafKind(path) !== "plain")
  )
    throw Error(
      "A linked, unverified or non-file knowledge source was refused",
    );
  return info;
}
function metadata(info: ReturnType<typeof leaf>) {
  return {
    ...identity(info),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
    nlink: String(info.nlink),
  };
}
export interface KnowledgeFileSnapshot {
  file: string;
  parent: { path: string; dev: string; ino: string };
  leaf: ReturnType<typeof metadata> | null;
  bytes: string | null;
  hash: string | null;
  mtimeMs: number | null;
}
export class KnowledgeFileTooLarge extends Error {}
/** Descriptor identity and canonical parents are rechecked before any retained bytes can be sent. */
export function captureKnowledgeFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): KnowledgeFileSnapshot {
  if (!safeRelative(relativePath))
    throw Error("Unsafe knowledge source selector");
  const rootBefore = directory(root),
    file = join(rootBefore.path, ...relativePath.split("/")),
    parent = parentAnchor(file);
  if (
    workspaceKey(canonicalTrustedDirectory(dirname(file))) !==
    workspaceKey(dirname(file))
  )
    throw Error("Knowledge parents changed their canonical address");
  let fd: number | undefined,
    present = false;
  try {
    const before = leaf(file);
    present = true;
    if (before.size > BigInt(maxBytes))
      throw new KnowledgeFileTooLarge("A source exceeds its byte limit");
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!equal(metadata(before), metadata(opened)) || !opened.isFile())
      throw Error("Knowledge source identity changed before read");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes)
      throw new KnowledgeFileTooLarge(
        "Knowledge source exceeded its bound during read",
      );
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd, { bigint: true }),
      named = leaf(file);
    if (
      !equal(metadata(opened), metadata(after)) ||
      !equal(metadata(after), metadata(named)) ||
      !equal(directory(rootBefore.path), rootBefore) ||
      !equal(parentAnchor(file), parent)
    )
      throw Error("Knowledge source changed during its verified read");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      file,
      parent,
      leaf: metadata(after),
      bytes: text,
      hash: knowledgeDigest(bytes),
      mtimeMs: Number(after.mtimeNs) / 1_000_000,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || present)
      throw error;
    if (
      !equal(parentAnchor(file), parent) ||
      !equal(directory(rootBefore.path), rootBefore)
    )
      throw Error("Knowledge absence changed during verification");
    return { file, parent, leaf: null, bytes: null, hash: null, mtimeMs: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type Authority = {
  root: ReturnType<typeof directory>;
  main: ReturnType<typeof directory>;
};
function authority(root: string, git: GitRun): Authority {
  const physical = directory(root),
    top = git(["rev-parse", "--show-toplevel"], physical.path, 5000),
    mainPath = mainCheckoutOf(physical.path, git);
  if (
    top.status !== 0 ||
    workspaceKey(top.stdout.trim()) !== workspaceKey(physical.path) ||
    !mainPath
  )
    throw Error("The served repository identity could not be verified");
  const main = directory(mainPath),
    mainTop = git(["rev-parse", "--show-toplevel"], main.path, 5000);
  const marker = lstatSync(join(main.path, ".git"));
  if (
    !marker.isDirectory() ||
    marker.isSymbolicLink() ||
    mainTop.status !== 0 ||
    workspaceKey(mainTop.stdout.trim()) !== workspaceKey(main.path)
  )
    throw Error("The served main checkout could not be verified");
  if (
    !equal(directory(physical.path), physical) ||
    !equal(directory(main.path), main)
  )
    throw Error("Served repository identity changed");
  return { root: physical, main };
}
export interface KnowledgeTarget {
  readonly root: string;
  readonly name: string;
  readonly repositoryKey: string;
  readonly file: string;
}
const targets = new WeakMap<
  KnowledgeTarget,
  { authority: Authority; git: GitRun }
>();
/** Only trusted host code calls this with its served checkout. Neither wire paths nor stored labels are authority. */
export function resolveKnowledgeTarget(
  root: string,
  git: GitRun = knowledgeGit,
): KnowledgeTarget {
  const found = authority(root, git),
    name = basename(found.main.path);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw Error("The served repository has no supported knowledge name");
  const target = Object.freeze({
    root: found.main.path,
    name,
    repositoryKey: knowledgeDigest(
      JSON.stringify({
        family: "project-knowledge-repository",
        version: 1,
        root: workspaceKey(found.main.path),
      }),
    ),
    file: join(found.main.path, "knowledge", "repos", `${name}.yaml`),
  });
  targets.set(target, { authority: found, git });
  return target;
}
export function verifyKnowledgeTarget(target: KnowledgeTarget) {
  const context = targets.get(target);
  if (
    !context ||
    !equal(
      authority(context.authority.root.path, context.git),
      context.authority,
    )
  )
    throw Error("The original served repository authority changed");
}

export function readKnowledgeTarget(
  target: KnowledgeTarget,
  now: number = Date.now(),
) {
  verifyKnowledgeTarget(target);
  const snapshot = captureKnowledgeFile(
    target.root,
    `knowledge/repos/${target.name}.yaml`,
    KNOWLEDGE_LIMITS.documentBytes,
  );
  let prior: Record<string, unknown> | null = null;
  if (snapshot.bytes !== null) {
    const parsed = parseDocument(snapshot.bytes, { uniqueKeys: true });
    if (parsed.errors.length || parsed.warnings.length)
      throw Error(
        "Existing knowledge is malformed or uses unsupported YAML tags",
      );
    try {
      prior = checkedKnowledgeData(parsed.toJS({ maxAliasCount: 0 }));
    } catch {
      throw Error(
        "Existing knowledge has unsupported aliases or non-data extensions",
      );
    }
  }
  verifyKnowledgeTarget(target);
  const ageDays = ageInDays(snapshot.mtimeMs, now);
  return {
    state:
      snapshot.bytes === null ? ("missing" as const) : ("present" as const),
    ageDays,
    freshness: freshnessFor(ageDays),
    snapshot,
    prior,
  };
}

export interface KnowledgeEvidenceFile {
  id: string;
  path: string;
  hash: string;
  text: string;
  redactions: readonly { kind: string; count: number }[];
  identity: NonNullable<KnowledgeFileSnapshot["leaf"]>;
}
export interface KnowledgeSource {
  version: 1;
  repositoryKey: string;
  name: string;
  sourceCommit: string;
  evidenceHash: string;
  files: KnowledgeEvidenceFile[];
  structure: string[];
  recentChanges: string[];
  omitted: string[];
}
const ignored = (path: string) =>
  isSensitivePath(path) ||
  path
    .toLowerCase()
    .split("/")
    .some(
      (part) =>
        [
          ".git",
          ".codex",
          ".aws",
          ".agent-forge",
          ".tmp",
          "node_modules",
          "trees",
          "knowledge",
        ].includes(part) ||
        part.startsWith(".env") ||
        /\.(pem|key|pfx|p12)$/i.test(part),
    );
const eligible = (path: string) =>
  !ignored(path) &&
  (/\.(md|json|toml|yaml|yml|ts|tsx|js|jsx|mjs|cjs|rs|py|go)$/i.test(path) ||
    ["Makefile", "Dockerfile"].includes(basename(path))) &&
  !/(^|\/)(package-lock\.json|bun\.lock|.*\.lock|.*\.test\.[^/]+|.*\.spec\.[^/]+)$/.test(
    path,
  );
const priority = (path: string) =>
  /^(README(?:\.md)?|AGENTS\.md|CONTRIBUTING\.md|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|tsconfig\.json|bunfig\.toml)$/i.test(
    path,
  )
    ? 0
    : /(^|\/)(index|main|server|app|cli)\.[^/]+$/i.test(path)
      ? 1
      : 2;
/** Fixed read-only Git invocations and bounded tracked files; model output never selects a read. */
export function collectKnowledgeSource(
  target: KnowledgeTarget,
  git: GitRun = knowledgeGit,
): KnowledgeSource {
  verifyKnowledgeTarget(target);
  const checkedGit = (args: readonly string[], maxBytes: number) => {
    const result = git(args, target.root, 5000);
    if (result.status !== 0 || Buffer.byteLength(result.stdout) > maxBytes)
      throw Error("A bounded knowledge Git read was unavailable");
    return result.stdout;
  };
  const sourceCommit = checkedGit(
    ["rev-parse", "--verify", "HEAD"],
    256,
  ).trim();
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(sourceCommit))
    throw Error(
      "A committed source identity is required for knowledge refresh",
    );
  const listed = checkedGit(["ls-files", "--cached", "-z"], 512 * 1024);
  if (listed && !listed.endsWith("\0"))
    throw Error("The tracked source listing was incomplete");
  const paths = listed ? listed.slice(0, -1).split("\0") : [];
  if (
    paths.length > KNOWLEDGE_LIMITS.entries ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !safeRelative(path))
  )
    throw Error(
      "The complete tracked source listing exceeded its verified bound",
    );
  const candidates = paths
      .filter(eligible)
      .sort(
        (a, b) => priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0),
      ),
    files: KnowledgeEvidenceFile[] = [],
    omitted: string[] = [];
  let bytes = 0;
  for (const path of candidates) {
    if (files.length >= KNOWLEDGE_LIMITS.sourceFiles) {
      omitted.push(`${path}: file limit`);
      continue;
    }
    let snapshot: KnowledgeFileSnapshot;
    try {
      snapshot = captureKnowledgeFile(
        target.root,
        path,
        KNOWLEDGE_LIMITS.fileBytes,
      );
    } catch (error) {
      if (error instanceof KnowledgeFileTooLarge) {
        omitted.push(`${path}: byte limit`);
        continue;
      }
      throw error;
    }
    if (snapshot.bytes === null || !snapshot.hash || !snapshot.leaf)
      throw Error("A retained tracked knowledge source is missing");
    const sanitized = sanitizeContent(snapshot.bytes, "redact"),
      size = Buffer.byteLength(sanitized.text);
    if (bytes + size > KNOWLEDGE_LIMITS.sourceBytes) {
      omitted.push(`${path}: aggregate byte limit`);
      continue;
    }
    bytes += size;
    files.push({
      id: `E${files.length + 1}`,
      path,
      hash: snapshot.hash,
      text: sanitized.text,
      redactions: sanitized.redactions,
      identity: snapshot.leaf,
    });
  }
  const recent = checkedGit(
    [
      "log",
      "-10",
      "--no-show-signature",
      "--no-decorate",
      "--format=%H%x09%aI%x09%s",
    ],
    16 * 1024,
  ).trim();
  const recentChanges = recent
    ? recent.split(/\r?\n/).map((line) => {
        const [commit, date, ...subject] = line.split("\t");
        if (
          !commit ||
          !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit) ||
          !date ||
          !Number.isFinite(Date.parse(date)) ||
          !subject.length
        )
          throw Error("Recent commit metadata was incomplete");
        return sanitizeContent(
          `${commit}: ${subject.join("\t")} (${date})`,
          "redact",
        ).text;
      })
    : [];
  if (
    checkedGit(["rev-parse", "--verify", "HEAD"], 256).trim() !== sourceCommit
  )
    throw Error("Source HEAD changed during knowledge collection");
  verifyKnowledgeTarget(target);
  const structure = [
    ...new Set(
      paths
        .filter((path) => !ignored(path))
        .map((path) =>
          path.split("/").slice(0, KNOWLEDGE_LIMITS.depth).join("/"),
        ),
    ),
  ].sort();
  const value = {
    version: 1 as const,
    repositoryKey: target.repositoryKey,
    name: target.name,
    sourceCommit,
    files,
    structure,
    recentChanges,
    omitted,
  };
  if (Buffer.byteLength(JSON.stringify(value)) > 384 * 1024)
    throw Error(
      "The complete knowledge source manifest exceeds its aggregate bound",
    );
  return { ...value, evidenceHash: knowledgeDigest(JSON.stringify(value)) };
}
