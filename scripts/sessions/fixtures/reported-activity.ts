/** Synthetic first-party-format packets only. No provider, file, tool or network is invoked. */
export const claudeReportedActivity = [
  {
    type: "assistant",
    uuid: "reasoning",
    message: {
      id: "reasoning",
      content: [
        {
          type: "thinking",
          thinking: "Private reported reasoning",
          signature: "opaque-never-retain",
        },
        { type: "redacted_thinking", data: "encrypted-never-retain" },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "bash-input",
    message: {
      id: "bash-message",
      content: [
        {
          type: "tool_use",
          id: "bash-activity",
          name: "Bash",
          input: { command: "echo private command" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "bash-output",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "bash-activity",
          content: "Private tool result",
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      stdout: "Private command output",
      stderr: "Tool notice",
      interrupted: false,
    },
  },
  {
    type: "assistant",
    uuid: "edit-input",
    message: {
      id: "edit-message",
      content: [
        {
          type: "tool_use",
          id: "edit-activity",
          name: "Edit",
          input: {
            file_path: "private.ts",
            old_string: "old",
            new_string: "new",
          },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "edit-output",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "edit-activity",
          content: "Edit reported",
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      filePath: "private.ts",
      gitDiff: {
        filename: "private.ts",
        status: "modified",
        patch: "-Private old\n+Private new",
        additions: 1,
        deletions: 1,
        changes: 2,
      },
    },
  },
  {
    type: "assistant",
    uuid: "todo-input",
    message: {
      id: "todo-message",
      content: [
        {
          type: "tool_use",
          id: "todo-activity",
          name: "TodoWrite",
          input: {
            todos: [
              {
                content: "Private plan",
                status: "in_progress",
                activeForm: "Planning",
              },
            ],
          },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "todo-output",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "todo-activity",
          content: "Plan reported",
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      oldTodos: [],
      newTodos: [
        {
          content: "Private plan",
          status: "in_progress",
          activeForm: "Planning",
        },
      ],
    },
  },
  {
    type: "rate_limit_event",
    uuid: "rate",
    rate_limit_info: {
      status: "allowed_warning",
      utilization: 0.75,
      resetsAt: 123,
    },
  },
  {
    type: "assistant",
    uuid: "usage",
    message: {
      id: "usage-message",
      content: [{ type: "text", text: "Private usage report" }],
    },
    usage_report: {
      session: { total_cost_usd: 0.5 },
      rate_limits: {
        limits: [
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 75,
            resets_at: "2026-10-30T08:00:00Z",
            severity: "warning",
            is_active: true,
          },
        ],
        extra_usage: null,
      },
    },
  },
];
export const codexReportedActivity = [
  {
    type: "item.completed",
    item: {
      id: "reasoning",
      type: "reasoning",
      text: "Private reported reasoning",
    },
  },
  {
    type: "item.started",
    item: {
      id: "command",
      type: "command_execution",
      command: "echo private command",
      aggregated_output: "",
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "command",
      type: "command_execution",
      command: "echo private command",
      aggregated_output: "Private command output",
      status: "completed",
      exit_code: 0,
    },
  },
  {
    type: "item.completed",
    item: {
      id: "files",
      type: "file_change",
      changes: [{ path: "private.ts", kind: "update" }],
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "tool",
      type: "mcp_tool_call",
      server: "fixture",
      tool: "read",
      arguments: { path: "private.ts" },
      result: {
        content: [{ type: "text", text: "Private tool result" }],
        structured_content: { actual: true },
      },
      status: "completed",
    },
  },
  {
    type: "item.updated",
    item: {
      id: "plan",
      type: "todo_list",
      items: [{ text: "Private plan", completed: false }],
    },
  },
];
