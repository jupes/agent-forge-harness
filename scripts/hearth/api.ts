/**
 * The operator API's route table and the one runner that serves it.
 *
 * A row says what a route is: method, path, how its request is validated and
 * what it does. Everything a route must not be trusted to remember — the
 * same-origin check, the operator token, the request body, the audit row and
 * the `{ ok, data, error }` envelope — is done here, for every row, so a route
 * added later gets all of it by being in the table.
 *
 * Order for an action (a POST): same-origin, token, body, validation, the
 * `operator.action` append, and only then the effect. A request refused before
 * the append has written nothing; an append that did not store a row stops the
 * action there.
 */

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  type LedgerEventInput,
  OPERATOR_SURFACES,
  type OperatorEnvelope,
  type OperatorSurface,
} from "../../types/hearth";
import type { AppendResult } from "../ledger/append";
import { redactSecrets } from "../secret-patterns";
import { isDeclaredSameOrigin } from "./gate";
import { API_PREFIX, OPERATOR_HEADER, SURFACE_HEADER } from "./paths";
import { tokenMatches } from "./token";
import type { ValidationResult } from "./validate";

/** What a row's validator is given. `body` is the parsed JSON of a POST, else undefined. */
export interface RouteRequest {
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** What a row answers; the runner turns it into the envelope. */
export type RouteReply =
  | { status: number; data: unknown }
  | { status: number; error: string };

interface RouteCommon<Input> {
  /** Relative to `/__agent-forge`; a `:name` segment is a parameter. */
  path: string;
  validate(request: RouteRequest): ValidationResult<Input>;
}

/** A GET that answers data. */
export interface ReadRoute<Input = unknown> extends RouteCommon<Input> {
  kind: "read";
  method: "GET";
  /** Set on a row whose answer, with no parameters, is one of the stream snapshot's collections. */
  collection?: string;
  read(input: Input): RouteReply | Promise<RouteReply>;
}

/** A GET that takes over the response (server-sent events). */
export interface StreamRoute<Input = unknown> extends RouteCommon<Input> {
  kind: "stream";
  method: "GET";
  /** Start streaming, or answer a refusal for the runner to send. */
  open(
    input: Input,
    req: IncomingMessage,
    res: ServerResponse,
  ): RouteReply | undefined | Promise<RouteReply | undefined>;
}

/** What an action is about, for its audit row. */
export interface ActionSubject {
  target?: string;
  beadId?: string;
}

/** A POST that changes something. */
export interface ActionRoute<Input = unknown> extends RouteCommon<Input> {
  kind: "action";
  method: "POST";
  /** The `operator.action` payload's `action`, e.g. `council.run.start`. */
  action: string;
  /** Largest request body accepted; defaults to 16 kB. */
  maxBodyBytes?: number;
  subject(input: Input): ActionSubject;
  effect(input: Input): RouteReply | Promise<RouteReply>;
}

export type ApiRoute = ReadRoute | StreamRoute | ActionRoute;

export interface OperatorApiDeps {
  /** The workspace audit rows are recorded under. */
  workspace: string;
  /** The token a mutation must present, or null while none can be honoured. */
  expectedToken(): string | null;
  /** The ledger's `appendEvent`, bound to this hearth's ledger. */
  appendEvent(event: LedgerEventInput): AppendResult;
}

export interface OperatorApi {
  /** The mounted table. */
  routes: readonly ApiRoute[];
  /** Serve the request if a row matches its path and method; otherwise call `next`. */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void>;
  /** The methods the table serves at this path; empty when it serves none. */
  allowedMethods(pathname: string): string[];
}

const DEFAULT_BODY_BYTES = 16_000;
/** A busy ledger is tried this many times, this far apart, before the action is refused. */
const AUDIT_ATTEMPTS = 3;
const AUDIT_RETRY_MS = 25;

/**
 * Headers a decision rests on. Sent twice, `node:http` under Bun reports only
 * the last value, so a repeat is refused rather than resolved.
 */
const SINGLE_HEADERS = new Set([
  OPERATOR_HEADER,
  SURFACE_HEADER,
  "origin",
  "sec-fetch-site",
  "host",
]);

/** An error message safe to send: secrets redacted, bounded. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text).text.slice(0, 500);
}

function send(res: ServerResponse, reply: RouteReply): void {
  const envelope: OperatorEnvelope =
    "error" in reply
      ? { ok: false, data: null, error: reply.error }
      : { ok: true, data: reply.data, error: null };
  res.statusCode = reply.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(envelope));
}

const refuse = (status: number, error: string): RouteReply => ({
  status,
  error,
});

interface Compiled {
  route: ApiRoute;
  segments: string[];
}

/** A matched request before anything in it has been trusted: parameters still percent-encoded. */
interface PendingRequest {
  params: Record<string, string>;
  query: URLSearchParams;
}

function compile(route: ApiRoute): Compiled {
  return { route, segments: route.path.split("/").slice(1) };
}

/** The row's parameters, still percent-encoded, when the path has its shape. */
function match(
  compiled: Compiled,
  segments: readonly string[],
): Record<string, string> | null {
  if (compiled.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const pattern = compiled.segments[i] ?? "";
    const actual = segments[i] ?? "";
    if (pattern.startsWith(":")) {
      if (actual.length === 0) return null;
      params[pattern.slice(1)] = actual;
    } else if (pattern !== actual) return null;
  }
  return params;
}

function decode(
  params: Record<string, string>,
): ValidationResult<Record<string, string>> {
  const decoded: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    try {
      decoded[name] = decodeURIComponent(value);
    } catch {
      return { ok: false, error: `${name}: not a valid path segment` };
    }
  }
  return { ok: true, value: decoded };
}

/** The path's segments below the API prefix, or null when the path is not under it. */
function relativeSegments(pathname: string): string[] | null {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return null;
  return pathname.slice(API_PREFIX.length).split("/").slice(1);
}

function repeatsSingleHeader(req: IncomingMessage): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] ?? "").toLowerCase();
    if (!SINGLE_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function declaredSurface(
  req: IncomingMessage,
): ValidationResult<OperatorSurface> {
  const declared = req.headers[SURFACE_HEADER];
  if (declared === undefined) return { ok: true, value: "api" };
  const known = OPERATOR_SURFACES.find((surface) => surface === declared);
  return known !== undefined
    ? { ok: true, value: known }
    : {
        ok: false,
        error: `${SURFACE_HEADER}: expected one of ${OPERATOR_SURFACES.join(" | ")}`,
      };
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ValidationResult<unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    return { ok: false, error: "Use application/json" };
  const tooLarge = `Request body exceeds ${maxBytes} bytes`;
  if (Number(req.headers["content-length"] ?? 0) > maxBytes)
    return { ok: false, error: tooLarge };
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    // Past the cap the rest is read and dropped, not abandoned: under Bun,
    // leaving this loop early makes the runtime end the response itself (an
    // empty 200), and the refusal below would never be sent.
    if (over) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      over = true;
      chunks.length = 0;
    } else chunks.push(buffer);
  }
  if (over) return { ok: false, error: tooLarge };
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { ok: true, value };
  } catch {
    return { ok: false, error: "Request body must be valid JSON" };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export function createOperatorApi(
  deps: OperatorApiDeps,
  routes: readonly ApiRoute[],
): OperatorApi {
  const table = routes.map(compile);

  function candidates(
    pathname: string,
  ): Array<{ compiled: Compiled; params: Record<string, string> }> {
    const segments = relativeSegments(pathname);
    if (segments === null) return [];
    return table.flatMap((compiled) => {
      const params = match(compiled, segments);
      return params === null ? [] : [{ compiled, params }];
    });
  }

  /**
   * Store the audit row. Null when the ledger returned the row's id; otherwise
   * why it did not: a refusal, a duplicate (nothing stored) or a throw.
   */
  async function audited(event: LedgerEventInput): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      // The appender is trusted for nothing but a row id: whatever else it
      // answers, or throws, the action stops here.
      let result: unknown;
      try {
        result = deps.appendEvent(event);
      } catch (error) {
        return safeMessage(error);
      }
      if (typeof result !== "object" || result === null)
        return "the ledger did not answer";
      const { ok, id, error } = result as {
        ok?: unknown;
        id?: unknown;
        error?: unknown;
      };
      // A row id is a positive whole number; nothing else counts as stored.
      if (ok === true)
        return typeof id === "number" && Number.isSafeInteger(id) && id > 0
          ? null
          : "the ledger stored no row";
      const reason = typeof error === "string" ? error : "the ledger refused";
      const busy = /busy|locked/i.test(reason);
      if (!busy || attempt >= AUDIT_ATTEMPTS) return safeMessage(reason);
      await sleep(AUDIT_RETRY_MS);
    }
  }

  async function act(
    route: ActionRoute,
    pending: PendingRequest,
    req: IncomingMessage,
  ): Promise<RouteReply> {
    if (!tokenMatches(deps.expectedToken(), req.headers[OPERATOR_HEADER]))
      return refuse(
        403,
        "This action needs the operator token of this control plane",
      );
    const surface = declaredSurface(req);
    if (!surface.ok) return refuse(400, surface.error);
    const params = decode(pending.params);
    if (!params.ok) return refuse(400, params.error);
    const body = await readJsonBody(
      req,
      route.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    );
    if (!body.ok) return refuse(400, body.error);
    const input = route.validate({
      params: params.value,
      query: pending.query,
      headers: req.headers,
      body: body.value,
    });
    if (!input.ok) return refuse(400, input.error);

    const subject = route.subject(input.value);
    const failure = await audited({
      kind: "operator.action",
      workspace: deps.workspace,
      ...(subject.beadId !== undefined ? { beadId: subject.beadId } : {}),
      payload: {
        action: route.action,
        surface: surface.value,
        ...(subject.target !== undefined ? { target: subject.target } : {}),
      },
    });
    if (failure !== null)
      return refuse(
        503,
        `The action could not be recorded in the audit ledger, so nothing was done (${failure}). It is safe to try again.`,
      );
    return route.effect(input.value);
  }

  async function serve(
    route: ApiRoute,
    pending: PendingRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (repeatsSingleHeader(req) || !isDeclaredSameOrigin(req))
      return send(
        res,
        refuse(
          403,
          "The operator API answers only a request from this control plane's own origin",
        ),
      );
    if (route.kind === "action")
      return send(res, await act(route, pending, req));

    const params = decode(pending.params);
    if (!params.ok) return send(res, refuse(400, params.error));
    const input = route.validate({
      params: params.value,
      query: pending.query,
      headers: req.headers,
      body: undefined,
    });
    if (!input.ok) return send(res, refuse(400, input.error));
    if (route.kind === "read") return send(res, await route.read(input.value));
    const refusal = await route.open(input.value, req, res);
    if (refusal !== undefined) send(res, refusal);
  }

  return {
    routes,
    allowedMethods(pathname) {
      return [
        ...new Set(
          candidates(pathname).map((hit) => hit.compiled.route.method),
        ),
      ];
    },
    async handle(req, res, next) {
      const url = req.url ?? "";
      const mark = url.indexOf("?");
      const pathname = mark === -1 ? url : url.slice(0, mark);
      const hit = candidates(pathname).find(
        (candidate) => candidate.compiled.route.method === req.method,
      );
      if (!hit) return next();
      try {
        await serve(
          hit.compiled.route,
          {
            params: hit.params,
            query: new URLSearchParams(mark === -1 ? "" : url.slice(mark + 1)),
          },
          req,
          res,
        );
      } catch (error) {
        if (res.headersSent) res.end();
        else
          send(res, refuse(500, `The request failed: ${safeMessage(error)}`));
      }
    },
  };
}
