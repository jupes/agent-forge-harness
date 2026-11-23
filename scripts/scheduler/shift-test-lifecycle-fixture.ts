/** Test-only ownership of the Shift cases' generated roots and ledger files. */
export interface ShiftTestCleanupPhase {
  phase: "ledger-close" | "root-remove";
  ordinal: number;
  elapsedMs: number;
  ok: boolean;
}

interface ShiftTestLifecycleDeps {
  closeLedger(path: string): void;
  removeRoot(path: string): void;
  report?(phase: ShiftTestCleanupPhase): void;
}

export function createShiftTestLifecycle(deps: ShiftTestLifecycleDeps) {
  const roots: string[] = [];
  const ledgers: string[] = [];
  return {
    root(path: string): void {
      roots.push(path);
    },
    ledger(path: string): void {
      ledgers.push(path);
    },
    cleanup(): { ledgers: number; roots: number } {
      // Consume the case's ownership before cleanup: even a failure cannot
      // carry resources into another case or make an operation run twice.
      const ownedLedgers = ledgers.splice(0);
      const ownedRoots = roots.splice(0);
      const failures: Error[] = [];
      const run = (
        phase: ShiftTestCleanupPhase["phase"],
        paths: string[],
        work: (path: string) => void,
      ) => {
        for (const [index, path] of paths.entries()) {
          const began = performance.now();
          let ok = false;
          try {
            work(path);
            ok = true;
          } catch (cause) {
            failures.push(
              Error(`Shift fixture ${phase} ${index + 1} failed.`, { cause }),
            );
          }
          try {
            deps.report?.({
              phase,
              ordinal: index + 1,
              elapsedMs: performance.now() - began,
              ok,
            });
          } catch (cause) {
            failures.push(
              Error(`Shift fixture ${phase} ${index + 1} reporting failed.`, {
                cause,
              }),
            );
          }
        }
      };
      run("ledger-close", ownedLedgers, deps.closeLedger);
      run("root-remove", ownedRoots, deps.removeRoot);
      if (failures.length)
        throw new AggregateError(failures, "Shift fixture teardown failed.");
      return { ledgers: ownedLedgers.length, roots: ownedRoots.length };
    },
  };
}
