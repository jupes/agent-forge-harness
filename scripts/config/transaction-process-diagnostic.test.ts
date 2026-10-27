import { expect, test } from "bun:test";
import {
  emitTransactionFixtureFailureFactsAndRethrow,
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
