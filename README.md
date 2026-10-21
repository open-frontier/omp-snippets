# omp-snippets

Reusable instructions for [omp](https://github.com/oh-my-pi/pi-coding-agent). Type `::name` anywhere in your message, keep preferences active, or select a conversation role.

| Expand | Pin | Select a role |
|---|---|---|
| `::name(args)` | `::pin(name)` | `::role-name` |
| One message | Every turn, until unpinned | One user-selected mode |

This repository is an omp [marketplace](https://github.com/oh-my-pi/pi-coding-agent) that hosts one plugin, `snippets`.

## Demo

![The :: picker, pinning a style, and inline expansion](./docs/demo/hero.gif)

This is the existing recording; the picker shortcuts below describe the updated behavior. A second recording shows the [Q&A-only guard refusing a write, then a role](./docs/demo/guard-roles.gif).

## Install

In omp:

```
/marketplace add open-frontier/omp-snippets
/marketplace install snippets@omp-snippets
```

Or from the command line:

```
omp plugin marketplace add open-frontier/omp-snippets
omp plugin install snippets@omp-snippets
```

## Snippets

Use an instruction once by typing its name in your message. Combine several, or pass arguments with `::name(args)`. It expands for that message; it is not automatically repeated on later turns.

```
::verify   → re-check each claim against concrete evidence
::reflect  → reflect on intent, then reformulate it clearly
```

Several snippets can share one message. They combine as modifiers on the same request; they are not a hard sequence of steps.

```
::careful ::concise ::verify Review the changes to authentication.
```

Type `::` to browse the bundled snippets.

## Pinned snippets

Keep instructions active every turn without retyping them. Stack output styles such as `concise`, `html`, or `yoda` with working preferences such as `careful`.

```
::pin(concise) ::pin(careful)
::unpin(concise)
```

A *pinnable* snippet supports pinning; it only becomes *pinned* when you turn it on. You can still use it once with `::concise`. Pins remain until unpinned or omp exits; conflicting pins in the same group replace each other.

> **Q&A is a special pin:** `::pin(qa)` blocks non-read-only tool calls until `::unpin(qa)`. It can coexist with a role and is separate from native `/plan`. Other pins are advisory. See the [Q&A-only guard](./plugins/snippets/README.md#qa-only-guard-guard-qa).

## Roles

A role also keeps instructions active, but occupies one separate slot for the main conversation. You choose it, not the model. Selecting another replaces it, and `::unrole` clears it without removing your pins.

Use a role for a sustained perspective or way of working, while keeping your preferred output styles pinned. The selected role is saved with the session and restored on resume or branch; it does not start a separate agent.

The bundled `mentor` role (alias `teacher`) is a real example. It helps you learn a concept or solve a problem yourself: it starts from your goal and current understanding, asks one question or sets one small exercise per turn, gives feedback on your attempt, and hints in steps. Ask outright for the answer or a worked example and it gives one. Select it by bare name, or clear it, like this:

```
::mentor
::unrole
```

`::teacher` selects the same role. Roles take no arguments, so type the bare name; the rest of your message is an ordinary request. For example:

```
::mentor Teach me how Rust lifetimes work. I know C++ but have never used Rust.
```

Your selection stays user-controlled and lasts until you clear or replace it. Pins keep working beside it, and only one role is active at a time.

`mentor` differs from the `socratic` style pin: `mentor` adapts to what you already know, mixing guided practice with direct explanations when asked, while `socratic` makes question-led delivery the style of every answer.

To define your own role, mark a snippet with `kind: role`; the [authoring guide](./plugins/snippets/README.md#authoring-a-role) walks through a `release-captain` example.

See [Roles](./plugins/snippets/README.md#roles--role-name-and-unrole) for lifetime, prompt placement, and authoring.

## Using the picker

Type `::` and filter by name. Use Up/Down to move and Escape to close. Toggling keeps the picker open and leaves your message unchanged.

| Selected row | Enter | Right arrow | Tab |
|---|---|---|---|
| Snippet | Insert | Move cursor | Insert |
| Pinnable | Pin / unpin | Pin / unpin | Insert |
| Role | Select / clear | Move cursor | Insert |

Enter applies a role immediately; Tab inserts its trigger for selection when you send. Parameterized pins use their blank-argument default in the picker; type `::pin(max-chars(500))` to choose a value. See [Live picker](./plugins/snippets/README.md#live-picker) for ordering and colors.

## Bundled snippets

All 30 examples ship with the plugin. Type the name with `::` to use one once; pinnable examples can also be pinned. A role is selected rather than expanded inline.

| Snippet | Type | What it does |
|---|---|---|
| [`brainstorm`](./plugins/snippets/examples/brainstorm.md) | One-shot | Brainstorm options and tradeoffs until a decision |
| [`bugfix`](./plugins/snippets/examples/bugfix.md) | One-shot | Delegate this bug fix to a background subagent |
| [`chain`](./plugins/snippets/examples/chain.md) | One-shot | Run the following steps as an ordered pipeline |
| [`create-snippet`](./plugins/snippets/examples/create-snippet.md) | One-shot | Create a reusable snippet using the plugin conventions |
| [`drift`](./plugins/snippets/examples/drift.md) | One-shot | Compare intended versus actual outcome for drift |
| [`explain_fix`](./plugins/snippets/examples/explain_fix.md) | One-shot | Explain the issue and propose concrete fixes |
| [`fanout`](./plugins/snippets/examples/fanout.md) | One-shot | Fan out independent read-only steps, then join |
| [`reflect`](./plugins/snippets/examples/reflect.md) | One-shot | Reflect on intent, then reformulate it clearly |
| [`report`](./plugins/snippets/examples/report.md) | One-shot | Report current thread status from the template |
| [`runbackground`](./plugins/snippets/examples/runbackground.md) | One-shot | Run this task in a background subagent |
| [`sidetrack`](./plugins/snippets/examples/sidetrack.md) | One-shot | Take a brief detour, then return to the topic |
| [`subagent`](./plugins/snippets/examples/subagent.md) | One-shot | Spawn a subagent to handle this off-thread |
| [`tradeoff`](./plugins/snippets/examples/tradeoff.md) | One-shot | Give a balanced advantages/disadvantages analysis |
| [`verify`](./plugins/snippets/examples/verify.md) | One-shot | Re-check each claim against concrete evidence |
| [`bluf`](./plugins/snippets/examples/bluf.md) | Style pin | Lead with the one-sentence answer, then details |
| [`bluf-insight`](./plugins/snippets/examples/bluf-insight.md) | Style pin | Lead with the answer, then insight where it helps |
| [`concise`](./plugins/snippets/examples/concise.md) | Style pin | Answer concisely in plain language, no fluff |
| [`explanatory`](./plugins/snippets/examples/explanatory.md) | Style pin | Add educational insights alongside the work |
| [`html`](./plugins/snippets/examples/html.md) | Style pin | Deliver the answer as a self-contained HTML page |
| [`informative`](./plugins/snippets/examples/informative.md) | Style pin | Thorough explanations of reasoning and tradeoffs |
| [`max-chars`](./plugins/snippets/examples/max-chars.md) | Style pin | Hard-cap every response at a set character limit |
| [`show`](./plugins/snippets/examples/show.md) | Style pin | Present the topic visually in the chosen format |
| [`socratic`](./plugins/snippets/examples/socratic.md) | Style pin | Answer with questions instead of the answer |
| [`ste100`](./plugins/snippets/examples/ste100.md) | Style pin | Write in ASD-STE100 aerospace maintenance style |
| [`yoda`](./plugins/snippets/examples/yoda.md) | Style pin | Speak like Yoda with inverted word order |
| [`careful`](./plugins/snippets/examples/careful.md) | Behavior pin | Think step by step and double-check changes |
| [`confirm-first`](./plugins/snippets/examples/confirm-first.md) | Behavior pin | Propose the change first, then await approval |
| [`direct-evidence`](./plugins/snippets/examples/direct-evidence.md) | Behavior pin | Answer directly with evidence, no praise |
| [`q&a`](./plugins/snippets/examples/q%26a.md) | Guarded pin | Stay read-only while pinned; unpin to allow changes |
| [`mentor`](./plugins/snippets/examples/mentor.md) | Role | Learn concepts and solve problems with guided practice |

Pinnable examples can also be used once. `q&a` is a guarded pin, not a role. `mentor` is a role: `::mentor` (or `::teacher`) selects it for the conversation instead of expanding inline.

## FAQ

### How is a snippet different from a skill or a slash command?

A skill is reusable expertise or a procedure the model loads when it judges it relevant. A slash command is a named command you type as its own entry point; it is not something you mix inline with other text. A snippet is a fragment you type anywhere in a message with `::`, so several can combine in one message. See the [detailed comparison](./plugins/snippets/README.md#snippets-vs-skills-vs-slash-commands).

### How do I create a snippet?

Ask for it: `::create-snippet a snippet that asks for a risk summary before any refactor`. Snippet files live in `~/.omp/agent/snippets/` for personal use or `.omp/snippets/` to share with a project. See [Authoring your own snippets](./plugins/snippets/README.md#authoring-your-own-snippets).

### What is the difference between pinnable, one-shot, and active?

A one-shot snippet applies to the message where you type it. A *pinnable* snippet can also be turned on with `::pin(name)`; once *pinned*, it is active every turn until you unpin it or omp exits.

### How do roles differ from pins?

A role is one mode you select, saved with the session. Pins stack, so you can combine several styles and behaviors, and they last only for the current omp process.

### How is `mentor` different from `socratic`?

`mentor` is a role you select for guided practice: it adapts to your level and mixes questions, exercises, feedback, and direct explanations or worked examples when you ask or get stuck. `socratic` is a style pin that delivers every answer as questions only. A role and a pin occupy different slots.

### Do snippets guarantee the model follows them?

No. A snippet is an instruction to the model, not enforcement or automatic execution. The Q&A-only guard is the exception: it blocks non-read-only tool calls while pinned.

## Full documentation

See the [catalog and authoring guide](./plugins/snippets/README.md) for aliases, pin groups, arguments, and creating your own snippets or roles. For how snippets differ from skills and slash commands, see [Snippets vs. skills vs. slash commands](./plugins/snippets/README.md#snippets-vs-skills-vs-slash-commands).

## License

MIT — see [LICENSE](./LICENSE). The plugin package carries its own copy at [plugin license](./plugins/snippets/LICENSE), because the package archive does not include the repository root. This project incorporates portions of other MIT-licensed software; see [third-party notices](./plugins/snippets/THIRD_PARTY_NOTICES.md) for the specific code regions and upstream copyright notices those regions require retaining.
