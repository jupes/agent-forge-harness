import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationPage } from "../../types/conversation";

type Read = (
  id: string,
  query: { after: number; limit: number },
) => Promise<ConversationPage>;

/** Private body replay, separate from the metadata ledger feed. Observers never control jobs. */
export function createConversationFeed() {
  const clients = new Set<{ projectId: string; wake(): void; close(): void }>();
  return {
    changed(projectId: string) {
      for (const client of clients)
        if (client.projectId === projectId) client.wake();
    },
    close() {
      for (const client of [...clients]) client.close();
    },
    async open(
      projectId: string,
      after: number,
      read: Read,
      req: IncomingMessage,
      res: ServerResponse,
    ) {
      const initial = await read(projectId, { after, limit: 10 });
      if (after > initial.lastSequence)
        return {
          status: 409,
          error:
            "The saved conversation cursor is ahead of its retained history. Reload the conversation.",
        };
      if (res.destroyed) return undefined;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.write(": open\n\n");
      let cursor = after;
      let revision = -1;
      let ended = false;
      let busy = false;
      let again = false;
      let blocked = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        if (ended) return;
        ended = true;
        if (timer) clearTimeout(timer);
        clearInterval(poll);
        clients.delete(client);
        res.off("close", close);
        req.off("aborted", close);
        res.end();
      };
      const send = (page: ConversationPage) => {
        if (ended || res.destroyed) return;
        if (res.writableLength > 350_000) {
          close();
          return;
        }
        const changed = page.revision !== revision || page.frames.length > 0;
        revision = page.revision;
        cursor = page.nextCursor;
        if (changed)
          blocked = !res.write(
            `id: ${cursor}\nevent: conversation\ndata: ${JSON.stringify(page)}\n\n`,
          );
        else blocked = !res.write(": keepalive\n\n");
        if (page.more) again = true;
      };
      const pump = async () => {
        timer = undefined;
        if (ended || busy || blocked) {
          again = true;
          return;
        }
        busy = true;
        again = false;
        try {
          send(await read(projectId, { after: cursor, limit: 10 }));
        } catch {
          close();
        } finally {
          busy = false;
          if (again && !ended && !blocked) wake();
        }
      };
      const wake = () => {
        again = true;
        if (!ended && !busy && !blocked && !timer)
          timer = setTimeout(() => {
            void pump();
          }, 0);
      };
      const client = { projectId, close, wake };
      // Also observes a writer in another hearth; no provider activity is started by this read.
      const poll = setInterval(wake, 2_000);
      res.once("close", close);
      req.once("aborted", close);
      res.on("drain", () => {
        blocked = false;
        if (again) wake();
      });
      clients.add(client);
      send(initial);
      if (again && !blocked) wake();
      return undefined;
    },
  };
}
