import type { ConversationObject } from "../../types/conversation";
import type { KeeperReadKind } from "../../types/keeper";

/** Object identities are references into the sealed reader, never filesystem paths. */
export const KEEPER_OBJECT_READS = {
  bead: "beads",
  session: "sessions",
  run: "runs",
  event: "activity",
} as const satisfies Record<ConversationObject["kind"], KeeperReadKind>;
