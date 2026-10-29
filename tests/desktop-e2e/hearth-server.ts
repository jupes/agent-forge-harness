/** Production hearth with an explicit native Codex fixture and inert sync seam. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { operatorCouncilLedger } from "../../scripts/council/ledger-wiring";
import { supervise } from "../../scripts/executors/supervisor";
import { ensurePrivateHome } from "../../scripts/hearth/home-guard";
import { closeOnSignal, createHearth } from "../../scripts/hearth/server";
import { isMain } from "../../scripts/is-main";
import { createProviderLoginService } from "../../scripts/providers/login";
import { createClaudeSessionTransport } from "../../scripts/sessions/claude-transport";
import { createCodexChatRuntime } from "../../scripts/sessions/codex-chat-runtime";
import { createCodexTaskRuntime } from "../../scripts/sessions/codex-task-runtime";
import { observeCodexChatPersist } from "../../scripts/sessions/fixtures/codex-chat-persist-diagnostic";
import { createGeminiChatRuntime } from "../../scripts/sessions/gemini-chat-runtime";
import { createGeminiTaskRuntime } from "../../scripts/sessions/gemini-task-runtime";

async function main() {
  const home = process.env["AGENT_FORGE_HOME"];
  if (!home)
    throw Error("The desktop fixture requires an isolated hearth home.");
  ensurePrivateHome(home);
  const args = process.argv.slice(2),
    index = args.indexOf("--root");
  const root = index >= 0 ? args[index + 1] : process.cwd();
  if (!root)
    throw Error("The desktop fixture requires its explicit repository.");
  const repositoryFixtureGit = process.env["AGENT_FORGE_E2E_REPOSITORY_GIT"];
  if (!repositoryFixtureGit || !isAbsolute(repositoryFixtureGit))
    throw Error(
      "The desktop fixture requires its trusted isolated-repository Git executable.",
    );
  const projectRepositoryRegistryRoot = join(home, "project-create-registry");
  const projectRepositoryName = "onboarding-fixture";
  const projectRepositoryPath = join(
    projectRepositoryRegistryRoot,
    "repos",
    projectRepositoryName,
  );
  const onboardingFixtures = join(home, "repository-onboarding-fixtures");
  const selectedFolder = join(onboardingFixtures, "selected-folder");
  const emptyGitMarker = join(onboardingFixtures, "empty-git-marker");
  const cloneSource = join(onboardingFixtures, "clone-source.git");
  const pickerControl = join(onboardingFixtures, "picker-selection.json");
  const cloneCalls = join(onboardingFixtures, "clone-calls.jsonl");
  const isolatedGitConfig = join(onboardingFixtures, "gitconfig");
  mkdirSync(onboardingFixtures, { recursive: true });
  writeFileSync(isolatedGitConfig, "");
  const fixtureGitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: isolatedGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  const initializeRepository = (cwd: string, bare = false) => {
    mkdirSync(cwd, { recursive: true });
    const initialized = Bun.spawnSync(
      [repositoryFixtureGit, "init", ...(bare ? ["--bare"] : []), "--quiet"],
      {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
        env: fixtureGitEnv,
      },
    );
    if (initialized.exitCode !== 0)
      throw Error("Could not prepare a private onboarding Git fixture.");
  };
  initializeRepository(selectedFolder);
  initializeRepository(cloneSource, true);
  initializeRepository(projectRepositoryPath);
  mkdirSync(join(emptyGitMarker, ".git"), { recursive: true });
  mkdirSync(join(projectRepositoryRegistryRoot, "repos"), {
    recursive: true,
  });
  writeFileSync(
    join(projectRepositoryRegistryRoot, "repos", "repos.json"),
    JSON.stringify({
      repos: [
        {
          name: projectRepositoryName,
          url: "https://example.invalid/onboarding-fixture",
          defaultBranch: "main",
        },
      ],
    }),
  );
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
  const geminiChatOptions = {
    root,
    home,
    configHome: join(home, "gemini-native-fixture"),
    command: [
      join(
        home,
        "bd-stand-in",
        "bin",
        process.platform === "win32" ? "gemini-chat.exe" : "gemini-chat",
      ),
    ],
    operatorToken: () => token,
    timeoutMs: 60_000,
    permissionTimeoutMs: 45_000,
  };
  const geminiChat = createGeminiChatRuntime(geminiChatOptions),
    deadlineGeminiChat = createGeminiChatRuntime({
      ...geminiChatOptions,
      timeoutMs: 5000,
    });
  const hearth = await createHearth({
    root,
    home,
    projectRepositoryPickerCommand: ["fixed-fixture-picker"],
    councilLedger: operatorCouncilLedger(),
    port: Number(process.env["HEARTH_PORT"] ?? 0),
    api: {
      ...{ projectRepositoryRegistryRoot },
      allowLocalRepositoryFixtureUrls: true,
      projectRepositoryRunPicker: async () => {
        let selected: string | null = null;
        if (existsSync(pickerControl)) {
          const value: unknown = JSON.parse(
            readFileSync(pickerControl, "utf8"),
          );
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            !("path" in value)
          )
            throw Error("Invalid private repository-picker fixture");
          const path = value.path;
          if (path !== null && typeof path !== "string")
            throw Error("Invalid private repository-picker fixture");
          if (path !== null) {
            const canonical = realpathSync.native(path);
            const fromFixtureRoot = relative(
              realpathSync.native(onboardingFixtures),
              canonical,
            );
            if (
              fromFixtureRoot === ".." ||
              fromFixtureRoot.startsWith(`..${sep}`) ||
              isAbsolute(fromFixtureRoot)
            )
              throw Error("Private repository-picker fixture escaped its home");
            selected = canonical;
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { path: selected },
            error: null,
          }),
        };
      },
      projectRepositoryRunGit: async (commandArgs, cwd) => {
        const actual = [...commandArgs];
        if (actual[0] !== "git")
          throw Error("Unexpected repository onboarding executable");
        actual[0] = repositoryFixtureGit;
        if (actual.includes("clone")) {
          if (actual.at(-2) !== "https://fixture.invalid/repository.git")
            throw Error("Unexpected repository onboarding clone URL");
          actual[actual.length - 2] = cloneSource;
          appendFileSync(
            cloneCalls,
            `${JSON.stringify({ operation: "clone" })}\n`,
          );
        }
        const result = Bun.spawnSync(actual, {
          cwd,
          stdout: "pipe",
          stderr: "ignore",
          env: fixtureGitEnv,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8").trimEnd(),
        };
      },
      // Run inspection never reads this machine's hook log during the fixture suite.
      forgeGateLogRoot: join(home, "run-gate-logs"),
      geminiChatRuntime: {
        prepare: (input) => geminiChat.prepare(input),
        run: async (...args) => {
          let hold = false;
          const control = join(home, "gemini-chat-fixture-calls.json.control");
          if (existsSync(control)) {
            try {
              hold =
                JSON.parse(readFileSync(control, "utf8")).holdOutcome === true;
            } catch {
              throw Error("Invalid inert ACP control");
            }
          }
          const result = await (hold ? deadlineGeminiChat : geminiChat).run(
            ...args,
          );
          if (hold) {
            writeFileSync(
              join(home, "gemini-chat-outcome-held.json"),
              JSON.stringify(result),
            );
            const until = Date.now() + 10_000;
            while (!existsSync(join(home, "gemini-chat-outcome-release"))) {
              if (Date.now() >= until)
                throw Error(
                  "The bounded ACP final-metadata fixture was not released",
                );
              await Bun.sleep(10);
            }
          }
          return result;
        },
      },
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
        fork: (input) => chat.fork(input),
        run: async (...args) => {
          let mode: unknown = null;
          try {
            mode = JSON.parse(
              readFileSync(join(home, "codex-chat-fixture-mode.json"), "utf8"),
            );
          } catch {
            /* Only the explicit inert mode selects a shorter approval deadline. */
          }
          const selectedRuntime =
            mode === "outcome-held"
              ? deadlineChat
              : mode === "approval-timeout"
                ? timedChat
                : chat;
          const [input, persist, signal, callbacks] = args;
          const result = await selectedRuntime.run(
            input,
            observeCodexChatPersist({
              persist,
              recordFailure(fact) {
                try {
                  writeFileSync(
                    join(home, "codex-chat-persist-failure.json"),
                    JSON.stringify(fact),
                    { encoding: "utf8", flag: "wx" },
                  );
                } catch {
                  // A fixture artifact never replaces the original rejection.
                }
              },
            }),
            signal,
            callbacks,
          );
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
