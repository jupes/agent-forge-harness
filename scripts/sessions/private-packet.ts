import { createHash } from "node:crypto";
/** Compare full bounded native JSON before clipping; object-key order is not a conflict. */
export function privatePacketHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "object" && item !== null && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    return item;
  });
  if (typeof canonical !== "string")
    throw new Error("Expected a bounded native JSON packet.");
  return createHash("sha256").update(canonical).digest("hex");
}
