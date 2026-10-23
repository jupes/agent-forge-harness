import type { ConversationBinding } from "../../types/conversation";
import type { Smith } from "../../types/hearth";
import type { KeeperReadiness } from "../../types/keeper-recovery";
import type { ProjectRecord } from "../../types/projects";
import { loadConfig } from "../config/load";
import { ConversationError } from "../conversations/error";
import type { ConversationTransport } from "../conversations/transport";
import { keeperReadiness } from "./readiness";

export interface KeeperRuntime {
  catalog(): { defaultSmith: string; smiths: Smith[] };
  transport(smith: Smith): ConversationTransport | null;
  readiness(
    smith: Smith,
    project: ProjectRecord,
    root: string,
    resume: ConversationBinding | null,
  ): Promise<KeeperReadiness>;
}

/** Provider reports are injected until the provider capability producer exists. */
export function createKeeperRuntime(options: {
  root: string;
  configHome?: string;
  transports: Readonly<Partial<Record<string, ConversationTransport>>>;
  report?:
    | ((
        smith: Smith,
      ) => Promise<
        Partial<
          Pick<
            KeeperReadiness,
            "connection" | "allowance" | "source" | "asOf" | "reason"
          >
        >
      >)
    | undefined;
}): KeeperRuntime {
  const transport = (smith: Smith) =>
    Object.hasOwn(options.transports, smith.provider)
      ? (options.transports[smith.provider] ?? null)
      : null;
  return {
    catalog() {
      const { config } = loadConfig({
        harnessRoot: options.root,
        env: {},
        ...(options.configHome ? { home: options.configHome } : {}),
      });
      const smiths = Object.values(config.smiths);
      if (smiths.length > 100)
        throw new ConversationError(
          503,
          "The Keeper smith catalog exceeds its supported bound.",
        );
      return { defaultSmith: config.workflow.defaultCrew, smiths };
    },
    transport,
    async readiness(smith, project, root, resume) {
      const adapter = transport(smith);
      if (!smith.enabled)
        return keeperReadiness({
          adapter: !!adapter,
          checked: false,
          reason: "This smith is disabled. Choose an enabled smith.",
        });
      if (!adapter) return keeperReadiness({ adapter: false, checked: false });
      if (
        smith.provider === "claude" &&
        /haiku-4-5/i.test(smith.model) &&
        smith.effort
      )
        return keeperReadiness({
          adapter: true,
          checked: false,
          reason:
            "This Haiku model's configured effort is unsupported or unverified. The smith must be checked before use; effort has not been removed.",
        });
      let report: Partial<
        Pick<
          KeeperReadiness,
          "connection" | "allowance" | "source" | "asOf" | "reason"
        >
      > = {};
      try {
        report = (await options.report?.(smith)) ?? {};
      } catch {
        /* An unavailable report proves neither sign-out nor exhaustion. */
      }
      if (report.connection === "adapter-missing")
        report = { ...report, connection: "unknown" };
      try {
        await adapter.check?.({
          project,
          root,
          resume: resume?.provider === smith.provider ? resume : null,
          smith: smith.name,
        });
        return keeperReadiness({
          adapter: true,
          checked: true,
          ...report,
          connection:
            report.connection === "signed-out" || report.connection === "ready"
              ? report.connection
              : "unknown",
        });
      } catch {
        return keeperReadiness({
          adapter: true,
          checked: false,
          ...report,
          connection:
            report.connection === "signed-out" || report.connection === "ready"
              ? report.connection
              : "unknown",
          reason:
            report.reason ??
            "The Keeper adapter capability check could not be verified. Recheck before sending.",
        });
      }
    },
  };
}

export async function prepareKeeper(
  runtime: KeeperRuntime,
  project: ProjectRecord,
  root: string,
  resume: ConversationBinding | null,
  name?: string,
) {
  const catalog = runtime.catalog();
  const smith = catalog.smiths.find(
    (item) => item.name === (name ?? catalog.defaultSmith),
  );
  if (!smith || !smith.enabled)
    throw new ConversationError(
      409,
      "The selected Keeper smith is unknown or disabled. No selection or conversation changed.",
    );
  const transport = runtime.transport(smith);
  const readiness = await runtime.readiness(smith, project, root, resume);
  if (!transport || !readiness.canStart)
    throw new ConversationError(503, readiness.reason);
  return { smith, transport };
}
