import { expect, test } from "bun:test";
import { redactSecrets } from "../secret-patterns";
import { safeMessage } from "./api";
import { looksLikeSecret } from "./routes/operator-reads";
import { launchFailure } from "./shift-launcher";
import { isBeadId } from "./tracker-write";

for (const hidden of ["\u200b", "\u00ad", "\u2060", "\u{e0020}", "\v", "\r"]) {
  for (const prefix of ["", `sk-${"Q7a".repeat(10)}`]) {
    test(`every hearth scanner handles ${JSON.stringify(hidden)} with glued key=${prefix !== ""}`, () => {
      const value = "ValueHead_" + "9aZ".repeat(8) + "_ValueTail";
      const text = `${prefix}OPENAI_API_KEY${hidden}=${value}`;
      expect(safeMessage(new Error(text))).not.toContain("ValueHead");
      expect(safeMessage(text)).not.toContain("ValueTail");
      expect(looksLikeSecret(text)).toBe(true);
      expect(isBeadId(text)).toBe(false);
      const failure = launchFailure({
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: text }),
        stderr: "",
      });
      expect(failure).not.toContain("ValueHead");
      expect(failure).not.toContain("ValueTail");
      expect(redactSecrets(text).redactions.length).toBeGreaterThan(0);
    });
  }
}
