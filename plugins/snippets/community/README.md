# Community snippets

Snippets contributed by users, for other users to copy. **Not shipped with the
plugin** — this directory is deliberately excluded from `package.json`'s
`files[]`, so nothing here is ever installed or auto-loaded. A snippet is
prompt payload that steers the model; before anything here becomes
installable, it needs a real audit story, not just a merged PR.

## Using one

Copy the `.md` file into your own `.omp/snippets/` (project) or
`~/.omp/agent/snippets/` (personal) directory. That's it — see the main
[README](../README.md#authoring-your-own-snippets) for the file format.

## Contributing one

Open a PR adding a single `.md` file here, named after the snippet
(`your-snippet.md`). Requirements:

- Follows the frontmatter/body schema documented in the main README.
- One snippet per file, self-contained — no references to a specific
  project's paths, tools, or conventions.
- A one-line description at the top of the PR: what it does, when you'd
  reach for it.
- No `pinnable: true` unless the content is genuinely a standing
  behavioral/style policy, not a one-shot action — see the main README's
  "Pins" section for the distinction.

Maintainers review for the schema and for prompt-injection risk (a snippet
that tries to instruct the *reviewer*, not just the eventual user, is
rejected outright). Review is about mechanical safety, not taste — a snippet
being niche or narrowly useful is not a reason to reject it.

This directory exists to see whether community contribution is worth
building real infrastructure for (an installable pack, a discovery mechanism)
before that infrastructure is built. If it stays empty, that's a useful
answer too.
