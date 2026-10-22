import { isMain } from "../../is-main";
import { createConversationService } from "../service";

async function main(): Promise<void> {
  const [home, root, projectId, requestId] = process.argv.slice(2);
  if (!home || !root || !projectId || !requestId)
    throw new Error("Missing private fixture arguments");
  const service = createConversationService({
    home,
    root,
    transport: {
      provider: "claude",
      async run(_request, persist, signal) {
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: "fixture-external-owner",
          version: "fixture-1",
        });
        await persist({
          kind: "text",
          text: "Partial output from the other process",
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        return { phase: "completed", reason: null };
      },
    },
  });
  await service.send(projectId, {
    requestId,
    expectedRevision: 0,
    text: "Fixture turn",
    about: [],
  });
  await service.settled(projectId);
  await service.close();
}

if (isMain(import.meta)) await main();
