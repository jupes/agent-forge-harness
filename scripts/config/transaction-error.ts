export class ConfigTransactionError extends Error {
  constructor(
    readonly reason:
      | "invalid"
      | "changed"
      | "closed"
      | "busy"
      | "unusable"
      | "unconfirmed",
    message: string,
    /** True once replacement was attempted; never a durable write receipt. */
    readonly replacementAttempted = false,
  ) {
    super(message);
  }
}

export function configChanged(): never {
  throw new ConfigTransactionError(
    "changed",
    "The paired configuration paths or bytes changed; review them again before writing.",
  );
}

export function invalidConfigPath(message: string): never {
  throw new ConfigTransactionError("invalid", message);
}
