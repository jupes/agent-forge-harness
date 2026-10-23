import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createProviderReadinessRoutes } from "../hearth/routes/providers";
import { closeLedger } from "../ledger/db";
import { scratchDirs } from "../test-scratch";
import { createProviderInspector } from "./inspect";
import { createProviderLoginService } from "./login";
import type { NativeConsoleExit } from "./native-console";
import type { readOwnedClaudeUsage } from "./owned-usage";
import { providerReadinessPageSchema } from "./protocol";

const scratch = scratchDirs(),
  opened: { close(): Promise<void> }[] = [],
  ledgers: string[] = [];
afterEach(async () => {
  for (const service of opened.splice(0)) await service.close();
  for (const file of ledgers.splice(0)) closeLedger(file);
  scratch.cleanup();
});
function fixture(readUsage: typeof readOwnedClaudeUsage) {
  const root = scratch.make("provider-cache-"),
    home = join(root, "home"),
    ledgerPath = join(root, "ledger.db");
  ledgers.push(ledgerPath);
  const logins = createProviderLoginService({
    root,
    home,
    prepare: async () => ({
      command: ["C:\\fixture.exe"],
      cwd: root,
      env: {},
      timeoutMs: 5000,
    }),
    launch: () => {
      let finish: (value: NativeConsoleExit) => void = () => {};
      const done = new Promise<NativeConsoleExit>((resolve) => {
        finish = resolve;
      });
      return {
        pid: 0,
        done,
        stop: async () => {
          finish({ exitCode: 0, stopped: true, timedOut: false });
          return done;
        },
      };
    },
  });
  opened.push(logins);
  const inspector = createProviderInspector({
    root,
    home,
    environment: {},
    which: () => null,
  });
  const routes = createProviderReadinessRoutes(
    {
      root,
      workspace: root,
      projectHome: home,
      providerLogin: logins,
      ledgerPath,
      configHome: root,
      runBd: async () => ({
        status: 1,
        stdout: "",
        stderr: "fixture has no tracker",
      }),
    },
    inspector,
    async () => {
      throw Error("No fixture projects");
    },
    readUsage,
  );
  const read = async () => {
    const reply = await routes.read.read(undefined);
    expect(reply.status).toBe(200);
    if (!("data" in reply)) throw Error("Expected a verified fixture report");
    return providerReadinessPageSchema
      .parse(reply.data)
      .providers.find((row) => row.provider === "claude")?.usage;
  };
  return { logins, read };
}
const report = () => ({
  id: "native",
  label: "Reported native window",
  kind: "subscription-window" as const,
  unit: "percent" as const,
  basis: "used" as const,
  value: 75,
  total: 100,
  observedAt: new Date().toISOString(),
  resetAt: null,
  durationMs: null,
  source: "provider-cli" as const,
  reason: null,
});
test("an immediate cached read after sign-in cannot return the previous account allowance", async () => {
  const f = fixture(async ({ after }) => ({
    reports: after ? [] : [report()],
    reason: "Native fixture report",
  }));
  expect((await f.read())?.[0]?.used).toBe(75);
  await f.logins.start("claude", "9886feb7-0172-4a08-a306-d5b8b98cc36d");
  expect(await f.read()).toEqual([]);
});
test("a sign-in marker that advances during the account scan prevents that old scan from being published", async () => {
  let entered = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  const f = fixture(async ({ after }) => {
    if (!after) {
      entered();
      await held;
    }
    return {
      reports: after ? [] : [report()],
      reason: "Native fixture report",
    };
  });
  const pending = f.read();
  await started;
  await f.logins.start("claude", "9886feb7-0172-4a08-a306-d5b8b98cc36d");
  release();
  expect(await pending).toEqual([]);
  expect(await f.read()).toEqual([]);
});
