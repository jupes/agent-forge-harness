/** Production hearth with an explicit native Codex fixture and inert sync seam. */
import { join } from "node:path";
import { operatorCouncilLedger } from "../../scripts/council/ledger-wiring";
import { supervise } from "../../scripts/executors/supervisor";
import { closeOnSignal, createHearth } from "../../scripts/hearth/server";
import { isMain } from "../../scripts/is-main";
import { createProviderLoginService } from "../../scripts/providers/login";
import { createCodexTaskRuntime } from "../../scripts/sessions/codex-task-runtime";

async function main() {
  const home = process.env["AGENT_FORGE_HOME"];
  if (!home)
    throw Error("The desktop fixture requires an isolated hearth home.");
  const args = process.argv.slice(2),
    index = args.indexOf("--root");
  const root = index >= 0 ? args[index + 1] : process.cwd();
  if (!root)
    throw Error("The desktop fixture requires its explicit repository.");
  const command = join(
    home,
    "bd-stand-in",
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  let token: string | null = null;
  const hearth = await createHearth({
    root,
    home,
    councilLedger: operatorCouncilLedger(),
    port: Number(process.env["HEARTH_PORT"] ?? 0),
    api: {
      providerLogin: createProviderLoginService({
        root,
        home,
        prepare: async (provider) => ({
          command: [
            join(
              home,
              "bd-stand-in",
              "bin",
              process.platform === "win32"
                ? "provider-login.exe"
                : "provider-login",
            ),
            provider,
          ],
          cwd: root,
          env: { PROVIDER_LOGIN_FIXTURE_HOME: home },
          timeoutMs: 60000,
          visible: false,
        }),
        ...(process.platform === "win32"
          ? {}
          : {
              launch: (spec) => {
                const child = supervise({
                  ...spec,
                  command: [...spec.command],
                  env: { ...spec.env },
                  stdin: "",
                  maxLineBytes: 1024,
                  onLine: () => {},
                });
                const done = child.done.then((result) => ({
                  exitCode: result.exitCode ?? 1,
                  stopped: result.stopped,
                  timedOut: result.timedOut,
                }));
                return {
                  pid: child.pid,
                  done,
                  stop: async () => {
                    await child.stop("Close inert login fixture");
                    return done;
                  },
                };
              },
            }),
      }),
      codexTaskRuntime: createCodexTaskRuntime({
        root,
        home,
        configHome: home,
        command: [command],
        syncCommand: [command, "--sync"],
        operatorToken: () => token,
        timeoutMs: 60_000,
      }),
    },
  });
  console.log(
    `hearth ${hearth.kind === "started" ? "listening" : "already running"} on ${hearth.url}`,
  );
  if (hearth.kind === "started") {
    token = hearth.token;
    closeOnSignal(hearth);
  }
}
if (isMain(import.meta))
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
