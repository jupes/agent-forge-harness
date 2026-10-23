import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProviderLoginService } from "../login";

const [root, home, record, ready, requestId] = process.argv.slice(2);
if (!root || !home || !record || !ready || !requestId)
  throw Error("Explicit private fixture arguments required");
const service = createProviderLoginService({
  root,
  home,
  prepare: async () => ({
    command: [
      process.execPath,
      join(import.meta.dir, "console-cli.ts"),
      "hang-tree",
    ],
    cwd: root,
    env: { CONSOLE_FIXTURE_RECORD: record },
    timeoutMs: 15000,
    visible: false,
  }),
});
const receipt = await service.start("claude", requestId);
writeFileSync(ready, JSON.stringify(receipt));
await new Promise(() => {});
