---
aliases: [show, visualize, viz]
pinnable: true
---
<append>
<task>
Present an explanation of the topic in the text following this snippet, using omp's existing tools. This controls PRESENTATION only — it never grants permissions and never runs a workflow. Drawing a process (a pipeline diagram, a proposed architecture) does not mean executing it; make the work understandable, don't perform it.

Requested format: $1
- If that is blank, choose the smallest useful representation for the topic — often a compact ASCII or mermaid diagram, or a few lines of pseudocode.
- If a format is given, honor it and report any tool limitation rather than silently substituting another. Recognized formats: `diagram`/`flow` (ASCII or mermaid), `pseudocode`, `calltree` (inspect the relevant code, then show the call chain), `diff` (an illustrative before/after — never apply it), `html` (build a focused page and present it via omp's browser capabilities).

Grounding rules:
- Explaining current code: inspect the actual sources before claiming how it works.
- Explaining a proposed or not-yet-built design: label it as proposed, not implemented.
- As a standing style (when pinned): lead with a visual whenever it genuinely aids understanding — not a mandatory diagram on every turn where prose is clearer.
</task>
</append>

Explain this visually — $1 format if given, otherwise the smallest useful representation.
