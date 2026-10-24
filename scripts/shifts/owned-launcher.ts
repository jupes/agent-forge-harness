import { realpathSync } from "node:fs";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { SHIFT_ENGINE_GRACE_MS } from "../executors/interactive-lifetime";
import {
  type InteractiveSuperviseOptions,
  supervise,
} from "../executors/supervisor";
import type {
  LaunchedShiftChild,
  ShiftLaunchSpec,
} from "../hearth/shift-launcher";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { runOptions } from "../scheduler/shift-cli-runtime";
import { canonicalSessionInput } from "../sessions/preparation";
import { createProjectShiftRegistry, projectShiftFlags } from "./registry";

export interface OwnedProjectShiftChild extends LaunchedShiftChild {
  enginePid: Promise<number>;
}

/** The command and ownership barrier belong to the host, never a public Start or private saved path. */
export function createOwnedProjectShiftLauncher(options: {
  root: string;
  home: string;
  command: readonly string[];
  bootstrapCommand?: readonly string[];
  /** Trusted failure fixture only. */
  ownership?: Pick<
    InteractiveSuperviseOptions,
    "interactiveGuard" | "beforeStart"
  >;
}) {
  const root = realpathSync.native(options.root),
    workspace = resolveCheckout(root).workspace,
    command = [...options.command],
    originals = createProjectShiftRegistry(options);
  return (
    input: ShiftLaunchSpec,
    original: ProjectShiftIntent,
  ): OwnedProjectShiftChild => {
    const intent = structuredClone(original),
      spec = structuredClone(input),
      bounds = runOptions(projectShiftFlags(intent.request));
    if (!bounds.ok || bounds.value.forMs === undefined)
      throw Error("The original shift lifetime is unavailable.");
    const verify = () => {
      const saved = originals.read(intent.projectId, intent.request.requestId);
      if (
        !saved.attemptedAt ||
        saved.startupStop ||
        saved.executionStartedAt ||
        canonicalSessionInput(saved) !== canonicalSessionInput(intent) ||
        workspaceKey(saved.workspace) !== workspaceKey(workspace) ||
        workspaceKey(realpathSync.native(spec.cwd)) !== workspaceKey(root) ||
        spec.env["AGENT_FORGE_HOME"] !== options.home ||
        JSON.stringify(spec.argv) !==
          JSON.stringify([
            ...command,
            intent.projectId,
            intent.request.requestId,
          ])
      )
        throw Error(
          "The immutable original shift launch could not be verified.",
        );
    };
    verify();
    let stdout = "";
    const owned = supervise({
      command: spec.argv,
      cwd: root,
      env: spec.env,
      stdinMode: "interactive",
      lifetime: "shift-engine",
      timeoutMs: bounds.value.forMs + SHIFT_ENGINE_GRACE_MS,
      maxStdinBytes: 1,
      maxLineBytes: 1_048_576,
      ...(options.bootstrapCommand
        ? { bootstrapCommand: options.bootstrapCommand }
        : {}),
      ...(options.ownership?.interactiveGuard
        ? { interactiveGuard: options.ownership.interactiveGuard }
        : {}),
      beforeStart: async () => {
        await options.ownership?.beforeStart?.();
        verify();
      },
      onLine: (line) => {
        stdout = `${stdout}${line}\n`.slice(-16_000);
      },
    });
    // No engine stdin payload exists. Identity is separate from the owned wrapper, then EOF follows.
    void owned.providerPid
      .then(() => owned.end())
      .catch(() => {
        // The primary done promise retains an unknown cleanup refusal.
        void owned.stop("The original shift child could not be verified.");
      });
    return {
      pid: owned.pid,
      enginePid: owned.providerPid,
      done: owned.done.then((exit) => ({
        exitCode: exit.stopped || exit.timedOut ? null : exit.exitCode,
        stdout,
        stderr: exit.stderr,
      })),
      stop: () => owned.stop("The project shift host is closing."),
    };
  };
}
