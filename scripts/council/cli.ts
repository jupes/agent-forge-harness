#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "path";
import {
  assertCouncilRunId,
  readCouncilRun,
  renderCouncilReport,
} from "./artifacts";
import { type SecretPolicy, sanitizeContent } from "./context";
import { providerReadiness } from "./providers";
import {
  type ContextSourceKind,
  type CouncilEvent,
  estimateCouncilCost,
} from "./types";
import {
  type CouncilReviewOptions,
  executeCouncilReview,
  loadCouncilProfile,
  prepareCouncilContext,
} from "./workflow";

export { loadCouncilProfile } from "./workflow";

const USAGE = `Agent Forge Council

Usage:
  bun run council -- file <path> [options]
  bun run council -- plan <path> [options]
  bun run council -- pr <number-or-url> [options]
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
  if (
    command !== "file" &&
    command !== "plan" &&
    command !== "pr" &&
    command !== "stdin"
  ) {
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
        try {
          assertCouncilRunId(value);
        } catch {
          return {
            ok: false,
            error: "--run-id must be a safe, non-reserved run name",
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
  const message = sanitizeContent(
    error instanceof Error ? error.message : String(error),
    "redact",
  ).text.slice(0, 1000);
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

    const profilePath = command.profilePath
      ? resolve(io.cwd, command.profilePath)
      : fileURLToPath(new URL("../../councils/default.json", import.meta.url));
    const profile = loadCouncilProfile(profilePath);
    const context = await prepareCouncilContext({
      kind: command.sourceKind,
      source:
        command.sourceKind === "stdin"
          ? await io.readStdin()
          : command.sourcePath!,
      workspaceRoot: io.cwd,
      secretPolicy: command.secretPolicy,
      maxBytes: command.maxBytes,
    });
    const estimatedCostUsd = estimateCouncilCost(profile);
    const budget = command.maxUsd ?? profile.maxEstimatedUsd;
    const readiness = providerReadiness(profile);
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
        providerReadiness: readiness,
      };
      if (command.json) emitEnvelope(io, true, data, null);
      else {
        io.stdout(
          [
            `Dry run: ${profile.title}`,
            `Source: ${context.source.displayName} (${context.byteLength} bytes${context.truncated ? ", truncated" : ""})`,
            `Seats: ${profile.seats.map((seat) => `${seat.id}=${seat.provider}/${seat.model}`).join(", ")}`,
            `Providers: ${readiness.map((provider) => `${provider.provider}=${provider.configured ? "ready" : `missing ${provider.missing.join(",")}`}`).join(", ")}`,
            `Estimated cost: $${estimatedCostUsd.toFixed(4)} / budget $${budget.toFixed(4)}`,
            "No model calls were made.",
            "",
          ].join("\n"),
        );
      }
      return estimatedCostUsd <= budget ? 0 : 1;
    }

    const runId =
      command.runId ?? `council-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const engineOptions: CouncilReviewOptions = {
      profile,
      context,
      runId,
      runsRoot,
    };
    if (io.signal) engineOptions.signal = io.signal;
    if (command.maxUsd !== undefined) engineOptions.maxUsd = command.maxUsd;
    if (!command.json) {
      engineOptions.onEvent = (event) => {
        const line = progressLine(event);
        if (line) io.stderr(line);
      };
    }
    const { result, artifacts } = await executeCouncilReview(engineOptions);
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
