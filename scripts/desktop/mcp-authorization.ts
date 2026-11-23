import { join, resolve } from "node:path";
import { z } from "zod";
import {
  integrationAuthorizationSchema,
  integrationClientSchema,
} from "../../types/app-integrations";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
export const integrationAuthorizationRequestSchema = z
  .object({ client: integrationClientSchema, requestId: z.string().uuid() })
  .strict();
type PrivateTicket = {
  home: string;
  folder: string;
  file: string;
  bytes: string;
};
function publishPrivate(ticket: PrivateTicket) {
  ensurePrivateHome(ticket.home);
  ensurePrivateHome(ticket.folder);
  writeOwnerOnly(ticket.file, ticket.bytes);
  const observed = readHomeFileBounded(ticket.folder, ticket.file, 8192);
  if (observed.problem || observed.text !== ticket.bytes)
    throw Error("authorization-unavailable");
}
/** Only trusted host selectors and a confirmed common-runner audit row enter here. */
export function createIntegrationAuthorization(input: {
  root: string;
  home: string;
  now?: () => number;
  publish?: (record: PrivateTicket) => void;
}) {
  const root = resolve(input.root),
    home = resolve(input.home),
    folder = join(home, "mcp-authorizations");
  const publish = input.publish ?? publishPrivate,
    now = input.now ?? Date.now;
  return (raw: unknown, auditEventId?: number) => {
    try {
      const request = integrationAuthorizationRequestSchema.parse(raw);
      if (
        !Number.isSafeInteger(auditEventId) ||
        !auditEventId ||
        auditEventId < 1
      )
        throw Error("Missing audit");
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0)
        throw Error("Clock unavailable");
      const record = {
        schemaVersion: 1,
        ...request,
        root,
        home,
        auditEventId,
        createdAt,
      };
      publish({
        home,
        folder,
        file: join(folder, request.client + ".json"),
        bytes: JSON.stringify(record),
      });
      return integrationAuthorizationSchema.parse({
        schemaVersion: 1,
        ...request,
        authorized: true,
      });
    } catch {
      throw Error("authorization-unavailable");
    }
  };
}
