import { statSync } from "node:fs";
import type { ClaudeAccountReport } from "../../types/claude-account";
import type { ProviderUsageReport } from "../../types/provider-readiness";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import {
  claudeAccountReportSchema,
  latestClaudeAccountReports,
} from "../sessions/claude-account";
import { createSessionRegistry } from "../sessions/registry";

/** Explicit percent/ISO fields only. Numeric utilization/reset fields have unreported units. */
export function projectClaudeUsage(
  reports: readonly ClaudeAccountReport[],
  options: { version: string | null; after: string | null },
): ProviderUsageReport[] {
  let latest: Extract<
    ClaudeAccountReport,
    { source: "claude.usage_report" }
  > | null = null;
  for (const report of reports) {
    const parsed = claudeAccountReportSchema.parse(report);
    if (
      parsed.source === "claude.usage_report" &&
      (!latest || parsed.observedAt >= latest.observedAt)
    )
      latest = parsed;
  }
  if (
    !latest ||
    latest.version !== options.version ||
    (options.after !== null && latest.observedAt <= options.after)
  )
    return [];
  const active =
    latest.report.rate_limits?.limits?.filter(
      (limit) => limit.is_active === true,
    ) ?? [];
  return active.slice(0, 24).flatMap((limit, index) => {
    if (/[\p{Cc}\p{Cs}]/u.test(`${limit.kind}${limit.group}`)) return [];
    return [
      {
        id: `claude-native-${index}`,
        label: `${limit.group} · ${limit.kind}`,
        kind: "subscription-window" as const,
        unit: "percent" as const,
        basis: "used" as const,
        value: limit.percent,
        total: 100,
        observedAt: latest.observedAt,
        resetAt: limit.resets_at,
        durationMs: null,
        source: "provider-cli" as const,
        reason: `Reported by a private session using native Claude ${latest.version}. Account identity and continuity with the current CLI sign-in are not reported. ${active.length > 24 ? "Only the first24 active windows are shown. " : ""}No duration or numeric reset unit is inferred.`,
      },
    ];
  });
}

/** Bounded protected projection, never a new provider call or credential-file read. */
export async function readOwnedClaudeUsage(options: {
  home: string;
  workspace: string;
  version: string | null;
  after: string | null;
}) {
  const rows = createSessionRegistry(options.home)
    .listWorkspace(options.workspace)
    .filter((row) => row.provider === "claude")
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  const candidates = rows.slice(0, 32),
    reports: ClaudeAccountReport[] = [];
  let bytes = 0,
    read = 0;
  const deadline = performance.now() + 2000;
  for (const row of candidates) {
    if (performance.now() > deadline) break;
    const address = {
        kind: "session" as const,
        projectId: row.projectId,
        sessionId: row.id,
      },
      file = conversationFile(options.home, row.projectId, address);
    let size: number;
    try {
      size = statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (bytes + size > 8 * 1024 * 1024) break;
    bytes += size;
    const state = createConversationStore(
        options.home,
        undefined,
        address,
      ).read(row.projectId),
      latest = latestClaudeAccountReports(state.frames);
    if (latest.usage) reports.push(latest.usage);
    read++;
    await Bun.sleep(0);
  }
  return {
    reports: projectClaudeUsage(reports, options),
    reason: `Allowance comes only from typed private native session reports, not the doctor command. Checked${read} of the newest${candidates.length} owned Claude sessions in this workspace (maximum32 sessions,8MiB,2-second scan budget). Older or unscanned sessions may be absent. Account identity/continuity is unreported; sign-in attempts and CLI version changes invalidate earlier allowance.`,
  };
}
