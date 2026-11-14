import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  type ProjectCheckpointSourceVersion,
  projectCheckpointSourceVersionSchema,
} from "../../types/project-checkpoint-submissions";
import { windowsConfigLeafKind } from "../config/transaction-windows";
import { ConversationError } from "../conversations/error";
import { buildChildEnv } from "../executors/env";
import { nativeWindowsAcl } from "../hearth/acl-windows";
import { canonicalTrustedDirectory } from "../trusted-directory";
import { comparableCheckout } from "./runs";

export type CheckpointCaptureChild = {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: NodeJS.Signals): boolean;
};
export type CheckpointCaptureSpawn = (
  command: "git",
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: true;
    timeout: number;
    killSignal: "SIGKILL";
    signal: AbortSignal;
  },
) => CheckpointCaptureChild;
const RESULT_DEADLINE_MS = 5000;
const MAX_BYTES = 16 * 1024;
const unavailable = () =>
  new ConversationError(503, "The committed checkpoint source is unavailable.");
type Directory = { path: string; dev: bigint; ino: bigint };
function directory(path: string): Directory {
  const checked = canonicalTrustedDirectory(path);
  const info = lstatSync(checked, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n)
    throw unavailable();
  return { path: checked, dev: info.dev, ino: info.ino };
}
function sameDirectory(a: Directory, b: Directory) {
  return (
    comparableCheckout(a.path) === comparableCheckout(b.path) &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}
function fileIdentity(info: BigIntStats) {
  return [info.dev, info.ino, info.nlink, info.size, info.mtimeNs, info.ctimeNs]
    .map(String)
    .join(":");
}
function pointerFile(parent: Directory, name: ".git" | "commondir") {
  const file = join(parent.path, name);
  const before = (() => {
    try {
      return lstatSync(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })();
  if (before === null) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.ino === 0n ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(MAX_BYTES)
  )
    throw unavailable();
  let bytes: Uint8Array;
  if (process.platform === "win32") {
    if (windowsConfigLeafKind(file) !== "plain") throw unavailable();
    const reader = nativeWindowsAcl().readInFolder;
    if (!reader) throw unavailable();
    const found = reader(parent.path, name, MAX_BYTES);
    if (!found?.file) throw unavailable();
    bytes = found.file.bytes;
  } else {
    if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0)
      throw unavailable();
    let fd: number | undefined;
    try {
      fd = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      if (
        fileIdentity(fstatSync(fd, { bigint: true })) !== fileIdentity(before)
      )
        throw unavailable();
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (count === 0) break;
        length += count;
      }
      if (
        fileIdentity(fstatSync(fd, { bigint: true })) !== fileIdentity(before)
      )
        throw unavailable();
      bytes = buffer.subarray(0, length);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const after = lstatSync(file, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1n ||
    fileIdentity(after) !== fileIdentity(before) ||
    bytes.length !== Number(before.size) ||
    (process.platform === "win32" && windowsConfigLeafKind(file) !== "plain")
  )
    throw unavailable();
  return {
    bytes,
    identity: JSON.stringify([
      name,
      fileIdentity(before),
      createHash("sha256").update(bytes).digest("hex"),
    ]),
  };
}
function directoryIdentity(found: Directory) {
  return [comparableCheckout(found.path), String(found.dev), String(found.ino)];
}
function repository(root: Directory) {
  const named = lstatSync(join(root.path, ".git"), { bigint: true });
  let gitdir: Directory;
  let gitIdentity: string;
  if (named.isDirectory() && !named.isSymbolicLink()) {
    gitdir = directory(join(root.path, ".git"));
    gitIdentity = JSON.stringify(["directory", ...directoryIdentity(gitdir)]);
  } else {
    const pointer = pointerFile(root, ".git");
    if (!pointer) throw unavailable();
    const value = line(pointer.bytes);
    if (!value.startsWith("gitdir: ") || value.length <= 8) throw unavailable();
    gitdir = directory(resolve(root.path, value.slice(8)));
    gitIdentity = pointer.identity;
  }
  const commonPointer = pointerFile(gitdir, "commondir");
  const common = commonPointer
    ? directory(resolve(gitdir.path, line(commonPointer.bytes)))
    : gitdir;
  return {
    gitdir,
    common,
    identity: JSON.stringify([
      gitIdentity,
      commonPointer?.identity ?? null,
      directoryIdentity(gitdir),
      directoryIdentity(common),
    ]),
  };
}

function line(bytes: Uint8Array): string {
  let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (
    !text ||
    text.startsWith("\uFEFF") ||
    text.length > 4096 ||
    /[\p{Cc}\p{Cs}]/u.test(text)
  )
    throw unavailable();
  return text;
}

export function createProjectCheckpointSourceCapture(
  checkout: string,
  options: {
    spawn?: CheckpointCaptureSpawn;
    environment?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
) {
  try {
    return createCapture(checkout, options);
  } catch {
    throw unavailable();
  }
}
function createCapture(
  checkout: string,
  options: Parameters<typeof createProjectCheckpointSourceCapture>[1],
) {
  const selected = resolve(checkout);
  const root = directory(selected);
  const repo = repository(root);
  const clock = options?.now ?? (() => performance.now());
  const spawnPort: CheckpointCaptureSpawn =
    options?.spawn ??
    ((command, args, input) => spawn(command, [...args], input));
  const env = buildChildEnv(options?.environment ?? process.env, []);
  for (const key of Object.keys(env))
    if (/^(git_|agent_forge_)/i.test(key)) delete env[key];
  const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullFile,
    GIT_CONFIG_GLOBAL: nullFile,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_COMMON_DIR: repo.common.path,
  });
  Object.freeze(env);
  const prefix = [
    "--git-dir=" + repo.gitdir.path,
    "--work-tree=" + root.path,
    "--no-pager",
    "--no-replace-objects",
    "--no-lazy-fetch",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=" + nullFile,
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "submodule.recurse=false",
  ];
  const jobs = new Set<AbortController>();
  const pending = new Set<Promise<ProjectCheckpointSourceVersion>>();
  let closing = false;
  function checkRoot() {
    if (
      !sameDirectory(directory(selected), root) ||
      repository(root).identity !== repo.identity
    )
      throw unavailable();
  }
  async function work(
    controller: AbortController,
    timing: { start: number; last: number },
  ): Promise<ProjectCheckpointSourceVersion> {
    const { start } = timing;
    const directories: Directory[] = [repo.gitdir, repo.common];
    function observe() {
      const current = clock();
      if (
        !Number.isFinite(current) ||
        current < timing.last ||
        current - start >= RESULT_DEADLINE_MS ||
        closing ||
        controller.signal.aborted
      )
        throw unavailable();
      timing.last = current;
      return Math.max(1, Math.floor(RESULT_DEADLINE_MS - (current - start)));
    }
    function check() {
      observe();
      checkRoot();
      for (const found of directories)
        if (!sameDirectory(directory(found.path), found)) throw unavailable();
      return observe();
    }

    async function read(args: readonly string[]): Promise<string> {
      const remaining = check();
      const value = await new Promise<Uint8Array>((accept, reject) => {
        let child: ReturnType<CheckpointCaptureSpawn>;
        try {
          child = spawnPort("git", [...prefix, ...args], {
            cwd: root.path,
            env: { ...env },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            timeout: remaining,
            killSignal: "SIGKILL",
            signal: controller.signal,
          });
        } catch {
          reject(unavailable());
          return;
        }
        let failed = false;
        let length = 0;
        const chunks: Buffer[] = [];
        let stopRequested = false;
        const stop = () => {
          if (stopRequested) return;
          stopRequested = true;
          try {
            child.kill("SIGKILL");
          } catch {
            failed = true;
          }
        };
        const fail = () => {
          failed = true;
          stop();
        };
        child.on("error", fail);
        child.once("close", (code, signal) => {
          if (
            failed ||
            code !== 0 ||
            signal !== null ||
            controller.signal.aborted
          )
            reject(unavailable());
          else accept(Buffer.concat(chunks, length));
        });
        if (!child.stdout || !child.stderr) fail();
        child.stdout?.on("data", (chunk: unknown) => {
          if (!(chunk instanceof Uint8Array)) {
            fail();
            return;
          }
          if (failed) return;
          length += chunk.byteLength;
          if (length > MAX_BYTES) {
            fail();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        child.stderr?.on("data", (chunk: unknown) => {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength !== 0) fail();
        });
        child.stdout?.on("error", fail);
        child.stderr?.on("error", fail);
        if (controller.signal.aborted) stop();
      });
      check();
      return line(value);
    }
    const top = directory(
      await read(["rev-parse", "--path-format=absolute", "--show-toplevel"]),
    );
    if (!sameDirectory(top, root)) throw unavailable();
    const gitdir = directory(await read(["rev-parse", "--absolute-git-dir"]));
    if (!sameDirectory(gitdir, repo.gitdir)) throw unavailable();
    const common = directory(
      await read(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    if (!sameDirectory(common, repo.common)) throw unavailable();
    if ((await read(["rev-parse", "--show-object-format"])) !== "sha1")
      throw unavailable();
    const commit = await read([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);
    if (!/^[a-f0-9]{40}$/.test(commit) || commit === "0".repeat(40))
      throw unavailable();
    const tree = await read([
      "rev-parse",
      "--verify",
      "--end-of-options",
      commit + "^{tree}",
    ]);
    const source = projectCheckpointSourceVersionSchema.parse({
      kind: "committed-git-snapshot",
      commit,
      tree,
    });
    if (
      (await read([
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
      ])) !== commit ||
      !sameDirectory(
        directory(
          await read([
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
          ]),
        ),
        root,
      ) ||
      !sameDirectory(
        directory(await read(["rev-parse", "--absolute-git-dir"])),
        gitdir,
      ) ||
      !sameDirectory(
        directory(
          await read([
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
        ),
        common,
      ) ||
      (await read(["rev-parse", "--show-object-format"])) !== "sha1"
    )
      throw unavailable();
    check();
    return Object.freeze(source);
  }
  return {
    capture(): Promise<ProjectCheckpointSourceVersion> {
      if (closing) return Promise.reject(unavailable());
      let start: number;
      try {
        start = clock();
        if (!Number.isFinite(start)) throw unavailable();
      } catch {
        return Promise.reject(unavailable());
      }
      const timing = { start, last: start };
      const controller = new AbortController();
      jobs.add(controller);
      const deadline = setTimeout(() => controller.abort(), RESULT_DEADLINE_MS);
      const task = Promise.resolve()
        .then(() => work(controller, timing))
        .then((source) => {
          const completed = clock();
          if (
            !Number.isFinite(completed) ||
            completed < timing.last ||
            completed - start >= RESULT_DEADLINE_MS ||
            closing ||
            controller.signal.aborted
          )
            throw unavailable();
          timing.last = completed;
          return source;
        })
        .catch(() => {
          throw unavailable();
        })
        .finally(() => {
          clearTimeout(deadline);
          jobs.delete(controller);
          pending.delete(task);
          if (closing || controller.signal.aborted) throw unavailable();
        });
      pending.add(task);
      return task;
    },
    async close(): Promise<void> {
      closing = true;
      for (const controller of jobs) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
