import {
  type HearthReadOptions,
  REAL_TIMERS,
  type Timers,
} from "../../../docs/js/hearth-read";
import { type OperatorRead, operatorRead } from "../../../docs/js/operator";
import {
  pageReads,
  readOperatorRoute,
  type StreamTransport,
} from "../../../docs/js/use-stream";
import { ownedCodingPageSchema } from "../../../scripts/sessions/codex-owned-journal";

/** Keep the ordinary API envelope, status, body bound and cancellation boundary. */
export function readSessionWindowPage(
  path: string,
  signal: AbortSignal,
  read: OperatorRead = operatorRead,
  environment: Pick<HearthReadOptions, "staticCopy"> = pageReads(),
): Promise<unknown> {
  return readOperatorRoute(path, {
    ...environment,
    fetch: async (input, init) => {
      const response = await read(
        input,
        {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        },
        { maxBodyBytes: 8 * 1024 * 1024 },
      );
      if (!response.ok) throw Error("Private session page unavailable");
      return response;
    },
  });
}

/** Compact views release HTTP/1 connection slots between protected page reads.
 * Actual served pages still pass the ordinary session client's replay checks.
 */
export function sessionWindowFeed(options: {
  projectId: string;
  sessionId: string;
  read(after: number, signal: AbortSignal): Promise<unknown>;
  timers?: Timers;
}): StreamTransport {
  const timers = options.timers ?? REAL_TIMERS;
  return (lastEventId, handlers) => {
    const controller = new AbortController();
    let closed = false,
      opened = false,
      cursor = lastEventId ?? 0,
      revision = -1,
      timer: unknown = null;
    const close = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      if (timer !== null) timers.clear(timer);
      timer = null;
    };
    const fail = () => {
      if (closed) return;
      close();
      handlers.onEnd("failed");
    };
    const poll = async () => {
      timer = null;
      try {
        for (let count = 0; count < 200 && !closed; count++) {
          const raw = await options.read(cursor, controller.signal);
          if (closed) return;
          const parsed = ownedCodingPageSchema.safeParse(raw);
          if (!parsed.success) throw Error("Unverified session page");
          const page = parsed.data;
          if (
            page.projectId !== options.projectId ||
            page.conversationId !== options.sessionId ||
            page.revision < revision ||
            page.nextCursor < cursor ||
            page.nextCursor > page.lastSequence ||
            page.more !== page.nextCursor < page.lastSequence ||
            (page.more && page.nextCursor === cursor)
          )
            throw Error("Unverified session cursor");
          revision = page.revision;
          cursor = page.nextCursor;
          if (!opened) {
            opened = true;
            handlers.onOpen();
          }
          if (closed) return;
          handlers.onActivity();
          if (closed) return;
          handlers.onMessage({
            event: "conversation",
            id: String(cursor),
            data: JSON.stringify(page),
          });
          if (closed) return;
          if (!page.more) {
            timer = timers.set(() => void poll(), 1000);
            return;
          }
        }
        if (!closed) throw Error("Session page limit reached");
      } catch {
        fail();
      }
    };
    void poll();
    return { close };
  };
}
