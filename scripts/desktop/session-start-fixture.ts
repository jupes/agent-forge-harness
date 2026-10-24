import { createSessionStartIdentities } from "../../apps/desktop/src/session-start-identities";

/** Each test owns its metadata storage and origin lock; no browser/account state. */
export function sessionStartFixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let tail = Promise.resolve();
  const withLock = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const prior = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const make = () => createSessionStartIdentities({ storage, withLock });
  return { storage, withLock, values, identities: make(), make };
}
