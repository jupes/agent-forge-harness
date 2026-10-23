import { expect, test } from "bun:test";
import { join } from "node:path";
import { importGraph } from "../import-graph";

test("the packaged hearth loads executor, shift and audit implementations without their command dispatchers", () => {
  const graph = importGraph(join(import.meta.dir, "compiled-entry.ts"));
  expect(
    graph.files.filter((file) =>
      /\/(?:executors\/exec-cli|scheduler\/shift-cli|ledger\/audit-cli)\.ts$/.test(
        file,
      ),
    ),
  ).toEqual([]);
});
