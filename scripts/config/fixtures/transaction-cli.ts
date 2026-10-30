/** Closed scratch-only CLI/transaction fixture. Never imported by production. */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scratchDirs } from "../../test-scratch";

async function main() {
  const [role, rawRoot, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !rawRoot ||
    !["moved-home", "hold", "write"].includes(role ?? "")
  )
    throw Error("Invalid closed fixture request");
  scratchDirs().track(rawRoot);
  const root = realpathSync.native(rawRoot);
  if (
    readFileSync(join(root, "fixture-marker"), "utf8") !==
    "config-transaction-fixture-v1\n"
  )
    throw Error("Missing fixture ownership marker");
  writeFileSync(join(root, `${role}-child-started`), "fixture-stage-v1\n");
  const controls = { coordinationRoot: join(root, "coordination") };
  if (role === "moved-home") {
    const [{ runConfigCli }, { machineConfigFile }] = await Promise.all([
      import("../cli"),
      import("../load"),
    ]);
    writeFileSync(join(root, `${role}-config-loaded`), "fixture-stage-v1\n");
    const forgeHome = join(root, "moved forge home");
    const osHome = join(root, "os home");
    if (realpathSync.native(homedir()) !== realpathSync.native(osHome))
      throw Error("Fixture OS home is not isolated");
    const options = { harnessRoot: join(root, "harness"), env: {} };
    const file = join(forgeHome, "config.toml");
    if (machineConfigFile({}) !== file)
      throw Error("Fixture moved profile is not isolated");
    const set = await runConfigCli(
      ["set", "workflow.default_crew", "claude-master", "--user", "--json"],
      options,
      controls,
    );
    const show = await runConfigCli(["show", "--json"], options, controls);
    return { set, show, file };
  }
  const options = {
    harnessRoot: join(
      root,
      role === "hold" ? "workspace alias" : "shared workspace",
    ),
    home: join(root, role === "hold" ? "profile-a" : "profile-b"),
    env: {},
  };
  if (role === "write") {
    const { runConfigCli } = await import("../cli");
    writeFileSync(join(root, `${role}-config-loaded`), "fixture-stage-v1\n");
    writeFileSync(join(root, "writer-entered"), String(process.pid));
    writeFileSync(join(root, "write-cli-started"), "fixture-stage-v1\n");
    const result = await runConfigCli(
      ["set", "shift.max_usd", "5", "--workspace", "--json"],
      options,
      controls,
    );
    writeFileSync(join(root, "writer-completed"), String(process.pid));
    return result;
  }
  const { prepareConfigTransaction, withConfigTransaction } = await import(
    "../transaction"
  );
  writeFileSync(join(root, `${role}-config-loaded`), "fixture-stage-v1\n");
  const context = prepareConfigTransaction({
    options,
    target: "workspace",
    ...controls,
  });
  writeFileSync(join(root, "hold-transaction-prepared"), "fixture-stage-v1\n");
  return await withConfigTransaction(context, async (transaction) => {
    writeFileSync(join(root, "hold-transaction-entered"), "fixture-stage-v1\n");
    writeFileSync(join(root, "holder-entered"), String(process.pid));
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(root, "release-holder"))) {
      if (Date.now() >= deadline)
        throw Error("Fixture holder deadline expired");
      await Bun.sleep(5);
    }
    return transaction.publish(Buffer.from("[shift]\nmax_beads = 7\n"));
  });
}

try {
  console.log(JSON.stringify({ ok: true, data: await main(), error: null }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
