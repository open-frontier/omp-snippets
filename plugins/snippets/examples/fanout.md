---
aliases: [fanout, parallel, scatter]
description: Fan out independent read-only steps, then join
---
<append>
<task>
The following steps are independent, read-only work. Fan them out concurrently using native omp tools:

1. Dispatch them as ONE batch of `scout` subagents — a single native task-tool call whose `tasks[]` array carries one `agent: scout` entry per step — and do not serialize them.
2. Keep every fanned-out step read-only: research, analysis, mapping. Do NOT parallelize edits or writes here — concurrent writers on one working tree are unsafe — so run any step that modifies anything sequentially after the join, never inside the parallel batch.
3. When all subagents finish, fold back only their distilled results — not full traces or tool calls — and continue from the combined result.
</task>
</append>

Fan these out in parallel (read-only), then join the results.
