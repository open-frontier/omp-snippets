import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assembleMessage,
	buildPinnedSystemPromptBlocks,
	type AutocompleteItem,
	buildSnippetAutocompleteItems,
	buildSnippetRegistry,
	canToggleFromPicker,
	computeAcceptedEditorText,
	decodeRawKey,
	expandTriggers,
	loadSnippetDir,
	nextPickerIndex,
	resolveScheduler,
	parseCommandArgs,
	parseFrontmatterAliases,
	parseSnippetBlocks,
	pinSnippetByName,
	processPinTriggers,
	scrollPickerIntoView,
	sortByPinState,
	unpinGroupSiblings,
	type SnippetDef,
	substituteArgs,
} from "../src/snippets.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-snippets-test-"));
}

const cleanupDirs: string[] = [];
function writeSnippet(dir: string, filename: string, content: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, filename), content, "utf8");
	if (!cleanupDirs.includes(dir)) cleanupDirs.push(dir);
}

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ============================================================================
// parseFrontmatterAliases
// ============================================================================

describe("parseFrontmatterAliases", () => {
	it("returns no aliases and the whole content when there is no frontmatter", () => {
		const result = parseFrontmatterAliases("just a body\nwith no frontmatter");
		expect(result.aliases).toEqual([]);
		expect(result.body).toBe("just a body\nwith no frontmatter");
	});

	it("parses a single inline scalar alias", () => {
		const result = parseFrontmatterAliases("---\naliases: safe\n---\nBe careful");
		expect(result.aliases).toEqual(["safe"]);
		expect(result.body).toBe("Be careful");
	});

	it("parses a bracketed inline array of aliases", () => {
		const result = parseFrontmatterAliases("---\naliases: [reframe, reflect, clarify]\n---\nbody");
		expect(result.aliases).toEqual(["reframe", "reflect", "clarify"]);
	});

	it("parses a YAML block-list of aliases", () => {
		const result = parseFrontmatterAliases("---\naliases:\n  - todo\n  - task\n---\nbody");
		expect(result.aliases).toEqual(["todo", "task"]);
	});

	it("strips quotes from alias values in every form", () => {
		expect(parseFrontmatterAliases('---\naliases: "safe"\n---\n').aliases).toEqual(["safe"]);
		expect(parseFrontmatterAliases("---\naliases: ['a', \"b\"]\n---\n").aliases).toEqual(["a", "b"]);
		expect(parseFrontmatterAliases("---\naliases:\n  - 'x'\n---\n").aliases).toEqual(["x"]);
	});

	it("stops at the first aliases key and ignores unrelated frontmatter keys", () => {
		const result = parseFrontmatterAliases("---\ndescription: unrelated\naliases: foo\nother: bar\n---\nbody");
		expect(result.aliases).toEqual(["foo"]);
		expect(result.body).toBe("body");
	});

	it("defaults pinnable to false when the key is absent", () => {
		expect(parseFrontmatterAliases("---\naliases: safe\n---\nbody").pinnable).toBe(false);
		expect(parseFrontmatterAliases("no frontmatter at all").pinnable).toBe(false);
	});

	it("parses pinnable: true regardless of alias-key ordering", () => {
		expect(parseFrontmatterAliases("---\naliases: safe\npinnable: true\n---\nbody").pinnable).toBe(true);
		expect(parseFrontmatterAliases("---\npinnable: true\naliases: safe\n---\nbody").pinnable).toBe(true);
	});

	it("treats any non-'true' pinnable value as false", () => {
		expect(parseFrontmatterAliases("---\npinnable: false\n---\nbody").pinnable).toBe(false);
		expect(parseFrontmatterAliases("---\npinnable: yes\n---\nbody").pinnable).toBe(false);
	});

	it("parses an optional group field, undefined when absent", () => {
		expect(parseFrontmatterAliases("---\npinnable: true\ngroup: answer-delivery\n---\nbody").group).toBe("answer-delivery");
		expect(parseFrontmatterAliases("---\npinnable: true\n---\nbody").group).toBeUndefined();
		expect(parseFrontmatterAliases("---\ngroup: \"quoted\"\n---\nbody").group).toBe("quoted");
	});
});

// ============================================================================
// loadSnippetDir / buildSnippetRegistry
// ============================================================================

describe("loadSnippetDir", () => {
	it("returns an empty registry for a missing directory", () => {
		const registry = loadSnippetDir(path.join(tempDir(), "does-not-exist"));
		expect(registry.size).toBe(0);
	});

	it("indexes a snippet by filename stem and every alias, case-insensitively", () => {
		const dir = tempDir();
		writeSnippet(dir, "cherry-pick.md", "---\naliases: [cp, pick]\n---\nbody");
		const registry = loadSnippetDir(dir);
		expect(registry.get("cherry-pick")?.name).toBe("cherry-pick");
		expect(registry.get("cp")?.name).toBe("cherry-pick");
		expect(registry.get("pick")?.name).toBe("cherry-pick");
		expect(registry.get("CP")).toBeUndefined(); // caller must lowercase the lookup key
	});

	it("keeps the file's raw body (post-frontmatter) unexpanded", () => {
		const dir = tempDir();
		writeSnippet(dir, "x.md", "---\naliases: y\n---\n<append>\n<task>hi</task>\n</append>\n\ninline");
		const registry = loadSnippetDir(dir);
		expect(registry.get("x")?.raw).toBe("<append>\n<task>hi</task>\n</append>\n\ninline");
	});

	it("propagates pinnable per-file, defaulting to false when absent", () => {
		const dir = tempDir();
		writeSnippet(dir, "sticky.md", "---\naliases: s\npinnable: true\n---\nbody");
		writeSnippet(dir, "oneshot.md", "---\naliases: o\n---\nbody");
		const registry = loadSnippetDir(dir);
		expect(registry.get("sticky")?.pinnable).toBe(true);
		expect(registry.get("oneshot")?.pinnable).toBe(false);
	});

	it("resolves a colliding alias to the lexicographically-first filename, not filesystem readdir order", () => {
		// Regression test: fs.readdirSync does not guarantee sorted order, but
		// the doc comment above loadSnippetDir promises "lexicographic readdir
		// order" wins ties. Write in an order that would expose an unsorted
		// implementation (writeSnippet's own iteration/mtime order is not
		// alphabetical here) and assert the lexicographically-first file wins
		// regardless of write order.
		const dir = tempDir();
		for (const file of ["zebra.md", "mango.md", "apple.md", "banana.md"]) {
			writeSnippet(dir, file, "---\naliases: shared\n---\nbody");
		}
		const registry = loadSnippetDir(dir);
		expect(registry.get("shared")?.name).toBe("apple");
	});
});

describe("loadSnippetDir — malformed and adversarial input", () => {
	it("does not crash on an empty file, treating it as an empty body with no aliases", () => {
		const dir = tempDir();
		writeSnippet(dir, "empty.md", "");
		const registry = loadSnippetDir(dir);
		expect(registry.get("empty")).toEqual({ name: "empty", raw: "", pinnable: false, group: undefined });
	});

	it("treats an unterminated frontmatter block (no closing ---) as no frontmatter at all", () => {
		const dir = tempDir();
		writeSnippet(dir, "broken.md", "---\naliases: b\nno closing delimiter here");
		const registry = loadSnippetDir(dir);
		// The regex requires a closing `---`; without one, nothing is stripped
		// and the whole file — including the leading `---` — becomes the body.
		expect(registry.get("broken")?.raw).toBe("---\naliases: b\nno closing delimiter here");
		expect(registry.get("b")).toBeUndefined(); // never parsed as an alias
	});

	it("does not crash on a file containing only frontmatter and no body", () => {
		const dir = tempDir();
		writeSnippet(dir, "bare.md", "---\naliases: b\n---\n");
		const registry = loadSnippetDir(dir);
		expect(registry.get("bare")?.raw).toBe("");
		expect(registry.get("b")?.name).toBe("bare");
	});
});

describe("reserved trigger names (pin/unpin/pins) at the registry boundary", () => {
	// A snippet author could legitimately (or maliciously, in a third-party
	// marketplace catalog) ship a file literally named pin.md/unpin.md/pins.md.
	// processPinTriggers intercepts the *parenthesized* `::pin(...)` /
	// `::unpin(...)` forms and the bare `::pins` form unconditionally, before
	// any registry lookup runs — confirming the actual precedence, not just
	// the doc comment's claim of it.
	it("permanently shadows a snippet named pins.md — ::pins always resolves to the status query", () => {
		const dir = tempDir();
		writeSnippet(dir, "pins.md", "---\npinnable: true\n---\nnot the status query");
		const registry = loadSnippetDir(dir);
		const pinned = new Map<string, string>();
		expect(processPinTriggers("::pins", registry, pinned)).toBe("(no active pins)");
	});

	it("permanently shadows a snippet named unpin.md for the parenthesized form — ::unpin(x) always resolves to the reserved unpin action", () => {
		const dir = tempDir();
		writeSnippet(dir, "unpin.md", "---\npinnable: true\n---\nnot the unpin action");
		writeSnippet(dir, "concise.md", "---\npinnable: true\n---\nbe concise");
		const registry = loadSnippetDir(dir);
		const pinned = new Map<string, string>([["concise", "be concise"]]);
		expect(processPinTriggers("::unpin(concise)", registry, pinned)).toBe("(unpinned: concise)");
	});

	it("permanently shadows a snippet named pin.md for the parenthesized form — ::pin(x) always pins x via the reserved action, never resolves pin.md's own content", () => {
		const dir = tempDir();
		writeSnippet(dir, "pin.md", "---\npinnable: true\n---\nnot the pin action");
		writeSnippet(dir, "concise.md", "---\npinnable: true\n---\nbe concise");
		const registry = loadSnippetDir(dir);
		const pinned = new Map<string, string>();
		expect(processPinTriggers("::pin(concise)", registry, pinned)).toBe("::concise");
		expect(pinned.has("concise")).toBe(true);
	});

	it("a bare ::pin trigger (no parens) is NOT reserved and resolves to the ordinary pin.md snippet via expandTriggers", () => {
		const dir = tempDir();
		writeSnippet(dir, "pin.md", "this is the actual pin.md content");
		const registry = loadSnippetDir(dir);
		expect(expandTriggers("::pin", registry).text).toBe("this is the actual pin.md content");
	});
});


describe("buildSnippetRegistry", () => {
	it("merges .opencode/snippet and .omp/snippets, with .omp/snippets winning on collision", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "shared.md", "shared-only body");
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "overridden.md", "opencode version");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "overridden.md", "omp-fork version");

		const registry = buildSnippetRegistry(cwd);
		expect(registry.get("shared")?.raw).toBe("shared-only body");
		expect(registry.get("overridden")?.raw).toBe("omp-fork version");
	});

	it("still works when only one of the two directories exists", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "only.md", "content");
		const registry = buildSnippetRegistry(cwd);
		expect(registry.get("only")?.raw).toBe("content");
	});

	it("a project with no .opencode/snippet or .omp/snippets directory still gets the bundled examples", () => {
		const cwd = tempDir(); // fresh temp dir, no snippet directories at all
		const registry = buildSnippetRegistry(cwd);
		expect(registry.get("careful")?.pinnable).toBe(true);
		expect(registry.get("concise")?.pinnable).toBe(true);
		expect(registry.get("explanatory")?.pinnable).toBe(true);
		expect(registry.get("reflect")).toBeDefined();
	});

	it("a project-level snippet with the same name as a bundled example overrides it", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "careful.md", "---\npinnable: true\n---\nproject-level override");
		const registry = buildSnippetRegistry(cwd);
		expect(registry.get("careful")?.raw).toBe("project-level override");
	});
});

// ============================================================================
// parseCommandArgs / substituteArgs
// ============================================================================

describe("parseCommandArgs", () => {
	it("splits on whitespace", () => {
		expect(parseCommandArgs("one two three")).toEqual(["one", "two", "three"]);
	});

	it("preserves spaces inside single or double quotes", () => {
		expect(parseCommandArgs('"hello world" foo')).toEqual(["hello world", "foo"]);
		expect(parseCommandArgs("'hello world' foo")).toEqual(["hello world", "foo"]);
	});

	it("returns an empty array for empty input", () => {
		expect(parseCommandArgs("")).toEqual([]);
		expect(parseCommandArgs("   ")).toEqual([]);
	});
});

describe("substituteArgs", () => {
	it("substitutes positional placeholders", () => {
		expect(substituteArgs("$1 and $2", ["a", "b"])).toBe("a and b");
	});

	it("leaves missing positional args as empty string", () => {
		expect(substituteArgs("$1 $2", ["only"])).toBe("only ");
	});

	it("substitutes $ARGUMENTS and $@ with all args joined", () => {
		expect(substituteArgs("run: $ARGUMENTS", ["a", "b", "c"])).toBe("run: a b c");
		expect(substituteArgs("run: $@", ["a", "b"])).toBe("run: a b");
	});

	it("supports $@[start:len] slicing", () => {
		expect(substituteArgs("$@[2]", ["a", "b", "c", "d"])).toBe("b c d");
		expect(substituteArgs("$@[2:2]", ["a", "b", "c", "d"])).toBe("b c");
	});

	it("does not re-substitute placeholder-shaped text found in argument values", () => {
		expect(substituteArgs("$1", ["$2"])).toBe("$2");
	});
});

// ============================================================================
// parseSnippetBlocks
// ============================================================================

describe("parseSnippetBlocks", () => {
	it("treats content with no tags as pure inline text", () => {
		const parsed = parseSnippetBlocks("just inline text");
		expect(parsed).toEqual({ inline: "just inline text", prepend: [], append: [], inject: [] });
	});

	it("extracts an append block and keeps surrounding text inline", () => {
		const parsed = parseSnippetBlocks("<append>\ntask body\n</append>\n\ntrailing inline");
		expect(parsed?.append).toEqual(["task body"]);
		expect(parsed?.inline).toBe("trailing inline");
	});

	it("extracts prepend, append, and inject independently", () => {
		const parsed = parseSnippetBlocks("<prepend>P</prepend>inline<append>A</append><inject>I</inject>");
		expect(parsed).toEqual({ inline: "inline", prepend: ["P"], append: ["A"], inject: ["I"] });
	});

	it("is lenient about an unclosed tag: the rest of the content becomes the block", () => {
		const parsed = parseSnippetBlocks("before<append>everything after this is the block");
		expect(parsed?.inline).toBe("before");
		expect(parsed?.append).toEqual(["everything after this is the block"]);
	});

	it("returns null on nested tags", () => {
		expect(parseSnippetBlocks("<append><prepend>nested</prepend></append>")).toBeNull();
	});

	it("returns null on a mismatched closing tag", () => {
		expect(parseSnippetBlocks("<append>content</prepend>")).toBeNull();
	});

	it("leaves a stray closing tag with no matching opener untouched, as inert text", () => {
		const parsed = parseSnippetBlocks("inline</append>more inline");
		expect(parsed?.inline).toBe("inline</append>more inline");
	});
});

// ============================================================================
// expandTriggers / assembleMessage — the end-to-end behavior the extension relies on
// ============================================================================

function registryFrom(entries: Record<string, string>): Map<string, SnippetDef> {
	const registry = new Map<string, SnippetDef>();
	for (const [name, raw] of Object.entries(entries)) registry.set(name, { name, raw, pinnable: false });
	return registry;
}

describe("expandTriggers + assembleMessage", () => {
	it("leaves an unknown trigger completely unchanged", () => {
		const registry = registryFrom({});
		const result = expandTriggers("please check ::doesnotexist for issues", registry);
		expect(assembleMessage(result)).toBe("please check ::doesnotexist for issues");
	});

	it("replaces a known trigger inline with the snippet's inline text", () => {
		const registry = registryFrom({ reflect: "\nReflect on this" });
		const result = expandTriggers("::reflect please", registry);
		expect(assembleMessage(result)).toBe("Reflect on this please");
	});

	it("splices an append block after the inline text", () => {
		const registry = registryFrom({ careful: "<append>\n<task>Think step by step.</task>\n</append>\n\nBe careful" });
		const result = expandTriggers("::careful", registry);
		expect(assembleMessage(result)).toBe("Be careful\n\n<task>Think step by step.</task>");
	});

	it("splices a prepend block before the inline text", () => {
		const registry = registryFrom({ ctx: "<prepend>PREPENDED</prepend>\ninline" });
		const result = expandTriggers("::ctx", registry);
		expect(assembleMessage(result)).toBe("PREPENDED\n\ninline");
	});

	it("composes multiple triggers in one message, preserving order", () => {
		const registry = registryFrom({
			careful: "<append>\n<task>careful-task</task>\n</append>\n\nBe careful",
			concise: "<append>\n<task>concise-task</task>\n</append>\n\nBe concise",
		});
		const result = expandTriggers("::careful and ::concise please", registry);
		expect(assembleMessage(result)).toBe(
			"Be careful and Be concise please\n\n<task>careful-task</task>\n\n<task>concise-task</task>",
		);
	});

	it("expands a snippet referenced inside another snippet's inline text", () => {
		const registry = registryFrom({
			base: "base-instruction",
			wrapper: "wrapped(::base)",
		});
		const result = expandTriggers("::wrapper", registry);
		expect(assembleMessage(result)).toBe("wrapped(base-instruction)");
	});

	it("expands a snippet referenced inside another snippet's append block and hoists its own append block", () => {
		const registry = registryFrom({
			inner: "<append>\n<task>inner-task</task>\n</append>\n\ninner-inline",
			outer: "<append>\n::inner and more\n</append>\n\nouter-inline",
		});
		const result = expandTriggers("::outer", registry);
		expect(result.append).toEqual(["inner-inline and more", "<task>inner-task</task>"]);
	});

	it("binds ::name(args) into $1/$ARGUMENTS placeholders", () => {
		const registry = registryFrom({ greet: "hello $1, args were: $ARGUMENTS" });
		const result = expandTriggers('::greet(world "a b")', registry);
		expect(assembleMessage(result)).toBe("hello world, args were: world a b");
	});

	it("ignores args for a snippet with no placeholders (current repo snippets)", () => {
		const registry = registryFrom({ reflect: "Reflect on this" });
		const result = expandTriggers("::reflect(some args)", registry);
		expect(assembleMessage(result)).toBe("Reflect on this");
	});

	it("caps circular self-reference expansion instead of hanging", () => {
		const registry = registryFrom({ loop: "I reference ::loop" });
		const result = expandTriggers("::loop", registry);
		// terminates, and the unexpandable tail keeps the literal trigger text
		expect(result.text.endsWith("::loop")).toBe(true);
		expect(result.text.length).toBeLessThan(2000);
	});

	it("deduplicates identical blocks contributed by repeated triggers", () => {
		const registry = registryFrom({ careful: "<append>\n<task>same-task</task>\n</append>\n\nBe careful" });
		const result = expandTriggers("::careful ::careful", registry);
		expect(result.append).toEqual(["<task>same-task</task>"]);
	});

	it("delivers inject blocks separately from the visible text", () => {
		const registry = registryFrom({ x: "<inject>\nhidden context\n</inject>\nvisible text" });
		const result = expandTriggers("::x", registry);
		expect(assembleMessage(result)).toBe("visible text");
		expect(result.inject).toEqual(["hidden context"]);
	});

	it("is a full no-op (no registry match) when the message has no :: at all", () => {
		const registry = registryFrom({ reflect: "Reflect on this" });
		const result = expandTriggers("no triggers here", registry);
		expect(assembleMessage(result)).toBe("no triggers here");
		expect(result.append).toEqual([]);
		expect(result.inject).toEqual([]);
	});

	it("passes bracketed content verbatim as $1/$ARGUMENTS, including parens and punctuation", () => {
		const registry = registryFrom({ reflect: "Reflect on: $1" });
		const result = expandTriggers("::reflect<<this (parenthetical) needs (nested) parens>>", registry);
		expect(assembleMessage(result)).toBe("Reflect on: this (parenthetical) needs (nested) parens");
	});

	it("passes multi-line bracketed content as a single unsplit argument", () => {
		const registry = registryFrom({ reflect: "Reflect on:\n$1" });
		const result = expandTriggers("::reflect<<line one\nline two\nline three>>", registry);
		expect(assembleMessage(result)).toBe("Reflect on:\nline one\nline two\nline three");
	});

	it("chains multiple triggers onto one shared bracketed argument", () => {
		const registry = registryFrom({ reflect: "reflect($1)", tradeoff: "tradeoff($1)" });
		const result = expandTriggers("::reflect::tradeoff<<the plan>>", registry);
		expect(assembleMessage(result)).toBe("reflect(the plan) tradeoff(the plan)");
	});

	it("allows whitespace between chained triggers and the bracket", () => {
		const registry = registryFrom({ reflect: "reflect($1)", tradeoff: "tradeoff($1)" });
		const result = expandTriggers("::reflect ::tradeoff <<the plan>>", registry);
		expect(assembleMessage(result)).toBe("reflect(the plan) tradeoff(the plan)");
	});

	it("expands known triggers and keeps unknown ones literal within a mixed chain", () => {
		const registry = registryFrom({ reflect: "reflect($1)" });
		const result = expandTriggers("::reflect::doesnotexist<<the plan>>", registry);
		expect(assembleMessage(result)).toBe("reflect(the plan) ::doesnotexist");
	});

	it("leaves the entire chain and brackets untouched when no trigger in it is known", () => {
		const registry = registryFrom({});
		const result = expandTriggers("::doesnotexist<<some text>>", registry);
		expect(assembleMessage(result)).toBe("::doesnotexist<<some text>>");
	});

	it("does not match << without an immediately preceding trigger (bit-shift, heredocs, code)", () => {
		const registry = registryFrom({ reflect: "should not fire" });
		const result = expandTriggers("cat <<EOF\nx << 2\nEOF", registry);
		expect(assembleMessage(result)).toBe("cat <<EOF\nx << 2\nEOF");
	});

	it("falls back to expanding the bare trigger when the bracket is unclosed (consistent with unclosed parens today)", () => {
		const registry = registryFrom({ reflect: "reflect($1)" });
		const result = expandTriggers("::reflect<<never closed", registry);
		expect(assembleMessage(result)).toBe("reflect()<<never closed");
	});

	it("routes append/prepend/inject blocks from a bracket-argument expansion same as (args)", () => {
		const registry = registryFrom({
			reflect: "<append>\n<task>reflect-task: $1</task>\n</append>\n\nreflecting",
		});
		const result = expandTriggers("::reflect<<the decision>>", registry);
		expect(assembleMessage(result)).toBe("reflecting\n\n<task>reflect-task: the decision</task>");
	});

	it("matches only the first >> for bracket content containing its own >> (documented limitation)", () => {
		const registry = registryFrom({ reflect: "reflect($1)" });
		const result = expandTriggers("::reflect<<Foo<Bar<Baz>>>>", registry);
		// closes at the first `>>` inside `Baz>>`, leaving a trailing `>>` as literal text
		expect(assembleMessage(result)).toBe("reflect(Foo<Bar<Baz)>>");
	});

});

// ============================================================================
// processPinTriggers / buildPinnedSystemPromptBlocks
// ============================================================================

function pinnableRegistryFrom(entries: Record<string, { raw: string; pinnable?: boolean }>): Map<string, SnippetDef> {
	const registry = new Map<string, SnippetDef>();
	for (const [name, def] of Object.entries(entries)) {
		registry.set(name, { name, raw: def.raw, pinnable: def.pinnable ?? false });
	}
	return registry;
}

describe("processPinTriggers", () => {
	it("pins a pinnable snippet and rewrites ::pin(name) to a normal one-shot trigger", () => {
		const registry = pinnableRegistryFrom({
			concise: { raw: "<append>\n<task>Be brief.</task>\n</append>\n\nBe concise", pinnable: true },
		});
		const pinned = new Map<string, string>();
		const rewritten = processPinTriggers("::pin(concise) please", registry, pinned);
		expect(rewritten).toBe("::concise please");
		expect(pinned.get("concise")).toBe("<task>Be brief.</task>");
	});

	it("leaves ::pin(name) inert when the target is not pinnable", () => {
		const registry = pinnableRegistryFrom({ verify: { raw: "Verify what you just said", pinnable: false } });
		const pinned = new Map<string, string>();
		const rewritten = processPinTriggers("::pin(verify)", registry, pinned);
		expect(rewritten).toBe("::pin(verify)");
		expect(pinned.size).toBe(0);
	});

	it("leaves ::pin(name) inert when the target is unknown", () => {
		const registry = pinnableRegistryFrom({});
		const pinned = new Map<string, string>();
		const rewritten = processPinTriggers("::pin(doesnotexist)", registry, pinned);
		expect(rewritten).toBe("::pin(doesnotexist)");
		expect(pinned.size).toBe(0);
	});

	it("supports pinning a parameterized snippet without truncating at the nested paren", () => {
		const registry = pinnableRegistryFrom({
			"max-chars": { raw: "<append>\n<task>Limit to $1 chars.</task>\n</append>\n\nLimit to $1", pinnable: true },
		});
		const pinned = new Map<string, string>();
		const rewritten = processPinTriggers("::pin(max-chars(280))", registry, pinned);
		expect(rewritten).toBe("::max-chars(280)");
		expect(pinned.get("max-chars")).toBe("<task>Limit to 280 chars.</task>");
	});

	it("composes multiple pins in one message", () => {
		const registry = pinnableRegistryFrom({
			careful: { raw: "<append>\n<task>Be careful.</task>\n</append>\n\nBe careful", pinnable: true },
			concise: { raw: "<append>\n<task>Be brief.</task>\n</append>\n\nBe concise", pinnable: true },
		});
		const pinned = new Map<string, string>();
		processPinTriggers("::pin(careful) ::pin(concise)", registry, pinned);
		expect([...pinned.keys()].sort()).toEqual(["careful", "concise"]);
	});

	it("::unpin(name) removes a pinned name and confirms, ignoring nested args", () => {
		const registry = pinnableRegistryFrom({
			"max-chars": { raw: "Limit to $1", pinnable: true },
		});
		const pinned = new Map<string, string>([["max-chars", "Limit to 280 chars."]]);
		const rewritten = processPinTriggers("::unpin(max-chars(999))", registry, pinned);
		expect(rewritten).toBe("(unpinned: max-chars)");
		expect(pinned.has("max-chars")).toBe(false);
	});

	it("::unpin(name) reports when the name was not pinned", () => {
		const registry = pinnableRegistryFrom({ concise: { raw: "Be concise", pinnable: true } });
		const pinned = new Map<string, string>();
		const rewritten = processPinTriggers("::unpin(concise)", registry, pinned);
		expect(rewritten).toBe("(concise was not pinned)");
	});

	it("::pins reports an empty state and a populated one, alphabetically sorted", () => {
		const registry = pinnableRegistryFrom({});
		const pinned = new Map<string, string>();
		expect(processPinTriggers("::pins", registry, pinned)).toBe("(no active pins)");
		pinned.set("concise", "x");
		pinned.set("careful", "y");
		expect(processPinTriggers("::pins", registry, pinned)).toBe("(pinned: careful, concise)");
	});
});

describe("buildPinnedSystemPromptBlocks", () => {
	it("returns an empty array when nothing is pinned", () => {
		expect(buildPinnedSystemPromptBlocks(new Map())).toEqual([]);
	});

	it("wraps all pinned entries in one block, in insertion order, with a scoping preamble", () => {
		const pinned = new Map([
			["careful", "Think step by step."],
			["concise", "Be brief."],
		]);
		const blocks = buildPinnedSystemPromptBlocks(pinned);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("<pinned-styles>");
		expect(blocks[0]).toContain("never WHAT you must verify, complete, or ship");
		expect(blocks[0]).toContain('<pinned-style name="careful">\nThink step by step.\n</pinned-style>');
		expect(blocks[0]).toContain('<pinned-style name="concise">\nBe brief.\n</pinned-style>');
		// insertion order: careful's block appears before concise's
		expect(blocks[0].indexOf('name="careful"')).toBeLessThan(blocks[0].indexOf('name="concise"'));
	});
});

// ============================================================================
// pinSnippetByName / buildSnippetAutocompleteItems (picker toggle support)
// ============================================================================

describe("pinSnippetByName", () => {
	it("pins a pinnable snippet by bare name, no arg substitution needed", () => {
		const registry = pinnableRegistryFrom({ careful: { raw: "<append>\n<task>Be careful.</task>\n</append>\n\nBe careful", pinnable: true } });
		const pinned = new Map<string, string>();
		expect(pinSnippetByName("careful", registry, pinned)).toBe(true);
		expect(pinned.get("careful")).toBe("<task>Be careful.</task>");
	});

	it("returns false and does not pin when the name is not pinnable", () => {
		const registry = pinnableRegistryFrom({ verify: { raw: "Verify what you just said", pinnable: false } });
		const pinned = new Map<string, string>();
		expect(pinSnippetByName("verify", registry, pinned)).toBe(false);
		expect(pinned.size).toBe(0);
	});

	it("returns false for an unknown name", () => {
		const registry = pinnableRegistryFrom({});
		const pinned = new Map<string, string>();
		expect(pinSnippetByName("doesnotexist", registry, pinned)).toBe(false);
	});

	it("resolves through aliases, case-insensitively", () => {
		const registry = new Map<string, SnippetDef>();
		const def: SnippetDef = { name: "careful", raw: "Be careful", pinnable: true };
		registry.set("careful", def);
		registry.set("safe", def);
		const pinned = new Map<string, string>();
		expect(pinSnippetByName("SAFE", registry, pinned)).toBe(true);
		expect(pinned.has("careful")).toBe(true);
	});
});

describe("buildSnippetAutocompleteItems", () => {
	it("flags pinnable and non-pinnable items correctly", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "careful.md", "---\npinnable: true\n---\nbody");
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "verify.md", "---\n---\nbody");
		const items = buildSnippetAutocompleteItems(cwd, "");
		expect(items.find((i) => i.value === "careful")?.pinnable).toBe(true);
		expect(items.find((i) => i.value === "verify")?.pinnable).toBe(false);
	});

	it("flags hasArgs when the body has an unbound placeholder", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "max-chars.md", "---\npinnable: true\n---\nLimit to $1 chars");
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "careful.md", "---\npinnable: true\n---\nBe careful, no placeholders");
		const items = buildSnippetAutocompleteItems(cwd, "");
		expect(items.find((i) => i.value === "max-chars")?.hasArgs).toBe(true);
		expect(items.find((i) => i.value === "careful")?.hasArgs).toBe(false);
	});

	it("label stays a bare ::name — no baked-in pin marker (rendering owns that dynamically)", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "careful.md", "---\npinnable: true\n---\nbody");
		const items = buildSnippetAutocompleteItems(cwd, "");
		expect(items.find((i) => i.value === "careful")?.label).toBe("::careful");
	});
});

describe("sortByPinState", () => {
	const item = (value: string, pinnable: boolean): AutocompleteItem => ({ value, label: `::${value}`, pinnable, hasArgs: false });

	it("floats currently-pinned items to the top, preserving relative order among the rest (pinnable-inactive included)", () => {
		const items = [item("verify", false), item("careful", true), item("judge", false), item("concise", true), item("drift", false)];
		const sorted = sortByPinState(items, new Set(["concise"]));
		expect(sorted.map((i) => i.value)).toEqual(["concise", "verify", "careful", "judge", "drift"]);
	});

	it("is a no-op when nothing is pinned, regardless of how many items are pinnable", () => {
		const items = [item("verify", false), item("careful", true), item("concise", true), item("drift", false)];
		expect(sortByPinState(items, new Set())).toEqual(items);
	});

	it("pinnable-but-inactive items sort inline with plain items, NOT clustered above them (the fixed UX bug)", () => {
		const items = [item("bluf", true), item("careful", true), item("drift", false), item("judge", false), item("verify", false)];
		// None pinned: order stays exactly as buildSnippetAutocompleteItems produced it —
		// pinnable items must not bubble above one-shot ones just for being pinnable.
		expect(sortByPinState(items, new Set())).toEqual(items);
	});

	it("does not mutate the input array", () => {
		const items = [item("verify", false), item("careful", true)];
		const original = [...items];
		sortByPinState(items, new Set(["careful"]));
		expect(items).toEqual(original);
	});

	it("multiple currently-pinned items all float ahead, unpinned items (pinnable or not) keep their relative order after them", () => {
		const items = [item("drift", false), item("careful", true), item("concise", true), item("bluf", true), item("verify", false)];
		const sorted = sortByPinState(items, new Set(["bluf", "concise"]));
		expect(sorted.slice(0, 2).map((i) => i.value).sort()).toEqual(["bluf", "concise"]);
		expect(sorted.slice(2).map((i) => i.value)).toEqual(["drift", "careful", "verify"]);
	});
});

describe("decodeRawKey", () => {
	it("decodes each recognized raw key sequence", () => {
		expect(decodeRawKey("\t")).toBe("tab");
		expect(decodeRawKey("\r")).toBe("enter");
		expect(decodeRawKey("\n")).toBe("enter");
		expect(decodeRawKey("\x1b[A")).toBe("up");
		expect(decodeRawKey("\x1b[B")).toBe("down");
		expect(decodeRawKey("\x1b[C")).toBe("right");
		expect(decodeRawKey("\x1b")).toBe("escape");
	});

	it("returns undefined for ordinary characters and unrecognized escape sequences", () => {
		expect(decodeRawKey("a")).toBeUndefined();
		expect(decodeRawKey("")).toBeUndefined();
		expect(decodeRawKey("\x1b[D")).toBeUndefined(); // left arrow - not a picker control key
	});
});

describe("resolveScheduler", () => {
	it("uses ctx.setTimeout when the running omp provides it", () => {
		const calls: Array<{ fn: () => void; ms: number }> = [];
		const fakeCtx = { setTimeout: (fn: () => void, ms: number) => { calls.push({ fn, ms }); return 1; } };
		const scheduler = resolveScheduler(fakeCtx as never);
		const callback = () => {};
		scheduler(callback, 30);
		expect(calls).toEqual([{ fn: callback, ms: 30 }]);
	});

	it("falls back to the global setTimeout when ctx.setTimeout is absent — the omp < 16.3.14 shape", async () => {
		const fakeCtx = {}; // no setTimeout property at all
		const scheduler = resolveScheduler(fakeCtx as never);
		const fired = await new Promise<boolean>((resolve) => {
			scheduler(() => resolve(true), 5);
		});
		expect(fired).toBe(true);
	});
});

describe("canToggleFromPicker", () => {
	it("allows pinnable items with no argument placeholder", () => {
		expect(canToggleFromPicker({ pinnable: true, hasArgs: false })).toBe(true);
	});

	it("rejects non-pinnable items", () => {
		expect(canToggleFromPicker({ pinnable: false, hasArgs: false })).toBe(false);
	});

	it("rejects pinnable items that take arguments — no value to bind from a keypress", () => {
		expect(canToggleFromPicker({ pinnable: true, hasArgs: true })).toBe(false);
	});

	it("rejects an undefined item (empty picker, out-of-range selection)", () => {
		expect(canToggleFromPicker(undefined)).toBe(false);
	});
});

describe("nextPickerIndex", () => {
	it("moves up within bounds", () => {
		expect(nextPickerIndex(2, 5, "up")).toBe(1);
	});

	it("moves down within bounds", () => {
		expect(nextPickerIndex(2, 5, "down")).toBe(3);
	});

	it("wraps from the first item to the last on up", () => {
		expect(nextPickerIndex(0, 5, "up")).toBe(4);
	});

	it("wraps from the last item to the first on down", () => {
		expect(nextPickerIndex(4, 5, "down")).toBe(0);
	});

	it("stays put with a single item in either direction", () => {
		expect(nextPickerIndex(0, 1, "up")).toBe(0);
		expect(nextPickerIndex(0, 1, "down")).toBe(0);
	});
});

describe("computeAcceptedEditorText", () => {
	it("replaces the matched trigger suffix with the accepted snippet name", () => {
		expect(computeAcceptedEditorText("hello ::car", "::car", "careful")).toBe("hello ::careful ");
	});

	it("handles the trigger at the very start of the buffer", () => {
		expect(computeAcceptedEditorText("::c", "::c", "concise")).toBe("::concise ");
	});

	it("preserves text before the trigger untouched", () => {
		expect(computeAcceptedEditorText("first line\nsecond ::j", "::j", "judge")).toBe("first line\nsecond ::judge ");
	});
});

describe("scrollPickerIntoView", () => {
	function items(n: number): AutocompleteItem[] {
		return Array.from({ length: n }, (_, i) => ({ label: `item${i}`, value: `item${i}`, pinnable: false, hasArgs: false }));
	}

	it("does not scroll when the selection is already within the visible window", () => {
		const state = { matchedSuffix: "", items: items(5), selectedIndex: 2, windowStart: 0 };
		scrollPickerIntoView(state);
		expect(state.windowStart).toBe(0);
	});

	it("scrolls up when the selection moves above the visible window", () => {
		const state = { matchedSuffix: "", items: items(20), selectedIndex: 3, windowStart: 5 };
		scrollPickerIntoView(state);
		expect(state.windowStart).toBe(3);
	});

	it("scrolls down when the selection moves below the visible window, exposing exactly MAX_PICKER_ROWS rows", () => {
		const state = { matchedSuffix: "", items: items(20), selectedIndex: 15, windowStart: 0 };
		scrollPickerIntoView(state);
		expect(state.windowStart).toBe(8); // 15 - 8 + 1
	});

	it("clamps windowStart to 0 when the whole list fits in one page (maxStart is 0)", () => {
		const state = { matchedSuffix: "", items: items(6), selectedIndex: 5, windowStart: 0 };
		scrollPickerIntoView(state);
		expect(state.windowStart).toBe(0);
	});
});

// ============================================================================
// Integration: the real bundled examples/*.md files shipped with this plugin
// ============================================================================

describe("bundled examples", () => {
	// buildSnippetRegistry resolves examples/ relative to this module's own
	// file location, so a plain empty temp dir exercises exactly the "fresh
	// install, no project snippets yet" case a marketplace install lands in.
	const registry = buildSnippetRegistry(tempDir());

	it("loads every bundled examples/*.md file without a parse failure", () => {
		const examplesDir = path.resolve(import.meta.dir, "../examples");
		const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".md"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const name = path.basename(file, ".md").toLowerCase();
			expect(registry.has(name)).toBe(true);
			expect(parseSnippetBlocks(registry.get(name)!.raw)).not.toBeNull();
		}
	});

	it("careful and concise are pinnable, reachable by their aliases", () => {
		expect(registry.get("careful")?.pinnable).toBe(true);
		expect(registry.get("safe")?.name).toBe("careful");
		expect(registry.get("concise")?.pinnable).toBe(true);
	});

	it("explanatory is pinnable, reachable by its aliases, and pins its real ★ Insight marker", () => {
		expect(registry.get("explanatory")?.pinnable).toBe(true);
		expect(registry.get("insight")?.name).toBe("explanatory");
		expect(registry.get("teach")?.name).toBe("explanatory");
		const pinned = new Map<string, string>();
		expect(pinSnippetByName("explanatory", registry, pinned)).toBe(true);
		expect(pinned.get("explanatory")).toContain("★ Insight");
	});

	it("reflect is a one-shot action, not pinnable, reachable by its aliases", () => {
		expect(registry.get("reflect")?.pinnable).toBe(false);
		expect(registry.get("reframe")?.name).toBe("reflect");
		expect(registry.get("clarify")?.name).toBe("reflect");
	});

	it("::careful ::concise compose in one message, matching the smoke-tested behavior", () => {
		const result = expandTriggers("::careful ::concise", registry);
		const assembled = assembleMessage(result);
		expect(assembled.startsWith("Be careful Be concise")).toBe(true);
		expect(assembled).toContain("Think step by step");
		expect(assembled).toContain("Answer concisely");
	});

	it("::pin(careful) then ::pin(concise) both compose in the pinned system prompt block — no forced single slot", () => {
		const pinned = new Map<string, string>();
		processPinTriggers("::pin(careful)", registry, pinned);
		processPinTriggers("::pin(concise)", registry, pinned);
		const blocks = buildPinnedSystemPromptBlocks(pinned);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('<pinned-style name="careful">');
		expect(blocks[0]).toContain('<pinned-style name="concise">');
	});

	it("::pin(reflect) is rejected since reflect is a one-shot action, not a standing style", () => {
		const pinned = new Map<string, string>();
		const rewritten = processPinTriggers("::pin(reflect)", registry, pinned);
		expect(rewritten).toBe("::pin(reflect)");
		expect(pinned.size).toBe(0);
	});
});
