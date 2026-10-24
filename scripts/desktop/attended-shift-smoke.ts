import { copyFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { ProjectShiftObservation } from "../../types/project-shifts";
import { buildChildEnv } from "../executors/env";
import { type InteractiveSupervised, supervise } from "../executors/supervisor";
import { FIXTURE_PROJECT_ID } from "../projects/testing";

interface NativePageTools {
  availablePort(): Promise<number>;
  waitForTarget(
    port: number,
    child: Pick<Bun.Subprocess, "exitCode">,
  ): Promise<{ webSocketDebuggerUrl: string }>;
  openCdp(url: string): Promise<WebSocket>;
  enable(socket: WebSocket): Promise<void>;
  evaluate(socket: WebSocket, expression: string): Promise<unknown>;
  waitForPage(
    socket: WebSocket,
    expression: string,
    error: string,
  ): Promise<void>;
  screenshot(socket: WebSocket, name: string): Promise<string | undefined>;
}
const providerRecord = z.object({
  pid: z.number().int().positive(),
  childPid: z.number().int().positive().nullable(),
  stdin: z.string(),
  argv: z.array(z.string()),
});
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Source-only verification of the actual packaged app. All CLIs and checkout data belong to this OS-temp fixture. */
export async function verifyAttendedProjectShifts(
  stage: string,
  tools: NativePageTools,
): Promise<void> {
  // Reuse the exact browser fixture without changing the smoke runner's environment.
  const keys = [
    "PORT",
    "E2E_HEARTH_PORT",
    "AGENT_FORGE_E2E_HOME",
    "AGENT_FORGE_SHIFT_FIXTURE_ROOT",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const fixture = await import("../../tests/desktop-shift-e2e/environment");
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixture.prepareFixture(process.execPath);
  const { FIXTURE_ROOT, REPOSITORY, HOME, BIN, STATE, EMPTY_HOME } = fixture;
  const executable = join(FIXTURE_ROOT, "agent-forge-desktop.exe");
  copyFileSync(join(stage, "agent-forge-desktop.exe"), executable);
  copyFileSync(
    join(stage, "desktop-host.exe"),
    join(FIXTURE_ROOT, "desktop-host.exe"),
  );
  copyFileSync(join(stage, "hearth.exe"), join(FIXTURE_ROOT, "hearth.exe"));
  cpSync(join(stage, "dashboard"), join(FIXTURE_ROOT, "dashboard"), {
    recursive: true,
  });
  let owned: InteractiveSupervised | null = null,
    socket: WebSocket | null = null,
    csp = 0;
  let code: number | null = null;
  const stop = async () => {
    socket?.close();
    socket = null;
    if (owned) {
      await owned.stop("The isolated packaged shift probe is closing.");
      await owned.done;
      owned = null;
    }
  };
  const start = async () => {
    const port = await tools.availablePort();
    const systemRoot =
      process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "C:\\Windows";
    const env = {
      ...Object.fromEntries(
        Object.entries(buildChildEnv(process.env, [])).filter(
          ([key]) => key.toLowerCase() !== "path",
        ),
      ),
      PATH: [BIN, join(systemRoot, "System32"), systemRoot].join(delimiter),
      AGENT_FORGE_HOME: HOME,
      HOME: EMPTY_HOME,
      // WebView's debug listener requires the real Windows GUI profile.
      // Agent state, WebView data and all closed fake-provider data stay isolated.
      USERPROFILE: process.env.USERPROFILE ?? EMPTY_HOME,
      APPDATA: EMPTY_HOME,
      LOCALAPPDATA: EMPTY_HOME,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: join(FIXTURE_ROOT, "native-profile"),
    };
    const child = supervise({
      command: [executable, "--root", REPOSITORY],
      cwd: FIXTURE_ROOT,
      env,
      stdinMode: "interactive",
      maxStdinBytes: 1,
      timeoutMs: 180000,
      bootstrapCommand: [
        join(FIXTURE_ROOT, "hearth.exe"),
        "--interactive-bootstrap",
      ],
      onLine: () => {},
      maxLineBytes: 4096,
    });
    owned = child;
    code = null;
    void child.done.then((exit) => {
      code = exit.exitCode;
    });
    await child.providerPid;
    await child.end();
    let target: { webSocketDebuggerUrl: string };
    try {
      target = await tools.waitForTarget(port, {
        get exitCode() {
          return code;
        },
      });
    } catch {
      throw Error("The owned packaged shift page did not open.");
    }
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.hostname !== "127.0.0.1" || Number(url.port) !== port)
      throw Error(
        "The packaged attended probe received a foreign debug target.",
      );
    const connected = await tools.openCdp(target.webSocketDebuggerUrl);
    socket = connected;
    connected.addEventListener("message", (event) => {
      try {
        const packet: unknown = JSON.parse(String(event.data));
        if (
          typeof packet === "object" &&
          packet !== null &&
          "method" in packet &&
          packet.method === "Log.entryAdded" &&
          /Content Security Policy|violates.*directive/i.test(
            String(event.data),
          )
        )
          csp++;
      } catch {
        /* A malformed diagnostic grants no authority. */
      }
    });
    await tools.enable(connected);
    await tools.waitForPage(
      connected,
      "!!document.querySelector('.af-desktop-frame')",
      "The packaged attended renderer did not initialize.",
    );
    await tools.evaluate(
      connected,
      `location.hash='#/desktop/project/${FIXTURE_PROJECT_ID}/workbench'`,
    );
    try {
      await tools.waitForPage(
        connected,
        "!!document.querySelector('.af-project-shifts')",
        "The packaged Workbench did not expose its scoped shift panel.",
      );
    } catch {
      const state = await tools.evaluate(
        connected,
        "JSON.stringify({hash:location.hash,text:document.querySelector('main')?.textContent?.slice(0,1800)})",
      );
      throw Error(
        `The packaged Workbench did not expose its scoped shift panel: ${String(state)}`,
      );
    }
    return connected;
  };
  const click = async (
    current: WebSocket,
    label: string,
    selector = ".af-project-shifts",
  ) => {
    await tools.evaluate(
      current,
      `(()=>{const root=document.querySelector(${JSON.stringify(selector)});const button=Array.from(root?.querySelectorAll('button')??[]).find(node=>node.textContent?.trim()===${JSON.stringify(label)});if(!button||button.getAttribute('aria-disabled')==='true'||button.disabled)throw Error('The intended native shift action is unavailable');button.click();})()`,
    );
  };
  const review = async (current: WebSocket, smith: string) => {
    const previous = z
      .array(z.string())
      .parse(
        await tools.evaluate(
          current,
          "Array.from(document.querySelectorAll('.af-shift-row[data-shift]')).map(row=>row.getAttribute('data-shift'))",
        ),
      );
    await tools.waitForPage(
      current,
      "Array.from(document.querySelectorAll('.af-project-shifts button')).some(b=>b.textContent?.trim()==='Start shift'&&b.getAttribute('aria-disabled')!=='true')",
      "The packaged original shift remains held.",
    );
    await click(current, "Start shift");
    await tools.waitForPage(
      current,
      "!!document.querySelector('dialog[open] input[aria-label=Duration]')",
      "The packaged shift defaults were unavailable.",
    );
    for (const [label, value, select] of [
      ["Base branch", "main", false],
      ["Smith override", smith, true],
      ["Epic filter", "alpha-epic", true],
    ] as const)
      await tools.evaluate(
        current,
        `(()=>{const input=document.querySelector('dialog[open] [aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!input)throw Error('Missing reviewed native field');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true}));})()`,
      );
    await click(current, "Start reviewed shift", "dialog[open]");
    await tools.waitForPage(
      current,
      "!document.querySelector('dialog[open]')",
      "The packaged explicit shift Start did not settle its receipt.",
    );
    const fresh = `Array.from(document.querySelectorAll('.af-shift-row')).map(row=>row.getAttribute('data-shift')).find(id=>!${JSON.stringify(previous)}.includes(id))`;
    await tools.waitForPage(
      current,
      `!!(${fresh})`,
      "The packaged reviewed Start did not expose its original shift identity.",
    );
    return z
      .string()
      .regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/)
      .parse(await tools.evaluate(current, fresh));
  };
  const originalPhase = (
    shiftId: string,
    phase: ProjectShiftObservation["phase"],
  ) =>
    `Array.from(document.querySelectorAll('.af-shift-row')).find(row=>row.getAttribute('data-shift')===${JSON.stringify(shiftId)})?.getAttribute('data-phase')===${JSON.stringify(phase)}`;
  const gone = async (pid: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await delay(100);
    }
    throw Error(
      "A packaged fixture-owned provider or helper survived owned-tree cleanup.",
    );
  };
  try {
    let current = await start();
    const codexShiftId = await review(current, "codex-journeyman");
    await tools.waitForPage(
      current,
      originalPhase(codexShiftId, "stopped"),
      "The packaged attended Codex shift did not reach a verified terminal record.",
    );
    await tools.waitForPage(
      current,
      "document.querySelector('.af-project-shift-attempts')?.textContent?.includes('Verified saved turn: completed')&&document.querySelector('.af-project-shift-attempts')?.textContent?.includes('Reported activity')",
      "The packaged shift did not render its verified private provider activity.",
    );
    const packets = readFileSync(join(STATE, "codex.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          throw Error("Invalid native Codex fixture log.");
        }
      });
    const task = packets.find(
      (packet) =>
        typeof packet === "object" &&
        packet !== null &&
        "kind" in packet &&
        packet.kind === "task",
    );
    const codex = providerRecord.parse(task);
    if (!codex.argv.includes('approval_policy="never"'))
      throw Error(
        "The packaged attended Codex adapter did not preserve its explicit never-approval policy.",
      );
    if (
      !(await tools.evaluate(
        current,
        `document.querySelector('.af-shift-private-input')?.textContent===${JSON.stringify(codex.stdin)}`,
      ))
    )
      throw Error(
        "The packaged view did not retain the actual original private input.",
      );
    await tools.evaluate(
      current,
      "document.querySelector('.af-project-shift-attempts')?.scrollIntoView({block:'start'})",
    );
    if (!(await tools.screenshot(current, "native-attended-shift.png")))
      throw Error(
        "The packaged attended shift screenshot could not be retained.",
      );
    fixture.resetTracker();
    fixture.fixtureMode("hang-tree");
    const claudeShiftId = await review(current, "claude-journeyman");
    await tools.waitForPage(
      current,
      "document.querySelector('.af-project-shift-attempts')?.textContent?.includes('Coding reply')",
      "The packaged running shift did not expose its retained partial private text.",
    );
    const claude = providerRecord.parse(
      JSON.parse(readFileSync(join(STATE, "claude.json"), "utf8")),
    );
    if (!claude.childPid)
      throw Error("The native Stop/recovery proof has no owned helper.");
    // Abrupt owner termination is through the actual held job, never a persisted numeric PID.
    await stop();
    await gone(claude.pid);
    await gone(claude.childPid);
    current = await start();
    await tools.waitForPage(
      current,
      originalPhase(claudeShiftId, "needs-recovery"),
      "The packaged restarted host did not retain the original interrupted shift.",
    );
    await click(
      current,
      "Recover original shift",
      `.af-shift-row[data-shift="${claudeShiftId}"]`,
    );
    await tools.waitForPage(
      current,
      originalPhase(claudeShiftId, "stopped"),
      "Explicit packaged recovery did not settle the original owned work.",
    );
    const after = providerRecord.parse(
      JSON.parse(readFileSync(join(STATE, "claude.json"), "utf8")),
    );
    const afterPackets = readFileSync(join(STATE, "codex.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          throw Error("Invalid native Codex fixture log.");
        }
      });
    if (
      after.pid !== claude.pid ||
      afterPackets.filter(
        (packet) =>
          typeof packet === "object" &&
          packet !== null &&
          "kind" in packet &&
          packet.kind === "task",
      ).length !== 1 ||
      csp !== 0
    )
      throw Error(
        "Packaged recovery repeated a provider turn or violated the renderer content policy.",
      );
    await stop();
    writeFileSync(
      join(FIXTURE_ROOT, "native-attended-proof.json"),
      JSON.stringify({
        originalInputVerified: true,
        reportedActivityVisible: true,
        codexApprovalNever: true,
        interruptedOriginalRecovered: true,
        noProviderReplay: true,
        csp: 0,
        childrenStopped: true,
      }),
    );
  } finally {
    await stop();
    fixture.cleanupFixture();
  }
}
