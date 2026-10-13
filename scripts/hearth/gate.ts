import type { IncomingMessage } from "node:http";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The headers the front door decides on; each may be sent at most once. */
const FRONT_DOOR_HEADERS = new Set(["host", "origin", "sec-fetch-site"]);
/**
 * The fetch metadata the front door accepts: a page of this origin, or the
 * user's own navigation. `same-site` is a page on another loopback port.
 */
const ACCEPTED_FETCH_SITES = new Set(["same-origin", "none"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

/**
 * Whether one of these lower-case header names was sent more than once. Read
 * from `rawHeaders`: under Bun's `node:http` a repeated header arrives in
 * `req.headers` as its last value only.
 */
function repeatsHeader(
  req: IncomingMessage,
  names: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] ?? "").toLowerCase();
    if (!names.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/**
 * The front-door check every hearth request must pass: a loopback peer;
 * `Host`, `Origin` and `Sec-Fetch-Site` each sent at most once; a loopback
 * `Host`; an `Origin` (when sent) equal to that host's own origin; and fetch
 * metadata (when sent) of `same-origin` or `none`. Returns the Host's origin on
 * success so callers can make further same-origin decisions.
 */
export function frontDoorOrigin(req: IncomingMessage): string | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null;
  if (repeatsHeader(req, FRONT_DOOR_HEADERS)) return null;
  try {
    const host = new URL(`http://${req.headers.host ?? ""}`);
    if (!LOOPBACK_HOSTNAMES.has(host.hostname)) return null;
    if (req.headers.origin && req.headers.origin !== host.origin) return null;
    const site = req.headers["sec-fetch-site"];
    if (
      site !== undefined &&
      (typeof site !== "string" || !ACCEPTED_FETCH_SITES.has(site))
    )
      return null;
    return host.origin;
  } catch {
    return null;
  }
}

export function passesFrontDoor(req: IncomingMessage): boolean {
  return frontDoorOrigin(req) !== null;
}

/**
 * Same-origin proof for a request that may legitimately carry no `Origin`
 * (browsers omit it on same-origin GETs): the Origin matches, or the browser
 * says `Sec-Fetch-Site: same-origin`. A bare request proves nothing.
 */
export function isDeclaredSameOrigin(req: IncomingMessage): boolean {
  const origin = frontDoorOrigin(req);
  if (origin === null) return false;
  return (
    req.headers.origin === origin ||
    req.headers["sec-fetch-site"] === "same-origin"
  );
}

/**
 * Paths a router could read two ways: dot segments, encoded separators or dots,
 * backslashes, and empty segments. No legitimate route uses them, so they are
 * refused outright rather than normalised.
 */
export function hasAmbiguousPath(pathname: string): boolean {
  return /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(pathname);
}
