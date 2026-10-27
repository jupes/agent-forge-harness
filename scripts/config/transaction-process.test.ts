import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scratchDirs } from "../test-scratch";
import { prepareConfigTransaction, withConfigTransaction } from "./transaction";
import { emitTransactionFixtureFailureFactsAndRethrow } from "./transaction-process-diagnostic.test-utils";
import { windowsConfigLeafKind } from "./transaction-windows";

const scratch = scratchDirs();
interface Child {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
}
const children: Child[] = [];
afterEach(async () => {
  const settled = await Promise.allSettled(
    children.splice(0).map(async (child) => {
      if (child.process.exitCode === null) child.process.kill();
      await child.done;
    }),
  );
  const failures: unknown[] = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  try {
    scratch.cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "Config fixture cleanup failed");
});

function box() {
  const root = realpathSync.native(scratch.make("config-process-"));
  for (const name of [
    "harness",
    "os home",
    "shared workspace",
    "profile-a",
    "profile-b",
  ])
    mkdirSync(join(root, name));
  writeFileSync(
    join(root, "fixture-marker"),
    "config-transaction-fixture-v1\n",
  );
  symlinkSync(
    join(root, "shared workspace"),
    join(root, "workspace alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return root;
}

/** Child-only startup environment; this process's homes are never moved. */
function start(root: string, role: "moved-home" | "hold" | "write"): Child {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  env.HOME = join(root, "os home");
  env.USERPROFILE = env.HOME;
  env.AGENT_FORGE_HOME = join(root, "moved forge home");
  const process_ = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "transaction-cli.ts"),
      role,
      root,
    ],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: root },
  );
  const timer = setTimeout(() => process_.kill(), 10_000);
  const done = Promise.all([
    process_.exited,
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ])
    .then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
    .finally(() => clearTimeout(timer));
  void done.catch(() => {});
  const child = { process: process_, done };
  children.push(child);
  return child;
}

async function marker(
  root: string,
  name: string,
  child: Child,
  role: "hold" | "write",
) {
  const deadline = performance.now() + 5_000;
  while (!existsSync(join(root, name))) {
    if (performance.now() >= deadline) {
      const error = Error(`Fixture did not reach ${name}`);
      await emitTransactionFixtureFailureFactsAndRethrow(
        error,
        () => fixtureFailureFacts(root, child, role),
        (line) => console.error(line.trimEnd()),
      );
    }
    await Bun.sleep(5);
  }
}

async function fixtureFailureFacts(
  root: string,
  child: Child,
  role: "hold" | "write",
) {
  const exitCode = child.process.exitCode;
  if (exitCode === null)
    return {
      stage: fixtureStage(root, role),
      child: "running" as const,
      stderr: "unavailable" as const,
    };
  let stderr: "empty" | "nonempty" | "unavailable" = "unavailable";
  try {
    const settled = await Promise.race([
      child.done,
      Bun.sleep(100).then(() => null),
    ]);
    if (settled !== null)
      stderr = settled.stderr.length === 0 ? "empty" : "nonempty";
  } catch {
    // A pipe read failure leaves only the process exit category available.
  }
  return {
    stage: fixtureStage(root, role),
    child:
      exitCode === 0 ? ("exited-zero" as const) : ("exited-nonzero" as const),
    stderr,
  };
}

function fixtureStage(root: string, role: "hold" | "write") {
  try {
    if (role === "hold") {
      if (existsSync(join(root, "hold-transaction-entered")))
        return "transaction-entered" as const;
      if (existsSync(join(root, "hold-transaction-prepared")))
        return "transaction-prepared" as const;
    } else if (existsSync(join(root, "write-cli-started"))) {
      return "cli-started" as const;
    }
    if (existsSync(join(root, `${role}-child-started`)))
      return "child-started" as const;
    return "none" as const;
  } catch {
    return "unavailable" as const;
  }
}

const cliOutcome = z
  .object({ code: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();

function decode<T>(stdout: string, data: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw Error(`Invalid fixture JSON: ${stdout}`);
  }
  const parsed = z
    .object({ ok: z.literal(true), data, error: z.null() })
    .strict()
    .safeParse(raw);
  expect(parsed.success, stdout).toBe(true);
  if (!parsed.success) throw Error(`Fixture envelope refused: ${stdout}`);
  return parsed.data.data;
}

function envelope<T>(
  output: Awaited<ReturnType<typeof start>["done"]>,
  data: z.ZodType<T>,
): T {
  expect(output.stderr).toBe("");
  expect(output.code, output.stdout).toBe(0);
  return decode(output.stdout, data);
}

test("with no home given, --user writes config.toml in AGENT_FORGE_HOME, and show names that file", async () => {
  const root = box();
  const forgeHome = join(root, "moved forge home");
  const osHome = join(root, "os home");
  const file = join(forgeHome, "config.toml");
  const { set, show } = envelope(
    await start(root, "moved-home").done,
    z.object({ set: cliOutcome, show: cliOutcome, file: z.string() }).strict(),
  );
  expect(
    decode(
      set.stdout,
      z.object({ file: z.string(), created: z.boolean() }).passthrough(),
    ),
  ).toMatchObject({ file, created: true });
  expect(readFileSync(file, "utf8")).toBe(
    '[workflow]\ndefault_crew = "claude-master"\n',
  );
  expect(existsSync(join(osHome, ".agent-forge"))).toBe(false);
  const body = decode(
    show.stdout,
    z
      .object({
        files: z.array(z.string()),
        provenance: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  );
  expect(body.files).toEqual([file]);
  expect(body.provenance["workflow.default_crew"]).toEqual({
    value: "claude-master",
    source: file,
  });
});

test("two actual writers in different profile and checkout spellings serialize without losing either change", async () => {
  const root = box();
  const holder = start(root, "hold");
  await marker(root, "holder-entered", holder, "hold");
  const lock = join(root, "coordination", "write.lock.db");
  const heldIdentity = lstatSync(lock, { bigint: true });
  const writer = start(root, "write");
  await marker(root, "writer-entered", writer, "write");
  // A separate acquisition refuses while the first process owns the lock.
  const context = prepareConfigTransaction({
    options: {
      harnessRoot: join(root, "shared workspace"),
      home: join(root, "profile-b"),
      env: {},
    },
    target: "workspace",
    coordinationRoot: join(root, "coordination"),
  });
  let entered = false;
  await expect(
    withConfigTransaction(
      context,
      () => {
        entered = true;
      },
      { waitMs: 100 },
    ),
  ).rejects.toMatchObject({ reason: "busy", replacementAttempted: false });
  expect(entered).toBe(false);
  expect(existsSync(join(root, "writer-completed"))).toBe(false);
  writeFileSync(join(root, "release-holder"), "release\n");
  envelope(await holder.done, z.unknown());
  const result = envelope(await writer.done, cliOutcome);
  expect(result.code, result.stdout).toBe(0);
  expect(
    readFileSync(join(root, "shared workspace", "agent-forge.toml"), "utf8"),
  ).toBe("[shift]\nmax_beads = 7\nmax_usd = 5\n");
  const releasedIdentity = lstatSync(lock, { bigint: true });
  expect([releasedIdentity.dev, releasedIdentity.ino]).toEqual([
    heldIdentity.dev,
    heldIdentity.ino,
  ]);
});

test("death of the actual lock owner releases it for a new scalar writer and keeps the persistent mutex", async () => {
  const root = box();
  const holder = start(root, "hold");
  await marker(root, "holder-entered", holder, "hold");
  const lock = join(root, "coordination", "write.lock.db");
  const heldIdentity = lstatSync(lock, { bigint: true });
  holder.process.kill();
  await holder.done;
  expect(existsSync(join(root, "shared workspace", "agent-forge.toml"))).toBe(
    false,
  );
  const result = envelope(await start(root, "write").done, cliOutcome);
  expect(result.code, result.stdout).toBe(0);
  expect(
    readFileSync(join(root, "shared workspace", "agent-forge.toml"), "utf8"),
  ).toBe("[shift]\nmax_usd = 5\n");
  const releasedIdentity = lstatSync(lock, { bigint: true });
  expect([releasedIdentity.dev, releasedIdentity.ino]).toEqual([
    heldIdentity.dev,
    heldIdentity.ino,
  ]);
});

test.skipIf(process.platform !== "win32")(
  "actual Windows reparse leaf is refused without replacing or changing its owned referent",
  async () => {
    const root = box();
    const referent = join(root, "reparse referent");
    mkdirSync(referent);
    const sentinel = join(referent, "kept");
    writeFileSync(sentinel, "exact referent bytes\n");
    const context = prepareConfigTransaction({
      options: {
        harnessRoot: join(root, "shared workspace"),
        home: join(root, "profile-a"),
        env: {},
      },
      target: "workspace",
      coordinationRoot: join(root, "coordination"),
    });
    symlinkSync(referent, context.files.workspace, "junction");
    expect(windowsConfigLeafKind(context.files.workspace)).toBe("reparse");
    await expect(
      withConfigTransaction(context, (transaction) =>
        transaction.publish(Buffer.from("must not write")),
      ),
    ).rejects.toThrow("linked");
    expect(lstatSync(context.files.workspace).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("exact referent bytes\n");
  },
);
