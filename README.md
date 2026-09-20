# omp-snippets

Composable `::name` prompt snippets for [omp](https://github.com/oh-my-pi) (oh-my-pi) — chain, parameterize, and pin reusable instruction fragments. Type `::name` anywhere in a message to expand a snippet; combine several in one message; pin a standing style (`::pin(concise)`) so it stays active every turn without retyping.

This repository is an omp [marketplace](https://github.com/oh-my-pi/pi-coding-agent) — it hosts one plugin, `snippets`.

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
- **A live filterable picker** — type `::` to see a dropdown of every available snippet, color-coded by pin state, with `Tab`/`Enter`/arrows/`Escape` navigation.
- **A pin mechanism** — `::pin(name)` keeps a standing preference active for the session, with a `Right arrow` picker hotkey and opt-in exclusivity groups. Pins are advisory instructions, not tool permissions; see the [pin scope and approval-policy exceptions](./plugins/snippets/README.md#how-pins-reach-the-model).
- **25 bundled example snippets** to try immediately — including `bugfix`, `chain`, `fanout`, `show`, `careful`, `concise`, and `report`. See [`plugins/snippets/README.md`](./plugins/snippets/README.md) for the full catalog, usage guide, and how to author your own.

## Full documentation

See [`plugins/snippets/README.md`](./plugins/snippets/README.md) for usage details, the pin mechanism, the live picker, and the authoring guide for writing your own snippets.

## License

MIT — see [LICENSE](./LICENSE). This project incorporates portions of other
MIT-licensed software; see [`plugins/snippets/THIRD_PARTY_NOTICES.md`](./plugins/snippets/THIRD_PARTY_NOTICES.md)
for the specific code regions and upstream copyright notices those regions require retaining.
