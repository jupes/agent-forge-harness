import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { KeeperShiftStartRequest } from "../../types/keeper-shift-start";
import { createConversationStore } from "../conversations/store";
import { buildChildEnv } from "../executors/env";
import { killTree } from "../executors/supervisor";
import { tokenPath } from "../hearth/home";
import { isPidAlive } from "../hearth/lock";
import {
  API_PREFIX,
  LAUNCH_HEADER,
  LAUNCH_ROUTE,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
  SESSION_ROUTE,
  SURFACE_HEADER,
  TOKEN_ROUTE,
} from "../hearth/paths";
import { privateTempDir } from "../hearth/testing";
import { readToken, writeOwnerOnly } from "../hearth/token";
import { keeperProposalFile } from "../keeper/proposal-store";
import { keeperProposals } from "../keeper/proposals";
import { keeperShiftStartReceiptSchema } from "../keeper/shift-start-protocol";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { readShiftRecord, SHIFTS_DIR } from "../scheduler/shift-store";
import { scratchDirs } from "../test-scratch";
import { projectShiftReceiptSchema } from "./protocol";
import {
  createProjectShiftRegistry,
  projectShiftRequestHash,
} from "./registry";

const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const sessionData = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) });
const tokenData = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });
const admission = z.object({ pid: z.number().int().positive() }).passthrough();
const READY_MS = 20_000;
const STOP_MS = 12_000;

type Host = {
  process: ReturnType<typeof Bun.spawn>;
  pid: number;
  port: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
  exited: Promise<number>;
  outputError: string | null;
};

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function parseEnvelope(text: string, label: string): unknown {
  const parsed = envelope.safeParse(parseJson(text, label));
  if (!parsed.success) throw new Error(`${label} returned an invalid envelope`);
  return parsed.data.data;
}

function compile(entry: string, target: string): void {
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", entry, "--outfile", target],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Inert Keeper proof tool compilation failed (${result.exitCode})`,
    );
}

function drain(
  stream: ReadableStream<Uint8Array>,
  record: (text: string) => void,
): Promise<void> {
  return (async () => {
    const reader = stream.getReader(),
      decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        record(decoder.decode(value, { stream: true }));
      }
      const rest = decoder.decode();
      if (rest) record(rest);
    } finally {
      reader.releaseLock();
    }
  })();
}

function addTail(previous: string, next: string): string {
  return (previous + next).slice(-8192);
}

async function startHost(
  binary: string,
  root: string,
  home: string,
  bin: string,
  userHome: string,
  providerRecord: string,
  owned: Host[],
): Promise<Host> {
  const base = Object.fromEntries(
      Object.entries(buildChildEnv(process.env, [])).filter(
        ([key]) => key.toLowerCase() !== "path",
      ),
    ),
    child = Bun.spawn([binary, "--root", root], {
      cwd: root,
      env: {
        ...base,
        PATH: bin,
        HOME: userHome,
        USERPROFILE: userHome,
        APPDATA: userHome,
        LOCALAPPDATA: userHome,
        AGENT_FORGE_HOME: home,
        CODING_FIXTURE_MODE: "rich",
        CODING_FIXTURE_RECORD: providerRecord,
        HEARTH_PORT: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  let readyResolve: ((port: number) => void) | undefined,
    readyReject: ((error: Error) => void) | undefined,
    startupText = "";
  const ready = new Promise<number>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const host: Host = {
    process: child,
    pid: child.pid,
    port: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutDone: Promise.resolve(),
    stderrDone: Promise.resolve(),
    exited: child.exited.then((code) => {
      host.exitCode = code;
      readyReject?.(new Error(`Compiled hearth exited before ready (${code})`));
      return code;
    }),
    outputError: null,
  };
  owned.push(host);
  host.stdoutDone = drain(child.stdout, (chunk) => {
    host.stdout = addTail(host.stdout, chunk);
    startupText = addTail(startupText, chunk);
    const match = /hearth listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(
      startupText,
    );
    if (match) {
      const port = Number(match[1]);
      if (Number.isSafeInteger(port) && port > 0) {
        host.port = port;
        readyResolve?.(port);
      }
    }
  }).catch((error: unknown) => {
    host.outputError = error instanceof Error ? error.message : String(error);
  });
  host.stderrDone = drain(child.stderr, (chunk) => {
    host.stderr = addTail(host.stderr, chunk);
  }).catch((error: unknown) => {
    host.outputError = error instanceof Error ? error.message : String(error);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Compiled hearth startup exceeded its bound")),
        READY_MS,
      );
    });
    await Promise.race([
      ready,
      timeout,
      host.exited.then((code) => {
        throw new Error(`Compiled hearth exited before ready (${code})`);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (host.port === null)
    throw new Error("Compiled hearth announced no loopback port");
  return host;
}

async function stopHost(host: Host): Promise<void> {
  if (host.exitCode === null) {
    try {
      host.process.kill("SIGTERM");
    } catch {
      /* The bounded fallback below owns this process tree if it is still alive. */
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      host.exited.then(() => true),
      new Promise<boolean>((resolveStopped) => {
        timer = setTimeout(() => resolveStopped(false), STOP_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!stopped) {
      killTree(host.pid);
      await Promise.race([
        host.exited,
        Bun.sleep(STOP_MS).then(() => {
          throw new Error("Compiled hearth tree did not exit after owner kill");
        }),
      ]);
    }
  }
  await Promise.all([host.stdoutDone, host.stderrDone]);
  if (host.outputError !== null)
    throw new Error("Compiled hearth output did not drain cleanly");
}

async function waitUntil<T>(
  read: () => T | null,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(25);
  }
  throw new Error(`${label} did not reach its expected state in time`);
}

function admissions(file: string): Array<z.infer<typeof admission>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => admission.parse(parseJson(line, "Provider admission log")));
}

async function acquireOperatorSession(
  origin: string,
  home: string,
  root: string,
) {
  const token = readToken(tokenPath(home, root));
  if (token === null)
    throw new Error("Compiled hearth token was not published");
  const launch = await fetch(`${origin}${LAUNCH_ROUTE}`, {
    method: "POST",
    headers: {
      Origin: origin,
      [OPERATOR_HEADER]: token,
      [SURFACE_HEADER]: "api",
    },
  });
  if (launch.status !== 200)
    throw new Error("Compiled hearth refused its local launch fixture");
  const launchValue = z
    .object({ secret: z.string().regex(/^[0-9a-f]{64}$/) })
    .parse(parseEnvelope(await launch.text(), "Launch response"));
  const session = await fetch(`${origin}${SESSION_ROUTE}`, {
    method: "POST",
    headers: {
      Origin: origin,
      [LAUNCH_HEADER]: launchValue.secret,
      [SURFACE_HEADER]: "api",
    },
  });
  if (session.status !== 200)
    throw new Error("Compiled hearth refused its same-origin session fixture");
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Compiled hearth session cookie was absent");
  const key = sessionData.parse(
    parseEnvelope(await session.text(), "Session response"),
  ).key;
  return { cookie, key };
}

async function sessionToken(
  origin: string,
  session: { cookie: string; key: string },
) {
  const response = await fetch(`${origin}${TOKEN_ROUTE}`, {
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      [SESSION_KEY_HEADER]: session.key,
    },
  });
  if (response.status !== 200)
    throw new Error(
      "The persisted dashboard session did not survive host restart",
    );
  return tokenData.parse(parseEnvelope(await response.text(), "Token response"))
    .token;
}

async function readOk(
  origin: string,
  path: string,
  token: string,
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    headers: { Origin: origin, [OPERATOR_HEADER]: token },
  });
  if (response.status !== 200)
    throw new Error("Protected Keeper/Shift read did not succeed");
  return parseEnvelope(await response.text(), "Protected read");
}

async function postStart(
  origin: string,
  path: string,
  token: string,
  request: KeeperShiftStartRequest,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      [OPERATOR_HEADER]: token,
      [SURFACE_HEADER]: "api",
    },
    body: JSON.stringify(request),
  });
}

async function portCanBind(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", resolveListen);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening)
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
  }
}

async function seedProposal(home: string) {
  const store = createConversationStore(home),
    requestId = randomUUID(),
    owner = randomUUID();
  let state = store.read(FIXTURE_PROJECT_ID);
  await store.accept(FIXTURE_PROJECT_ID, {
    requestId,
    expectedRevision: state.revision,
    text: "Propose one Shift for explicit human review",
    about: [],
  });
  await store.start(FIXTURE_PROJECT_ID, requestId, owner);
  await store.append(FIXTURE_PROJECT_ID, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: randomUUID(),
    version: "keeper-compiled-fixture",
  });
  await store.append(FIXTURE_PROJECT_ID, requestId, owner, {
    kind: "text",
    text: JSON.stringify({
      kind: "keeper.proposals.v1",
      message: "Review this proposal and its editable execution bounds.",
      proposals: [
        {
          title: "Review a project Shift",
          detail: "Review the complete bounds before starting.",
          action: {
            kind: "start-shift",
            durationMinutes: 45,
            concurrency: 2,
            beadLimit: 5,
            spendLimitUsd: 8,
          },
        },
      ],
    }),
  });
  await store.finish(FIXTURE_PROJECT_ID, requestId, owner, "completed", null);
  state = store.read(FIXTURE_PROJECT_ID);
  const proposal = keeperProposals(state).find(
    (item) => item.draft.action.kind === "start-shift",
  );
  if (!proposal)
    throw new Error("Compiled Keeper source proposal was not created");
  return proposal;
}

/** Uses the compiled production entry supplied by compiled-attended.test.ts; only fixture tools are compiled here. */
export async function runKeeperShiftCompiledProof(
  hearthBinary: string,
): Promise<void> {
  const scratch = scratchDirs(),
    owned: Host[] = [],
    ledgers: string[] = [];
  let primaryError: unknown;
  try {
    const root = resolve(scratch.make("compiled keeper shift ")),
      home = scratch.track(privateTempDir("compiled-keeper-home-")),
      bin = join(root, "bin"),
      stateDir = join(root, "fixture"),
      userHome = join(root, "user-home"),
      ext = process.platform === "win32" ? ".exe" : "",
      sourceRoot = resolve(import.meta.dir, ".."),
      ledger = join(home, "ledger.db"),
      keeperFile = keeperProposalFile(home, FIXTURE_PROJECT_ID),
      admissionsFile = join(stateDir, "provider-admissions.jsonl");
    ledgers.push(ledger);
    for (const directory of [
      home,
      bin,
      stateDir,
      userHome,
      join(root, ".git"),
      join(root, ".claude", "skills", "one"),
      join(root, ".claude", "commands"),
      join(root, ".claude", "agents"),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(root, "attended-native-fixture.marker"),
      "agent-forge-attended-native-fixture-v1",
    );
    writeFileSync(join(root, ".gitignore"), "trees/\n");
    writeFileSync(
      join(root, ".claude", "skills", "one", "SKILL.md"),
      "# Planted Keeper Shift skill\n",
    );
    writeFileSync(
      join(root, "agent-forge.toml"),
      '[execution.env]\npass=["CODING_FIXTURE_MODE","CODING_FIXTURE_RECORD"]\n[shift]\nthrottle=1.0\n',
    );
    writeFileSync(
      join(stateDir, "tracker.json"),
      JSON.stringify([
        {
          id: "alpha-epic",
          title: "Selected project epic",
          issueType: "epic",
          labels: ["project:alpha"],
        },
        {
          id: "alpha-work",
          title: "One inert compiled Shift admission",
          issueType: "task",
          parent: { id: "alpha-epic" },
          labels: ["queue:queued", "project:alpha"],
          metadata: { queue_state: "queued" },
          description: "Planted work only.\n\n## Files\nsrc/planted/**\n",
        },
      ]),
    );
    writeFileSync(join(stateDir, "trees.json"), "[]");
    writeOwnerOnly(
      projectCatalogPath(home),
      JSON.stringify(projectCatalogFixture(root)),
    );

    const toolsEntry = join(stateDir, "tools.ts"),
      tools = join(bin, `bd${ext}`),
      nativeTools = join(
        import.meta.dir,
        "fixtures",
        "native-tools.ts",
      ).replaceAll("\\", "/");
    writeFileSync(
      toolsEntry,
      `import {runAttendedNativeToolFixture} from ${JSON.stringify(nativeTools)}; await runAttendedNativeToolFixture(${JSON.stringify(root)});`,
    );
    compile(toolsEntry, tools);
    for (const name of ["git", "gh"])
      copyFileSync(tools, join(bin, `${name}${ext}`));

    const providerEntry = join(stateDir, "provider.ts"),
      provider = join(bin, `claude${ext}`),
      providerFixture = join(
        sourceRoot,
        "sessions",
        "fixtures",
        "coding-cli-fixture.ts",
      ).replaceAll("\\", "/");
    writeFileSync(
      providerEntry,
      `import {appendFileSync} from "node:fs"; import {runCodingCliFixture} from ${JSON.stringify(providerFixture)}; const args=process.argv.slice(2); if(!args.includes("--version")&&!args.includes("--help")) appendFileSync(${JSON.stringify(admissionsFile)}, JSON.stringify({pid:process.pid,cwd:process.cwd()})+"\\n"); await runCodingCliFixture();`,
    );
    compile(providerEntry, provider);

    const proposal = await seedProposal(home),
      reviewed: KeeperShiftStartRequest = {
        sourceHash: proposal.sourceHash,
        expectedRevision: 0,
        start: {
          requestId: "913c01ee-e854-4d0e-8d6c-a246304d74a1",
          expectedCatalogRevision: 1,
          options: {
            for: "1m",
            concurrency: 1,
            maxBeads: 1,
            maxUsd: 5,
            repairs: 1,
            base: "main",
            smith: "claude-journeyman",
          },
        },
      },
      startPath = `${API_PREFIX}/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${proposal.id}/shift-start`,
      originalPath = `${startPath}/${reviewed.start.requestId}`,
      canonicalPath = `${API_PREFIX}/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${reviewed.start.requestId}`,
      originalHash = projectShiftRequestHash(
        FIXTURE_PROJECT_ID,
        root,
        reviewed.start,
      );

    const hostA = await startHost(
        hearthBinary,
        root,
        home,
        bin,
        userHome,
        join(stateDir, "provider.json"),
        owned,
      ),
      originA = `http://127.0.0.1:${hostA.port}`,
      session = await acquireOperatorSession(originA, home, root),
      tokenA = await sessionToken(originA, session),
      action = await postStart(originA, startPath, tokenA, reviewed);
    expect(action.status).toBe(200);
    await action.body?.cancel();

    const savedIntent = createProjectShiftRegistry({ home, root }).read(
      FIXTURE_PROJECT_ID,
      reviewed.start.requestId,
    );
    expect(savedIntent.requestHash).toBe(originalHash);
    await waitUntil(() => {
      const row = readShiftRecord(join(home, SHIFTS_DIR), savedIntent.shiftId);
      return admissions(admissionsFile).length === 1 && row?.state === "stopped"
        ? row
        : null;
    }, "the first canonical Shift and provider admission");
    const firstAdmissions = admissions(admissionsFile);
    expect(firstAdmissions).toHaveLength(1);
    const providerPid = firstAdmissions[0]?.pid;
    if (providerPid === undefined)
      throw new Error("Provider admission pid was absent");
    const canonicalA = projectShiftReceiptSchema.parse(
        await readOk(originA, canonicalPath, tokenA),
      ),
      startEvents = queryEvents(
        { workspace: root, kinds: ["operator.action", "shift.started"] },
        { path: ledger },
      ),
      keeperActions = startEvents.filter(
        (event) =>
          event.kind === "operator.action" &&
          event.payload.action === "keeper.proposal.shift.start" &&
          event.payload.target === proposal.id,
      );
    expect(canonicalA.intent.request).toEqual(reviewed.start);
    expect(canonicalA.intent.requestHash).toBe(originalHash);
    expect(canonicalA.intent.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(keeperActions).toHaveLength(1);
    const shiftStarted = startEvents.filter(
      (event) => event.kind === "shift.started",
    );
    expect(shiftStarted).toHaveLength(1);
    const audit = keeperActions[0];
    if (!audit || audit.kind !== "operator.action")
      throw new Error("Keeper Start audit row was absent");
    const canonicalStart = shiftStarted[0];
    if (!canonicalStart || canonicalStart.kind !== "shift.started")
      throw new Error("Canonical Shift start audit row was absent");
    expect(audit.id).toBeLessThan(canonicalStart.id);
    const durableBeforeGet = readFileSync(keeperFile, "utf8"),
      originalA = keeperShiftStartReceiptSchema.parse(
        await readOk(originA, originalPath, tokenA),
      );
    expect(originalA.original).toEqual(reviewed);
    expect(originalA.record.auditEventId).toBe(audit.id);
    expect(originalA.startHash).toBe(originalHash);
    expect(originalA.shift?.intent.requestHash).toBe(originalHash);
    expect(admissions(admissionsFile)).toHaveLength(1);
    expect(readFileSync(keeperFile, "utf8")).toBe(durableBeforeGet);

    const shiftRecord = readShiftRecord(
      join(home, SHIFTS_DIR),
      savedIntent.shiftId,
    );
    if (!shiftRecord || shiftRecord.state !== "stopped")
      throw new Error(
        "Canonical Shift record was not durably stopped before host restart",
      );
    const shiftPid = shiftRecord.pid,
      oldPort = hostA.port;
    if (oldPort === null) throw new Error("First host port was not recorded");
    await stopHost(hostA);
    await waitUntil(
      () =>
        !isPidAlive(hostA.pid) &&
        !isPidAlive(shiftPid) &&
        !isPidAlive(providerPid)
          ? true
          : null,
      "first host and engine process exit",
    );
    expect(await portCanBind(oldPort)).toBe(true);

    const hostB = await startHost(
        hearthBinary,
        root,
        home,
        bin,
        userHome,
        join(stateDir, "provider.json"),
        owned,
      ),
      originB = `http://127.0.0.1:${hostB.port}`,
      tokenB = await sessionToken(originB, session),
      beforeInspect = admissions(admissionsFile).length,
      durableAfterRestart = readFileSync(keeperFile, "utf8"),
      protectedB = keeperShiftStartReceiptSchema.parse(
        await readOk(originB, originalPath, tokenB),
      ),
      canonicalB = projectShiftReceiptSchema.parse(
        await readOk(originB, canonicalPath, tokenB),
      );
    expect(beforeInspect).toBe(1);
    expect(protectedB.original).toEqual(reviewed);
    expect(protectedB.record.auditEventId).toBe(audit.id);
    expect(protectedB.shift?.intent.requestHash).toBe(originalHash);
    expect(canonicalB.intent).toEqual(canonicalA.intent);
    expect(readFileSync(keeperFile, "utf8")).toBe(durableAfterRestart);
    expect(admissions(admissionsFile)).toHaveLength(1);

    const exact = await postStart(originB, startPath, tokenB, reviewed);
    expect(exact.status).toBe(200);
    const exactBody = keeperShiftStartReceiptSchema.parse(
      parseEnvelope(await exact.text(), "Exact Keeper retry"),
    );
    expect(exactBody.original).toEqual(reviewed);
    expect(exactBody.shift?.intent.requestHash).toBe(originalHash);
    expect(admissions(admissionsFile)).toHaveLength(1);

    const edited = structuredClone(reviewed);
    edited.start.options.maxBeads = 2;
    const changed = await postStart(originB, startPath, tokenB, edited);
    expect(changed.status).toBe(409);
    await changed.body?.cancel();
    expect(admissions(admissionsFile)).toHaveLength(1);
    const finalActions = queryEvents(
      { workspace: root, kinds: ["operator.action"] },
      { path: ledger },
    ).filter(
      (event) =>
        event.kind === "operator.action" &&
        event.payload.action === "keeper.proposal.shift.start" &&
        event.payload.target === proposal.id,
    );
    expect(finalActions).toHaveLength(3);
    const portB = hostB.port;
    if (portB === null) throw new Error("Restarted host port was not recorded");
    await stopHost(hostB);
    await waitUntil(
      () =>
        !isPidAlive(hostB.pid) &&
        !isPidAlive(shiftPid) &&
        !isPidAlive(providerPid)
          ? true
          : null,
      "restarted host and original task process exit",
    );
    expect(await portCanBind(portB)).toBe(true);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const host of [...owned].reverse()) {
    try {
      await stopHost(host);
    } catch (error) {
      cleanupErrors.push(error);
      killTree(host.pid);
    }
  }
  for (const ledger of ledgers) {
    try {
      closeLedger(ledger);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    scratch.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length)
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Keeper compiled proof failed and cleanup reported errors",
      );
    throw primaryError;
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      "Keeper compiled proof cleanup failed",
    );
}
