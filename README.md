# omp-snippets

Composable `::name` prompt snippets for [omp](https://github.com/oh-my-pi) (oh-my-pi) — chain, parameterize, and pin reusable instruction fragments. Type `::name` anywhere in a message to expand a snippet; combine several in one message; pin a standing style (`::pin(concise)`) so it stays active every turn without retyping.

This repository is an omp [marketplace](https://github.com/oh-my-pi/pi-coding-agent) — it hosts one plugin, `snippets`.

## Install

```
/marketplace add misterdojo777/omp-snippets
/marketplace install snippets@omp-snippets
```

Or from the command line:

```
omp plugin marketplace add misterdojo777/omp-snippets
omp plugin install snippets@omp-snippets
```

## What you get

- **`::name` / `::name(args)` expansion** — type a trigger inline, anywhere in your prose; it expands to the snippet's instruction.
- **A live filterable picker** — type `::` to see a dropdown of every available snippet, color-coded by pin state, with `Tab`/`Enter`/arrows/`Escape` navigation.
- **A pin mechanism** — `::pin(name)` keeps a standing style active for the rest of the session (e.g. "answer concisely"), with a `Right arrow` hotkey in the picker and an opt-in exclusivity `group` for styles that are logically, not just stylistically, incompatible.
- **4 bundled example snippets** to try immediately: `careful`, `concise`, `explanatory` (pinnable), and `reflect` (one-shot). See [`plugins/snippets/README.md`](./plugins/snippets/README.md) for the full catalog, usage guide, and how to author your own.

## Full documentation

See [`plugins/snippets/README.md`](./plugins/snippets/README.md) for usage details, the pin mechanism, the live picker, and the authoring guide for writing your own snippets.

## License

MIT — see [LICENSE](./LICENSE).
