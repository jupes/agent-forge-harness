import { spawnSync } from "node:child_process";
import { bunPath, HEARTH_HOME } from "../e2e/servers";
import { workspace } from "./project-fixtures";

/** Fixture housekeeping only: fixed run-home SQLite, exact generated IDs, no provider or tracker. */
function membershipFixture(
  mode: "count" | "clear",
  projectId = "",
  before = 0,
): number {
  const result = spawnSync(
    bunPath(),
    [
      "-e",
      `
    import { comparableCheckout } from "./scripts/forge/runs";
    import { openLedger } from "./scripts/ledger/db";
    import { resolveCheckout } from "./scripts/ledger/workspace";
    import { isRunHome } from "./tests/e2e/servers";
    if (!isRunHome(process.env.AGENT_FORGE_HOME ?? "")) throw Error("Expected this browser run's temporary home");
    const mode=process.argv[1], workspace=comparableCheckout(process.argv[2]);
    if(workspace!==comparableCheckout(resolveCheckout(process.cwd()).workspace)) throw Error("Foreign fixture workspace");
    const db=openLedger();
    const count=()=>db.query("SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE workspace=?").get(workspace).n;
    if(mode==="clear") {
      const projectId=process.argv[3], before=Number(process.argv[4]);
      if(!/^project-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(projectId)||!Number.isSafeInteger(before)||before<0) throw Error("Invalid fixture identity");
      const ids=JSON.stringify(Array.from({length:1001},(_,i)=>"bounded-"+projectId+"-"+i));
      db.transaction(()=>{
        const rows=db.query("SELECT kind,bead_id FROM events WHERE workspace=? AND session_id IN (SELECT value FROM json_each(?))").all(workspace,ids);
        if((rows.length!==0&&rows.length!==1001)||rows.some(row=>row.kind!=="session.started"||row.bead_id!=="activity-empty-epic")) throw Error("Refused unexpected fixture rows");
        const removed=db.query("DELETE FROM events WHERE workspace=? AND kind='session.started' AND bead_id='activity-empty-epic' AND session_id IN (SELECT value FROM json_each(?))").run(workspace,ids);
        if(removed.changes!==rows.length||count()!==before) throw Error("Fixture cleanup did not restore the prior session count");
      })();
    } else if(mode!=="count") throw Error("Unknown fixture action");
    console.log(JSON.stringify({ok:true,data:{count:count()},error:null}));
  `,
      mode,
      workspace,
      projectId,
      String(before),
    ],
    {
      env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (result.status !== 0)
    throw Error(
      `Activity fixture failed: ${result.error?.message ?? result.stderr}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw Error("Activity fixture returned invalid JSON");
  }
  const record = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  if (
    !record(value) ||
    value.ok !== true ||
    !record(value.data) ||
    !Number.isSafeInteger(value.data.count) ||
    typeof value.data.count !== "number" ||
    value.data.count < 0
  )
    throw Error("Activity fixture returned an invalid count");
  return value.data.count;
}

export const activityFixtureSessionCount = () => membershipFixture("count");
export function clearActivityMembershipFixtures(
  projectId: string,
  before: number,
): void {
  membershipFixture("clear", projectId, before);
}
