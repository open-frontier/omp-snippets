# Snippets (`::name`)

A native [omp](https://github.com/oh-my-pi) extension for composable prompt-fragment expansion. Type `::name` anywhere in a message to expand a reusable instruction fragment — chain several in one message, pass arguments, or `::pin` one so it stays active every turn for the rest of the session.

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

Typing `::` opens a live filterable picker below the editor — you don't need to memorize names. Keep typing to filter, `Tab`/`Enter` to accept, `↑`/`↓` to cycle, `Escape` to cancel.

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

## Live picker

- Rows are color-coded: plain text for one-shot snippets, **green** for pinnable-but-inactive, **amber** for pinnable-and-currently-pinned, accent for whichever row is selected.
- **Right arrow** on a highlighted pinnable row toggles its pin state in place — no text inserted, picker stays open. Excluded from the hotkey: parameterized pinnable snippets with an unbound `$1`/`$@`/`$ARGUMENTS` — there's no argument value to bind from a keypress, so those stay `::pin(name(args))` text-only.
- Currently-pinned items float to the top; merely-pinnable-but-inactive ones sort inline with everything else (no positional privilege just for being pinnable).
- A status-bar line (`📌 name, name`) mirrors the pinned set at all times, not just while the picker is open.

## Pins — `::pin(name)` / `::unpin(name)` / `::pins`

Most snippets are one-shot: `::reflect` means "reflect on this," *right now* — re-asserting that on an unrelated later turn would be incoherent. A small set of snippets are different — they're standing behavioral/style policies (`careful`, `concise`) rather than one-time actions. Those are marked `pinnable: true` and can be pinned so their content is re-delivered to the model every turn for the rest of the session, without retyping:

```
::pin(concise)      # pins by bare name
::unpin(concise)    # removes it
::pins              # inline confirmation of what's currently pinned
```

Multiple pins compose (no forced single slot) — `::pin(careful) ::pin(concise)` holds both. The one exception: snippets sharing an opt-in `group` (see [Authoring](#authoring-your-own-snippets) below) are mutually exclusive — pinning one auto-unpins the other, with a heads-up notification, because their content is *logically* contradictory (e.g. a "state the answer first" style vs. a "never state the answer directly" style — no single response can satisfy both).

Pins are session-only: they don't persist to disk and don't survive a restart.

## Bundled examples

| Name | Aliases | Pinnable | What it does |
|---|---|---|---|
| `bluf` | `bottom-line`, `tldr` | yes | Lead with the one-sentence conclusion before any setup |
| `brainstorm` | — | no | Back-and-forth exploration until a decision; don't stop at the first idea |
| `careful` | `safe` | yes | Step-by-step, double-check work, ask when ambiguous |
| `concise` | — | yes | Terse, no fluff, no hedging |
| `drift` | — | no | Compare original intent vs. actual result; verdict + smallest fix |
| `explain_fix` | `xf`, `explain-fix` | no | Explain root cause and propose concrete fixes |
| `explanatory` | `insight`, `insights`, `teach` | yes | Adds `★ Insight` educational asides alongside the work |
| `informative` | `verbose`, `detailed` | yes | Thorough reasoning and context; the opposite stance of `concise` |
| `max-chars` | `char-limit`, `maxchars` | yes | Hard-cap response length — `::pin(max-chars(280))` |
| `plan-mode` | `planning` | yes | Investigate and propose, but don't write/edit/execute until approved |
| `reflect` | `reframe`, `reformulate`, `clarify` | no | Identify core intent, reflect, reformulate more precisely |
| `runbackground` | — | no | Run the following task via a background subagent |
| `sidetrack` | `side`, `quick-thought` | no | Flag a brief detour; return to the prior topic afterward |
| `socratic` | `socrates`, `discover` | yes | Never answer directly — lead with questions |
| `subagent` | `delegate` | no | Delegate a task to a subagent off the main thread |
| `tradeoff` | — | no | Balanced advantages / disadvantages / verdict |
| `verify` | — | no | Re-check the last claim against real evidence, not recall |
| `yoda` | `jedi` | yes | Inverted syntax; substance and code unchanged |

`bluf` and `socratic` share the `answer-delivery` exclusivity group — pinning one auto-unpins the other, since no response can both open with the answer and never state it.

These ship so `::` works immediately after install. Override any of them by dropping a same-named `.md` into `.omp/snippets/`.

## Authoring your own snippets

Drop a `.md` file into `.omp/snippets/` in your project — omp's native project config directory, the same family as `.omp/extensions/`, `.omp/commands/`, and `.omp/skills/`. Files are re-read from disk on every `::` trigger match, so changes take effect on your very next message — no restart needed. Your own snippets always take priority over a bundled example with the same name.

```markdown
---
aliases: [alt-name, another-alt]
pinnable: true        # optional, default false — only for standing style/policy content
group: my-group        # optional — mutually exclusive with other pinnable
                        # snippets sharing this group (see Pins above)
---
<prepend>
Content spliced at the top of the visible message.
</prepend>

<append>
<task>
The main instruction. Everything inside <append> is spliced at the bottom of
the visible message when this trigger expands, AND is what gets pinned if
this snippet is `pinnable: true` and gets `::pin`'d.
</task>
</append>

<inject>
Hidden context delivered as a display:false custom message for the turn —
not part of the visible prompt. Rarely needed.
</inject>

Text outside any block replaces the `::name` token inline in the visible
message (this is what appears if you just type `::name` with nothing else).
```

Args: `::name(args)` binds into the body via `$1`, `$2`, `$@`, `$@[start:len]`, `$ARGUMENTS` — the same convention `.omp/commands/*.md` uses.

## Known limitations

- **Interactive TUI only.** `::` triggers expand via `pi.on("input", ...)`, which only fires from the interactive TUI input controller — `omp -p` (print mode) and RPC mode never call it.
- **Pins don't persist.** Session-only; a restart clears them.
- **Live picker degrades gracefully on older omp.** The debounce timer falls back to the global `setTimeout` automatically if the running omp doesn't have `ctx.setTimeout` — no functionality lost, just not container-managed.

## Development

```
bun install
bun run typecheck
bun test
```

The extension source (`src/snippets.ts`) carries the detailed "why" for every non-obvious implementation decision in its top-of-file doc comment.

## Credits

- **[JosXa/opencode-snippets](https://github.com/JosXa/opencode-snippets)** (MIT, Copyright (c) 2025 JosXa) — origin of the `#hashtag`-trigger concept (`::name` here), the `aliases:` frontmatter convention, and the `<prepend>/<append>/<inject>` body schema. `parseSnippetBlocks`, the `BlockRecord`/`BlockCollector`/`addBlock` dedup machinery, and `expandText`'s recursive-expansion/loop-detection structure are a direct port of that project's `src/expander.ts` — not an independent reimplementation of the same idea.
- **[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)** (MIT, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük) — `parseCommandArgs`/`substituteArgs` (the `$1`/`$@`/`$ARGUMENTS` placeholder grammar) are copied near-verbatim from that package's internal `src/utils/command-args.ts`, to match `.omp/commands/*.md`'s existing argument convention exactly.
- Original to this project: the pin/exclusivity-group mechanism, the live raw-terminal-input picker, the bundled-examples loader tier, and the regex-based frontmatter parser (`pinnable`/`group` support).

See `THIRD_PARTY_NOTICES.md` for the full upstream license texts these portions require retaining.

## License

MIT for this project's own code — see `THIRD_PARTY_NOTICES.md` for the two ported regions that carry their own upstream MIT copyright notices.
