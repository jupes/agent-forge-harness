/**
 * The dashboard's session: how a browser page comes to be given the operator
 * token, and nothing else that only declares the hearth's origin does
 * (`x1gs.3.31`).
 *
 * The root of trust is the token file, which only the OS user who started the
 * hearth can read (mode 0600; on Windows the profile directory's ACL). The
 * token route used to serve the token to any request that passed the front
 * door and declared the hearth's own `Origin`: headers any local program can
 * set, another OS user's included. Now:
 *
 * 1. A holder of the token mints a launch secret (`POST /launch`): 256 random
 *    bits, good for `LAUNCH_TTL_MS` and for one use. Only its hash is kept, in
 *    this hearth's memory.
 * 2. The dashboard is opened at a link whose fragment carries the secret
 *    (`#launch=<secret>`). The page sends it once, same-origin, to
 *    `POST /session`. Any request there that presents a secret spends it,
 *    before anything else about the request is looked at and whether or not
 *    the exchange succeeds. A good exchange answers a session cookie: fresh
 *    randomness (never the secret or the token), HttpOnly, SameSite=Strict,
 *    scoped to the API prefix, named for this hearth's home and root.
 * 3. `GET /token` answers only a request that carries a valid session cookie,
 *    on top of the front door and the declared same origin.
 *
 * Sessions are kept as hashes with an absolute expiry (`SESSION_TTL_MS`, 7
 * days, not extended by use) in a file beside the token file, written as the
 * token file is: the dashboard restarts a stopped hearth without the page
 * knowing, and the page keeps its session across that restart.
 *
 * Scripts, CLIs and the MCP server keep reading the token file. Every route
 * that changes something keeps requiring the token.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type LedgerEventInput,
  OPERATOR_SURFACES,
  type OperatorSurface,
} from "../../types/hearth";
import type { AppendResult } from "../ledger/append";
import { isDeclaredSameOrigin } from "./gate";
import { rootKey } from "./home";
import { type Exchange, loopbackExchange } from "./loopback";
import {
  API_PREFIX,
  LAUNCH_HEADER,
  LAUNCH_KEY,
  LAUNCH_ROUTE,
  OPEN_COMMAND,
  OPERATOR_HEADER,
  SURFACE_HEADER,
} from "./paths";
import { tokenMatches, writeOwnerOnly } from "./token";

/** How long a launch secret can be exchanged after it was minted. */
export const LAUNCH_TTL_MS = 5 * 60 * 1000;
/** How long a session lasts from its exchange; use does not extend it. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Launch secrets waiting at once; minting another drops the oldest. */
export const MAX_PENDING_LAUNCHES = 16;
/** Sessions kept at once; a new one drops the oldest. */
export const MAX_SESSIONS = 64;

/** What a launch secret and a session value are: 256 bits as lower-case hex. */
const SECRET_SHAPE = /^[0-9a-f]{64}$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;

export function isSecretShaped(value: unknown): value is string {
  return typeof value === "string" && SECRET_SHAPE.test(value);
}

function freshSecret(): string {
  return randomBytes(32).toString("hex");
}

function hashOf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Which of `stored` equal one of `presented`, every pair compared with
 * `timingSafeEqual` (both are SHA-256 digests, so of one length), with no
 * comparison skipped once a match is found.
 */
function matches(
  stored: readonly Buffer[],
  presented: readonly Buffer[],
): boolean[] {
  return stored.map((hash) => {
    let matched = false;
    for (const candidate of presented)
      matched = timingSafeEqual(hash, candidate) || matched;
    return matched;
  });
}

// ── Launch secrets ──────────────────────────────────────────────────────────

export interface MintedLaunch {
  secret: string;
  expiresAt: string;
}

export interface LaunchSecrets {
  /** A new secret. Only its hash is kept. */
  mint(): MintedLaunch;
  /**
   * Spend every pending secret among `presented`, live or expired; true when
   * one of them was live. A value that is not secret-shaped matches nothing.
   */
  spend(presented: readonly string[]): boolean;
  /** How many secrets are waiting (expired ones included until the next mint or spend). */
  pending(): number;
}

export interface Clocked {
  /** The clock, in milliseconds since the epoch; the system's by default. */
  now?: () => number;
}

export function createLaunchSecrets(
  options: Clocked & { ttlMs?: number; max?: number } = {},
): LaunchSecrets {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? LAUNCH_TTL_MS;
  const max = options.max ?? MAX_PENDING_LAUNCHES;
  let entries: Array<{ hash: Buffer; expiresAt: number }> = [];
  return {
    mint() {
      const at = now();
      entries = entries.filter((entry) => entry.expiresAt > at);
      const secret = freshSecret();
      const expiresAt = at + ttl;
      entries.push({ hash: hashOf(secret), expiresAt });
      entries = entries.slice(-max);
      return { secret, expiresAt: new Date(expiresAt).toISOString() };
    },
    spend(presented) {
      const at = now();
      const hashes = presented.filter(isSecretShaped).map(hashOf);
      const found = matches(
        entries.map((entry) => entry.hash),
        hashes,
      );
      let live = false;
      const kept: typeof entries = [];
      entries.forEach((entry, index) => {
        if (found[index]) live = entry.expiresAt > at || live;
        else if (entry.expiresAt > at) kept.push(entry);
      });
      entries = kept;
      return live;
    },
    pending: () => entries.length,
  };
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface CreatedSession {
  /** The cookie's value. Never stored: the file holds its hash. */
  value: string;
  expiresAt: string;
}

export interface SessionStore {
  create(): CreatedSession;
  /** Whether one of `presented` is a session that has not expired. */
  valid(presented: readonly string[]): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sessions in `file`, by hash and expiry. A file that is missing, not
 * JSON or of another shape holds none; an entry of another shape is skipped.
 */
function readSessions(
  file: string,
): Array<{ hash: Buffer; expiresAt: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (
    !isRecord(parsed) ||
    parsed["version"] !== 1 ||
    !Array.isArray(parsed["sessions"])
  )
    return [];
  const sessions: Array<{ hash: Buffer; expiresAt: number }> = [];
  for (const item of parsed["sessions"]) {
    if (!isRecord(item)) continue;
    const { hash, expiresAt } = item;
    if (typeof hash !== "string" || !HASH_SHAPE.test(hash)) continue;
    if (typeof expiresAt !== "string") continue;
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) continue;
    sessions.push({ hash: Buffer.from(hash, "hex"), expiresAt: at });
  }
  return sessions;
}

/**
 * The sessions of one hearth, kept in `file` (`sessionsPath`): a hash and an
 * absolute expiry for each, never a session value. The file is read on every
 * check, so a hearth started again honours what the last one created.
 */
export function createSessionStore(
  file: string,
  options: Clocked & { ttlMs?: number; max?: number } = {},
): SessionStore {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? SESSION_TTL_MS;
  const max = options.max ?? MAX_SESSIONS;
  return {
    create() {
      const at = now();
      const value = freshSecret();
      const expiresAt = at + ttl;
      const kept = [
        ...readSessions(file).filter((entry) => entry.expiresAt > at),
        { hash: hashOf(value), expiresAt },
      ]
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(-max);
      writeOwnerOnly(
        file,
        `${JSON.stringify(
          {
            version: 1,
            sessions: kept.map((entry) => ({
              hash: entry.hash.toString("hex"),
              expiresAt: new Date(entry.expiresAt).toISOString(),
            })),
          },
          null,
          2,
        )}\n`,
      );
      return { value, expiresAt: new Date(expiresAt).toISOString() };
    },
    valid(presented) {
      const hashes = presented.filter(isSecretShaped).map(hashOf);
      if (hashes.length === 0) return false;
      const at = now();
      const sessions = readSessions(file);
      const found = matches(
        sessions.map((entry) => entry.hash),
        hashes,
      );
      return sessions.some(
        (entry, index) => found[index] === true && entry.expiresAt > at,
      );
    },
  };
}

// ── The cookie ──────────────────────────────────────────────────────────────

/**
 * The session cookie's name for a hearth: one per home and root. A browser
 * keeps cookies per host, not per port, so two dashboards on one host must
 * not share a name, or each would overwrite the other's session.
 */
export function sessionCookieName(home: string, root: string): string {
  const key = createHash("sha256")
    .update(`${rootKey(home)}\n${rootKey(root)}`)
    .digest("hex")
    .slice(0, 16);
  return `agent_forge_session_${key}`;
}

/**
 * The `Set-Cookie` value for a session: HttpOnly (no script reads it),
 * SameSite=Strict (no other site's page sends it), the API prefix as its path
 * (it goes only to the control plane's routes), no `Domain` (it stays on the
 * host that answered), no `Secure` (the dashboard is plain http on loopback),
 * and no `Expires` or `Max-Age`: a browser-session cookie, which the hearth
 * stops honouring at the session's own expiry in any case.
 */
export function sessionCookie(name: string, value: string): string {
  return `${name}=${value}; Path=${API_PREFIX}; HttpOnly; SameSite=Strict`;
}

/** Every value of header `name` the request sent, from `rawHeaders` (Bun keeps only the last in `headers`). */
function rawValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if ((req.rawHeaders[i] ?? "").toLowerCase() === name)
      values.push(req.rawHeaders[i + 1] ?? "");
  return values;
}

/** Every value the request's cookies give `name`, in every `Cookie` line it sent. */
export function presentedCookies(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (const line of rawValues(req, "cookie"))
    for (const pair of line.split(";")) {
      const at = pair.indexOf("=");
      if (at > 0 && pair.slice(0, at).trim() === name)
        values.push(pair.slice(at + 1).trim());
    }
  return values;
}

// ── The routes ──────────────────────────────────────────────────────────────

function reply(
  res: ServerResponse,
  status: number,
  data: unknown,
  error: string | null = null,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({ ok: error === null, data: error ? null : data, error }),
  );
}

/** The surface the request declares (absent means `api`), or null for anything else or a repeat. */
function declaredSurface(req: IncomingMessage): OperatorSurface | null {
  const values = rawValues(req, SURFACE_HEADER);
  if (values.length === 0) return "api";
  if (values.length > 1) return null;
  return OPERATOR_SURFACES.find((surface) => surface === values[0]) ?? null;
}

const AUDIT_ATTEMPTS = 3;
const AUDIT_RETRY_MS = 25;

export interface LaunchRouteDeps {
  launches: LaunchSecrets;
  sessions: SessionStore;
  cookieName: string;
  /** The token a mint must present, or null while none can be honoured. */
  expectedToken(): string | null;
  appendEvent(event: LedgerEventInput): AppendResult;
  workspace: string;
}

export interface LaunchRoutes {
  /**
   * Spend every launch secret the request presents, before anything else
   * about it is looked at; true when one of them was live. Called by the
   * server for every request to `SESSION_ROUTE`, the front door's refusals
   * included.
   */
  spend(req: IncomingMessage): boolean;
  /** `POST /launch`: mint a launch secret for a holder of the operator token. */
  mint(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** `POST /session`: given what `spend` found, answer the session cookie or a refusal. */
  exchange(
    req: IncomingMessage,
    res: ServerResponse,
    live: boolean,
  ): Promise<void>;
  /** Whether the request carries a valid session cookie. */
  hasSession(req: IncomingMessage): boolean;
}

export function launchRoutes(deps: LaunchRouteDeps): LaunchRoutes {
  /**
   * The `operator.action` row, which names the action and the surface and
   * nothing of a secret, a session or the token. Null once stored; otherwise
   * why not. A busy ledger is tried again, as the operator API's runner does.
   */
  async function audited(
    action: string,
    surface: OperatorSurface,
  ): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      let result: AppendResult;
      try {
        result = deps.appendEvent({
          kind: "operator.action",
          workspace: deps.workspace,
          payload: { action, surface },
        });
      } catch {
        return "the ledger could not be written";
      }
      if (result.ok)
        return "id" in result && typeof result.id === "number" && result.id > 0
          ? null
          : "the ledger stored no row";
      const reason = "error" in result ? String(result.error) : "refused";
      if (!/busy|locked/i.test(reason) || attempt >= AUDIT_ATTEMPTS)
        return "the ledger refused the row";
      await new Promise((done) => setTimeout(done, AUDIT_RETRY_MS));
    }
  }

  const notRecorded = (why: string): string =>
    `The action could not be recorded in the audit ledger, so nothing was done (${why}). It is safe to try again.`;

  return {
    spend(req) {
      return deps.launches.spend(rawValues(req, LAUNCH_HEADER));
    },

    async mint(req, res) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return reply(res, 405, null, "Method not allowed");
      }
      const tokens = rawValues(req, OPERATOR_HEADER);
      if (tokens.length !== 1 || !tokenMatches(deps.expectedToken(), tokens[0]))
        return reply(
          res,
          403,
          null,
          "A launch link needs the operator token of this control plane, sent once",
        );
      const surface = declaredSurface(req);
      if (surface === null)
        return reply(
          res,
          400,
          null,
          `${SURFACE_HEADER}: expected one of ${OPERATOR_SURFACES.join(" | ")}, sent once`,
        );
      const failure = await audited("dashboard.launch", surface);
      if (failure !== null) return reply(res, 503, null, notRecorded(failure));
      return reply(res, 200, deps.launches.mint());
    },

    async exchange(req, res, live) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return reply(res, 405, null, "Method not allowed");
      }
      if (rawValues(req, LAUNCH_HEADER).length !== 1)
        return reply(
          res,
          400,
          null,
          `${LAUNCH_HEADER}: send the launch secret once`,
        );
      if (!isDeclaredSameOrigin(req))
        return reply(
          res,
          403,
          null,
          "A dashboard session is given only to a page of this control plane's own origin",
        );
      if (!live)
        return reply(
          res,
          403,
          null,
          `This launch link is not valid: it expired, was used already, or was never minted. For a new one: ${OPEN_COMMAND}`,
        );
      const surface = declaredSurface(req);
      if (surface === null)
        return reply(
          res,
          400,
          null,
          `${SURFACE_HEADER}: expected one of ${OPERATOR_SURFACES.join(" | ")}, sent once`,
        );
      const failure = await audited("dashboard.session", surface);
      if (failure !== null) return reply(res, 503, null, notRecorded(failure));
      let session: CreatedSession;
      try {
        session = deps.sessions.create();
      } catch {
        return reply(
          res,
          500,
          null,
          `The session could not be stored. For a new launch link: ${OPEN_COMMAND}`,
        );
      }
      res.setHeader(
        "Set-Cookie",
        sessionCookie(deps.cookieName, session.value),
      );
      return reply(res, 200, { expiresAt: session.expiresAt });
    },

    hasSession(req) {
      return deps.sessions.valid(presentedCookies(req, deps.cookieName));
    },
  };
}

// ── The client: what the launcher, the open command and the browser suite call ──

/** How long a mint may take, and how much of an answer is read. */
const MINT_TIMEOUT_MS = 5000;
const MINT_MAX_BYTES = 16_384;

export interface RequestLaunchOptions {
  /** The hearth's port on 127.0.0.1. */
  port: number;
  /** The operator token, read from the token file. Sent on this request only. */
  token: string;
  surface?: OperatorSurface;
  /** `loopbackExchange` when not given: never `fetch`, which may go to a proxy. */
  exchange?: Exchange;
}

/**
 * Mint a launch secret from the hearth on `port`. The error says why not in
 * the hearth's words, never with the token.
 */
export async function requestLaunch(
  options: RequestLaunchOptions,
): Promise<MintedLaunch> {
  const answer = await (options.exchange ?? loopbackExchange)({
    port: options.port,
    method: "POST",
    target: LAUNCH_ROUTE,
    headers: {
      [OPERATOR_HEADER]: options.token,
      [SURFACE_HEADER]: options.surface ?? "cli",
    },
    body: "",
    timeoutMs: MINT_TIMEOUT_MS,
    maxBytes: MINT_MAX_BYTES,
  });
  let envelope: unknown = null;
  try {
    envelope = JSON.parse(answer.body);
  } catch {
    // Not the control plane's envelope: said below.
  }
  const data =
    isRecord(envelope) && envelope["ok"] === true ? envelope["data"] : null;
  if (
    answer.status === 200 &&
    isRecord(data) &&
    isSecretShaped(data["secret"]) &&
    typeof data["expiresAt"] === "string"
  )
    return { secret: data["secret"], expiresAt: data["expiresAt"] };
  const error =
    isRecord(envelope) && typeof envelope["error"] === "string"
      ? envelope["error"]
      : "the answer was not the control plane's";
  throw new Error(
    `the control plane did not mint a launch link (HTTP ${answer.status}: ${error})`,
  );
}

/** The dashboard at `base`, opened with `secret` in its fragment. */
export function launchUrl(base: string, secret: string): string {
  const url = new URL(base);
  url.hash = `${LAUNCH_KEY}=${secret}`;
  return url.toString();
}

/**
 * What a running dashboard writes for `bun run dashboard:open`
 * (`dashboardRecordPath`): where it listens. Holds no secret.
 */
export interface DashboardRecord {
  /** The dev server's process. */
  pid: number;
  /** The root the dashboard serves, resolved. */
  root: string;
  /** Where the dashboard listens, as `dashboardUrl` writes it. */
  url: string;
}

/** The record in `file`, or null when there is none or it is of another shape. */
export function readDashboardRecord(file: string): DashboardRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { pid, root, url } = parsed;
  return typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof root === "string" &&
    typeof url === "string"
    ? { pid, root, url }
    : null;
}
