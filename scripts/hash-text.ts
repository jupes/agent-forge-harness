/**
 * The one text hash the harness uses: SHA-256, hex.
 *
 * A leaf module — it imports nothing of the harness — so a hook can hash a
 * prompt or a tool input without loading anything else.
 */

import { createHash } from "crypto";

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
