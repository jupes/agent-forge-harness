import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { backupsDir, ledgerHome, ledgerPath } from "./paths";

describe("ledger paths", () => {
  test("the ledger lives under the user's home unless AGENT_FORGE_HOME moves it", () => {
    const home = join(homedir(), ".agent-forge");
    expect(ledgerHome({})).toBe(home);
    expect(ledgerHome({ AGENT_FORGE_HOME: "  " })).toBe(home);
    expect(ledgerPath({})).toBe(join(home, "ledger.db"));
    expect(backupsDir({})).toBe(join(home, "backups"));

    const moved = { AGENT_FORGE_HOME: "C:/some dir/forge home" };
    expect(ledgerHome(moved)).toBe("C:/some dir/forge home");
    expect(ledgerPath(moved)).toBe(join("C:/some dir/forge home", "ledger.db"));
    expect(backupsDir(moved)).toBe(join("C:/some dir/forge home", "backups"));
  });

  test("the test process itself is pointed at a temp ledger home, not the user's", () => {
    const home = resolve(ledgerHome());
    expect(home).not.toBe(resolve(join(homedir(), ".agent-forge")));
    expect(home.startsWith(resolve(tmpdir()))).toBe(true);
  });
});
