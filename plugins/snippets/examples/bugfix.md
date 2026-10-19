---
aliases: [bugfix, bug-fix, fixbug]
description: Delegate this bug fix to a background subagent
---
<append>
<task>
The user's text following this snippet is a concrete bug report related to the current work.

Use the current thread's understanding to isolate the bug, then delegate one bounded implementation task to a `task` subagent via the native task tool — the call returns immediately with a handle for the dispatched work. Give the subagent only bug-specific context—not a recap of the conversation—including:

- the user-observed behavior, treated as ground truth
- the expected invariant or behavior
- the likely files, symbols, and ownership boundary
- relevant constraints and non-goals
- targeted reproduction and verification requirements

Do not create or transition a spec without explicit user approval. Do not ask questions that repository state or existing context can answer. Avoid assigning yourself and the subagent overlapping edits while the task runs.

Report the handle the dispatch returned, immediately resume the prior topic, and integrate the result when it arrives. Before calling the bug fixed, review the subagent's changes and verify the reported behavior on the actual affected surface.
</task>
</append>

Delegate this related bug fix in the background, then resume the prior work.
