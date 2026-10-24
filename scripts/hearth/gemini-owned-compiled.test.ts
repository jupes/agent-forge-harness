import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ConversationPage } from "../../types/conversation";
import { buildChildEnv } from "../executors/env";
import { createProjectStore } from "../projects/store";
import { ownedCodingPageSchema } from "../sessions/codex-owned-journal";
import { scratchDirs } from "../test-scratch";
import { lockPath } from "./home";
import { readLock } from "./lock";
import { OPERATOR_HEADER } from "./paths";

const scratch = scratchDirs(),
  repo = resolve(import.meta.dir, "../.."),
  extension = process.platform === "win32" ? ".exe" : "";
let bin: string, hearth: string;
beforeAll(() => {
  bin = scratch.make("gemini-owned-packaged-bin-");
  hearth = join(bin, `hearth${extension}`);
  for (const [entry, output] of [
    ["scripts/hearth/compiled-entry.ts", hearth],
    [
      "scripts/sessions/fixtures/gemini-task-runtime-compiled.ts",
      join(bin, `gemini${extension}`),
    ],
    ["tests/e2e/git-stand-in.ts", join(bin, `git${extension}`)],
  ]) {
    if (!entry || !output) throw Error("Missing closed packaged fixture entry");
    const result = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        join(repo, entry),
        "--outfile",
        output,
      ],
      {
        cwd: bin,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    if (result.exitCode !== 0)
      throw Error(
        `The isolated packaged Gemini oracle did not compile: ${result.stderr.toString().slice(-1000)}`,
      );
  }
}, 95_000);
afterAll(() => scratch.cleanup());

test("the production compiled hearth owns Gemini Task bootstrap, private history and real tree Stop without ambient Bun or source", async () => {
  for (const mode of ["normal", "hang-tree"]) {
    const root = realpathSync.native(
        scratch.make("gemini-owned-packaged-root-"),
      ),
      home = join(root, "private-home"),
      log = join(root, "native.jsonl");
    mkdirSync(join(root, ".git"));
    writeFileSync(
      join(root, "agent-forge.toml"),
      '[execution.env]\npass = ["GEMINI_RUNTIME_LOG"]\n[smiths.gemini-example]\nprovider = "gemini"\nmodel = "configured-example"\neffort = "default"\nenabled = true\n',
    );
    writeFileSync(`${log}.control`, JSON.stringify({ mode }));
    const catalog = await createProjectStore(home).create(
        {
          slug: "packaged",
          name: "Packaged fixture",
          description: "",
          icon: "P",
          workspaces: [
            { root, repositories: [root], epicIds: ["fixture-epic"] },
          ],
        },
        0,
      ),
      project = catalog.projects[0];
    if (!project) throw Error("The planted packaged project is absent");
    const env = {
      ...Object.fromEntries(
        Object.entries(buildChildEnv(process.env, [])).filter(
          ([key]) => key.toLowerCase() !== "path",
        ),
      ),
      PATH: bin,
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      XDG_CONFIG_HOME: root,
      AGENT_FORGE_HOME: home,
      GEMINI_RUNTIME_LOG: log,
      HEARTH_PORT: "",
    };
    const child = Bun.spawn([hearth, "--root", root], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    let url = "",
      headers: Record<string, string> = {},
      sessionId: string | null = null;
    const requestId = crypto.randomUUID();
    try {
      const deadline = Date.now() + 10_000;
      let lock = readLock(lockPath(home, root));
      while (!lock || !existsSync(lock.tokenFile)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw Error(
            "The isolated packaged hearth did not publish its own lock/token",
          );
        await Bun.sleep(20);
        lock = readLock(lockPath(home, root));
      }
      expect(lock.pid).toBe(child.pid);
      url = `http://127.0.0.1:${lock.port}/__agent-forge/projects/${project.id}/sessions`;
      headers = {
        Origin: `http://127.0.0.1:${lock.port}`,
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: readFileSync(lock.tokenFile, "utf8").trim(),
      };
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "gemini",
          requestId,
          smith: "gemini-example",
          repository: root,
          worktree: root,
          launch: {
            route: "gemini-cli",
            mode: "task",
            prompt: "PRIVATE-PACKAGED-GEMINI-REQUEST",
          },
        }),
      });
      const accepted = await response.json();
      expect(response.status, JSON.stringify(accepted)).toBe(202);
      sessionId = accepted.data.session.id;
      let page: ConversationPage;
      const read = async () => {
        const reply = await fetch(`${url}/${sessionId}`, { headers });
        expect(reply.status).toBe(200);
        return ownedCodingPageSchema.parse((await reply.json()).data);
      };
      const completionDeadline = Date.now() + 10_000;
      do {
        page = await read();
        if (
          mode === "hang-tree"
            ? page.frames.some(
                (frame) =>
                  frame.event.kind === "coding-gemini-task" &&
                  frame.event.event.kind === "text",
              )
            : page.turns[0]?.phase === "completed"
        )
          break;
        if (Date.now() > completionDeadline)
          throw Error(
            "The packaged Gemini Task did not reach its required native state",
          );
        await Bun.sleep(20);
      } while (Date.now() <= completionDeadline);
      expect(page.binding?.provider).toBe("gemini");
      const nativeProcess = page.frames.find(
        (frame) =>
          frame.event.kind === "coding-gemini-task" &&
          frame.event.event.kind === "process",
      )?.event;
      if (
        nativeProcess?.kind !== "coding-gemini-task" ||
        nativeProcess.event.kind !== "process"
      )
        throw Error("No persisted actual packaged provider PID");
      expect(nativeProcess.event.pid).not.toBe(
        nativeProcess.event.bootstrapPid,
      );
      if (mode === "hang-tree") {
        const stop = await fetch(`${url}/${sessionId}/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ requestId }),
        });
        expect(stop.status).toBe(200);
        const stopDeadline = Date.now() + 5000;
        while ((await read()).turns[0]?.phase !== "cancelled") {
          if (Date.now() > stopDeadline)
            throw Error("The packaged Stop did not settle");
          await Bun.sleep(20);
        }
        let records: Record<string, unknown>[];
        try {
          records = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        } catch {
          throw Error("The packaged native recording is invalid");
        }
        const task = records.find((record) => record.kind === "task");
        for (const pid of [task?.pid, task?.childPid]) {
          if (typeof pid !== "number")
            throw Error("Missing packaged inert tree PID");
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } else expect(page.turns[0]?.phase).toBe("completed");
      expect(existsSync(join(root, "scripts"))).toBe(false);
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      expect(existsSync(join(bin, `bd${extension}`))).toBe(false);
    } finally {
      if (sessionId && url)
        await fetch(`${url}/${sessionId}/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      child.kill();
      await child.exited;
    }
  }
}, 40_000);
