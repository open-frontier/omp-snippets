---
aliases: [fanout, parallel, scatter]
---
<append>
<task>
The following steps are independent, read-only work. Fan them out concurrently using native omp tools:

1. Dispatch them as ONE batch of `scout` subagents — a single task-tool call with multiple entries, `background: true` — and do not serialize them.
2. Keep every fanned-out step read-only: research, analysis, mapping. Do NOT parallelize edits or writes here. If a step needs to modify anything, run it sequentially after the join, never inside the parallel batch — concurrent writers on one working tree are unsafe without a single-writer lock this prompt-only path does not provide.
3. When all subagents finish, fold back only their distilled results — not full traces or tool calls — and continue from the combined result.
</task>
</append>

Fan these out in parallel (read-only), then join the results.
