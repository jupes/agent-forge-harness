import { queueTracker } from "../../scheduler/queue-fixture";
import type { BdIssue } from "../bd-answers";
import type { TestHearth } from "../testing";

/** In-memory export/write/queue composition; no real tracker or external process. */
export function seedProjectBeadWriteFixture(h: TestHearth): void {
  const now = new Date().toISOString();
  const issue = (id: string, project: string, epic: boolean): BdIssue => ({
    id,
    title: id,
    issue_type: epic ? "epic" : "task",
    priority: 2,
    status: "open",
    labels: [`project:${project}`],
    created_at: now,
    updated_at: now,
    ...(!epic
      ? {
          dependencies: [
            {
              issue_id: id,
              depends_on_id: `${project}-epic`,
              type: "parent-child",
            },
          ],
        }
      : {}),
  });
  h.bd.issues.set("alpha-epic", issue("alpha-epic", "alpha", true));
  h.bd.issues.set("beta-epic", issue("beta-epic", "beta", true));
  h.bd.issues.set("alpha-task", issue("alpha-task", "alpha", false));
  h.bd.issues.set("alpha-propose", issue("alpha-propose", "alpha", false));
  h.bd.answer = (args) => {
    if (args[0] === "export")
      return {
        status: 0,
        stdout: [...h.bd.issues.values()]
          .map((item) => JSON.stringify(item))
          .join("\n"),
        stderr: "",
      };
    if (
      args[0] !== "show" &&
      !(args[0] === "update" && !args.includes("--claim"))
    )
      return undefined;
    const tracker = queueTracker([...h.bd.issues.values()]);
    const answer = tracker.answer(args);
    if (args[0] === "update" && answer?.status === 0) {
      const changed = tracker.beads.get(args.at(-1) ?? "");
      const old = changed ? h.bd.issues.get(changed.id) : undefined;
      if (changed && old)
        h.bd.issues.set(old.id, {
          ...old,
          labels: changed.labels ?? [],
          metadata: changed.metadata ?? {},
        });
    }
    return answer;
  };
}
