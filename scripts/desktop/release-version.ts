/** Bounded SemVer 2 precedence; a leading v is accepted only as a release-tag prefix. */
export function parseReleaseVersion(value: string) {
  if (value.length > 128) return null;
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match || match[0] !== value) return null;
  const pre = match[4]?.split(".") ?? [];
  if (
    pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")
  )
    return null;
  return { core: [match[1]!, match[2]!, match[3]!], pre };
}
const numeric = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
export function compareReleaseVersions(
  left: string,
  right: string,
): number | null {
  const a = parseReleaseVersion(left),
    b = parseReleaseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    const order = numeric(a.core[i]!, b.core[i]!);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length)
    return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    return xn && yn
      ? numeric(x, y)
      : xn !== yn
        ? xn
          ? -1
          : 1
        : x < y
          ? -1
          : 1;
  }
  return 0;
}
