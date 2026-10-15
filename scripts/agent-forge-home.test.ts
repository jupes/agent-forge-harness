import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join, relative, sep } from "path";
import { agentForgeHome } from "./agent-forge-home";
import { machineConfigFile } from "./config/load";
import { withProcessHomes } from "./config/testing";
import { hearthHome, lockPath, tokenPath } from "./hearth/home";
import { runtimeSpecifiers } from "./import-graph";
import { backupsDir, ledgerHome, ledgerPath } from "./ledger/paths";

const DEFAULT = join(homedir(), ".agent-forge");

describe("the Agent Forge home", () => {
  test("is AGENT_FORGE_HOME when that is set to more than whitespace, else ~/.agent-forge", () => {
    expect(agentForgeHome({})).toBe(DEFAULT);
    expect(agentForgeHome({ AGENT_FORGE_HOME: "" })).toBe(DEFAULT);
    expect(agentForgeHome({ AGENT_FORGE_HOME: "  " })).toBe(DEFAULT);
    expect(agentForgeHome({ AGENT_FORGE_HOME: "C:/some dir/forge home" })).toBe(
      "C:/some dir/forge home",
    );
    // The OS home, not `$HOME`: a shell that exports another HOME moves nothing.
    expect(agentForgeHome({ HOME: "/elsewhere" })).toBe(DEFAULT);
  });

  test("the ledger and the hearth resolve the same directory for the same environment", () => {
    for (const env of [
      {},
      { AGENT_FORGE_HOME: "" },
      { AGENT_FORGE_HOME: "  " },
      { AGENT_FORGE_HOME: "/x/home" },
      { AGENT_FORGE_HOME: "C:\\Users\\some one\\forge" },
    ]) {
      expect(hearthHome(env)).toBe(agentForgeHome(env));
      expect(ledgerHome(env)).toBe(agentForgeHome(env));
    }
  });

  test("the module is a leaf: what it loads at runtime, in any form the import scan reads, is os and path only", () => {
    const source = readFileSync(
      join(import.meta.dir, "agent-forge-home.ts"),
      "utf8",
    );
    expect(runtimeSpecifiers(source).sort()).toEqual(["os", "path"]);
  });

  test("what the ledger, the hearth and the machine config keep in that directory cannot share a name", () => {
    const home = join("some", "home");
    const top = (path: string): string =>
      relative(home, path).split(sep)[0] ?? "";
    const ledger = [
      top(ledgerPath({ AGENT_FORGE_HOME: home })),
      top(backupsDir({ AGENT_FORGE_HOME: home })),
      "hook-probe.jsonl",
    ];
    expect(ledger).toEqual(["ledger.db", "backups", "hook-probe.jsonl"]);
    // SQLite's own files sit beside the database under its name plus a suffix.
    const ledgerOwned = (name: string): boolean =>
      ledger.includes(name) || name.startsWith("ledger.db");

    const hearth = ["/a/b", "C:/work/tree", "/"].flatMap((root) => [
      top(lockPath(home, root)),
      top(tokenPath(home, root)),
    ]);
    for (const name of hearth) {
      expect(
        name === "tokens" || /^hearth-[0-9a-f]{12}\.lock$/.test(name),
      ).toBe(true);
      expect(ledgerOwned(name)).toBe(false);
    }

    const config = top(
      withProcessHomes(home, join("some", "os home"), () =>
        machineConfigFile({}),
      ),
    );
    expect(config).toBe("config.toml");
    expect(ledgerOwned(config) || hearth.includes(config)).toBe(false);
  });
});
