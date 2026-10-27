import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { operatorCouncilLedger } from "../../scripts/council/ledger-wiring";
import { hearthHome } from "../../scripts/hearth/home";
import {
  closeOnSignal,
  createHearth,
} from "../../scripts/hearth/server-runtime";
import { writeOwnerOnly } from "../../scripts/hearth/token";
import { createCodexChatRuntime } from "../../scripts/sessions/codex-chat-runtime";
import { observeCodexChatPersist } from "../../scripts/sessions/fixtures/codex-chat-persist-diagnostic";

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

async function run(): Promise<void> {
  const root = rootArgument(process.argv.slice(2));
  const home = hearthHome(process.env);
  const token = { current: null as string | null };
  const port = requestedPort(process.env["HEARTH_PORT"]);
  const defaultRuntime = createCodexChatRuntime({
    root,
    home,
    environment: process.env,
    operatorToken: () => token.current,
  });
  const codexChatRuntime: ReturnType<typeof createCodexChatRuntime> = {
    ...defaultRuntime,
    run(input, persist, signal, callbacks) {
      return defaultRuntime.run(
        input,
        observeCodexChatPersist({
          persist,
          recordFailure(fact) {
            const path = join(home, FACT_FILE);
            if (!existsSync(path)) writeOwnerOnly(path, JSON.stringify(fact));
          },
        }),
        signal,
        callbacks,
      );
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
  process.stdout.write(
    `hearth ${hearth.kind === "started" ? "listening" : "already running"} on ${hearth.url}\n`,
  );
  if (hearth.kind === "reused") return;
  token.current = hearth.token;
  closeOnSignal(hearth);
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
