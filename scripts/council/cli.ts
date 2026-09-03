#!/usr/bin/env bun

import { readFileSync } from "fs";
import { resolve } from "path";
import {
  readCouncilRun,
  renderCouncilReport,
  writeCouncilArtifacts,
} from "./artifacts";
import {
  buildContextPack,
  type ContextInput,
  type SecretPolicy,
} from "./context";
import { FakeCouncilTransport, runCouncil } from "./engine";
import {
  type ContextSourceKind,
  type CouncilEvent,
  type CouncilProfile,
  estimateCouncilCost,
  parseCouncilProfileJson,
} from "./types";

const USAGE = `Agent Forge Council

Usage:
  bun run council -- file <path> [options]
  bun run council -- plan <path> [options]
  <command> | bun run council -- stdin [options]
  bun run council -- replay <run-id-or-manifest> [options]

Options:
  --profile <path>       Council profile JSON (default: councils/default.json)
  --runs-dir <path>      Artifact root (default: reports/council-runs)
  --max-usd <amount>     Hard estimated-cost budget
  --max-bytes <bytes>    Maximum source bytes (default: 200000)
  --run-id <id>          Stable run id for automation
  --redact-secrets       Redact detected credentials instead of rejecting input
  --dry-run              Resolve context and estimate cost without model calls
  --json                 Emit the standard { ok, data, error } envelope
  --help                  Show this help
`;

type RunCommand = {
  kind: "run";
  sourceKind: ContextSourceKind;
  sourcePath?: string;
  profilePath?: string;
  runsDir?: string;
  maxUsd?: number;
  maxBytes?: number;
  runId?: string;
  secretPolicy: SecretPolicy;
  dryRun: boolean;
  json: boolean;
};

type ReplayCommand = {
  kind: "replay";
  pathOrRunId: string;
  runsDir?: string;
  json: boolean;
};

export type CouncilCliCommand =
  | RunCommand
  | ReplayCommand
  | { kind: "help"; json: boolean };

export type ParseCliResult =
  | { ok: true; value: CouncilCliCommand }
  | { ok: false; error: string; json: boolean };

function parseNonNegativeNumber(value: string, flag: string): number | string {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return `${flag} must be a non-negative number`;
  }
  return number;
}

function parsePositiveInt(value: string, flag: string): number | string {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return `${flag} must be a positive integer`;
  }
  return number;
}

export function parseCouncilCliArgs(args: string[]): ParseCliResult {
  const json = args.includes("--json");
  if (args.length === 0 || args.includes("--help") || args[0] === "help") {
    return { ok: true, value: { kind: "help", json } };
  }
  const command = args[0];
  if (command === "replay") {
    const pathOrRunId = args[1];
    if (!pathOrRunId || pathOrRunId.startsWith("--")) {
      return { ok: false, error: "replay requires a run id or path", json };
    }
    let runsDir: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--json") continue;
      if (arg === "--runs-dir") {
        const value = args[index + 1];
        if (!value || value.startsWith("--"))
          return { ok: false, error: "--runs-dir needs a value", json };
        runsDir = value;
        index += 1;
        continue;
      }
      return { ok: false, error: `unknown replay option: ${arg}`, json };
    }
    const value: ReplayCommand = { kind: "replay", pathOrRunId, json };
    if (runsDir) value.runsDir = runsDir;
    return { ok: true, value };
  }
  if (command !== "file" && command !== "plan" && command !== "stdin") {
    return { ok: false, error: `unknown command: ${command}`, json };
  }
  const sourcePath = command === "stdin" ? undefined : args[1];
  if (command !== "stdin" && (!sourcePath || sourcePath.startsWith("--"))) {
    return { ok: false, error: `${command} requires a path`, json };
  }
  const start = command === "stdin" ? 1 : 2;
  let profilePath: string | undefined;
  let runsDir: string | undefined;
  let maxUsd: number | undefined;
  let maxBytes: number | undefined;
  let runId: string | undefined;
  let secretPolicy: SecretPolicy = "reject";
  let dryRun = false;
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") continue;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--redact-secrets") {
      secretPolicy = "redact";
      continue;
    }
    if (
      arg === "--profile" ||
      arg === "--runs-dir" ||
      arg === "--max-usd" ||
      arg === "--max-bytes" ||
      arg === "--run-id"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: `${arg} needs a value`, json };
      }
      if (arg === "--profile") profilePath = value;
      if (arg === "--runs-dir") runsDir = value;
      if (arg === "--run-id") {
        if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
          return {
            ok: false,
            error:
              "--run-id may contain only letters, numbers, dot, underscore, and hyphen",
            json,
          };
        }
        runId = value;
      }
      if (arg === "--max-usd") {
        const parsed = parseNonNegativeNumber(value, arg);
        if (typeof parsed === "string")
          return { ok: false, error: parsed, json };
        maxUsd = parsed;
      }
      if (arg === "--max-bytes") {
        const parsed = parsePositiveInt(value, arg);
        if (typeof parsed === "string")
          return { ok: false, error: parsed, json };
        maxBytes = parsed;
      }
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown option: ${arg}`, json };
  }
  const value: RunCommand = {
    kind: "run",
    sourceKind: command,
    secretPolicy,
    dryRun,
    json,
  };
  if (sourcePath) value.sourcePath = sourcePath;
  if (profilePath) value.profilePath = profilePath;
  if (runsDir) value.runsDir = runsDir;
  if (maxUsd !== undefined) value.maxUsd = maxUsd;
  if (maxBytes !== undefined) value.maxBytes = maxBytes;
  if (runId) value.runId = runId;
  return { ok: true, value };
}

export type CouncilCliIo = {
  cwd: string;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
};

function defaultIo(): CouncilCliIo {
  return {
    cwd: process.cwd(),
    readStdin: () => Bun.stdin.text(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function emitEnvelope(
  io: CouncilCliIo,
  ok: boolean,
  data: unknown,
  error: string | null,
): void {
  io.stdout(`${JSON.stringify({ ok, data, error }, null, 2)}\n`);
}

function loadProfile(path: string): CouncilProfile {
  const parsed = parseCouncilProfileJson(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error(`invalid council profile: ${parsed.error}`);
  return parsed.value;
}

function progressLine(event: CouncilEvent): string | null {
  if (event.type === "stage.started") {
    return `→ ${String(event.payload.stage)} round started\n`;
  }
  if (event.type === "seat.completed") {
    return `  ✓ ${String(event.payload.seatId)} (${String(event.payload.stage)})\n`;
  }
  if (event.type === "seat.failed") {
    return `  ✗ ${String(event.payload.seatId)} (${String(event.payload.stage)}): ${String(event.payload.error)}\n`;
  }
  if (event.type === "run.cancelled") return "Council run cancelled.\n";
  return null;
}

function errorResult(io: CouncilCliIo, json: boolean, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (json) emitEnvelope(io, false, null, message);
  else io.stderr(`Error: ${message}\n`);
  return 1;
}

export async function runCouncilCli(
  args: string[],
  overrides: Partial<CouncilCliIo> = {},
): Promise<number> {
  const defaults = defaultIo();
  const io: CouncilCliIo = { ...defaults, ...overrides };
  const parsed = parseCouncilCliArgs(args);
  if (!parsed.ok) return errorResult(io, parsed.json, parsed.error);
  const command = parsed.value;
  if (command.kind === "help") {
    if (command.json) emitEnvelope(io, true, { usage: USAGE }, null);
    else io.stdout(USAGE);
    return 0;
  }
  try {
    const runsRoot = resolve(io.cwd, command.runsDir ?? "reports/council-runs");
    if (command.kind === "replay") {
      const run = readCouncilRun(command.pathOrRunId, runsRoot);
      if (command.json) emitEnvelope(io, true, { run }, null);
      else io.stdout(`${renderCouncilReport(run)}\n`);
      return 0;
    }

    const profilePath = resolve(
      io.cwd,
      command.profilePath ?? "councils/default.json",
    );
    const profile = loadProfile(profilePath);
    const inputText =
      command.sourceKind === "stdin" ? await io.readStdin() : undefined;
    const contextInput: ContextInput =
      command.sourceKind === "stdin"
        ? {
            kind: "stdin",
            text: inputText ?? "",
            secretPolicy: command.secretPolicy,
          }
        : {
            kind: command.sourceKind,
            path: command.sourcePath!,
            cwd: io.cwd,
            secretPolicy: command.secretPolicy,
          };
    if (command.maxBytes !== undefined) {
      contextInput.maxBytes = command.maxBytes;
    }
    const context = buildContextPack(contextInput);
    const estimatedCostUsd = estimateCouncilCost(profile);
    const budget = command.maxUsd ?? profile.maxEstimatedUsd;
    if (command.dryRun) {
      const data = {
        dryRun: true,
        profile: {
          id: profile.id,
          depth: profile.depth,
          seats: profile.seats.map((seat) => ({
            id: seat.id,
            role: seat.role,
            provider: seat.provider,
            model: seat.model,
          })),
          chair: {
            id: profile.chair.id,
            provider: profile.chair.provider,
            model: profile.chair.model,
          },
        },
        context: {
          source: context.source,
          contentHash: context.contentHash,
          byteLength: context.byteLength,
          truncated: context.truncated,
          redactions: context.redactions,
        },
        estimatedCostUsd,
        budgetUsd: budget,
        budgetAllowed: estimatedCostUsd <= budget,
      };
      if (command.json) emitEnvelope(io, true, data, null);
      else {
        io.stdout(
          [
            `Dry run: ${profile.title}`,
            `Source: ${context.source.displayName} (${context.byteLength} bytes${context.truncated ? ", truncated" : ""})`,
            `Seats: ${profile.seats.map((seat) => `${seat.id}=${seat.provider}/${seat.model}`).join(", ")}`,
            `Estimated cost: $${estimatedCostUsd.toFixed(4)} / budget $${budget.toFixed(4)}`,
            "No model calls were made.",
            "",
          ].join("\n"),
        );
      }
      return estimatedCostUsd <= budget ? 0 : 1;
    }

    const unsupported = [...profile.seats, profile.chair].find(
      (seat) => seat.provider !== "fake",
    );
    if (unsupported) {
      throw new Error(
        `provider ${unsupported.provider} is not available in the protocol-kernel slice; use a fake profile`,
      );
    }
    const fakeTransport = new FakeCouncilTransport();
    const engineOptions: Parameters<typeof runCouncil>[0] = {
      profile,
      context,
      resolveTransport: () => fakeTransport,
    };
    if (io.signal) engineOptions.signal = io.signal;
    if (command.maxUsd !== undefined) engineOptions.maxUsd = command.maxUsd;
    if (command.runId) engineOptions.runId = command.runId;
    if (!command.json) {
      engineOptions.onEvent = (event) => {
        const line = progressLine(event);
        if (line) io.stderr(line);
      };
    }
    const result = await runCouncil(engineOptions);
    const artifacts = writeCouncilArtifacts(result.run, runsRoot);
    if (command.json) {
      emitEnvelope(
        io,
        result.ok,
        { run: result.run, artifacts },
        result.ok ? null : result.error,
      );
    } else {
      io.stdout(
        `${renderCouncilReport(result.run)}\nReport: ${artifacts.report}\n`,
      );
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    return errorResult(io, command.json, error);
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);
  process.exitCode = await runCouncilCli(process.argv.slice(2), {
    signal: controller.signal,
  });
  process.removeListener("SIGINT", onInterrupt);
}
