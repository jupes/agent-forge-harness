/**
 * Generic, idempotent Beads plan importer.
 *
 * A plan is a list of issues with stable local keys, parent links and deps.
 * `importPlan` creates missing issues (matching by parent + exact title) and
 * missing `blocks` dependencies, in an order where parents and blockers exist
 * first. Re-running creates nothing new.
 *
 * The `BdClient` seam lets tests run without `bd`; `createExecBdClient()` is
 * the real implementation (argument arrays, never a shell string).
 */
import { execFileSync } from "node:child_process";
import { parseBdCreateJsonOutput, parseJsonLoose } from "./bd-json-parse";

export type PlanIssueType =
  | "epic"
  | "feature"
  | "task"
  | "decision"
  | "bug"
  | "chore";

export interface PlanIssue {
  /** Stable local key, unique within the plan. */
  key: string;
  /** Key of the parent issue; absent only for the epic. */
  parent?: string;
  type: PlanIssueType;
  /** 0 (critical) … 4 (lowest). */
  priority: 0 | 1 | 2 | 3 | 4;
  title: string;
  description?: string;
  /** Acceptance criteria lines; rendered as a bullet list. */
  acceptance: string[];
  labels?: string[];
  /** Keys in this plan, or real Beads IDs, that block this issue. */
  deps?: string[];
}

export interface PlanSpec {
  name: string;
  epicKey: string;
  issues: PlanIssue[];
}

export interface BdIssueRow {
  id: string;
  title: string;
  issue_type?: string;
  status?: string;
}

export interface BdDepRow {
  id: string;
  dependency_type?: string;
}

export interface BdCreateParams {
  title: string;
  type: PlanIssueType;
  priority: number;
  parent?: string | undefined;
  acceptance?: string | undefined;
  description?: string | undefined;
  labels?: string[] | undefined;
}

export interface BdClient {
  findEpicByTitle(title: string): string | null;
  listChildren(parentId: string): BdIssueRow[];
  create(params: BdCreateParams): string;
  listDeps(issueId: string): BdDepRow[];
  depAdd(blocked: string, dependsOn: string): void;
}

export interface ImportResult {
  /** key → Beads id for every issue in the plan. */
  ids: Record<string, string>;
  created: string[];
  reused: string[];
  depsAdded: Array<{ blocked: string; dependsOn: string }>;
}

const EXTERNAL_ID = /^agent-forge-harness-[a-z0-9]+(\.[a-z0-9]+)*$/;

export function isExternalId(ref: string): boolean {
  return EXTERNAL_ID.test(ref);
}

/** Structural validation: keys, parents, deps, acyclicity, required fields. */
export function validatePlan(spec: PlanSpec): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, PlanIssue>();
  for (const issue of spec.issues) {
    if (byKey.has(issue.key)) errors.push(`duplicate key: ${issue.key}`);
    byKey.set(issue.key, issue);
  }
  const epic = byKey.get(spec.epicKey);
  if (!epic) errors.push(`epicKey ${spec.epicKey} not in issues`);
  else if (epic.type !== "epic")
    errors.push(`epicKey ${spec.epicKey} is not type epic`);
  if (epic?.parent) errors.push(`epic ${spec.epicKey} must not have a parent`);

  for (const issue of spec.issues) {
    if (!issue.title.trim()) errors.push(`${issue.key}: empty title`);
    if (
      issue.priority < 0 ||
      issue.priority > 4 ||
      !Number.isInteger(issue.priority)
    ) {
      errors.push(`${issue.key}: priority must be an integer 0–4`);
    }
    if (!issue.acceptance.length || issue.acceptance.some((a) => !a.trim())) {
      errors.push(`${issue.key}: acceptance criteria required`);
    }
    if (issue.key !== spec.epicKey) {
      if (!issue.parent) errors.push(`${issue.key}: missing parent`);
      else if (!byKey.has(issue.parent))
        errors.push(`${issue.key}: unknown parent ${issue.parent}`);
    }
    if (issue.type === "epic" && issue.key !== spec.epicKey) {
      errors.push(`${issue.key}: only ${spec.epicKey} may be an epic`);
    }
    for (const dep of issue.deps ?? []) {
      if (dep === issue.key) errors.push(`${issue.key}: depends on itself`);
      else if (!byKey.has(dep) && !isExternalId(dep)) {
        errors.push(`${issue.key}: unknown dep ${dep}`);
      }
    }
  }

  const cycle = findCycle(spec);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  return errors;
}

/** Internal deps (keys only) plus parent edges, as a map key → prerequisites. */
function prerequisites(spec: PlanSpec): Map<string, string[]> {
  const keys = new Set(spec.issues.map((i) => i.key));
  const out = new Map<string, string[]>();
  for (const issue of spec.issues) {
    const prereqs: string[] = [];
    if (issue.parent && keys.has(issue.parent)) prereqs.push(issue.parent);
    for (const dep of issue.deps ?? []) if (keys.has(dep)) prereqs.push(dep);
    out.set(issue.key, prereqs);
  }
  return out;
}

function findCycle(spec: PlanSpec): string[] | null {
  const pre = prerequisites(spec);
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    const s = state.get(key);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, "visiting");
    stack.push(key);
    for (const p of pre.get(key) ?? []) {
      const found = visit(p);
      if (found) return found;
    }
    stack.pop();
    state.set(key, "done");
    return null;
  };
  for (const key of pre.keys()) {
    const found = visit(key);
    if (found) return found;
  }
  return null;
}

/** Issues ordered so every parent and internal blocker precedes its dependents. Stable otherwise. */
export function topoOrder(spec: PlanSpec): PlanIssue[] {
  const pre = prerequisites(spec);
  const byKey = new Map(spec.issues.map((i) => [i.key, i]));
  const placed = new Set<string>();
  const out: PlanIssue[] = [];
  const place = (key: string): void => {
    if (placed.has(key)) return;
    placed.add(key);
    for (const p of pre.get(key) ?? []) place(p);
    const issue = byKey.get(key);
    if (issue) out.push(issue);
  };
  for (const issue of spec.issues) place(issue.key);
  return out;
}

export function renderAcceptance(lines: string[]): string {
  return lines.map((l) => `- [ ] ${l}`).join("\n");
}

export function importPlan(
  spec: PlanSpec,
  bd: BdClient,
  log: (line: string) => void = () => {},
): ImportResult {
  const errors = validatePlan(spec);
  if (errors.length) {
    throw new Error(`invalid plan ${spec.name}:\n${errors.join("\n")}`);
  }
  const result: ImportResult = {
    ids: {},
    created: [],
    reused: [],
    depsAdded: [],
  };

  for (const issue of topoOrder(spec)) {
    const parentId = issue.parent ? result.ids[issue.parent] : undefined;
    const existing =
      issue.key === spec.epicKey
        ? bd.findEpicByTitle(issue.title)
        : (bd
            .listChildren(parentId as string)
            .find((r) => r.title === issue.title)?.id ?? null);
    if (existing) {
      result.ids[issue.key] = existing;
      result.reused.push(issue.key);
      log(`reuse ${issue.key} -> ${existing}`);
      continue;
    }
    const id = bd.create({
      title: issue.title,
      type: issue.type,
      priority: issue.priority,
      parent: parentId,
      acceptance: renderAcceptance(issue.acceptance),
      description: issue.description,
      labels: issue.labels,
    });
    result.ids[issue.key] = id;
    result.created.push(issue.key);
    log(`create ${issue.key} -> ${id}`);
  }

  for (const issue of spec.issues) {
    const blocked = result.ids[issue.key];
    if (!blocked) continue;
    for (const dep of issue.deps ?? []) {
      const dependsOn = result.ids[dep] ?? dep;
      const have = bd
        .listDeps(blocked)
        .some(
          (d) =>
            d.id === dependsOn &&
            (d.dependency_type === "blocks" || !d.dependency_type),
        );
      if (have) continue;
      bd.depAdd(blocked, dependsOn);
      result.depsAdded.push({ blocked, dependsOn });
      log(`dep ${blocked} <- ${dependsOn}`);
    }
  }
  return result;
}

/** Markdown bead map for docs: one table row per issue, with resolved ids when known. */
export function renderPlanMarkdown(
  spec: PlanSpec,
  ids: Record<string, string> = {},
): string {
  const lines = [
    "| Key | Beads ID | Type | P | Title | Blocked by |",
    "|---|---|---|---|---|---|",
  ];
  for (const issue of spec.issues) {
    const deps = (issue.deps ?? []).map((d) => ids[d] ?? d).join(", ") || "—";
    const id = ids[issue.key] ?? "(not imported)";
    lines.push(
      `| \`${issue.key}\` | \`${id}\` | ${issue.type} | P${issue.priority} | ${issue.title} | ${deps} |`,
    );
  }
  return lines.join("\n");
}

function execBd(args: string[]): string {
  return execFileSync("bd", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}

function listIssues(extraArgs: string[]): BdIssueRow[] {
  const parsed: unknown = parseJsonLoose(
    execBd(["list", "--json", "--flat", "--limit", "500", ...extraArgs]),
  );
  if (!Array.isArray(parsed))
    throw new Error("bd list --json did not return an array");
  return parsed as BdIssueRow[];
}

export function createExecBdClient(): BdClient {
  return {
    findEpicByTitle(title) {
      const rows = listIssues(["--type", "epic", "--status", "open"]);
      return rows.find((r) => r.title === title)?.id ?? null;
    },
    listChildren(parentId) {
      return listIssues(["--parent", parentId]);
    },
    create(params) {
      const args = [
        "create",
        params.title,
        "--type",
        params.type,
        "--priority",
        String(params.priority),
        "--json",
      ];
      if (params.parent) args.push("--parent", params.parent);
      if (params.acceptance) args.push("--acceptance", params.acceptance);
      if (params.description) args.push("--description", params.description);
      if (params.labels?.length) args.push("--labels", params.labels.join(","));
      const json = parseBdCreateJsonOutput(execBd(args));
      if (!json?.id || typeof json.id !== "string") {
        throw new Error(`bd create returned no issue id for "${params.title}"`);
      }
      return json.id;
    },
    listDeps(issueId) {
      const parsed: unknown = parseJsonLoose(
        execBd(["dep", "list", issueId, "--json"]),
      );
      return Array.isArray(parsed) ? (parsed as BdDepRow[]) : [];
    },
    depAdd(blocked, dependsOn) {
      execBd(["dep", "add", blocked, dependsOn]);
    },
  };
}
