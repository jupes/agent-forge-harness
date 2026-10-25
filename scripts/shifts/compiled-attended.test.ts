import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { buildChildEnv } from "../executors/env";
import { writeOwnerOnly } from "../hearth/token";
import { closeLedger } from "../ledger/db";
import { activeReservations, queryEvents } from "../ledger/query";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { createSessionRegistry } from "../sessions/registry";
import { scratchDirs } from "../test-scratch";
import { createProjectShiftAttemptReader } from "./attempt-read";
import { runKeeperShiftCompiledProof } from "./keeper-compiled-proof";
import { createOwnedProjectShiftLauncher } from "./owned-launcher";
import { projectShiftReceiptSchema } from "./protocol";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "./registry";

const scratch = scratchDirs(),
  ledgers: string[] = [];
afterEach(() => {
  for (const file of ledgers.splice(0)) closeLedger(file);
  scratch.cleanup();
});
const source = join(import.meta.dir, "..");
function compile(entry: string, target: string) {
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", entry, "--outfile", target],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  if (result.exitCode !== 0)
    throw Error(
      `Native attended fixture compilation failed: ${result.stderr.toString().slice(-1000)}`,
    );
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Native attended fixture returned an invalid envelope");
  }
}

test("the actual compiled production hearth executes attended input through fixed bootstrap and sync modes without ambient Bun or source", async () => {
  let lastCompiledHearth: string | null = null;
  for (const providerKind of ["claude", "codex"] as const) {
    const root = realpathSync.native(scratch.make("compiled attended shift ")),
      home = join(root, "home"),
      bin = join(root, "bin"),
      state = join(root, "fixture"),
      extension = process.platform === "win32" ? ".exe" : "";
    for (const dir of [
      bin,
      state,
      join(root, ".git"),
      join(root, ".claude/skills/one"),
      join(root, ".claude/commands"),
      join(root, ".claude/agents"),
    ])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(root, "attended-native-fixture.marker"),
      "agent-forge-attended-native-fixture-v1",
    );
    writeFileSync(join(root, ".gitignore"), "trees/\n");
    writeFileSync(
      join(root, ".claude/skills/one/SKILL.md"),
      "# Planted attended skill\n",
    );
    writeFileSync(
      join(root, "agent-forge.toml"),
      '[execution.env]\npass=["CODING_FIXTURE_MODE","CODING_FIXTURE_RECORD","CODEX_RUNTIME_MODE","CODEX_RUNTIME_LOG"]\n[shift]\nthrottle=1.0\n',
    );
    writeFileSync(
      join(state, "tracker.json"),
      JSON.stringify([
        {
          id: "alpha-epic",
          title: "Selected epic",
          issueType: "epic",
          labels: ["project:alpha"],
        },
        {
          id: "alpha-work",
          title: "Bounded native work",
          issueType: "task",
          parent: { id: "alpha-epic" },
          labels: ["queue:queued", "project:alpha"],
          metadata: { queue_state: "queued" },
          description: "Planted work.\n\n## Files\nsrc/planted/**\n",
        },
      ]),
    );
    writeFileSync(join(state, "trees.json"), "[]");
    writeOwnerOnly(
      projectCatalogPath(home),
      JSON.stringify(projectCatalogFixture(root)),
    );
    const hearth = join(bin, `hearth${extension}`),
      tools = join(bin, `bd${extension}`),
      toolSource = join(state, "tools.ts");
    compile(join(source, "hearth/compiled-entry.ts"), hearth);
    lastCompiledHearth = hearth;
    writeFileSync(
      toolSource,
      `import {runAttendedNativeToolFixture} from ${JSON.stringify(join(import.meta.dir, "fixtures/native-tools.ts").replaceAll("\\", "/"))}; await runAttendedNativeToolFixture(${JSON.stringify(root)});`,
    );
    compile(toolSource, tools);
    for (const name of ["git", "gh"])
      copyFileSync(tools, join(bin, `${name}${extension}`));
    const providerSource = join(state, "provider.ts"),
      provider = join(bin, `claude${extension}`);
    writeFileSync(
      providerSource,
      `import {basename} from "node:path"; import {runCodingCliFixture} from ${JSON.stringify(join(source, "sessions/fixtures/coding-cli-fixture.ts").replaceAll("\\", "/"))}; import {runCodexTaskRuntimeFixture} from ${JSON.stringify(join(source, "sessions/fixtures/codex-task-runtime-fixture.ts").replaceAll("\\", "/"))}; if(basename(process.execPath).startsWith("codex")) await runCodexTaskRuntimeFixture(); else await runCodingCliFixture();`,
    );
    compile(providerSource, provider);
    copyFileSync(provider, join(bin, `codex${extension}`));
    const base = Object.fromEntries(
      Object.entries(buildChildEnv(process.env, [])).filter(
        ([key]) => key.toLowerCase() !== "path",
      ),
    );
    const osHome = join(root, "os-home");
    mkdirSync(osHome);
    const env = {
      ...base,
      PATH: bin,
      HOME: osHome,
      USERPROFILE: osHome,
      APPDATA: osHome,
      LOCALAPPDATA: osHome,
      AGENT_FORGE_HOME: home,
      CODING_FIXTURE_MODE: "rich",
      CODING_FIXTURE_RECORD: join(state, "claude.json"),
      CODEX_RUNTIME_MODE: "rich",
      CODEX_RUNTIME_LOG: join(state, "codex.jsonl"),
    };
    const registry = createProjectShiftRegistry({ root, home }),
      request = {
        requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
        expectedCatalogRevision: 1,
        options: {
          for: "1m",
          concurrency: 1,
          maxBeads: 1,
          maxUsd: 5,
          repairs: 1,
          base: "main",
          smith: `${providerKind}-journeyman`,
        },
      };
    const saved = await registry.reserve(
      FIXTURE_PROJECT_ID,
      request,
      async () => ({ shiftId: "shift-20261023-180000-1234" }),
    );
    const marked = await registry.markAttempted(
      FIXTURE_PROJECT_ID,
      request.requestId,
      saved.intent.requestHash,
    );
    const command = [hearth, "--project-shift-run"],
      child = createOwnedProjectShiftLauncher({
        root,
        home,
        command,
        bootstrapCommand: [hearth, "--interactive-bootstrap"],
      })(
        {
          argv: [...command, FIXTURE_PROJECT_ID, request.requestId],
          cwd: root,
          env,
        },
        marked.intent,
      );
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      void child.stop();
    }, 45000);
    const result = await child.done.finally(() => clearTimeout(timer));
    expect(expired).toBe(false);
    expect(await child.enginePid).not.toBe(child.pid);
    expect(
      result.exitCode,
      JSON.stringify({
        provider: providerKind,
        stdout: result.stdout.toString().slice(-4000),
        stderr: result.stderr.toString().slice(-4000),
      }),
    ).toBe(0);
    const envelope = z
      .object({
        ok: z.literal(true),
        data: projectShiftReceiptSchema,
        error: z.null(),
      })
      .strict()
      .parse(parse(result.stdout.toString()));
    expect(envelope.data.observation.phase).toBe("stopped");
    expect(
      envelope.data.observation.actual?.admitted,
      JSON.stringify({
        observation: envelope.data.observation,
        calls: readFileSync(join(state, "calls.jsonl"), "utf8"),
      }),
    ).toBe(1);
    const rows = createSessionRegistry(home).listAll(FIXTURE_PROJECT_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw Error("No compiled private attempt");
    const page = await createProjectShiftAttemptReader({ root, home }).read(
      FIXTURE_PROJECT_ID,
      request.requestId,
      row.id,
    );
    expect(page.turns[0]?.phase).toBe("completed");
    expect(page.controllable).toBe(false);
    const log =
      providerKind === "claude"
        ? env.CODING_FIXTURE_RECORD
        : env.CODEX_RUNTIME_LOG;
    const actual = z
      .object({
        argv: z.array(z.string()),
        stdin: z.string(),
        pid: z.number(),
        cwd: z.string(),
      })
      .parse(
        providerKind === "claude"
          ? parse(readFileSync(log, "utf8"))
          : readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .map(parse)
              .find(
                (packet) =>
                  typeof packet === "object" &&
                  packet !== null &&
                  "kind" in packet &&
                  packet.kind === "task",
              ),
      );
    const user = page.frames[0]?.event;
    if (user?.kind !== "user" || !user.shift)
      throw Error("No compiled immutable input");
    expect(user.shift.command).toEqual([
      join(bin, `${providerKind}${extension}`),
      ...actual.argv,
    ]);
    expect(user.shift.stdin).toBe(actual.stdin);
    expect(user.shift.cwd).toBe(actual.cwd);
    expect(
      page.frames.find((frame) => frame.event.kind === "process")?.event,
    ).toMatchObject({ kind: "process", pid: actual.pid });
    if (providerKind === "codex") {
      expect(actual.argv).toContain('approval_policy="never"');
      expect(
        readFileSync(join(actual.cwd, ".agents/skills/one/SKILL.md"), "utf8"),
      ).toBe("# Planted attended skill\n");
    }
    const before = readFileSync(log, "utf8"),
      calls = readFileSync(join(state, "calls.jsonl"), "utf8");
    const repeated = Bun.spawnSync(
      [hearth, "--project-shift-run", FIXTURE_PROJECT_ID, request.requestId],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expect(repeated.exitCode).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(before);
    expect(readFileSync(join(state, "calls.jsonl"), "utf8")).toBe(calls);
    const originalBytes = readFileSync(projectShiftRegistryFile(home), "utf8");
    const refused = Bun.spawnSync(
      [
        hearth,
        "--project-shift-run",
        FIXTURE_PROJECT_ID,
        request.requestId,
        "--root",
        join(root, "outside"),
      ],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expect(refused.exitCode).toBe(1);
    expect(parse(refused.stdout.toString())).toMatchObject({
      ok: false,
      data: null,
    });
    expect(readFileSync(projectShiftRegistryFile(home), "utf8")).toBe(
      originalBytes,
    );
    expect(readFileSync(join(state, "calls.jsonl"), "utf8")).toBe(calls);
    const ledger = join(home, "ledger.db");
    ledgers.push(ledger);
    expect(activeReservations({ workspace: root }, { path: ledger })).toEqual(
      [],
    );
    expect(
      JSON.stringify(queryEvents({ workspace: root }, { path: ledger })),
    ).not.toContain(actual.stdin);
  }
  if (lastCompiledHearth === null)
    throw new Error(
      "No compiled production hearth was available for Keeper proof",
    );
  await runKeeperShiftCompiledProof(lastCompiledHearth);
}, 120000);
