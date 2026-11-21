import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { scratchDirs } from "../test-scratch";
import { appendEvent } from "./append";
import { closeLedger, openLedger } from "./db";
import { activeReservations } from "./query";
import { readReservationInventory } from "./reservation-inventory";

const scratch = scratchDirs();
afterEach(() => {
  closeLedger();
  scratch.cleanup();
});
function fixture() {
  const base = realpathSync.native(scratch.make("reservation-inventory-"));
  const home = join(base, "home"),
    path = join(home, "ledger.db"),
    workspace = join(base, "repo");
  ensurePrivateHome(home);
  mkdirSync(workspace);
  const claim = (
    kind: "reservation.acquired" | "reservation.released",
    beadId: string,
    worktree: string,
  ) => {
    const saved = appendEvent(
      { kind, workspace, beadId, payload: { worktree, globs: ["src/**"] } },
      { path },
    );
    if (!saved.ok) throw Error(saved.error);
  };
  return { home, path, workspace, claim };
}
test("reservation lookup uses the ledger producer's workspace spelling even with outer whitespace", () => {
  const f = fixture(),
    workspace = `${f.workspace} `;
  const saved = appendEvent(
    {
      kind: "reservation.acquired",
      workspace,
      beadId: "forge-test.1",
      payload: { worktree: "trees/held", globs: [] },
    },
    { path: f.path },
  );
  expect(saved.ok).toBe(true);
  const result = readReservationInventory({ ...f, workspace });
  expect(result.state).toBe("complete");
  expect(result.reservations).toHaveLength(1);
});
test("readonly reservation inventory folds the complete live WAL snapshot without normal-ledger writes", () => {
  const f = fixture();
  f.claim("reservation.acquired", "forge-test.1", "trees/old");
  f.claim("reservation.released", "forge-test.1", "trees/old");
  f.claim("reservation.acquired", "forge-test.2", "trees/held");
  expect(readReservationInventory(f)).toEqual({
    state: "complete",
    reservations: activeReservations(
      { workspace: f.workspace },
      { path: f.path },
    ),
  });
  const db = openLedger(f.path);
  const count = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
    .get()!.count;
  readReservationInventory(f);
  expect(
    db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
      .get()!.count,
  ).toBe(count);
});
test("missing or malformed reservation evidence is unknown", () => {
  const f = fixture();
  expect(readReservationInventory(f).state).toBe("unknown");
  f.claim("reservation.acquired", "forge-test.1", "trees/held");
  const db = openLedger(f.path);
  db.exec("UPDATE events SET payload = '{invalid'");
  expect(readReservationInventory(f).state).toBe("unknown");
  db.exec("UPDATE events SET payload = '{}' ");
  expect(readReservationInventory(f).state).toBe("unknown");
});

test("missing WAL sidecars after normal writer close and unsupported schema remain unknown", () => {
  const f = fixture();
  f.claim("reservation.acquired", "forge-test.1", "trees/held");
  const db = openLedger(f.path);
  db.exec("PRAGMA user_version=999");
  expect(readReservationInventory(f).state).toBe("unknown");
  db.exec("PRAGMA user_version=1");
  expect(readReservationInventory(f).state).toBe("complete");
  closeLedger(f.path);
  expect(readReservationInventory(f).state).toBe("unknown");
});

test("oversized payloads, absent bead ownership and row-cap overflow never become an empty inventory", () => {
  const f = fixture();
  f.claim("reservation.acquired", "forge-test.1", "trees/held");
  const db = openLedger(f.path),
    valid = JSON.stringify({ worktree: "trees/held", globs: ["src/**"] });
  db.query("UPDATE events SET payload=?").run(
    JSON.stringify({ worktree: "trees/held", globs: ["x".repeat(16384)] }),
  );
  expect(readReservationInventory(f).state).toBe("unknown");
  db.query("UPDATE events SET payload=?,bead_id=NULL").run(valid);
  expect(readReservationInventory(f).state).toBe("unknown");
  db.exec("UPDATE events SET bead_id='forge-test.1'");
  const workspace = f.workspace.replaceAll("\\", "/");
  const normalized =
    process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const insert = db.query(
    "INSERT INTO events(ulid,ts,kind,workspace,bead_id,payload) VALUES(?,'2026-11-07T00:00:00.000Z','reservation.acquired',?,'forge-test.1',?)",
  );
  db.transaction(() => {
    for (let index = 0; index < 4096; index++)
      insert.run(`capacity-${index}`, normalized, valid);
  })();
  expect(readReservationInventory(f).state).toBe("unknown");
});

test("an unsettled rollback-journal transaction is refused without repair", () => {
  const f = fixture();
  f.claim("reservation.acquired", "forge-test.1", "trees/held");
  const db = openLedger(f.path);
  db.exec(
    "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; UPDATE events SET ts='2026-11-07T00:00:00.000Z'",
  );
  try {
    expect(readReservationInventory(f).state).toBe("unknown");
  } finally {
    db.exec("ROLLBACK");
  }
});
