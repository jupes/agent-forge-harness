# Task Graph Population Prompt
# Paste this prompt to an agent to break a feature into tasks.
# Replace <FEATURE-ID> and <FEATURE-TITLE> with the actual values.

You are creating the task graph for: <FEATURE-ID> — <FEATURE-TITLE>

Read the feature details:
```bash
bd show <FEATURE-ID>
```

Break the feature into tasks following these rules:
1. Each task is a single atomic action (one function, one component, one migration, etc.)
2. Tasks should take 15-60 minutes each
3. Identify dependencies between tasks (task B requires task A)
4. Separate concerns: types first, then data layer, then logic, then UI

For each task:
```bash
bd create \
  --type task \
  --title "<verb> <object>" \
  --repo <repo> \
  --priority <value> \
  --acceptance "<acceptance criterion>"
```

Set `<value>` using `.claude/skills/beads-priority-assignment/SKILL.md`.

For dependencies:
```bash
bd dep add <task-b-id> <task-a-id>   # task B depends on task A: the later task first
```

After creating all tasks, report:
- Total tasks created: N
- Critical path: T-X → T-Y → T-Z
- Parallelizable tasks: [T-A, T-B, T-C]
