import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { operatorCouncilLedger } from "../../scripts/council/ledger-wiring";
import { hearthHome, tokenPath } from "../../scripts/hearth/home";
import {
  closeOnSignal,
  createHearth,
} from "../../scripts/hearth/server-runtime";
import { readToken, writeOwnerOnly } from "../../scripts/hearth/token";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import {
  createCodexChatRuntime,
  type CodexChatCallbacks,
} from "../../scripts/sessions/codex-chat-runtime";
import { observeCodexChatPersist } from "../../scripts/sessions/fixtures/codex-chat-persist-diagnostic";
import {
  claimCodexChatStartupDiagnosticHost,
  createCodexChatStartupDiagnostic,
  writeFirstCodexChatStartupFailure,
} from "../../scripts/sessions/fixtures/codex-chat-startup-diagnostic";
import {
  createCodexChatPrepareDiagnostics,
  createFilePrepareDiagnosticIo,
  initializePrepareDiagnosticFiles,
} from "../../scripts/sessions/fixtures/codex-chat-prepare-diagnostics";
import { isRunHome } from "../e2e/servers";
import { ROOT } from "./environment";

const FACT_FILE = "codex-chat-private-persist-failure.json";

function rootArgument(argv: readonly string[]): string {
  if (
    argv.length !== 2 ||
    argv[0] !== "--root" ||
    !argv[1] ||
    !/^(?:[A-Za-z]:[\\/]|\/)/.test(argv[1])
  )
    throw new Error("Invalid restart-fixture hearth arguments.");
  return resolve(argv[1]);
}

function requestedPort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d{1,5}$/.test(value))
    throw new Error("Invalid restart-fixture hearth port.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid restart-fixture hearth port.");
  return port;
}

function ownedFixtureHome(): string {
  const configured = process.env["AGENT_FORGE_HOME"],
    fixture = process.env["AGENT_FORGE_E2E_HOME"];
  if (
    !configured ||
    !fixture ||
    resolve(configured) !== resolve(fixture) ||
    !isRunHome(configured)
  )
    throw new Error("The restart fixture requires its isolated owned home.");
  return resolve(configured);
}

function ownedFixtureRoot(value: string): string {
  const fixture = resolveCheckout(ROOT),
    expectedRoot = fixture.workspace,
    expected = resolveCheckout(expectedRoot),
    actual = resolveCheckout(value);
  const comparable = (path: string) => {
    const normalized = resolve(path).replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (
    actual.workspace !== expected.workspace ||
    actual.worktree !== expected.worktree ||
    comparable(value) !== comparable(expectedRoot)
  )
    throw new Error("The restart fixture requires its owned checkout.");
  return expectedRoot;
}

async function run(): Promise<void> {
  const root = ownedFixtureRoot(rootArgument(process.argv.slice(2)));
  const home = ownedFixtureHome();
  if (hearthHome(process.env) !== home)
    throw new Error("The restart fixture home changed during startup.");
  const tokenFile = tokenPath(home, root);
  const token = { current: null as string | null };
  const port = requestedPort(process.env["HEARTH_PORT"]);
  const initialPrepareOrdinal = initializePrepareDiagnosticFiles(
    home,
    writeOwnerOnly,
  );
  const prepareDiagnostics = createCodexChatPrepareDiagnostics(
    createFilePrepareDiagnosticIo(home, writeOwnerOnly, initialPrepareOrdinal),
  );
  let initialHostClaimed = false,
    runtimeRunOrdinal = 0;
  const defaultRuntime = createCodexChatRuntime({
    root,
    home,
    environment: process.env,
    operatorToken: () => {
      const expected = token.current;
      return expected !== null && readToken(tokenFile) === expected
        ? expected
        : null;
    },
  });
  const codexChatRuntime: ReturnType<typeof createCodexChatRuntime> = {
    ...defaultRuntime,
    check(input) {
      return prepareDiagnostics.observe("check", () =>
        defaultRuntime.check(input),
      );
    },
    prepare(input) {
      return prepareDiagnostics.observe("prepare", () =>
        defaultRuntime.prepare(input),
      );
    },
    run(input, persist, signal, callbacks) {
      runtimeRunOrdinal++;
      const historicalPersist = observeCodexChatPersist({
        persist,
        recordFailure(fact) {
          const path = join(home, FACT_FILE);
          if (!existsSync(path)) writeOwnerOnly(path, JSON.stringify(fact));
        },
      });
      if (!initialHostClaimed || runtimeRunOrdinal !== 1)
        return defaultRuntime.run(input, historicalPersist, signal, callbacks);

      const diagnostic = createCodexChatStartupDiagnostic({
        recordFailure(fact) {
          writeFirstCodexChatStartupFailure({ home, fact, writeOwnerOnly });
        },
      });
      const observedCallbacks: CodexChatCallbacks = {
        ...callbacks,
        onStartupPhase(phase, signalAborted) {
          diagnostic.observeRuntimePhase(phase, signalAborted);
          callbacks.onStartupPhase?.(phase, signalAborted);
        },
      };
      const observedPersist = diagnostic.wrapPersist(historicalPersist);
      return (async () => {
        try {
          const outcome = await defaultRuntime.run(
            input,
            observedPersist,
            signal,
            observedCallbacks,
          );
          diagnostic.finish(outcome.phase);
          return outcome;
        } catch (error) {
          diagnostic.finish("threw");
          throw error;
        }
      })();
    },
  };

  const hearth = await createHearth({
    root,
    home,
    environment: process.env,
    ...(port === undefined ? {} : { port }),
    councilLedger: operatorCouncilLedger(),
    api: { codexChatRuntime },
  });
  if (hearth.kind === "reused") {
    process.stdout.write(`hearth already running on ${hearth.url}\n`);
    return;
  }
  initialHostClaimed = claimCodexChatStartupDiagnosticHost(home);
  process.stdout.write(`hearth listening on ${hearth.url}\n`);
  token.current = hearth.token;
  closeOnSignal(hearth);
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
