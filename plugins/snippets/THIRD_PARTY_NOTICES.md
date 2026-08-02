# Third-Party Notices

`src/snippets.ts` is original code, but two specific, non-trivial regions were
adapted or copied from other MIT-licensed projects. MIT's only real
obligation — "The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software" — is
satisfied here by reproducing both notices below, scoped to exactly which
code they cover. This is not a soft "inspired by" credit; it is a license
compliance document.

## 1. Block-parsing and expansion engine — adapted from `opencode-snippets`

**Source:** [JosXa/opencode-snippets](https://github.com/JosXa/opencode-snippets), `src/expander.ts`
**What was adapted:** the `#hashtag` → `::name` trigger concept itself is not
copyrightable, but the *algorithm* implementing it was ported, not
independently reinvented:

- `parseSnippetBlocks` — the single-regex `<prepend>/<append>/<inject>`
  state-machine tag parser (nested-tag → error, mismatched-closing-tag →
  error, unclosed-tag → lenient rest-as-block, stray-closing-tag → ignored)
  is a direct structural port of `expander.ts`'s function of the same name.
- `BlockRecord` / `BlockCollector` / `addBlock` — the exact same data shapes
  and the `${type}\u0000${name}\u0000${content}` NUL-delimited dedup-key
  scheme used to prevent a snippet's `<prepend>`/`<append>`/`<inject>` block
  from being inserted twice when reached via multiple expansion paths.
- `expandText`'s recursive-expansion-with-loop-detection structure (a
  per-snippet `expansionCounts` map, a max-depth guard, and
  expand-inline-then-recurse-into-collected-blocks control flow) mirrors
  `expander.ts`'s `expandText`/`expandHashtags`.

Everything else touching snippets — frontmatter parsing (`pinnable`, `group`,
custom regex-based YAML instead of `gray-matter`), the pin/exclusivity-group
mechanism, the live raw-terminal-input picker, and the bundled-examples
loader tier — has no equivalent in `opencode-snippets` and is original to
this project.

```
MIT License

Copyright (c) 2025 JosXa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Argument placeholder substitution — copied from `@oh-my-pi/pi-coding-agent`

**Source:** [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), `packages/coding-agent/src/utils/command-args.ts`
**What was copied:** `parseCommandArgs` (quoted-token splitter) and
`substituteArgs` (the `$1`/`$2`/`$@`/`$@[start:len]`/`$ARGUMENTS` placeholder
grammar and its exact substitution order) in `src/snippets.ts` are a
near-verbatim copy of that module — same regexes, same three-pass
substitution order, same edge-case handling. It was copied rather than
imported because `command-args.ts` is an internal utility, not exported from
the package's public surface; the goal was matching `.omp/commands/*.md`'s
existing argument convention exactly, not independent design.

```
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
