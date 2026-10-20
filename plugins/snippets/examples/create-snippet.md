---
aliases: [new-snippet]
description: Create a reusable snippet using the plugin conventions
---
<append>
<task>
Create a reusable snippet file from the request in this message, then check
that it loads. If the message gives no request, ask what the snippet should
do and create nothing. Otherwise settle the routine choices (name, aliases,
kind, location) yourself and state them in your reply.

Inspect first:
- Locate the loaded omp-snippets package, installed copy or checkout, for
  example by finding this snippet's own file, create-snippet.md, in its
  examples/ folder; use the actual path. Read only its README sections
  "Snippet, pin, or role?" and "Authoring your own snippets" (plus
  "Authoring a role" for a role). Then open the bundled examples/ file
  nearest to your target: verify for a one-shot, concise or careful for a
  pin, max-chars for a parameter, bluf for a group. No role ships. If these
  cannot be read, say so and rely on this prompt alone.
- List the snippets that already exist: the package's examples/, the
  personal folder (normally ~/.omp/agent/snippets/), and the project's
  .omp/snippets/. Match any local conventions you find there.

Choose the kind:
- One-shot (default): an instruction for the message where it is typed.
- Pin: a standing style or working preference. It is re-sent every turn
  until unpinned, stacks with other pins, and lasts only this omp process.
  Set `pinnable: true` and `category: style` (presentation) or
  `category: behavior` (diligence, approval, evidence). Add a `group` only
  for pins that would contradict each other. A pin must never waive
  verification, completion, or safety requirements.
- Role: one standing operational assignment for the main conversation. The
  user selects it, only one is active at a time, and it is saved with the
  session. Set `kind: role`. It takes no arguments and cannot be pinnable or
  grouped. State what it owns and where it stops; it grants no permissions.
  Only `kind: role` makes a role; `category: role` merely tints a pin.
Unless the request asks for standing behavior, write a one-shot and mention
how it could become a pin. Omit `guard` unless the user explicitly asks for
the enforced read-only Q&A mode.

Write the file:
- Save it in the project's .omp/snippets/ (under the working directory;
  create it if needed), or in the personal folder only when the user asks
  for a personal snippet. Write no other file. Project snippets are shared
  through the repository, so keep secrets and machine-specific paths out.
- The file name without .md is the canonical name: short, lowercase
  letters, digits, and hyphens, and never pin, unpin, pins, or unrole. Add
  one or two short aliases only if they help.
- Never overwrite a file, and never silently take over a name or alias that
  any tier already uses. On a collision choose another name, or ask when
  the user plainly wants a replacement.
- Frontmatter is read line by line, not as full YAML: one plain key: value
  per line, no trailing comments. Always give a description of one plain
  line, at most 60 characters. Add aliases only if you chose any, as a
  one-line bracketed list.
- Body: one append block (an append tag pair) holding a task block (a task
  tag pair) with the instruction. Except for a role, add one short plain
  line after the block to stand in for the trigger in the message. Tags are
  read literally and cannot nest, so write no append, prepend, or inject
  tag anywhere else in the file.
- Write imperative, specific text: what to do, what to leave alone, what the
  output looks like. Keep it as short as the behavior allows.
- Add a parameter only if the user wants one; the message around the
  trigger is already available, so most snippets need none. Use the first
  numbered argument placeholder as max-chars does, and say what applies
  when it is blank: a bare trigger, the picker, and a plain pin all supply
  it blank.
- Keep triggers (two colons and a name) out of the body: a registered one
  expands when the snippet does. Compose another snippet by reference only
  on purpose, as bluf-insight does. A dollar sign followed by digits, an at
  sign, or the word ARGUMENTS is read as an argument placeholder.

If you cannot write files here (a pinned Q&A guard blocks writes, for
example), show the complete file and its path instead of working around it.

Then check it:
- Read the file back: fields as intended, exactly one append block, no
  stray tags, no unintended triggers or placeholders.
- Check the loaded behavior. If you can run the package's own registry and
  expansion code (an installed copy may not run outside omp), confirm that
  the name and every alias resolve to the new file with no definition
  problems, then check by kind. A one-shot swaps its plain line in for the
  trigger, keeps the surrounding text, and appends the new task block once,
  with nothing from other snippets. A pin's stored text is the new task
  block once; a blank parameter must fall back to its stated default. A
  role is never expanded inline: confirm that its body extracts and that
  its bare name selects it. If you cannot run the code, say so. Files
  reload on every trigger, so no restart is needed.
- This checks mechanics, not obedience. Snippet text is an instruction, not
  enforcement or automatic execution; never say a model will always follow
  it.

Reply with the file path, the kind, the name and any aliases, how to use it
(the trigger; for a pin, how to pin and unpin it and its default; for a
role, the bare name and how to clear it), and what you checked and could not
check. A pin or role stays off until the user turns it on.
</task>
</append>

Create a snippet from this request:
