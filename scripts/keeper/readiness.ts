import type { KeeperReadiness } from "../../types/keeper-recovery";

/** Only specific provider evidence may establish signed-out or exhausted. */
export function keeperReadiness(input: {
  adapter: boolean;
  checked: boolean;
  connection?: "ready" | "signed-out" | "unknown";
  allowance?: "available" | "exhausted" | "unreported";
  source?: string;
  asOf?: string;
  reason?: string;
}): KeeperReadiness {
  const connection = !input.adapter
    ? "adapter-missing"
    : (input.connection ?? "unknown");
  const allowance = input.allowance ?? "unreported";
  return {
    connection,
    allowance,
    canStart:
      input.adapter &&
      input.checked &&
      connection !== "signed-out" &&
      allowance !== "exhausted",
    source: input.source ?? "Keeper adapter capability check",
    asOf: input.asOf ?? new Date().toISOString(),
    reason:
      input.reason ??
      (!input.adapter
        ? "No sealed read-only Keeper adapter is available for this provider. Choose a supported smith."
        : connection === "signed-out"
          ? "This provider reports that it is signed out. Sign in through its CLI, or explicitly choose another available smith."
          : allowance === "exhausted"
            ? "This provider reports that its allowance is exhausted. Wait for its reset or explicitly choose another available smith."
            : !input.checked
              ? "The Keeper adapter capability check could not be verified. Recheck before sending."
              : "The read-only Keeper adapter was checked. Sign-in and provider allowance are not reported; no exhaustion is inferred."),
  };
}
