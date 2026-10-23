/** Production hearth with an explicit native Codex fixture and inert sync seam. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { operatorCouncilLedger } from "../../scripts/council/ledger-wiring";
import { supervise } from "../../scripts/executors/supervisor";
import { closeOnSignal, createHearth } from "../../scripts/hearth/server";
import { isMain } from "../../scripts/is-main";
import { createProviderLoginService } from "../../scripts/providers/login";
import { createClaudeSessionTransport } from "../../scripts/sessions/claude-transport";
import { createCodexChatRuntime } from "../../scripts/sessions/codex-chat-runtime";
import { createCodexTaskRuntime } from "../../scripts/sessions/codex-task-runtime";
import { createGeminiTaskRuntime } from "../../scripts/sessions/gemini-task-runtime";

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
  const claudeOptions = {
    root,
    home,
    configHome: home,
    command: [
      join(
        home,
        "bd-stand-in",
        "bin",
        process.platform === "win32" ? "claude.exe" : "claude",
      ),
    ],
    operatorToken: () => token,
  };
  const claude = createClaudeSessionTransport(claudeOptions);
  const timedClaude = createClaudeSessionTransport({
    ...claudeOptions,
    timeoutMs: 1500,
  });
  const chatOptions = {
    root,
    home,
    configHome: home,
    command: [
      join(
        home,
        "bd-stand-in",
        "bin",
        process.platform === "win32" ? "codex-chat.exe" : "codex-chat",
      ),
    ],
    syncCommand: [command, "--sync"],
    operatorToken: () => token,
    timeoutMs: 60_000,
  };
  const chat = createCodexChatRuntime({
      ...chatOptions,
      approvalTimeoutMs: 45_000,
    }),
    timedChat = createCodexChatRuntime({
      ...chatOptions,
      approvalTimeoutMs: 5000,
    }),
    deadlineChat = createCodexChatRuntime({
      ...chatOptions,
      timeoutMs: 5000,
      approvalTimeoutMs: 45_000,
    });
  const hearth = await createHearth({
    root,
    home,
    councilLedger: operatorCouncilLedger(),
    port: Number(process.env["HEARTH_PORT"] ?? 0),
    api: {
      geminiTaskRuntime: createGeminiTaskRuntime({
        root,
        home,
        configHome: join(home, "gemini-native-fixture"),
        command: [
          join(
            home,
            "bd-stand-in",
            "bin",
            process.platform === "win32" ? "gemini.exe" : "gemini",
          ),
        ],
        operatorToken: () => token,
        timeoutMs: 60_000,
      }),
      sessionRuntime: {
        provider: "claude",
        prepare: (input) => claude.prepare(input),
        run: (...args) => {
          let mode: unknown = null;
          try {
            mode = JSON.parse(
              readFileSync(join(home, "coding-fixture-mode.json"), "utf8"),
            );
          } catch {
            /* Only an explicit fixture mode selects the bounded timeout. */
          }
          return (mode === "rich-timeout" ? timedClaude : claude).run(...args);
        },
      },
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
      codexChatRuntime: {
        check: (input) => chat.check(input),
        prepare: (input) => chat.prepare(input),
        run: async (...args) => {
          let mode: unknown = null;
          try {
            mode = JSON.parse(
              readFileSync(join(home, "codex-chat-fixture-mode.json"), "utf8"),
            );
          } catch {
            /* Only the explicit inert mode selects a shorter approval deadline. */
          }
          const result = await (mode === "outcome-held"
            ? deadlineChat
            : mode === "approval-timeout"
              ? timedChat
              : chat
          ).run(...args);
          if (mode === "outcome-held") {
            // Hold only the fixture's final application metadata write after
            // the real native tree and private outcome have already settled.
            writeFileSync(
              join(home, "codex-chat-outcome-held.json"),
              JSON.stringify(result),
            );
            const until = Date.now() + 10_000;
            while (!existsSync(join(home, "codex-chat-outcome-release"))) {
              if (Date.now() >= until)
                throw Error(
                  "The bounded final metadata fixture was not released",
                );
              await Bun.sleep(10);
            }
          }
          return result;
        },
      },
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
