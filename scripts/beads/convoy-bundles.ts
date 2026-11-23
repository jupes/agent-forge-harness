#!/usr/bin/env bun
/** Source CLI wrapper; packaged/runtime imports use the implementation directly. */
import { isMain } from "../is-main";
import { type BundlesEnvelope, runBundles } from "./convoy-bundles-core";
import { runBdOnPath } from "./live-tracker";

export * from "./convoy-bundles-core";

if (isMain(import.meta)) {
  const epicId = process.argv[2];
  const envelope: BundlesEnvelope = epicId
    ? await runBundles({ cwd: process.cwd(), runBd: runBdOnPath, epicId })
    : {
        ok: false,
        data: null,
        error: "usage: bun run beads:bundles <EPIC-ID>",
      };
  console.log(JSON.stringify(envelope, null, 2));
  if (!envelope.ok) process.exit(1);
}
