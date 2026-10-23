import { createHash } from "node:crypto";
import type {
  SessionLibraryList,
  SessionTranscriptExport,
} from "../../types/session-library";
import { ConversationError } from "../conversations/error";
import { createConversationStore } from "../conversations/store";
import type { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import {
  MAX_SESSION_EXPORT_BYTES,
  originalSessionLaunchMatches,
  sessionTranscriptExportSchema,
} from "./library-protocol";
import { createSessionLibraryStore } from "./library-store";
import { createSessionRegistry } from "./registry";

export { sessionLibraryFile } from "./library-store";

/** Reads saved facts only. No runtime, Stop, native command or provider is available here. */
export function createSessionLibrary(options: {
  root: string;
  home: string;
  now?: () => Date;
  persist?: typeof writeOwnerOnly;
  validateAccess?(projectId: string): void;
}) {
  const registry = createSessionRegistry(options.home);
  const workspace = workspaceKey(resolveCheckout(options.root).workspace);
  const now = options.now ?? (() => new Date());
  const lookup = (projectId: string, sessionId: string) => {
    options.validateAccess?.(projectId);
    const session = registry.lookup(projectId, sessionId);
    if (workspaceKey(session.workspace) !== workspace)
      throw new ConversationError(
        409,
        "This owned session belongs to a different workspace. Open its hearth to read or change it.",
      );
    return session;
  };
  const preferences = createSessionLibraryStore({
    home: options.home,
    now,
    lookup,
    ...(options.persist ? { persist: options.persist } : {}),
  });
  return {
    read: (projectId: string, sessionId: string, requestId?: string) =>
      preferences.read(lookup(projectId, sessionId), requestId),
    archive: preferences.archive,
    list(projectId: string): SessionLibraryList {
      options.validateAccess?.(projectId);
      return {
        projectId,
        entries: preferences.list(
          registry
            .listAll(projectId)
            .filter((session) => workspaceKey(session.workspace) === workspace),
        ),
      };
    },
    exportTranscript(
      projectId: string,
      sessionId: string,
    ): SessionTranscriptExport {
      const session = lookup(projectId, sessionId);
      const state = createConversationStore(options.home, undefined, {
        kind: "session",
        projectId,
        sessionId,
      }).read(projectId);
      if (!originalSessionLaunchMatches(session, state))
        throw new ConversationError(
          503,
          "The original private launch cannot be verified. No partial transcript was exported.",
        );
      for (const turn of state.turns) {
        const user = state.frames.find(
          (frame) =>
            frame.turnId === turn.requestId && frame.event.kind === "user",
        )?.event;
        if (user?.kind !== "user")
          throw new ConversationError(
            503,
            "A private turn is incomplete. No partial transcript was exported.",
          );
        const hash = createHash("sha256")
          .update(
            JSON.stringify({
              text: user.text,
              about: user.about,
              ...(user.brief ? { brief: user.brief } : {}),
              ...(user.session ? { session: user.session } : {}),
              ...(user.codexTask ? { codexTask: user.codexTask } : {}),
            }),
          )
          .digest("hex");
        if (hash !== turn.hash)
          throw new ConversationError(
            503,
            "The original private turn cannot be verified. No partial transcript was exported.",
          );
      }
      const result: SessionTranscriptExport = {
        format: "agent-forge.session-transcript",
        version: 1,
        complete: true,
        exportedAt: now().toISOString(),
        session,
        lastSequence: state.frames.length,
        conversation: {
          conversationId: state.conversationId,
          revision: state.revision,
          binding: state.binding,
          turns: state.turns.map(({ owner: _owner, ...turn }) => turn),
          frames: state.frames,
        },
      };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_SESSION_EXPORT_BYTES)
        throw new ConversationError(
          503,
          "The complete saved transcript exceeds the 8 MiB export limit. No partial export was created.",
        );
      const parsed = sessionTranscriptExportSchema.safeParse(result);
      if (!parsed.success)
        throw new ConversationError(
          503,
          "The saved transcript is incomplete or unsupported. No partial export was created.",
        );
      return parsed.data;
    },
  };
}
