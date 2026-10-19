---
aliases: delegate
description: Spawn a subagent to handle this off-thread
---
<append>
<task>
Spawn a sub-agent to handle the following on its own, off the main thread: $1

Pick the most suitable subagent type (scout for read-only research, task for anything that edits). Dispatch it with the native `task` tool: the call returns immediately with a handle for the dispatched work, so it doesn't block the main conversation or dilute it with intermediate steps. When it finishes, report back only the distilled result - not its full trace or tool calls - and fold that back into the main thread's context.
</task>
</append>

Subagent: $1
