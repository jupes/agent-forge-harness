import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { KeeperShiftStartRequest } from "../../types/keeper-shift-start";
import { createConversationStore } from "../conversations/store";
import { buildChildEnv } from "../executors/env";
import { PRIVATE_CAPTURE_FAILURE } from "../executors/private-capture";
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
import { resolveCheckout } from "../ledger/workspace";
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
const nativeCall = z
  .object({
    tool: z.string().max(64),
    args: z.array(z.string().max(2048)).max(64),
  })
  .passthrough();
const refusalEnvelope = z
  .object({ ok: z.literal(false), data: z.null(), error: z.string().max(512) })
  .strict();
const READY_MS = 20_000;
const STOP_MS = 12_000;
const REQUEST_MS = 10_000;
const DRAIN_MS = 5_000;
const REFUSAL_BODY_MAX_BYTES = 4_096;

/** Physical root spelling for fixture I/O and child arguments. */
export function physicalKeeperProofRoot(root: string): string {
  return realpathSync.native(resolve(root));
}

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
  outputAbort: AbortController;
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
  signal: AbortSignal,
): Promise<void> {
  return (async () => {
    const reader = stream.getReader(),
      decoder = new TextDecoder(),
      cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        record(decoder.decode(value, { stream: true }));
      }
      const rest = decoder.decode();
      if (rest) record(rest);
    } finally {
      signal.removeEventListener("abort", cancel);
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
        HEARTH_PORT: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  let readyResolve: ((port: number) => void) | undefined,
    readyReject: ((error: Error) => void) | undefined,
    startupText = "";
  const outputAbort = new AbortController();
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
    outputAbort,
    exited: child.exited.then((code) => {
      host.exitCode = code;
      readyReject?.(new Error(`Compiled hearth exited before ready (${code})`));
      return code;
    }),
    outputError: null,
  };
  owned.push(host);
  host.stdoutDone = drain(
    child.stdout,
    (chunk) => {
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
    },
    outputAbort.signal,
  ).catch((error: unknown) => {
    host.outputError = error instanceof Error ? error.message : String(error);
  });
  host.stderrDone = drain(
    child.stderr,
    (chunk) => {
      host.stderr = addTail(host.stderr, chunk);
    },
    outputAbort.signal,
  ).catch((error: unknown) => {
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
  const errors: unknown[] = [];
  if (host.exitCode === null) {
    try {
      // Bun's Windows child signal is a termination request, not proof of graceful app shutdown.
      host.process.kill("SIGTERM");
    } catch {
      // The bounded wait and owner fallback below determine whether it remains alive.
    }
    try {
      await waitBounded(host.exited, "Compiled hearth exit", STOP_MS);
    } catch {
      try {
        killTree(host.pid);
        await waitBounded(
          host.exited,
          "Compiled hearth tree exit after owner kill",
          STOP_MS,
        );
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (host.exitCode === null) {
    try {
      killTree(host.pid);
      await waitBounded(
        host.exited,
        "Compiled hearth tree exit after final owner kill",
        STOP_MS,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (host.exitCode !== null && host.port !== null) {
    try {
      await waitUntil(
        async () => ((await portCanBind(host.port!)) ? true : null),
        "Compiled hearth port release",
        STOP_MS,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  for (const [name, drain] of [
    ["stdout", host.stdoutDone],
    ["stderr", host.stderrDone],
  ] as const) {
    try {
      await waitBounded(drain, `Compiled hearth ${name} drain`, DRAIN_MS);
    } catch (error) {
      errors.push(error);
      host.outputAbort.abort();
      try {
        await waitBounded(
          drain,
          `Compiled hearth ${name} drain after cancellation`,
          STOP_MS,
        );
      } catch (cancelError) {
        errors.push(cancelError);
      }
    }
  }
  if (host.outputError !== null)
    errors.push(new Error("Compiled hearth output did not drain cleanly"));
  if (errors.length)
    throw new AggregateError(errors, "Compiled hearth cleanup failed");
}

async function waitBounded<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its ${timeoutMs}ms bound`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil<T>(
  read: () => T | null | Promise<T | null>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
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

export function keeperWaitFacts(
  home: string,
  shiftId: string,
  admissionsFile: string,
  nativeCallsFile: string,
): string {
  const row = readShiftRecord(join(home, SHIFTS_DIR), shiftId);
  let admissionCount = "unreadable";
  try {
    admissionCount = String(admissions(admissionsFile).length);
  } catch {
    // Preserve the timeout and report only the fact that the fixture log was unreadable.
  }
  let methods: string[] = [];
  try {
    if (existsSync(nativeCallsFile)) {
      methods = readFileSync(nativeCallsFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-12)
        .flatMap((line) => {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return [];
          }
          const parsed = nativeCall.safeParse(raw);
          if (!parsed.success) return [];
          const tool = basename(parsed.data.tool).replace(/\.exe$/i, ""),
            method = parsed.data.args
              .slice(0, 2)
              .map((part) =>
                /^[A-Za-z0-9_.-]{1,32}$/.test(part) ? part : "arg",
              )
              .join(" ");
          return /^[A-Za-z0-9_.-]{1,32}$/.test(tool)
            ? [`${tool}:${method || "unknown"}`]
            : [];
        });
    }
  } catch {
    methods = ["unreadable"];
  }
  const reason = typeof row?.reason === "string" ? row.reason : "none";
  const boundedReason = reason
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 160);
  const errorClass =
    row?.error === PRIVATE_CAPTURE_FAILURE
      ? "private-capture"
      : typeof row?.error === "string" &&
          row.error.startsWith("the shift failed:")
        ? "shift-loop"
        : row?.error === undefined
          ? "none"
          : "other";
  const admittedValue = row?.admitted;
  const admitted =
    typeof admittedValue === "number" &&
    Number.isSafeInteger(admittedValue) &&
    admittedValue >= 0 &&
    admittedValue <= 100
      ? String(admittedValue)
      : "unknown";
  const outcomes = ["running", "review", "released", "halted", "left", "set-aside"];
  let beadFacts = "unknown";
  const rowBeads = row?.beads;
  if (Array.isArray(rowBeads) && rowBeads.length <= 100) {
    const counts = new Map(outcomes.map((outcome) => [outcome, 0]));
    let attempts = 0;
    let valid = true;
    for (const bead of rowBeads) {
      if (
        typeof bead !== "object" ||
        bead === null ||
        !("outcome" in bead) ||
        !("attempts" in bead) ||
        typeof bead.outcome !== "string" ||
        !counts.has(bead.outcome) ||
        !Number.isSafeInteger(bead.attempts) ||
        bead.attempts < 0 ||
        bead.attempts > 11
      ) {
        valid = false;
        break;
      }
      counts.set(bead.outcome, (counts.get(bead.outcome) ?? 0) + 1);
      attempts += bead.attempts;
    }
    if (valid)
      beadFacts = `${rowBeads.length};${outcomes.map((outcome) => counts.get(outcome)).join(",")};${attempts}`;
  }
  return `shiftState=${row?.state ?? "missing"}; reason=${boundedReason}; errorClass=${errorClass}; recordAdmitted=${admitted}; beadFacts=${beadFacts}; admissionCount=${admissionCount}; nativeMethods=${methods.join(",").slice(0, 400) || "none"}`.slice(0, 800);
}

async function acquireOperatorSession(
  origin: string,
  home: string,
  root: string,
) {
  const token = readToken(tokenPath(home, root));
  if (token === null)
    throw new Error("Compiled hearth token was not published");
  const launch = await boundedFetch(`${origin}${LAUNCH_ROUTE}`, {
    method: "POST",
    headers: {
      Origin: origin,
      [OPERATOR_HEADER]: token,
      [SURFACE_HEADER]: "api",
    },
  });
  if (launch.status !== 200) {
    await cancelBody(launch);
    throw new Error("Compiled hearth refused its local launch fixture");
  }
  const launchValue = z
    .object({ secret: z.string().regex(/^[0-9a-f]{64}$/) })
    .parse(parseEnvelope(await launch.text(), "Launch response"));
  const session = await boundedFetch(`${origin}${SESSION_ROUTE}`, {
    method: "POST",
    headers: {
      Origin: origin,
      [LAUNCH_HEADER]: launchValue.secret,
      [SURFACE_HEADER]: "api",
    },
  });
  if (session.status !== 200) {
    await cancelBody(session);
    throw new Error("Compiled hearth refused its same-origin session fixture");
  }
  const key = sessionData.parse(
    parseEnvelope(await session.text(), "Session response"),
  ).key;
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Compiled hearth session cookie was absent");
  return { cookie, key };
}

async function sessionToken(
  origin: string,
  session: { cookie: string; key: string },
) {
  const response = await boundedFetch(`${origin}${TOKEN_ROUTE}`, {
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      [SESSION_KEY_HEADER]: session.key,
    },
  });
  if (response.status !== 200) {
    await cancelBody(response);
    throw new Error(
      "The persisted dashboard session did not survive host restart",
    );
  }
  return tokenData.parse(parseEnvelope(await response.text(), "Token response"))
    .token;
}

async function readOk(
  origin: string,
  path: string,
  token: string,
): Promise<unknown> {
  const response = await boundedFetch(`${origin}${path}`, {
    headers: { Origin: origin, [OPERATOR_HEADER]: token },
  });
  if (response.status !== 200) {
    await cancelBody(response);
    throw new Error("Protected Keeper/Shift read did not succeed");
  }
  return parseEnvelope(await response.text(), "Protected read");
}

async function postStart(
  origin: string,
  path: string,
  token: string,
  request: KeeperShiftStartRequest,
): Promise<Response> {
  return boundedFetch(`${origin}${path}`, {
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

function boundedFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
}

async function cancelBody(response: Response): Promise<void> {
  await waitBounded(
    response.body?.cancel() ?? Promise.resolve(),
    "HTTP response body cancellation",
    REQUEST_MS,
  );
}

/** Read only a bounded standard refusal envelope; never include arbitrary response bodies in test output. */
export async function keeperStartFailureDiagnostic(
  response: Response,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return `status=${response.status}; refusal=missing-body`;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await waitBounded(
        reader.read(),
        "Keeper Start refusal body read",
        REQUEST_MS,
      );
      if (done) break;
      bytes += value.byteLength;
      if (bytes > REFUSAL_BODY_MAX_BYTES) {
        let cancellation = "oversized";
        try {
          await waitBounded(
            reader.cancel(),
            "Keeper Start refusal body cancellation",
            REQUEST_MS,
          );
        } catch {
          cancellation = "oversized-cancel-incomplete";
        }
        return `status=${response.status}; refusal=${cancellation}`;
      }
      chunks.push(value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(content),
      );
    } catch {
      return `status=${response.status}; refusal=malformed`;
    }
    const parsed = refusalEnvelope.safeParse(raw);
    return parsed.success
      ? `status=${response.status}; refusal=${JSON.stringify(parsed.data.error)}`
      : `status=${response.status}; refusal=malformed`;
  } catch {
    try {
      await waitBounded(
        reader.cancel(),
        "Keeper Start refusal body cancellation after read failure",
        REQUEST_MS,
      );
    } catch {
      // A diagnostic cleanup failure must not replace the primary HTTP failure.
    }
    return `status=${response.status}; refusal=unavailable`;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Keep the action refusal as the test's primary error.
    }
  }
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
    const root = physicalKeeperProofRoot(
        scratch.make("compiled keeper shift "),
      ),
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
    const workspace = resolveCheckout(root).workspace;
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
      '[execution.env]\npass=["CODING_FIXTURE_MODE"]\n[shift]\nthrottle=1.0\n',
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
      JSON.stringify(projectCatalogFixture(workspace)),
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
      `import {appendFileSync} from "node:fs"; import {runCodingCliFixture} from ${JSON.stringify(providerFixture)}; const args=process.argv.slice(2); if(args.includes("--version")){console.log("2.1.293 (Claude Code fixture)");} else if(args.includes("--help")){console.log("--print --output-format --verbose --model --effort --permission-mode --allowedTools");} else if(args.slice(-2).join(" ")==="auth status"){console.log(JSON.stringify({authMethod:"api_key",loggedIn:true}));} else if(args.includes("-p")&&args.includes("--output-format")&&args[args.indexOf("--output-format")+1]==="stream-json"){appendFileSync(${JSON.stringify(admissionsFile)}, JSON.stringify({pid:process.pid,cwd:process.cwd()})+"\\n"); await runCodingCliFixture();} else {process.exitCode=2;}`,
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
        workspace,
        reviewed.start,
      );

    const hostA = await startHost(
        hearthBinary,
        root,
        home,
        bin,
        userHome,
        owned,
      ),
      originA = `http://127.0.0.1:${hostA.port}`,
      session = await acquireOperatorSession(originA, home, root),
      tokenA = await sessionToken(originA, session),
      action = await postStart(originA, startPath, tokenA, reviewed);
    if (action.status !== 200) {
      const details = await keeperStartFailureDiagnostic(action).catch(
        () => `status=${action.status}; refusal=unavailable`,
      );
      throw new Error(
        `The reviewed Keeper start was not accepted (${details})`,
      );
    }
    await cancelBody(action);

    const savedIntent = createProjectShiftRegistry({ home, root }).read(
      FIXTURE_PROJECT_ID,
      reviewed.start.requestId,
    );
    expect(savedIntent.requestHash).toBe(originalHash);
    try {
      await waitUntil(() => {
        const row = readShiftRecord(
            join(home, SHIFTS_DIR),
            savedIntent.shiftId,
          ),
          count = admissions(admissionsFile).length;
        return count === 1 && row?.state === "stopped" ? row : null;
      }, "the first canonical Shift and provider admission");
    } catch (error) {
      throw new Error(
        `The first canonical Shift and provider admission did not complete (${keeperWaitFacts(home, savedIntent.shiftId, admissionsFile, join(stateDir, "calls.jsonl"))})`,
        { cause: error },
      );
    }
    const firstAdmissions = admissions(admissionsFile);
    expect(firstAdmissions).toHaveLength(1);
    const providerPid = firstAdmissions[0]?.pid;
    if (providerPid === undefined)
      throw new Error("Provider admission pid was absent");
    const canonicalA = projectShiftReceiptSchema.parse(
        await readOk(originA, canonicalPath, tokenA),
      ),
      startEvents = queryEvents(
        { workspace, kinds: ["operator.action", "shift.started"] },
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
    if (exact.status !== 200) {
      await cancelBody(exact);
      throw new Error("The exact Keeper retry did not return its original");
    }
    const exactBody = keeperShiftStartReceiptSchema.parse(
      parseEnvelope(await exact.text(), "Exact Keeper retry"),
    );
    expect(exactBody.original).toEqual(reviewed);
    expect(exactBody.shift?.intent.requestHash).toBe(originalHash);
    expect(admissions(admissionsFile)).toHaveLength(1);

    const edited = structuredClone(reviewed);
    edited.start.options.maxBeads = 2;
    const changed = await postStart(originB, startPath, tokenB, edited);
    if (changed.status !== 409) {
      await cancelBody(changed);
      throw new Error("The changed Keeper body was not refused");
    }
    await cancelBody(changed);
    expect(admissions(admissionsFile)).toHaveLength(1);
    const finalActions = queryEvents(
      { workspace, kinds: ["operator.action"] },
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
