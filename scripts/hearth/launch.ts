/**
 * The dashboard's session: how a browser page comes to be given the operator
 * token, and nothing else that only declares the hearth's origin does
 * (`x1gs.3.31`).
 *
 * The root of trust is the token file, which only the OS user who started the
 * hearth can read (`writeOwnerOnly`: mode 0600, on Windows an owner-only
 * DACL). The token route used to serve the token to any request that passed
 * the front door and declared the hearth's own `Origin`: headers any local
 * program can set, another OS user's included. Now:
 *
 * 1. A holder of the token mints a launch secret (`POST /launch`): 256 random
 *    bits, good for `LAUNCH_TTL_MS` and for one use. Only its hash is kept, in
 *    this hearth's memory.
 * 2. The dashboard is opened at a link whose fragment carries the secret
 *    (`#launch=<secret>`). The page sends it once, same-origin, to
 *    `POST /session`. Any request there that presents a secret spends it,
 *    before anything else about the request is looked at and whether or not
 *    the exchange succeeds. A good exchange answers a session cookie (fresh
 *    randomness, never the secret or the token; HttpOnly, SameSite=Strict,
 *    scoped to the API prefix, named for this hearth's home and root) and,
 *    in its body, a session key (fresh randomness too), which the page keeps
 *    in its origin's `localStorage`.
 * 3. `GET /token` answers only a request that carries both halves of one
 *    session, the cookie and the key in `SESSION_KEY_HEADER`, on top of the
 *    front door and the declared same origin. A browser sends the cookie to
 *    every port of the host, so a page served by another program on another
 *    loopback port can have its own server receive it; that page cannot read
 *    the dashboard origin's storage, so it never has the key.
 *
 * Sessions are kept as hashes (of the cookie value and of the key) with an
 * absolute expiry (`SESSION_TTL_MS`, 7 days, not extended by use) in a file
 * beside the token file, written as the token file is: the dashboard restarts
 * a stopped hearth without the page knowing, and the page keeps its session
 * across that restart.
 *
 * Scripts, CLIs and the MCP server keep reading the token file. Every route
 * that changes something keeps requiring the token.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  type LedgerEventInput,
  OPERATOR_SURFACES,
  type OperatorSurface,
} from "../../types/hearth";
import type { AppendResult } from "../ledger/append";
import { isDeclaredSameOrigin } from "./gate";
import { lockPath, rootKey } from "./home";
import { readHomeLock } from "./home-guard";
import { type Exchange, loopbackExchange } from "./loopback";
import {
  API_PREFIX,
  LAUNCH_HEADER,
  LAUNCH_KEY,
  LAUNCH_ROUTE,
  OPEN_COMMAND,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
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

/**
 * A session is two values, both fresh randomness, both needed: the cookie's
 * value, and a key the page keeps in `localStorage` and sends in
 * `SESSION_KEY_HEADER`. A browser sends the cookie to every port of the host
 * (cookies are not kept per port), so a page another program serves on
 * another loopback port can have its own server receive it. The key belongs
 * to the dashboard's origin, port included: that page cannot read it, so the
 * cookie it received is worth nothing without it.
 */
export interface CreatedSession {
  /** The cookie's value. Never stored: the file holds its hash. */
  value: string;
  /** The session key, answered in the exchange's body. Never stored: the file holds its hash. */
  key: string;
  expiresAt: string;
}

export interface SessionStore {
  create(): CreatedSession;
  /**
   * Whether one of `cookies` and one of `keys` are the cookie value and the
   * key of the same session, and it has not expired.
   */
  valid(cookies: readonly string[], keys: readonly string[]): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The version of the sessions file; a file of another (an older one, whose sessions had no key) holds none. */
const SESSIONS_VERSION = 2;

interface StoredSession {
  hash: Buffer;
  keyHash: Buffer;
  expiresAt: number;
}

/**
 * The sessions in `file`, by hash, key hash and expiry. A file that is
 * missing, not JSON or of another shape or version holds none; an entry of
 * another shape is skipped.
 */
function readSessions(file: string): StoredSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (
    !isRecord(parsed) ||
    parsed["version"] !== SESSIONS_VERSION ||
    !Array.isArray(parsed["sessions"])
  )
    return [];
  const sessions: StoredSession[] = [];
  for (const item of parsed["sessions"]) {
    if (!isRecord(item)) continue;
    const { hash, keyHash, expiresAt } = item;
    if (typeof hash !== "string" || !HASH_SHAPE.test(hash)) continue;
    if (typeof keyHash !== "string" || !HASH_SHAPE.test(keyHash)) continue;
    if (typeof expiresAt !== "string") continue;
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) continue;
    sessions.push({
      hash: Buffer.from(hash, "hex"),
      keyHash: Buffer.from(keyHash, "hex"),
      expiresAt: at,
    });
  }
  return sessions;
}

/**
 * The sessions of one hearth, kept in `file` (`sessionsPath`): for each, the
 * hash of its cookie value, the hash of its key and an absolute expiry, never
 * a value or a key. The file is read on every check, so a hearth started
 * again honours what the last one created.
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
      const key = freshSecret();
      const expiresAt = at + ttl;
      const kept = [
        ...readSessions(file).filter((entry) => entry.expiresAt > at),
        { hash: hashOf(value), keyHash: hashOf(key), expiresAt },
      ]
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(-max);
      writeOwnerOnly(
        file,
        `${JSON.stringify(
          {
            version: SESSIONS_VERSION,
            sessions: kept.map((entry) => ({
              hash: entry.hash.toString("hex"),
              keyHash: entry.keyHash.toString("hex"),
              expiresAt: new Date(entry.expiresAt).toISOString(),
            })),
          },
          null,
          2,
        )}\n`,
      );
      return { value, key, expiresAt: new Date(expiresAt).toISOString() };
    },
    valid(cookies, keys) {
      const cookieHashes = cookies.filter(isSecretShaped).map(hashOf);
      const keyHashes = keys.filter(isSecretShaped).map(hashOf);
      if (cookieHashes.length === 0 || keyHashes.length === 0) return false;
      const at = now();
      const sessions = readSessions(file);
      const cookieFound = matches(
        sessions.map((entry) => entry.hash),
        cookieHashes,
      );
      const keyFound = matches(
        sessions.map((entry) => entry.keyHash),
        keyHashes,
      );
      // Both of the same session: one session's cookie with another's key is no session.
      return sessions.some(
        (entry, index) =>
          cookieFound[index] === true &&
          keyFound[index] === true &&
          entry.expiresAt > at,
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
  /**
   * Whether the request carries a session: its cookie, and its key in
   * `SESSION_KEY_HEADER`, sent once, both of the same unexpired session.
   */
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
      // The key goes in the body, which only a page of this origin can read
      // (the dev server answers no CORS), and the page keeps it in its
      // origin's storage.
      return reply(res, 200, {
        expiresAt: session.expiresAt,
        key: session.key,
      });
    },

    hasSession(req) {
      const keys = rawValues(req, SESSION_KEY_HEADER);
      // The key sent once: a request that sends two is refused, whatever they hold.
      if (keys.length !== 1) return false;
      return deps.sessions.valid(presentedCookies(req, deps.cookieName), keys);
    },
  };
}

// ── The client: what the launcher, the open command and the browser suite call ──

/** How long a mint may take, and how much of an answer is read. */
const MINT_TIMEOUT_MS = 5000;
const MINT_MAX_BYTES = 16_384;

export interface RequestLaunchOptions {
  /**
   * The hearth home and the checkout root the port was found for: the home,
   * and the lock file of that root in it, are checked and read first
   * (`readHomeLock`), and nothing is sent when others can write either, or
   * when that lock names another port.
   */
  home: string;
  root: string;
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
 * the hearth's words, never with the token. Nothing is sent from a home, or
 * with a lock file, that others can write: whoever can write them can name
 * the port (`home-guard.ts`). And nothing is sent to a port the lock of
 * `root` in the home does not name, read as it is checked (`readHomeLock`),
 * here, just before the token goes: a port found earlier from a lock that was
 * swapped back since is not sent the token (`x1gs.3.38`).
 */
export async function requestLaunch(
  options: RequestLaunchOptions,
): Promise<MintedLaunch> {
  const file = lockPath(options.home, options.root);
  const read = readHomeLock(options.home, file);
  if (read.problem !== null)
    throw new Error(`Refusing to send the operator token: ${read.problem}`);
  if (read.lock === null)
    throw new Error(
      `Refusing to send the operator token: there is no lock file of a hearth for ${resolve(options.root)} in ${options.home} (${file})`,
    );
  if (read.lock.port !== options.port)
    throw new Error(
      `Refusing to send the operator token: the lock file ${file} names port ${read.lock.port}, not ${options.port}`,
    );
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

/**
 * The hosts a launch link may name: the loopback addresses themselves. Never
 * a name that resolves, such as `localhost`: a browser may resolve it to an
 * address the dashboard does not listen on (`::1` when it bound `127.0.0.1`),
 * where any program, another OS user's included, can listen, be handed the
 * link and read the secret from its fragment (`x1gs.3.31`).
 */
const LAUNCH_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/**
 * `base` as the root a launch link is built on (`http://127.0.0.1:<port>/` or
 * `http://[::1]:<port>/`); throws, saying why, for any other host or scheme.
 */
export function launchBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${base} is not a URL`);
  }
  if (url.protocol !== "http:" || !LAUNCH_HOSTS.has(url.hostname))
    throw new Error(
      `a launch link names the address the dashboard listens on, http://127.0.0.1 or http://[::1], never a name that resolves: not ${url.protocol}//${url.host}`,
    );
  return `${url.origin}/`;
}

/** The dashboard at `base` (a `launchBase`), opened with `secret` in its fragment. */
export function launchUrl(base: string, secret: string): string {
  const url = new URL(launchBase(base));
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
  try {
    return parseDashboardRecord(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The record in the text of a record file, or null when it is of another shape. */
export function parseDashboardRecord(text: string): DashboardRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
