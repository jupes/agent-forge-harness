import { describe, expect, test } from "bun:test";
import { BUILTIN_SMITHS } from "../config/defaults";
import { ledgerHome } from "../ledger/paths";
import { adapterEnv, buildChildEnv, childEnv } from "./env";
import type { SpawnRequest } from "./types";

describe("buildChildEnv", () => {
  test("passes the base set and configured names, drops everything else", () => {
    const child = buildChildEnv(
      {
        PATH: "/bin",
        SystemRoot: "C:\\Windows",
        ANTHROPIC_API_KEY: "k",
        DATABASE_URL: "postgres://x",
        AWS_SECRET_ACCESS_KEY: "s",
      },
      ["ANTHROPIC_API_KEY"],
    );
    expect(Object.keys(child).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "PATH",
      "SystemRoot",
    ]);
  });

  test("matches names case-insensitively and keeps the parent's casing", () => {
    const child = buildChildEnv({ Path: "C:\\bin", Anthropic_Api_Key: "k" }, [
      "ANTHROPIC_API_KEY",
    ]);
    expect(child).toEqual({ Path: "C:\\bin", Anthropic_Api_Key: "k" });
  });

  test("a moved Agent Forge home reaches the child, so its hooks do not fall back to the OS home", () => {
    const child = buildChildEnv(
      {
        PATH: "/bin",
        USERPROFILE: "C:\Users\someone",
        AGENT_FORGE_HOME: "C:\sandbox\forge home",
        AGENT_FORGE_BEAD_ID: "bead-1",
      },
      [],
    );
    expect(child).toEqual({
      PATH: "/bin",
      USERPROFILE: "C:\Users\someone",
      AGENT_FORGE_HOME: "C:\sandbox\forge home",
    });
    // The ledger resolves the child's home from that, not from USERPROFILE.
    expect(ledgerHome(child)).toBe("C:\sandbox\forge home");
    expect(ledgerHome(buildChildEnv({ PATH: "/bin" }, []))).toBe(
      ledgerHome({}),
    );
  });

  test("skips undefined values", () => {
    expect(buildChildEnv({ PATH: undefined, HOME: "h" }, [])).toEqual({
      HOME: "h",
    });
  });
});

const smith = BUILTIN_SMITHS["codex-journeyman"] as SpawnRequest["smith"];

describe("adapterEnv", () => {
  test("marks the child as an adapter child and names its bead and smith", () => {
    expect(adapterEnv({ beadId: "bead-1", smith })).toEqual({
      AGENT_FORGE_ADAPTER: "1",
      AGENT_FORGE_BEAD_ID: "bead-1",
      AGENT_FORGE_SMITH: "codex-journeyman",
    });
  });

  test("adds the run and the parent session only when the request names them", () => {
    expect(
      adapterEnv({
        beadId: "bead-1",
        smith,
        runId: "run-1",
        parentSessionId: "parent-1",
      }),
    ).toEqual({
      AGENT_FORGE_ADAPTER: "1",
      AGENT_FORGE_BEAD_ID: "bead-1",
      AGENT_FORGE_SMITH: "codex-journeyman",
      FORGE_SLUG: "run-1",
      AGENT_FORGE_PARENT_SESSION: "parent-1",
    });
  });
});

describe("childEnv", () => {
  test("keeps the request's environment and adds the adapter's variables", () => {
    expect(
      childEnv({ env: { PATH: "/bin", EXTRA: "x" }, beadId: "bead-1", smith }),
    ).toEqual({
      PATH: "/bin",
      EXTRA: "x",
      AGENT_FORGE_ADAPTER: "1",
      AGENT_FORGE_BEAD_ID: "bead-1",
      AGENT_FORGE_SMITH: "codex-journeyman",
    });
  });

  test("a value that arrived under one of the adapter's names, in any letter case, is dropped — also when the request sets no value for it", () => {
    expect(
      childEnv({
        env: {
          PATH: "/bin",
          agent_forge_adapter: "0",
          Agent_Forge_Bead_Id: "planted",
          FORGE_SLUG: "someone-elses-run",
          agent_forge_parent_session: "someone-elses-session",
        },
        beadId: "bead-1",
        smith,
      }),
    ).toEqual({
      PATH: "/bin",
      AGENT_FORGE_ADAPTER: "1",
      AGENT_FORGE_BEAD_ID: "bead-1",
      AGENT_FORGE_SMITH: "codex-journeyman",
    });
  });
});
