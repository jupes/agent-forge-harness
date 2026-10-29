import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { readHearth } from "../../../docs/js/hearth-read";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import {
  createSessionArchiveJournal,
  SESSION_ARCHIVE_JOURNAL,
} from "./session-archive-journal";
import {
  downloadSessionTranscript,
  readSessionExportResponse,
} from "./session-export";
import { createSessionLibraryClient } from "./session-library-client";

const path = (record: OwnedCodingSessionRecord) =>
  `/projects/${encodeURIComponent(record.projectId)}/sessions/${encodeURIComponent(record.id)}`;
export function useSessionLibrary(
  projectId: string | null,
  record: OwnedCodingSessionRecord | null,
  writesAllowed: boolean,
) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0);
  const held = useRef<ReturnType<typeof createSessionLibraryClient> | null>(
    null,
  );
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Archive stays unavailable before any write. */
    }
    held.current = createSessionLibraryClient({
      canWrite: () => writes.current,
      requestId: () => crypto.randomUUID(),
      journal: createSessionArchiveJournal({
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error(
              "Shared original archive identity locking is unavailable.",
            );
          return navigator.locks.request(
            SESSION_ARCHIVE_JOURNAL,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      list: (id) =>
        readOperatorRoute(
          `/projects/${encodeURIComponent(id)}/session-library`,
          { ...pageReads(), fetch: operatorRead },
        ),
      read: (selected, requestId) =>
        readOperatorRoute(
          `${path(selected)}/archive${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
          { ...pageReads(), fetch: operatorRead },
        ),
      post: (selected, original) =>
        actionOutcome(
          () =>
            operatorPost(`/__agent-forge${path(selected)}/archive`, original),
          "Check the original archive change before retrying.",
        ),
      exportTranscript: (selected) =>
        readHearth(
          `/__agent-forge${path(selected)}/export`,
          readSessionExportResponse,
          { ...pageReads(), fetch: operatorRead },
        ),
      download: downloadSessionTranscript,
      readTerminal: (selected) =>
        readOperatorRoute(`${path(selected)}/terminal-handoff`, {
          ...pageReads(),
          fetch: operatorRead,
        }),
      postTerminal: (selected, requestId) =>
        actionOutcome(
          () =>
            operatorPost(`/__agent-forge${path(selected)}/terminal-handoff`, {
              requestId,
            }),
          "Check the original terminal handoff before trying again.",
        ),
    });
  }
  const client = held.current;
  const terminalPhase = client.current()?.terminalAttempt?.phase;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    client.activate(projectId, record);
  }, [
    client,
    projectId,
    record?.id,
    record?.requestId,
    record?.requestHash,
    record?.workspace,
  ]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === SESSION_ARCHIVE_JOURNAL) client.refreshIdentities();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [client]);
  useEffect(
    () =>
      appStream().watch(["operator.action", "session.started"], () => {
        void client.refresh();
        client.refreshTerminal();
      }),
    [client],
  );
  useEffect(() => {
    if (terminalPhase !== "opened") return;
    const timer = window.setInterval(() => client.refreshTerminal(), 2000);
    return () => window.clearInterval(timer);
  }, [client, terminalPhase]);
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
