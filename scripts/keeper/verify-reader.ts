/** Run the real source/packaged reader against a hermetic hearth; no provider is started. */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildChildEnv } from "../executors/env";
import { startTestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { isMain } from "../is-main";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";

export async function verifyKeeperReader(command: readonly string[]) {
  const program = command[0];
  if (!program) throw new Error("A reader runtime command is required.");
  const h = await startTestHearth();
  const client = new Client({ name: "keeper-runtime-verifier", version: "0" });
  const transport = new StdioClientTransport({
    command: program,
    args: [
      ...command.slice(1),
      "--origin",
      h.hearth.url,
      "--project",
      FIXTURE_PROJECT_ID,
    ],
    env: buildChildEnv(process.env, []),
    stderr: "pipe",
    maxBufferSize: 128_000,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    writeOwnerOnly(
      projectCatalogPath(h.home),
      JSON.stringify(projectCatalogFixture(h.workspace)),
    );
    h.bd.answer = (args) =>
      args[0] === "export"
        ? {
            status: 0,
            stdout: [
              {
                id: "alpha-epic",
                title: "Packaged fixture",
                issue_type: "epic",
                status: "open",
                labels: ["project:alpha"],
              },
              {
                id: "foreign",
                title: "FOREIGN_BODY_SENTINEL",
                issue_type: "epic",
                status: "open",
                labels: ["project:beta"],
              },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n"),
            stderr: "",
          }
        : undefined;
    await Promise.race([
      (async () => {
        await client.connect(transport);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        if (JSON.stringify(names) !== '["read_project"]')
          throw new Error("The reader exposed a different tool profile.");
        const answer = await client.callTool({
          name: "read_project",
          arguments: { kind: "beads" },
        });
        const text = JSON.stringify(answer);
        if (
          answer.isError ||
          !text.includes("alpha-epic") ||
          text.includes("FOREIGN_BODY_SENTINEL") ||
          text.includes(h.hearth.token)
        )
          throw new Error("The reader did not preserve its project scope.");
        const denied = await client
          .callTool({
            name: "read_project",
            arguments: { kind: "beads", projectId: "foreign" },
          })
          .then(
            (value) => value.isError === true,
            () => true,
          );
        if (!denied || h.events(["operator.action"]).length)
          throw new Error(
            "The readonly reader accepted an action or scope change.",
          );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("The reader verification reached its deadline.")),
          15_000,
        );
      }),
    ]);
    await client.close();
    if (transport.pid !== null)
      throw new Error("The reader subprocess did not close.");
    return {
      oneReadonlyTool: true,
      projectScoped: true,
      scopeChangeRefused: true,
      noOperatorAction: true,
      childStopped: true,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close();
    await h.close();
  }
}

if (isMain(import.meta)) {
  verifyKeeperReader(process.argv.slice(2)).then(
    (data) => {
      process.stdout.write(
        JSON.stringify({ ok: true, data, error: null }) + "\n",
      );
    },
    () => {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          data: null,
          error: "Keeper reader runtime verification failed.",
        }) + "\n",
      );
      process.exitCode = 1;
    },
  );
}
