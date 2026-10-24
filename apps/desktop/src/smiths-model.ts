import type { LoadedConfig } from "../../../scripts/config/load";
import type { ScoreboardRow } from "../../../types/hearth";
import { boundedSmithsValue, savedSmithConfigSchema } from "./smiths-protocol";

export const SMITH_FIELDS = [
  "provider",
  "model",
  "effort",
  "enabled",
  "tags",
] as const;

export function inspectSmiths(raw: unknown) {
  const loaded = savedSmithConfigSchema.parse(boundedSmithsValue(raw));
  const source = (key: string) => loaded.provenance[key]?.source ?? null;
  return {
    files: loaded.files,
    defaultSmith: loaded.config.workflow.defaultCrew,
    defaultSource: source("workflow.default_crew"),
    smiths: Object.values(loaded.config.smiths).map((smith) => {
      const ranks = smith.tags.filter((tag) =>
        /^rank:(master|journeyman|apprentice)$/.test(tag),
      );
      return {
        ...smith,
        rank: ranks.length === 1 ? (ranks[0]?.slice(5) ?? null) : null,
        fields: SMITH_FIELDS.map((key) => ({
          key,
          value: smith[key],
          source: source(`smiths.${smith.name}.${key}`),
        })),
      };
    }),
    benches: (["low", "medium", "high"] as const).map((name) => {
      const rows = loaded.config.benches[name];
      const total = rows.reduce((sum, row) => sum + row.weight, 0);
      return {
        name,
        source: source(`benches.${name}`),
        entries: rows.map((row) => ({
          ...row,
          percent: (row.weight / total) * 100,
          enabled: loaded.config.smiths[row.smith]?.enabled ?? false,
        })),
      };
    }),
  };
}
export type SmithInspection = ReturnType<typeof inspectSmiths>;
export function scoreboardKey(row: ScoreboardRow): string {
  return JSON.stringify([
    row.executor?.smith ?? null,
    row.executor?.provider ?? null,
    row.executor?.model ?? null,
  ]);
}
export function metric(
  value: number | null | undefined,
  kind: "count" | "usd" | "percent" = "count",
) {
  return value === null || value === undefined
    ? "—"
    : kind === "usd"
      ? `$${value.toFixed(2)}`
      : kind === "percent"
        ? `${(value * 100).toFixed(1)}%`
        : value.toLocaleString();
}
/** Only the fields already reported by the loader are used; no provider selection is resolved. */
export function sameSmithConfiguration(
  loaded: LoadedConfig,
  view: unknown,
): boolean {
  if (
    !view ||
    typeof view !== "object" ||
    !("smiths" in view) ||
    !("benches" in view) ||
    !("defaultSmith" in view)
  )
    return false;
  return (
    JSON.stringify(view.smiths) ===
      JSON.stringify(Object.values(loaded.config.smiths)) &&
    JSON.stringify(view.benches) === JSON.stringify(loaded.config.benches) &&
    view.defaultSmith === loaded.config.workflow.defaultCrew
  );
}
