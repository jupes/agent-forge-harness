import { describe, expect, test } from "bun:test";
import { parseMoleculeJson } from "./parse";

const minimal = {
  schemaVersion: 1,
  id: "m",
  title: "M",
  steps: [
    { id: "a", title: "A", agent: "worker", produces: [], consumes: [], depends_on: [] },
  ],
};

describe("parseMoleculeJson", () => {
  test("accepts minimal molecule", () => {
    const r = parseMoleculeJson(JSON.stringify(minimal));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.steps[0]?.id).toBe("a");
  });

  test("rejects duplicate step id", () => {
    const m = {
      ...minimal,
      steps: [
        minimal.steps[0],
        { id: "a", title: "B", agent: "worker", produces: [], consumes: [], depends_on: [] },
      ],
    };
    const r = parseMoleculeJson(JSON.stringify(m));
    expect(r.ok).toBe(false);
  });

  test("rejects unknown depends_on target", () => {
    const m = {
      ...minimal,
      steps: [
        { id: "a", title: "A", agent: "worker", produces: [], consumes: [], depends_on: ["missing"] },
      ],
    };
    const r = parseMoleculeJson(JSON.stringify(m));
    expect(r.ok).toBe(false);
  });

  test("rejects cycles", () => {
    const m = {
      ...minimal,
      steps: [
        { id: "a", title: "A", agent: "worker", produces: [], consumes: [], depends_on: ["b"] },
        { id: "b", title: "B", agent: "worker", produces: [], consumes: [], depends_on: ["a"] },
      ],
    };
    const r = parseMoleculeJson(JSON.stringify(m));
    expect(r.ok).toBe(false);
  });

  test("rejects unknown gate kind", () => {
    const m = {
      ...minimal,
      steps: [
        {
          id: "a",
          title: "A",
          agent: "worker",
          produces: [],
          consumes: [],
          depends_on: [],
          gate: { kind: "not-a-gate" },
        },
      ],
    };
    const r = parseMoleculeJson(JSON.stringify(m));
    expect(r.ok).toBe(false);
  });

  test("accepts eval-verdict gate", () => {
    const m = {
      ...minimal,
      steps: [
        {
          id: "a",
          title: "A",
          agent: "evaluator",
          produces: [],
          consumes: [],
          depends_on: [],
          gate: { kind: "eval-verdict" },
        },
      ],
    };
    const r = parseMoleculeJson(JSON.stringify(m));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.steps[0]?.gate?.kind).toBe("eval-verdict");
  });
});
