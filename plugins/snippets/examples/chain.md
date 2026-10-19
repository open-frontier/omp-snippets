---
aliases: [chain, pipe, then]
description: Run the following steps as an ordered pipeline
---
<append>
<task>
The text following this snippet describes a multi-step workflow. Execute it as an ordered pipeline using native omp tools:

1. State the steps as a short numbered plan before starting, then run them strictly in sequence — never reorder, skip, or merge steps.
2. Feed each step's result forward as the input/context to the next: the final step's output is the answer; earlier steps are intermediate.
3. For any step marked to run off the main thread, delegate it via the task tool — `scout` for read-only research, `task` for anything that edits — and fold back only the distilled result, not the full trace, before continuing the chain.
4. If a step is genuinely ambiguous, ask before running it rather than guessing.
</task>
</append>

Execute the following as an ordered pipeline.
