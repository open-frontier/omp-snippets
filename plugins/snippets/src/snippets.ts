/**
 * `::name` / `::name(args)` / `::name<<...>>` composable prompt-snippet expansion for omp.
 * The trigger concept, `aliases:` frontmatter, and `<prepend>/<append>/<inject>`
 * body schema originate from the `opencode-snippets` OpenCode plugin, so
 * bodies are reusable across both tools verbatim. Two specific regions below
 * are ported/copied from other MIT projects rather than independently
 * designed — see `THIRD_PARTY_NOTICES.md` for exactly which code and the
 * upstream copyright notices that porting carries with it.
 *
 * User-facing docs (usage, picker, pins, authoring guide): see this
 * package's `README.md`. This comment covers implementation rationale —
 * read it when modifying the code, not when using the feature.
 *
 * ## Two-tier source
 *
 * - `examples/*.md` (bundled with this package) — lowest priority. A
 *   handful of example snippets shipped so `::` has something to
 *   demonstrate out of the box, even in a project with no snippet
 *   directory of its own. Any project-level snippet with the same
 *   name/alias always wins over a bundled one.
 * - `.omp/snippets/*.md` (project-level) — the place to add your own
 *   snippets, following omp's native `.omp/` project convention (the same
 *   directory family as `.omp/extensions/`, `.omp/commands/`,
 *   `.omp/skills/`). Drop a `.md` file in and it's live on your next
 *   message.
 *
 * ## Why `input`, not `before_agent_start`
 *
 * The upstream plugin rewrites the actual submitted message text: content
 * outside `<prepend>`/`<append>` blocks replaces the `#trigger` inline, and
 * block content is spliced into the visible message (prepend at the top,
 * append at the bottom) — see `examples/reflect.md`, whose
 * trailing plain-text line ("Reflect on this") is exactly this inline
 * replacement text. That is a visible rewrite of the user's own prompt, not
 * a hidden system note, so it maps to omp's `input` event
 * (`InputEventResult.text` replaces the submitted text) rather than
 * `before_agent_start` (which can only add one *additional hidden* message).
 *
 * `<inject>` blocks are the one part of the upstream schema that IS meant to
 * be hidden context for the whole turn — those are collected separately and
 * delivered via `before_agent_start` as a `display: false` custom message.
 * None of the bundled `examples/*.md` files use `<inject>`, but the
 * plumbing is here for when one does.
 *
 * ## Hot reload
 *
 * Both snippet directories are re-read from disk on every `::` trigger
 * match (no in-memory cache across turns) — editing or adding a `.md` file
 * takes effect on the very next message, no session restart needed. Cheap
 * by construction: a couple dozen small markdown files, read once per user
 * message that actually contains `::`.
 *
 * ## Known limitation
 *
 * `pi.on("input", ...)` is only invoked from the interactive TUI input
 * controller (`emitInput(..., "interactive")`) as of pi-coding-agent
 * 16.0.1 — print mode (`omp -p`) and RPC mode never call it. `::` triggers
 * therefore only expand in interactive sessions.
 *
 * ## Live picker (Tab-to-complete, color-coded, Right-arrow to pin)
 *
 * Typing `::` shows a filterable dropdown below the editor (Up/Down cycle,
 * Tab/Enter accept, Escape cancel). See the "Live `::name` picker" section
 * below for why this needed a raw-terminal-input bypass instead of the
 * documented `addAutocompleteProvider` extension point — that API is real,
 * but the built-in editor's own keystroke gate never routes a literal `::`
 * to any provider (its trigger regex is single-colon-only, for emoji
 * shortcodes). Live-verified end to end (filter, accept, cycle, cancel) in
 * a real interactive session.
 *
 * Rows carry no category badge: category is display metadata only (the purple
 * tier first, then styles, then other named categories, uncategorized last),
 * so what a row is never depends on a textual tag. Color names the category
 * instead, and covers the name alone: a role's name is the fixed ANSI-256
 * violet, active or not — a role's standing effect is carried by the
 * `Role: <name>` status line and the footer hint, not by a repaint — and a
 * PINNABLE snippet authored `category: role` shares that violet as a
 * display-only classification (a role-like pin: it is still an ordinary pin
 * for selection, expansion, and the Q&A guard). Every other pinnable row's
 * name is the theme's `success` green, and an ordinary snippet's name keeps
 * the normal foreground, as does every description. The trailing pin mark
 * stays in that normal foreground too, so what a row *does* is never decoded
 * from its color: the color says which group the row belongs to, the mark
 * says whether it is pinned. Selection is an `accent` caret marker (`▸ `)
 * rather than a repaint. The pin state is
 * also marked without relying on color: a pinnable row that isn't pinned
 * right now carries a trailing `☐` checkbox, an active pin its trailing `📌`
 * glyph, and non-pinnable rows leave that column blank. Right arrow on a
 * highlighted pinnable row toggles
 * its pin state in place — no text inserted, picker stays open — separate
 * from Tab/Enter, which still insert the one-shot trigger into the message
 * as before (accepting a role row inserts `::role-name`; it does not
 * activate anything by itself). Excluded from the hotkey: snippets with an
 * unbound `$1`/`$@`/`$ARGUMENTS` placeholder (`max-chars`) — there's no
 * argument value to bind from a keypress, so those stay `::pin(name(args))`
 * text-only, and roles, which are never pinnable. Three status-bar lines
 * (`ctx.ui.setStatus`) mirror the pinned set, the active role, and — while a
 * `guard: qa` pin is active — the enforced Q&A-only mode at all times, not
 * just while the picker is open, so no standing state disappears once you
 * close it. A muted footer line under the rows names what the highlighted
 * row would do: the pin-toggle key for a pinnable row, or — for a role row,
 * which Tab/Enter only inserts as text — `conversation role · send to select`
 * (`· send to refresh` when it is already the active role), so the standing
 * effect is visible before submission.
 *
 * Every row is label first — `::name` plus its pin mark, then the
 * description — and is fitted to a single line at whatever width the surface
 * actually gives it (see `PickerWidget`). Descriptions start at one shared
 * column: the widget measures the widest visible label and pads every row to
 * it, so a short name simply gets more gap and a narrow surface shrinks the
 * column rather than starving the description. The description itself is the
 * author's `description:` frontmatter when the snippet declares one, else a
 * preview of the body; either way it is one line, capped at
 * `MAX_DESCRIPTION_CODEPOINTS` code points, and cut further only when the
 * row's own width demands it.
 *
 * Ordering is three groups, group first: the purple tier (real roles and
 * pinnable rows authored `category: role`), then every other pinnable row
 * (styles and behavioral pins), then ordinary one-shot snippets. Inside a
 * group the order is unchanged — the purple tier, styles, then other named
 * categories alphabetically, then uncategorized snippets, with the active item
 * (pinned, or the selected role) first within its category, then alphabetical
 * by name. A typed query is relevance-first (exact match beats prefix beats
 * substring, aliases included), but the group boundary outranks relevance: no
 * match quality lifts an ordinary snippet above a style, or a style above a
 * role-like row — category, then active state, only break equal relevance.
 * Recomputed on every keystroke, but deliberately NOT re-run when a
 * Right-arrow toggle changes pin state while the picker is already open —
 * reordering mid-browse would jump the row out from under the user's cursor.
 *
 * ## Args
 *
 * `::name(args)` binds `args` into the snippet body using the same
 * `$1`, `$2`, `$@`, `$@[start:len]`, `$ARGUMENTS` placeholder convention as
 * `.omp/commands/*.md` (ported from `src/utils/command-args.ts` since that
 * module isn't part of the package's public export surface). None of the
 * current snippet bodies use placeholders, so this is a no-op for them
 * today — forward-compatible plumbing only.
 *
 * ## Pins — `::pin(name)` / `::unpin(name)` / `::pins`
 *
 * Snippets are one-shot by design and stay that way; pinning is a separate,
 * explicit opt-in for the minority of content that's actually a standing
 * behavioral/style policy — tone/format overlays like the bundled
 * `careful`, `concise`, `explanatory` examples — rather than a one-time
 * action (`reflect`, or any other single-use trigger you author). Only
 * snippets marked
 * `pinnable: true` in frontmatter can be pinned — the snippet author decides
 * this, not the caller, since most existing content is semantically
 * incoherent as a standing instruction (re-asserting "verify what you just
 * said" every turn doesn't generalize to anything). Pinned content composes
 * by default (multiple pins can be active at once, no forced single slot) —
 * except within an opt-in exclusivity `group` (see `SnippetDef.group` /
 * `unpinGroupSiblings`), reserved for the rare pair whose content is
 * logically, not just stylistically, contradictory (e.g. a "lead with the
 * answer first" style vs. a "never state the answer directly" style —
 * no response can both open with the answer and never state it). Pinning
 * a snippet auto-unpins any other pinned snippet sharing its `group`, with
 * a `ctx.ui.notify` heads-up so the swap isn't silent. Pinned content is
 * re-delivered every turn via `before_agent_start`'s `systemPrompt: string[]`
 * mutation — a real, per-turn-only override (confirmed in `agent-session.ts`:
 * the base array is rebuilt fresh every turn, so the extension owns
 * re-supplying pinned content itself; nothing here is engine-persisted).
 * See the "Pins" section below for the full design rationale.
 *
 * A pinnable snippet may also carry `guard: qa`, which turns its pin into
 * enforced Q&A-only mode: while that pin is active, host tool interception
 * blocks every mutating or executing tool call until the user unpins (see
 * the "Q&A-only guard" section below; `examples/q&a.md` is the bundled
 * example). Bare `::q&a` stays a one-shot prompt — only `::pin` (or
 * the picker's Right arrow) engages the guard.
 *
 * ## Roles — `::role-name` / `::unrole`
 *
 * A snippet with `kind: role` in frontmatter is an operational role, not an
 * ordinary snippet: typing its bare trigger and submitting selects it as the
 * one active role for the main conversation (re-selecting refreshes its saved
 * snapshot; it is never a toggle), and `::unrole` clears it. Roles accept no
 * arguments — `::role-name(args)` and `::role-name<<...>>` are left untouched
 * and never activate — and only the submitted text is scanned for them: a
 * `::role-name` sitting inside a snippet body or inside another trigger's
 * arguments is not an activation. The selected role is snapshotted (canonical
 * name + fully expanded body, `append` blocks else inline, the same rule
 * `::pin` uses) into a session custom entry, so a resume replays the body that
 * was active even if the file changed or disappeared, and re-supplies it as one
 * extra system-prompt block per turn. Only the main agent may select, restore,
 * or inject a role; subagent bindings never do, and a host that does not
 * report `ctx.agent.kind` disables roles with a one-time notice instead of
 * guessing. See the "Roles" section below for the full design rationale.
 *
 * Pure functions below are exported for `snippets.test.ts`; the extension
 * itself is the default export.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { qaBlockReason, qaPinnedNames, qaSpawnBlockReason } from "./qa-guard.ts";

// ============================================================================
// Snippet registry — bundled examples/*.md overlaid by the project's
// .omp/snippets/*.md. Reloaded fresh on every trigger match; see "Hot
// reload" above.
// ============================================================================

export interface SnippetDef {
	/** Canonical id: the lowercased filename stem. Shared by all aliases. */
	name: string;
	/** File content after frontmatter (raw, unexpanded, unsubstituted). */
	raw: string;
	/** Whether `::pin(name)` may pin this snippet's content into the system
	 *  prompt for the rest of the session (see "Pins" below). Opt-in,
	 *  default `false` — most snippets are one-shot actions ("verify what
	 *  you just said", "spawn a review of the current discussion") that
	 *  don't generalize into a standing instruction; re-asserting them every
	 *  turn would be incoherent, not just noisy. Only content that reads as
	 *  a durable behavioral/style policy (e.g. `careful`, `concise`) should
	 *  set this. */
	pinnable: boolean;
	/** Opt-in exclusivity tag for pinnable snippets whose content is
	 *  logically, not just stylistically, incompatible with other members
	 *  of the same group (e.g. `bluf` "state the answer first" vs.
	 *  `socratic` "never state the answer" — no response can satisfy both).
	 *  Pinning a snippet auto-unpins any other currently-pinned snippet
	 *  sharing its `group`. Absent by default: most pinnable snippets are
	 *  merely different *stances* (`concise` vs. `informative`) that the
	 *  model can blend, not contradictions, and stay freely composable. */
	group?: string;
	/** `kind: role` in frontmatter. Absent for ordinary snippets. A role is
	 *  selected with a bare `::name` (see "Roles" below) instead of being
	 *  expanded into the message, and is therefore never expandable — nested
	 *  references included — and never pinnable (`pinnable`/`group` are
	 *  stripped at load with a diagnostic). */
	kind?: "role";
	/** `category: <label>` in frontmatter — display and picker ordering only.
	 *  `style` (case-insensitive) is one reserved value: it marks the snippet
	 *  as an output style, which is purely a grouping label. The other is the
	 *  singular `role` (case-insensitive, trimmed): on a PINNABLE snippet it
	 *  makes the row role-like — the picker's violet, in the leading group —
	 *  which is still a display classification only, not a `kind: role`
	 *  definition (see `isRoleTier`). Neither value controls activation or
	 *  persistence — `pinnable`/`group` still do that. A real role sorts under
	 *  `Role` regardless of any value here. */
	category?: string;
	/** `description: <one line>` in frontmatter — the picker's description for
	 *  this definition, display-only. Absent by default, in which case the
	 *  picker previews the body instead. It never reaches expansion,
	 *  `::pin`, or a role's injected body: `raw` is the body either way. */
	description?: string;
	/** `guard: qa` in frontmatter — opt-in enforcement on top of `pinnable`,
	 *  the one pinned snippet whose content changes what runs instead of how
	 *  responses read. While a pin snapshot carries this guard, the extension
	 *  blocks tool calls that could mutate or execute (see `qa-guard.ts`)
	 *  until the user unpins. Only ordinary pinnable snippets may declare it:
	 *  a role cannot (diagnostic, ignored), and without `pinnable: true` it is
	 *  ignored with a diagnostic too, because a guard nothing can activate is
	 *  a definition bug rather than a feature. */
	guard?: "qa";
	/** Non-fatal definition problems found while loading this file (invalid
	 *  role combinations, an unusable role body, an unknown `kind`). The
	 *  definition still loads whenever it is usable as something; problems are
	 *  surfaced once per session as a notice so a broken file never breaks the
	 *  rest of the registry, and never silently. */
	diagnostics?: string[];
}

/** Parses the value after `aliases:` in one of the three YAML shapes it may
 *  take: inline bracketed array, single inline scalar, or a block list on
 *  the following lines. Extracted from `parseFrontmatterAliases` purely to
 *  keep that function's cognitive complexity in check — the nested
 *  loop+branch for the block-list case was most of its weight. */
function parseAliasesValue(lines: string[], index: number, inline: string, stripQuotes: (s: string) => string): string[] {
	const aliases: string[] = [];
	if (inline.startsWith("[")) {
		for (const part of inline.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
			const value = stripQuotes(part);
			if (value) aliases.push(value);
		}
		return aliases;
	}
	if (inline) {
		aliases.push(stripQuotes(inline));
		return aliases;
	}
	for (let j = index + 1; j < lines.length; j++) {
		const item = lines[j].match(/^\s*-\s*(.+)$/);
		if (!item) break;
		aliases.push(stripQuotes(item[1]));
	}
	return aliases;
}

/** Frontmatter fields this module understands, after quote-stripping. Values
 *  are raw strings — validating `kind`/`category` against what the feature
 *  supports happens in `buildSnippetDef`, which knows the file's name and can
 *  report a diagnostic. */
export interface SnippetFrontmatter {
	aliases: string[];
	pinnable: boolean;
	group?: string;
	kind?: string;
	category?: string;
	description?: string;
	guard?: string;
	body: string;
}

export function parseFrontmatterAliases(fileContent: string): SnippetFrontmatter {
	const fm = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!fm) return { aliases: [], pinnable: false, body: fileContent };

	const body = fileContent.slice(fm[0].length);
	const lines = fm[1].split(/\r?\n/);
	const aliases: string[] = [];
	let pinnable = false;
	let group: string | undefined;
	let kind: string | undefined;
	let category: string | undefined;
	let description: string | undefined;
	let guard: string | undefined;
	const stripQuotes = (s: string) => s.trim().replace(/^["']|["']$/g, "");

	for (let i = 0; i < lines.length; i++) {
		const aliasMatch = lines[i].match(/^aliases:\s*(.*)$/);
		if (aliasMatch) {
			aliases.push(...parseAliasesValue(lines, i, aliasMatch[1].trim(), stripQuotes));
			continue;
		}
		const pinnableMatch = lines[i].match(/^pinnable:\s*(.*)$/);
		if (pinnableMatch) {
			pinnable = pinnableMatch[1].trim().toLowerCase() === "true";
			continue;
		}
		const groupMatch = lines[i].match(/^group:\s*(.*)$/);
		if (groupMatch) {
			const value = stripQuotes(groupMatch[1]);
			if (value) group = value;
			continue;
		}
		const kindMatch = lines[i].match(/^kind:\s*(.*)$/);
		if (kindMatch) {
			const value = stripQuotes(kindMatch[1]);
			if (value) kind = value;
			continue;
		}
		const categoryMatch = lines[i].match(/^category:\s*(.*)$/);
		if (categoryMatch) {
			const value = stripQuotes(categoryMatch[1]);
			if (value) category = value;
			continue;
		}
		// Same conservative scalar rule as `group`: one line, quotes stripped,
		// an empty or block value simply leaves the picker to preview the body.
		const descriptionMatch = lines[i].match(/^description:\s*(.*)$/);
		if (descriptionMatch) {
			const value = stripQuotes(descriptionMatch[1]);
			if (value) description = value;
			continue;
		}
		const guardMatch = lines[i].match(/^guard:\s*(.*)$/);
		if (guardMatch) {
			const value = stripQuotes(guardMatch[1]);
			if (value) guard = value;
		}
	}
	return { aliases, pinnable, group, kind, category, description, guard, body };
}

/** Raw text a definition contributes before nested expansion: its `<append>`
 *  blocks when it has any, else its inline text — the snapshot rule `::pin`
 *  established, reused for roles. `parsed` is null when the block tags
 *  themselves are malformed, which callers report differently from a body that
 *  simply came out empty. */
function rawSnippetBody(raw: string): { parsed: ParsedSnippetBody | null; base: string } {
	const parsed = parseSnippetBlocks(raw);
	const base = parsed ? (parsed.append.length > 0 ? parsed.append.join("\n\n") : parsed.inline) : "";
	return { parsed, base };
}

/** Turns parsed frontmatter into the def the registry stores, applying the
 *  rules that keep `kind: role` and `category:` honest — an unknown `kind` is
 *  ignored rather than silently becoming a role, a role is never pinnable and
 *  never carries a style `group` (both are stripped), and a role whose raw body
 *  has no `<append>` block and no inline text (or whose block tags are
 *  malformed) is reported as unusable. Every problem goes into `diagnostics`
 *  instead of throwing, so one broken file cannot take down the rest of the
 *  registry — and the def is still stored, so the problem is reported rather
 *  than silently making the name resolve to nothing (or, worse, to a lower
 *  tier's definition the author meant to override). An unusable role is hidden
 *  from the picker and refused at selection; see `extractRoleBody`. */
function buildSnippetDef(name: string, frontmatter: SnippetFrontmatter): SnippetDef {
	const diagnostics: string[] = [];
	let kind = frontmatter.kind;
	let pinnable = frontmatter.pinnable;
	let group = frontmatter.group;
	let guard = frontmatter.guard;

	if (kind !== undefined && kind !== ROLE_KIND) {
		diagnostics.push(`unknown kind "${kind}" — only "role" is supported; treating this as an ordinary snippet`);
		kind = undefined;
	}
	if (kind === ROLE_KIND) {
		if (pinnable) {
			diagnostics.push("a role cannot be pinnable — `pinnable` ignored");
			pinnable = false;
		}
		if (group) {
			diagnostics.push("a role cannot carry a style group — `group` ignored");
			group = undefined;
		}
	}
	if (guard !== undefined && guard.trim().toLowerCase() !== QA_GUARD) {
		diagnostics.push(`unknown guard "${guard}" — only "qa" is supported; \`guard\` ignored`);
		guard = undefined;
	}
	if (guard !== undefined && kind === ROLE_KIND) {
		diagnostics.push("a role cannot carry a QA guard — `guard` ignored");
		guard = undefined;
	}
	if (guard !== undefined && !pinnable) {
		diagnostics.push("`guard: qa` requires `pinnable: true` — `guard` ignored");
		guard = undefined;
	}

	const def: SnippetDef = { name, raw: frontmatter.body, pinnable, group };
	if (frontmatter.category) def.category = frontmatter.category;
	if (frontmatter.description) def.description = frontmatter.description;
	if (guard !== undefined) def.guard = QA_GUARD;
	if (kind === ROLE_KIND) {
		def.kind = ROLE_KIND;
		const { parsed, base } = rawSnippetBody(def.raw);
		if (!base.trim()) {
			diagnostics.push(
				parsed
					? "role body is empty — a role injects its <append> blocks or its inline text (same rule as ::pin)"
					: "malformed <prepend>/<append>/<inject> blocks — the role cannot be selected",
			);
		}
	}

	if (diagnostics.length > 0) def.diagnostics = diagnostics;
	return def;
}

/** Loads one directory's `*.md` files into a registry. Within a single
 *  directory, the first occurrence of a name/alias wins (lexicographic
 *  `readdir` order). Missing directory -> empty registry, not an error. */
export function loadSnippetDir(dir: string): Map<string, SnippetDef> {
	const registry = new Map<string, SnippetDef>();
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
	} catch {
		return registry;
	}

	for (const file of files) {
		const name = path.basename(file, ".md").toLowerCase();
		let content: string;
		try {
			content = fs.readFileSync(path.join(dir, file), "utf8");
		} catch {
			continue;
		}
		const frontmatter = parseFrontmatterAliases(content);
		const def = buildSnippetDef(name, frontmatter);
		if (!registry.has(name)) registry.set(name, def);
		for (const alias of frontmatter.aliases) {
			const key = alias.toLowerCase();
			if (key && !registry.has(key)) registry.set(key, def);
		}
	}
	return registry;
}

/** Reconciles inherited alias keys with the canonical definition each alias
 *  belongs to. `loadSnippetDir` gives every canonical id and its aliases the
 *  same object inside one directory; a plain key-wise overlay across tiers
 *  would leave a lower tier's alias pointing at a definition whose canonical
 *  key a higher tier replaced — a stale object the picker could preview while
 *  the inserted canonical trigger activates the replacement.
 *
 *  After the overlay, every alias key (a key whose winning definition has a
 *  different canonical name) is re-pointed at that name's effective canonical
 *  owner. An explicit higher-tier claim on the alias key is itself the winning
 *  entry and normally owns its own canonical key at the same tier, so it is
 *  left alone. When the canonical key is won by a DIFFERENT definition name —
 *  the old owner is shadowed — its aliases are dropped rather than redirected
 *  to an unrelated identity, so no stale picker row or hidden body survives.
 *  Within-directory first-key-wins is applied by `loadSnippetDir` and is not
 *  revisited here. */
function reconcileInheritedAliases(merged: Map<string, SnippetDef>): Map<string, SnippetDef> {
	const canonical = new Map<string, SnippetDef>();
	for (const [key, def] of merged) {
		if (key === def.name) canonical.set(key, def);
	}
	for (const [key, def] of merged) {
		if (key === def.name) continue;
		const owner = canonical.get(def.name);
		if (!owner) {
			merged.delete(key);
			continue;
		}
		if (owner !== def) merged.set(key, owner);
	}
	return merged;
}

/** Merges bundled example snippets (shipped alongside this module in
 *  `../examples/`, lowest priority) with the user's own `~/.omp/agent/snippets/*.md`
 *  (personal snippets available in every project) under the current
 *  project's `.omp/snippets/*.md` (highest priority) — later tiers win on
 *  name/alias collision, so a project can override a personal snippet and a
 *  personal snippet can override a bundled example. This matches omp's own
 *  user-then-project precedence for skills and extensions (`getAgentDir()`
 *  for user scope, `.omp/` for project scope).
 *  An inherited alias follows the effective higher-tier definition of its
 *  canonical id (body and all metadata); a higher tier claiming the alias key
 *  itself still wins, and aliases of a shadowed, differently-named owner are
 *  dropped (see `reconcileInheritedAliases`).
 *  `loadSnippetDir` returns an empty registry for a missing directory (not
 *  an error), so this is a no-op wherever a tier's directory doesn't exist —
 *  e.g. `../examples/` when this file is vendored directly into a project's
 *  own `.omp/extensions/` instead of installed as a marketplace plugin, or
 *  `~/.omp/agent/snippets/` for a user who has never created one.
 *  `userDir` defaults to the real user agent dir and is only ever
 *  overridden in tests. */
export function buildSnippetRegistry(cwd: string, userDir: string = getAgentDir()): Map<string, SnippetDef> {
	const bundled = loadSnippetDir(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples"));
	const user = loadSnippetDir(path.join(userDir, "snippets"));
	const project = loadSnippetDir(path.join(cwd, ".omp", "snippets"));
	return reconcileInheritedAliases(new Map([...bundled, ...user, ...project]));
}

// ============================================================================
// Arg placeholder substitution — copied from @oh-my-pi/pi-coding-agent's
// src/utils/command-args.ts (same convention as .omp/commands/*.md; not part
// of the package's public export surface, so copied rather than imported).
// See THIRD_PARTY_NOTICES.md for the upstream MIT notice this carries.
// ============================================================================

export function parseCommandArgs(argsString: string): string[] {
	return parseCommandArgsWithOpaque(argsString, 0, EMPTY_ROLE_ARG_SPANS);
}

/** Tokenizes ordinary arguments while copying any protected role expression
 *  as one untouched token. Its internal spaces and quotes are role data, not
 *  shell-style separators or quote delimiters. */
function parseCommandArgsWithOpaque(argsString: string, sourceOffset: number, opaque: readonly TextSpan[]): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const span = opaqueSpanAt(opaque, sourceOffset + i);
		if (span) {
			const end = Math.min(argsString.length, span.end - sourceOffset);
			current += argsString.slice(i, end);
			i = end - 1;
			continue;
		}
		const char = argsString.charAt(i);
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	result = result.replace(/\$(\d+)/g, (_, num: string) => args[Number.parseInt(num, 10) - 1] ?? "");

	result = result.replace(/\$@\[(\d+)(?::(\d*)?)?\]/g, (_, startRaw: string, lengthRaw?: string) => {
		const start = Number.parseInt(startRaw, 10);
		if (!Number.isFinite(start) || start < 1) return "";
		const startIndex = start - 1;
		if (startIndex >= args.length) return "";
		if (lengthRaw === undefined || lengthRaw === "") return args.slice(startIndex).join(" ");
		const length = Number.parseInt(lengthRaw, 10);
		if (!Number.isFinite(length) || length <= 0) return "";
		return args.slice(startIndex, startIndex + length).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replaceAll("$ARGUMENTS", allArgs);
	result = result.replaceAll("$@", allArgs);
	return result;
}

// ============================================================================
// Block parser — ported from opencode-snippets' parseSnippetBlocks.
// See THIRD_PARTY_NOTICES.md for the upstream MIT notice this carries.
// ============================================================================

export type BlockType = "prepend" | "append" | "inject";
const BLOCK_TYPES: BlockType[] = ["prepend", "append", "inject"];
const MAX_EXPANSION_DEPTH = 15;

export interface ParsedSnippetBody {
	inline: string;
	prepend: string[];
	append: string[];
	inject: string[];
}
const EMPTY_ROLE_ARG_SPANS: readonly TextSpan[] = [];

/** Lenient stack-based parser: unclosed tag -> rest of content becomes the
 *  block; nesting/mismatch -> null (caller leaves the trigger unexpanded). */
export function parseSnippetBlocks(content: string): ParsedSnippetBody | null {
	return parseSnippetBlocksWithOpaque(content, EMPTY_ROLE_ARG_SPANS);
}

/** Parses blocks while treating opaque operational-role arguments as data.
 *  This internal form is used after argument substitution: a submitted role
 *  wrapper can then contain tag-looking text without opening, closing, or
 *  changing the snippet's own prepend/append/inject structure. */
function parseSnippetBlocksWithOpaque(content: string, opaque: readonly TextSpan[]): ParsedSnippetBody | null {
	const prepend: string[] = [];
	const append: string[] = [];
	const inject: string[] = [];
	let inline = "";

	const tagPattern = /<(\/?)(prepend|append|inject)>/gi;
	let lastIndex = 0;
	let currentBlock: { type: BlockType; contentStart: number } | null = null;
	const push = (type: BlockType, value: string) => {
		if (!value) return;
		(type === "prepend" ? prepend : type === "append" ? append : inject).push(value);
	};
	let match = tagPattern.exec(content);
	while (match !== null) {
		if (opaqueSpanAt(opaque, match.index)) {
			match = tagPattern.exec(content);
			continue;
		}
		const isClosing = match[1] === "/";
		const tagName = match[2].toLowerCase() as BlockType;
		const tagStart = match.index;
		const tagEnd = tagStart + match[0].length;

		if (isClosing) {
			if (currentBlock === null) {
				match = tagPattern.exec(content);
				continue; // stray closing tag — ignore
			}
			if (currentBlock.type !== tagName) return null; // mismatched
			push(currentBlock.type, content.slice(currentBlock.contentStart, tagStart).trim());
			lastIndex = tagEnd;
			currentBlock = null;
		} else {
			if (currentBlock !== null) return null; // nested tags not allowed
			inline += content.slice(lastIndex, tagStart);
			currentBlock = { type: tagName, contentStart: tagEnd };
		}
		match = tagPattern.exec(content);
	}

	if (currentBlock !== null) {
		push(currentBlock.type, content.slice(currentBlock.contentStart).trim());
	} else {
		inline += content.slice(lastIndex);
	}

	return { inline: inline.trim(), prepend, append, inject };
}

// ============================================================================
// Recursive expansion — ported from opencode-snippets' expandText/expandHashtags.
// See THIRD_PARTY_NOTICES.md for the upstream MIT notice this carries.
// ============================================================================

interface BlockRecord {
	type: BlockType;
	snippetName: string;
	content: string;
}

interface BlockCollector {
	prepend: BlockRecord[];
	append: BlockRecord[];
	inject: BlockRecord[];
	seen: Set<string>;
}

function addBlock(collector: BlockCollector, type: BlockType, snippetName: string, content: string): void {
	if (!content) return;
	const key = `${type}\u0000${snippetName}\u0000${content}`;
	if (collector.seen.has(key)) return;
	collector.seen.add(key);
	collector[type].push({ type, snippetName, content });
}

// A trigger name is not a fixed character class any more: the bundled `q&a`
// id and a spaced alias like `question and answer` are legal names, so the
// expansion resolves a head against the registry instead of lexing it with
// one regex. `TRIGGER_TOKEN_PATTERN` is the original `[\w-]+` token — the
// shape an UNKNOWN name still has to have (so `::careful-extra` stays one
// unknown name rather than a `careful` prefix match, exactly as before) —
// while a registered key may be longer than the token at that position and
// win. Deliberately no `&` in the token class: `::a&b` keeps expanding `a`
// and leaving `&b`, the behavior it had when `&` was not a trigger character
// at all; only the registry can make `&` part of a name.
const TRIGGER_TOKEN_PATTERN = /[\w-]+/y;

/** Name shape a REGISTERED key must have to be reachable as a bare trigger:
 *  `[\w-]`/`&` tokens separated by single spaces. This is what makes the
 *  spaced alias (`question and answer`) a legal trigger name, and what keeps
 *  an alias that is not shaped like a name (punctuation, double spaces, a
 *  leading dash) out of the bare-trigger grammar — such a key stays reachable
 *  through the picker and `::pin`, which look names up rather than lexing
 *  them, but can never silently swallow surrounding prose. */
const TRIGGER_NAME_SHAPE = /^[\w&-]+(?: [\w&-]+)*$/;

/** A character that could continue a name a registered key already matched:
 *  the key may only win when the text behind it cannot extend that name, so
 *  `::careful-extra` never resolves to `careful` and `::question and answers`
 *  never resolves to `question and answer`. `&` is not in this class for the
 *  same reason it is not in the token class above. */
const TRIGGER_NAME_CHAR = /[\w-]/;

/** One resolved `::name` head: the name text as typed, and the index just
 *  past it. */
interface TriggerHead {
	name: string;
	end: number;
}

/** The `::name` head starting at `index` — the character right after `::`.
 *
 *  The head is the LONGER of the grammar token run (`[\w-]+`, registered or
 *  not: an unknown head still counts as a chain sibling and must be kept
 *  literal) and any registered key matching at that position. Consulting the
 *  registry is what makes names the grammar alone cannot express reachable
 *  everywhere a name is accepted — `q&a`'s `&` and the spaced
 *  `question and answer` alias resolve exactly like `qa` does — while the
 *  boundary check keeps a registered key from matching as a prefix of a
 *  longer unregistered word. */
function matchTriggerHead(text: string, index: number, registry: Map<string, SnippetDef>): TriggerHead | undefined {
	TRIGGER_TOKEN_PATTERN.lastIndex = index;
	const token = TRIGGER_TOKEN_PATTERN.exec(text);
	let best: TriggerHead | undefined;
	if (token) best = { name: token[0], end: index + token[0].length };

	for (const key of registry.keys()) {
		if (key.length <= (best?.name.length ?? 0)) continue;
		if (!TRIGGER_NAME_SHAPE.test(key)) continue;
		const end = index + key.length;
		if (end > text.length) continue;
		if (text.slice(index, end).toLowerCase() !== key) continue;
		const after = text[end];
		if (after !== undefined && TRIGGER_NAME_CHAR.test(after)) continue;
		best = { name: text.slice(index, end), end };
	}
	return best;
}

/** The `::a ::b<<...>>` chain starting at `first`: every head stacked
 *  immediately before one bracketed span (whitespace only between them), the
 *  span's verbatim argument, and the index just past its closing `>>`.
 *  `undefined` when the run does not end in a CLOSED bracket — an unclosed
 *  `<<` falls back to expanding the heads bare, exactly like the regex this
 *  replaces. Only a head's own grammar decides membership here (a `::` head
 *  that resolves to nothing still counts), because the chain's identity is
 *  syntactic: `::reflect::doesnotexist<<the plan>>` must still feed the
 *  bracket to `reflect` while leaving the unknown sibling literal. */
function collectBracketChain(
	text: string,
	first: TriggerHead,
	registry: Map<string, SnippetDef>,
): { names: string[]; arg: string; start: number; end: number } | undefined {
	const names = [first.name];
	let cursor = first.end;
	for (;;) {
		let i = cursor;
		while (i < text.length && /\s/.test(text[i])) i++;
		if (text.startsWith("::", i)) {
			const next = matchTriggerHead(text, i + 2, registry);
			if (!next) return undefined;
			names.push(next.name);
			cursor = next.end;
			continue;
		}
		if (!text.startsWith("<<", i)) return undefined;
		const close = text.indexOf(">>", i + 2);
		if (close === -1) return undefined;
		return { names, arg: text.slice(i + 2, close).trim(), start: i, end: close + 2 };
	}
}

// `::name<<...>>` — an alternate argument form for when the argument is
// prose rather than a short token list. `(args)` runs through
// parseCommandArgs' shell-style tokenizer, which breaks on any unescaped
// `)` in the text and is awkward across multiple lines; `<<...>>` instead
// takes its entire contents verbatim as a single $1/$ARGUMENTS value — no
// tokenizing, free to contain parens/quotes/newlines. One bracketed span
// can also feed a *chain* of triggers stacked immediately before it:
// `::a::b<<shared text>>` calls both `a` and `b` with the same argument,
// mirroring how bare `::a ::b` already compose in one message today.
//
// Requiring the chain to sit immediately left of `<<` (only whitespace
// between) is deliberate, not just stylistic: it's what keeps this pattern
// from ever matching `<<` used for its ordinary meanings in pasted code
// (bit-shift, heredocs, git conflict markers) — none of those are preceded
// by a `::name` token, so they're never touched.
//
// Known limitation: matches the FIRST `>>`, so content containing its own
// `>>` (pasted C++ nested generics `Foo<Bar<Baz>>`, a `>>` operator) closes
// the bracket early — the same lenient, no-nesting tradeoff the
// <prepend>/<append>/<inject> body-block parser above already accepts.
// `collectBracketChain` recognizes the same spans this used to regex for.

type TriggerExpansion = { ok: true; text: string } | { ok: false; loop: boolean };

/** Expands one trigger occurrence against `args`. `ok: false` means the
 *  caller should leave the original text unchanged (unknown name, malformed
 *  body blocks, or empty result); `loop: true` additionally means expansion
 *  depth was exceeded and the whole enclosing match should stop retrying. */
function expandSingleTrigger(
	name: string,
	args: string[],
	registry: Map<string, SnippetDef>,
	expansionCounts: Map<string, number>,
	collector: BlockCollector,
): TriggerExpansion {
	const snippet = lookupOrdinarySnippet(registry, name);
	if (!snippet) return { ok: false, loop: false };

	const count = (expansionCounts.get(snippet.name) ?? 0) + 1;
	if (count > MAX_EXPANSION_DEPTH) return { ok: false, loop: true };
	expansionCounts.set(snippet.name, count);

	const substituted = substituteArgs(snippet.raw, args);
	// Substitution can form an unsupported role wrapper around tag-looking data,
	// so discover its opaque spans before interpreting any block tags.
	const opaque = substituted.includes("::") ? findOpaqueRoleArgSpans(substituted, registry) : EMPTY_ROLE_ARG_SPANS;
	const parsed = parseSnippetBlocksWithOpaque(substituted, opaque);
	if (!parsed) return { ok: false, loop: false }; // malformed blocks — leave unexpanded

	if (!parsed.inline && parsed.prepend.length === 0 && parsed.append.length === 0 && parsed.inject.length === 0) {
		return { ok: false, loop: false };
	}

	for (const type of BLOCK_TYPES) {
		for (const raw of parsed[type]) {
			const nested: BlockCollector = { prepend: [], append: [], inject: [], seen: new Set() };
			const nestedContent = expandText(raw, registry, expansionCounts, nested);
			addBlock(collector, type, snippet.name, nestedContent);
			for (const nestedType of BLOCK_TYPES) {
				for (const b of nested[nestedType]) addBlock(collector, nestedType, b.snippetName, b.content);
			}
		}
	}

	return { ok: true, text: expandText(parsed.inline, registry, expansionCounts, collector) };
}

/** Expands one bracketed chain head-run at `start` — `::a::b<<...>>`, one
 *  bracket feeding every head stacked immediately before it — or `undefined`
 *  when no chain starts there (so the caller's scan moves on). Only consumes
 *  the run and its brackets once at least one head actually expanded, exactly
 *  like the regex this replaces; an all-unknown chain is left untouched. */
function expandChainAt(
	text: string,
	start: number,
	head: TriggerHead,
	registry: Map<string, SnippetDef>,
	expansionCounts: Map<string, number>,
	collector: BlockCollector,
	markLoop: () => void,
	opaque: readonly TextSpan[],
): { text: string; end: number } | undefined {
	const chain = collectBracketChain(text, head, registry);
	if (!chain) return undefined;
	// A bracket fed by a role head is that role's unsupported argument. No
	// sibling in the run may consume it, so the whole chain stays as typed —
	// its contents never contribute to an ordinary expansion.
	if (opaqueSpanAt(opaque, chain.start)) return { text: text.slice(start, chain.end), end: chain.end };
	const pieces: string[] = [];
	let anyExpanded = false;
	for (const name of chain.names) {
		const result = expandSingleTrigger(name, [chain.arg], registry, expansionCounts, collector);
		if (!result.ok) {
			if (result.loop) markLoop();
			pieces.push(`::${name}`); // unknown/malformed — keep this one literal
			continue;
		}
		anyExpanded = true;
		pieces.push(result.text);
	}
	return anyExpanded
		? { text: pieces.join(" "), end: chain.end }
		: { text: text.slice(start, chain.end), end: chain.end };
}

/** Expands the bracket chains in `text`, left to right, and nothing else.
 *
 *  This runs as its own pass BEFORE the parenthesized arguments are
 *  shell-tokenized (see `expandText`), which is the order the two regex
 *  passes this module used to run in, and it is load-bearing: in
 *  `::outer(::inner<<two words>>)` the chain inside `outer`'s argument must
 *  expand to `INNER` first, or the tokenizer splits the unexpanded
 *  `<<two words>>` into two arguments and the snippet sees a mangled `$1`. */
function expandBracketChains(
	text: string,
	registry: Map<string, SnippetDef>,
	expansionCounts: Map<string, number>,
	collector: BlockCollector,
	markLoop: () => void,
): string {
	let scanText = text;
	let out = "";
	let i = 0;
	// Recomputed when a replacement opens an opaque span across the remaining
	// text; recursive snippet bodies may introduce such wrappers.
	let opaque = findOpaqueRoleArgSpans(scanText, registry);
	while (i < scanText.length) {
		const start = scanText.indexOf("::", i);
		if (start === -1) {
			out += scanText.slice(i);
			break;
		}
		const span = opaqueSpanAt(opaque, start);
		if (span) {
			out += scanText.slice(i, span.end);
			i = span.end;
			continue;
		}
		const head = matchTriggerHead(scanText, start + 2, registry);
		// No head, or a head that opens no chain: keep the text as it was and
		// rescan one character on, so a `::` inside a later head run or arg is visited.
		if (!head) {
			out += scanText.slice(i, start + 1);
			i = start + 1;
			continue;
		}
		const chain = expandChainAt(scanText, start, head, registry, expansionCounts, collector, markLoop, opaque);
		if (!chain) {
			out += scanText.slice(i, head.end);
			i = head.end;
			continue;
		}
		out += scanText.slice(i, start) + chain.text;
		i = chain.end;
		if (i < scanText.length) {
			const boundary = out.length;
			const effective = out + scanText.slice(i);
			const updatedOpaque = findOpaqueSpansCrossingBoundary(effective, boundary, registry);
			if (updatedOpaque) {
				scanText = effective;
				opaque = updatedOpaque;
				i = boundary;
			}
		}
	}
	return out;
}

/** Expands the one non-chain trigger starting at the `::` at `start`,
 *  returning the replacement text and the index just past everything it
 *  consumed (always past `start`, so the caller's scan advances even on a
 *  miss):
 *    - `::name(args)`: the first `)` outside an opaque role span closes the
 *      argument (otherwise the old first-`)` rule is retained), and an
 *      unterminated `(` leaves the head bare with the rest of the span literal.
 *    - `::name` alone: a one-shot trigger with no arguments. */
function expandTriggerAt(
	text: string,
	start: number,
	registry: Map<string, SnippetDef>,
	expansionCounts: Map<string, number>,
	collector: BlockCollector,
	markLoop: () => void,
	opaque: readonly TextSpan[],
): { text: string; end: number } {
	const head = matchTriggerHead(text, start + 2, registry);
	// No name after `::`: leave one colon and rescan from the next character,
	// so `:::name` still finds the inner `::name` the way the old regex did.
	if (!head) return { text: ":", end: start + 1 };

	if (text[head.end] === "(") {
		let close = text.indexOf(")", head.end + 1);
		while (close !== -1 && opaqueSpanAt(opaque, close)) close = text.indexOf(")", close + 1);
		const end = close === -1 ? head.end : close + 1;
		const args = close === -1 ? [] : parseCommandArgsWithOpaque(text.slice(head.end + 1, close), head.end + 1, opaque);
		const result = expandSingleTrigger(head.name, args, registry, expansionCounts, collector);
		if (result.ok) return { text: result.text, end };
		if (result.loop) markLoop();
		return { text: text.slice(start, end), end };
	}

	const result = expandSingleTrigger(head.name, [], registry, expansionCounts, collector);
	if (result.ok) return { text: result.text, end: head.end };
	if (result.loop) markLoop();
	return { text: text.slice(start, head.end), end: head.end };
}

/** Expands the non-chain triggers in `text`, left to right. Runs after
 *  `expandBracketChains`, so a chain nested inside an argument span has
 *  already become plain text by the time the argument is tokenized here. */
function expandSingleTriggers(
	text: string,
	registry: Map<string, SnippetDef>,
	expansionCounts: Map<string, number>,
	collector: BlockCollector,
	markLoop: () => void,
): string {
	let scanText = text;
	let out = "";
	let i = 0;
	// Recompute ranges when a replacement opens a role wrapper over remaining
	// text, then resume so that only the newly protected portion is skipped.
	let opaque = findOpaqueRoleArgSpans(scanText, registry);
	while (i < scanText.length) {
		const start = scanText.indexOf("::", i);
		if (start === -1) {
			out += scanText.slice(i);
			break;
		}
		out += scanText.slice(i, start);
		const span = opaqueSpanAt(opaque, start);
		if (span) {
			out += scanText.slice(start, span.end);
			i = span.end;
			continue;
		}
		const expansion = expandTriggerAt(scanText, start, registry, expansionCounts, collector, markLoop, opaque);
		out += expansion.text;
		i = expansion.end;
		if (i < scanText.length) {
			const boundary = out.length;
			const effective = out + scanText.slice(i);
			const updatedOpaque = findOpaqueSpansCrossingBoundary(effective, boundary, registry);
			if (updatedOpaque) {
				scanText = effective;
				opaque = updatedOpaque;
				i = boundary;
			}
		}
	}
	return out;
}

export function expandText(
	text: string,
	registry: Map<string, SnippetDef>,
	expansionCounts: Map<string, number>,
	collector: BlockCollector,
): string {
	let expanded = text;
	let changed = true;

	while (changed) {
		const previous = expanded;
		let loopDetected = false;
		const markLoop = (): void => {
			loopDetected = true;
		};

		// Chains first, then everything else: the order the two regex passes
		// ran in, and what keeps a bracket chain nested inside a `(...)`
		// argument from being split by the argument tokenizer.
		expanded = expandBracketChains(expanded, registry, expansionCounts, collector, markLoop);
		expanded = expandSingleTriggers(expanded, registry, expansionCounts, collector, markLoop);

		changed = expanded !== previous && !loopDetected;
	}

	return expanded;
}

export interface ExpansionResult {
	text: string;
	prepend: string[];
	append: string[];
	inject: string[];
}

export function expandTriggers(text: string, registry: Map<string, SnippetDef>): ExpansionResult {
	const collector: BlockCollector = { prepend: [], append: [], inject: [], seen: new Set() };
	const expandedText = expandText(text, registry, new Map(), collector);
	return {
		text: expandedText,
		prepend: collector.prepend.map((b) => b.content),
		append: collector.append.map((b) => b.content),
		inject: collector.inject.map((b) => b.content),
	};
}

/** Joins prepend blocks + main text + append blocks, double-newline separated. */
export function assembleMessage(result: Pick<ExpansionResult, "text" | "prepend" | "append">): string {
	const parts: string[] = [];
	if (result.prepend.length > 0) parts.push(result.prepend.join("\n\n"));
	if (result.text.trim()) parts.push(result.text);
	if (result.append.length > 0) parts.push(result.append.join("\n\n"));
	return parts.join("\n\n");
}

// ============================================================================
// Pins — ::pin(name) / ::unpin(name) / ::pins
//
// Snippets are one-shot by design: `::careful ::concise` each contribute one
// instruction to the message they're typed in, then fall out of context like
// any other turn. Most snippet content is inherently one-shot — `verify.md`
// ("verify what you just said"), `judge.md` (spawn a reviewer for "the
// current discussion"), `drift.md` (compare intent vs. a specific finished
// result) — none of that generalizes into a standing instruction; repeating
// it on unrelated future turns would be incoherent, not just noisy.
//
// A small minority of snippet content — `careful`, `concise` — reads as a
// durable behavioral/style policy instead of a one-time action. `::pin(name)`
// lets that minority opt into persistence, explicitly, per-invocation:
//   - Only snippets marked `pinnable: true` in frontmatter can be pinned;
//     `::pin(verify)` is left inert, same as an unknown trigger — pinning
//     isn't a property the *caller* gets to force onto arbitrary content.
//   - Pinning is additive/composable, not a single mutually-exclusive slot:
//     `::pin(careful) ::pin(concise)` holds both, matching how the ordinary
//     one-shot mechanism already composes multiple triggers.
//   - `::pin(name)` still expands exactly like `::name` for the message it's
//     typed in (unchanged one-shot behavior) — pinning is additive on top,
//     not a replacement delivery path.
//   - Pinned content is re-asserted into the system prompt on *every*
//     subsequent turn via `before_agent_start`'s `systemPrompt: string[]`
//     return. This is NOT engine-side persistence — `event.systemPrompt` is
//     rebuilt fresh from the base template every turn (confirmed in
//     `agent-session.ts`: `#buildSystemPromptForAgentStart` runs per-call,
//     and a returned `systemPrompt` only overrides that one provider
//     request), so the extension is entirely responsible for re-supplying
//     pinned blocks itself each time from its own held state. No
//     accumulation risk either way: each turn starts from the pristine base
//     and we append fresh from our own map, never from a prior turn's
//     already-mutated array.
//   - `::unpin(name)` / `::pins` are session-only bookkeeping, not content —
//     `pin`/`unpin`/`pins` are reserved trigger names, checked before the
//     ordinary snippet registry lookup.
//   - Pins live for the running session only; they are not persisted to
//     disk and do not survive a restart.
//
// ## Q&A-only guard — `guard: qa`
//
// A pinnable ordinary snippet may carry `guard: qa` in frontmatter
// (`examples/q&a.md` does). While ANY active pin snapshot carries that
// guard, `qa-guard.ts` blocks tool calls that could mutate or execute — the
// allowlist and exact refusal contract live there — and the extension adds
// one `<qa-enforcement>` system-prompt block plus a `🛡 Q&A-only` status line.
// The guard is part of the pin snapshot and follows the pin's lifetime
// exactly: it appears with a successful `::pin(name)`/Right-arrow activation
// and disappears when that pin is unpinned, because it is derived from the
// same map on every use — nothing tracks guards in a second place that could
// drift. Activation of a guarded pin is refused outright while the agent is
// not idle or owned async jobs are still running (enforcement cannot
// retroactively stop work already in flight), and a host that cannot report
// either fact refuses too. Bare `::name` remains the one-shot prompt it always
// was: only `::pin(name)` (or the picker's Right arrow) activates the
// enforced mode. The guard is host tool interception, not OS containment —
// the user's own shell, other sessions, and external processes are outside
// its authority.
// ============================================================================

/** One pinned snippet's snapshot: the fully expanded content re-delivered
 *  every turn, plus the definition's `guard: qa` marker when it had one. The
 *  guard lives in the snapshot on purpose — the file can change or disappear
 *  after pinning, and enforcement must match what was actually pinned. */
export interface PinnedSnippet {
	content: string;
	guard?: "qa";
}

/** Runtime gate consulted before a QA-guarded pin may activate: returns a
 *  refusal reason (shown to the user; nothing changes) or `null` to allow.
 *  Only definitions with `guard: qa` ever call it — ordinary pins never
 *  consult the session at all. */
export type QaActivationGate = (def: SnippetDef) => string | null;

/** Auto-unpins any other currently-pinned snippet sharing `def.group` (a
 *  no-op if `def.group` is unset — the default for most pinnable snippets,
 *  which are freely composable). Enforces exclusivity for the rare pair
 *  whose content is logically, not just stylistically, contradictory (e.g.
 *  `bluf` "state the answer first" vs. `socratic` "never state the answer" —
 *  no single response can satisfy both, so silently keeping both pinned
 *  just means the model picks a winner with no signal to the user which).
 *  Returns the names actually removed, so callers can surface a notice. */
export function unpinGroupSiblings(def: SnippetDef, registry: Map<string, SnippetDef>, pinned: Map<string, PinnedSnippet>): string[] {
	if (!def.group) return [];
	const removed: string[] = [];
	for (const name of pinned.keys()) {
		if (name === def.name) continue;
		if (registry.get(name)?.group === def.group) removed.push(name);
	}
	for (const name of removed) pinned.delete(name);
	return removed;
}

/** Shared tail of both pin entry points: enforce group exclusivity, expand
 *  the trigger for its full one-shot content, and persist it into the
 *  pinned map. `triggerText` is what follows `::` — a bare canonical name
 *  for the hotkey path (`pinSnippetByName`, no args to bind), or
 *  `name(args)` for the text-trigger path (`::pin(max-chars(280))`).
 *  Factored out so the pinned-content extraction rule
 *  (`expansion.append.join("\n\n") || expansion.text`) lives in exactly
 *  one place — `pinSnippetByName` and the `::pin(...)` branch below used
 *  to duplicate this verbatim, which meant any future change to it had to
 *  be made twice or the two paths would silently drift. Returns the names
 *  auto-unpinned by group exclusivity (empty if none).
 *
 *  A refresh (pinning a name that is already pinned) keeps the guard marker
 *  the ACTIVE snapshot carries: dropping `guard: qa` from a definition file
 *  must never silently release enforcement, because the pin's promise is
 *  "nothing mutating runs until the user unpins" — an explicit `::unpin`
 *  (or a group replacement, which removes the pin outright) is the only
 *  exit, not a source edit. */
function applyPin(def: SnippetDef, triggerText: string, registry: Map<string, SnippetDef>, pinned: Map<string, PinnedSnippet>): string[] {
	const removed = unpinGroupSiblings(def, registry, pinned);
	const expansion = expandTriggers(`::${triggerText}`, registry);
	const content = expansion.append.join("\n\n") || expansion.text;
	const guard = def.guard === QA_GUARD || pinned.get(def.name)?.guard === QA_GUARD;
	pinned.set(def.name, guard ? { content, guard: QA_GUARD } : { content });
	return removed;
}

/** Runtime gate decision for one pin activation: a QA-guarded definition is
 *  refused when the supplied gate rejects it, or when no gate exists at all
 *  (fail-closed — the pure helpers cannot verify that nothing is running).
 *  A definition whose ACTIVE snapshot already carries the guard counts as
 *  guarded too: refreshing an enforced pin must pass the same gate as arming
 *  it, or a source edit that drops `guard: qa` would turn a busy-session
 *  refresh into an ungated mutation of the snapshot. Ordinary definitions
 *  never consult the gate. Called BEFORE any mutation, so a refused
 *  activation never unpins group siblings. */
function qaGateRefusal(def: SnippetDef, gate: QaActivationGate | undefined, pinned: ReadonlyMap<string, PinnedSnippet>): string | null {
	if (def.guard !== QA_GUARD && pinned.get(def.name)?.guard !== QA_GUARD) return null;
	return gate ? gate(def) : "no activation gate is available in this context";
}

/** Runtime-only refusal reason for activating a QA-guarded pin in this
 *  session, or `null` when activation is allowed. Reads the live context on
 *  every call — activation is judged at the moment of the pin, not captured
 *  when the picker was installed — and refuses while the agent is streaming
 *  or owned async jobs are still running, because enforcement cannot
 *  retroactively stop work already in flight. A host that cannot report
 *  either fact, or reports a shape this code cannot read, refuses too: the
 *  guard's promise is "nothing mutating runs until you unpin", and an
 *  unverifiable host cannot honor it. Ordinary pins never consult this. */
export function qaActivationRefusal(ctx: ExtensionContext): string | null {
	const host = ctx as unknown as {
		isIdle?: () => unknown;
		getAsyncJobSnapshot?: () => unknown;
	};
	if (typeof host.isIdle !== "function") return "this omp host cannot report idle/async-job state";
	const idle = host.isIdle();
	if (idle === false) return "the agent is currently working; pin again when it is idle";
	if (idle !== true) return "this omp host returned an unreadable idle state";
	if (typeof host.getAsyncJobSnapshot !== "function") return "this omp host cannot report idle/async-job state";
	const snapshot = host.getAsyncJobSnapshot();
	// Only the native `null` means "no owned manager/jobs". Anything else —
	// `undefined` included — must carry a readable `running` array, or the
	// host cannot prove nothing is running and activation stays refused.
	if (snapshot === null) return null;
	const running = (snapshot as { running?: unknown } | undefined)?.running;
	if (!Array.isArray(running)) return "this omp host returned an unreadable async-job snapshot";
	if (running.length > 0) return `${running.length} owned job(s) are still running; wait or cancel them`;
	return null;
}

/** The name-shaped prefix of a `::pin(...)`/`::unpin(...)` body: `[\w-]`/`&`
 *  tokens separated by single spaces, stopping at the argument span or any
 *  other punctuation. The same shape `TRIGGER_NAME_SHAPE` accepts, left
 *  unanchored at the end so the body's `(args)` part is not part of it. */
const TRIGGER_NAME_PREFIX = /^[\w&-]+(?: [\w&-]+)*/;

/** The snippet a `::pin(...)`/`::unpin(...)` body names, resolved through
 *  the same head matcher the expansion uses — so every key that resolves to
 *  one definition (the bundled `q&a` example's canonical id and its five
 *  aliases, for instance) addresses the one pin, whatever the surface it was
 *  typed on. `typed` is the name as typed, lowercased; `canonical` is the
 *  definition's own name when the registry knows it.
 *
 *  An ACTIVE pin whose key equals the body's whole name-shaped prefix wins
 *  before the live registry is consulted: that name is the pin's own
 *  canonical name, and after the defining file is deleted a shorter
 *  surviving name would otherwise capture it (`q&a` resolves to an ordinary
 *  `q`, so the real pin could never be released — and `q` might be unpinned
 *  by mistake instead). A `&` name the registry does not know never degrades
 *  to the shorter token before its `&` either, for the same reason. Without
 *  any match, the name-shaped prefix stands in for both fields, because the
 *  grammar token alone would read `q&a` as `q`. */
function parsePinTarget(
	inner: string,
	registry: Map<string, SnippetDef>,
	pinned: ReadonlyMap<string, PinnedSnippet>,
): { typed: string; canonical: string } {
	const trimmed = inner.trim();
	const prefix = TRIGGER_NAME_PREFIX.exec(trimmed)?.[0].toLowerCase() ?? "";
	if (prefix && pinned.has(prefix)) return { typed: prefix, canonical: prefix };

	const headName = matchTriggerHead(trimmed, 0, registry)?.name.toLowerCase() ?? "";
	const def = registry.get(headName);
	// A `&` name is only usable when the registry knows that exact name: the
	// grammar token alone reads `probe&guard` as `probe`, and neither pinning nor
	// unpinning may silently address that shorter snippet instead (a live `q`
	// must never stand in for a `q&a` the registry no longer has).
	if (def && prefix !== headName && prefix.includes("&")) return { typed: prefix, canonical: prefix };
	const typed = def ? headName : (prefix || headName);
	return { typed, canonical: def?.name ?? typed };
}

/** Handles `::pin(name)` / `::pin(name(args))` / `::unpin(name)` / `::pins`
 *  as a stateful preprocessing pass that runs BEFORE the pure
 *  `expandTriggers` pipeline. Mutates `pinned` in place (side effect is the
 *  point); returns the rewritten text. `::pin(...)` rewrites to a plain
 *  `::name`/`::name(args)` trigger so the normal pipeline still renders its
 *  one-shot content for this message (with args substituted, for
 *  parameterized pinnable snippets like `max-chars`); `::unpin`/`::pins`
 *  have no snippet content of their own, so they're replaced with a short
 *  inline confirmation directly. The outer capture allows one level of
 *  nested parens (`(?:[^()]|\([^()]*\))*`) so `::pin(max-chars(280))` parses
 *  as inner content `max-chars(280)`, not truncated at the first `)`.
 *  The name inside those parens is resolved against the registry
 *  (`parsePinTarget`), so an alias and the canonical id operate on the same
 *  pin; the rewrite keeps the typed name, which the expansion resolves the
 *  same way.
 *  Optional `autoUnpinnedOut`: when a `::pin(name)` triggers group exclusion
 *  (see `unpinGroupSiblings`), the auto-removed name(s) are pushed here so
 *  the caller can surface a notice — omit it to ignore that signal
 *  entirely (backward compatible with existing callers/tests).
 *  Optional `gate`: consulted for a `guard: qa` definition before anything
 *  mutates. A refusal rewrites the trigger to an inline confirmation —
 *  `(name not pinned — <reason>)`, or `(name stays pinned — <reason>)` when
 *  the pin already existed and only its refresh was declined — and group
 *  siblings are never unpinned on a refused activation; no gate at all
 *  refuses too (see `qaGateRefusal`).
 *  Any command match overlapping an unsupported real-role argument span is
 *  left exactly as typed (see `findOpaqueRoleArgSpans`): a nested
 *  `::unpin(...)`/`::pin(...)`/`::pins` inside `::role(...)` or a role-fed
 *  `<<...>>` never mutates or lists state, including when that wrapper sits
 *  inside an ordinary argument. Valid commands outside such spans are
 *  processed normally, in the same order as before. */
export function processPinTriggers(
	text: string,
	registry: Map<string, SnippetDef>,
	pinned: Map<string, PinnedSnippet>,
	autoUnpinnedOut?: string[],
	gate?: QaActivationGate,
): string {
	let result = text;
	const NESTED_PARENS = "(?:[^()]|\\([^()]*\\))*";
	// Re-read after every pass: the previous rewrite may shift offsets, while
	// the protected spans themselves never change shape here.

	const pinsOpaque = findOpaqueRoleArgSpans(result, registry);
	result = result.replace(/::pins\b/gi, (match: string, offset: number) => {
		if (overlapsOpaqueSpan(pinsOpaque, offset, match.length)) return match;
		if (pinned.size === 0) return "(no active pins)";
		return `(pinned: ${[...pinned.keys()].sort().join(", ")})`;
	});

	const unpinOpaque = findOpaqueRoleArgSpans(result, registry);
	result = result.replace(new RegExp(`::unpin\\((${NESTED_PARENS})\\)`, "gi"), (match: string, inner: string, offset: number) => {
		if (overlapsOpaqueSpan(unpinOpaque, offset, match.length)) return match;
		const { canonical } = parsePinTarget(inner, registry, pinned);
		if (!canonical) return match;
		if (pinned.has(canonical)) {
			pinned.delete(canonical);
			return `(unpinned: ${canonical})`;
		}
		return `(${canonical} was not pinned)`;
	});

	const pinOpaque = findOpaqueRoleArgSpans(result, registry);
	result = result.replace(new RegExp(`::pin\\((${NESTED_PARENS})\\)`, "gi"), (match: string, inner: string, offset: number) => {
		if (overlapsOpaqueSpan(pinOpaque, offset, match.length)) return match;
		const trimmed = inner.trim();
		const { typed } = parsePinTarget(inner, registry, pinned);
		const def = typed ? lookupOrdinarySnippet(registry, typed) : undefined;
		if (!def || !def.pinnable) return match; // unknown, a role, or not pinnable: left inert
		const refusal = qaGateRefusal(def, gate, pinned);
		if (refusal) {
			// An already-pinned guarded snippet keeps its snapshot when only the
			// refresh is declined — saying "not pinned" there would be false.
			return pinned.has(def.name) ? `(${def.name} stays pinned — ${refusal})` : `(${def.name} not pinned — ${refusal})`;
		}
		const removed = applyPin(def, trimmed, registry, pinned);
		if (autoUnpinnedOut) autoUnpinnedOut.push(...removed);
		return `::${trimmed}`;
	});

	return result;
}

/** Result of a bare-name pin attempt: `pinned` on success (with the names
 *  group exclusivity removed), otherwise why nothing changed. `guard-refused`
 *  means a `guard: qa` definition whose runtime gate said no — the caller
 *  shows `reason` and nothing was mutated. */
export type PinAttempt =
	| { status: "pinned"; autoUnpinned: string[] }
	| { status: "unknown" }
	| { status: "not-pinnable" }
	| { status: "guard-refused"; reason: string };

/** Bare-name pin, no arg substitution — used by the picker's hotkey toggle
 *  (Right arrow), which has no argument value to bind and only ever offers
 *  this on items where `AutocompleteItem.hasArgs` is false. `::pin(name)`
 *  text triggers go through `processPinTriggers` above instead, which also
 *  handles the `name(args)` case this deliberately doesn't. `gate` is
 *  consulted for a `guard: qa` definition — and for a refresh of a pin whose
 *  active snapshot carries the guard — before anything mutates; see
 *  `qaGateRefusal`. */
export function pinSnippetByName(
	name: string,
	registry: Map<string, SnippetDef>,
	pinned: Map<string, PinnedSnippet>,
	gate?: QaActivationGate,
): PinAttempt {
	const def = lookupOrdinarySnippet(registry, name);
	if (!def) return { status: "unknown" };
	if (!def.pinnable) return { status: "not-pinnable" };
	const refusal = qaGateRefusal(def, gate, pinned);
	if (refusal) return { status: "guard-refused", reason: refusal };
	return { status: "pinned", autoUnpinned: applyPin(def, def.name, registry, pinned) };
}

/** Builds the extra system-prompt blocks for currently pinned snippets.
 *  Called fresh on every `before_agent_start` — see the header note above on
 *  why nothing here is engine-persisted.
 *
 *  Wrapped in one explicit-scope preamble, not just the bare style content:
 *  the base prompt already carries protected completeness/verification
 *  rules ("Be brief in prose, not in evidence, verification, or blocking
 *  details"; "NEVER silently shrink scope"; "Verification claims MUST match
 *  what was actually exercised") — and pinned content lands at the most
 *  recency-weighted position in the prompt, closest to generation. A blunt
 *  pin like `concise` ("no fluff, no hedging") sitting there unscoped could
 *  plausibly tip a model toward compressing exactly the evidence/completeness
 *  detail the contract protects. The preamble draws that boundary once, at
 *  the mechanism level, so most pinnable snippets don't have to restate it.
 *
 *  Presentation pins are advisory — this function only adds text, and a model
 *  that ignores a style preference isn't stopped by anything here. A
 *  `guard: qa` pin is the deliberate exception: it is enforced by host tool
 *  interception (`qa-guard.ts`), and its separate `<qa-enforcement>` block
 *  exists to tell the model what is already being blocked, so it neither
 *  burns turns on refused calls nor narrates success that cannot happen. The
 *  preamble above is deliberately left untouched for that block. */
export function buildPinnedSystemPromptBlocks(pinned: ReadonlyMap<string, PinnedSnippet>): string[] {
	if (pinned.size === 0) return [];
	const preamble =
		"The following are session-scoped presentation preferences the user explicitly turned on via ::pin. " +
		"They govern HOW you phrase, format, and size responses — never WHAT you must verify, complete, or ship. " +
		"Every contract, completeness, and yielding requirement defined earlier in this prompt remains fully in " +
		"force regardless of any preference below.";
	const styles = [...pinned.entries()].map(([name, pin]) => `<pinned-style name="${name}">\n${pin.content}\n</pinned-style>`);
	const blocks = [`<pinned-styles>\n${preamble}\n\n${styles.join("\n\n")}\n</pinned-styles>`];
	const qaNames = qaPinnedNames(pinned);
	if (qaNames.length > 0) blocks.push(buildQaEnforcementBlock(qaNames));
	return blocks;
}

/** Mechanism-level notice for an active Q&A-only guard. It states what the
 *  host is already blocking and that only the user's unpin releases it, so
 *  the model neither reads a prose go-ahead as permission nor claims a
 *  blocked action succeeded. Kept separate from the `<pinned-styles>`
 *  preamble, which describes presentation pins and must stay accurate for
 *  them. */
function buildQaEnforcementBlock(names: readonly string[]): string {
	const unpin = names.map((name) => `::unpin(${name})`).join(" / ");
	return (
		`<qa-enforcement>\nQ&A-only enforcement is active for this session (pinned: ${names.join(", ")}). ` +
		"The host intercepts tool calls and blocks every call that could mutate the workspace or execute code — " +
		"edit/write/bash/eval/python/task and any unknown tool are refused; only read-only investigation tools " +
		"(read, grep, glob, web_search, ask, todo, wait) and read-only LSP queries run. This is mechanism-level host " +
		'interception, not a preference: conversation text (including a user "go ahead" or the model\'s own statements) ' +
		`and tool arguments cannot turn it off, and it stays in force until the user unpins (${unpin}). Until then, ` +
		"investigate and answer only; never attempt a blocked action and never claim or imply that one was performed or is permitted.\n</qa-enforcement>"
	);
}

const PIN_STATUS_KEY = "snippet-pins";

/** Status-bar key for the enforced Q&A-only mode. Separate from the pin list
 *  so the two can never be mistaken for each other. */
export const QA_STATUS_KEY = "snippet-qa";

/** Keeps the persistent pin indicators in the TUI status bar/footer — the
 *  pinned set and, while a `guard: qa` pin is active, the enforced Q&A-only
 *  mode — so neither state disappears once the picker closes and without
 *  re-typing `::pins`. Both are derived from the live map on every call, so
 *  they cannot drift from it. Call after any mutation to the pinned map. */
function updatePinStatus(ctx: ExtensionContext, pinned: ReadonlyMap<string, PinnedSnippet>): void {
	ctx.ui.setStatus(PIN_STATUS_KEY, pinned.size === 0 ? undefined : `📌 ${[...pinned.keys()].sort().join(", ")}`);
	const qaNames = qaPinnedNames(pinned);
	ctx.ui.setStatus(QA_STATUS_KEY, qaNames.length === 0 ? undefined : `🛡 Q&A-only · ${qaNames.join(", ")}`);
}

/** Fires the "X replaces Y (same style group)" heads-up when a pin mutation
 *  auto-unpinned group siblings (see `unpinGroupSiblings`). Shared by both
 *  pin-mutation call sites (the picker's hotkey toggle and the text-trigger
 *  `input` handler) — they used to duplicate this exact notify verbatim,
 *  same class of drift risk as `applyPin` was factored out to avoid. No-op
 *  when nothing was auto-unpinned. */
function notifyGroupReplace(ctx: ExtensionContext, added: string[], autoUnpinned: string[]): void {
	if (autoUnpinned.length === 0) return;
	ctx.ui.notify(`${added.join(", ")} replaces ${autoUnpinned.join(", ")} (same style group)`, "info");
}

// ============================================================================
// Roles — `::role-name` / `::unrole`
//
// A `kind: role` snippet is not a snippet: it is an operational role for the
// main conversation, selected by submitting its bare trigger. Roles exist
// because both neighbouring mechanisms fall short of that job:
//   - `::name` expansion rewrites ONE message. A role is a standing assignment
//     — who the agent is being for this conversation — so it has to outlive the
//     turn it was typed in.
//   - `::pin(name)` is standing, but pinning is a *presentation* mechanism: it
//     layers style preferences (tone, format, length) and is deliberately
//     additive/composable, so there is no "the pinned thing" and no reason to
//     expect mutual exclusion.
// A role is a single slot — one active role, re-selecting refreshes it, never a
// toggle — whose content is operational rather than presentational, and it is
// snapshotted at selection time so a resume replays what was actually active.
//
// Deliberate boundaries:
//   - Bare names only. `::role-name(args)` / `::role-name<<...>>` never
//     activate and are left exactly as typed; roles take no arguments, so there
//     is nothing to bind.
//   - Top-level submitted text only. Role actions are processed at the input
//     seam, never inside recursive expansion, so a `::role-name` written inside
//     a snippet body or inside another trigger's arguments stays inert text.
//     `findRoleActions` recognizes only the spans the expander itself treats as
//     opaque — a trigger's `(...)` argument list, and the `<<...>>` a trigger or
//     `::a::b` chain feeds on — so an unrelated `<<` in prose never hides a
//     trigger after it, and an unterminated `::role-name<<…` never activates.
//   - Main agent only. `ctx.agent.kind` is the documented identity
//     (`omp://extensions.md`): subagent bindings neither restore nor inject a
//     role, so a child session never inherits the parent's role and the parent
//     is never affected by a child. A host too old to expose `ctx.agent`
//     (this package's own pinned dev dependency is) reports nothing: roles are
//     then disabled with a one-time notice rather than inferred from depth,
//     parentSession, or UI heuristics — guessing "main" is the one failure mode
//     that would silently corrupt a child session.
//   - Persistence is a session custom entry (`omp-snippets.role`) replayed from
//     the ACTIVE branch on every lifecycle event, never from global entry
//     history: a rewind or fork must reflect the branch it landed on, and
//     `/new` must start with none. `null` is a tombstone that stops the
//     backward scan, so a cleared role cannot be resurrected by an older record
//     — and neither can an unreadable one, which is reported instead of skipped.
// ============================================================================

/** `kind: role` in frontmatter — the value `SnippetDef.kind` carries. */
const ROLE_KIND = "role";

/** The one supported `guard:` value — see `SnippetDef.guard`. */
const QA_GUARD = "qa";

/** Reserved exact trigger that clears the active role. Exact means exact:
 *  `::unrole-extra` is an ordinary trigger name, not a clear. */
export const UNROLE_TRIGGER = "unrole";

/** Session custom-entry type carrying the role snapshot. Namespaced away from
 *  core-owned custom types (`omp://session.md`) — an extension must not collide
 *  with a value core replays as lifecycle state. */
export const ROLE_CUSTOM_TYPE = "omp-snippets.role";
export const ROLE_ENTRY_VERSION = 1;

/** Status-bar key for the persistent `Role: <name>` indicator. */
export const ROLE_STATUS_KEY = "snippet-role";

/** A selected role: canonical name plus the fully expanded body snapshotted at
 *  selection time. The snapshot is what gets injected, so a resumed session
 *  does not depend on the snippet file still existing or still matching. */
export interface ActiveRole {
	name: string;
	body: string;
}

export function isRoleDef(def: SnippetDef | undefined): def is SnippetDef & { kind: "role" } {
	return def?.kind === ROLE_KIND;
}

/** Ordinary-snippet lookup: roles are not snippets (they are selected, never
 *  expanded into a message — nested references included), and `unrole` is a
 *  reserved trigger belonging to the role feature rather than an author's name.
 *  Expansion, `::pin`, and the picker's pin hotkey all go through here, which is
 *  why a role can never be expanded or pinned even when another body references
 *  it. */
function lookupOrdinarySnippet(registry: Map<string, SnippetDef>, name: string): SnippetDef | undefined {
	const key = name.toLowerCase();
	if (key === UNROLE_TRIGGER) return undefined;
	const def = registry.get(key);
	return isRoleDef(def) ? undefined : def;
}

export type AgentIdentity = "main" | "sub" | "unknown";

interface CtxWithAgent {
	agent?: { kind?: unknown };
}

/** Documented `ctx.agent` (`omp://extensions.md`) is the only sanctioned way to
 *  tell a main session from a subagent. Read through a narrow structural cast
 *  because this package's pinned dev dependency predates the field; `unknown`
 *  means "this host did not say", and roles stay off rather than being guessed
 *  from `depth`, parent ids, or UI heuristics. */
export function resolveAgentIdentity(ctx: ExtensionContext): AgentIdentity {
	const agent = (ctx as unknown as CtxWithAgent).agent;
	const kind = agent?.kind;
	return kind === "main" || kind === "sub" ? kind : "unknown";
}

/** Fully expanded body a role injects. When the definition has its own
 *  `<append>` blocks the snapshot has `::pin`'s two-part shape — the expanded
 *  append content first, then any `<append>` blocks a nested snippet hoisted in
 *  — so a helper can add to a role's body but never replace it. (A definition
 *  with several hoisting append blocks groups its own text ahead of the hoisted
 *  blocks instead of interleaving them per block the way the pin collector
 *  does; same content, and only observable in that shape.) An inline-only
 *  definition keeps `::pin`'s rule verbatim (`<append>` blocks when any were
 *  hoisted, else the inline text). Nested ordinary snippets expand; nested role
 *  references stay literal (see `lookupOrdinarySnippet`), so a body can never
 *  activate a second role. Returns `undefined` when the body cannot be parsed or
 *  is empty after expansion — the caller refuses to select such a role. */
export function extractRoleBody(def: SnippetDef, registry: Map<string, SnippetDef>): string | undefined {
	const { parsed, base } = rawSnippetBody(def.raw);
	if (!parsed || !base.trim()) return undefined;
	const expansion = expandTriggers(base, registry);
	// With `<append>` blocks present, `base` IS that append content, so its
	// expansion lands in `text` — taking only the hoisted blocks here would
	// silently drop the role's own body whenever a nested snippet contributes
	// blocks of its own (`::pin` keeps both for the identical definition).
	const body =
		parsed.append.length > 0
			? [expansion.text, ...expansion.append].filter((part) => part.trim()).join("\n\n").trim()
			: (expansion.append.join("\n\n") || expansion.text).trim();
	return body.length > 0 ? body : undefined;
}

export type RoleAction =
	| { kind: "select"; name: string; def: SnippetDef; start: number; end: number }
	| { kind: "clear"; start: number; end: number };

/** Trigger names the pin feature owns: `::pins` / `::pin(x)` / `::unpin(x)` are
 *  rewritten by the pin pass, which runs after the role pass, so a role must
 *  never be selectable under one of them — otherwise a role named `pins` would
 *  silently take over the "what's pinned" trigger. */
const RESERVED_PIN_TRIGGERS: Record<string, true> = { pin: true, unpin: true, pins: true };

/** True when a role's bare trigger can never reach it because the name belongs
 *  to the pin/role triggers themselves. `unrole` is the clear trigger, so it
 *  always wins; the pin words are rewritten by the pin pass. Names are compared
 *  lowercased, like every other trigger name in this module. Such a role is
 *  never selected and stays out of the picker rather than offering a row that
 *  cannot work. */
function isUnselectableRoleName(name: string): boolean {
	const key = name.toLowerCase();
	return key === UNROLE_TRIGGER || RESERVED_PIN_TRIGGERS[key] === true;
}

/** End index (exclusive) of the argument span opening at `openIndex`, or the end
 *  of the text when it never closes — an unterminated `::name(` swallows the
 *  rest of the message rather than exposing its contents as top-level text. */
function findArgSpanEnd(text: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return i + 1;
	}
	return text.length;
}

/** End index (exclusive) of the `<<...>>` span opening at `bracketStart`, or the
 *  end of the text when it never closes — matching the expander's lazy
 *  `[\s\S]*?>>`, which is just as greedy about an unterminated bracket. */
function findBracketSpanEnd(text: string, bracketStart: number): number {
	const close = text.indexOf(">>", bracketStart);
	return close === -1 ? text.length : close + 2;
}

/** A half-open `[start, end)` range of submitted text. */
interface TextSpan {
	start: number;
	end: number;
}

/** True when `name` resolves to a role this module can actually select.
 *  Reserved trigger names never qualify — the pin/unrole controls own them —
 *  so their argument spans stay ordinary text and those controls keep their
 *  precedence over any user-defined definition using the same name. */
function isOperationalRole(name: string, registry: Map<string, SnippetDef>): boolean {
	const key = name.toLowerCase();
	if (isUnselectableRoleName(key)) return false;
	const def = registry.get(key);
	return isRoleDef(def) && !isUnselectableRoleName(def.name);
}

/** Opaque ranges attached to a real role: the complete `::role(...)` form and
 *  the complete whitespace-separated head run plus `<<...>>` argument when a
 *  real role feeds that bracket. Keeping every sibling in the latter range
 *  prevents a reserved command or ordinary trigger from detaching the literal
 *  argument. Roles accept no arguments, so their unsupported forms are data.
 *
 *  Recognition mirrors `findRoleActions` — the same trigger-name resolution,
 *  argument-span scanners, and chain-run rule. Unclosed spans run to the end of
 *  the text exactly as they do for the role scanner. Reserved names are
 *  excluded via `isOperationalRole`, so pin controls retain precedence. */
function findOpaqueRoleArgSpans(text: string, registry: Map<string, SnippetDef>): TextSpan[] {
	const spans: TextSpan[] = [];
	const inSpan = (index: number): boolean => spans.some((span) => index >= span.start && index < span.end);
	let pending: string[] = [];
	let pendingStart = -1;
	let runEnd = -1;

	for (let start = text.indexOf("::"); start !== -1; start = text.indexOf("::", start + 1)) {
		const head = matchTriggerHead(text, start + 2, registry);
		if (!head) continue;
		const nameEnd = head.end;
		if (inSpan(start)) continue;
		// Only whitespace may separate two heads in one chain run; anything else
		// ends the run, so a later bracket cannot feed an earlier role head.
		if (runEnd !== -1 && text.slice(runEnd, start).trim().length > 0) {
			pending = [];
			pendingStart = -1;
		}
		if (text[nameEnd] === "(") {
			// A role's whole unsupported form stays literal, including its head.
			const end = findArgSpanEnd(text, nameEnd);
			if (isOperationalRole(head.name, registry)) spans.push({ start, end });
			pending = [];
			pendingStart = -1;
			runEnd = end;
			continue;
		}

		let bracketStart = nameEnd;
		while (bracketStart < text.length && /\s/.test(text[bracketStart])) bracketStart++;
		if (text[bracketStart] === "<" && text[bracketStart + 1] === "<") {
			// The bracket feeds every head in the run. If one is a real role,
			// protect all siblings as well as the argument.
			const end = findBracketSpanEnd(text, bracketStart);
			if (isOperationalRole(head.name, registry) || pending.some((name) => isOperationalRole(name, registry))) {
				spans.push({ start: pendingStart === -1 ? start : pendingStart, end });
			}
			pending = [];
			pendingStart = -1;
			runEnd = end;
			continue;
		}

		if (pending.length === 0) pendingStart = start;
		pending.push(head.name);
		runEnd = nameEnd;
	}
	return spans;
}

/** The opaque span containing `index`, if any. */
function opaqueSpanAt(spans: readonly TextSpan[], index: number): TextSpan | undefined {
	for (const span of spans) {
		if (index >= span.start && index < span.end) return span;
	}
	return undefined;
}
/** Recomputes role opacity after a replacement. A range crossing `boundary`
 *  starts in the produced prefix and continues into the unconsumed suffix. */
function findOpaqueSpansCrossingBoundary(
	text: string,
	boundary: number,
	registry: Map<string, SnippetDef>,
): TextSpan[] | undefined {
	const spans = findOpaqueRoleArgSpans(text, registry);
	return spans.some((span) => span.start < boundary && span.end > boundary) ? spans : undefined;
}

/** True when the half-open range `[start, start + length)` overlaps any
 *  opaque span. A pin command whose argument encloses a role wrapper is left
 *  untouched too: its meaning would otherwise depend on text the contract
 *  keeps literal. */
function overlapsOpaqueSpan(spans: readonly TextSpan[], start: number, length: number): boolean {
	const end = start + length;
	return spans.some((span) => start < span.end && end > span.start);
}

/** Top-level role actions in submitted text, left to right.
 *
 *  "Top-level" is the whole point: a role reference nested in a snippet body or
 *  inside another trigger's arguments must not activate anything — but neither
 *  may an unrelated `<<` in ordinary prose (`x << 2`) hide a later trigger. So
 *  this recognizes exactly the spans the expander itself recognizes, instead of
 *  masking every `<<` it happens to see:
 *    - `::name(` … `)` — the parenthesized argument form, which roles do not
 *      support: the head is not a candidate and the span is opaque.
 *    - `::name<<…>>` / `::a::b<<…>>` — the heredoc form. The head that opens it
 *      *and* every head stacked before it in the same whitespace-separated run
 *      receive that bracket as their argument, so none of them is bare; the
 *      bracket is opaque, and an unterminated one swallows the rest of the
 *      message (the same span the expander matches).
 *  Heads inside an opaque span are skipped, which is what keeps a `::role-name`
 *  written inside `<<...>>` from activating. Each returned `start`/`end` spans
 *  exactly `::name` in the original text, so the caller can rewrite in place.
 *
 *  A head is resolved with `matchTriggerHead`, the same matcher the expansion
 *  uses, and its resolved end drives the span tests: a spaced name
 *  (`::question and answer(`) or a `&` name is one head here exactly as it is
 *  there, so the argument span it opens really does mask the `::role-name`
 *  written inside it, and a role registered under a spaced alias is selectable
 *  as its complete registered name rather than being read as its first word. */
export function findRoleActions(text: string, registry: Map<string, SnippetDef>): RoleAction[] {
	const actions: RoleAction[] = [];
	const opaque: Array<{ start: number; end: number }> = [];
	const inOpaque = (index: number): boolean => opaque.some((range) => index >= range.start && index < range.end);

	// Heads of the current `::a::b` run, held back until the run ends: a `<<`
	// immediately after the run turns every one of them into a heredoc-fed
	// trigger rather than a bare role action, so nothing may be committed before
	// the run is known to be over.
	let pending: Array<{ start: number; end: number; name: string }> = [];
	let runEnd = -1;
	const flushPending = (): void => {
		for (const head of pending) {
			// Every sibling trigger is case-insensitive (`::pins`/`::pin()` are
			// matched with /gi, role names come from lowercased filenames), so the
			// reserved checks and the lookup normalize the typed name too — a
			// `::UNROLE` that fell through would otherwise be sent verbatim, and
			// `::Pins` could reach a role the reserved names are meant to protect.
			const name = head.name.toLowerCase();
			if (name === UNROLE_TRIGGER) {
				actions.push({ kind: "clear", start: head.start, end: head.end });
				continue;
			}
			if (isUnselectableRoleName(name)) continue;
			const def = registry.get(name);
			// The typed name being clear of the reserved words is not enough: the
			// registry maps every alias key to the same definition, so a role whose
			// CANONICAL name is reserved (`pins` reachable as `::captain`) would
			// otherwise be selected through the alias and take over the trigger it
			// is meant to be protected from. Check the resolved name too.
			if (isRoleDef(def) && !isUnselectableRoleName(def.name)) {
				actions.push({ kind: "select", name: def.name, def, start: head.start, end: head.end });
			}
		}
		pending = [];
	};

	for (let start = text.indexOf("::"); start !== -1; start = text.indexOf("::", start + 1)) {
		const head = matchTriggerHead(text, start + 2, registry);
		if (!head) continue;
		const nameEnd = head.end;
		if (inOpaque(start)) continue;
		// Only whitespace may separate two heads in one chain run; anything else
		// ends the run, and its heads are then known not to be heredoc-fed.
		if (runEnd !== -1 && text.slice(runEnd, start).trim().length > 0) flushPending();

		if (text[nameEnd] === "(") {
			flushPending();
			const end = findArgSpanEnd(text, nameEnd);
			opaque.push({ start: nameEnd, end });
			runEnd = end;
			continue;
		}

		let bracketStart = nameEnd;
		while (bracketStart < text.length && /\s/.test(text[bracketStart])) bracketStart++;
		if (text[bracketStart] === "<" && text[bracketStart + 1] === "<") {
			pending = [];
			const end = findBracketSpanEnd(text, bracketStart);
			opaque.push({ start: bracketStart, end });
			runEnd = end;
			continue;
		}

		pending.push({ start, end: nameEnd, name: head.name });
		runEnd = nameEnd;
	}

	flushPending();
	return actions;
}

/** Per-binding mutable state. The extension factory runs once per session
 *  binding — including every subagent — so this is session state, not module
 *  state: a child session can never observe the parent's role, pins, or notices. */
interface SnippetSessionState {
	role: ActiveRole | null;
	identityNoticeShown: boolean;
	reportedDiagnostics: Set<string>;
}

const IDENTITY_NOTICE =
	"Roles are unavailable: this host does not report whether the session is the main agent. Snippets and styles still work.";

/** One-time heads-up for a host that does not expose `ctx.agent.kind`. */
function noticeIdentityUnavailable(ctx: ExtensionContext, state: SnippetSessionState): void {
	if (state.identityNoticeShown) return;
	state.identityNoticeShown = true;
	ctx.ui.notify(IDENTITY_NOTICE, "warning");
}

/** Keeps the persistent `Role: <name>` footer indicator in sync; call after any
 *  change to `state.role`. */
function updateRoleStatus(ctx: ExtensionContext, state: SnippetSessionState): void {
	ctx.ui.setStatus(ROLE_STATUS_KEY, state.role ? `Role: ${state.role.name}` : undefined);
}

/** Writes the role snapshot (or the `null` tombstone) and refreshes the footer.
 *  The only writer of `omp-snippets.role` entries — and it is reached only from
 *  a role action, never from an ordinary turn. */
function setActiveRole(ctx: ExtensionContext, state: SnippetSessionState, pi: ExtensionAPI, role: ActiveRole | null): void {
	state.role = role;
	pi.appendEntry(ROLE_CUSTOM_TYPE, { version: ROLE_ENTRY_VERSION, role });
	updateRoleStatus(ctx, state);
}

/** Reports definition problems once per session binding. The registry is
 *  re-read on every turn (hot reload), so this dedupes instead of notifying per
 *  turn; a file fixed and re-broken within one session is not re-announced. */
function surfaceDiagnostics(ctx: ExtensionContext, state: SnippetSessionState, registry: Map<string, SnippetDef>): void {
	const fresh: string[] = [];
	for (const def of new Set(registry.values())) {
		for (const problem of def.diagnostics ?? []) {
			const line = `${def.name}: ${problem}`;
			if (state.reportedDiagnostics.has(line)) continue;
			state.reportedDiagnostics.add(line);
			fresh.push(line);
		}
	}
	if (fresh.length > 0) ctx.ui.notify(`Snippet definition problems:\n${fresh.join("\n")}`, "warning");
}

/** Structural view of a session entry, so tests and callers can pass plain
 *  objects — the only fields a role record needs are its type and payload. */
export interface PersistedRoleEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export type PersistedRoleRead =
	| { status: "absent" }
	| { status: "invalid" }
	| { status: "cleared" }
	| { status: "role"; role: ActiveRole };

/** Persisted payload `setActiveRole` writes, read as an untrusted shape: it
 *  comes back from a session file on disk, so every field is checked before use
 *  instead of being trusted to match the writer. */
interface PersistedRoleData {
	version?: unknown;
	role?: unknown;
}

/** Latest role record on the ACTIVE branch (entries in root->leaf order), or
 *  `absent` when that branch never recorded one. The scan stops at the first
 *  `omp-snippets.role` entry it meets: a `null` tombstone or an unreadable
 *  record must not let an older role resurface, which is why the caller is told
 *  `cleared`/`invalid` rather than being left to keep looking. */
export function readPersistedRole(entries: readonly PersistedRoleEntry[]): PersistedRoleRead {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== ROLE_CUSTOM_TYPE) continue;
		// Unchecked cast to the writer's payload type: the fields are validated
		// right below, which is what makes the cast safe rather than assumed.
		const data = entry.data as PersistedRoleData | null | undefined;
		if (typeof data !== "object" || data === null || data.version !== ROLE_ENTRY_VERSION) {
			return { status: "invalid" };
		}
		const role: unknown = data.role;
		if (role === null) return { status: "cleared" };
		if (typeof role !== "object") return { status: "invalid" };
		const { name, body } = role as { name?: unknown; body?: unknown };
		if (typeof name !== "string" || name.trim().length === 0 || typeof body !== "string" || body.trim().length === 0) {
			return { status: "invalid" };
		}
		return { status: "role", role: { name, body } };
	}
	return { status: "absent" };
}

/** The saved body is authoritative on resume — the file may have changed or
 *  vanished since it was written. When the definition no longer matches what it
 *  would produce now, say so (non-blocking) so a stale snapshot is never
 *  mistaken for the current definition; reselecting the role refreshes it. */
function reportRoleDrift(ctx: ExtensionContext, state: SnippetSessionState, role: ActiveRole): void {
	const registry = buildSnippetRegistry(ctx.cwd);
	surfaceDiagnostics(ctx, state, registry);
	const def = registry.get(role.name);
	const current = isRoleDef(def) ? extractRoleBody(def, registry) : undefined;
	if (current === undefined) {
		ctx.ui.notify(
			`Role "${role.name}" restored from the session snapshot; no matching role definition was found — reselect ::${role.name} to refresh.`,
			"info",
		);
		return;
	}
	if (current !== role.body) {
		ctx.ui.notify(
			`Role "${role.name}" restored from the session snapshot; its definition changed — reselect ::${role.name} to refresh.`,
			"info",
		);
	}
}

/** Restores the role for the branch the session is now on. Called on every
 *  lifecycle event that can change which branch is active (start, switch,
 *  branch, tree), and it always clears the cached role first, so a failed or
 *  empty read can never leave the previous session's role injected. Pins,
 *  pending injects, and picker hooks are deliberately untouched here. */
function restoreRole(ctx: ExtensionContext, state: SnippetSessionState): void {
	state.role = null;
	const identity = resolveAgentIdentity(ctx);
	// A subagent binding never carries a role — that is the design, not a host
	// gap — and it must not touch the main session's footer indicator on its way
	// through, so it stops here silently.
	if (identity === "sub") return;

	const read = readPersistedRole(ctx.sessionManager.getBranch());
	if (identity === "unknown") {
		// Only worth explaining when something was actually saved for this
		// branch: otherwise the user is told once, when they first try a role.
		if (read.status === "role" || read.status === "invalid") noticeIdentityUnavailable(ctx, state);
	} else if (read.status === "invalid") {
		ctx.ui.notify("Ignored an unreadable saved role record in this session.", "warning");
	} else if (read.status === "role") {
		state.role = read.role;
		reportRoleDrift(ctx, state, read.role);
	}
	updateRoleStatus(ctx, state);
}

/** Applies top-level role actions to `state` (left to right — the last valid
 *  action wins) and rewrites each trigger into a short confirmation for the
 *  message history. The role body itself is never copied into the transcript,
 *  only injected as a system-prompt block on later turns. Returns the rewritten
 *  text, or the input unchanged when there is nothing to do. */
function applyRoleActions(
	text: string,
	registry: Map<string, SnippetDef>,
	ctx: ExtensionContext,
	state: SnippetSessionState,
	pi: ExtensionAPI,
): string {
	const actions = findRoleActions(text, registry);
	if (actions.length === 0) return text;
	const identity = resolveAgentIdentity(ctx);
	const rewrites: Array<{ start: number; end: number; text: string }> = [];

	for (const action of actions) {
		if (action.kind === "clear") {
			if (state.role) {
				setActiveRole(ctx, state, pi, null);
				rewrites.push({ start: action.start, end: action.end, text: "(role cleared)" });
			} else {
				rewrites.push({ start: action.start, end: action.end, text: "(no role active)" });
			}
			continue;
		}
		if (identity !== "main") {
			if (identity === "unknown") noticeIdentityUnavailable(ctx, state);
			rewrites.push({ start: action.start, end: action.end, text: "(role unavailable)" });
			continue;
		}
		const body = extractRoleBody(action.def, registry);
		if (body === undefined) {
			ctx.ui.notify(`Role "${action.def.name}" has no content to inject.`, "warning");
			rewrites.push({ start: action.start, end: action.end, text: `(role ${action.def.name} unavailable)` });
			continue;
		}
		setActiveRole(ctx, state, pi, { name: action.def.name, body });
		rewrites.push({ start: action.start, end: action.end, text: `(role: ${action.def.name})` });
	}

	// Right-to-left so earlier spans keep their original offsets.
	let result = text;
	for (const rewrite of rewrites.reverse()) {
		result = result.slice(0, rewrite.start) + rewrite.text + result.slice(rewrite.end);
	}
	return result;
}

const ROLE_PREAMBLE =
	"The role below is an operational assignment the user selected for this conversation. It defines what you " +
	"are responsible for here, where your attention goes, and which boundaries you hold. It is not a subagent " +
	"identity, not a task delegation, and not a permission grant: it never overrides the native instructions, " +
	"safety rules, approval requirements, completion criteria, or an enforced Plan/Execute mode defined earlier " +
	"in this prompt. Where the role and those instructions conflict, those instructions win.";

/** System-prompt block for the active role, appended after the native prompt
 *  (and after the pinned-styles block), so the operational assignment is the
 *  most recent thing the model reads without displacing anything the host
 *  already put there. */
export function buildRoleSystemPromptBlocks(role: ActiveRole): string[] {
	return [`<operational-role name="${role.name}">\n${ROLE_PREAMBLE}\n\n${role.body}\n</operational-role>`];
}

// ============================================================================
// Live `::name` picker — raw terminal input interception
//
// `ctx.ui.addAutocompleteProvider(factory)` IS a real, shipped extension API
// (added in pi-coding-agent 16.3.14) that stacks a wrapper onto the built-in
// editor's autocomplete provider — but it never fires for `::`. The built-in
// editor's own keystroke dispatcher only calls ANY provider (base or
// wrapped) for input matching its own hardcoded trigger shapes: `/`
// (commands), `@` (mentions), URL schemes, and a *single* `:` immediately
// followed by word characters (emoji shortcodes) — confirmed by decompiling
// the shipped binary's editor dispatch gate:
// `/(?:^|[\s([{>]):[a-zA-Z0-9_+-]*$/`. A literal `::` fails that character
// class at the second colon, so it never reaches `getSuggestions` at all —
// verified empirically too: instrumenting a real `addAutocompleteProvider`
// wrapper showed it invoked for `/` and `:r`, never for `::` or `::r`, even
// moments after typing. That gate lives in the editor's own private
// keystroke handler; extensions cannot reach or extend it.
//
// This bypasses that gate entirely via `ctx.ui.onTerminalInput`, which taps
// the raw PTY byte stream and runs BEFORE the built-in editor's own key
// dispatch (confirmed in the binary: input listeners run "before focus
// dispatch"; a handler returning `{ consume: true }` suppresses the normal
// handling of that byte). Approach:
//   1. Ordinary keystrokes pass through untouched (not consumed).
//   2. After each one, on a short debounce, re-read the whole editor buffer
//      via `getEditorText()`. There is no cursor-position accessor on
//      `ExtensionUIContext`, so this only recognizes a trigger anchored at
//      the very end of the buffer — the dominant case (typing `::name` as
//      you go). Mid-buffer edits after moving the cursor elsewhere are not
//      tracked; accepted tradeoff for a picker, not a full completion API.
//   3. When the buffer ends with `::name`, render candidates as a
//      `belowEditor` widget and start consuming Tab/Enter (accept), Up/Down
//      (cycle), and Escape (cancel) — ONLY while a match is active; every
//      other key keeps behaving exactly as before. The widget is a component
//      factory over structured rows, not a row-string array: a plain
//      `string[]` cannot fit a row to the width the surface actually gives
//      it, and loses the role violet on a native (Tern) surface. See
//      `PickerWidget` for how each surface is fitted.
//   4. Accepting splices `::<value> ` (trailing space, so the buffer no
//      longer ends in a bare trigger and the picker closes on its own) into
//      the buffer via `setEditorText` — the literal token the `input`
//      handler above already expands, so nothing else needs to change.
//   5. The debounce hands its callback to a scheduler this module cannot always
//      cancel (`resolveScheduler` falls back to the global timer on hosts
//      without `ctx.setTimeout`), and a session switch or shutdown retires the
//      listener while a recompute may still be queued. The picker therefore
//      carries a `disposed` flag: a late callback (or a late keystroke) is a
//      no-op instead of painting a widget into a context that is no longer live.
// ============================================================================

export interface AutocompleteItem {
	value: string;
	label: string;
	/** One-line description for the row: the definition's `description:`
	 *  frontmatter when it has one, else a preview of the body (block tags
	 *  dropped, whitespace and newlines normalized). Either way it is capped
	 *  at `MAX_DESCRIPTION_CODEPOINTS` code points including a trailing `…`.
	 *  `undefined` when the body has no text and no description was authored.
	 *  The renderers only ever shorten it further, to the cells a row has. */
	description?: string;
	pinnable: boolean;
	/** True when the snippet body still has an unbound `$1`/`$@`/`$ARGUMENTS`
	 *  placeholder — the picker's hotkey-toggle can't supply an arg value, so
	 *  these are excluded from it and stay `::pin(name(args))`-text-only. */
	hasArgs: boolean;
	/** Display category for picker ordering and coloring only — `Role` for a
	 *  real role or a pinnable `category: role`, `Styles` for
	 *  `category: style`, the authored label otherwise, `Snippets` when the
	 *  definition carries no category. Never rendered: rows carry no textual
	 *  badge, so what a row is never depends on a tag. */
	category?: string;
	/** True for `kind: role` definitions only (never pinnable, never
	 *  expandable) — the operational conversation role a bare `::name`
	 *  selects. Deliberately NOT set by `category: role`: that label is
	 *  display-only, so a role-like pin keeps its pin behavior, its pin hint
	 *  and its place outside role selection (see `isRoleTier`). */
	isRole?: boolean;
}

const PICKER_WIDGET_KEY = "snippet-picker";
/** The trigger at the end of the editor buffer, as the picker's query: a
 *  `[\w-]`/`&` token run, optionally followed by more space-separated words —
 *  the same name shape the expansion accepts, so a spaced alias can be typed
 *  and completed as one name (`::question and answ`). A trailing space is NOT
 *  allowed: a space after a complete name ends the query, exactly as it
 *  always has. The capture is optional but always participates, so an empty
 *  query (`::`) is the empty string rather than `undefined`. */
const TRIGGER_AT_END = /::((?:[\w&-]+(?: [\w&-]+)*)?)$/;
const MAX_PICKER_ROWS = 8;
/** Description cap, in code points, ellipsis included. The same for every row
 *  — no category or pin state buys a longer description — and only ever
 *  shortened further by the width a row actually has (see `truncateCells`). */
const MAX_DESCRIPTION_CODEPOINTS = 60;
/** Display cap, in terminal cells, for the `::name` part of a row label.
 *  The label is the one segment neither surface can fit for itself: the
 *  native `ansi` node has no truncation of its own, so a long canonical name
 *  must be bounded before it is described, or the mini-terminal autowraps it
 *  onto a second row. Display only — the item's value, which Tab/Enter
 *  inserts, keeps the full name. */
const MAX_LABEL_CELLS = 28;
/** Cells between the label column and the description: three spaces, the
 *  narrowest gap that still reads as a column rather than a typo. The column
 *  itself is measured per widget (the widest label actually painted, see
 *  `PickerWidget`), so this is the only fixed horizontal constant left. */
const LABEL_GAP_CELLS = 3;
const LABEL_GAP = " ".repeat(LABEL_GAP_CELLS);
/** Description budget the label column yields to on any surface wide enough
 *  to hold a column cell plus this much text: twelve cells fit a word or two,
 *  where four read as a stub (`Coo…`, `Kee…`). On a 40-cell terminal a
 *  28-cell name would otherwise leave every description at the four-cell
 *  floor, so the column truncates instead. */
const PREFERRED_DESCRIPTION_CELLS = 12;
/** Below this many cells a description is dropped instead of rendered as a
 *  two-character stub — an absent description reads better than a noisy one.
 *  Also the last-ditch budget on a surface too narrow for
 *  `PREFERRED_DESCRIPTION_CELLS` and a column cell both. */
const MIN_DESCRIPTION_CELLS = 4;
/** The widget's own one-cell inset, the `Text` padding every row used to
 *  carry. */
const ROW_INSET_CELLS = 1;

/** Fixed ANSI-256 violet (xterm 141) for the purple tier's names — the only
 *  color the picker assigns on its own (a pinnable name outside that tier
 *  takes the theme's `success` token instead). The host theme exposes no
 *  purple token and this deliberately does not add one: purple identifies the
 *  role-like rows (see `isRoleTier`), never a pin state and never a
 *  description, so it is one constant applied to the name alone: a pin mark
 *  behind it is reset back to the terminal's foreground, never painted violet.
 *  It survives native (Tern) rendering only because that label travels as raw
 *  ANSI — see `PickerWidget`. */
const ROLE_VIOLET = "\x1b[38;5;141m";
const ANSI_FG_RESET = "\x1b[39m";

/** Grapheme iterator shared by both text cutters (`truncateCells` and
 *  `capDescription`): a cut must never separate a base character from its
 *  combining marks or break a ZWJ emoji apart, and `Intl.Segmenter` is the
 *  runtime's own grapheme table — no dependency, one instance for the module. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts `text` to at most `max` terminal cells, ending in `…` when anything
 *  was dropped. Widths come from `Bun.stringWidth`, which ignores ANSI
 *  escapes, counts CJK as 2 and emoji by their rendered width — the same
 *  table a terminal uses, so the fit holds on screen. The cut walks whole
 *  graphemes and measures each candidate prefix whole, so what is kept is
 *  always exactly as wide as it measured: no combining mark or ZWJ sequence
 *  is split, and no undercount can let a row overflow. Plain text only: SGR
 *  sequences measure 0 but would still be consumed as characters, so
 *  truncate first and style after. */
function truncateCells(text: string, max: number): string {
	if (max <= 0) return "";
	if (Bun.stringWidth(text) <= max) return text;
	let kept = "";
	for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
		const candidate = kept + segment;
		if (Bun.stringWidth(candidate) > max - 1) break;
		kept = candidate;
	}
	// A cut landing right after an existing ellipsis (the build-time
	// description cap) must not render as "……".
	while (kept.endsWith("…")) kept = kept.slice(0, -1);
	return `${kept}…`;
}

/** Category labels the display and ordering code compares against — the
 *  authored `category: style`/`styles` normalize to `STYLE_CATEGORY` and the
 *  singular `category: role` to `ROLE_CATEGORY`; `Snippets` is a derived
 *  bucket. Display metadata only; the picker renders no badge from these, and
 *  only a PINNABLE `Role` row takes the violet (see `isRoleTier`). */
const ROLE_CATEGORY = "Role";
const STYLE_CATEGORY = "Styles";
const SNIPPETS_CATEGORY = "Snippets";

/** True once the cursor sits inside a trigger's argument span that hasn't
 *  been closed yet - an open `::name(` with no `)` after it, or an open
 *  `::name<<`/chain with no `>>` after it. The picker's own trigger match
 *  (`TRIGGER_AT_END`) is blind to this: it fires on any `::name` sitting at
 *  the end of the buffer — a spaced name included — even one typed as a
 *  NESTED reference inside someone else's still-open argument. Left unchecked,
 *  that pops the
 *  autocomplete dropdown mid-prose and its Tab/Enter/arrow handling then
 *  hijacks the very keys the user needs to keep typing or close the span -
 *  exactly backwards for `<<...>>`, whose whole point is "type freely, no
 *  interference." Suppressing the picker here does not touch expansion:
 *  a nested `::name` typed and left inside a closed span still expands
 *  normally once the message is submitted (recursed through the same
 *  `expandText` call that renders the enclosing argument).
 *
 *  Heads are matched with the same name shape the expansion accepts — the
 *  `[\w-]`/`&` token run, optionally followed by more space-separated words
 *  (`question and answer`) — so an argument span opened by any legal name is
 *  recognized. Over-matching here only ever suppresses the picker, which is
 *  the conservative direction for a keystroke interception. */
export function isInsideUnclosedTriggerArgs(text: string): boolean {
	const chainOpen = /(?:::[\w&-]+(?: [\w&-]+)*\s*)+<</g;
	let lastEnd = -1;
	let match: RegExpExecArray | null;
	while ((match = chainOpen.exec(text))) lastEnd = match.index + match[0].length;
	if (lastEnd !== -1 && !text.slice(lastEnd).includes(">>")) return true;

	const parenOpen = /::[\w&-]+(?: [\w&-]+)*\(/g;
	lastEnd = -1;
	while ((match = parenOpen.exec(text))) lastEnd = match.index + match[0].length;
	if (lastEnd !== -1 && !text.slice(lastEnd).includes(")")) return true;

	return false;
}

/** Ranks one candidate name against a typed query: exact > prefix > substring > no match (-1). */
function scoreNameMatch(query: string, candidate: string): number {
	if (candidate === query) return 3;
	if (candidate.startsWith(query)) return 2;
	if (candidate.includes(query)) return 1;
	return -1;
}

/** Best relevance of a definition for `query`, counting its aliases — a user
 *  who types an alias (`::safe` for `careful`) should find the row it resolves
 *  to. Aliases come from the live registry rather than the definition, because
 *  a later tier can claim an alias key for its own snippet. */
function scoreSnippetMatch(query: string, def: SnippetDef, aliases: readonly string[] | undefined): number {
	if (!query) return 0;
	let best = scoreNameMatch(query, def.name.toLowerCase());
	for (const alias of aliases ?? []) best = Math.max(best, scoreNameMatch(query, alias));
	return best;
}

/** Registry keys pointing at each definition, so a definition can be scored by
 *  its aliases without walking the registry per candidate. */
function collectAliases(registry: Map<string, SnippetDef>): Map<SnippetDef, string[]> {
	const byDef = new Map<SnippetDef, string[]>();
	for (const [key, def] of registry) {
		if (key === def.name) continue;
		const list = byDef.get(def);
		if (list) list.push(key);
		else byDef.set(def, [key]);
	}
	return byDef;
}

/** True when `query` is a case-insensitive prefix of some registered key.
 *  The picker's gate for a multi-word query: only a name being typed can be a
 *  prefix of a name, so prose that merely contains a registered phrase as a
 *  substring never counts (see `buildSnippetAutocompleteItems`). */
function isRegisteredNamePrefix(registry: Map<string, SnippetDef>, query: string): boolean {
	const prefix = query.toLowerCase();
	for (const key of registry.keys()) {
		if (key.startsWith(prefix)) return true;
	}
	return false;
}

/** The category bucket a definition displays and sorts under: a real role is
 *  always `Role` (authoritative, so an authored `category` can never disguise
 *  one), a singular authored `role` normalizes to that same `Role` bucket —
 *  the one authored label that carries display meaning, see `isRoleTier` —
 *  `style`/`styles` normalizes to the shared `Styles` bucket, any other
 *  authored label is kept verbatim (`roles`, plural, among them), and nothing
 *  becomes `Snippets`. Display metadata only: it never reaches expansion,
 *  pinning, or role selection, and the picker renders no badge from it. */
function displayCategory(def: SnippetDef): string {
	if (isRoleDef(def)) return ROLE_CATEGORY;
	const label = def.category?.trim();
	if (!label) return SNIPPETS_CATEGORY;
	const lower = label.toLowerCase();
	if (lower === "role") return ROLE_CATEGORY;
	return lower === "style" || lower === "styles" ? STYLE_CATEGORY : label;
}

/** The picker's purple tier: the rows whose name renders in the role violet.
 *  A real `kind: role` definition always, plus a PINNABLE snippet whose display
 *  category is `Role` — `category: role` is display-only, so it colors and
 *  groups a row like a role without ever making it one: that row stays an
 *  ordinary pinnable snippet for selection, expansion, and the Q&A guard (see
 *  `AutocompleteItem.isRole`). A NON-pinnable snippet keeps its ordinary color
 *  and group even when authored `category: role`: the violet marks the rows the
 *  pin machinery treats specially, so it never claims one that cannot be
 *  pinned. Takes a built item, whose `category` is already the canonical
 *  `displayCategory`. */
function isRoleTier(item: Pick<AutocompleteItem, "isRole" | "pinnable" | "category">): boolean {
	return item.isRole === true || (item.pinnable === true && item.category === ROLE_CATEGORY);
}

/** Intra-group category order: the purple tier first, then styles, then every
 *  other named category (ordered alphabetically by the comparator),
 *  uncategorized snippets last. Only ever compares rows of the same group —
 *  the group key (`pickerGroup`) runs ahead of it. */
function categoryRank(item: Pick<AutocompleteItem, "isRole" | "pinnable" | "category">): number {
	if (isRoleTier(item)) return 0;
	if (item.category === STYLE_CATEGORY) return 1;
	return item.category === SNIPPETS_CATEGORY ? 3 : 2;
}

/** Ordering group — the first sort key, ahead of match relevance: the purple
 *  tier (real roles and role-like pins together), then every other pinnable
 *  row (output styles and behavioral pins alike), then ordinary one-shot
 *  snippets. A query reorders rows inside a group but never across one, so no
 *  match quality lifts an ordinary snippet above a style, or a style above a
 *  role-like pin. */
function pickerGroup(item: Pick<AutocompleteItem, "isRole" | "pinnable" | "category">): number {
	if (isRoleTier(item)) return 0;
	return item.pinnable ? 1 : 2;
}

/** One line of body text for the picker preview: block tags become spaces,
 *  every whitespace run (newlines included) collapses to one space, and the
 *  edges are trimmed. `undefined` when nothing is left. */
function snippetBodyText(raw: string): string | undefined {
	const text = raw.replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " ");
	return text || undefined;
}

/** Caps one already-normalized line at `MAX_DESCRIPTION_CODEPOINTS` code
 *  points including the trailing `…`, returning it unchanged when it fits.
 *  The cut backs off whole graphemes — a base character is never separated
 *  from its combining marks — and prefers the last word boundary inside the
 *  cap, so a preview ends on a whole word rather than mid-token; text with no
 *  space to cut at (CJK, one long token) falls back to the grapheme cut. */
function capDescription(text: string | undefined): string | undefined {
	if (!text) return undefined;
	if ([...text].length <= MAX_DESCRIPTION_CODEPOINTS) return text;
	let kept = "";
	let points = 0;
	let lastWordEnd = -1;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
		const segmentPoints = [...segment].length;
		// One code point is reserved for the ellipsis; a grapheme that would
		// not fit whole is left out rather than split.
		if (points + segmentPoints > MAX_DESCRIPTION_CODEPOINTS - 1) break;
		kept += segment;
		points += segmentPoints;
		if (/\s/.test(segment)) lastWordEnd = kept.length;
	}
	// A word boundary anywhere in the kept prefix wins over a cut inside the
	// following token; `trimEnd` drops the space the boundary itself kept.
	if (lastWordEnd > 0) kept = kept.slice(0, lastWordEnd).trimEnd();
	return `${kept}…`;
}

/** The picker's one-line description for a definition: the authored
 *  `description:` frontmatter when present, else a preview of the body. Both
 *  paths normalize whitespace and run through the same cap, so every row's
 *  description is one line of at most `MAX_DESCRIPTION_CODEPOINTS` code
 *  points and the renderers only ever shorten it further, to the cells a row
 *  actually has. */
function snippetDescription(def: SnippetDef): string | undefined {
	const authored = def.description?.replace(/\s+/g, " ").trim();
	return capDescription(authored || snippetBodyText(def.raw));
}

/** Current picker state a row can be "active" in: pinned styles (and any other
 *  pinned snippet) and the one active role. Passed in rather than read from the
 *  session, so ordering stays a pure function of its inputs. */
export interface PickerActiveState {
	pinned?: ReadonlySet<string>;
	role?: string;
}

const PLACEHOLDER_PATTERN = /\$(\d+|@|ARGUMENTS)/;

/** Builds the picker's rows for a query, already ordered.
 *
 *  Three groups, group first: the purple tier — real roles and pinnable rows
 *  authored `category: role` — then every other pinnable row (output styles
 *  and behavioral pins alike), then ordinary one-shot snippets. Inside
 *  a group the remaining order is unchanged: unqueried (empty query) order is
 *  category-first — the purple tier, styles, other named categories
 *  alphabetically, then uncategorized snippets — with the active row (pinned,
 *  or the active role) first within its category, then alphabetical. A typed
 *  query stays relevance-first — exact > prefix > substring, aliases included —
 *  but the group boundary outranks relevance; category, then active state, then
 *  alphabetical only break equal relevance inside the same group.
 *  A query that contains a space is the picker's multi-word case — a spaced
 *  name being typed across spaces — and is answered only while it is a prefix
 *  of some registered key, so ordinary prose after a single-word trigger
 *  (`::careful and then`) yields no rows and the dropdown closes instead of
 *  holding on to a coincidental substring match.
 *  Ordering runs only when the picker recomputes from a keystroke; a Right-arrow
 *  toggle re-renders without re-sorting, so the highlighted row never jumps out
 *  from under the cursor. */
export function buildSnippetAutocompleteItems(cwd: string, query: string, active: PickerActiveState = {}): AutocompleteItem[] {
	const registry = buildSnippetRegistry(cwd);
	if (query.includes(" ") && !isRegisteredNamePrefix(registry, query)) return [];
	const aliases = collectAliases(registry);
	const seen = new Set<SnippetDef>();
	const scored: Array<{ item: AutocompleteItem; score: number; rank: number; group: number }> = [];

	for (const def of registry.values()) {
		if (seen.has(def)) continue;
		seen.add(def);
		// A role that can never be selected — reserved trigger name, or a body
		// that cannot expand — stays out of the picker instead of offering a row
		// that always refuses.
		if (isRoleDef(def) && (isUnselectableRoleName(def.name) || extractRoleBody(def, registry) === undefined)) continue;
		const score = scoreSnippetMatch(query, def, aliases.get(def));
		if (score < 0) continue;
		const item: AutocompleteItem = {
			value: def.name,
			label: `::${def.name}`,
			description: snippetDescription(def),
			pinnable: def.pinnable,
			hasArgs: isRoleDef(def) ? false : PLACEHOLDER_PATTERN.test(def.raw),
			category: displayCategory(def),
			isRole: isRoleDef(def) ? true : undefined,
		};
		scored.push({ item, score, rank: categoryRank(item), group: pickerGroup(item) });
	}

	const isActive = (entry: { item: AutocompleteItem }): boolean =>
		entry.item.isRole === true ? entry.item.value === active.role : (active.pinned?.has(entry.item.value) ?? false);

	return scored
		.sort((a, b) => {
			// Group first — the purple tier, then other pinnables, then
			// ordinary snippets — and only then the keys that order *inside* a
			// group: relevance, category, active state, name. A query can
			// reorder a group but never cross one.
			if (a.group !== b.group) return a.group - b.group;
			if (a.score !== b.score) return b.score - a.score;
			if (a.rank !== b.rank) return a.rank - b.rank;
			const category = (a.item.category ?? "").localeCompare(b.item.category ?? "");
			if (category !== 0) return category;
			const byActive = Number(isActive(b)) - Number(isActive(a));
			if (byActive !== 0) return byActive;
			return a.item.value.localeCompare(b.item.value);
		})
		.map((entry) => entry.item);
}

interface PickerState {
	/** Exact trailing text this selection replaces, e.g. "::ref". */
	matchedSuffix: string;
	items: AutocompleteItem[];
	selectedIndex: number;
	/** Index of the first item currently rendered (scroll offset). */
	windowStart: number;
}

/** Slides `windowStart` so `selectedIndex` stays within the visible page. */
export function scrollPickerIntoView(state: PickerState): void {
	const maxStart = Math.max(0, state.items.length - MAX_PICKER_ROWS);
	if (state.selectedIndex < state.windowStart) {
		state.windowStart = state.selectedIndex;
	} else if (state.selectedIndex >= state.windowStart + MAX_PICKER_ROWS) {
		state.windowStart = state.selectedIndex - MAX_PICKER_ROWS + 1;
	}
	state.windowStart = Math.max(0, Math.min(state.windowStart, maxStart));
}

/** Pure gate for the Right-arrow pin-toggle: pinnable items only, and only
 *  when there's no unbound arg placeholder to bind from a keypress alone —
 *  those stay `::pin(name(args))` text-only. Shared by `pickerHint` and
 *  `togglePinOnHighlighted`'s actual gate — a test seam, exported for direct
 *  unit testing without a real terminal input stream. */
export function canToggleFromPicker(item: Pick<AutocompleteItem, "pinnable" | "hasArgs"> | undefined): boolean {
	return !!item?.pinnable && !item.hasArgs;
}

/** Footer hint for the highlighted row. Rows are only ever *inserted* as text by
 *  Tab/Enter, so for a role the hint has to say what the row means once the
 *  message is sent — otherwise a bare `::role-name` sitting in the editor reads
 *  like any other one-shot trigger. Pinnable rows keep their key hint, since
 *  Right-arrow acts on them without touching the buffer — a role-like pin
 *  (`category: role`) among them: it is still a pin, and only `isRole` — a real
 *  `kind: role` definition — can ask for a role's wording here. */
function pickerHint(item: AutocompleteItem | undefined, activeRole: string | undefined): string | undefined {
	if (canToggleFromPicker(item)) return "right arrow to toggle pin";
	if (item?.isRole !== true) return undefined;
	return item.value === activeRole ? "active conversation role · send to refresh" : "conversation role · send to select";
}

/** `DescribeContext.supports` (`native/node.ts`): does this terminal render
 *  `kind` natively? */
interface NativeSupports {
	supports(kind: "ansi"): boolean;
}

/** The subset of the TSP vocabulary the picker describes, declared locally —
 *  the native surface postdates this package's pinned dev dependency.
 *  Upstream shapes: `native/node.ts` and `pi-wire/src/tsp.ts`; element docs:
 *  https://docs.stencil.so/tern/elements/layout.md and
 *  https://docs.stencil.so/tern/elements/text.md. */
/** One styled run of a native `text` node (TSP `TspSpan`). The picker uses
 *  two of that vocabulary's semantic tokens — `accent` for the selection
 *  caret and `success` for a pinnable row's name outside the purple tier — so
 *  the terminal colors both from its own theme and nothing but the role violet
 *  ever needs raw ANSI. */
interface NativeSpan {
	readonly t: string;
	readonly s?: "accent" | "success";
}

/** The one raw-`ansi` segment the picker still describes: a purple-tier label,
 *  whose fixed xterm-256 violet has no theme token behind it (see
 *  `ROLE_VIOLET`). The violet covers the name alone — a pinnable role-like pin
 *  carries its `☐`/`📌` mark *after* an explicit foreground reset, exactly
 *  where the terminal path resets — and a real role, never pinnable, has no
 *  mark to place. Measured in Tern 0.9.1: an `ansi` node has NO intrinsic
 *  width and `basis: "content"` resolves to zero — the mini-terminal lays out
 *  at 0 cells (hidden, `sf-ansi` never sized) and the row collapses to the
 *  description's height. An explicit extent gives it a real cell width, and
 *  that extent is the SHARED label column plus the gap, reserved as empty
 *  cells while the text ends at the label: every row's description then
 *  starts at the same cell, and a trailing blank on the node's last cells
 *  (which is what wrapped `☐`/`…` rows onto a second line) never exists —
 *  the reserved cells double as slack for the wider-than-one-cell advance
 *  such fallback glyphs render with. `max.h` is deliberately NOT used: on an
 *  `ansi` node it adds scrolling rather than a nowrap clamp. */
interface NativeAnsiNode {
	readonly k: "ansi";
	readonly p: {
		readonly text: string;
		readonly min: { readonly w: `${number}ch` };
		readonly max: { readonly w: `${number}ch` };
		readonly shrink: 0;
	};
}

interface NativeTextNode {
	readonly k: "text";
	readonly p: {
		/** Plain text (muted footers, descriptions) or styled `spans` (a label:
		 *  the caret, the name's category token, and the pin mark) — `spans`
		 *  wins when both are present, as upstream. */
		readonly text?: string;
		readonly spans?: readonly NativeSpan[];
		readonly tone?: "muted";
		/** One line, cut at the end with `…` — the terminal's own layout
		 *  decides where, so the actual block width is what fits. */
		readonly wrap: "none";
		readonly truncate: "end";
		readonly lines: 1;
		/** Pinned box for a label segment: both bounds in `"<n>ch"`, no
		 *  shrink, the same shared label column + gap on every row. The
		 *  padding and gap are reserved as empty cells and absorb the
		 *  wider-than-one-cell advance of fallback glyphs (`☐`, `…`), which
		 *  keeps the segment on one line and the descriptions aligned. */
		readonly min?: { readonly w: `${number}ch` };
		readonly max?: { readonly w: `${number}ch` };
		readonly shrink?: 0;
	};
}

interface NativeRowNode {
	readonly k: "row";
	/** `wrap: false` keeps the children on one line: the description shrinks
	 *  and truncates instead of flowing onto a second row. */
	readonly p: { readonly gap: "none"; readonly wrap: false };
	readonly c: readonly (NativeAnsiNode | NativeTextNode)[];
}

interface NativeColNode {
	readonly k: "col";
	readonly p: { readonly gap: "none" };
	readonly c: readonly (NativeRowNode | NativeTextNode)[];
}

type NativeNode = NativeAnsiNode | NativeTextNode | NativeRowNode | NativeColNode;

/** The theme handle the widget factory receives (the same shape as
 *  `ctx.ui.theme`); the picker reads only `fg`, for the selection caret, a
 *  pinnable name outside the purple tier, and the muted footer lines. */
interface PickerTheme {
	fg(name: string, text: string): string;
}

/** One picker row, kept structured rather than pre-rendered: the terminal
 *  path needs the plain label/description split to cut in cells, and the
 *  native path needs the same split to hand the label to an `ansi` node and
 *  the description to a native `text` node. Both paths render exactly one
 *  visual row per entry. */
type PickerRow =
	| {
			readonly kind: "item";
			readonly selected: boolean;
			/** True for a purple-tier row — a real role, or a pinnable row
			 *  authored `category: role` (see `isRoleTier`). Its name is the
			 *  one thing the picker colors on its own (`ROLE_VIOLET`), and the
			 *  color stops before the pin mark. */
			readonly purple: boolean;
			/** True for a pinnable row outside the purple tier — its name
			 *  takes the theme's `success` green, pinned or not; the mark says
			 *  which. */
			readonly pinnable: boolean;
			/** `::name` alone, already bounded to `MAX_LABEL_CELLS`. Kept
			 *  apart from `mark` because the two are styled separately: the
			 *  name carries its category's color, the mark none. */
			readonly name: string;
			/** The trailing `☐`/`📌` pin mark, empty for a non-pinnable row.
			 *  Never colored — it always sits outside the name's color span. */
			readonly mark: string;
			readonly description?: string;
	  }
	| { readonly kind: "footer"; readonly text: string };

/** The picker's `belowEditor` widget: structured rows in, one fitted line
 *  (or one native row) per entry out.
 *
 *  Terminal path (`render(width)`): every row is composed and cut in cells
 *  here, so a long label, a CJK description or an unbroken word can never
 *  make the host's own text layout wrap one entry into two — which is why
 *  this is not a stack of `Text` children any more. The label column is
 *  measured from the rows this widget actually paints (the widest bounded
 *  label plus pin mark) and every row is padded to it, so descriptions line
 *  up; on a surface that cannot hold that column plus a meaningful
 *  description the column shrinks (down to `PREFERRED_DESCRIPTION_CELLS`,
 *  then to the four-cell floor), truncating names — pin marks stay whole —
 *  instead of reducing every description to a stub.
 *
 *  Native path (`describe`): a `col` of `row`s, each a label segment plus a
 *  native `text` description. The label is bounded before it ever reaches the
 *  terminal (`MAX_LABEL_CELLS`) and then pinned to the SHARED label column's
 *  cell width plus the gap (`min.w`/`max.w` in `"<n>ch"`, no shrink) — the
 *  same extent on every item row, reserved as empty cells after the label
 *  text, which is what makes the descriptions start at one column natively
 *  too. `describe` never sees a width, so the native extent cannot make the
 *  same trade the terminal path does; Tern shrinks the description to
 *  whatever the block gets instead. The extent includes the gap rather than
 *  appending it as literal spaces: a trailing blank on the node's last cells
 *  is what wrapped `☐`/`…` rows onto a second line (measured: 32px vs 16px
 *  rows), and the reserved cells double as slack for the wider-than-one-cell
 *  advance those fallback glyphs render with. Only a purple-tier label is raw
 *  `ansi` — its fixed xterm-256 violet has no theme token behind it, and the
 *  host's span reverse-mapping (`native/spans.ts`) drops exactly such colors
 *  — and even there the explicit extent is required: Tern measures no
 *  intrinsic width for an `ansi` node (verified in 0.9.1 — with no extent the
 *  mini-terminal lays out at zero, `sf-ansi` is never sized, and the row
 *  collapses). Every other label is a native `text` node with `wrap: "none"` /
 *  `truncate: "end"` / `lines: 1`, its name carrying its category's color as
 *  a theme token (`success` for a pinnable row outside the purple tier,
 *  nothing for an ordinary one), its pin mark a span of its own with no token
 *  at all, and its selected caret an `accent` span — so no glyph advance can
 *  ever wrap it. The description uses the same one-line text shape with no
 *  pinned box, so Tern's own layout shrinks and cuts it to whatever width the
 *  block gets, and the `row` never wraps its children.
 *
 *  Rows are immutable once built, so both renderings are memoized and return
 *  the same reference while nothing changed (the `Component` reference
 *  contract). */
class PickerWidget {
	readonly #rows: readonly PickerRow[];
	readonly #theme: PickerTheme;
	/** The shared label column, in cells: the widest bounded label (name +
	 *  pin mark) among the item rows this widget paints. Measured from the
	 *  rows actually shown, so a page of short names never reserves the
	 *  28-cell bound a long name elsewhere would need. */
	readonly #labelColumnCells: number;
	#renderedWidth = -1;
	#renderedRows: readonly string[] | undefined;
	#native: NativeNode | undefined;

	constructor(rows: readonly PickerRow[], theme: PickerTheme) {
		this.#rows = [...rows];
		this.#theme = theme;
		let column = 0;
		for (const row of rows) if (row.kind === "item") column = Math.max(column, Bun.stringWidth(row.name + row.mark));
		this.#labelColumnCells = column;
	}

	/** One entry per visual row, each at most `width` cells wide (SGR
	 *  sequences measure 0, so the styled result stays within budget). */
	render(width: number): readonly string[] {
		if (this.#renderedRows && this.#renderedWidth === width) return this.#renderedRows;
		this.#renderedRows = this.#rows.map((row) => this.#renderRow(row, width));
		this.#renderedWidth = width;
		return this.#renderedRows;
	}

	#renderRow(row: PickerRow, width: number): string {
		const budget = width - ROW_INSET_CELLS;
		if (budget <= 0) return "";
		if (row.kind === "footer") return ` ${this.#theme.fg("muted", truncateCells(row.text, budget))}`;
		const caret = row.selected ? "▸ " : "  ";
		const caretCells = Bun.stringWidth(caret);
		const label = row.name + row.mark;
		// The shared column, shrunk when the surface cannot hold it plus a
		// meaningful description: the column gives up width before the
		// description drops below `PREFERRED_DESCRIPTION_CELLS`, and on a
		// surface too narrow for that it falls back to the four-cell floor.
		// Below one column cell there is nothing left to align, so the row
		// degrades to "caret label" with no gap, no description, no color.
		const roomy = budget - caretCells - LABEL_GAP_CELLS - PREFERRED_DESCRIPTION_CELLS;
		const column = Math.min(
			this.#labelColumnCells,
			roomy >= 1 ? roomy : budget - caretCells - LABEL_GAP_CELLS - MIN_DESCRIPTION_CELLS,
		);
		if (column < 1) return ` ${truncateCells(`${caret}${label}`, budget)}`;
		// Cut the name to the column and keep the pin mark whole behind it: a
		// row you can pin must still show whether it is pinned. Display only —
		// the item's value, which Tab/Enter inserts, keeps the full name. Only
		// when the column cannot hold the mark at all does the cut take the
		// combined label.
		const markCells = Bun.stringWidth(row.mark);
		const keepMark = markCells > 0 && column > markCells;
		const fittedName = truncateCells(row.name, keepMark ? column - markCells : column);
		const fitted = keepMark ? `${fittedName}${row.mark}` : truncateCells(label, column);
		const pad = " ".repeat(column - Bun.stringWidth(fitted));
		const remaining = budget - caretCells - column - LABEL_GAP_CELLS;
		const description = remaining >= MIN_DESCRIPTION_CELLS ? truncateCells(row.description ?? "", remaining) : "";
		// The color stops at the mark, so the cut has to be split back apart:
		// with the mark kept whole it is exactly the suffix behind the name,
		// otherwise the cut may have reached inside either. A purple-tier row
		// can be pinnable (`category: role`), so its violet must end where the
		// green already does — at the name, before the mark.
		const name = keepMark ? fittedName : fitted.startsWith(row.name) ? row.name : fitted;
		const mark = fitted.slice(name.length);
		const styledLabel = row.purple
			? `${ROLE_VIOLET}${name}${ANSI_FG_RESET}${mark}`
			: row.pinnable
				? `${this.#theme.fg("success", name)}${mark}`
				: fitted;
		const marker = row.selected ? this.#theme.fg("accent", caret) : caret;
		// A row with no description ends at its label: nothing follows the
		// column, so its padding must not be painted as trailing blanks.
		return description ? ` ${marker}${styledLabel}${pad}${LABEL_GAP}${description}` : ` ${marker}${styledLabel}`;
	}

	/** The Tern description, or `null` when the terminal has no `ansi` node —
	 *  the backend then falls back to `render()` rows. Row count needs no
	 *  clamp: `renderPicker` emits at most `MAX_PICKER_ROWS` item rows plus
	 *  its two footer lines. */
	describe(cx: NativeSupports): NativeNode | null {
		if (!cx.supports("ansi")) return null;
		return (this.#native ??= {
			k: "col",
			p: { gap: "none" },
			c: this.#rows.map((row) => this.#describeRow(row)),
		});
	}

	#describeRow(row: PickerRow): NativeRowNode | NativeTextNode {
		if (row.kind === "footer") {
			return { k: "text", p: { text: ` ${row.text}`, tone: "muted", wrap: "none", truncate: "end", lines: 1 } };
		}
		const caret = row.selected ? "▸ " : "  ";
		const label = row.name + row.mark;
		// The extent is measured on the plain segment (SGR measures 0 anyway)
		// and is the SAME on every item row: the shared label column plus the
		// gap, which the label text itself never carries. The gap and the
		// column's padding are reserved as empty cells after the text, so
		// every description starts at one column — and those cells double as
		// slack for the wider-than-one-cell advance fallback glyphs (`☐`, `…`)
		// render with. Both label renderings are pinned to it.
		const extent: `${number}ch` = `${ROW_INSET_CELLS + Bun.stringWidth(caret) + this.#labelColumnCells + LABEL_GAP_CELLS}ch`;
		const box = { min: { w: extent }, max: { w: extent }, shrink: 0 } as const;
		const children: Array<NativeAnsiNode | NativeTextNode> = [];
		if (row.purple) {
			// The role violet is the one color with no theme token behind it, so
			// a purple-tier label is the one raw-`ansi` segment — see
			// `NativeAnsiNode` for why it must still be given the explicit
			// extent. The reset splits name from mark here exactly as it does on
			// the terminal path: a pinnable `category: role` row carries its
			// `☐`/`📌` after it, never inside the violet.
			const styledCaret = row.selected ? this.#theme.fg("accent", caret) : caret;
			children.push({
				k: "ansi",
				p: { text: ` ${styledCaret}${ROLE_VIOLET}${row.name}${ANSI_FG_RESET}${row.mark}`, ...box },
			});
		} else {
			// Every other label is a native `text` node instead of a
			// mini-terminal: `wrap: "none"` can never put it on a second line,
			// whatever width a glyph really renders with. A pinnable row's name
			// takes the theme's `success` token while its pin mark stays a span
			// with no token — the terminal ends the green exactly at the span
			// boundary, the same place the terminal path resets — and an
			// ordinary row's label carries no token at all. The selected caret
			// is an `accent` span. The spans carry the same leading one-cell
			// inset the extent and the raw-`ansi` role segment do, so every
			// row's label starts at the same column.
			const labelSpans: readonly NativeSpan[] = row.pinnable
				? [{ t: row.name, s: "success" }, { t: row.mark }]
				: [{ t: label }];
			const spans: readonly NativeSpan[] = row.selected
				? [{ t: ` ${caret}`, s: "accent" }, ...labelSpans]
				: [{ t: ` ${caret}` }, ...labelSpans];
			children.push({ k: "text", p: { spans, wrap: "none", truncate: "end", lines: 1, ...box } });
		}
		if (row.description) children.push({ k: "text", p: { text: row.description, wrap: "none", truncate: "end", lines: 1 } });
		return { k: "row", p: { gap: "none", wrap: false }, c: children };
	}
}

function renderPicker(ctx: ExtensionContext, state: PickerState, pinned: ReadonlyMap<string, PinnedSnippet>, activeRole: string | undefined): void {
	const rows: PickerRow[] = state.items
		.slice(state.windowStart, state.windowStart + MAX_PICKER_ROWS)
		.map((item, i): PickerRow => {
			const isPinned = item.pinnable && pinned.has(item.value);
			// ☐/📌 for pinnable items only: the empty checkbox marks a row you can
			// pin right now, the glyph marks one that already is. Non-pinnable rows
			// leave that column blank. The mark travels as its own field, apart
			// from the name, so neither the color nor the width cut of the name
			// can ever reach it.
			const pinMark = item.pinnable ? (isPinned ? " 📌" : " ☐") : "";
			// A filename is not obliged to be well-behaved, so the label is
			// whitespace-normalized before it is cut: an embedded newline or tab
			// must never put a second physical line into a rendered row.
			const name = truncateCells(item.label.replace(/\s+/g, " "), MAX_LABEL_CELLS);
			return {
				kind: "item",
				selected: state.windowStart + i === state.selectedIndex,
				// The violet is a display classification, not the item's role
				// identity: a pinnable `category: role` row is purple while
				// `item.isRole` stays unset, so nothing downstream of the
				// renderer — hint, toggle, selection — reads it as a role.
				purple: isRoleTier(item),
				pinnable: item.pinnable,
				name,
				mark: pinMark,
				description: item.description,
			};
		});
	if (state.items.length > MAX_PICKER_ROWS) {
		rows.push({ kind: "footer", text: `  (${state.selectedIndex + 1}/${state.items.length})` });
	}
	const hint = pickerHint(state.items[state.selectedIndex], activeRole);
	if (hint) rows.push({ kind: "footer", text: `  → ${hint}` });
	ctx.ui.setWidget(PICKER_WIDGET_KEY, (_tui, theme) => new PickerWidget(rows, theme), { placement: "belowEditor" });
}

export type RawKey = "tab" | "enter" | "up" | "down" | "right" | "escape";

/** Decodes the handful of raw PTY key sequences the picker cares about;
 *  everything else (ordinary character input, unrecognized escape
 *  sequences) returns `undefined` and falls through to the built-in
 *  editor unconsumed. Exported so the key-dispatch mapping is directly
 *  unit-testable without standing up a real terminal input stream. */
export function decodeRawKey(data: string): RawKey | undefined {
	if (data === "\t") return "tab";
	if (data === "\r" || data === "\n") return "enter";
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\x1b[C") return "right";
	if (data === "\x1b") return "escape";
	return undefined;
}

interface UiWithTerminalInput {
	onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
	getEditorText(): string;
	setEditorText(text: string): void;
	setWidget(
		key: string,
		content: ((tui: unknown, theme: PickerTheme) => PickerWidget) | undefined,
		options?: { placement: "aboveEditor" | "belowEditor" },
	): void;
}

/** `ctx.setTimeout` — added in pi-coding-agent 16.3.14+; absent from older
 *  omp (including the 16.0.1 `.d.ts` snapshot this file typechecks
 *  against locally), hence the narrow structural cast below instead of
 *  relying on `ExtensionContext`'s (stale) declared shape. On an omp that
 *  predates 16.3.14 the property is simply missing at runtime — calling it
 *  unconditionally would throw on every keystroke that reaches the picker
 *  debounce. `resolveScheduler` below detects that at install time and
 *  falls back to the global `setTimeout`, so the picker still works
 *  (un-container-managed) on older omp instead of crashing. */
interface CtxWithManagedTimers {
	setTimeout(fn: () => void, ms: number): unknown;
}

/** Picks `ctx.setTimeout` when the running omp actually has it, otherwise
 *  the global timer — see `CtxWithManagedTimers` above for why this check
 *  exists at all. Resolved once per picker install, not per keystroke. */
export function resolveScheduler(ctx: ExtensionContext): (fn: () => void, ms: number) => void {
	const timers = ctx as unknown as CtxWithManagedTimers;
	if (typeof timers.setTimeout === "function") return (fn, ms) => timers.setTimeout(fn, ms);
	return (fn, ms) => setTimeout(fn, ms);
}

/** Pure index math for Up/Down navigation — wraps at both ends. A test
 *  seam, exported for direct unit testing without a real terminal input
 *  stream. */
export function nextPickerIndex(current: number, length: number, direction: "up" | "down"): number {
	if (direction === "up") return (current - 1 + length) % length;
	return (current + 1) % length;
}

/** Pure: the new editor buffer text after accepting a picker selection —
 *  splices `::<value> ` in place of the trailing matched trigger substring.
 *  A test seam, exported for direct unit testing without a real terminal
 *  input stream. */
export function computeAcceptedEditorText(currentText: string, matchedSuffix: string, value: string): string {
	return `${currentText.slice(0, currentText.length - matchedSuffix.length)}::${value} `;
}

/** Wires the raw-input picker for one session. Returns an unsubscribe function
 *  that also clears the widget.
 *  `pinnedStyles` is the SAME map the `input`/`before_agent_start` handlers
 *  use — a single source of truth, so a Right-arrow toggle here is visible
 *  to `::pins` and vice versa. `readActiveRole` is read lazily for the same
 *  reason: the picker is installed once per session lifecycle event, but the
 *  active role can change between keystrokes. */
function installSnippetPicker(
	ctx: ExtensionContext,
	pinnedStyles: Map<string, PinnedSnippet>,
	readActiveRole: () => string | undefined,
): () => void {
	const ui = ctx.ui as unknown as UiWithTerminalInput;
	const scheduleTimeout = resolveScheduler(ctx);
	let picker: PickerState | null = null;
	// The debounce below hands a callback to a scheduler we cannot always cancel
	// (`resolveScheduler` may fall back to the global timer on hosts without
	// `ctx.setTimeout`), and a session switch/shutdown can dispose this picker
	// while one is still queued. Without this flag that late callback would
	// re-read the editor and paint a widget into a context that is no longer
	// live — so every entry point that can run late checks it first.
	let disposed = false;

	function closePicker(): void {
		if (!picker) return;
		picker = null;
		ui.setWidget(PICKER_WIDGET_KEY, undefined);
	}

	function recomputePicker(): void {
		if (disposed) return;
		const text = ui.getEditorText();
		const match = isInsideUnclosedTriggerArgs(text) ? null : TRIGGER_AT_END.exec(text);
		if (!match) {
			closePicker();
			return;
		}
		const items = buildSnippetAutocompleteItems(ctx.cwd, match[1].toLowerCase(), {
			pinned: new Set(pinnedStyles.keys()),
			role: readActiveRole(),
		});
		if (items.length === 0) {
			closePicker();
			return;
		}
		picker = { matchedSuffix: match[0], items, selectedIndex: 0, windowStart: 0 };
		renderPicker(ctx, picker, pinnedStyles, readActiveRole());
	}

	function acceptSelection(): void {
		if (!picker) return;
		const item = picker.items[picker.selectedIndex];
		ui.setEditorText(computeAcceptedEditorText(ui.getEditorText(), picker.matchedSuffix, item.value));
		closePicker();
	}

	/** Right arrow toggles the highlighted item's pin state without touching
	 *  the message buffer or closing the picker — a separate action from
	 *  Tab/Enter (which insert the one-shot trigger into this message).
	 *  No-ops (falls through unconsumed, cursor moves normally) for
	 *  non-pinnable items — roles among them — and for parameterized ones
	 *  (`hasArgs`), since there's no argument value to bind here: those stay
	 *  `::pin(name(args))` text-only. A `guard: qa` item consults the same
	 *  runtime gate as the text path (`qaActivationRefusal`); a refusal warns
	 *  and leaves every pin untouched. The list is deliberately NOT re-sorted
	 *  here, so the highlighted row stays under the cursor. */
	function togglePinOnHighlighted(): boolean {
		if (!picker) return false;
		const item = picker.items[picker.selectedIndex];
		if (!canToggleFromPicker(item)) return false;
		if (pinnedStyles.has(item.value)) {
			pinnedStyles.delete(item.value);
		} else {
			const registry = buildSnippetRegistry(ctx.cwd);
			const attempt = pinSnippetByName(item.value, registry, pinnedStyles, (def) => qaActivationRefusal(ctx));
			if (attempt.status === "guard-refused") {
				ctx.ui.notify(`${item.value} not pinned — ${attempt.reason}`, "warning");
			} else if (attempt.status === "pinned") {
				notifyGroupReplace(ctx, [item.value], attempt.autoUnpinned);
			}
		}
		updatePinStatus(ctx, pinnedStyles);
		renderPicker(ctx, picker, pinnedStyles, readActiveRole());
		return true;
	}

	const unsubscribe = ui.onTerminalInput((data) => {
		if (disposed) return undefined;
		if (picker) {
			const key = decodeRawKey(data);
			if (key === "tab" || key === "enter") {
				acceptSelection();
				return { consume: true };
			}
			if (key === "up") {
				picker.selectedIndex = nextPickerIndex(picker.selectedIndex, picker.items.length, "up");
				scrollPickerIntoView(picker);
				renderPicker(ctx, picker, pinnedStyles, readActiveRole());
				return { consume: true };
			}
			if (key === "down") {
				picker.selectedIndex = nextPickerIndex(picker.selectedIndex, picker.items.length, "down");
				scrollPickerIntoView(picker);
				renderPicker(ctx, picker, pinnedStyles, readActiveRole());
				return { consume: true };
			}
			if (key === "right" && togglePinOnHighlighted()) {
				return { consume: true };
			}
			if (key === "escape") {
				closePicker();
				return { consume: true };
			}
		}
		// Not a picker-control key (or no picker active): let the built-in
		// editor apply it first, then recompute from the updated buffer.
		scheduleTimeout(recomputePicker, 30);
		return undefined;
	});

	return () => {
		disposed = true;
		closePicker();
		unsubscribe();
	};
}

// ============================================================================
// Extension
// ============================================================================

/** `before_subagent_spawn` — a real extension hook in current omp (verified
 *  in the shipped 18.10.4 runtime: handlers receive `{ type, agent,
 *  invocationKind, modelRole, patterns, spawnKey }` and returning
 *  `{ block: true, reason }` aborts the spawn with that reason, defaulting to
 *  "Subagent spawn blocked by extension."). It is absent from the 17.2.4
 *  `.d.ts` snapshot this package typechecks against, hence the narrow
 *  structural cast below — the same pattern as `CtxWithManagedTimers`.
 *  Spawns are not always model tool calls (`eval`/`workpool` can spawn
 *  directly), so this is Q&A-only mode's second enforcement point. */
interface SubagentSpawnEvent {
	type: "before_subagent_spawn";
	agent: string;
	invocationKind: string;
	modelRole?: string;
	patterns: string[];
	spawnKey?: string;
}

interface ApiWithSubagentSpawn {
	on(event: "before_subagent_spawn", handler: (event: SubagentSpawnEvent) => { block?: boolean; reason?: string } | undefined): void;
}

export default function snippetsExtension(pi: ExtensionAPI) {
	pi.setLabel("Snippets (::name)");

	let uninstallPicker: (() => void) | undefined;
	const pinnedStyles = new Map<string, PinnedSnippet>();
	const session: SnippetSessionState = { role: null, identityNoticeShown: false, reportedDiagnostics: new Set() };

	// Q&A-only enforcement: while any active pin snapshot carries `guard: qa`,
	// every tool call outside the read-only allowlist is refused here, before
	// the native approval gate — so it holds under yolo or an explicit
	// per-tool allow too, and no approval settings are touched. The decision
	// reads the live pin map on every call; nothing is cached.
	pi.on("tool_call", async (event) => {
		const reason = qaBlockReason(event.toolName, event.input, pinnedStyles);
		return reason ? { block: true, reason } : undefined;
	});

	// Same guard, second enforcement point: a spawn that never routes through
	// a tool call (`eval`/`workpool`) is refused here while the guard is
	// active. Registered through a narrow documented cast because the pinned
	// typings predate this hook; on a host without it the registration is a
	// no-op and tool_call still covers every model-issued spawn.
	const spawnApi = pi as unknown as ApiWithSubagentSpawn;
	spawnApi.on("before_subagent_spawn", (event) => {
		const reason = qaSpawnBlockReason(typeof event.agent === "string" ? event.agent : "", pinnedStyles);
		return reason ? { block: true, reason } : undefined;
	});

	/** (Re)installs the raw-input picker for the session context now in play and
	 *  re-derives the role from that session's active branch. Runs on every
	 *  lifecycle event that can move the session — a switch or a branch can hand
	 *  the runner a different context/cwd, so the previous listener is always
	 *  unsubscribed first and keystrokes are never handled twice. Pins and any
	 *  pending inject are untouched: they belong to this binding, not the file. */
	function reinstallPicker(ctx: ExtensionContext): void {
		uninstallPicker?.();
		// A picker widget left over from the previous context would otherwise stay
		// on screen after a switch, since the new UI never saw its close.
		ctx.ui.setWidget(PICKER_WIDGET_KEY, undefined);
		uninstallPicker = installSnippetPicker(ctx, pinnedStyles, () => session.role?.name);
		updatePinStatus(ctx, pinnedStyles);
		restoreRole(ctx, session);
	}

	pi.on("session_start", async (_event, ctx) => reinstallPicker(ctx));
	pi.on("session_switch", async (_event, ctx) => reinstallPicker(ctx));
	pi.on("session_branch", async (_event, ctx) => reinstallPicker(ctx));
	pi.on("session_tree", async (_event, ctx) => reinstallPicker(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		uninstallPicker?.();
		uninstallPicker = undefined;
		ctx.ui.setWidget(PICKER_WIDGET_KEY, undefined);
	});

	let pendingInject: string | undefined;

	pi.on("input", async (event, ctx) => {
		const text = event.text;
		if (!text || !text.includes("::")) return;

		const registry = buildSnippetRegistry(ctx.cwd);
		// An active role must stay clearable even if every snippet file behind it
		// is gone, so it is part of the "anything to do?" test.
		if (registry.size === 0 && pinnedStyles.size === 0 && session.role === null) return;
		surfaceDiagnostics(ctx, session, registry);

		const autoUnpinned: string[] = [];
		const before = new Set(pinnedStyles.keys());
		// Role actions first: they rewrite their triggers into confirmations, so
		// the pin pass and the expansion pass below see plain prose where a role
		// trigger used to be — and a role is never expanded either way.
		const afterRoles = applyRoleActions(text, registry, ctx, session, pi);
		const preprocessed = processPinTriggers(afterRoles, registry, pinnedStyles, autoUnpinned, (def) => qaActivationRefusal(ctx));
		notifyGroupReplace(ctx, [...pinnedStyles.keys()].filter((name) => !before.has(name)), autoUnpinned);
		updatePinStatus(ctx, pinnedStyles);

		const result = expandTriggers(preprocessed, registry);
		const finalText = assembleMessage(result);
		const noChange = finalText === text && result.inject.length === 0;
		if (noChange) return;

		if (result.inject.length > 0) {
			pendingInject = result.inject.join("\n\n");
		}

		return { text: finalText };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const content = pendingInject;
		pendingInject = undefined;
		const message = content
			? { customType: "snippet-inject", content, display: false, attribution: "user" as const }
			: undefined;

		// The native prompt is preserved as-is; our blocks are appended after it,
		// pinned styles first (unchanged) and the operational role last.
		const blocks: string[] = [];
		if (pinnedStyles.size > 0) blocks.push(...buildPinnedSystemPromptBlocks(pinnedStyles));
		if (session.role && resolveAgentIdentity(ctx) === "main") blocks.push(...buildRoleSystemPromptBlocks(session.role));

		if (!message && blocks.length === 0) return;
		return { message, systemPrompt: blocks.length > 0 ? [...event.systemPrompt, ...blocks] : undefined };
	});
}
