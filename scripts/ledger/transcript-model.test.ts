import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  modelFromTranscriptTail,
  readTail,
  TRANSCRIPT_TAIL_BYTES,
} from "./transcript-model";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: readonly unknown[], raw: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript test "));
  temporary.push(dir);
  const file = join(dir, "session.jsonl");
  const body = [...lines.map((line) => JSON.stringify(line)), ...raw];
  writeFileSync(file, `${body.join("\n")}\n`);
  return file;
}

function assistant(model: string, effort?: unknown): Record<string, unknown> {
  return {
    type: "assistant",
    isSidechain: false,
    ...(effort !== undefined ? { effort } : {}),
    message: { role: "assistant", model, content: [] },
  };
}

describe("modelFromTranscriptTail", () => {
  test("the last assistant record's model and effort are returned", () => {
    const file = transcript([
      { type: "user", message: { role: "user", content: "hello" } },
      assistant("model-old", "low"),
      { type: "user", message: { role: "user", content: "again" } },
      assistant("model-new", "high"),
      { type: "last-prompt" },
    ]);
    expect(modelFromTranscriptTail(file)).toEqual({
      model: "model-new",
      effort: "high",
    });
  });

  test("an effort written as an object is read as its level, and an absent effort is left out", () => {
    expect(
      modelFromTranscriptTail(
        transcript([assistant("model-a", { level: "xhigh" })]),
      ),
    ).toEqual({ model: "model-a", effort: "xhigh" });
    const bare = modelFromTranscriptTail(transcript([assistant("model-a")]));
    expect(bare).toEqual({ model: "model-a" });
    expect(bare !== null && "effort" in bare).toBe(false);
  });

  test("a transcript with no assistant record yields nothing", () => {
    const file = transcript([
      { type: "queue-operation" },
      { type: "user", message: { role: "user", content: "hello" } },
    ]);
    expect(modelFromTranscriptTail(file)).toBeNull();
  });

  test("a placeholder model and a sidechain record are skipped", () => {
    const file = transcript([
      assistant("model-real", "medium"),
      { ...assistant("model-side"), isSidechain: true },
      assistant("<synthetic>"),
    ]);
    expect(modelFromTranscriptTail(file)).toEqual({
      model: "model-real",
      effort: "medium",
    });
  });

  test("a missing file, a cut first line and non-JSON lines are tolerated", () => {
    expect(
      modelFromTranscriptTail(join(tmpdir(), "no such transcript.jsonl")),
    ).toBeNull();

    const noisy = transcript(
      [assistant("model-kept")],
      ["not json at all", '{"type":"assistant","message":{"model":'],
    );
    expect(modelFromTranscriptTail(noisy)).toEqual({ model: "model-kept" });

    // A tail that starts in the middle of a record: the cut record is dropped
    // even though what is left of it would parse on its own.
    const cut = modelFromTranscriptTail("ignored", {
      read: () => ({
        text: `${JSON.stringify(assistant("model-cut"))}\n${JSON.stringify({ type: "user" })}\n`,
        fromStart: false,
      }),
    });
    expect(cut).toBeNull();
  });

  test("only the tail of a large transcript is read", () => {
    const filler = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(1000) },
    });
    const lines: string[] = [JSON.stringify(assistant("model-early", "low"))];
    while (lines.length * (filler.length + 1) < 5 * 1024 * 1024)
      lines.push(filler);
    lines.push(JSON.stringify(assistant("model-late", "high")));
    lines.push(filler);
    const file = transcript([], lines);

    const sizes: number[] = [];
    const result = modelFromTranscriptTail(file, {
      read: (path, maxBytes) => {
        const tail = readTail(path, maxBytes);
        if (tail !== null) sizes.push(Buffer.byteLength(tail.text, "utf8"));
        return tail;
      },
    });
    expect(result).toEqual({ model: "model-late", effort: "high" });
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThanOrEqual(TRANSCRIPT_TAIL_BYTES);
    expect(sizes[0]).toBeGreaterThan(0);
    expect(readTail(file, TRANSCRIPT_TAIL_BYTES)?.fromStart).toBe(false);
  });
});
