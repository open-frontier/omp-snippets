# Snippets (`::name`)

A native [omp](https://github.com/oh-my-pi) extension for composable prompt-fragment expansion. Type `::name` anywhere in a message to expand a reusable instruction fragment — chain several in one message, pass arguments, or `::pin` one so it stays active every turn for the rest of the session. A snippet marked `kind: role` is different: typing its bare name selects one standing operational role for the main conversation (`::unrole` clears it).

The `::name` trigger concept, the `aliases:` frontmatter convention, and the `<prepend>/<append>/<inject>` body schema originate from [JosXa/opencode-snippets](https://github.com/JosXa/opencode-snippets); this extension's block-parsing/expansion engine is a direct algorithmic port of that project's `expander.ts`, not an independent reimplementation. See [Credits](#credits) below for exactly what's ported vs. original, and `THIRD_PARTY_NOTICES.md` for the license text that porting obligates.

Not a slash command (`/name` must be the first token, one per message) — `::name` works inline, anywhere in your prose, and composes.

## Quick start

```
::careful implement the retry logic
::careful ::concise implement the retry logic
::reflect(the user's actual request)
::reflect<<
Everything in this block is what I want reflected on,
parens (like this) and all — no escaping needed.
>>
```

Typing `::` opens a live filterable picker below the editor — you don't need to memorize names. Keep typing to filter, `Tab`/`Enter` to accept, `↑`/`↓` to cycle, `Escape` to cancel. A role snippet (`kind: role`) is selected the same way but takes effect on submit: accepting the row inserts `::role-name`, and submitting the message selects that role (see [Roles](#roles--role-name-and-unrole)).

## Snippet, pin, or role?

Every `::` trigger is one of three kinds:

| | Snippet | Pin | Role |
|---|---|---|---|
| Use for | A one-off instruction | A standing style or policy | A standing operational assignment |
| Activate | `::name` or `::name(args)` | `::pin(name)`, `::unpin(name)`, or `Right` in the picker | Bare `::name`; `::unrole` clears |
| Lasts | That message | Every turn until unpinned; this process only | Every turn until cleared; saved in the session and restored on resume/branch |
| How many | Any number per message | Any number (`group` members replace each other) | One at a time |
| Arguments | Yes | Yes | No |
| Reaches the model as | Expanded text in your message | `<pinned-styles>` in the system prompt | `<operational-role>` in the system prompt |
| Enforced | No | No, except `q&a`, which blocks non-read-only tool calls | No; never overrides safety, approvals, or Plan mode |
| Defined by | Any snippet file | `pinnable: true` | `kind: role` |
| Bundled examples | `reflect`, `verify`, `subagent` | `concise`, `careful`, `bluf`, `q&a` | None; write your own |

Details: [Pins](#pins--pinname--unpinname--pins), [Roles](#roles--role-name-and-unrole), [Q&A-only guard](#qa-only-guard-guard-qa). Slash commands and skills are compared [below](#snippets-vs-skills-vs-slash-commands).

## Arguments — `::name(args)` vs `::name<<...>>`

Two ways to bind `$1`/`$2`/`$@`/`$ARGUMENTS` in a snippet body:

- **`::name(args)`** — shell-style tokenizing (space-separated, `"quoted strings"` preserve spaces), so `$1`, `$2`, ... are separate positional values. Good for short, structured arguments. Breaks if the content itself contains an unescaped `)`, and gets unreadable across multiple lines. **Any unpaired `'` or `"` also opens a quote silently** — a plain English contraction (`it's`, `doesn't`) or a stray quotation mark starts an unterminated quote that swallows everything after it into one token and drops the quote character entirely. Avoid `(args)` for natural-language prose; use `<<...>>` instead.
- **`::name<<...>>`** — the entire bracketed span is taken verbatim as a single value bound to `$1`/`$ARGUMENTS` — no tokenizing, no escaping, free to contain parens/quotes and span multiple lines/paragraphs. Use this when the argument is prose, not a short token list — e.g. reflecting on a specific block of your own message rather than the whole thing.
  - One bracketed span can feed a **chain** of triggers stacked immediately before it: `::reflect::tradeoff<<the plan above>>` calls both with the same argument, same as how bare `::a ::b` already compose.
  - The trigger chain must sit immediately before `<<` (whitespace allowed, nothing else) — this is what keeps `<<` from ever colliding with its ordinary meanings in pasted code (bit-shift `<<`, heredocs, git conflict markers): none of those are preceded by a `::name` token, so they're never touched.
  - Matches the *first* `>>` — content containing its own `>>` (e.g. pasted `Foo<Bar<Baz>>`) closes the bracket early. Same no-nesting tradeoff as `<prepend>`/`<append>`/`<inject>` snippet-body blocks.
  - An unclosed `<<...` falls back to expanding the bare trigger name and leaves the dangling `<<` as literal text, same as an unclosed `(` does today.
  - Content is expanded recursively, so a nested `::name` typed inside an argument (either form) still expands normally once submitted — e.g. `::subagent<<go check whether ::careful should apply here>>` expands `::careful` too, as long as the outer snippet's body actually places the argument somewhere in its output.
  - The live picker is suppressed while an argument span is still open (no closing `)` or `>>` typed yet) — otherwise autocompleting a nested trigger name would hijack Tab/Enter/arrow keys away from the text you're composing.

Roles are the one exception to both forms: `::role-name(args)` and `::role-name<<...>>` are unsupported and never activate a role — role selection accepts bare names only (see [Roles](#roles--role-name-and-unrole)). When the name in the wrapper is a recognized, selectable real role — canonical, alias, case variant, or an `&`/phrase name — that recognized span remains literal in the text being processed, preserving its characters as present there; an unclosed `(` or `<<` span runs to the end of that text, following the existing scanner rules. Whenever recognized, the span remains inert through the role pass, the pin-preprocessing pass, both expansion passes, and every recursive rescan (spans are recomputed on each pass): its contents never pin or unpin anything, never select or clear a role, never expand an ordinary snippet, never contribute `<prepend>`/`<append>`/`<inject>` content, and a role-headed bracket chain feeds the span to no ordinary sibling — including when a complete wrapper is produced in ordinary body or argument text and recognized on a later pass, or when it sits inside a `::a::b<<...>>` chain. This is phase-local protection, not cross-phase quoting: it does not undo an expansion already completed if later, separately generated text forms only a role head/opener. Existing bracket-first ordinary expansion and `::pins`/`::unpin`/`::pin` preprocessing order are unchanged. This is intentionally narrow: reserved `::pin(...)`/`::unpin(...)`/`::pins` controls, valid top-level role commands, ordinary expansion, and explicit pin/unpin outside the protected span still execute. Only a selectable actual `kind: role` definition counts as a real role here; the display-only `category: role` label on a pin (such as `q&a`) does not subject that pin's arguments to this rule.

## Live picker

- Rows share an aligned name column, a three-space gap, and a one-line description capped at 60 code points. Narrow terminals shorten the columns without wrapping. Role-like names (real roles and `category: role` pins such as `q&a`) are fixed purple; other pinnable names are theme green; ordinary names and all descriptions retain the normal foreground. Pinnables show `☐` when inactive and `📌` when pinned. The selected row keeps its colors beside an accent caret. Categories are conveyed by ordering, not text badges.
- **Right arrow** on a highlighted pinnable row toggles its pin state in place — no text inserted, picker stays open. Excluded from the hotkey: parameterized pinnable snippets with an unbound `$1`/`$@`/`$ARGUMENTS` — there's no argument value to bind from a keypress, so those stay `::pin(name(args))` text-only.
- Rows group in three tiers, role-like rows first: real `kind: role` roles together with pinnable rows tagged `category: role`, then every other pinnable row (output styles and behavioral pins alike), then ordinary non-pinnable one-shot snippets — in every pin state and under both an empty and a typed query. Within a tier the order is category-first when the query is empty — Styles, then any other named categories alphabetically, then uncategorized snippets last — with the active row (the selected role or a pinned snippet) leading inside its category, then alphabetical. A typed query stays relevance-first inside its tier. Merely-pinnable-but-inactive snippets get no positional privilege within the pinnable tier — an unrelated active pin never buries a better match. See [Categories and picker ordering](#categories-and-picker-ordering).
- A status-bar line (`📌 name, name`) mirrors the pinned set at all times, not just while the picker is open.
- A muted hint line below the rows describes the highlighted row, since `Tab`/`Enter` only ever inserts text: `→ right arrow to toggle pin` for a pinnable row, `→ conversation role · send to select` for a role row (or `→ active conversation role · send to refresh` when it is already the active role). It appears after the `(n/total)` counter when the list overflows.

## Categories and picker ordering

`category: <label>` in frontmatter is **display/order-only** — it never changes activation, persistence, pinnability, or role selection. `style` and `styles` (case-insensitive) both bucket the row under Styles; an empty or absent label puts it with the uncategorized snippets; any other label becomes its own named group. The one other reserved value is **`role`** (singular, case-insensitive, whitespace-trimmed; `roles` is an ordinary verbatim label): on a *pinnable* snippet it makes the row a **role-like pin** — the row joins the leading role-like tier and its name renders in the same fixed purple as a real role, while the snippet still expands, pins, and unpins exactly like any other pin. On a non-pinnable snippet, `category: role` is just an ordinary grouping label: the row keeps the ordinary tier and the normal color. A real `kind: role` row is always bucketed as Role and always purple, regardless of any `category:` it declares.

```markdown
---
pinnable: true
category: role      # display-only: this PIN looks role-like (purple, top tier)
---
...                 # still expands, pins, and unpins like any other pin
```

Contrast with an actual conversation role, which is a different mechanism entirely (no pinning, selected by bare name, delivered every turn — see [Roles](#roles--role-name-and-unrole)):

```markdown
---
kind: role          # operational conversation role, not a display category
---
<append><task>You own the release cut.</task></append>
```

- **Unqueried**, rows split into three tiers, role-like first: real `kind: role` roles together with role-categorized pins, then every other pinnable row (styles and behavioral pins alike), then ordinary non-pinnable snippets. Within a tier the order is Styles, then other named categories alphabetically, then uncategorized snippets last — the role-like bucket is its own leading tier, so it never mixes with the pinnable tier; inside a category the active row (pinned snippet or active role) leads, then everything else alphabetically.
- **While filtering**, rows keep the same three role-like/pinnable/ordinary tiers; within a tier relevance ranks first — exact match, then prefix, then substring (aliases count) — then category, then active state, then alphabetically. Within a tier, an unrelated active pin cannot bury an exact match (a better match in a higher tier still leads).
- Right-arrow still toggles pins only (real `kind: role` roles are never pinnable; a role-*categorized* pin toggles like any other), and toggling never re-sorts the list, so the highlighted row stays put.

This ordering intentionally replaces the older "pinned items float to the top" rule: the tier key is *role-like* (a real role, or a pin tagged `category: role`), then *pinnable* (the row can be pinned), not *pinned* (it currently is).

## Pins — `::pin(name)` / `::unpin(name)` / `::pins`

Most snippets are one-shot: `::reflect` means "reflect on this," *right now* — re-asserting that on an unrelated later turn would be incoherent. A small set of snippets are different — they're standing behavioral/style policies (`careful`, `concise`) rather than one-time actions. Those are marked `pinnable: true` and can be pinned so their content is re-delivered to the model every turn for the rest of the session, without retyping:

```
::pin(concise)      # pins by bare name
::unpin(concise)    # removes it
::pins              # inline confirmation of what's currently pinned
```

Multiple pins compose (no forced single slot) — `::pin(careful) ::pin(concise)` holds both. The one exception: snippets sharing an opt-in `group` (see [Authoring](#authoring-your-own-snippets) below) are mutually exclusive — pinning one auto-unpins the other, with a heads-up notification, because their content is *logically* contradictory (e.g. a "state the answer first" style vs. a "never state the answer directly" style — no single response can satisfy both).

For BLUF plus useful `★ Insight` asides, select the combined style:

```
::pin(bluf-insight)
```

It references `bluf` and `explanatory` rather than copying their prompts. Use the combination or the individual pins, not both: separately pinning `explanatory` as well repeats its instruction. Insights are optional and must add something non-obvious; trivial answers need none.

Presentation styles are opt-in. The plugin does not create or modify `APPEND_SYSTEM.md`; a standing rule supplied there is independent of pins and cannot be disabled by unpinning a style.

### How pins reach the model

Every turn, `before_agent_start` wraps all currently-pinned content into one `<pinned-styles>` block and appends it to the system prompt — nothing is engine-persisted; the extension rebuilds this from its own pin map on every single call, from scratch. The block opens with a fixed preamble that scopes what a pin is allowed to influence:

> The following are session-scoped presentation preferences the user explicitly turned on via `::pin`. They govern HOW you phrase, format, and size responses — never WHAT you must verify, complete, or ship. Every contract, completeness, and yielding requirement defined earlier in this prompt remains fully in force regardless of any preference below.

That's why pinning `concise` can't be used to quietly skip verification, or `max-chars` to truncate a correctness-relevant detail — the preamble draws that line once, at the mechanism level, so individual snippet bodies don't each have to restate it.

`confirm-first` and Q&A are exceptions to the HOW-only framing. `confirm-first` is an advisory instruction to wait for approval; it does not intercept tools. Q&A (`q&a`) instead declares the [Q&A-only guard](#qa-only-guard-guard-qa): while pinned, it blocks non-read-only tool calls until explicit unpinning, regardless of prose approval.

### Q&A-only guard (`guard: qa`)

Q&A (`q&a`) is the one bundled pin that is *enforced*, not merely advised. Its frontmatter declares `pinnable: true` and `guard: qa`. While any active pin snapshot carries that guard, the extension blocks non-read-only `tool_call` events before execution. The `🛡 Q&A-only · <names>` status line shows the active guard, and a separate `<qa-enforcement>` block follows `<pinned-styles>` in the system prompt without changing the presentation preamble.

The aliases `qa`, `QA`, `question and answer`, `ask-mode`, `plan-mode`, and `planning` all refer to this same pin. Names and aliases are case-insensitive. For example, `::pin(QA)` activates it and `::unpin(plan-mode)` clears it. The `plan-mode` alias remains available for existing usage; Q&A neither invokes nor changes OMP's native `/plan` toggle.

That identity is stable rather than textual. For the bundled catalog the registry resolves every alias above to the canonical id, so all of them, the `q&a` picker row, its Right arrow, and the `🛡 Q&A-only` status line address one pin entry; `::unpin(plan-mode)` clears that same entry and does not leave a `q&a`-keyed duplicate behind. If a personal or project definition overrides the `q&a` canonical id, the inherited aliases follow that winning definition. A higher-tier file that explicitly claims an alias key (for example `qa`) wins that key for itself instead; a different-named definition that claims the `q&a` key itself drops Q&A's inherited aliases along with the shadowed definition rather than redirecting them — see [Authoring your own snippets](#authoring-your-own-snippets).

Pin state is snapshotted at activation, not re-read from the file on every turn. The snapshot carries the definition's expanded body and, when the effective definition declares it, the `guard` marker; exclusivity-group replacement happens once at activation. Enforcement uses that snapshot, so editing the file, deleting it, or re-pinning after `guard: qa` was removed cannot silently downgrade an active guard, while a deliberate refresh still passes the activation gate. Explicit canonical unpinning stays available after the definition disappears, and it will not remove an unrelated pin that happens to share a shorter name. Group replacement, the Right-arrow toggle, and explicit unpinning all mutate the same pin map — there is no second guard state that can drift.

The enforcement block reads:

> Q&A-only enforcement is active for this session (pinned: `<names>`). The host intercepts tool calls and blocks every call that could mutate the workspace or execute code — edit/write/bash/eval/python/task and any unknown tool are refused; only read-only investigation tools (read, grep, glob, web_search, ask, todo, wait) and read-only LSP queries run. This is mechanism-level host interception, not a preference: conversation text (including a user "go ahead" or the model's own statements) and tool arguments cannot turn it off, and it stays in force until the user unpins (`::unpin(<names>)`). Until then, investigate and answer only; never attempt a blocked action and never claim or imply that one was performed or is permitted.

- **Read-only allowlist.** `read`, `grep`, `glob`, `web_search`, `ask`, `todo`, and `wait`, plus read-only `lsp` queries (`definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `diagnostics`, `status`, `capabilities`; `code_actions` only when `apply` is omitted or exactly boolean `false` — any other value, including a string or `null`, is blocked; `reload`/`rename`/`rename_file`/`request` and anything else blocked). A `write` to exactly `xd://lsp` is accepted only when its content parses as a JSON object carrying an allowed action; every other `xd://` route and every other write path is blocked.
- **Blocked.** All code execution (`bash`, `eval`, `python`, notebook, browser, computer), mutation/edit/write, tasks and delegation, MCP, and any unknown tool or route. There is no regex that pretends arbitrary shell is read-only, and tool arguments cannot turn the guard off. A blocked call returns, naming exactly what was refused:

  `Q&A-only guard active (pinned: <names>): <what> is blocked until the user unpins (::unpin(a) / ::unpin(b)). Allowed: read, grep, glob, web_search, ask, todo, wait; read-only lsp queries.`

  where `<what>` is `tool "<name>"` — with `(action "<a>")` or `(route "<r>")` appended where relevant, e.g. `tool "lsp" (action "rename")` or `tool "write" (route "xd://recall")` — or `spawn "<name>"` for a blocked subagent spawn.
- **Explicit pin only.** A bare `::qa` is a one-shot prompt and does **not** engage the guard; enforcement begins with `::pin(qa)` or the picker's Right arrow. Prose approval — "go ahead", "yes", "proceed" — never releases it. Exit with `::unpin(qa)` or any alias of the same pin.
- **Same lifetime as the pin.** The guard is snapshotted at activation. Editing the definition or refreshing a pin after its `guard` metadata was removed cannot downgrade an active guard; the activation gate still applies to refreshes. Explicit canonical unpinning remains available even if the definition disappears or a shorter registered name survives. Unpinning, group replacement, and the Right-arrow toggle update the same pin map, with no separate guard state to drift. Pins survive a same-process `/new`, but a restart clears them.
- **No approval-mode override.** The guard blocks regardless of a global yolo/auto-approve setting or an explicit in-message tool allow. It writes nothing to `tools.approvalMode` and never toggles native Plan/Execute mode; after you unpin, the native approval requirements are untouched — unpinning does not weaken them.
- **Activation is refused, not queued.** Pinning Q&A while the agent is working or owns running background jobs is rejected without changing state. The inline confirmation and Right-arrow warning explain whether to wait for the agent to become idle or for its jobs to finish. Hosts without readable idle/job-state APIs also refuse activation rather than assuming safety. Ordinary pins are unaffected.
- **Scope — tool interception, not a sandbox.** This is host tool interception, not OS or filesystem containment: it cannot stop user-initiated `!` shell / `$` Python, native non-tool commands, external processes, or other OMP sessions, and higher-priority system instructions remain unaffected. See [Known limitations](#known-limitations).

### Pin categories

- **Output styles** use `category: style`: formatting, verbosity, visual presentation, or answer delivery. Their names are green.
- **Behavioral pins** use `category: behavior`: `careful`, `confirm-first`, and `direct-evidence` govern diligence, approval discipline, and evidence. They remain green and sort after Styles.
- **Q&A** uses `category: role` plus `guard: qa`: a purple, leading-tier behavioral pin, not a `kind: role` conversation assignment.

Pins are process-local: they survive a same-process `/new`, but not a restart. Conversation roles have a separate persisted lifecycle.

## Roles — `::role-name` and `::unrole`

A snippet marked `kind: role` is a standing **operational role** for the main conversation, not a one-turn instruction. Submitting its bare name selects it:

```
::release-captain     # selects the role, or re-selects it to refresh
::unrole              # clears the active role
```

- **Set/refresh, never a toggle.** Submitting the same bare name again re-selects the role from the file on disk, picking up edits. Aliases resolve like any other snippet, through the effective canonical definition described under [Authoring your own snippets](#authoring-your-own-snippets). Exactly one role is active at a time; selecting another replaces it. Role actions are processed left to right in the submitted text — the last valid role or clear wins.
- **`::unrole`** is a reserved exact trigger that clears the active role (`::unrole-extra` is an ordinary snippet name, not reserved). `unrole`, `pin`, `unpin`, and `pins` are reserved trigger names. A role whose canonical name is one of them is never selectable — not under its own name, and not through any of its aliases — and stays out of the picker rather than offering a row that always refuses. The reserved check is case-insensitive, like every other trigger name.
- **Bare names only.** `::role-name(args)` and `::role-name<<...>>` are unsupported forms: they never activate a role. A wrapper recognized for a selectable real role remains literal in the text being processed; this phase-local protection does not undo an earlier expansion if later, separately generated text forms only the role head/opener (see the Arguments section above). A recognized span protects the wrapper through the role pass, the pin pass, both expansion passes, and every recursive rescan, with an unclosed span running to the end of the text. Contents such as `::pin(...)`/`::unpin(...)`, an ordinary `::snippet`, or nested role-like text stay inert and produce no injected material, and a role-headed bracket chain feeds no ordinary sibling. Only top-level submitted text counts — a `::role-name` inside a snippet body, inside a `<<...>>` argument, inside another trigger's `(...)`, or in a `::a::b<<x>>` chain stays inert, and a bare `::role-name` there is likewise not a selection. The predicate is a selectable definition's actual `kind: role`, not the display-only `category: role` label; reserved `::pin(...)`/`::unpin(...)`/`::pins` controls and valid commands outside the span still execute.
- **Not a normal expansion target.** A role never expands inline as a one-shot snippet, is not eligible for `::pin` or the picker's Right-arrow pin hotkey (even when referenced from inside another snippet), and cannot carry an exclusivity `group`.
- **Invalid definitions are diagnosed, not fatal.** Problems surface as one `Snippet definition problems:` warning per session, listing `name: problem` lines; a `pinnable` or `group` on a role is ignored with a diagnostic, an empty role body or malformed block tags hides the role from the picker and refuses it at selection, and an unknown `kind:` value is diagnosed and treated as an ordinary snippet. Unrelated snippets keep loading.
- **Status.** A persistent `Role: <name>` indicator in the status bar shows the active role, separate from the `📌` pin line.
- **Via the picker.** Role-like rows lead the list (the first tier, shared with role-categorized pins — see [Categories and picker ordering](#categories-and-picker-ordering)); `Tab`/`Enter` inserts the `::role-name` text into your message without activating it — selection happens when you submit the message, not when you accept the row (the picker's hint line reads `send to select`, or `send to refresh` when that role is already active).

### What a role does to the prompt

The active role is delivered every turn as its own `<operational-role name="...">` block appended to the system prompt **after** the `<pinned-styles>` block — the incoming native system prompt is left untouched. Selection and clear add only a short history confirmation — `(role: <name>)`, `(role cleared)`, or `(no role active)`; on a host without agent identity, or in a subagent session, a role action records `(role unavailable)` instead. The role body itself is never copied into your message. Nested ordinary `::snippets` in the role body are expanded when the snapshot is taken; nested role references stay literal.

The role block opens with a fixed preamble that scopes it: a role assigns operational responsibilities and boundaries, but it **never** overrides native instructions, safety rules, approval gates, completion requirements, or an enforced Plan/Execute mode, and it is not a subagent identity, a delegation grant, or a permission grant. Switching or clearing removes the role body from subsequent turns — there is no promise that already-generated history or model repeats are erased.

### Role lifetime

- A selection snapshot (canonical name plus the fully expanded body) is stored as a native custom entry — `pi.appendEntry("omp-snippets.role", { version: 1, role: { name, body } | null })`. Nothing is recorded on an ordinary turn: only a role action writes an entry, and clearing writes a `null` tombstone so an older role cannot be silently resurrected.
- On `session_start`, `session_switch`, `session_branch`, and `session_tree`, in-memory role state is cleared and then rebuilt from the newest role record **on the active branch** (`ctx.sessionManager.getBranch()`, not global history) — so a rewind or fork reflects the role that branch actually retained, and compaction does not drop it. `/new` starts with no role. Pins and any pending `<inject>` are untouched by this restoration.
- Resume uses the saved body even if the role file was edited or deleted since, with a non-blocking notice naming the saved role — *no matching role definition was found* or *its definition changed*, either way re-select `::<name>` to refresh. An unreadable saved record is ignored with a warning rather than resurrecting an older one.
- **Journal durability, no more.** The record rides the session's ordinary append path, so it inherits that journal's limits rather than adding any: a brand-new ordinary session stays memory-only until its first assistant message crosses the native persistence boundary, and there is no `fsync`. Selecting a role writes through `pi.appendEntry` (which returns `void`) — the extension cannot force a session to disk, so there is no crash-before-first-response or power-loss guarantee.
- **Main conversation only.** The extension gates on the documented `ctx.agent.kind`; subagent/child sessions never select, restore, or inject a role (silently, by design), and the parent session is unchanged. On a host that doesn't report the field, roles are disabled with a one-time warning — *"Roles are unavailable: this host does not report whether the session is the main agent. Snippets and styles still work."*

### Authoring a role

Roles live in the same snippet directories as everything else. The role body uses the same convention as a pin — the `<append>` block's content, else the inline text:

```markdown
---
kind: role
---
<append>
<task>
You are the release captain for this repository. Own the cut: verify the
tree is green, write the release notes, and stop before tagging until the
operator confirms.
</task>
</append>
```

Drop it in `.omp/snippets/` (project-local, shared with your team) or `~/.omp/agent/snippets/` (personal) — project-local wins on a name collision. There is no default role and no production role ships with the plugin.

## Snippets vs. skills vs. slash commands

Three different extension points in omp — not interchangeable, each with its own trigger and scope:

| | Slash commands (`/name`) | Skills (`skill://name`) | Snippets (`::name`) |
|---|---|---|---|
| Trigger | First token, one per message, typed by the user | Model reads it on its own judgment when the task matches its description | Anywhere inline, any number per message, typed by the user |
| Composable | No — one per message | Model may pull several if relevant | Yes — `::a ::b ::c` and `::pin(...)` all compose |
| Args | Yes (`$1`/`$ARGUMENTS`) | No — it's reference material, not parameterized | Yes, two forms: `(args)` and `<<...>>` |
| Persistence | One-shot | Re-evaluated by the model each time it's relevant | One-shot by default; `pinnable: true` + `::pin` re-delivers it every turn for the session, and `kind: role` is the other exception — a bare `::name` selects a persistent main-conversation role |
| Scope | Usually a full workflow/procedure | Domain knowledge/reference the model self-serves | Anything from a presentation modifier to a one-off action directive (`subagent`, `runbackground`); the HOW-not-WHAT scoping guarantee applies only to *pinned* content (see [Pins](#pins--pinname--unpinname--pins) above), while `kind: role` delivers a scoped `<operational-role>` block |
| Works outside interactive TUI | Yes | Yes | No — `::` expansion only fires from `pi.on("input", ...)`, which `omp -p` and RPC mode never call |

Examples side by side:

- Slash command: `/plan` — a deliberate, named workflow; one shot, first token only.
- Skill: no trigger typed at all — the model reads `skill://axi` on its own when a task matches its stated purpose.
- Snippet: `::careful ::concise ::pin(max-chars(280))` — three independent style modifiers stacked inline in one message, the last one also pinned so it persists for the rest of the session.
- Role snippet: `::release-captain` — selects one standing operational role for the main conversation; `::unrole` clears it.

Bottom line: reach for a slash command when you're deliberately invoking a whole procedure, a skill when you want the model to self-serve reference knowledge without you remembering it exists, and a snippet when you want to shape a response inline — a style modifier or a one-off directive — stackable and optionally sticky.

### Orchestration snippets are instructions, not a runtime

`chain`, `fanout`, `subagent`, and `bugfix` ask the model to use the current host's delegation tools. They do not implement scheduling, retries, durable execution, or tool permissions. `show` controls presentation; drawing a workflow does not execute it.

Native `workflowz` and `/wf-*` recipes belong to OMP's orchestration layer, not this plugin, and none ship in this repository. Native `workflowz` activation alongside snippet expansion has not yet been integration-verified; this release does not add a `::workflowz` alias or a Mastra bridge.

## Bundled examples

| Name | Aliases | Type | What it does |
|---|---|---|---|
| `bluf` | `bottom-line`, `tldr` | Style pin | Lead with one-sentence BLUF, then a separator and details |
| `bluf-insight` | — | Style pin | Combine BLUF with useful, non-obvious `★ Insight` asides |
| `brainstorm` | — | One-shot | Explore options together until a decision is clear |
| `bugfix` | `bug-fix`, `fixbug` | One-shot | Delegate a bounded bug fix, then resume the prior work |
| `careful` | `safe` | Behavior pin | Double-check work and clarify material ambiguity |
| `chain` | `pipe`, `then` | One-shot | Run an ordered pipeline, feeding each result into the next |
| `concise` | — | Style pin | Answer compactly in plain language without filler |
| `confirm-first` | `confirm`, `approval-first` | Behavior pin | Propose the smallest change and await approval before acting |
| `direct-evidence` | `evidence-first`, `no-praise` | Behavior pin | Ground recommendations in evidence, uncertainty, and objections |
| `drift` | — | One-shot | Compare original intent with the result and identify the smallest fix |
| `explain_fix` | `xf`, `explain-fix` | One-shot | Explain root cause and propose concrete fixes |
| `explanatory` | `insight`, `insights`, `teach` | Style pin | Add educational `★ Insight` asides only where useful |
| `fanout` | `parallel`, `scatter` | One-shot | Batch independent read-only subagents and join their findings |
| `informative` | `verbose`, `detailed` | Style pin | Explain context, reasoning, and tradeoffs thoroughly |
| `max-chars` | `char-limit`, `maxchars` | Style pin | Cap response length: `::pin(max-chars(280))` |
| `q&a` | `qa` / `QA`, `question and answer`, `ask-mode`, `plan-mode`, `planning` | Guarded pin | Stay read-only while pinned; explicitly unpin to allow changes |
| `reflect` | `reframe`, `reformulate`, `clarify` | One-shot | Identify intent and reformulate it precisely |
| `report` | `thread-report`, `status-report` | One-shot | Report current-thread status using the external report template |
| `runbackground` | — | One-shot | Run the following task in a background subagent |
| `show` | `visualize`, `viz` | Style pin | Present a grounded diagram, pseudocode, calltree, diff, or HTML view |
| `sidetrack` | `side`, `quick-thought` | One-shot | Take a brief detour, then return to the prior topic |
| `socratic` | `socrates`, `discover` | Style pin | Lead with questions rather than giving the answer directly |
| `subagent` | `delegate` | One-shot | Delegate the supplied `$1` task off the main thread |
| `tradeoff` | — | One-shot | Weigh advantages, disadvantages, and a verdict |
| `verify` | — | One-shot | Re-check the last claim against real evidence |
| `yoda` | `jedi` | Style pin | Invert prose syntax without changing code or substance |

`bluf`, `bluf-insight`, and `socratic` share `answer-delivery`: pinning one replaces the others. BLUF and Socratic answer delivery conflict; the combined style also replaces plain BLUF to avoid repeating it.

One-shot snippets remain non-pinnable and retain the normal foreground. No bundled example defines a `kind: role` conversation role; author project-specific assignments only when needed. Native `reviewer`, `scout`, and other subagents remain the specialist delegation mechanism.

These ship so `::` works immediately after install. Override any of them by
dropping a same-named `.md` into `.omp/snippets/` or `~/.omp/agent/snippets/`.

`report` reads `templates/thread-report.md` from the loaded package or checkout. That template ships with the plugin; its location is not tied to a particular home-directory installation layout.

## Authoring your own snippets

Three tiers, checked in this order (later wins on name/alias collision):

- **Bundled examples** — the definitions shipped beside the extension under
  `examples/`, lowest priority.
- **`~/.omp/agent/snippets/`** — personal snippets, available in every
  project on this machine. Same directory family as `~/.omp/agent/skills/`.
- **`.omp/snippets/`** — project snippets, checked into the repo and shared
  with your team. Same family as `.omp/extensions/`, `.omp/commands/`,
  `.omp/skills/`. Wins over a personal or bundled snippet with the same name.

Within one directory, the first file in lexicographic order wins a name or
alias key; later files cannot overwrite it. Across tiers, an explicit claim on
a key in a later tier wins that key. An inherited alias makes no independent
claim: it resolves to its canonical id (the lowercased filename stem), and
the effective definition for that id supplies the body and every metadata
field — `kind`, `pinnable`, `group`, `category`, `guard`, and `description`.
So overriding `q&a` in `.omp/snippets/` also changes what `qa`, `QA`,
`question and answer`, `ask-mode`, `plan-mode`, and `planning` resolve to; no
stale lower-tier body survives behind an inherited alias. (If a canonical key
was taken by a different-named definition, the inherited aliases are dropped
instead — see below.)

An **explicit higher-tier claim on the alias key still wins**: if a project
file declares `aliases: [qa]`, that `qa` key points at the project file, not
at the effective `q&a`. Overriding a canonical id differs from shadowing it
with another name:

- When a higher tier overrides the **same canonical id** (for example a
  project `q&a.md`), that winning definition supplies the body and every
  metadata field, and the inherited aliases re-point to it.
- When a higher tier claims a canonical key with a **different-named**
  definition (for example a `captain.md` whose `aliases` include `q&a`), that
  definition owns the key and the shadowed definition's inherited aliases are
  **dropped with it**, not redirected. No stale lower-tier object or picker
  row survives.

There is exactly one effective picker row per effective definition, labeled
with that definition's canonical id; its preview, the trigger it inserts, a
raw alias invocation, and Right-arrow pinning all agree on that definition.
Invalid higher-tier definitions are still diagnosed (`Snippet definition
problems:`); they never silently fall back to an older body that happens to
still exist in a lower tier.

Files are re-read from disk on every `::` trigger match, so changes take
effect on your very next message — no restart needed. This covers snippet
`.md` text only; editing the extension's own code (`src/snippets.ts`) is not
hot-reloaded — see [Development](#development).

Looking for more than the bundled examples? Browse or contribute to
[`community/`](./community/) — snippets shared by users, copy-paste only
(not installed automatically; see that folder's README for why).

```markdown
---
aliases: [alt-name, another-alt]
pinnable: true        # optional, default false — only for standing style/policy content
group: my-group        # optional — mutually exclusive with other pinnable
                        # snippets sharing this group (see Pins above)
description: One-line picker summary   # optional, display-only — shown beside
                        # the name in the picker instead of a body preview
kind: role             # optional — 'role' makes this a selectable operational role
                        # (see Roles above); absent means an ordinary snippet, and
                        # any other value is diagnosed and treated as ordinary
category: style        # optional — display/order-only picker grouping (see Categories);
                        # 'style'/'styles' -> Styles group, empty -> uncategorized;
                        # 'role' on a pinnable snippet -> role-like pin (purple, top tier)
guard: qa              # optional — opt-in Q&A-only guard for a pinnable snippet;
                        # blocks non-read-only tools while pinned (see Q&A-only guard)
---
<prepend>
Content spliced at the top of the visible message.
</prepend>

<append>
<task>
The main instruction. Everything inside <append> is spliced at the bottom of
the visible message when this trigger expands, AND is what gets pinned if
this snippet is `pinnable: true` and gets `::pin`'d. For a `kind: role`
snippet it is instead the role body delivered to the main conversation's
system prompt (falling back to the inline text when there is no <append>).
</task>
</append>

<inject>
Hidden context delivered as a display:false custom message for the turn —
not part of the visible prompt. Rarely needed.
</inject>

Text outside any block replaces the `::name` token inline in the visible
message (this is what appears if you just type `::name` with nothing else).
```

Names and aliases are case-insensitive. Ordinary word/hyphen names remain valid; registered names may also contain `&` or a single-spaced phrase, such as `q&a` and `question and answer`. Use those literal names after `::` or inside `::pin(...)` / `::unpin(...)`; the picker inserts the canonical name. The native controls `::pin(...)`, `::unpin(...)`, `::pins`, and `::unrole` are reserved trigger names: a bundled, personal, or project file that claims one of those names cannot shadow the control. An alias is a registry key, not a second definition. Absent an explicit higher-tier claim on that key, every surface that accepts it operates on the effective definition of its canonical id, so an alias never pins, previews, or expands a different body than the canonical name does. If a higher-tier file explicitly declares that alias, the key belongs to that file instead.

Args: `::name(args)` binds into the body via `$1`, `$2`, `$@`, `$@[start:len]`, `$ARGUMENTS` — the same convention `.omp/commands/*.md` uses. Roles take no arguments: `::role-name(args)` and `::role-name<<...>>` are unsupported and do not activate a role.

A composite can reference existing snippets rather than duplicate their prompts. `bluf-insight.md` contains `::bluf` and `::explanatory`; their `<append>` blocks are collected into its expanded and pinned text. Keep standing content in `<append>` when authoring styles for composition. References compose text, not metadata: the composite declares its own `pinnable`, `group`, `category`, and any `guard`.

## Known limitations

- **Interactive TUI only.** `::` triggers expand via `pi.on("input", ...)`, which only fires from the interactive TUI input controller — `omp -p` (print mode) and RPC mode never call it. Role selection happens at the same submitted-input seam.
- **Pins don't persist.** Session-only; a restart clears them. (Roles are the opposite: the active role is stored as a native session entry and restored on resume/branch — see [Roles](#roles--role-name-and-unrole).)
- **Roles are main-conversation only.** Selection, restoration, and injection are gated on the documented `ctx.agent.kind`; subagent/child sessions never inherit a role. On a host that doesn't report the field, roles are disabled with a one-time warning — snippets and styles keep working.
- **Live picker degrades gracefully on older omp.** The debounce timer falls back to the global `setTimeout` automatically if the running omp doesn't have `ctx.setTimeout` — no functionality lost, just not container-managed.
- **The Q&A-only guard is tool interception, not a sandbox.** It blocks plugin-visible *tool calls* (the native `tool_call` event, plus a `before_subagent_spawn` guard for the delegation paths), but it has no OS- or filesystem-level authority. In particular it does **not** hook the native user-execution paths — a user-initiated `!` shell command or `$` Python snippet runs outside the plugin's tool hooks (by design), as do native non-tool slash commands, external processes, and other OMP sessions. It also cannot stop work that was already running when the pin was set — that is why activation is refused while the session is busy rather than killing that work. It never touches `tools.approvalMode` or the native Plan/Execute mode.
- **Earlier native Tern visual check.** OMP 18.11.3 in Tern 0.9.1 was exercised with isolated HOME/agent directories at wide/light and narrow/dark viewports. The then-named `plan-mode` pin led in purple, other pins were green, ordinary names/descriptions kept the normal foreground, rows stayed aligned and single-line, and pin/unpin updated the checkbox and Q&A status without changing colors. This check predates the rename to `q&a`; it establishes the unchanged renderer's behavior, not a fresh check of the renamed trigger.
- **Q&A rename verification.** A fresh interactive OMP 18.12.1 classic-terminal session was exercised at 132 and 65 columns with isolated HOME/agent directories and explicit checkout loading. Q&A led in purple with its checkbox; styles and behavioral pins were green; ordinary snippets kept their color; descriptions aligned without wrapping. All aliases, full-phrase Tab/Enter completion, composite-style injection and exclusivity, read allowance, write blocking under yolo, prose approval, same-process `/new`, missing-definition canonical release, sticky guard refresh, spaced role aliases, and nested arguments were exercised. A scripted local provider proved plumbing and actual tool interception, not model obedience; native Tern was not rechecked in this run.
- **Verification status (Q&A-only guard and role lifecycle).** Exercised end-to-end against a live OMP 18.10.4 session (explicit yolo + per-tool allow): the QA status line appeared, real `write`/`edit`/`bash`/`eval`/`task`/unknown-tool calls (including a declared-read custom mutator and a mounted `eval`) were blocked with native guard errors and left every sentinel file unchanged, `read` still succeeded, a prose "yes" did not disable the guard, and an explicit unpin restored a temporary write with unrelated pins and the active role intact; activation was refused while an owned background job ran. The mounted `xd://lsp` `status` route was allowed while pinned — the native result was *No language servers configured for this project* (not a block) — so the route is verified as permitted, but no real language-server query was exercised. A scripted provider was used, so this proves the enforcement plumbing, not model obedience, and it is not an OS sandbox (see the bullet above). The extension's own test suite covers the guard's callback-level paths. No currently-running live session was restarted for any of this — every check ran in a fresh isolated process, so an already-open session keeps whatever extension code it loaded at startup.

## Development

```
bun install
bun run typecheck
bun test
```

The extension source (`src/snippets.ts`) carries the detailed "why" for every non-obvious implementation decision in its top-of-file doc comment.

Editing the extension **code** (`src/snippets.ts`) is not hot-reloaded: omp loads the extension once at startup, so a code change only takes effect after you restart (or otherwise reload) the running process. Snippet `.md` text is different — see [Authoring your own snippets](#authoring-your-own-snippets): those files are re-read on every `::` match, so editing them needs no restart. To run the code straight from a checkout, point omp at the extension file by absolute path:

```
omp -e /absolute/path/to/omp-snippets/plugins/snippets/src/snippets.ts
```

`-e`/`--extension` loads an extension file and is repeatable. A session started with `-e <checkout>/plugins/snippets/src/snippets.ts` runs that checkout's source; a session without it runs the installed copy — the version recorded in `~/.omp/plugins/installed_plugins.json`, whose `installPath` lies under `~/.omp/plugins/cache/plugins/`. The two are independent targets: loading a checkout changes only that process, and restarting or reloading a session keeps loading whatever target it started with — a reload does not switch a session from the installed copy to the checkout (or back). Only an explicit install/upgrade (`/marketplace upgrade`, `omp plugin install`) changes the installed copy — a running session never auto-upgrades it.

After this Q&A rename, restart a checkout-backed session before testing and re-pin the styles you want. Hot-reloading the Markdown alone cannot teach an older loaded extension the new `&` and phrase syntax. Pins remain process-local; no startup pin preset or automatic installed-package upgrade is added.

## Credits

- **[JosXa/opencode-snippets](https://github.com/JosXa/opencode-snippets)** (MIT, Copyright (c) 2025 JosXa) — origin of the `#hashtag`-trigger concept (`::name` here), the `aliases:` frontmatter convention, and the `<prepend>/<append>/<inject>` body schema. `parseSnippetBlocks`, the `BlockRecord`/`BlockCollector`/`addBlock` dedup machinery, and `expandText`'s recursive-expansion/loop-detection structure are a direct port of that project's `src/expander.ts` — not an independent reimplementation of the same idea.
- **[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)** (MIT, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük) — `parseCommandArgs`/`substituteArgs` (the `$1`/`$@`/`$ARGUMENTS` placeholder grammar) are copied near-verbatim from that package's internal `src/utils/command-args.ts`, to match `.omp/commands/*.md`'s existing argument convention exactly.
- Original to this project: the pin/exclusivity-group mechanism, the live raw-terminal-input picker, the bundled-examples loader tier, category-based picker ordering, role selection/restoration, and the regex-based frontmatter parser (`pinnable`/`group`/`kind`/`category` support).

See `THIRD_PARTY_NOTICES.md` for the full upstream license texts these portions require retaining.

## License

MIT for this project's own code — the package ships the project license at [`LICENSE`](./LICENSE), and `THIRD_PARTY_NOTICES.md` covers the two ported regions that carry their own upstream MIT copyright notices.
