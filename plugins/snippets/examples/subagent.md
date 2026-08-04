---
aliases: delegate
---
<append>
<task>
Spawn a sub-agent to handle the following on its own, off the main thread: $1

Pick the most suitable subagent type (scout for read-only research, task for anything that edits). Prefer `background: true` / an isolated task so this doesn't block or dilute the main conversation with its intermediate steps. When it finishes, report back only the distilled result - not its full trace or tool calls - and fold that back into the main thread's context.
</task>
</append>

Subagent: $1
