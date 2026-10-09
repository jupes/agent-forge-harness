/**
 * The one stdin reader every hook shares, driven with constructed streams.
 *
 * The real-stdin path (a pipe from a parent process) is exercised by the
 * spawned-hook suites: `ledger/hooks.test.ts` and `quality-gate-hook.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  type HookStdinSource,
  parseHookInput,
  readHookInput,
  readHookStdin,
} from "../.claude/hooks/utils/hook-input";

const encoder = new TextEncoder();

/** A pipe that delivers `chunks` and then closes — or, with `open`, never does. */
function piped(
  chunks: readonly string[],
  opts: { open?: boolean } = {},
): HookStdinSource & { opened: number } {
  const source = {
    isTTY: false,
    opened: 0,
    stream(): ReadableStream<Uint8Array> {
      source.opened += 1;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (!opts.open) controller.close();
        },
      });
    },
  };
  return source;
}

describe("readHookStdin", () => {
  test("a piped JSON object is the payload, even when it arrives in pieces", async () => {
    const read = await readHookStdin({
      source: piped(['{"hook_event_name":"Teamm', 'ateIdle","team_name":"t"}']),
    });
    expect(read).toEqual({
      kind: "payload",
      input: { hook_event_name: "TeammateIdle", team_name: "t" },
    });
  });

  test("a terminal is never read: a run by hand does not wait", async () => {
    let opened = 0;
    const terminal: HookStdinSource = {
      isTTY: true,
      stream: () => {
        opened += 1;
        return piped(["{}"], { open: true }).stream();
      },
    };
    const started = performance.now();
    const read = await readHookStdin({ source: terminal, waitMs: 5_000 });
    expect(read).toEqual({ kind: "none", reason: "terminal" });
    expect(opened).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("empty and whitespace-only piped input is no payload, not an error", async () => {
    expect(await readHookStdin({ source: piped([]) })).toEqual({
      kind: "none",
      reason: "empty",
    });
    expect(await readHookStdin({ source: piped(["  \r\n"]) })).toEqual({
      kind: "none",
      reason: "empty",
    });
  });

  test("a pipe that never closes and sends nothing is given up on after the wait", async () => {
    const started = performance.now();
    const read = await readHookStdin({
      source: piped([], { open: true }),
      waitMs: 60,
    });
    const elapsed = performance.now() - started;
    expect(read).toEqual({ kind: "none", reason: "silent" });
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a pipe that never closes still yields a complete object it already sent", async () => {
    const read = await readHookStdin({
      source: piped(['{"hook_event_name":"TaskCompleted"}'], { open: true }),
      waitMs: 60,
    });
    expect(read).toEqual({
      kind: "payload",
      input: { hook_event_name: "TaskCompleted" },
    });
  });

  test("malformed piped input is reported as malformed, with the reason", async () => {
    expect(await readHookStdin({ source: piped(["{ not json"]) })).toEqual({
      kind: "malformed",
      error: "stdin is not valid JSON",
    });
    for (const notObject of ["[1,2]", '"text"', "7", "null"]) {
      expect(await readHookStdin({ source: piped([notObject]) })).toEqual({
        kind: "malformed",
        error: "stdin is not a JSON object",
      });
    }
    const cutOff = await readHookStdin({
      source: piped(['{"hook_event_name":"TaskComp'], { open: true }),
      waitMs: 60,
    });
    expect(cutOff).toEqual({
      kind: "malformed",
      error: "stdin did not close within 60 ms and held incomplete JSON",
    });
  });

  test("input over the size bound is refused without being parsed", async () => {
    const big = `{"pad":"${"x".repeat(4_096)}"}`;
    const read = await readHookStdin({ source: piped([big]), maxBytes: 1_024 });
    expect(read).toEqual({
      kind: "malformed",
      error: "stdin is larger than 1024 bytes",
    });
    // An endless writer is cut off at the bound rather than read forever.
    let sent = 0;
    const endless: HookStdinSource = {
      isTTY: false,
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            controller.enqueue(encoder.encode("x".repeat(512)));
          },
        }),
    };
    expect(
      await readHookStdin({ source: endless, maxBytes: 2_048, waitMs: 5_000 }),
    ).toEqual({ kind: "malformed", error: "stdin is larger than 2048 bytes" });
    expect(sent).toBeLessThan(64);
  });
});

describe("readHookInput (what the session and ledger hooks call)", () => {
  test("still never throws and reads anything unusable as no input", async () => {
    expect(await readHookInput({ source: piped(['{"a":1}']) })).toEqual({
      a: 1,
    });
    for (const source of [
      piped(["{ not json"]),
      piped(["[]"]),
      piped([]),
      piped([], { open: true }),
      { ...piped(["{}"]), isTTY: true },
    ]) {
      expect(await readHookInput({ source, waitMs: 40 })).toBeNull();
    }
    const broken: HookStdinSource = {
      isTTY: false,
      stream: () => {
        throw new Error("no stdin");
      },
    };
    expect(await readHookInput({ source: broken })).toBeNull();
  });
});

describe("the size bound belongs to the caller", () => {
  test("with none given, a payload over a megabyte is still read whole", async () => {
    // A PostToolUse payload carries the tool's output, which can be large.
    const big = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: "x".repeat(1_500_000),
    });
    const input = await readHookInput({ source: piped([big]) });
    expect(input?.tool_name).toBe("Read");
    expect(String(input?.tool_response).length).toBe(1_500_000);
    const read = await readHookStdin({ source: piped([big]) });
    expect(read.kind).toBe("payload");
  });
});

describe("parseHookInput", () => {
  test("is the object in the text, or null", () => {
    expect(parseHookInput('{"session_id":"S"}')).toEqual({ session_id: "S" });
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("nope")).toBeNull();
    expect(parseHookInput("[]")).toBeNull();
  });
});
