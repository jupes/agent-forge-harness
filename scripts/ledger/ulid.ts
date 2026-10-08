/**
 * ULIDs: 26 Crockford base32 characters — 48 bits of time, then 80 of
 * randomness. Hand-written because the harness takes no dependency for it.
 *
 * Monotonic within a process: ids minted in the same millisecond (or after the
 * clock stepped back) increment the previous random part instead of drawing a
 * new one, so mint order and sort order agree.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS));
  return Array.from(bytes, (byte) => byte % 32);
}

/** The digits plus one, or null when every digit was already at its maximum. */
function increment(digits: readonly number[]): number[] | null {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  return null;
}

/** A new ULID for the given epoch milliseconds (default: now). */
export function ulid(now: number = Date.now()): string {
  const time = Math.max(0, Math.floor(now));
  if (time > lastTime) {
    lastTime = time;
    lastRandom = freshRandom();
  } else {
    const bumped = increment(lastRandom);
    if (bumped) {
      lastRandom = bumped;
    } else {
      // The random space of this millisecond is spent: move to the next one.
      lastTime += 1;
      lastRandom = freshRandom();
    }
  }
  return (
    encodeTime(lastTime) +
    lastRandom.map((digit) => ALPHABET.charAt(digit)).join("")
  );
}
