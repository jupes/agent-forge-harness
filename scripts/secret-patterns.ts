/**
 * The secret shapes the harness refuses to send to a provider or store in the
 * ledger. One list, shared by the council's context packer and the ledger's
 * redaction. Imports nothing, so it is safe in any runtime.
 */

export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> =
  [
    {
      kind: "provider-api-key-assignment",
      pattern:
        /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|OPENROUTER_API_KEY)\s*[:=]\s*["']?[^\s"']{8,}/gi,
    },
    {
      kind: "private-key",
      pattern:
        /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    },
    { kind: "anthropic-api-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    {
      kind: "openai-api-key",
      pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    },
    {
      kind: "github-token",
      pattern: /gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}/g,
    },
    { kind: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
    { kind: "slack-token", pattern: /xox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}/g },
  ];

export interface SecretRedaction {
  kind: string;
  count: number;
}

/** Replace every secret-shaped span with `[REDACTED:<kind>]` and say what was found. */
export function redactSecrets(text: string): {
  text: string;
  redactions: SecretRedaction[];
} {
  let sanitized = text;
  const redactions: SecretRedaction[] = [];
  for (const secret of SECRET_PATTERNS) {
    const matches = sanitized.match(secret.pattern);
    if (!matches || matches.length === 0) continue;
    redactions.push({ kind: secret.kind, count: matches.length });
    sanitized = sanitized.replace(secret.pattern, `[REDACTED:${secret.kind}]`);
  }
  return { text: sanitized, redactions };
}
