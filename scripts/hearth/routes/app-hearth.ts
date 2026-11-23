import { lstatSync } from "node:fs";
import { loadConfig } from "../../config/load";
import {
  type AppHearthSettings,
  appHearthSettingsSchema,
} from "../../desktop/app-hearth-protocol";
import { BACKUP_KEEP_DAYS, RETENTION_DAYS } from "../../ledger/backup";
import type { ReadRoute } from "../api";
import { HEARTH_API_VERSION } from "../protocol";
import { noParameters, type ReadDeps } from "./operator-reads";

function fileSize(path: string): AppHearthSettings["ledger"]["database"] {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && Number.isSafeInteger(stat.size) && stat.size >= 0
      ? { state: "available", bytes: stat.size }
      : { state: "unknown" };
  } catch (error) {
    return error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
      ? { state: "missing" }
      : { state: "unknown" };
  }
}
function environment(deps: ReadDeps): AppHearthSettings["execution"] {
  try {
    const names = loadConfig({
      harnessRoot: deps.root,
      env: {},
      ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
    }).config.execution.envPass;
    // The loader accepts arbitrary strings; never echo malformed config or its errors.
    if (
      names.length > 256 ||
      names.some(
        (name) => name.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
      )
    )
      return { state: "unavailable" };
    return { state: "available", names: [...new Set(names)].sort() };
  } catch {
    return { state: "unavailable" };
  }
}
/** Only fixed metadata paths bound by this Hearth; no reads open the DB or perform upkeep. */
export function appHearthSettingsRead(deps: ReadDeps): ReadRoute<null> {
  return {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/app-settings/hearth",
    validate: noParameters,
    read() {
      let port: number | null = null;
      try {
        const bound = deps.runtimePort?.();
        if (
          typeof bound === "number" &&
          Number.isInteger(bound) &&
          bound > 0 &&
          bound <= 65535
        )
          port = bound;
      } catch {
        /* Listening state is unavailable, never inferred from the UI origin. */
      }
      return {
        status: 200,
        data: appHearthSettingsSchema.parse({
          version: 1,
          checkedAt: new Date().toISOString(),
          port,
          apiVersion: HEARTH_API_VERSION,
          ledger: {
            path: deps.ledgerPath,
            database: fileSize(deps.ledgerPath),
            wal: fileSize(deps.ledgerPath + "-wal"),
            sharedMemory: fileSize(deps.ledgerPath + "-shm"),
          },
          upkeep: {
            backupKeepDays: BACKUP_KEEP_DAYS,
            retentionDays: RETENTION_DAYS,
            backupTrigger: "session-start-if-due",
            nightlyBackup: deps.readLedgerBackupSchedule?.() ?? null,
            compactionTrigger: "manual",
          },
          execution: environment(deps),
        }),
      };
    },
  };
}
