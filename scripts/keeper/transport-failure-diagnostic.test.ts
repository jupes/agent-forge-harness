import { expect, test } from "bun:test";
import { createKeeperTransportFailureWitness } from "./transport-failure-diagnostic.test-utils";

test("Keeper transport failure witness preserves the original error and reports only a fixed cleanup category", async () => {
  const witness = createKeeperTransportFailureWitness();
  const error = new Error(
    "Owned process group cleanup could not be confirmed.",
  );
  await expect(
    witness.observe(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(witness.facts()).toEqual({
    calls: 1,
    state: "threw",
    failure: {
      category: "owned-process-group-unconfirmed",
      errorName: "Error",
      errorCode: "none",
    },
  });
});

test("Keeper failure facts exclude private values and never invoke hostile accessors", async () => {
  const witness = createKeeperTransportFailureWitness();
  let getters = 0;
  const error = {
    get message() {
      getters++;
      throw Error("PRIVATE accessor");
    },
    get code() {
      getters++;
      return "PRIVATE code";
    },
    payload: "PRIVATE body",
  };
  await expect(
    witness.observe(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(getters).toBe(0);
  expect(witness.facts()).toEqual({
    calls: 1,
    state: "threw",
    failure: { category: "other", errorName: "other", errorCode: "none" },
  });
  expect(JSON.stringify(witness.facts())).not.toContain("PRIVATE");
});

test("Keeper failure witness preserves returned values and marks repeated calls ambiguous", async () => {
  const witness = createKeeperTransportFailureWitness();
  const result = { payload: "PRIVATE return" };
  expect(await witness.observe(async () => result)).toBe(result);
  expect(witness.facts()).toEqual({
    calls: 1,
    state: "returned",
    failure: null,
  });
  const error = Object.assign(new Error("PRIVATE error path"), {
    code: "EPIPE",
  });
  await expect(
    witness.observe(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(witness.facts()).toEqual({
    calls: 2,
    state: "ambiguous",
    failure: null,
  });
  expect(JSON.stringify(witness.facts())).not.toContain("PRIVATE");
});

test.each([
  { code: "EPIPE", expected: "EPIPE" },
  { code: "PRIVATE arbitrary code", expected: "other" },
])("Keeper failure code projection remains allowlisted: $expected", async ({
  code,
  expected,
}) => {
  const witness = createKeeperTransportFailureWitness();
  const error = Object.assign(new Error("PRIVATE error body"), { code });
  await expect(
    witness.observe(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(witness.facts().failure).toEqual({
    category: "other",
    errorName: "Error",
    errorCode: expected,
  });
  expect(JSON.stringify(witness.facts())).not.toContain("PRIVATE");
});

test("Keeper observation failure cannot replace the thrown provider object", async () => {
  const witness = createKeeperTransportFailureWitness();
  const error = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("PRIVATE reflection failure");
      },
    },
  );
  await expect(
    witness.observe(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(witness.facts().failure).toEqual({
    category: "unavailable",
    errorName: "unavailable",
    errorCode: "unavailable",
  });
  expect(JSON.stringify(witness.facts())).not.toContain("PRIVATE");
});
