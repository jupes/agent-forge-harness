import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isMain } from "../is-main";
import { isProjectId } from "../projects/store";
import { createKeeperReader, keeperReaderOrigin } from "./reader";

export function parseKeeperReaderArgs(args: readonly string[]): {
  origin: string;
  projectId: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== "--origin" && name !== "--project") ||
      value === undefined ||
      values.has(name)
    )
      throw new Error("Invalid Keeper reader arguments.");
    values.set(name, value);
  }
  const origin = values.get("--origin");
  const projectId = values.get("--project");
  if (!origin || !isProjectId(projectId))
    throw new Error("A local hearth and project are required.");
  keeperReaderOrigin(origin);
  return { origin, projectId };
}

export function runKeeperReader(args: readonly string[]): void {
  try {
    const options = parseKeeperReaderArgs(args);
    const gone = new AbortController();
    process.stderr.on("error", () => {});
    const handle = serveStdio(
      () => createKeeperReader({ ...options, signal: gone.signal }),
      {
        onerror: () => {
          process.stderr.write("Keeper reader protocol error.\n");
        },
      },
    );
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      gone.abort();
      void handle.close().catch(() => {});
    };
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
  } catch {
    process.stderr.write(
      "Keeper reader requires a valid local hearth and project.\n",
    );
    process.exitCode = 1;
  }
}

if (isMain(import.meta)) runKeeperReader(process.argv.slice(2));
