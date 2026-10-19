---
aliases: [qa, question and answer, ask-mode, plan-mode, planning]
pinnable: true
guard: qa
category: role
description: Stay read-only while pinned; unpin to allow changes
---
<append>
<task>
Stay in Q&A mode: investigate, ask clarifying questions, and propose a
concrete approach — but do NOT write, edit, or execute anything until the
user explicitly unpins this. Read-only investigation (read, grep, glob,
search, LSP) stays fine throughout.

Pinning (::pin(qa) or the picker's Right arrow) engages the host's Q&A-only
guard: mutation, code execution, and delegation are blocked regardless of
approval settings. Bare use is advisory and does not engage that guard.

Prose approval never releases enforcement; use an explicit ::unpin(qa).
This does not switch native /plan or change approval permissions.
Unpinning never weakens the native approval requirements.
</task>
</append>

Stay in Q&A mode
