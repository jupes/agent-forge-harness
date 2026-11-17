import { expect, test } from "bun:test";
import { readFixtureReady } from "./fixture-readiness.test-utils";

async function observe(chunks: Uint8Array[], close = true): Promise<void> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
  });
  const reader = stream.getReader();
  try {
    await readFixtureReady(reader);
  } finally {
    await reader.cancel();
  }
}
const bytes = (text: string) => new TextEncoder().encode(text);

test("fixture readiness accepts its exact marker", async () => {
  await expect(observe([bytes("fixture-ready\n")])).resolves.toBeUndefined();
});

test("fixture readiness accepts a marker split across bounded reads", async () => {
  await expect(
    observe([bytes("fix"), bytes("ture-"), bytes("ready\n")]),
  ).resolves.toBeUndefined();
});

test("fixture readiness rejects extra bytes after its exact marker", async () => {
  await expect(observe([bytes("fixture-ready\nextra")])).rejects.toThrow(
    "Fixture readiness refused",
  );
});

test("fixture readiness rejects a different marker", async () => {
  await expect(observe([bytes("foreign-ready\n")])).rejects.toThrow(
    "Fixture readiness refused",
  );
});

test("fixture readiness rejects an oversized chunk", async () => {
  await expect(observe([new Uint8Array(65)])).rejects.toThrow(
    "Fixture readiness refused",
  );
});

test("fixture readiness rejects EOF without a marker", async () => {
  await expect(observe([])).rejects.toThrow("Fixture readiness refused");
});

test("fixture readiness rejects a truncated marker", async () => {
  await expect(observe([bytes("fixture-ready")])).rejects.toThrow(
    "Fixture readiness refused",
  );
});

test("empty reads cannot evade the readiness work bound", async () => {
  await expect(
    observe(Array.from({ length: 65 }, () => new Uint8Array())),
  ).rejects.toThrow("Fixture readiness refused");
});

test("a silent stream reaches the fixed readiness deadline", async () => {
  await expect(observe([], false)).rejects.toThrow(
    "Fixture readiness deadline",
  );
}, 3000);
