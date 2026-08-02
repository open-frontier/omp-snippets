# Snippets (`::name`)

A native [omp](https://github.com/oh-my-pi) extension that ports the [`opencode-snippets`](https://github.com/JosXa/opencode-snippets) composable-prompt-fragment idea into `omp` sessions. Type `::name` anywhere in a message to expand a reusable instruction fragment — chain several in one message, pass arguments, or `::pin` one so it stays active every turn for the rest of the session.

Not a slash command (`/name` must be the first token, one per message) — `::name` works inline, anywhere in your prose, and composes.

## Quick start

```
::careful implement the retry logic
::careful ::concise implement the retry logic
::reflect(the user's actual request)
```

Typing `::` opens a live filterable picker below the editor — you don't need to memorize names. Keep typing to filter, `Tab`/`Enter` to accept, `↑`/`↓` to cycle, `Escape` to cancel.

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
| `careful` | `safe` | yes | Step-by-step, double-check work, ask when ambiguous |
| `concise` | — | yes | Terse, no fluff, no hedging |
| `explanatory` | `insight`, `insights`, `teach` | yes | Adds `★ Insight` educational asides alongside the work — mirrors Claude Code's official "Explanatory" output style |
| `reflect` | `reframe`, `reformulate`, `clarify` | no | Identify core intent, reflect, reformulate more precisely |

These exist so `::` has something to try immediately after install. They're deliberately minimal — write your own for anything project- or workflow-specific.

## Authoring your own snippets

Drop a `.md` file into `.opencode/snippet/` in your project (shared with OpenCode's `opencode-snippets` plugin if you use both tools) or `.omp/snippets/` (omp-only — use this only when a snippet's content genuinely needs to diverge between the two tools; a byte-identical duplicate is a maintenance trap, not an override). Files are re-read from disk on every `::` trigger match, so changes take effect on your very next message — no restart needed. Your own snippets always take priority over the bundled examples with the same name.

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

## License

MIT
