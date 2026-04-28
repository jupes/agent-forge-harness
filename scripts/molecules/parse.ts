/**
 * Molecule parser — validates `.claude/molecules/*.json` against schema v1.
 * See `.claude/molecules/README.md`.
 */

export const MOLECULE_SCHEMA_VERSION = 1 as const;

export const MOLECULE_AGENTS = ["lead", "worker", "evaluator", "user"] as const;
export type MoleculeAgent = (typeof MOLECULE_AGENTS)[number];

export const MOLECULE_GATE_KINDS = ["quality-gate", "eval-verdict"] as const;
export type MoleculeGateKind = (typeof MOLECULE_GATE_KINDS)[number];

export type MoleculeGate = { kind: MoleculeGateKind };

export type MoleculeStep = {
  id: string;
  title: string;
  agent: MoleculeAgent;
  produces: string[];
  consumes: string[];
  depends_on: string[];
  gate?: MoleculeGate;
};

export type Molecule = {
  schemaVersion: typeof MOLECULE_SCHEMA_VERSION;
  id: string;
  title: string;
  description?: string;
  steps: MoleculeStep[];
};

export type ParseMoleculeResult =
  | { ok: true; value: Molecule }
  | { ok: false; error: string };

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

export function parseMoleculeJson(text: string): ParseMoleculeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "root must be an object" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== MOLECULE_SCHEMA_VERSION) {
    return { ok: false, error: "schemaVersion must be 1" };
  }
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) {
    return {
      ok: false,
      error: "id must be kebab-case (lower a-z, 0-9, hyphen)",
    };
  }
  if (typeof o.title !== "string" || o.title.trim() === "") {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (o.description !== undefined && typeof o.description !== "string") {
    return { ok: false, error: "description must be a string when present" };
  }
  if (!Array.isArray(o.steps) || o.steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }

  const stepIds = new Set<string>();
  const steps: MoleculeStep[] = [];
  const adjacency = new Map<string, string[]>();

  for (const s of o.steps) {
    if (typeof s !== "object" || s === null) {
      return { ok: false, error: "each step must be an object" };
    }
    const st = s as Record<string, unknown>;
    if (typeof st.id !== "string" || !ID_RE.test(st.id)) {
      return { ok: false, error: "step.id must be kebab-case" };
    }
    if (stepIds.has(st.id)) {
      return { ok: false, error: `duplicate step id: ${st.id}` };
    }
    if (typeof st.title !== "string" || st.title.trim() === "") {
      return {
        ok: false,
        error: `step.${st.id}.title must be a non-empty string`,
      };
    }
    if (
      typeof st.agent !== "string" ||
      !MOLECULE_AGENTS.includes(st.agent as MoleculeAgent)
    ) {
      return {
        ok: false,
        error: `step.${st.id}.agent must be one of ${MOLECULE_AGENTS.join("|")}`,
      };
    }
    const produces = st.produces ?? [];
    const consumes = st.consumes ?? [];
    const depends_on = st.depends_on ?? [];
    if (
      !isStringArray(produces) ||
      !isStringArray(consumes) ||
      !isStringArray(depends_on)
    ) {
      return {
        ok: false,
        error: `step.${st.id}.{produces,consumes,depends_on} must be string arrays`,
      };
    }
    let gate: MoleculeGate | undefined;
    if (st.gate !== undefined && st.gate !== null) {
      if (typeof st.gate !== "object" || Array.isArray(st.gate)) {
        return { ok: false, error: `step.${st.id}.gate must be an object` };
      }
      const g = st.gate as Record<string, unknown>;
      if (
        typeof g.kind !== "string" ||
        !MOLECULE_GATE_KINDS.includes(g.kind as MoleculeGateKind)
      ) {
        return {
          ok: false,
          error: `step.${st.id}.gate.kind must be one of ${MOLECULE_GATE_KINDS.join("|")}`,
        };
      }
      gate = { kind: g.kind as MoleculeGateKind };
    }
    stepIds.add(st.id);
    const built: MoleculeStep = {
      id: st.id,
      title: st.title,
      agent: st.agent as MoleculeAgent,
      produces,
      consumes,
      depends_on,
    };
    if (gate) built.gate = gate;
    steps.push(built);
    adjacency.set(st.id, depends_on);
  }

  for (const [from, deps] of adjacency) {
    for (const d of deps) {
      if (!stepIds.has(d)) {
        return {
          ok: false,
          error: `step.${from}.depends_on references unknown step: ${d}`,
        };
      }
      if (d === from) {
        return { ok: false, error: `step.${from} cannot depend on itself` };
      }
    }
  }

  // Cycle detection (iterative DFS)
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of stepIds) color.set(id, WHITE);
  for (const start of stepIds) {
    if (color.get(start) !== WHITE) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const deps = adjacency.get(top.id) ?? [];
      if (top.i >= deps.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const next = deps[top.i]!;
      top.i += 1;
      const c = color.get(next);
      if (c === GRAY) {
        return { ok: false, error: `cycle detected at step: ${next}` };
      }
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({ id: next, i: 0 });
      }
    }
  }

  const molecule: Molecule = {
    schemaVersion: MOLECULE_SCHEMA_VERSION,
    id: o.id,
    title: o.title,
    steps,
  };
  if (typeof o.description === "string") molecule.description = o.description;
  return { ok: true, value: molecule };
}
