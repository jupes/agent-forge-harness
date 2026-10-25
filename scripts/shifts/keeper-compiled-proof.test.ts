import { expect, test } from "bun:test";
import { keeperStartFailureDiagnostic } from "./keeper-compiled-proof";

test("Keeper compiled proof reports only a strict bounded public refusal error", async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      data: null,
      error: "The original Shift review could not be verified.",
    }),
    { status: 503 },
  );
  expect(await keeperStartFailureDiagnostic(response)).toBe(
    'status=503; refusal="The original Shift review could not be verified."',
  );
});

test("Keeper compiled proof hides malformed, oversized and nonstandard refusal bodies", async () => {
  const malformed = new Response(
      JSON.stringify({ ok: false, data: null, error: "bad", extra: "private" }),
      { status: 400 },
    ),
    tooLong = new Response(
      JSON.stringify({ ok: false, data: null, error: "x".repeat(513) }),
      { status: 409 },
    );
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 503 },
  );
  expect(await keeperStartFailureDiagnostic(malformed)).toBe(
    "status=400; refusal=malformed",
  );
  expect(await keeperStartFailureDiagnostic(tooLong)).toBe(
    "status=409; refusal=malformed",
  );
  expect(await keeperStartFailureDiagnostic(oversized)).toBe(
    "status=503; refusal=oversized",
  );
  expect(cancelled).toBe(true);
});
