import { z } from "zod";
import type { OperatorRead } from "../../../docs/js/operator";
import { projectCreateOptionsSchema } from "../../../scripts/projects/create-options-protocol";
import {
  projectCreateDiscoverySchema,
  projectCreateIdentitySchema,
} from "../../../scripts/projects/create-protocol";

const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const optionsBytes = { maxBodyBytes: 1_048_576 };
const identityBytes = { maxBodyBytes: 524_288 };
const identityPath = "/__agent-forge/projects/create-reservations";

async function checkedData<T>(
  read: OperatorRead,
  path: string,
  limit: { maxBodyBytes: number },
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await read(path, { method: "GET" }, limit);
  if (response.status !== 200)
    throw Error("Saved project creation details could not be verified.");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw Error("Saved project creation details could not be verified.");
  }
  const checkedEnvelope = envelope.safeParse(raw);
  const checked = schema.safeParse(
    checkedEnvelope.success ? checkedEnvelope.data.data : null,
  );
  if (!checked.success)
    throw Error("Saved project creation details could not be verified.");
  return checked.data;
}

/** Browser-safe, read-only access to the protected project-create producer. */
export function createProjectCreateApi(read: OperatorRead) {
  return {
    options: () =>
      checkedData(
        read,
        "/__agent-forge/projects/create-options",
        optionsBytes,
        projectCreateOptionsSchema,
      ),
    discovery: () =>
      checkedData(
        read,
        identityPath,
        identityBytes,
        projectCreateDiscoverySchema,
      ),
    original: (requestId: string) =>
      checkedData(
        read,
        `${identityPath}/${encodeURIComponent(requestId)}`,
        identityBytes,
        projectCreateIdentitySchema,
      ),
  };
}
