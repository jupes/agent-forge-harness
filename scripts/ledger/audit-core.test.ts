import { expect, test } from "bun:test";
import { join } from "node:path";
import { importGraph } from "../import-graph";

test("packaged server and shift implementations do not import the audit command dispatcher", () => {
  const graph = importGraph(
    join(import.meta.dir, "../hearth/server.ts"),
    join(import.meta.dir, "../scheduler/shift-cli.ts"),
  );
  expect(
    graph.files.filter((file) => /\/audit-(cli|core)\.ts$/.test(file)),
  ).toEqual([join(import.meta.dir, "audit-core.ts").replaceAll("\\", "/")]);
});
