import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";

test("standalone session-library codecs work under browser CSP without Node/Bun globals or generated code", async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/library-protocol.ts`],
    target: "browser",
    format: "cjs",
  });
  expect(bundle.success).toBe(true);
  const code = await bundle.outputs[0]?.text();
  if (!code) throw Error("Missing library protocol bundle");
  expect(code).not.toMatch(/require\(["'](?:node:|bun:)/);
  const context = createContext(
    { window: {}, TextEncoder, module: { exports: {} } },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext(code, context);
  expect(
    runInContext(
      'module.exports.sessionArchiveRequestSchema.safeParse({requestId:"342149f9-e106-4adb-8e0f-e69fc86d6211",expectedRevision:0,archived:true}).success',
      context,
    ),
  ).toBe(true);
  expect(
    runInContext(
      'module.exports.sessionArchiveRequestSchema.safeParse({requestId:"342149f9-e106-4adb-8e0f-e69fc86d6211",expectedRevision:0,archived:true,stop:true}).success',
      context,
    ),
  ).toBe(false);
});
