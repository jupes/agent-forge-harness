import { describe, expect, test } from "bun:test";
import { actionOutcome } from "../../docs/js/action-outcome";
import { createOperatorClient, NotSent } from "../../docs/js/operator";
import { TOKEN_ROUTE } from "../hearth/paths";

const CHECK = "The run may have started: look for it in the runs list.";

/** `promise`, or a failure after 2 s of real time: a regression fails instead of hanging the runner. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`${what} did not settle within 2000 ms`)),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const envelope = (status: number, body: unknown): Response =>
  Response.json(body, { status });

describe("actionOutcome", () => {
  test("an ok envelope is done, with its data", async () => {
    expect(
      await actionOutcome(
        async () =>
          envelope(202, { ok: true, data: { runId: "r" }, error: null }),
        CHECK,
      ),
    ).toEqual({ state: "done", data: { runId: "r" } });
  });

  test("a refusal in the control plane's words is refused: nothing was changed", async () => {
    expect(
      await actionOutcome(
        async () =>
          envelope(409, { ok: false, data: null, error: "Already running" }),
        CHECK,
      ),
    ).toEqual({ state: "refused", message: "Already running" });
  });

  test("no operator token (NotSent) is refused: nothing left the page", async () => {
    const outcome = await actionOutcome(async () => {
      throw new NotSent("no session");
    }, CHECK);
    expect(outcome.state).toBe("refused");
    expect(outcome).toHaveProperty(
      "message",
      expect.stringContaining("Nothing was changed."),
    );
  });

  test.each([
    [
      "a deadline that passed",
      new Error("The control plane did not answer within 45 s."),
    ],
    ["a dropped connection", new TypeError("Failed to fetch")],
  ])("a sent request that fails with %s may have been acted on, and says how to check", async (_, error) => {
    const outcome = await actionOutcome(async () => {
      throw error;
    }, CHECK);
    expect(outcome.state).toBe("unknown");
    expect(outcome).toHaveProperty("message", expect.stringContaining(CHECK));
    expect(outcome).toHaveProperty(
      "message",
      expect.stringContaining(error.message.replace(/\.$/, "")),
    );
  });

  test("a 504, an answer that is not the envelope, and an ok status without ok: true are not known either", async () => {
    for (const response of [
      envelope(504, { ok: false, data: null, error: "bd did not finish" }),
      new Response("<html>Bad gateway</html>", { status: 502 }),
      envelope(200, { ok: false, data: null, error: null }),
    ]) {
      const outcome = await actionOutcome(async () => response, CHECK);
      expect(outcome.state).toBe("unknown");
      expect(outcome).toHaveProperty("message", expect.stringContaining(CHECK));
    }
  });

  test("a post through the operator client that outlives its deadline is not known, never refused", async () => {
    let expire = () => {};
    let reached = () => {};
    const sent = new Promise<void>((done) => {
      reached = done;
    });
    const client = createOperatorClient(
      async (url) => {
        if (url === TOKEN_ROUTE)
          return Response.json({ ok: true, data: { token: "t" }, error: null });
        reached();
        return new Promise<Response>(() => {});
      },
      {
        timers: {
          set(run) {
            expire = run;
            return 1;
          },
          clear() {},
        },
      },
    );
    const pending = actionOutcome(() => client.post("/runs", {}), CHECK);
    await within(sent, "the post");
    await Promise.resolve();
    expire();
    const outcome = await within(pending, "the outcome");
    expect(outcome.state).toBe("unknown");
    expect(outcome).toHaveProperty(
      "message",
      `The request did not complete: The control plane did not answer within 45 s. ${CHECK}`,
    );
  });
});
