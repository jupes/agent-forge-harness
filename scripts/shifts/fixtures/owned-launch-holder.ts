/** Hermetic ownership oracle only: a nested inert provider tree, never a tracker, Git or model. */
import { join } from "node:path";
import { buildChildEnv } from "../../executors/env";
import { supervise } from "../../executors/supervisor";
import { createOwnedProjectShiftLauncher } from "../owned-launcher";
import { createProjectShiftRegistry } from "../registry";

if (process.argv[2] === "engine") {
  const nested = supervise({
    command: [
      process.execPath,
      join(import.meta.dir, "../../executors/fixtures/interactive-cli.ts"),
      "startup-tree",
    ],
    cwd: import.meta.dir,
    env: {
      ...buildChildEnv(process.env, []),
      INTERACTIVE_TREE_LOG: process.env.INTERACTIVE_TREE_LOG ?? "",
    },
    stdinMode: "interactive",
    timeoutMs: 30_000,
    onLine: () => {},
  });
  await nested.providerPid;
  await new Promise(() => setInterval(() => {}, 1000));
} else {
  const [root, home, projectId, requestId, log] = process.argv.slice(2);
  if (!root || !home || !projectId || !requestId || !log)
    throw Error("Incomplete owned launcher fixture");
  const intent = createProjectShiftRegistry({ root, home }).read(
      projectId,
      requestId,
    ),
    command = [process.execPath, import.meta.filename, "engine"],
    launch = createOwnedProjectShiftLauncher({ root, home, command });
  const child = launch(
    {
      argv: [...command, projectId, requestId],
      cwd: root,
      env: {
        ...buildChildEnv(process.env, []),
        AGENT_FORGE_HOME: home,
        INTERACTIVE_TREE_LOG: log,
      },
    },
    intent,
  );
  const enginePid = await child.enginePid;
  console.log(
    JSON.stringify({
      holderPid: process.pid,
      wrapperPid: child.pid,
      enginePid,
    }),
  );
  await child.done;
}
