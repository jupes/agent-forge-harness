import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { loadConfig } from "../config/load";
import { resolveSmith } from "../config/resolve";
import { ConversationError } from "../conversations/error";
import { claudeAdapter } from "../executors/claude";
import { createCodexAdapter } from "../executors/codex";
import { syncCodexSkills } from "../executors/codex-sync";
import { buildChildEnv } from "../executors/env";
import { PrivateCaptureError } from "../executors/private-capture";
import { readHomeFile, readSessionTranscript } from "../hearth/home-guard";
import { projectSnapshotReader } from "../hearth/routes/project-summaries";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { smithFor } from "../scheduler/queue";
import { runShift, type ShiftDeps } from "../scheduler/shift";
import {
  interruptShift,
  runOptions,
  shiftCliDeps,
} from "../scheduler/shift-cli-runtime";
import { readShiftRecord, SHIFTS_DIR } from "../scheduler/shift-store";
import { canonicalSessionInput } from "../sessions/preparation";
import { createShiftAttemptCapture } from "./attempt-capture";
import type { ProjectShiftExecutionRuntime } from "./execution";
import { observeProjectShift } from "./observations";
import { createShiftPrBodyCheck } from "./pr-check";
import { createShiftProviderPreparer } from "./provider-prepare";
import { createProjectShiftRegistry, projectShiftFlags } from "./registry";
import { createProjectShiftScopeValidator } from "./scope";

const activeRecordSchema = z
  .object({
    pid: z.number().int().positive(),
    state: z.literal("running"),
    beads: z
      .array(
        z
          .object({
            beadId: z.string(),
            runId: z.string(),
            outcome: z.string(),
            attempts: z.number().int().nonnegative(),
            smith: z.string().optional(),
            worktree: z.string().optional(),
          })
          .passthrough(),
      )
      .max(10000),
  })
  .passthrough();
function currentAttempt(
  home: string,
  dir: string,
  intent: ProjectShiftIntent,
  beadId: string,
  runId: string,
) {
  const file = join(dir, `${intent.shiftId}.json`);
  for (const [path, folder] of [
    [dir, true],
    [file, false],
  ] as const) {
    const info = lstatSync(path);
    if (
      info.isSymbolicLink() ||
      (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    )
      throw new PrivateCaptureError();
  }
  if (readHomeFile(dir).problem !== null) throw new PrivateCaptureError();
  const found = readSessionTranscript(home, file);
  if (found.problem !== null || found.text === null)
    throw new PrivateCaptureError();
  let raw: unknown;
  try {
    raw = JSON.parse(found.text);
  } catch {
    throw new PrivateCaptureError();
  }
  const checked = activeRecordSchema.safeParse(raw);
  if (
    !checked.success ||
    checked.data.pid !== process.pid ||
    observeProjectShift(intent, { record: raw, alive: true }).actual === null
  )
    throw new PrivateCaptureError();
  const matches = checked.data.beads.filter(
    (entry) => entry.beadId === beadId && entry.runId === runId,
  );
  if (matches.length !== 1) throw new PrivateCaptureError();
  return matches[0];
}

export interface AttendedProjectShiftCommands {
  codexSyncCommand?: readonly string[];
  interactiveBootstrapCommand?: readonly string[];
}

/** Trusted process composition only; no HTTP/CLI input can supply dependencies, programs or paths. */
export function createAttendedProjectShiftExecutionRuntime(options: {
  root: string;
  home: string;
  configHome?: string;
  environment?: Record<string, string | undefined>;
  commands?: AttendedProjectShiftCommands;
  /** A hermetic host fixture may replace tracker/Git/worktree I/O, but never the attended provider adapters. */
  dependencies?: ShiftDeps;
}): ProjectShiftExecutionRuntime {
  const environment = Object.fromEntries(
    Object.entries(options.environment ?? process.env).filter(
      ([key]) => key.toLowerCase() !== "agent_forge_smith",
    ),
  );
  const base =
    options.dependencies ??
    shiftCliDeps(options.root, {
      ...environment,
      AGENT_FORGE_HOME: options.home,
    });
  const workspace = resolveCheckout(options.root).workspace;
  if (
    workspaceKey(resolveCheckout(base.root).workspace) !==
      workspaceKey(workspace) ||
    workspaceKey(base.shiftsDir) !==
      workspaceKey(join(options.home, SHIFTS_DIR))
  )
    throw new ConversationError(
      503,
      "The attended shift host does not match this private workspace.",
    );
  const originals = createProjectShiftRegistry(options);
  const load = () =>
    loadConfig({
      harnessRoot: options.root,
      env: {},
      ...(options.configHome ? { home: options.configHome } : {}),
    });
  const scope = createProjectShiftScopeValidator({
    workspace,
    load: projectSnapshotReader(options.home, {
      root: options.root,
      workspace,
      ledgerPath: base.ledgerPath,
      runBd: base.runBd,
      ...(options.configHome ? { configHome: options.configHome } : {}),
    }),
    loadConfig: load,
  });
  const prepareProvider = createShiftProviderPreparer({
    root: options.root,
    environment,
    ...(options.configHome ? { configHome: options.configHome } : {}),
  });
  const syncCommand = options.commands?.codexSyncCommand ?? [
    process.execPath,
    resolve(import.meta.dir, "../sync-codex.ts"),
  ];
  const adapters = {
    claude: claudeAdapter,
    codex: createCodexAdapter({
      approvalPolicy: "never",
      prepare: (request) =>
        syncCodexSkills({
          workspace: request.workspace,
          worktree: request.worktree,
          command: syncCommand,
          env: buildChildEnv(request.env, []),
          ...(request.signal ? { signal: request.signal } : {}),
          timeoutMs: Math.min(request.timeoutMs ?? 30000, 30000),
        }),
    }),
  };
  let preparedFor: string | null = null,
    entered = false;
  const checkedOriginal = (intent: ProjectShiftIntent) => {
    const saved = originals.read(intent.projectId, intent.request.requestId);
    if (
      !saved.attemptedAt ||
      !saved.executionStartedAt ||
      canonicalSessionInput(saved) !== canonicalSessionInput(intent)
    )
      throw new ConversationError(
        409,
        "The immutable original shift execution could not be verified.",
      );
    return saved;
  };
  const key = (intent: ProjectShiftIntent) =>
    `${intent.projectId}/${intent.request.requestId}/${intent.requestHash}`;
  return {
    attended: true,
    async prepare(input) {
      if (entered)
        throw new ConversationError(
          409,
          "This attended engine entry was already consumed.",
        );
      const intent = checkedOriginal(input);
      await scope.validateStart(intent.projectId, intent.request);
      if (intent.request.options.smith) {
        const selected = resolveSmith(load().config, {
          explicit: intent.request.options.smith,
        });
        if (
          !selected.ok ||
          !["claude", "codex"].includes(selected.smith.provider)
        )
          throw new ConversationError(
            503,
            "This selected smith has no verified attended shift adapter.",
          );
      }
      preparedFor = key(intent);
    },
    async run(input) {
      const intent = checkedOriginal(input);
      if (entered || preparedFor !== key(intent))
        throw new ConversationError(
          409,
          "The attended engine was not freshly prepared or was already entered.",
        );
      entered = true;
      await scope.validateStart(intent.projectId, intent.request);
      const parsed = runOptions(projectShiftFlags(intent.request));
      if (!parsed.ok)
        throw new ConversationError(
          400,
          "The original reviewed shift bounds are invalid.",
        );
      const beforeStart = scope.beforeStart(intent.projectId, intent.request);
      const interrupt = interruptShift(
        { say: () => {}, exit: (code) => process.exit(code) },
        () => ({
          id: intent.shiftId,
          recorded: readShiftRecord(base.shiftsDir, intent.shiftId) !== null,
        }),
      );
      try {
        const outcome = await runShift(parsed.value, {
          ...base,
          shiftId: intent.shiftId,
          signal: interrupt.signal,
          exec: {
            env: environment,
            ...(options.configHome ? { home: options.configHome } : {}),
            ...(base.exec?.command ? { command: base.exec.command } : {}),
            adapters,
            ...(options.commands?.interactiveBootstrapCommand
              ? {
                  privateBootstrapCommand:
                    options.commands.interactiveBootstrapCommand,
                }
              : {}),
          },
          checkPrBody: createShiftPrBodyCheck(
            join(base.shiftsDir, intent.shiftId),
          ),
          async beforeStart(id, shown) {
            if (!(await beforeStart(id, shown))) return false;
            const config = load().config;
            const selected = intent.request.options.smith
              ? resolveSmith(config, { explicit: intent.request.options.smith })
              : smithFor(config, {
                  id,
                  labels: Array.isArray(shown["labels"])
                    ? shown["labels"].filter(
                        (value): value is string => typeof value === "string",
                      )
                    : [],
                  metadata: shown["metadata"],
                });
            return (
              selected.ok &&
              ["claude", "codex"].includes(selected.smith.provider)
            );
          },
          captureAttempt(source) {
            if (source.shiftId !== intent.shiftId)
              throw new PrivateCaptureError();
            return createShiftAttemptCapture({
              home: options.home,
              intent,
              attempt: source.attempt,
              prepare: prepareProvider,
              async validate(actual, signal) {
                if (
                  signal.aborted ||
                  actual.beadId !== source.beadId ||
                  actual.runId !== source.runId
                )
                  throw new PrivateCaptureError();
                await scope.validateAttempt(
                  intent.projectId,
                  intent.request,
                  actual.beadId,
                );
                if (signal.aborted) throw new PrivateCaptureError();
                const entry = currentAttempt(
                  options.home,
                  base.shiftsDir,
                  intent,
                  source.beadId,
                  source.runId,
                );
                if (
                  !entry ||
                  entry.outcome !== "running" ||
                  entry.attempts !== source.attempt ||
                  entry.smith !== actual.smith.name ||
                  !entry.worktree ||
                  workspaceKey(entry.worktree) !== workspaceKey(actual.cwd)
                )
                  throw new PrivateCaptureError();
              },
            });
          },
        });
        if (!outcome.ok)
          throw new ConversationError(
            503,
            "The original attended shift did not enter or finish its canonical engine. Read its original request.",
          );
      } finally {
        interrupt.release();
      }
    },
  };
}
