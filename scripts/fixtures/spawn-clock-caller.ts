/** Keep each gap free of synchronous spawns from other tests' background work. */
import { spawnSync } from "node:child_process";
import { checkHomeInBun } from "../hearth/home-guard";
import { execFileNoShell } from "../quality-gate-beads";

const [kind, program, cwd] = process.argv.slice(2);
if ((kind !== "home" && kind !== "beads") || !program || !cwd)
  throw new Error("expected home|beads, a program and a working directory");
const gapMs = kind === "home" ? 12_000 : 4_000;
const real = process.execPath;
if (spawnSync(real, ["--version"]).status !== 0)
  throw new Error("the earlier synchronous spawn failed");
await Bun.sleep(gapMs);

if (kind === "home") {
  process.execPath = program;
  try {
    process.stdout.write(JSON.stringify(checkHomeInBun(cwd, undefined)));
  } finally {
    process.execPath = real;
  }
} else {
  process.stdout.write(
    JSON.stringify(execFileNoShell(real, [program], { cwd, timeoutMs: 8_000 })),
  );
}
