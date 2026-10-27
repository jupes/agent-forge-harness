import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type DesktopHost,
  startDesktopHost,
} from "../../scripts/hearth/desktop-host";

const [root, home, assets] = process.argv.slice(2);
if (!root || !home || !assets)
  throw new Error("The Smith origin fixture requires its owned paths.");
const rootPath = root!;
const homePath = home!;
const assetsPath = assets!;

function send(value: unknown): void {
  process.stdout.write(
    `${JSON.stringify({ ok: true, data: value, error: null })}\n`,
  );
}

async function start(): Promise<DesktopHost> {
  return startDesktopHost({
    root: resolve(rootPath),
    home: resolve(homePath),
    assetsRoot: resolve(assetsPath),
    port: 0,
    hearthCommand: [process.execPath, resolve("scripts/hearth/server.ts")],
  });
}

let host: DesktopHost | null = await start();
send({ url: host.url, owner: host.owner });
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let command: unknown;
  try {
    command = JSON.parse(line);
  } catch {
    process.stderr.write("Invalid Smith origin fixture command.\n");
    process.exitCode = 1;
    break;
  }
  if (
    !command ||
    typeof command !== "object" ||
    !("action" in command) ||
    (command.action !== "close" &&
      command.action !== "start" &&
      command.action !== "quit")
  ) {
    process.stderr.write("Unsupported Smith origin fixture command.\n");
    process.exitCode = 1;
    break;
  }
  if (command.action === "close" || command.action === "quit") {
    await host?.close();
    host = null;
    send({ closed: true });
    if (command.action === "quit") break;
  } else {
    if (host !== null) {
      process.stderr.write("The prior Smith origin host is still open.\n");
      process.exitCode = 1;
      break;
    }
    host = await start();
    send({ url: host.url, owner: host.owner });
  }
}
await host?.close();
