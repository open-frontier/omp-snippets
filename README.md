# omp-snippets

Composable `::name` prompt snippets for [omp](https://github.com/oh-my-pi) (oh-my-pi) — chain, parameterize, and pin reusable instruction fragments. Type `::name` anywhere in a message to expand a snippet; combine several in one message; pin a standing style (`::pin(concise)`) so it stays active every turn without retyping.

This repository is an omp [marketplace](https://github.com/oh-my-pi/pi-coding-agent) — it hosts one plugin, `snippets`.

## Demo

**Picker, inline expansion, and pins**

![The :: picker, pinning a style, and inline expansion](./docs/demo/hero.gif)

**Enforced Q&A-only guard and roles**

![A Q&A-only pin refusing a write under auto-approve, then a role](./docs/demo/guard-roles.gif)

## Install

```
/marketplace add open-frontier/omp-snippets
/marketplace install snippets@omp-snippets
```

Or from the command line:

```
omp plugin marketplace add open-frontier/omp-snippets
omp plugin install snippets@omp-snippets
```

## What you get

- **`::name` / `::name(args)` expansion** — type a trigger inline, anywhere in your prose; it expands to the snippet's instruction.
- **A live filterable picker** — type `::` to browse role-like rows first, then other pinnables, then ordinary one-shot snippets, with `Tab`/`Enter`/arrows/`Escape` navigation. Role-like names (including the guarded `q&a` pin) are purple; other pinnable names are green; ordinary names and descriptions retain the normal foreground. Names and one-line descriptions share aligned columns, descriptions are capped at 60 code points, and pinnables keep their checkbox/pin mark.
- **A pin mechanism** — `::pin(name)` keeps a standing preference active for the session, with a `Right arrow` picker hotkey and opt-in exclusivity groups. Pins are advisory except **Q&A**: `::pin(qa)` blocks non-read-only tool calls until `::unpin(qa)`. The bundled Q&A aliases (`qa`, `QA`, `question and answer`, `ask-mode`, `plan-mode`, `planning`) resolve to one stable pin entry, so pinning or unpinning through any of them addresses the same snapshot. It is independent of native `/plan` and approval settings. See the [Q&A-only guard](./plugins/snippets/README.md#qa-only-guard-guard-qa).
- **Roles** — a snippet marked `kind: role` is a standing operational role for the main conversation: type its bare name (`::release-captain`) to select or refresh it, `::unrole` to clear it. Roles are separate from pinned presentation styles, apply only to the main agent, and persist across resume and branch via a native session entry. Role selection takes a bare name only; an argument wrapper such as `::release-captain(args)` or `::release-captain<<...>>` is unsupported. A wrapper recognized for a selectable real role stays literal and inert in the text where it is recognized, rather than activating anything. This is phase-local protection, not cross-phase quoting: separately generated role-head/opener text does not undo an expansion already completed earlier. Existing bracket-first expansion and `::pins`/`::unpin`/`::pin` preprocessing order is unchanged.
- **26 bundled examples** — output styles, behavioral pins, and one-shot actions, including `bluf-insight` for BLUF plus useful `★ Insight` asides. No generic reviewer/researcher roles ship; use native subagents for delegated specialist work. See [`plugins/snippets/README.md`](./plugins/snippets/README.md) for the catalog and authoring guide.

## Snippet, pin, or role?

Every `::` trigger is one of three kinds. Unlike a `/slash` command (first token only, one per message), all of them work inline, anywhere in your prose; see [snippets vs. skills vs. slash commands](./plugins/snippets/README.md#snippets-vs-skills-vs-slash-commands).

| | Snippet | Pin | Role |
|---|---|---|---|
| Use for | A one-off instruction | A standing style or policy | A standing operational assignment |
| Activate | `::name` or `::name(args)` | `::pin(name)`, `::unpin(name)`, or `Right` in the picker | Bare `::name`; `::unrole` clears |
| Lasts | That message | Every turn until unpinned; this process only | Every turn until cleared; saved in the session |
| How many | Any number per message | Any number (`group` members replace each other) | One at a time |
| Arguments | Yes | Yes | No |
| Reaches the model as | Expanded text in your message | `<pinned-styles>` in the system prompt | `<operational-role>` in the system prompt |
| Enforced | No | No, except `q&a`, which blocks non-read-only tool calls | No; never overrides safety, approvals, or Plan mode |
| Defined by | Any snippet file | `pinnable: true` | `kind: role` |
| Bundled examples | `reflect`, `verify`, `subagent` | `concise`, `careful`, `bluf`, `q&a` | None; write your own |

## Full documentation

See [`plugins/snippets/README.md`](./plugins/snippets/README.md) for usage details, the pin mechanism, the live picker, and the authoring guide for writing your own snippets.

## License

MIT — see [LICENSE](./LICENSE). The plugin package carries its own copy at [`plugins/snippets/LICENSE`](./plugins/snippets/LICENSE), because the package archive does not include the repository root. This project incorporates portions of other MIT-licensed software; see [`plugins/snippets/THIRD_PARTY_NOTICES.md`](./plugins/snippets/THIRD_PARTY_NOTICES.md) for the specific code regions and upstream copyright notices those regions require retaining.
