import { afterEach, describe, expect, test } from "bun:test";
import type {
  BeadWriteResult,
  LedgerEvent,
  OperatorEnvelope,
} from "../../../types/hearth";
import { hashText } from "../../hash-text";
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "../testing";
import { validateOperatorEnvelope } from "../validate";

/**
 * The Beads write rows, through a hermetic hearth: a request goes in over
 * HTTP, and what is checked is the answer, the argument arrays `bd` was given
 * and what the ledger holds. `bd` here is the recorder of `../testing`; nothing
 * reaches a tracker.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(options: TestHearthOptions = {}): Promise<TestHearth> {
  const hearth = await startTestHearth(options);
  open.push(hearth);
  return hearth;
}

interface Answer<T> {
  status: number;
  body: OperatorEnvelope<T>;
}

async function post<T = BeadWriteResult>(
  h: TestHearth,
  path: string,
  body: unknown,
): Promise<Answer<T>> {
  const response = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  const checked = validateOperatorEnvelope(parsed);
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return {
    status: response.status,
    body: checked.value as OperatorEnvelope<T>,
  };
}

/** What the ledger holds, reduced to what these tests compare. */
function recorded(
  h: TestHearth,
): Array<Pick<LedgerEvent, "kind" | "beadId" | "payload">> {
  return h.events().map((event) => ({
    kind: event.kind,
    ...(event.beadId !== undefined ? { beadId: event.beadId } : {}),
    payload: event.payload,
  })) as Array<Pick<LedgerEvent, "kind" | "beadId" | "payload">>;
}

describe("POST /beads", () => {
  test("with a parent and a priority: 201 with the id bd printed, one bd call, the audit row and then bead.transitioned for the new bead", async () => {
    const h = await start();

    const answer = await post(h, "/beads", {
      title: "Wire the lantern",
      type: "feature",
      priority: "P1",
      parent: "demo-epic",
      description: "Two lines\nof context",
      acceptance: "- [ ] it lights\n- [ ] it stays lit",
    });

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({
      ok: true,
      data: {
        id: "demo-epic.1",
        action: "create",
        status: "open",
        recorded: true,
      },
      error: null,
    });
    expect(h.bd.calls).toEqual([
      [
        "create",
        "--title=Wire the lantern",
        "--type=feature",
        "--priority=1",
        "--parent=demo-epic",
        "--description=Two lines\nof context",
        "--acceptance=- [ ] it lights\n- [ ] it stays lit",
        "--json",
      ],
    ]);
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-epic",
        payload: { action: "bead.create", surface: "api", target: "demo-epic" },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-epic.1",
        payload: {
          action: "create",
          hash: hashText("Wire the lantern"),
          length: 16,
        },
      },
    ]);
  });
});
