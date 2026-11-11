import { expect, test } from "bun:test";
import {
  emitTransactionFixtureFailureFactsAndRethrow,
  observeTransactionFixtureConfigImport,
  summarizeTransactionFixtureFailure,
} from "./transaction-process-diagnostic.test-utils";

test("transaction fixture failure facts expose only bounded fixed categories", () => {
  const privateValues = [
    "C:\\private\\home\\workspace",
    "PRIVATE_CONFIG_BODY",
    "Bearer operator-secret",
  ];
  const facts = summarizeTransactionFixtureFailure({
    stage: "transaction-prepared",
    child: "exited-nonzero",
    stderr: "nonempty",
    ...({ path: privateValues[0], output: privateValues[1] } as object),
  });
  const text = JSON.stringify(facts);
  expect(facts).toEqual({
    stage: "transaction-prepared",
    child: "exited-nonzero",
    stderr: "nonempty",
  });
  for (const value of privateValues) expect(text).not.toContain(value);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(512);
  expect(
    summarizeTransactionFixtureFailure({
      stage: "config-loaded",
      child: "running",
      stderr: "unavailable",
    }),
  ).toEqual({
    stage: "config-loaded",
    child: "running",
    stderr: "unavailable",
  });
  expect(
    summarizeTransactionFixtureFailure({
      stage: privateValues[0] as never,
      child: privateValues[1] as never,
      stderr: privateValues[2] as never,
    }),
  ).toEqual({
    stage: "unavailable",
    child: "unavailable",
    stderr: "unavailable",
  });
});

test("failure facts are emitted before cleanup and preserve the original error through observer failures", async () => {
  const original = new Error("Fixture did not reach holder-entered"),
    order: string[] = [];
  let caught: unknown;
  try {
    await emitTransactionFixtureFailureFactsAndRethrow(
      original,
      async () => {
        order.push("collect");
        return {
          stage: "transaction-prepared",
          child: "running",
          stderr: "unavailable",
        };
      },
      (line) => {
        order.push("emit");
        expect(line).toContain('"stage":"transaction-prepared"');
      },
    );
  } catch (error) {
    caught = error;
    order.push("caught");
  }
  order.push("cleanup");
  expect(caught).toBe(original);
  expect(order).toEqual(["collect", "emit", "caught", "cleanup"]);

  caught = undefined;
  try {
    await emitTransactionFixtureFailureFactsAndRethrow(
      original,
      async () => {
        throw Error("private path and child output");
      },
      () => {
        throw Error("private stderr failure");
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);

  caught = undefined;
  try {
    await emitTransactionFixtureFailureFactsAndRethrow(
      original,
      async () => ({
        stage: "transaction-prepared",
        child: "exited-nonzero",
        stderr: "empty",
      }),
      () => {
        throw Error("private stderr failure");
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
});

test("import progress facts retain fixed categories after an existing valid stage", () => {
  const child = { child: "running" as const, stderr: "unavailable" as const };
  expect(
    summarizeTransactionFixtureFailure({ ...child, stage: "config-loaded" }),
  ).toEqual({
    ...child,
    stage: "config-loaded",
  });
  for (const stage of [
    "config-import-started",
    "config-import-rejected",
  ] as const) {
    expect(summarizeTransactionFixtureFailure({ ...child, stage })).toEqual({
      ...child,
      stage,
    });
  }
});

test("import observation does not finish before a deferred loader returns its exact module", async () => {
  const module = { value: "loaded" };
  const order: string[] = [];
  let release!: (value: typeof module) => void;
  const deferred = new Promise<typeof module>((resolve) => {
    release = resolve;
  });
  const pending = observeTransactionFixtureConfigImport(
    () => {
      order.push("load");
      return deferred;
    },
    (stage) => {
      order.push(stage);
    },
  ).then((value) => {
    order.push("returned");
    return value;
  });
  expect(order).toEqual(["config-import-started", "load"]);
  await Promise.resolve();
  expect(order).toEqual(["config-import-started", "load"]);
  release(module);
  expect(await pending).toBe(module);
  expect(order).toEqual(["config-import-started", "load", "returned"]);
});

test("throwing progress observers cannot prevent loading or replace its success or rejection", async () => {
  const module = { value: "loaded" };
  let calls = 0;
  expect(
    await observeTransactionFixtureConfigImport(
      async () => {
        calls++;
        return module;
      },
      () => {
        throw Error("private marker failure");
      },
    ),
  ).toBe(module);
  expect(calls).toBe(1);
  const original = new Error("private import failure");
  const stages: string[] = [];
  let caught: unknown;
  try {
    await observeTransactionFixtureConfigImport(
      async () => {
        calls++;
        throw original;
      },
      (stage) => {
        stages.push(stage);
        throw Error("private marker failure");
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
  expect(calls).toBe(2);
  expect(stages).toEqual(["config-import-started", "config-import-rejected"]);
});
