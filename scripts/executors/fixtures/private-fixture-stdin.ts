/** Read this fixture's planted bytes and require the writer to close its pipe. */
export async function readPrivateFixtureStdin(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const expected = Buffer.from("  exact private prompt\nsecond line  ");
  const received = Buffer.alloc(expected.length);
  const reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.length > received.length - offset) throw Error();
      received.set(part.value, offset);
      offset += part.value.length;
    }
    if (offset !== expected.length || !received.equals(expected)) throw Error();
    return received.toString("utf8");
  } catch {
    throw Error("Invalid private fixture stdin.");
  } finally {
    reader.releaseLock();
  }
}
