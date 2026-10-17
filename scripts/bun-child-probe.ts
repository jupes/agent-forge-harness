/** Bounded, opt-in probe: bun run scripts/bun-child-probe.ts <bun> [count] [parallel] [seed] */
import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, release } from "node:os";
import { join, resolve } from "node:path";
import { isMain } from "./is-main";
import { scratchDirs } from "./test-scratch";

export interface Witness {
  code: number;
  stdout: string;
  stderr: string;
  marker: string | null;
  timedOut: boolean;
}

export function classify(witness: Witness, token: string): string {
  if (witness.timedOut) return "timeout";
  if (witness.code !== 0) return "nonzero";
  if (witness.marker === null && witness.stdout === "" && witness.stderr === "")
    return "exit-zero-without-witness";
  if (
    witness.marker === token &&
    witness.stdout === `${token}\n` &&
    witness.stderr === `${token}\n`
  )
    return "complete";
  return "witness-mismatch";
}

// The same payload is used verbatim for eval and file mode; synchronous writes
// provide a witness independent of stdout/stderr pipe delivery.
export const PAYLOAD = `import { writeFileSync } from "node:fs";
const token = process.env.PROBE_TOKEN;
writeFileSync(process.env.PROBE_MARKER, token);
writeFileSync(1, token + "\\n");
writeFileSync(2, token + "\\n");`;

export async function probeChild(
  executable: string,
  mode: "eval" | "file",
  file: string,
  directory: string,
  token: string,
  timeoutMs = 10_000,
): Promise<Witness> {
  const marker = join(directory, `${token}.marker`);
  const child = Bun.spawn(
    [executable, ...(mode === "eval" ? ["-e", PAYLOAD] : ["run", file])],
    {
      cwd: directory,
      env: { ...process.env, PROBE_TOKEN: token, PROBE_MARKER: marker },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const results = await Promise.allSettled([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const [exit, output, diagnostic] = results;
    if (exit.status === "rejected") throw exit.reason;
    if (output.status === "rejected") throw output.reason;
    if (diagnostic.status === "rejected") throw diagnostic.reason;
    let content: string | null = null;
    try {
      content = readFileSync(marker, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      code: exit.value,
      stdout: output.value,
      stderr: diagnostic.value,
      marker: content,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const [executableArg, countArg = "300", parallelArg = "1", seed = "ieqd"] =
    process.argv.slice(2);
  const count = Number(countArg);
  const parallel = Number(parallelArg);
  if (
    !executableArg ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 10_000 ||
    !Number.isInteger(parallel) ||
    parallel < 1 ||
    parallel > 16 ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(seed)
  )
    throw new Error(
      "Expected <bun path> [count 1..10000] [parallel 1..16] [safe seed]",
    );
  const executable = resolve(executableArg);
  const scratch = scratchDirs();
  const directory = scratch.make("forge-bun-child-probe-");
  const file = join(directory, "payload.ts");
  writeFileSync(file, PAYLOAD);
  const matrices = [];
  try {
    for (const mode of ["eval", "file"] as const) {
      let next = 0;
      const counts: Record<string, number> = {};
      const failures: unknown[] = [];
      const started = Date.now();
      await Promise.all(
        Array.from({ length: parallel }, async () => {
          while (next < count && Date.now() - started < 180_000) {
            const index = next++;
            const token = `${seed}-${mode}-${index}`;
            try {
              const witness = await probeChild(
                executable,
                mode,
                file,
                directory,
                token,
              );
              const outcome = classify(witness, token);
              counts[outcome] = (counts[outcome] ?? 0) + 1;
              if (outcome !== "complete")
                failures.push({ index, token, outcome, ...witness });
            } catch (error) {
              counts["probe-error"] = (counts["probe-error"] ?? 0) + 1;
              failures.push({ index, token, error: String(error) });
            }
          }
        }),
      );
      matrices.push({
        mode,
        count,
        attempted: next,
        parallel,
        counts,
        failures,
        elapsedMs: Date.now() - started,
      });
    }
  } finally {
    scratch.cleanup();
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        data: {
          executable,
          parentBun: Bun.version,
          platform: process.platform,
          arch: arch(),
          release: release(),
          cpus: cpus().length,
          seed,
          timeoutMs: 10_000,
          matrixBudgetMs: 180_000,
          payload: PAYLOAD,
          matrices,
        },
        error: null,
      },
      null,
      2,
    ),
  );
}

if (isMain(import.meta)) {
  main().catch((error: unknown) => {
    console.log(
      JSON.stringify({ ok: false, data: null, error: String(error) }),
    );
    process.exitCode = 1;
  });
}
