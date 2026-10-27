const MAX_DIAGNOSTIC_BYTES = 512;

export type TransactionFixtureStage =
  | "none"
  | "child-started"
  | "transaction-prepared"
  | "transaction-entered"
  | "cli-started"
  | "unavailable";
export type TransactionFixtureChildState =
  | "running"
  | "exited-zero"
  | "exited-nonzero"
  | "unavailable";
export type TransactionFixtureStderr = "empty" | "nonempty" | "unavailable";

export interface TransactionFixtureFailureFacts {
  stage: TransactionFixtureStage;
  child: TransactionFixtureChildState;
  stderr: TransactionFixtureStderr;
}

const stages: readonly TransactionFixtureStage[] = [
  "none",
  "child-started",
  "transaction-prepared",
  "transaction-entered",
  "cli-started",
  "unavailable",
];
const childStates: readonly TransactionFixtureChildState[] = [
  "running",
  "exited-zero",
  "exited-nonzero",
  "unavailable",
];
const stderrStates: readonly TransactionFixtureStderr[] = [
  "empty",
  "nonempty",
  "unavailable",
];

/** Project only fixed categorical facts; fixture output and paths never enter diagnostics. */
export function summarizeTransactionFixtureFailure(
  facts: Partial<TransactionFixtureFailureFacts>,
): TransactionFixtureFailureFacts {
  return {
    stage: stages.includes(facts.stage as TransactionFixtureStage)
      ? (facts.stage as TransactionFixtureStage)
      : "unavailable",
    child: childStates.includes(facts.child as TransactionFixtureChildState)
      ? (facts.child as TransactionFixtureChildState)
      : "unavailable",
    stderr: stderrStates.includes(facts.stderr as TransactionFixtureStderr)
      ? (facts.stderr as TransactionFixtureStderr)
      : "unavailable",
  };
}

/** Best-effort failure facts, then rethrow the exact marker failure. */
export async function emitTransactionFixtureFailureFactsAndRethrow(
  error: unknown,
  collect: () => Promise<Partial<TransactionFixtureFailureFacts>>,
  write: (line: string) => unknown,
): Promise<never> {
  try {
    const facts = summarizeTransactionFixtureFailure(await collect());
    let line = JSON.stringify(facts);
    if (Buffer.byteLength(line, "utf8") > MAX_DIAGNOSTIC_BYTES)
      line = JSON.stringify({
        stage: "unavailable",
        child: "unavailable",
        stderr: "unavailable",
      });
    write(`[transaction-fixture-failure] ${line}\n`);
  } catch {
    // Diagnostics must not replace the marker failure or interrupt cleanup.
  }
  throw error;
}
