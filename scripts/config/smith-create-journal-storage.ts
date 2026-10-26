/** Existing Smith create storage API; the shared adapter keeps its fixed namespace. */

import { agentForgeHome } from "../agent-forge-home";
import {
  createSmithConfigJournalStorage,
  isTrustedNewSmithSidecarOwner,
} from "./smith-config-journal-storage";
import type { SmithCreateJournalStorage } from "./smith-create-journal-core";

export { isTrustedNewSmithSidecarOwner };

/** Preserve the existing create-family factory and on-disk namespace. */
export function createSmithCreateJournalStorage(
  profileHome: string = agentForgeHome(),
): SmithCreateJournalStorage {
  return createSmithConfigJournalStorage(profileHome, "create");
}
