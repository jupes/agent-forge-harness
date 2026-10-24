/** Closed oracle: startup/execution latency is separate from private finalization. */
await Bun.sleep(1100);
await import("./fake-cli");

export {};
