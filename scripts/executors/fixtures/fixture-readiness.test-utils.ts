const READY = new TextEncoder().encode("fixture-ready\n");

export async function readFixtureReady(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        let bytes = 0;
        for (let reads = 0; reads < 64; reads++) {
          const next = await reader.read();
          if (next.done || bytes + next.value.byteLength > 64)
            throw Error("Fixture readiness refused");
          for (const byte of next.value) {
            if (byte !== READY[bytes++])
              throw Error("Fixture readiness refused");
          }
          if (bytes === READY.byteLength) return;
        }
        throw Error("Fixture readiness refused");
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(Error("Fixture readiness deadline")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
