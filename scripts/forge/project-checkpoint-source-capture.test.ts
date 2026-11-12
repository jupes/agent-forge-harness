import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { projectCheckpointSourceVersionSchema } from "../../types/project-checkpoint-submissions";
import { canonicalTrustedDirectory } from "../trusted-directory";
import {
  type CheckpointCaptureSpawn,
  createProjectCheckpointSourceCapture,
} from "./project-checkpoint-source-capture";

const bases: string[] = [];
const captures: ReturnType<typeof createProjectCheckpointSourceCapture>[] = [];
function removeOwned(base: string, target = base) {
  const allocated = resolve(base),
    checked = resolve(target);
  if (
    dirname(allocated) !== resolve(tmpdir()) ||
    !basename(allocated).startsWith("checkpoint-capture-")
  )
    throw Error("Unexpected fixture root");
  if (checked !== allocated && !checked.startsWith(allocated + sep))
    throw Error("Fixture cleanup escaped its root");
  rmSync(checked, { recursive: true, force: true, maxRetries: 3 });
}
afterEach(async () => {
  await Promise.allSettled(
    captures.splice(0).map((capture) => capture.close()),
  );
  for (const base of bases.splice(0)) removeOwned(base);
});
class InertGitChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number> = [];
  finish(
    output: string | Uint8Array = "",
    code: number | null = 0,
    errorOutput: string | Uint8Array = "",
  ) {
    this.stdout.end(output);
    this.stderr.end(errorOutput);
    this.emit("exit", code, null);
    queueMicrotask(() => this.emit("close", code, null));
  }
  kill(signal: NodeJS.Signals | number = "SIGTERM") {
    this.signals.push(signal);
    queueMicrotask(() => this.finish("", null));
    return true;
  }
}
function fixture(linked = false) {
  const base = mkdtempSync(join(tmpdir(), "checkpoint-capture-"));
  bases.push(base);
  const checkout = join(base, "repo");
  mkdirSync(checkout);
  const gitdir = linked
    ? join(base, "metadata", "worktree")
    : join(checkout, ".git");
  const common = linked ? join(base, "metadata", "common") : gitdir;
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(common, { recursive: true });
  if (linked) {
    writeFileSync(
      join(checkout, ".git"),
      "gitdir: " + gitdir.replaceAll("\\", "/") + "\n",
    );
    writeFileSync(
      join(gitdir, "commondir"),
      common.replaceAll("\\", "/") + "\n",
    );
  }
  const commit = "b".repeat(40),
    tree = "c".repeat(40);
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: Parameters<CheckpointCaptureSpawn>[2];
    child: InertGitChild;
  }> = [];
  const output = (args: readonly string[]) => {
    const index = args.indexOf("rev-parse");
    if (index < 0) throw Error("Expected fixed metadata command");
    const flags = args.slice(index + 1);
    const key = flags.join(" ");
    if (key === "--path-format=absolute --show-toplevel")
      return checkout + "\n";
    if (key === "--absolute-git-dir") return gitdir + "\n";
    if (key === "--path-format=absolute --git-common-dir") return common + "\n";
    if (key === "--show-object-format") return "sha1\n";
    if (key === "--verify --end-of-options HEAD^{commit}") return commit + "\n";
    if (key === "--verify --end-of-options " + commit + "^{tree}")
      return tree + "\n";
    throw Error("Unexpected metadata arguments");
  };
  const behavior: {
    output: (
      value: string,
      args: readonly string[],
      index: number,
    ) => string | Uint8Array;
  } = { output: (value) => value };
  const spawn: CheckpointCaptureSpawn = (command, args, options) => {
    const child = new InertGitChild();
    calls.push({ command, args: [...args], options, child });
    const index = calls.length;
    queueMicrotask(() =>
      child.finish(behavior.output(output(args), args, index)),
    );
    return child;
  };
  const create = (
    override: Parameters<typeof createProjectCheckpointSourceCapture>[1] = {},
  ) => {
    const capture = createProjectCheckpointSourceCapture(checkout, {
      spawn,
      ...override,
    });
    captures.push(capture);
    return capture;
  };
  return {
    base,
    checkout,
    gitdir,
    common,
    commit,
    tree,
    calls,
    spawn,
    output,
    create,
    behavior,
  };
}

test("existing directory and strict committed-source schema controls are valid", () => {
  const f = fixture();
  expect(canonicalTrustedDirectory(f.checkout)).toBeTruthy();
  expect(
    projectCheckpointSourceVersionSchema.safeParse({
      kind: "committed-git-snapshot",
      commit: f.commit,
      tree: f.tree,
    }).success,
  ).toBe(true);
});

test("capture returns the exact committed snapshot through a pinned inert metadata boundary", async () => {
  const f = fixture();
  expect(await f.create().capture()).toEqual({
    kind: "committed-git-snapshot",
    commit: f.commit,
    tree: f.tree,
  });
  expect(f.calls.length).toBeGreaterThan(0);
});

test("an errored live child is stopped once and remains owned until CLOSE", async () => {
  const f = fixture();
  class HeldChild extends InertGitChild {
    override kill(signal: NodeJS.Signals | number = "SIGTERM") {
      this.signals.push(signal);
      this.emit("error", Error("private kill error sentinel"));
      return true;
    }
  }
  const child = new HeldChild();
  let entered = () => {};
  const observed = new Promise<void>((accept) => {
    entered = accept;
  });
  const owner = f.create({
    spawn: () => {
      entered();
      return child;
    },
  });
  let settled = false,
    closed = false;
  let failure: unknown;
  const pending = owner.capture().then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      failure = error;
      settled = true;
    },
  );
  await observed;
  child.emit("error", Error("private child error sentinel"));
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  try {
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(settled).toBe(false);
    expect(closed).toBe(false);
  } finally {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGKILL");
    await pending;
    await closing;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw Error("Expected fixed source refusal");
  expect(failure.message).toBe(
    "The committed checkpoint source is unavailable.",
  );
});

test("a leading UTF8 BOM is rejected rather than normalized in metadata", async () => {
  for (const field of ["format", "commit", "tree"] as const) {
    const f = fixture();
    const owner = f.create({
      spawn: (_command, args) => {
        const child = new InertGitChild();
        queueMicrotask(() => {
          const text = f.output(args);
          const selected =
            field === "format"
              ? args.includes("--show-object-format")
              : field === "commit"
                ? args.includes("HEAD^{commit}")
                : args.includes(f.commit + "^{tree}");
          child.finish(
            selected
              ? Buffer.concat([
                  Buffer.from([0xef, 0xbb, 0xbf]),
                  Buffer.from(text),
                ])
              : text,
          );
        });
        return child;
      },
    });
    await expect(owner.capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
  }
});

test("consistently wrong first Git and common directory reports cannot choose repository identity", async () => {
  for (const field of ["gitdir", "common"] as const) {
    const f = fixture();
    const wrong = join(f.base, "wrong-metadata");
    mkdirSync(wrong);
    const owner = f.create({
      spawn: (_command, args) => {
        const child = new InertGitChild();
        queueMicrotask(() =>
          child.finish(
            (
              field === "gitdir"
                ? args.includes("--absolute-git-dir")
                : args.includes("--git-common-dir")
            )
              ? wrong + "\n"
              : f.output(args),
          ),
        );
        return child;
      },
    });
    await expect(owner.capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
  }
});

function moveOwned(base: string, source: string, destination: string) {
  const allocated = resolve(base);
  if (
    dirname(allocated) !== resolve(tmpdir()) ||
    !basename(allocated).startsWith("checkpoint-capture-")
  )
    throw Error("Unexpected fixture root");
  const from = resolve(source),
    to = resolve(destination);
  if (!from.startsWith(allocated + sep) || !to.startsWith(allocated + sep))
    throw Error("Fixture move escaped its root");
  renameSync(from, to);
}

test("normal and linked layouts pin exact directories without reading dirty or untracked files", async () => {
  for (const linked of [false, true]) {
    const f = fixture(linked);
    if (linked) {
      writeFileSync(join(f.checkout, ".git"), "gitdir: ../metadata/worktree\n");
      writeFileSync(join(f.gitdir, "commondir"), "../common\n");
    }
    const working = join(f.checkout, "uncommitted.txt"),
      untracked = join(f.checkout, "untracked.txt");
    writeFileSync(working, "uncommitted private content");
    writeFileSync(untracked, "untracked private content");
    const owner = f.create();
    const source = await owner.capture();
    expect(source).toEqual({
      kind: "committed-git-snapshot",
      commit: f.commit,
      tree: f.tree,
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.keys(source).sort()).toEqual(["commit", "kind", "tree"]);
    expect(await owner.capture()).toEqual(source);
    expect(readFileSync(working, "utf8")).toBe("uncommitted private content");
    expect(readFileSync(untracked, "utf8")).toBe("untracked private content");
  }
});

test("fixed Git invocation strips ambient redirects and binds only constructor-owned paths", async () => {
  const f = fixture();
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_DIR: "private redirect",
    git_work_tree: "private tree",
    GIT_COMMON_DIR: "private common",
    GIT_CONFIG_COUNT: "4",
    AGENT_FORGE_HOME: "private home",
    PRIVATE_CAPTURE_SECRET: "private token",
  };
  const before = { ...environment };
  const owner = f.create({ environment });
  expect(f.calls).toEqual([]);
  await owner.capture();
  expect(environment).toEqual(before);
  const allowed = new Set([
    "--path-format=absolute --show-toplevel",
    "--absolute-git-dir",
    "--path-format=absolute --git-common-dir",
    "--show-object-format",
    "--verify --end-of-options HEAD^{commit}",
    "--verify --end-of-options " + f.commit + "^{tree}",
  ]);
  for (const call of f.calls) {
    expect(call.command).toBe("git");
    expect(call.args).toContain(
      "--git-dir=" + canonicalTrustedDirectory(f.gitdir),
    );
    expect(call.args).toContain(
      "--work-tree=" + canonicalTrustedDirectory(f.checkout),
    );
    expect(call.args).toContain("--no-lazy-fetch");
    expect(call.args).toContain("--no-replace-objects");
    expect(call.args).toContain("--no-optional-locks");
    expect(call.args).toContain("core.fsmonitor=false");
    expect(call.args).toContain("maintenance.auto=false");
    expect(
      allowed.has(
        call.args.slice(call.args.indexOf("rev-parse") + 1).join(" "),
      ),
    ).toBe(true);
    expect(call.options.cwd).toBe(canonicalTrustedDirectory(f.checkout));
    expect(call.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.killSignal).toBe("SIGKILL");
    expect(call.options.timeout).toBeGreaterThan(0);
    expect(call.options.timeout).toBeLessThanOrEqual(5000);
    expect(call.options.env.GIT_DIR).toBeUndefined();
    expect(call.options.env.git_work_tree).toBeUndefined();
    expect(call.options.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(call.options.env.AGENT_FORGE_HOME).toBeUndefined();
    expect(call.options.env.PRIVATE_CAPTURE_SECRET).toBeUndefined();
    expect(call.options.env.GIT_COMMON_DIR).toBe(
      canonicalTrustedDirectory(f.common),
    );
    expect(call.options.env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(call.options.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  }
});

test("exact root and Git/common directories must exist before any metadata command", () => {
  for (const missing of ["root", "git", "common"] as const) {
    const f = fixture(true);
    removeOwned(
      f.base,
      missing === "root" ? f.checkout : missing === "git" ? f.gitdir : f.common,
    );
    expect(() => f.create()).toThrow(
      "The committed checkpoint source is unavailable.",
    );
    expect(f.calls).toEqual([]);
  }
});

test("pointer files reject malformed, ambiguous and oversized representations", () => {
  for (const name of [".git", "commondir"] as const) {
    for (const malformed of [
      "",
      "\n",
      "gitdir:",
      "\uFEFFbad",
      "first\nsecond\n",
      "bad\0path",
      "x".repeat(16385),
    ]) {
      const f = fixture(true);
      writeFileSync(
        name === ".git" ? join(f.checkout, name) : join(f.gitdir, name),
        malformed,
      );
      expect(() => f.create()).toThrow(
        "The committed checkpoint source is unavailable.",
      );
      expect(f.calls).toEqual([]);
    }
  }
});

test("hardlinked pointers and reparse directory entries cannot establish a capture", () => {
  for (const name of [".git", "commondir"] as const) {
    const f = fixture(true);
    linkSync(
      name === ".git" ? join(f.checkout, name) : join(f.gitdir, name),
      join(f.base, "pointer-copy"),
    );
    expect(() => f.create()).toThrow(
      "The committed checkpoint source is unavailable.",
    );
  }
  const f = fixture();
  const other = join(f.base, "other-git");
  moveOwned(f.base, f.gitdir, other);
  symlinkSync(
    other,
    f.gitdir,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => f.create()).toThrow(
    "The committed checkpoint source is unavailable.",
  );
});

test("pointer appearance, rewrite and directory replacement invalidate lifetime identity", async () => {
  for (const change of [
    "root",
    "gitdir",
    "gitfile",
    "commonfile",
    "common-appears",
  ] as const) {
    const f = fixture(change === "gitfile" || change === "commonfile");
    const owner = f.create();
    if (change === "root") {
      moveOwned(f.base, f.checkout, join(f.base, "old-repo"));
      mkdirSync(join(f.checkout, ".git"), { recursive: true });
    }
    if (change === "gitdir") {
      moveOwned(f.base, f.gitdir, join(f.base, "old-git"));
      mkdirSync(f.gitdir);
    }
    if (change === "gitfile")
      writeFileSync(join(f.checkout, ".git"), "gitdir: missing-target\n");
    if (change === "commonfile" || change === "common-appears") {
      const changed = join(f.base, "changed-common");
      mkdirSync(changed);
      writeFileSync(join(f.gitdir, "commondir"), changed + "\n");
    }
    await expect(owner.capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
    expect(f.calls).toEqual([]);
  }
});

test("strict metadata refuses unsupported hashes, malformed IDs and incomplete bytes", async () => {
  for (const problem of [
    "sha256",
    "short-commit",
    "uppercase-commit",
    "zero-commit",
    "short-tree",
    "zero-tree",
    "extra-line",
    "control",
    "invalid-utf8",
    "over-limit",
  ] as const) {
    const f = fixture();
    f.behavior.output = (value, args) => {
      if (problem === "sha256" && args.includes("--show-object-format"))
        return "sha256\n";
      if (args.includes("HEAD^{commit}")) {
        if (problem === "short-commit") return "b".repeat(12) + "\n";
        if (problem === "uppercase-commit") return "B".repeat(40) + "\n";
        if (problem === "zero-commit") return "0".repeat(40) + "\n";
      }
      if (args.includes(f.commit + "^{tree}")) {
        if (problem === "short-tree") return "c".repeat(12) + "\n";
        if (problem === "zero-tree") return "0".repeat(40) + "\n";
      }
      if (args.includes("--show-object-format")) {
        if (problem === "extra-line") return "sha1\nsha1\n";
        if (problem === "control") return "sha1\0\n";
        if (problem === "invalid-utf8") return new Uint8Array([0xc3, 0x28]);
        if (problem === "over-limit") return "x".repeat(16385);
      }
      return value;
    };
    await expect(f.create().capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
  }
});

test("HEAD or reported directories changing during capture are refused without retry", async () => {
  for (const field of [
    "HEAD^{commit}",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
    "--show-object-format",
  ] as const) {
    const f = fixture();
    const wrong = join(f.base, "different");
    mkdirSync(wrong);
    let reads = 0;
    f.behavior.output = (value, args) => {
      if (args.includes(field) && ++reads === 2)
        return field === "HEAD^{commit}"
          ? "e".repeat(40) + "\n"
          : field === "--show-object-format"
            ? "sha256\n"
            : wrong + "\n";
      return value;
    };
    await expect(f.create().capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
    expect(reads).toBe(2);
  }
});

test("stderr and spawn failures are fixed private refusals", async () => {
  const f = fixture();
  const throwing = f.create({
    spawn: () => {
      throw Error("private spawn sentinel");
    },
  });
  await expect(throwing.capture()).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
  const warning = f.create({
    spawn: (_command, args) => {
      const child = new InertGitChild();
      queueMicrotask(() =>
        child.finish(f.output(args), 0, "private stderr sentinel"),
      );
      return child;
    },
  });
  await expect(warning.capture()).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
});

test("failed or backwards clocks and an elapsed result deadline cannot return a source", async () => {
  for (const change of ["throw", "NaN", "elapsed", "backwards"] as const) {
    const f = fixture();
    let time = 100;
    f.behavior.output = (value) => {
      if (change === "elapsed") time = 5100;
      if (change === "backwards") time = 99;
      return value;
    };
    const owner = f.create({
      now: () => {
        if (change === "throw") throw Error("private clock sentinel");
        return change === "NaN" ? Number.NaN : time;
      },
    });
    await expect(owner.capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
    expect(f.calls.length).toBeLessThanOrEqual(1);
  }
});

test("capture waits for CLOSE after exit and snapshots mutable byte chunks", async () => {
  const f = fixture();
  let release = () => {},
    entered = () => {};
  const observed = new Promise<void>((accept) => {
    entered = accept;
  });
  let first = true;
  const owner = f.create({
    spawn: (command, args, options) => {
      if (!first) return f.spawn(command, args, options);
      first = false;
      const child = new InertGitChild();
      release = () => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      };
      queueMicrotask(() => {
        const bytes = Buffer.from(f.output(args));
        child.stdout.write(bytes);
        bytes.fill(120);
        child.emit("exit", 0, null);
        entered();
      });
      return child;
    },
  });
  let settled = false;
  const pending = owner.capture().finally(() => {
    settled = true;
  });
  await observed;
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await pending).toEqual({
    kind: "committed-git-snapshot",
    commit: f.commit,
    tree: f.tree,
  });
});

test("close refuses new work and concurrent captures share one pinned repository", async () => {
  const f = fixture();
  const owner = f.create();
  const results = await Promise.all([owner.capture(), owner.capture()]);
  expect(results[0]).toEqual(results[1]);
  await owner.close();
  const before = f.calls.length;
  await expect(owner.capture()).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
  expect(f.calls).toHaveLength(before);
});

test("time queued before capture work starts belongs to the same result deadline", async () => {
  const f = fixture();
  let time = 0;
  const owner = f.create({ now: () => time });
  const pending = owner.capture();
  time = 6000;
  await expect(pending).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
  expect(f.calls).toEqual([]);
});

test("final synchronous validation cannot return a source using a stale clock observation", async () => {
  const f = fixture();
  let formats = 0,
    finalReadClosed = false,
    observations = 0,
    modeledTime = 0;
  f.behavior.output = (value, args) => {
    if (args.includes("--show-object-format") && ++formats === 2)
      finalReadClosed = true;
    return value;
  };
  const owner = f.create({
    now: () => {
      if (!finalReadClosed) return 0;
      const observed =
        observations++ === 0 ? 4998 : observations === 2 ? 4999 : 6000;
      modeledTime = observed === 4999 ? 6000 : observed + 1;
      return observed;
    },
  });
  await expect(owner.capture()).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
  expect(modeledTime).toBeGreaterThanOrEqual(5000);
});

test("nonzero metadata exit never becomes a source", async () => {
  const f = fixture();
  const owner = f.create({
    spawn: (_command, args) => {
      const child = new InertGitChild();
      queueMicrotask(() => child.finish(f.output(args), 1));
      return child;
    },
  });
  await expect(owner.capture()).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
});

test("closing a clean in-flight capture aborts it and joins explicit CLOSE", async () => {
  const f = fixture();
  class HeldChild extends InertGitChild {
    override kill(signal: NodeJS.Signals | number = "SIGTERM") {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new HeldChild();
  const seen: { input?: Parameters<CheckpointCaptureSpawn>[2] } = {};
  let entered = () => {};
  const observed = new Promise<void>((accept) => {
    entered = accept;
  });
  const owner = f.create({
    spawn: (_command, _args, input) => {
      seen.input = input;
      input.signal.addEventListener(
        "abort",
        () => child.emit("error", Error("private abort sentinel")),
        { once: true },
      );
      entered();
      return child;
    },
  });
  let completed = false,
    closed = false;
  const pending = owner.capture().then(
    () => {
      throw Error("Aborted capture returned a source");
    },
    () => {
      completed = true;
    },
  );
  await observed;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  try {
    expect(seen.input?.signal.aborted).toBe(true);
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(completed).toBe(false);
    expect(closed).toBe(false);
  } finally {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGKILL");
    await pending;
    await closing;
  }
});

test("pointer changes during the last metadata read cannot return a stale source", async () => {
  for (const name of [".git", "commondir"] as const) {
    const f = fixture(true);
    let formats = 0;
    f.behavior.output = (value, args) => {
      if (args.includes("--show-object-format") && ++formats === 2)
        writeFileSync(
          name === ".git" ? join(f.checkout, name) : join(f.gitdir, name),
          "changed-pointer\n",
        );
      return value;
    };
    await expect(f.create().capture()).rejects.toThrow(
      "The committed checkpoint source is unavailable.",
    );
  }
});

test("the final consumed clock observation cannot move backwards within the operation", async () => {
  const control = fixture();
  let samples = 0;
  await control.create({ now: () => 100 + ++samples }).capture();
  expect(samples).toBeGreaterThan(1);
  const f = fixture();
  let observed = 0;
  const owner = f.create({
    now: () => {
      observed++;
      return observed === samples ? 101 : 100 + observed;
    },
  });
  await expect(owner.capture()).rejects.toThrow(
    "The committed checkpoint source is unavailable.",
  );
});
