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
  type BenchName,
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
  /** Private read/stream content needs operator authority; actions always require it. */
  operatorOnly?: true;
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
  /** Fixed write-family tag for operations whose identities share an API. */
  family?: string;
  /** Durable idempotency UUID; never carries request content. */
  requestId?: string;
  /** Canonical request digest; never carries request content. */
  inputHash?: string;
  /** Closed routing change kind; never carries the selected value. */
  changeKind?: "default" | "bench";
  /** Fixed routing selector, or one known bench name. */
  selector?: "workflow.default_crew" | BenchName;
}

/** A POST that changes something. */
export interface ActionContext {
  /** The numeric row confirmed by the common runner, never an input capability. */
  auditEventId: number;
}

export interface ActionRoute<Input = unknown> extends RouteCommon<Input> {
  kind: "action";
  method: "POST";
  /** The `operator.action` payload's `action`, e.g. `council.run.start`. */
  action: string;
  /** Largest request body accepted; defaults to 16 kB. */
  maxBodyBytes?: number;
  /** Reject duplicate decoded keys in the raw JSON object before auditing. */
  rejectDuplicateBodyKeys?: boolean;
  subject(input: Input): ActionSubject;
  effect(
    input: Input,
    context?: ActionContext,
  ): RouteReply | Promise<RouteReply>;
}

export type ApiRoute = ReadRoute | StreamRoute | ActionRoute;

export interface OperatorApiDeps {
  /** The workspace audit rows are recorded under. */
  workspace: string;
  /** The token a mutation must present, or null while none can be honoured. */
  expectedToken(): string | null;
  /** The ledger's `appendEvent`, bound to this hearth's ledger. */
  appendEvent(event: LedgerEventInput): AppendResult;
  /** How long an action's body may take to arrive in full; `BODY_TIMEOUT_MS` when not given. */
  bodyTimeoutMs?: number;
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
/**
 * How long an action's body may take to arrive in full. Past it the request
 * is answered (408, or the refusal it already had) and its connection closed.
 */
export const BODY_TIMEOUT_MS = 10_000;
/**
 * A refusal whose body has not begun to arrive this long after the refusal was
 * decided is sent without waiting for it (see `serveAction`): a client that
 * holds its body back without `Expect` (an MCP server built before it sent
 * `Expect`, for 100 ms) has not sent it yet.
 */
const HELD_BODY_MS = 50;
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

const NOT_THIS_ORIGIN =
  "The operator API answers only a request from this control plane's own origin";

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

/** How reading a request's body ended. */
interface BodyRead {
  /** False when the body had not ended by the time limit, or its client went first. */
  ended: boolean;
  /** The body, when it ended at no more than the bytes the reader kept; otherwise null. */
  bytes: Buffer | null;
}

/** An action's body, read at most once, by its deadline. */
interface RequestBody {
  /**
   * Read to the end of the body or to the deadline, whichever comes first,
   * keeping at most `keep` bytes: past that what arrives is read and dropped.
   * Every call after the first answers what the first read.
   */
  read(keep: number): Promise<BodyRead>;
  /** Whether any byte of the body has been read yet. */
  started(): boolean;
  /** Whether an Expect client is still waiting for permission to send its body. */
  unasked(): boolean;
}

/**
 * Not read with `for await`: under Bun, leaving that loop before the body ends
 * makes the runtime end the response itself (an empty 200), so a reader that
 * stops at a deadline would never send its answer. Listeners are taken off
 * when the read stops, and the request is paused if its body had not ended.
 *
 * A client that said `Expect: 100-continue` waits to be asked for its body,
 * and the server sends nothing for it (`server.ts`): the first read that keeps
 * the body asks, with `100 Continue`. A read that keeps nothing (dropping the
 * body of a refusal) does not ask, so such a client is refused on its head.
 */
function requestBody(
  req: IncomingMessage,
  res: ServerResponse,
  timeoutMs: number,
): RequestBody {
  const deadline = Date.now() + timeoutMs;
  // An error after the read has stopped (the connection closed under it) must not be thrown as unhandled.
  req.on("error", () => {});
  let reading: Promise<BodyRead> | null = null;
  let started = false;
  let continued = false;
  const readTo = (keep: number): Promise<BodyRead> =>
    new Promise((done) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const stop = (ended: boolean): void => {
        clearTimeout(timer);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("close", onClose);
        if (!ended) req.pause();
        done({
          ended,
          bytes: ended && size <= keep ? Buffer.concat(chunks) : null,
        });
      };
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        started = true;
        size += buffer.byteLength;
        if (size <= keep) chunks.push(buffer);
        else chunks.length = 0;
      };
      const onEnd = (): void => stop(true);
      // Its client went before the body ended: under Bun `close` follows `end` otherwise.
      const onClose = (): void => stop(false);
      const timer = setTimeout(
        () => stop(false),
        Math.max(0, deadline - Date.now()),
      );
      if (req.readableEnded) return stop(true);
      req.on("data", onData);
      req.once("end", onEnd);
      req.once("close", onClose);
    });
  return {
    read(keep) {
      if (
        reading === null &&
        keep > 0 &&
        req.headers.expect?.toLowerCase() === "100-continue"
      ) {
        res.writeContinue();
        continued = true;
      }
      reading ??= readTo(keep);
      return reading;
    },
    started: () => started,
    unasked: () =>
      req.headers.expect?.toLowerCase() === "100-continue" && !continued,
  };
}

async function readJsonBody(
  req: IncomingMessage,
  body: RequestBody,
  maxBytes: number,
  timeoutMs: number,
  rejectDuplicateKeys = false,
): Promise<{ ok: true; value: unknown } | { ok: false; refusal: RouteReply }> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    return { ok: false, refusal: refuse(400, "Use application/json") };
  const tooLarge = refuse(400, `Request body exceeds ${maxBytes} bytes`);
  if (Number(req.headers["content-length"] ?? 0) > maxBytes)
    return { ok: false, refusal: tooLarge };
  const read = await body.read(maxBytes);
  if (!read.ended)
    return {
      ok: false,
      refusal: refuse(
        408,
        `The request body did not arrive within ${timeoutMs} ms`,
      ),
    };
  if (read.bytes === null) return { ok: false, refusal: tooLarge };
  try {
    const source = read.bytes.toString("utf8");
    const value: unknown = JSON.parse(source);
    if (rejectDuplicateKeys && hasDuplicateObjectKeys(source))
      return { ok: false, refusal: refuse(400, "Request body contains duplicate object keys") };
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      refusal: refuse(400, "Request body must be valid JSON"),
    };
  }
}

/** Scan valid JSON iteratively so decoded duplicate names are rejected before route validation. */
function hasDuplicateObjectKeys(source: string): boolean {
  const stack: Array<{
    kind: "object" | "array";
    expectKey: boolean;
    keys?: Set<string>;
  }> = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index++] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectKey) {
        const key: unknown = JSON.parse(source.slice(start, index));
        if (typeof key !== "string") return true;
        if (frame.keys?.has(key)) return true;
        frame.keys?.add(key);
        frame.expectKey = false;
      }
      index--;
    } else if (character === "{") {
      const parent = stack.at(-1);
      if (parent) parent.expectKey = false;
      stack.push({ kind: "object", expectKey: true, keys: new Set() });
    } else if (character === "[") {
      const parent = stack.at(-1);
      if (parent) parent.expectKey = false;
      stack.push({ kind: "array", expectKey: false });
    } else if (character === "}" || character === "]") stack.pop();
    else if (character === "," && stack.at(-1)?.kind === "object")
      stack.at(-1)!.expectKey = true;
  }
  return false;
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
   * Store the audit row and retain its confirmed id for the effect's trace.
   */
  async function audited(
    event: LedgerEventInput,
  ): Promise<{ id: number } | { error: string }> {
    for (let attempt = 1; ; attempt++) {
      // The appender is trusted for nothing but a row id: whatever else it
      // answers, or throws, the action stops here.
      let result: unknown;
      try {
        result = deps.appendEvent(event);
      } catch (error) {
        return { error: safeMessage(error) };
      }
      if (typeof result !== "object" || result === null)
        return { error: "the ledger did not answer" };
      const { ok, id, error } = result as {
        ok?: unknown;
        id?: unknown;
        error?: unknown;
      };
      // A row id is a positive whole number; nothing else counts as stored.
      if (ok === true)
        return typeof id === "number" && Number.isSafeInteger(id) && id > 0
          ? { id }
          : { error: "the ledger stored no row" };
      const reason = typeof error === "string" ? error : "the ledger refused";
      const busy = /busy|locked/i.test(reason);
      if (!busy || attempt >= AUDIT_ATTEMPTS)
        return { error: safeMessage(reason) };
      await sleep(AUDIT_RETRY_MS);
    }
  }

  const bodyTimeoutMs = deps.bodyTimeoutMs ?? BODY_TIMEOUT_MS;

  async function act(
    route: ActionRoute,
    pending: PendingRequest,
    req: IncomingMessage,
    incoming: RequestBody,
  ): Promise<RouteReply> {
    if (repeatsSingleHeader(req) || !isDeclaredSameOrigin(req))
      return refuse(403, NOT_THIS_ORIGIN);
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
      incoming,
      route.maxBodyBytes ?? DEFAULT_BODY_BYTES,
      bodyTimeoutMs,
      route.rejectDuplicateBodyKeys === true,
    );
    if (!body.ok) return body.refusal;
    const input = route.validate({
      params: params.value,
      query: pending.query,
      headers: req.headers,
      body: body.value,
    });
    if (!input.ok) return refuse(400, input.error);

    const subject = route.subject(input.value);
    const audit = await audited({
      kind: "operator.action",
      workspace: deps.workspace,
      ...(subject.beadId !== undefined ? { beadId: subject.beadId } : {}),
      payload: {
        action: route.action,
        surface: surface.value,
        ...(subject.target !== undefined ? { target: subject.target } : {}),
        ...(subject.family !== undefined ? { family: subject.family } : {}),
        ...(subject.requestId !== undefined
          ? { requestId: subject.requestId }
          : {}),
        ...(subject.inputHash !== undefined
          ? { inputHash: subject.inputHash }
          : {}),
        ...(subject.changeKind !== undefined
          ? { changeKind: subject.changeKind }
          : {}),
        ...(subject.selector !== undefined
          ? { selector: subject.selector }
          : {}),
      },
    });
    if ("error" in audit)
      return refuse(
        503,
        `The action could not be recorded in the audit ledger, so nothing was done (${audit.error}). It is safe to try again.`,
      );
    return route.effect(input.value, { auditEventId: audit.id });
  }

  /**
   * An action's answer is sent once its body has been read: a refusal given
   * before that (the origin, the token, a declared length over the cap) first
   * reads the body and drops it. Answered while its client was still writing,
   * the answer could be lost with the connection: under Bun a client that sent
   * `Connection: close` with a body of 2 MB or more received nothing.
   *
   * An Expect client whose body was never asked for is answered immediately
   * and closed, without starting a body reader or either wait below.
   * A body that has not ended by the time limit is not waited
   * for longer: the answer is sent and the connection closed once it is
   * written. And a refusal whose body has not begun to arrive within
   * `HELD_BODY_MS` is sent then, as the refusal of a client that holds its
   * body back until it has heard nothing; the
   * body is still read and dropped after it, and the connection closed if the
   * body has not ended by the time limit.
   */
  async function serveAction(
    route: ActionRoute,
    pending: PendingRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const incoming = requestBody(req, res, bodyTimeoutMs);
    const reply = await act(route, pending, req, incoming);
    if (incoming.unasked()) {
      req.pause();
      res.setHeader("Connection", "close");
      res.once("finish", () => req.socket.destroy());
      send(res, reply);
      return;
    }
    const reading = incoming.read(0);
    let held: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      reading,
      new Promise<"held back">((done) => {
        held = setTimeout(() => {
          if (!incoming.started()) done("held back");
        }, HELD_BODY_MS);
      }),
    ]);
    clearTimeout(held);
    if (outcome === "held back") {
      send(res, reply);
      const read = await reading;
      if (!read.ended) req.socket.destroy();
      return;
    }
    if (!outcome.ended) {
      res.setHeader("Connection", "close");
      res.once("finish", () => req.socket.destroy());
    }
    send(res, reply);
  }

  async function serve(
    route: ApiRoute,
    pending: PendingRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (route.kind === "action") return serveAction(route, pending, req, res);
    if (repeatsSingleHeader(req) || !isDeclaredSameOrigin(req))
      return send(res, refuse(403, NOT_THIS_ORIGIN));
    if (
      route.operatorOnly &&
      !tokenMatches(deps.expectedToken(), req.headers[OPERATOR_HEADER])
    )
      return send(
        res,
        refuse(
          403,
          "This private read needs the operator token of this control plane",
        ),
      );

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
