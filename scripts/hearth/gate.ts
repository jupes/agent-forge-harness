import type { IncomingMessage } from "node:http";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

/**
 * The front-door check every hearth request must pass: a loopback peer, a
 * loopback `Host`, an `Origin` (when sent) equal to that host's own origin, and
 * no cross-site fetch metadata. Returns the Host's origin on success so callers
 * can make further same-origin decisions.
 */
export function frontDoorOrigin(req: IncomingMessage): string | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null;
  try {
    const host = new URL(`http://${req.headers.host ?? ""}`);
    if (!LOOPBACK_HOSTNAMES.has(host.hostname)) return null;
    if (req.headers.origin && req.headers.origin !== host.origin) return null;
    if (req.headers["sec-fetch-site"] === "cross-site") return null;
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
