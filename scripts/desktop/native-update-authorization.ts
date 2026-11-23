import { join, resolve } from "node:path";
import {
  nativeUpdateAuthorizationResultSchema,
  nativeUpdateAuthorizationSchema,
} from "../../types/native-update";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";

export { nativeUpdateAuthorizationSchema };
export type UpdateTicket = {
  home: string;
  folder: string;
  file: string;
  bytes: string;
};
function publishPrivate(ticket: UpdateTicket) {
  ensurePrivateHome(ticket.home);
  ensurePrivateHome(ticket.folder);
  writeOwnerOnly(ticket.file, ticket.bytes);
  const observed = readHomeFileBounded(ticket.folder, ticket.file, 8192);
  if (observed.problem || observed.text !== ticket.bytes)
    throw Error("authorization-unavailable");
}
/** Fixed private selectors and a confirmed common-runner audit id only. */
export function createNativeUpdateAuthorization(input: {
  root: string;
  home: string;
  now?: () => number;
  publish?: (ticket: UpdateTicket) => void;
}) {
  const root = resolve(input.root),
    home = resolve(input.home),
    folder = join(home, "update-authorizations");
  const publish = input.publish ?? publishPrivate,
    now = input.now ?? Date.now;
  return (raw: unknown, auditEventId?: number) => {
    try {
      const request = nativeUpdateAuthorizationSchema.parse(raw);
      if (
        !Number.isSafeInteger(auditEventId) ||
        !auditEventId ||
        auditEventId < 1
      )
        throw Error("Missing audit");
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0)
        throw Error("Clock unavailable");
      publish({
        home,
        folder,
        file: join(folder, request.operation + ".json"),
        bytes: JSON.stringify({
          schemaVersion: 1,
          ...request,
          root,
          home,
          auditEventId,
          createdAt,
        }),
      });
      return nativeUpdateAuthorizationResultSchema.parse({
        schemaVersion: 1,
        ...request,
        authorized: true,
      });
    } catch {
      throw Error("authorization-unavailable");
    }
  };
}
