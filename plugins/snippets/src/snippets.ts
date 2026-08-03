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
 * ## Three-tier source
 *
 * - `examples/*.md` (bundled with this package) — lowest priority. A
 *   handful of example snippets shipped so `::` has something to
 *   demonstrate out of the box, even in a project with no snippet
 *   directory of its own. Any project-level snippet with the same
 *   name/alias always wins over a bundled one.
 * - `.opencode/snippet/*.md` (project-level, shared with OpenCode's
 *   `opencode-snippets` plugin) — the primary place to add your own
 *   snippets.
 * - `.omp/snippets/*.md` (project-level, omp-only forks/overrides) — for
 *   the rare snippet whose content needs to diverge specifically for omp
 *   (e.g. referencing an omp-specific subagent) without touching the
 *   shared file or affecting OpenCode sessions. A byte-for-byte (or
 *   near-identical) copy in this tier is NOT a fork, it's an unmonitored
 *   duplicate — nothing keeps the two in sync, so the next edit to one and
 *   not the other silently drifts them apart. Only fork a snippet here
 *   when its content genuinely needs to differ.
 *
 * ## Why `input`, not `before_agent_start`
 *
 * The upstream plugin rewrites the actual submitted message text: content
 * outside `<prepend>`/`<append>` blocks replaces the `#trigger` inline, and
 * block content is spliced into the visible message (prepend at the top,
 * append at the bottom) — see `.opencode/snippet/reflect.md` etc., whose
 * trailing plain-text line ("Reflect on this") is exactly this inline
 * replacement text. That is a visible rewrite of the user's own prompt, not
 * a hidden system note, so it maps to omp's `input` event
 * (`InputEventResult.text` replaces the submitted text) rather than
 * `before_agent_start` (which can only add one *additional hidden* message).
 *
 * `<inject>` blocks are the one part of the upstream schema that IS meant to
 * be hidden context for the whole turn — those are collected separately and
 * delivered via `before_agent_start` as a `display: false` custom message.
 * None of the current `.opencode/snippet/*.md` files use `<inject>`, but the
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
 * Rows are color-coded by what they are, not just marked: plain text for
 * ordinary one-shot snippets, `success` (green) for pinnable-but-inactive,
 * `warning` (amber) for pinnable-and-currently-pinned, `accent` for
 * whichever row is selected (overrides the other two). Right arrow on a
 * highlighted pinnable row toggles its pin state in place — no text
 * inserted, picker stays open — separate from Tab/Enter, which still insert
 * the one-shot trigger into the message as before. Excluded from the
 * hotkey: snippets with an unbound `$1`/`$@`/`$ARGUMENTS` placeholder
 * (`max-chars`) — there's no argument value to bind from a keypress, so
 * those stay `::pin(name(args))` text-only. A status-bar line
 * (`ctx.ui.setStatus`) mirrors the pinned set at all times, not just while
 * the picker is open, so pin state doesn't disappear once you close it.
 *
 * Currently-pinned items float to the top within each match-relevance tier
 * (exact match still beats prefix beats substring — floating is a
 * tiebreaker, never a relevance override; see `sortByPinState`). Merely
 * `pinnable: true` snippets that aren't pinned right now get their color
 * but no positional privilege — they sort inline with one-shot snippets,
 * not clustered above them, so a growing pinnable set doesn't bury the
 * ordinary one-shot triggers most `::` usage actually reaches for.
 * Recomputed on every keystroke, but deliberately NOT re-run when a
 * Right-arrow toggle changes pin state while the picker is already open —
 * reordering mid-browse would jump the row out from under the user's
 * cursor.
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
 * Pure functions below are exported for `snippets.test.ts`; the extension
 * itself is the default export.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Snippet registry — .opencode/snippet/*.md (shared with OpenCode) overlaid
// by .omp/snippets/*.md (omp-only forks/overrides). Reloaded fresh on every
// trigger match; see "Hot reload" above.
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

export function parseFrontmatterAliases(fileContent: string): { aliases: string[]; pinnable: boolean; group?: string; body: string } {
	const fm = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!fm) return { aliases: [], pinnable: false, body: fileContent };

	const body = fileContent.slice(fm[0].length);
	const lines = fm[1].split(/\r?\n/);
	const aliases: string[] = [];
	let pinnable = false;
	let group: string | undefined;
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
		}
	}
	return { aliases, pinnable, group, body };
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
		const { aliases, pinnable, group, body } = parseFrontmatterAliases(content);
		const def: SnippetDef = { name, raw: body, pinnable, group };
		if (!registry.has(name)) registry.set(name, def);
		for (const alias of aliases) {
			const key = alias.toLowerCase();
			if (key && !registry.has(key)) registry.set(key, def);
		}
	}
	return registry;
}

/** Merges bundled example snippets (shipped alongside this module in
 *  `../examples/`, lowest priority) with `.omp/snippets/*.md` (omp-only
 *  forks) over `.opencode/snippet/*.md` (shared source) — omp-only entries
 *  win on name/alias collision, so a fork like `judge.md` can diverge
 *  without touching the shared file. Bundled examples exist so a
 *  marketplace-installed plugin has something to demonstrate `::` triggers
 *  with out of the box, even in a project with no `.opencode/snippet`
 *  directory of its own — any project-level snippet with the same
 *  name/alias always wins over the bundled one. `loadSnippetDir` returns an
 *  empty registry for a missing directory (not an error), so this is a
 *  no-op when no `examples/` directory ships alongside the module — e.g.
 *  when this file is vendored directly into a project's own
 *  `.omp/extensions/`, as opposed to installed as a marketplace plugin. */
export function buildSnippetRegistry(cwd: string): Map<string, SnippetDef> {
	const bundled = loadSnippetDir(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples"));
	const shared = loadSnippetDir(path.join(cwd, ".opencode", "snippet"));
	const ompOnly = loadSnippetDir(path.join(cwd, ".omp", "snippets"));
	return new Map([...bundled, ...shared, ...ompOnly]);
}

// ============================================================================
// Arg placeholder substitution — copied from @oh-my-pi/pi-coding-agent's
// src/utils/command-args.ts (same convention as .omp/commands/*.md; not part
// of the package's public export surface, so copied rather than imported).
// See THIRD_PARTY_NOTICES.md for the upstream MIT notice this carries.
// ============================================================================

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (const char of argsString) {
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

/** Lenient stack-based parser: unclosed tag -> rest of content becomes the
 *  block; nesting/mismatch -> null (caller leaves the trigger unexpanded). */
export function parseSnippetBlocks(content: string): ParsedSnippetBody | null {
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

const TRIGGER_PATTERN = /::([\w-]+)(?:\(([^)]*)\))?/g;

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
const BRACKET_CHAIN_PATTERN = /((?:::[\w-]+\s*)+)<<([\s\S]*?)>>/g;
const CHAIN_NAME_PATTERN = /::([\w-]+)/g;

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
	const snippet = registry.get(name.toLowerCase());
	if (!snippet) return { ok: false, loop: false };

	const count = (expansionCounts.get(snippet.name) ?? 0) + 1;
	if (count > MAX_EXPANSION_DEPTH) return { ok: false, loop: true };
	expansionCounts.set(snippet.name, count);

	const substituted = substituteArgs(snippet.raw, args);
	const parsed = parseSnippetBlocks(substituted);
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

		expanded = expanded.replace(BRACKET_CHAIN_PATTERN, (match, chain: string, content: string) => {
			const names = [...chain.matchAll(CHAIN_NAME_PATTERN)].map((m) => m[1]);
			const arg = [content.trim()];
			const pieces: string[] = [];
			let anyExpanded = false;

			for (const name of names) {
				const result = expandSingleTrigger(name, arg, registry, expansionCounts, collector);
				if (!result.ok) {
					if (result.loop) loopDetected = true;
					pieces.push(`::${name}`); // unknown/malformed — keep this one literal
					continue;
				}
				anyExpanded = true;
				pieces.push(result.text);
			}

			// Only consumes the brackets once at least one trigger actually
			// expanded; an all-unknown chain leaves the whole match untouched,
			// same as an unknown bare trigger today.
			return anyExpanded ? pieces.join(" ") : match;
		});

		expanded = expanded.replace(TRIGGER_PATTERN, (match, name: string, argsStr: string | undefined) => {
			const args = parseCommandArgs(argsStr ?? "");
			const result = expandSingleTrigger(name, args, registry, expansionCounts, collector);
			if (!result.ok) {
				if (result.loop) loopDetected = true;
				return match;
			}
			return result.text;
		});

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
// ============================================================================

/** Auto-unpins any other currently-pinned snippet sharing `def.group` (a
 *  no-op if `def.group` is unset — the default for most pinnable snippets,
 *  which are freely composable). Enforces exclusivity for the rare pair
 *  whose content is logically, not just stylistically, contradictory (e.g.
 *  `bluf` "state the answer first" vs. `socratic` "never state the answer" —
 *  no single response can satisfy both, so silently keeping both pinned
 *  just means the model picks a winner with no signal to the user which).
 *  Returns the names actually removed, so callers can surface a notice. */
export function unpinGroupSiblings(def: SnippetDef, registry: Map<string, SnippetDef>, pinned: Map<string, string>): string[] {
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
 *  auto-unpinned by group exclusivity (empty if none). */
function applyPin(def: SnippetDef, triggerText: string, registry: Map<string, SnippetDef>, pinned: Map<string, string>): string[] {
	const removed = unpinGroupSiblings(def, registry, pinned);
	const expansion = expandTriggers(`::${triggerText}`, registry);
	pinned.set(def.name, expansion.append.join("\n\n") || expansion.text);
	return removed;
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
 *  Optional `autoUnpinnedOut`: when a `::pin(name)` triggers group exclusion
 *  (see `unpinGroupSiblings`), the auto-removed name(s) are pushed here so
 *  the caller can surface a notice — omit it to ignore that signal
 *  entirely (backward compatible with existing callers/tests). */
export function processPinTriggers(text: string, registry: Map<string, SnippetDef>, pinned: Map<string, string>, autoUnpinnedOut?: string[]): string {
	let result = text;
	const NESTED_PARENS = "(?:[^()]|\\([^()]*\\))*";

	result = result.replace(/::pins\b/gi, () => {
		if (pinned.size === 0) return "(no active pins)";
		return `(pinned: ${[...pinned.keys()].sort().join(", ")})`;
	});

	result = result.replace(new RegExp(`::unpin\\((${NESTED_PARENS})\\)`, "gi"), (match, inner: string) => {
		const nameMatch = /^([\w-]+)/.exec(inner.trim());
		const rawName = nameMatch?.[1]?.toLowerCase() ?? "";
		const def = registry.get(rawName);
		const canonical = def?.name ?? rawName;
		if (!canonical) return match;
		if (pinned.has(canonical)) {
			pinned.delete(canonical);
			return `(unpinned: ${canonical})`;
		}
		return `(${canonical} was not pinned)`;
	});

	result = result.replace(new RegExp(`::pin\\((${NESTED_PARENS})\\)`, "gi"), (match, inner: string) => {
		const trimmed = inner.trim();
		const nameMatch = /^([\w-]+)/.exec(trimmed);
		const def = nameMatch ? registry.get(nameMatch[1].toLowerCase()) : undefined;
		if (!def || !def.pinnable) return match; // unknown or not pinnable: left inert
		const removed = applyPin(def, trimmed, registry, pinned);
		if (autoUnpinnedOut) autoUnpinnedOut.push(...removed);
		return `::${trimmed}`;
	});

	return result;
}

/** Bare-name pin, no arg substitution — used by the picker's hotkey toggle
 *  (Right arrow), which has no argument value to bind and only ever offers
 *  this on items where `AutocompleteItem.hasArgs` is false. `::pin(name)`
 *  text triggers go through `processPinTriggers` above instead, which also
 *  handles the `name(args)` case this deliberately doesn't. Returns whether
 *  the pin was applied (false: unknown name or not pinnable). */
export function pinSnippetByName(name: string, registry: Map<string, SnippetDef>, pinned: Map<string, string>): boolean {
	const def = registry.get(name.toLowerCase());
	if (!def || !def.pinnable) return false;
	applyPin(def, def.name, registry, pinned);
	return true;
}

/** Builds the extra system-prompt block for currently pinned styles. Called
 *  fresh on every `before_agent_start` — see the header note above on why
 *  nothing here is engine-persisted.
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
 *  `plan-mode` is the one deliberate exception: it explicitly changes WHAT
 *  gets done (defers write/edit/exec until approval), not just HOW
 *  responses are phrased — so its own content self-declares the carve-out
 *  ("Unlike other pinned presentation preferences, this one changes WHAT
 *  you do...") rather than the mechanism silently overriding the preamble
 *  for every pin. This is advisory, not an enforced tool gate — the pin
 *  mechanism only adds system-prompt text, it cannot block tool calls the
 *  way `tools.approvalMode` does; a model that ignores the instruction
 *  isn't stopped by anything here. */
export function buildPinnedSystemPromptBlocks(pinned: Map<string, string>): string[] {
	if (pinned.size === 0) return [];
	const preamble =
		"The following are session-scoped presentation preferences the user explicitly turned on via ::pin. " +
		"They govern HOW you phrase, format, and size responses — never WHAT you must verify, complete, or ship. " +
		"Every contract, completeness, and yielding requirement defined earlier in this prompt remains fully in " +
		"force regardless of any preference below.";
	const styles = [...pinned.entries()].map(([name, content]) => `<pinned-style name="${name}">\n${content}\n</pinned-style>`);
	return [`<pinned-styles>\n${preamble}\n\n${styles.join("\n\n")}\n</pinned-styles>`];
}

const PIN_STATUS_KEY = "snippet-pins";

/** Keeps a persistent "what's pinned right now" indicator in the TUI status
 *  bar/footer, so pin state stays visible after the picker closes and
 *  without re-typing `::pins`. Call after any mutation to the pinned map. */
function updatePinStatus(ctx: ExtensionContext, pinned: ReadonlyMap<string, string>): void {
	ctx.ui.setStatus(PIN_STATUS_KEY, pinned.size === 0 ? undefined : `📌 ${[...pinned.keys()].sort().join(", ")}`);
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
//      other key keeps behaving exactly as before.
//   4. Accepting splices `::<value> ` (trailing space, so the buffer no
//      longer ends in a bare trigger and the picker closes on its own) into
//      the buffer via `setEditorText` — the literal token the `input`
//      handler above already expands, so nothing else needs to change.
// ============================================================================

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	pinnable: boolean;
	/** True when the snippet body still has an unbound `$1`/`$@`/`$ARGUMENTS`
	 *  placeholder — the picker's hotkey-toggle can't supply an arg value, so
	 *  these are excluded from it and stay `::pin(name(args))`-text-only. */
	hasArgs: boolean;
}

const PICKER_WIDGET_KEY = "snippet-picker";
const TRIGGER_AT_END = /::([\w-]*)$/;
const MAX_PICKER_ROWS = 8;
const MAX_PREVIEW_WORDS = 8;

/** Ranks a registry entry against a typed query: exact > prefix > substring > no match (-1). */
function scoreSnippetMatch(query: string, def: SnippetDef): number {
	if (!query) return 0;
	const name = def.name.toLowerCase();
	if (name === query) return 3;
	if (name.startsWith(query)) return 2;
	if (name.includes(query)) return 1;
	return -1;
}

const PLACEHOLDER_PATTERN = /\$(\d+|@|ARGUMENTS)/;

export function buildSnippetAutocompleteItems(cwd: string, query: string): AutocompleteItem[] {
	const registry = buildSnippetRegistry(cwd);
	const seen = new Set<SnippetDef>();
	const scored: Array<{ item: AutocompleteItem; score: number }> = [];

	for (const def of registry.values()) {
		if (seen.has(def)) continue;
		seen.add(def);
		const score = scoreSnippetMatch(query, def);
		if (score < 0) continue;
		const words = def.raw.replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
		const preview =
			words.length === 0 ? undefined : words.length > MAX_PREVIEW_WORDS ? `${words.slice(0, MAX_PREVIEW_WORDS).join(" ")}…` : words.join(" ");
		const item: AutocompleteItem = {
			value: def.name,
			label: `::${def.name}`,
			description: preview || undefined,
			pinnable: def.pinnable,
			hasArgs: PLACEHOLDER_PATTERN.test(def.raw),
		};
		scored.push({ item, score });
	}

	return scored.sort((a, b) => b.score - a.score || a.item.value.localeCompare(b.item.value)).map((s) => s.item);
}

/** Floats currently-pinned items to the top of the picker, keeping every
 *  other item — pinnable or not — in its original (match-score, then
 *  alphabetical) order from `buildSnippetAutocompleteItems`. Deliberately
 *  a 2-way split, not a 3-way one: an earlier version also clustered
 *  pinnable-but-INACTIVE snippets ahead of one-shot ones, on the theory
 *  that grouping "things you could pin" together helps browsing. In
 *  practice that backfired — with 8 pinnable snippets and growing, the
 *  whole set permanently buried every ordinary one-shot snippet at the
 *  bottom of the list regardless of whether anything was actually pinned,
 *  even though most `::` usage is one-shot triggers, not pin management.
 *  Only an item you've actually opted into (pinned right now) earns a
 *  guaranteed top slot; `pinnable: true` alone still gets a color (see
 *  `renderPicker`) but no positional privilege. `Array.prototype.sort` is
 *  stable (guaranteed since ES2019/V8, which Bun embeds), so this key only
 *  distinguishes the two clusters, never reorders within either. Applied
 *  only when the picker recomputes from a keystroke — deliberately NOT
 *  re-run on every pin toggle, so pinning an item mid-browse doesn't jump
 *  it to a new row out from under the user's cursor. */
export function sortByPinState(items: AutocompleteItem[], pinnedNames: ReadonlySet<string>): AutocompleteItem[] {
	const rank = (item: AutocompleteItem): number => (pinnedNames.has(item.value) ? 0 : 1);
	return [...items].sort((a, b) => rank(a) - rank(b));
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
 *  those stay `::pin(name(args))` text-only. Shared by the render hint
 *  (line below) and `togglePinOnHighlighted`'s actual gate — a test seam,
 *  exported for direct unit testing without a real terminal input stream. */
export function canToggleFromPicker(item: Pick<AutocompleteItem, "pinnable" | "hasArgs"> | undefined): boolean {
	return !!item?.pinnable && !item.hasArgs;
}

function renderPicker(ctx: ExtensionContext, state: PickerState, pinned: ReadonlyMap<string, string>): void {
	const visible = state.items.slice(state.windowStart, state.windowStart + MAX_PICKER_ROWS);
	const lines = visible.map((item, i) => {
		const absoluteIndex = state.windowStart + i;
		const isSelected = absoluteIndex === state.selectedIndex;
		const isActive = item.pinnable && pinned.has(item.value);
		// ☐/📌 only for pinnable items; non-pinnable rows keep the column blank
		// so labels stay aligned instead of every row needing a placeholder.
		const pinMark = item.pinnable ? (isActive ? " 📌" : " ☐") : "";
		const marker = isSelected ? "▸ " : "  ";
		const label = `${item.label}${pinMark}`.padEnd(22);
		const line = `${marker}${label}${item.description ?? ""}`;
		if (isSelected) return ctx.ui.theme.fg("accent", line);
		if (isActive) return ctx.ui.theme.fg("warning", line);
		if (item.pinnable) return ctx.ui.theme.fg("success", line);
		return line;
	});
	if (state.items.length > MAX_PICKER_ROWS) {
		lines.push(ctx.ui.theme.fg("muted", `  (${state.selectedIndex + 1}/${state.items.length})`));
	}
	const highlighted = state.items[state.selectedIndex];
	if (canToggleFromPicker(highlighted)) {
		lines.push(ctx.ui.theme.fg("muted", "  → right arrow to toggle pin"));
	}
	ctx.ui.setWidget(PICKER_WIDGET_KEY, lines, { placement: "belowEditor" });
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
	theme: { fg(name: string, text: string): string };
	setWidget(key: string, content: string[] | undefined, options?: { placement: "aboveEditor" | "belowEditor" }): void;
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

/** Wires the raw-input picker for one session. Returns an unsubscribe function.
 *  `pinnedStyles` is the SAME map the `input`/`before_agent_start` handlers
 *  use — a single source of truth, so a Right-arrow toggle here is visible
 *  to `::pins` and vice versa. */
function installSnippetPicker(ctx: ExtensionContext, pinnedStyles: Map<string, string>): () => void {
	const ui = ctx.ui as unknown as UiWithTerminalInput;
	const scheduleTimeout = resolveScheduler(ctx);
	let picker: PickerState | null = null;

	function closePicker(): void {
		if (!picker) return;
		picker = null;
		ui.setWidget(PICKER_WIDGET_KEY, undefined);
	}

	function recomputePicker(): void {
		const match = TRIGGER_AT_END.exec(ui.getEditorText());
		if (!match) {
			closePicker();
			return;
		}
		const items = sortByPinState(buildSnippetAutocompleteItems(ctx.cwd, match[1].toLowerCase()), new Set(pinnedStyles.keys()));
		if (items.length === 0) {
			closePicker();
			return;
		}
		picker = { matchedSuffix: match[0], items, selectedIndex: 0, windowStart: 0 };
		renderPicker(ctx, picker, pinnedStyles);
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
	 *  non-pinnable items and for parameterized ones (`hasArgs`), since
	 *  there's no argument value to bind here — those stay `::pin(name(args))`
	 *  text-only. */
	function togglePinOnHighlighted(): boolean {
		if (!picker) return false;
		const item = picker.items[picker.selectedIndex];
		if (!canToggleFromPicker(item)) return false;
		if (pinnedStyles.has(item.value)) {
			pinnedStyles.delete(item.value);
		} else {
			const registry = buildSnippetRegistry(ctx.cwd);
			const before = new Set(pinnedStyles.keys());
			pinSnippetByName(item.value, registry, pinnedStyles);
			notifyGroupReplace(ctx, [item.value], [...before].filter((name) => !pinnedStyles.has(name)));
		}
		updatePinStatus(ctx, pinnedStyles);
		renderPicker(ctx, picker, pinnedStyles);
		return true;
	}

	return ui.onTerminalInput((data) => {
		if (picker) {
			const key = decodeRawKey(data);
			if (key === "tab" || key === "enter") {
				acceptSelection();
				return { consume: true };
			}
			if (key === "up") {
				picker.selectedIndex = nextPickerIndex(picker.selectedIndex, picker.items.length, "up");
				scrollPickerIntoView(picker);
				renderPicker(ctx, picker, pinnedStyles);
				return { consume: true };
			}
			if (key === "down") {
				picker.selectedIndex = nextPickerIndex(picker.selectedIndex, picker.items.length, "down");
				scrollPickerIntoView(picker);
				renderPicker(ctx, picker, pinnedStyles);
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
}

// ============================================================================
// Extension
// ============================================================================

export default function snippetsExtension(pi: ExtensionAPI) {
	pi.setLabel("Snippets (::name)");

	let uninstallPicker: (() => void) | undefined;
	const pinnedStyles = new Map<string, string>();

	pi.on("session_start", async (_event, ctx) => {
		uninstallPicker = installSnippetPicker(ctx, pinnedStyles);
		updatePinStatus(ctx, pinnedStyles);
	});

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
		if (registry.size === 0 && pinnedStyles.size === 0) return;

		const autoUnpinned: string[] = [];
		const before = new Set(pinnedStyles.keys());
		const preprocessed = processPinTriggers(text, registry, pinnedStyles, autoUnpinned);
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

	pi.on("before_agent_start", async (event) => {
		const content = pendingInject;
		pendingInject = undefined;
		const message = content
			? { customType: "snippet-inject", content, display: false, attribution: "user" as const }
			: undefined;
		const systemPrompt =
			pinnedStyles.size > 0 ? [...event.systemPrompt, ...buildPinnedSystemPromptBlocks(pinnedStyles)] : undefined;

		if (!message && !systemPrompt) return;
		return { message, systemPrompt };
	});
}
