/** Scan valid JSON iteratively so decoded duplicate names are rejected before route validation. */
export function hasDuplicateObjectKeys(source: string): boolean {
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
