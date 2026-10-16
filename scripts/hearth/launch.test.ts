import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeLedger } from "../ledger/db";
import { sessionsPath, tokenPath } from "./home";
import {
  createLaunchSecrets,
  createSessionStore,
  LAUNCH_TTL_MS,
  launchBase,
  launchUrl,
  SESSION_TTL_MS,
  sessionCookie,
  sessionCookieName,
} from "./launch";
import {
  LAUNCH_HEADER,
  LAUNCH_ROUTE,
  NO_SESSION_ERROR,
  OPERATOR_HEADER,
  SESSION_ROUTE,
  TOKEN_ROUTE,
} from "./paths";
import { createHearth, type StartedHearth } from "./server";
import {
  cookiePair,
  exchangeLaunch,
  mintLaunch,
  startTestHearth,
  type TestHearth,
} from "./testing";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
  );
  return dir;
}

/** A clock the test moves by hand. */
function clock(start = Date.parse("2026-10-16T12:00:00.000Z")): {
  now: () => number;
  set(at: number): void;
  start: number;
} {
  let at = start;
  return {
    now: () => at,
    set(value) {
      at = value;
    },
    start,
  };
}

const HEX_256 = /^[0-9a-f]{64}$/;
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Values that are not the secret `real`: another secret, and ones of the wrong shape. */
function notTheSecret(real: string): string[] {
  return [
    "0".repeat(64),
    real.toUpperCase(),
    real.slice(0, 63),
    `${real}0`,
    `${real.slice(0, 63)}g`,
    ` ${real}`,
    "",
  ];
}

describe("launch secrets", () => {
  test("a minted secret is 256 bits as lower-case hex, different each time, and expires five minutes after it was minted", () => {
    const time = clock();
    const launches = createLaunchSecrets({ now: time.now });
    const first = launches.mint();
    const second = launches.mint();
    expect(first.secret).toMatch(HEX_256);
    expect(second.secret).not.toBe(first.secret);
    expect(LAUNCH_TTL_MS).toBe(5 * 60 * 1000);
    expect(first.expiresAt).toBe(
      new Date(time.start + LAUNCH_TTL_MS).toISOString(),
    );
    expect(launches.pending()).toBe(2);
  });

  test("a launch secret works once, then never again", () => {
    const launches = createLaunchSecrets();
    const { secret } = launches.mint();
    expect(launches.spend([secret])).toBe(true);
    expect(launches.spend([secret])).toBe(false);
    expect(launches.pending()).toBe(0);
  });

  test("a secret is good until a millisecond before its expiry; at its expiry it is refused, and spent", () => {
    const time = clock();
    const launches = createLaunchSecrets({ now: time.now });
    const early = launches.mint().secret;
    const late = launches.mint().secret;
    time.set(time.start + LAUNCH_TTL_MS - 1);
    expect(launches.spend([early])).toBe(true);
    time.set(time.start + LAUNCH_TTL_MS);
    expect(launches.spend([late])).toBe(false);
    expect(launches.pending()).toBe(0);
  });

  test("a wrong secret, or one of the wrong length or charset, is refused and leaves the real one good", () => {
    const launches = createLaunchSecrets();
    const { secret } = launches.mint();
    for (const wrong of notTheSecret(secret))
      expect({ wrong, live: launches.spend([wrong]) }).toEqual({
        wrong,
        live: false,
      });
    expect(launches.spend([secret])).toBe(true);
  });

  test("minting past the cap drops the oldest secret", () => {
    const launches = createLaunchSecrets({ max: 2 });
    const oldest = launches.mint().secret;
    const middle = launches.mint().secret;
    const newest = launches.mint().secret;
    expect(launches.spend([oldest])).toBe(false);
    expect(launches.spend([middle])).toBe(true);
    expect(launches.spend([newest])).toBe(true);
  });
});

describe("sessions", () => {
  test("a session is 256 bits of fresh hex, good for seven days, and its file holds its hash and expiry, never the value", () => {
    const time = clock();
    const file = sessionsPath(temp("af-launch-home-"), "/r");
    const store = createSessionStore(file, { now: time.now });
    const session = store.create();
    const other = store.create();
    expect(session.value).toMatch(HEX_256);
    expect(other.value).not.toBe(session.value);
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(session.expiresAt).toBe(
      new Date(time.start + SESSION_TTL_MS).toISOString(),
    );
    expect(store.valid([session.value])).toBe(true);
    const written = readFileSync(file, "utf8");
    expect(written).not.toContain(session.value);
    expect(written).not.toContain(other.value);
    expect(JSON.parse(written)).toEqual({
      version: 1,
      sessions: [
        { hash: sha256(session.value), expiresAt: session.expiresAt },
        { hash: sha256(other.value), expiresAt: other.expiresAt },
      ],
    });
  });

  test("a session survives a new store on the same file, as a hearth started again reads it; it is good until a millisecond before its expiry and refused at it", () => {
    const time = clock();
    const file = sessionsPath(temp("af-launch-home-"), "/r");
    const session = createSessionStore(file, { now: time.now }).create();
    const again = createSessionStore(file, { now: time.now });
    expect(again.valid([session.value])).toBe(true);
    time.set(time.start + SESSION_TTL_MS - 1);
    expect(again.valid([session.value])).toBe(true);
    time.set(time.start + SESSION_TTL_MS);
    expect(again.valid([session.value])).toBe(false);
  });

  test("another value, one of the wrong length or charset, or none at all is not a session", () => {
    const store = createSessionStore(
      sessionsPath(temp("af-launch-home-"), "/r"),
    );
    const { value } = store.create();
    for (const wrong of notTheSecret(value))
      expect({ wrong, valid: store.valid([wrong]) }).toEqual({
        wrong,
        valid: false,
      });
    expect(store.valid([])).toBe(false);
    // One good value among others is a session: a browser can send two cookies of one name.
    expect(store.valid(["0".repeat(64), value])).toBe(true);
  });

  test("the sessions file is created beside the token file, readable by this OS user only (mode 0600 where the file system keeps modes, as the token file)", () => {
    const home = temp("af-launch-home-");
    const file = sessionsPath(home, "/r");
    createSessionStore(file).create();
    expect(dirname(file)).toBe(dirname(tokenPath(home, "/r")));
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  test("a sessions file that is not JSON, or of another shape, holds no session, and the next session replaces it", () => {
    const file = sessionsPath(temp("af-launch-home-"), "/r");
    mkdirSync(dirname(file), { recursive: true });
    const store = createSessionStore(file);
    for (const content of [
      "{not json",
      JSON.stringify({ version: 2, sessions: [] }),
      JSON.stringify({
        version: 1,
        sessions: [{ hash: "zz", expiresAt: "never" }],
      }),
    ]) {
      writeFileSync(file, content);
      expect(store.valid(["0".repeat(64)])).toBe(false);
    }
    const { value } = store.create();
    expect(store.valid([value])).toBe(true);
    expect(
      (JSON.parse(readFileSync(file, "utf8")) as { sessions: unknown[] })
        .sessions,
    ).toHaveLength(1);
  });

  test("an expired session leaves the file at the next session, and past the cap the oldest go", () => {
    const time = clock();
    const file = sessionsPath(temp("af-launch-home-"), "/r");
    const store = createSessionStore(file, { now: time.now, max: 2 });
    const expired = store.create();
    time.set(time.start + SESSION_TTL_MS);
    const a = store.create();
    const b = store.create();
    const c = store.create();
    const kept = (
      JSON.parse(readFileSync(file, "utf8")) as {
        sessions: Array<{ hash: string }>;
      }
    ).sessions.map((entry) => entry.hash);
    expect(kept).toEqual([sha256(b.value), sha256(c.value)]);
    expect(kept).not.toContain(sha256(expired.value));
    expect(store.valid([a.value])).toBe(false);
  });
});

describe("the launch link", () => {
  const SECRET = "d".repeat(64);

  test("x1gs.3.31: names 127.0.0.1 or [::1] itself, over http, with the secret in the fragment", () => {
    expect(launchUrl("http://127.0.0.1:8787/", SECRET)).toBe(
      `http://127.0.0.1:8787/#launch=${SECRET}`,
    );
    expect(launchUrl("http://[::1]:8787", SECRET)).toBe(
      `http://[::1]:8787/#launch=${SECRET}`,
    );
    // The root, whatever path or query the base had: the secret is never in a query.
    expect(launchUrl("http://127.0.0.1:8787/x?y=1#z", SECRET)).toBe(
      `http://127.0.0.1:8787/#launch=${SECRET}`,
    );
  });

  test("x1gs.3.31: is never built on localhost or any other name a browser resolves, on an address off this machine, or over another scheme", () => {
    for (const base of [
      "http://localhost:8787/",
      "http://LOCALHOST:8787/",
      "http://localhost.:8787/",
      "http://dashboard.localhost:8787/",
      "http://evil.example:8787/",
      "http://192.168.1.20:8787/",
      "http://127.0.0.2:8787/",
      "https://127.0.0.1:8787/",
      "127.0.0.1:8787",
    ]) {
      const refused = (() => {
        try {
          return launchUrl(base, SECRET);
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      })();
      expect({ base, refused: refused instanceof Error }).toEqual({
        base,
        refused: true,
      });
      expect(() => launchBase(base)).toThrow();
    }
  });
});

describe("the cookie", () => {
  test("the Set-Cookie value is exactly name=value; Path=/__agent-forge; HttpOnly; SameSite=Strict, with no Domain, no Secure, no Expires and no Max-Age", () => {
    const set = sessionCookie("agent_forge_session_x", "a".repeat(64));
    const [pair, ...attributes] = set.split(";").map((part) => part.trim());
    expect(pair).toBe(`agent_forge_session_x=${"a".repeat(64)}`);
    expect(attributes).toEqual([
      "Path=/__agent-forge",
      "HttpOnly",
      "SameSite=Strict",
    ]);
    for (const absent of ["domain", "secure", "expires", "max-age"])
      expect(
        attributes.some((attribute) =>
          attribute.toLowerCase().startsWith(absent),
        ),
      ).toBe(false);
  });

  test("the cookie name differs per root and per home, is the same for the same pair, and is a cookie name a browser keeps as it is", () => {
    const name = sessionCookieName("/home/a", "/work/one");
    expect(name).toMatch(/^agent_forge_session_[0-9a-f]{16}$/);
    expect(sessionCookieName("/home/a", "/work/one")).toBe(name);
    expect(sessionCookieName("/home/a", "/work/two")).not.toBe(name);
    expect(sessionCookieName("/home/b", "/work/one")).not.toBe(name);
  });
});

// ── The routes, on a hearth ─────────────────────────────────────────────────

async function hearth(
  options: { launchNow?: () => number } = {},
): Promise<TestHearth> {
  const h = await startTestHearth(options);
  cleanup.push(() => h.close());
  return h;
}

/** A request with exactly these header lines over a raw socket: fetch folds a repeated header into one line. */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headerLines: string[],
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          ...headerLines,
          "Content-Length: 0",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", fail);
    socket.on("close", () => {
      const split = received.indexOf("\r\n\r\n");
      done({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0),
        head: received.slice(0, split),
        body: received.slice(split + 4),
      });
    });
  });
}

/** The `operator.action` rows' payloads, oldest first. */
function actions(h: TestHearth): unknown[] {
  return h.events(["operator.action"]).map((event) => event.payload);
}

async function mintedSecret(h: TestHearth): Promise<string> {
  const minted = await mintLaunch(h.hearth.url, h.hearth.token);
  const secret = minted.body.data?.["secret"];
  if (minted.status !== 200 || typeof secret !== "string")
    throw new Error("no secret was minted");
  return secret;
}

/** A token request declaring the hearth's origin with `cookie`: its status, and whether the token came back. */
async function tokenWith(
  url: string,
  token: string,
  cookie: string | null,
): Promise<{ status: number; token: boolean; error: string | null }> {
  const answer = await fetch(`${url}${TOKEN_ROUTE}`, {
    headers: { Origin: url, ...(cookie !== null ? { Cookie: cookie } : {}) },
  });
  const body = await answer.text();
  return {
    status: answer.status,
    token: body.includes(token),
    error: (JSON.parse(body) as { error: string | null }).error,
  };
}

describe("POST /launch", () => {
  test("is refused without the operator token, with a wrong one, with the token sent twice, for a GET and with an unknown surface; nothing is recorded", async () => {
    const h = await hearth();
    const { url, token, port } = h.hearth;
    const answers = [
      (await mintLaunch(url, null)).status,
      (await mintLaunch(url, "0".repeat(64))).status,
      (await mintLaunch(url, token.toUpperCase())).status,
      (
        await rawRequest(port, "POST", LAUNCH_ROUTE, [
          `${OPERATOR_HEADER}: ${token}`,
          `${OPERATOR_HEADER}: ${token}`,
        ])
      ).status,
      (
        await fetch(`${url}${LAUNCH_ROUTE}`, {
          headers: { [OPERATOR_HEADER]: token },
        })
      ).status,
      (await mintLaunch(url, token, { "x-agent-forge-surface": "robot" }))
        .status,
    ];
    expect(answers).toEqual([403, 403, 403, 403, 405, 400]);
    expect(actions(h)).toEqual([]);
  });

  test("with the operator token answers a fresh secret and records one operator.action row that names the action and the surface and holds nothing of the secret or the token", async () => {
    const h = await hearth();
    const minted = await mintLaunch(h.hearth.url, h.hearth.token);
    expect(minted.status).toBe(200);
    const secret = String(minted.body.data?.["secret"]);
    expect(secret).toMatch(HEX_256);
    expect(minted.setCookie).toBeNull();
    const rows = h.events(["operator.action"]);
    expect(rows.map((row) => row.payload)).toEqual([
      { action: "dashboard.launch", surface: "cli" },
    ]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(h.hearth.token);
  });
});

describe("POST /session", () => {
  test("exchanges a launch secret once: a session cookie set exactly as specified, recorded with nothing of either value; the same secret again is 403 and sets no cookie", async () => {
    const h = await hearth();
    const secret = await mintedSecret(h);
    const first = await exchangeLaunch(h.hearth.url, secret);
    expect(first.status).toBe(200);
    const name = sessionCookieName(h.home, h.root);
    const value = cookiePair(first.setCookie).slice(name.length + 1);
    expect(value).toMatch(HEX_256);
    expect(value).not.toBe(secret);
    expect(value).not.toBe(h.hearth.token);
    // Spelled out, not built with `sessionCookie`, so a change there shows here.
    expect(first.setCookie).toBe(
      `${name}=${value}; Path=/__agent-forge; HttpOnly; SameSite=Strict`,
    );
    const second = await exchangeLaunch(h.hearth.url, secret);
    expect({ status: second.status, setCookie: second.setCookie }).toEqual({
      status: 403,
      setCookie: null,
    });
    expect(second.body.error).toContain("bun run dashboard:open");
    const rows = h.events(["operator.action"]);
    expect(rows.map((row) => row.payload)).toEqual([
      { action: "dashboard.launch", surface: "cli" },
      { action: "dashboard.session", surface: "ui" },
    ]);
    for (const held of [secret, value])
      expect(JSON.stringify(rows)).not.toContain(held);
  });

  test("needs a declared same origin: with no Origin, or with a foreign one, it is 403 and sets no cookie, and the secret is spent all the same", async () => {
    const h = await hearth();
    for (const declared of [{}, { Origin: "https://evil.example" }]) {
      const secret = await mintedSecret(h);
      const refused = await exchangeLaunch(h.hearth.url, secret, declared);
      expect({ status: refused.status, setCookie: refused.setCookie }).toEqual({
        status: 403,
        setCookie: null,
      });
      const after = await exchangeLaunch(h.hearth.url, secret);
      expect({ status: after.status, setCookie: after.setCookie }).toEqual({
        status: 403,
        setCookie: null,
      });
    }
    expect(actions(h)).toEqual([
      { action: "dashboard.launch", surface: "cli" },
      { action: "dashboard.launch", surface: "cli" },
    ]);
  });

  test("an expired secret is refused", async () => {
    const time = clock();
    const h = await hearth({ launchNow: time.now });
    const secret = await mintedSecret(h);
    time.set(time.start + LAUNCH_TTL_MS);
    const late = await exchangeLaunch(h.hearth.url, secret);
    expect({ status: late.status, setCookie: late.setCookie }).toEqual({
      status: 403,
      setCookie: null,
    });
  });

  test("a wrong secret, or one of the wrong length or charset, is refused and leaves the real secret good", async () => {
    const h = await hearth();
    const secret = await mintedSecret(h);
    // A value a header cannot carry (a leading space is trimmed by fetch) is left out.
    for (const wrong of notTheSecret(secret).filter(
      (value) => value.trim() === value && value !== "",
    )) {
      const refused = await exchangeLaunch(h.hearth.url, wrong);
      expect({ wrong, status: refused.status }).toEqual({ wrong, status: 403 });
    }
    expect((await exchangeLaunch(h.hearth.url, secret)).status).toBe(200);
  });

  test("a launch header sent twice, the real secret in both, is refused and the secret spent", async () => {
    const h = await hearth();
    const secret = await mintedSecret(h);
    const twice = await rawRequest(h.hearth.port, "POST", SESSION_ROUTE, [
      `Origin: ${h.hearth.url}`,
      `${LAUNCH_HEADER}: ${secret}`,
      `${LAUNCH_HEADER}: ${secret}`,
    ]);
    expect(twice.status).toBe(400);
    expect(twice.head.toLowerCase()).not.toContain("set-cookie");
    expect((await exchangeLaunch(h.hearth.url, secret)).status).toBe(403);
  });
});

describe("GET /token with a session", () => {
  test("the session a launch link gave is served the token; the secret it came from is not a session", async () => {
    const h = await hearth();
    const secret = await mintedSecret(h);
    const cookie = cookiePair(
      (await exchangeLaunch(h.hearth.url, secret)).setCookie,
    );
    expect(await tokenWith(h.hearth.url, h.hearth.token, cookie)).toEqual({
      status: 200,
      token: true,
      error: null,
    });
    const name = sessionCookieName(h.home, h.root);
    expect(
      await tokenWith(h.hearth.url, h.hearth.token, `${name}=${secret}`),
    ).toEqual({ status: 401, token: false, error: NO_SESSION_ERROR });
  });

  test("a session survives a restart of the hearth, which serves it the token it minted; an expired session is refused", async () => {
    const time = clock();
    const home = temp("af-launch-home-");
    const root = temp("af-launch-root-");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".tmp", "work"), { recursive: true });
    const started = async (): Promise<StartedHearth> => {
      const h = await createHearth({
        root,
        home,
        environment: {},
        launchNow: time.now,
      });
      if (h.kind !== "started") throw new Error("expected a fresh hearth");
      return h;
    };
    cleanup.push(() => closeLedger(join(home, "ledger.db")));
    const first = await started();
    let cookie: string;
    try {
      const minted = await mintLaunch(first.url, first.token);
      cookie = cookiePair(
        (await exchangeLaunch(first.url, String(minted.body.data?.["secret"])))
          .setCookie,
      );
    } finally {
      await first.close();
    }
    const second = await started();
    try {
      expect(second.token).not.toBe(first.token);
      expect(await tokenWith(second.url, second.token, cookie)).toEqual({
        status: 200,
        token: true,
        error: null,
      });
      time.set(time.start + SESSION_TTL_MS);
      expect(await tokenWith(second.url, second.token, cookie)).toEqual({
        status: 401,
        token: false,
        error: NO_SESSION_ERROR,
      });
    } finally {
      await second.close();
    }
  });

  test("a session of another root's hearth, with that hearth's cookie name or this one's, is not a session here", async () => {
    const one = await hearth();
    const two = await hearth();
    const [name, value] = (
      await (async () => {
        const secret = await mintedSecret(two);
        return cookiePair(
          (await exchangeLaunch(two.hearth.url, secret)).setCookie,
        );
      })()
    ).split("=");
    for (const cookie of [
      `${name}=${value}`,
      `${sessionCookieName(one.home, one.root)}=${value}`,
    ])
      expect(await tokenWith(one.hearth.url, one.hearth.token, cookie)).toEqual(
        { status: 401, token: false, error: NO_SESSION_ERROR },
      );
  });
});

describe("what is written", () => {
  test("no launch secret, session value or token appears in the ledger, the audit rows, the sessions file, or anything written to stdout, stderr or the console", async () => {
    const h = await hearth();
    const written: string[] = [];
    const restore: Array<() => void> = [];
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      // justification: a spy that records every chunk and passes it on, whatever overload was called.
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        written.push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restore.push(() => {
        stream.write = original;
      });
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const original = console[method];
      console[method] = (...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      };
      restore.push(() => {
        console[method] = original;
      });
    }
    let secret = "";
    let value = "";
    try {
      secret = await mintedSecret(h);
      const exchanged = await exchangeLaunch(h.hearth.url, secret);
      value = cookiePair(exchanged.setCookie).split("=")[1] ?? "";
      await tokenWith(
        h.hearth.url,
        h.hearth.token,
        cookiePair(exchanged.setCookie),
      );
      // A refusal of each kind too.
      await exchangeLaunch(h.hearth.url, secret);
      await mintLaunch(h.hearth.url, "0".repeat(64));
    } finally {
      for (const undo of restore) undo();
    }
    expect(secret).toMatch(HEX_256);
    expect(value).toMatch(HEX_256);
    const ledger = [h.ledger, `${h.ledger}-wal`]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, "latin1"))
      .join("");
    const places = {
      ledger,
      audit: JSON.stringify(h.events()),
      sessions: readFileSync(sessionsPath(h.home, h.root), "utf8"),
      output: written.join("\n"),
    };
    for (const [place, text] of Object.entries(places))
      for (const [what, held] of Object.entries({
        secret,
        value,
        token: h.hearth.token,
      }))
        expect({ place, what, found: text.includes(held) }).toEqual({
          place,
          what,
          found: false,
        });
    // The ledger was written: the scan above read the rows it holds.
    expect(h.events(["operator.action"]).length).toBe(2);
  });
});
