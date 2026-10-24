import { McpServer } from "@modelcontextprotocol/server";
import { type Exchange, loopbackExchange } from "../hearth/loopback";
import { isProjectId } from "../projects/store";
import {
  KEEPER_READ_SCHEMA,
  KEEPER_RESULT_SCHEMA,
  parseKeeperReadQuery,
} from "./protocol";

export function keeperReaderOrigin(value: string): {
  origin: string;
  port: number;
} {
  if (!/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(value))
    throw new Error("Keeper reads require a literal local hearth origin.");
  const url = new URL(value);
  const port = Number(url.port || 80);
  if (port < 1 || port > 65535) throw new Error("Invalid local hearth port.");
  return { origin: url.origin, port };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const toolAnswer = (data: unknown, error: string | null = null) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        ok: error === null,
        data: error === null ? data : null,
        error,
      }),
    },
  ],
  isError: error !== null,
});

/** The project and origin are fixed by the hearth, never accepted as model tool arguments. */
export function createKeeperReader(options: {
  origin: string;
  projectId: string;
  exchange?: Exchange;
  signal?: AbortSignal;
}) {
  const address = keeperReaderOrigin(options.origin);
  if (!isProjectId(options.projectId))
    throw new Error("Expected the Keeper's project id.");
  const exchange = options.exchange ?? loopbackExchange;
  const server = new McpServer({
    name: "agent-forge-keeper-reader",
    version: "0.1.0",
  });
  server.registerTool(
    "read_project",
    {
      title: "Read this project's sources",
      description:
        "Read only this Keeper's project. Beads without id returns an index; with id returns details. Queue, sessions, runs and activity provide recorded metadata. Follow nextCursor for more records; check completeness, limits and read time. This tool has no commands, arbitrary paths or actions.",
      inputSchema: KEEPER_READ_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const query = parseKeeperReadQuery(input);
        const params = new URLSearchParams({ kind: query.kind });
        if (query.id !== undefined) params.set("id", query.id);
        if (query.after !== undefined) params.set("after", String(query.after));
        if (query.limit !== undefined) params.set("limit", String(query.limit));
        const response = await exchange({
          port: address.port,
          method: "GET",
          target: `/__agent-forge/projects/${options.projectId}/keeper/read?${params}`,
          headers: { Origin: address.origin },
          timeoutMs: 20_000,
          maxBytes: 65_536,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (
          response.status !== 200 ||
          Buffer.byteLength(response.body) > 60_000
        )
          return toolAnswer(
            null,
            "The project read is unavailable. Continue with an explicitly incomplete answer.",
          );
        let raw: unknown;
        try {
          raw = JSON.parse(response.body);
        } catch {
          return toolAnswer(
            null,
            "The project reader returned an invalid response.",
          );
        }
        if (!record(raw) || raw["ok"] !== true || raw["error"] !== null)
          return toolAnswer(
            null,
            "The project reader did not confirm its result.",
          );
        const parsed = KEEPER_RESULT_SCHEMA.safeParse(raw["data"]);
        if (
          !parsed.success ||
          parsed.data.scope.projectId !== options.projectId ||
          parsed.data.kind !== query.kind ||
          parsed.data.mode !== (query.id ? "detail" : "index") ||
          (query.id !== undefined &&
            parsed.data.records.some((item) => item.id !== query.id))
        )
          return toolAnswer(
            null,
            "The project reader returned an invalid or different scope.",
          );
        return toolAnswer(parsed.data);
      } catch {
        return toolAnswer(
          null,
          "The project read could not be completed. Continue with an explicitly incomplete answer.",
        );
      }
    },
  );
  return server;
}
