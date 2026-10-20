import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import snippetsExtension from "../src/snippets.ts";
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
	extractRoleBody,
	findRoleActions,
	isInsideUnclosedTriggerArgs,
	isRoleDef,
	loadSnippetDir,
	nextPickerIndex,
	readPersistedRole,
	resolveScheduler,
	ROLE_CUSTOM_TYPE,
	ROLE_STATUS_KEY,
	parseCommandArgs,
	parseFrontmatterAliases,
	parseSnippetBlocks,
	pinSnippetByName,
	processPinTriggers,
	scrollPickerIntoView,
	QA_STATUS_KEY,
	type PinnedSnippet,
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
		const result = parseFrontmatterAliases("---\ntitle: unrelated\naliases: foo\nother: bar\n---\nbody");
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

	it("parses the raw guard value, undefined when absent", () => {
		expect(parseFrontmatterAliases("---\npinnable: true\nguard: qa\n---\nbody").guard).toBe("qa");
		expect(parseFrontmatterAliases("---\npinnable: true\n---\nbody").guard).toBeUndefined();
	});

	it("parses an optional scalar description, undefined when absent or empty", () => {
		expect(parseFrontmatterAliases("---\ndescription: Think step by step\n---\nbody").description).toBe("Think step by step");
		expect(parseFrontmatterAliases('---\ndescription: "quoted text"\n---\nbody').description).toBe("quoted text");
		expect(parseFrontmatterAliases("---\ndescription:\n---\nbody").description).toBeUndefined();
		expect(parseFrontmatterAliases("---\ndescription: ''\n---\nbody").description).toBeUndefined();
		expect(parseFrontmatterAliases("---\npinnable: true\n---\nbody").description).toBeUndefined();
	});

	it("parses description in any key order without disturbing the other fields", () => {
		const result = parseFrontmatterAliases("---\ndescription: Safe default\npinnable: true\naliases: [safe]\n---\nbody");
		expect(result.description).toBe("Safe default");
		expect(result.pinnable).toBe(true);
		expect(result.aliases).toEqual(["safe"]);
		expect(result.body).toBe("body");
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

	it("propagates a frontmatter description to the definition without touching the raw body", () => {
		const dir = tempDir();
		writeSnippet(dir, "x.md", "---\ndescription: A short line\n---\nbody text");
		const registry = loadSnippetDir(dir);
		expect(registry.get("x")?.description).toBe("A short line");
		expect(registry.get("x")?.raw).toBe("body text");
		expect(assembleMessage(expandTriggers("::x", registry))).toBe("body text");
	});

	it("leaves the definition's description unset when the key is absent or empty", () => {
		const dir = tempDir();
		writeSnippet(dir, "absent.md", "---\npinnable: true\n---\nbody");
		writeSnippet(dir, "empty.md", "---\ndescription:\n---\nbody");
		const registry = loadSnippetDir(dir);
		expect(registry.get("absent")?.description).toBeUndefined();
		expect(registry.get("empty")?.description).toBeUndefined();
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
		const def = registry.get("empty");
		expect(def?.name).toBe("empty");
		expect(def?.raw).toBe("");
		expect(def?.pinnable).toBe(false);
		expect(def?.group).toBeUndefined();
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
		const pinned = new Map<string, PinnedSnippet>();
		expect(processPinTriggers("::pins", registry, pinned)).toBe("(no active pins)");
	});

	it("permanently shadows a snippet named unpin.md for the parenthesized form — ::unpin(x) always resolves to the reserved unpin action", () => {
		const dir = tempDir();
		writeSnippet(dir, "unpin.md", "---\npinnable: true\n---\nnot the unpin action");
		writeSnippet(dir, "concise.md", "---\npinnable: true\n---\nbe concise");
		const registry = loadSnippetDir(dir);
		const pinned = new Map<string, PinnedSnippet>([["concise", { content: "be concise" }]]);
		expect(processPinTriggers("::unpin(concise)", registry, pinned)).toBe("(unpinned: concise)");
	});

	it("permanently shadows a snippet named pin.md for the parenthesized form — ::pin(x) always pins x via the reserved action, never resolves pin.md's own content", () => {
		const dir = tempDir();
		writeSnippet(dir, "pin.md", "---\npinnable: true\n---\nnot the pin action");
		writeSnippet(dir, "concise.md", "---\npinnable: true\n---\nbe concise");
		const registry = loadSnippetDir(dir);
		const pinned = new Map<string, PinnedSnippet>();
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
	it("loads project snippets from .omp/snippets", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "mine.md", "my body");
		const registry = buildSnippetRegistry(cwd, tempDir());
		expect(registry.get("mine")?.raw).toBe("my body");
	});

	it("a project with no .omp/snippets directory still gets the bundled examples", () => {
		const cwd = tempDir(); // fresh temp dir, no snippet directory at all
		const registry = buildSnippetRegistry(cwd, tempDir());
		expect(registry.get("careful")?.pinnable).toBe(true);
		expect(registry.get("concise")?.pinnable).toBe(true);
		expect(registry.get("explanatory")?.pinnable).toBe(true);
		expect(registry.get("reflect")).toBeDefined();
	});

	it("a project-level snippet with the same name as a bundled example overrides it", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "careful.md", "---\npinnable: true\n---\nproject-level override");
		const registry = buildSnippetRegistry(cwd, tempDir());
		expect(registry.get("careful")?.raw).toBe("project-level override");
	});

	it("ignores .opencode/snippet entirely — omp-native .omp/snippets is the only project tier", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "opencode-only.md", "should never load");
		writeSnippet(path.join(cwd, ".opencode", "snippet"), "careful.md", "---\n---\nshould not override bundled");
		const registry = buildSnippetRegistry(cwd, tempDir());
		expect(registry.get("opencode-only")).toBeUndefined();
		expect(registry.get("careful")?.raw).not.toContain("should not override bundled");
	});

	it("loads personal snippets from the user's agent dir, available with no project directory at all", () => {
		const userDir = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "mine.md", "personal body");
		const registry = buildSnippetRegistry(tempDir(), userDir);
		expect(registry.get("mine")?.raw).toBe("personal body");
	});

	it("a project snippet overrides a user snippet with the same name", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "shared.md", "user version");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "shared.md", "project version");
		const registry = buildSnippetRegistry(cwd, userDir);
		expect(registry.get("shared")?.raw).toBe("project version");
	});

	it("a user snippet overrides a bundled example with the same name", () => {
		const userDir = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "careful.md", "---\npinnable: true\n---\nuser override");
		const registry = buildSnippetRegistry(tempDir(), userDir);
		expect(registry.get("careful")?.raw).toBe("user override");
	});

	it("defaults userDir to the real user agent dir when not supplied", () => {
		// Exercises the default-parameter path itself; the real ~/.omp/agent
		// on the machine running this test has no snippets/ dir, so this only
		// asserts the call doesn't throw and still returns bundled examples.
		const registry = buildSnippetRegistry(tempDir());
		expect(registry.get("careful")).toBeDefined();
	});

	it("re-points a bundled alias at the user-tier override of its canonical id", () => {
		const userDir = tempDir();
		writeSnippet(
			path.join(userDir, "snippets"),
			"careful.md",
			"---\npinnable: true\ncategory: style\ndescription: USER CAREFUL\n---\nUSER-CAREFUL-BODY",
		);
		const registry = buildSnippetRegistry(tempDir(), userDir);
		const careful = registry.get("careful");

		// `safe` was declared by the bundled definition only; it now addresses
		// the effective user-tier `careful`, body and metadata included.
		expect(careful?.raw).toBe("USER-CAREFUL-BODY");
		expect(careful?.category).toBe("style");
		expect(careful?.description).toBe("USER CAREFUL");
		expect(registry.get("safe")).toBe(careful);
		// Nothing still carries the shadowed bundled body.
		expect([...registry.values()].some((def) => def.raw.includes("Ask clarifying questions"))).toBe(false);
	});

	it("follows a user-to-project override through an inherited alias and every metadata field", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeSnippet(
			path.join(userDir, "snippets"),
			"zz-eff.md",
			"---\naliases: [zz-eff-alt]\npinnable: true\ncategory: behavior\ndescription: USER EFF\n---\nUSER-EFF-BODY",
		);
		writeSnippet(
			path.join(cwd, ".omp", "snippets"),
			"zz-eff.md",
			"---\npinnable: true\ncategory: style\ndescription: PROJECT EFF\ngroup: zz-eff-group\nguard: qa\n---\nPROJECT-EFF-BODY",
		);
		const registry = buildSnippetRegistry(cwd, userDir);

		expect(registry.get("zz-eff-alt")).toBe(registry.get("zz-eff"));
		expect(registry.get("zz-eff")).toEqual({
			name: "zz-eff",
			raw: "PROJECT-EFF-BODY",
			pinnable: true,
			category: "style",
			description: "PROJECT EFF",
			group: "zz-eff-group",
			guard: "qa",
		});
		expect([...registry.values()].some((def) => def.raw === "USER-EFF-BODY")).toBe(false);
	});

	it("carries a canonical kind change through an inherited alias", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "zz-kind.md", "---\naliases: [zz-kind-alt]\n---\nUSER-ORDINARY");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-kind", "PROJECT-ROLE");
		const registry = buildSnippetRegistry(cwd, userDir);
		const def = registry.get("zz-kind");

		expect(registry.get("zz-kind-alt")).toBe(def);
		expect(isRoleDef(def)).toBe(true);
		expect(def?.raw).toBe("PROJECT-ROLE");
		expect(findRoleActions("::zz-kind-alt", registry)).toMatchObject([{ kind: "select", name: "zz-kind" }]);
		expect(expandTriggers("::zz-kind-alt", registry).text).toBe("::zz-kind-alt");
	});

	it("keeps an explicit higher-tier alias claim instead of following the bundled canonical id", () => {
		const userDir = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "zz-claimed.md", "---\naliases: [safe]\n---\nUSER-CLAIM-BODY");
		const registry = buildSnippetRegistry(tempDir(), userDir);

		expect(registry.get("safe")).toBe(registry.get("zz-claimed"));
		expect(registry.get("careful")?.raw).toContain("Be careful");
	});

	it("drops the shadowed owner's inherited aliases when a higher tier claims its canonical key", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "zz-shadow.md", "---\naliases: [zz-shadow-alt]\n---\nUSER-SHADOW-BODY");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zz-other.md", "---\naliases: [zz-shadow]\n---\nPROJECT-OTHER-BODY");
		const registry = buildSnippetRegistry(cwd, userDir);

		// `::zz-shadow` now addresses the project definition; the old owner is
		// gone with its alias rather than being redirected to an unrelated id.
		expect(registry.get("zz-shadow")).toBe(registry.get("zz-other"));
		expect(registry.get("zz-shadow-alt")).toBeUndefined();
		expect([...registry.values()].some((def) => def.raw === "USER-SHADOW-BODY")).toBe(false);
	});

	it("reports an invalid higher-tier definition instead of resurrecting the lower-tier body through its alias", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeRole(path.join(userDir, "snippets"), "zz-bad", "USER-VALID-ROLE", ["aliases: [zz-bad-alt]"]);
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-bad", "<append><prepend>nested</prepend></append>");
		const registry = buildSnippetRegistry(cwd, userDir);
		const def = registry.get("zz-bad");

		expect(registry.get("zz-bad-alt")).toBe(def);
		expect(def?.diagnostics?.length).toBeGreaterThan(0);
		expect(extractRoleBody(def!, registry)).toBeUndefined();
		// The alias resolves to the diagnosed higher definition (so selection
		// refuses there); it never falls back to the shadowed valid body.
		expect(findRoleActions("::zz-bad-alt", registry)).toMatchObject([{ kind: "select", name: "zz-bad" }]);
		expect([...registry.values()].some((entry) => entry.raw === "USER-VALID-ROLE")).toBe(false);
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

	it("expands a registered name the token grammar cannot express — the `&` in the canonical id, case-insensitively", () => {
		const registry = registryFrom({ "q&a": "qa-body" });
		expect(assembleMessage(expandTriggers("::q&a", registry))).toBe("qa-body");
		expect(assembleMessage(expandTriggers("::Q&A", registry))).toBe("qa-body");
		expect(assembleMessage(expandTriggers("::q&a and more", registry))).toBe("qa-body and more");
	});

	it("expands a registered spaced alias as one name and stops at its boundary", () => {
		const registry = registryFrom({ "q&a": "qa-body", "question and answer": "qa-body" });
		expect(assembleMessage(expandTriggers("::question and answer", registry))).toBe("qa-body");
		expect(assembleMessage(expandTriggers("::question and answer, please", registry))).toBe("qa-body, please");
		// a longer unregistered word is not a prefix match
		expect(assembleMessage(expandTriggers("::question and answers", registry))).toBe("::question and answers");
	});

	it("keeps longest-name and token-prefix boundaries across an alias pair", () => {
		const registry = registryFrom({ qa: "qa-body", "q&a": "q-and-a-body" });
		expect(assembleMessage(expandTriggers("::q&a", registry))).toBe("q-and-a-body"); // longest registered name wins
		expect(assembleMessage(expandTriggers("::QA", registry))).toBe("qa-body");
		expect(assembleMessage(expandTriggers("::qa-extra", registry))).toBe("::qa-extra");
		expect(assembleMessage(expandTriggers("::q&a-extra", registry))).toBe("::q&a-extra");
	});

	it("binds args and brackets for a `&` name, and composes it with a chain sibling", () => {
		const registry = registryFrom({ "q&a": "qa($1)", tradeoff: "tradeoff($1)" });
		expect(assembleMessage(expandTriggers("::q&a(plan)", registry))).toBe("qa(plan)");
		expect(assembleMessage(expandTriggers("::q&a<<the plan>>", registry))).toBe("qa(the plan)");
		expect(assembleMessage(expandTriggers("::q&a::tradeoff<<the plan>>", registry))).toBe("qa(the plan) tradeoff(the plan)");
	});

	it("expands a spaced alias and a `&` name nested inside another snippet's body", () => {
		const registry = registryFrom({ "q&a": "qa-body", "question and answer": "qa-body", wrapper: "wrapped(::q&a) (::question and answer)" });
		expect(assembleMessage(expandTriggers("::wrapper", registry))).toBe("wrapped(qa-body) (qa-body)");
	});

	it("expands a bracket chain nested inside a parenthesized argument before tokenizing it", () => {
		const registry = registryFrom({ outer: "[$1]", inner: "INNER" });
		// Bracket chains run first, so the argument is tokenized from expanded
		// text: without that order the tokenizer splits `<<two words>>` and the
		// argument arrives mangled (`[INNER<<two]`).
		expect(assembleMessage(expandTriggers("::outer(::inner<<two words>>)", registry))).toBe("[INNER]");
		expect(assembleMessage(expandTriggers("::outer(::inner<<two words>> tail)", registry))).toBe("[INNER]");
	});

});

// ============================================================================
// processPinTriggers / buildPinnedSystemPromptBlocks
// ============================================================================

function pinnableRegistryFrom(entries: Record<string, { raw: string; pinnable?: boolean; guard?: "qa"; group?: string }>): Map<string, SnippetDef> {
	const registry = new Map<string, SnippetDef>();
	for (const [name, def] of Object.entries(entries)) {
		registry.set(name, { name, raw: def.raw, pinnable: def.pinnable ?? false, ...(def.guard === undefined ? {} : { guard: def.guard }), ...(def.group === undefined ? {} : { group: def.group }) });
	}
	return registry;
}

describe("processPinTriggers", () => {
	it("pins a pinnable snippet and rewrites ::pin(name) to a normal one-shot trigger", () => {
		const registry = pinnableRegistryFrom({
			concise: { raw: "<append>\n<task>Be brief.</task>\n</append>\n\nBe concise", pinnable: true },
		});
		const pinned = new Map<string, PinnedSnippet>();
		const rewritten = processPinTriggers("::pin(concise) please", registry, pinned);
		expect(rewritten).toBe("::concise please");
		expect(pinned.get("concise")?.content).toBe("<task>Be brief.</task>");
	});

	it("leaves ::pin(name) inert when the target is not pinnable", () => {
		const registry = pinnableRegistryFrom({ verify: { raw: "Verify what you just said", pinnable: false } });
		const pinned = new Map<string, PinnedSnippet>();
		const rewritten = processPinTriggers("::pin(verify)", registry, pinned);
		expect(rewritten).toBe("::pin(verify)");
		expect(pinned.size).toBe(0);
	});

	it("leaves ::pin(name) inert when the target is unknown", () => {
		const registry = pinnableRegistryFrom({});
		const pinned = new Map<string, PinnedSnippet>();
		const rewritten = processPinTriggers("::pin(doesnotexist)", registry, pinned);
		expect(rewritten).toBe("::pin(doesnotexist)");
		expect(pinned.size).toBe(0);
	});

	it("supports pinning a parameterized snippet without truncating at the nested paren", () => {
		const registry = pinnableRegistryFrom({
			"max-chars": { raw: "<append>\n<task>Limit to $1 chars.</task>\n</append>\n\nLimit to $1", pinnable: true },
		});
		const pinned = new Map<string, PinnedSnippet>();
		const rewritten = processPinTriggers("::pin(max-chars(280))", registry, pinned);
		expect(rewritten).toBe("::max-chars(280)");
		expect(pinned.get("max-chars")?.content).toBe("<task>Limit to 280 chars.</task>");
	});

	it("composes multiple pins in one message", () => {
		const registry = pinnableRegistryFrom({
			careful: { raw: "<append>\n<task>Be careful.</task>\n</append>\n\nBe careful", pinnable: true },
			concise: { raw: "<append>\n<task>Be brief.</task>\n</append>\n\nBe concise", pinnable: true },
		});
		const pinned = new Map<string, PinnedSnippet>();
		processPinTriggers("::pin(careful) ::pin(concise)", registry, pinned);
		expect([...pinned.keys()].sort()).toEqual(["careful", "concise"]);
	});

	it("::unpin(name) removes a pinned name and confirms, ignoring nested args", () => {
		const registry = pinnableRegistryFrom({
			"max-chars": { raw: "Limit to $1", pinnable: true },
		});
		const pinned = new Map<string, PinnedSnippet>([["max-chars", { content: "Limit to 280 chars." }]]);
		const rewritten = processPinTriggers("::unpin(max-chars(999))", registry, pinned);
		expect(rewritten).toBe("(unpinned: max-chars)");
		expect(pinned.has("max-chars")).toBe(false);
	});

	it("::unpin(name) reports when the name was not pinned", () => {
		const registry = pinnableRegistryFrom({ concise: { raw: "Be concise", pinnable: true } });
		const pinned = new Map<string, PinnedSnippet>();
		const rewritten = processPinTriggers("::unpin(concise)", registry, pinned);
		expect(rewritten).toBe("(concise was not pinned)");
	});

	it("::pins reports an empty state and a populated one, alphabetically sorted", () => {
		const registry = pinnableRegistryFrom({});
		const pinned = new Map<string, PinnedSnippet>();
		expect(processPinTriggers("::pins", registry, pinned)).toBe("(no active pins)");
		pinned.set("concise", { content: "x" });
		pinned.set("careful", { content: "y" });
		expect(processPinTriggers("::pins", registry, pinned)).toBe("(pinned: careful, concise)");
	});

	it("addresses one pin through every name of its definition — pin by alias, unpin by canonical, and vice versa", () => {
		const registry = pinnableRegistryFrom({ "q&a": { raw: "QA-BODY", pinnable: true, guard: "qa" } });
		const def = registry.get("q&a")!;
		for (const key of ["qa", "question and answer", "ask-mode", "plan-mode", "planning"]) registry.set(key, def);
		const pinned = new Map<string, PinnedSnippet>();
		const allow = (): null => null;

		// The old alias pins the canonical name...
		expect(processPinTriggers("::pin(plan-mode)", registry, pinned, undefined, allow)).toBe("::plan-mode");
		expect([...pinned.keys()]).toEqual(["q&a"]);
		// ...and the canonical unpin releases it.
		expect(processPinTriggers("::unpin(q&a)", registry, pinned)).toBe("(unpinned: q&a)");
		expect(pinned.size).toBe(0);

		// The spaced alias pins it (case-insensitively)...
		processPinTriggers("::pin(QUESTION AND ANSWER)", registry, pinned, undefined, allow);
		expect([...pinned.keys()]).toEqual(["q&a"]);
		// ...and another alias releases it.
		expect(processPinTriggers("::unpin(ask-mode)", registry, pinned)).toBe("(unpinned: q&a)");
		expect(pinned.size).toBe(0);
	});

	it("leaves a pin inert for a name that only LOOKS like one — a longer unregistered word is not a prefix match", () => {
		const registry = pinnableRegistryFrom({ qa: { raw: "QA-BODY", pinnable: true } });
		const pinned = new Map<string, PinnedSnippet>();
		expect(processPinTriggers("::pin(qa-extra)", registry, pinned)).toBe("::pin(qa-extra)");
		expect(pinned.size).toBe(0);
	});

	it("releases a pin by its canonical name after the definition is gone — `&` and spaced names included", () => {
		const registry = pinnableRegistryFrom({
			"zz&mode": { raw: "ZZ-AMP-BODY", pinnable: true, guard: "qa" },
			"zz style": { raw: "ZZ-SPACE-BODY", pinnable: true },
		});
		const pinned = new Map<string, PinnedSnippet>();
		processPinTriggers("::pin(zz&mode)", registry, pinned, undefined, () => null);
		processPinTriggers("::pin(zz style)", registry, pinned, undefined, () => null);
		expect([...pinned.keys()].sort()).toEqual(["zz style", "zz&mode"]);

		// Both defining files are gone, so the registry no longer knows either
		// name — and its grammar token alone would read both as `zz`. Each
		// canonical name must still release its own pin, and only its own.
		const afterDelete = pinnableRegistryFrom({});
		expect(processPinTriggers("::unpin(zz&mode)", afterDelete, pinned)).toBe("(unpinned: zz&mode)");
		expect([...pinned.keys()]).toEqual(["zz style"]);
		expect(processPinTriggers("::unpin(zz style)", afterDelete, pinned)).toBe("(unpinned: zz style)");
		expect(pinned.size).toBe(0);
	});

	it("prefers an active pin's own key over a shorter surviving registered name", () => {
		// `probe&guard`'s definition is gone but an ordinary `probe` survives, so
		// the live registry resolves the body to the WRONG name: the unpin must
		// release the guarded pin it names, and leave the unrelated `probe` alone.
		const registry = pinnableRegistryFrom({ probe: { raw: "PROBE-BODY", pinnable: true } });
		const pinned = new Map<string, PinnedSnippet>([
			["probe&guard", { content: "PROBE-GUARD-BODY", guard: "qa" }],
			["probe", { content: "PROBE-BODY" }],
		]);

		expect(processPinTriggers("::unpin(probe&guard)", registry, pinned)).toBe("(unpinned: probe&guard)");
		expect([...pinned.keys()]).toEqual(["probe"]);
		expect(pinned.get("probe")?.content).toBe("PROBE-BODY");
	});

	it("never addresses a shorter live name for a `&` name the registry does not know", () => {
		const registry = pinnableRegistryFrom({ probe: { raw: "PROBE-BODY", pinnable: true } });
		const pinned = new Map<string, PinnedSnippet>([["probe", { content: "PROBE-BODY" }]]);

		// `probe&guard` is neither registered nor pinned, so the only honest
		// answers are "not pinned" and "inert" — never the live `probe`.
		expect(processPinTriggers("::unpin(probe&guard)", registry, pinned)).toBe("(probe&guard was not pinned)");
		expect(pinned.has("probe")).toBe(true);
		expect(processPinTriggers("::pin(probe&guard)", registry, pinned)).toBe("::pin(probe&guard)");
		expect([...pinned.keys()]).toEqual(["probe"]);
	});
});

describe("buildPinnedSystemPromptBlocks", () => {
	it("returns an empty array when nothing is pinned", () => {
		expect(buildPinnedSystemPromptBlocks(new Map())).toEqual([]);
	});

	it("wraps all pinned entries in one block, in insertion order, with a scoping preamble", () => {
		const pinned = new Map([
			["careful", { content: "Think step by step." }],
			["concise", { content: "Be brief." }],
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
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("careful", registry, pinned).status).toBe("pinned");
		expect(pinned.get("careful")?.content).toBe("<task>Be careful.</task>");
	});

	it("reports not-pinnable and does not pin when the name is not pinnable", () => {
		const registry = pinnableRegistryFrom({ verify: { raw: "Verify what you just said", pinnable: false } });
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("verify", registry, pinned).status).toBe("not-pinnable");
		expect(pinned.size).toBe(0);
	});

	it("reports unknown for a name with no definition", () => {
		const registry = pinnableRegistryFrom({});
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("doesnotexist", registry, pinned).status).toBe("unknown");
	});

	it("resolves through aliases, case-insensitively", () => {
		const registry = new Map<string, SnippetDef>();
		const def: SnippetDef = { name: "careful", raw: "Be careful", pinnable: true };
		registry.set("careful", def);
		registry.set("safe", def);
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("SAFE", registry, pinned).status).toBe("pinned");
		expect(pinned.has("careful")).toBe(true);
	});
});

describe("buildSnippetAutocompleteItems", () => {
	it("flags pinnable and non-pinnable items correctly", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "careful.md", "---\npinnable: true\n---\nbody");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "verify.md", "---\n---\nbody");
		const items = buildSnippetAutocompleteItems(cwd, "");
		expect(items.find((i) => i.value === "careful")?.pinnable).toBe(true);
		expect(items.find((i) => i.value === "verify")?.pinnable).toBe(false);
	});

	it("label stays a bare ::name — no baked-in pin marker (rendering owns that dynamically)", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "careful.md", "---\npinnable: true\n---\nbody");
		const items = buildSnippetAutocompleteItems(cwd, "");
		expect(items.find((i) => i.value === "careful")?.label).toBe("::careful");
	});

	it("marks a role row non-pinnable and non-argument-taking, with the authoritative Role category", () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-role", "ROLE-BODY");
		const items = buildSnippetAutocompleteItems(cwd, "zz-role");
		const role = items.find((i) => i.value === "zz-role");
		expect(role?.isRole).toBe(true);
		expect(role?.pinnable).toBe(false);
		expect(role?.category).toBe("Role");
	});

	it("uses the authored description in place of the body preview", () => {
		const cwd = tempDir();
		writeSnippet(
			path.join(cwd, ".omp", "snippets"),
			"explain.md",
			"---\ndescription: 'Explain the change and its tradeoffs'\n---\nTHIS BODY TEXT MUST NOT REACH THE ROW",
		);
		const item = buildSnippetAutocompleteItems(cwd, "explain").find((i) => i.value === "explain");
		expect(item?.description).toBe("Explain the change and its tradeoffs");
	});

	it("falls back to a one-line body preview when no description is authored", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "preview.md", "<append>\n<task>Keep it short.</task>\n</append>\n\nSecond   paragraph here");
		const item = buildSnippetAutocompleteItems(cwd, "preview").find((i) => i.value === "preview");
		expect(item?.description).toBe("Keep it short. Second paragraph here");
	});

	it("caps both the authored description and the fallback preview at 60 code points, ending on a word boundary", () => {
		const cwd = tempDir();
		const authored = "longword ".repeat(20);
		const fallback = "alpha ".repeat(30);
		writeSnippet(path.join(cwd, ".omp", "snippets"), "authored.md", `---\ndescription: ${authored}\n---\nbody`);
		writeSnippet(path.join(cwd, ".omp", "snippets"), "fallback.md", fallback);
		for (const [name, source] of [
			["authored", authored],
			["fallback", fallback],
		] as const) {
			const description = buildSnippetAutocompleteItems(cwd, name).find((i) => i.value === name)?.description;
			expect(description).toBeTruthy();
			if (typeof description !== "string") throw new Error(`${name} has no description`);
			expect([...description].length).toBeLessThanOrEqual(60);
			expect(description.endsWith("…")).toBe(true);
			expect(description).not.toMatch(/[\r\n]| {2}/);
			// The cut is a prefix of the source that stops exactly at a space:
			// a preview ending mid-token would put the next source character
			// inside the word.
			const kept = description.slice(0, -1);
			expect(source.startsWith(kept)).toBe(true);
			expect(source[kept.length]).toBe(" ");
		}
	});

	it("leaves the description undefined when the body has no text and no description was authored", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "silent.md", "---\ndescription:\n---\n");
		const item = buildSnippetAutocompleteItems(cwd, "silent").find((i) => i.value === "silent");
		expect(item?.description).toBeUndefined();
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
	it("allows pinnable items, including parameterized ones", () => {
		expect(canToggleFromPicker({ pinnable: true })).toBe(true);
	});

	it("rejects non-pinnable items", () => {
		expect(canToggleFromPicker({ pinnable: false })).toBe(false);
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

describe("isInsideUnclosedTriggerArgs", () => {
	it("is false for plain text with no triggers", () => {
		expect(isInsideUnclosedTriggerArgs("just talking about stuff")).toBe(false);
	});

	it("is false once a paren-arg trigger is closed", () => {
		expect(isInsideUnclosedTriggerArgs("::reflect(closed) more text")).toBe(false);
	});

	it("is true while a paren-arg trigger is still open", () => {
		expect(isInsideUnclosedTriggerArgs("::reflect(still typing")).toBe(true);
	});

	it("is true while typing a nested trigger inside an open paren", () => {
		expect(isInsideUnclosedTriggerArgs("::reflect(please run ::car")).toBe(true);
	});

	it("is false once a bracket-arg trigger is closed", () => {
		expect(isInsideUnclosedTriggerArgs("::reflect<<closed>> more text")).toBe(false);
	});

	it("is true while a bracket-arg trigger is still open", () => {
		expect(isInsideUnclosedTriggerArgs("::reflect<<still typing")).toBe(true);
	});

	it("is true while typing a nested trigger inside an open bracket chain", () => {
		expect(isInsideUnclosedTriggerArgs("::a::b<<please run ::car")).toBe(true);
	});

	it("is false for a bare :: with no open span at all", () => {
		expect(isInsideUnclosedTriggerArgs("::reflect")).toBe(false);
	});

	it("only looks at the last open span, ignoring earlier closed ones", () => {
		expect(isInsideUnclosedTriggerArgs("::a(closed) ::b<<also closed>> ::c(")).toBe(true);
		expect(isInsideUnclosedTriggerArgs("::a(closed) ::b<<also closed>> plain text")).toBe(false);
	});

	it("recognizes an argument span opened by a name the token class cannot type — `&` and a spaced alias", () => {
		expect(isInsideUnclosedTriggerArgs("::q&a(still typing")).toBe(true);
		expect(isInsideUnclosedTriggerArgs("::q&a(closed)")).toBe(false);
		expect(isInsideUnclosedTriggerArgs("::question and answer<<still typing")).toBe(true);
		expect(isInsideUnclosedTriggerArgs("::question and answer<<closed>>")).toBe(false);
		// The nested case the mask exists for: a later trigger must stay hidden
		// behind the span a `&` name opened.
		expect(isInsideUnclosedTriggerArgs("::q&a(please run ::car")).toBe(true);
	});
});

describe("scrollPickerIntoView", () => {
	function items(n: number): AutocompleteItem[] {
		return Array.from({ length: n }, (_, i) => ({ label: `item${i}`, value: `item${i}`, pinnable: false }));
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
	const registry = buildSnippetRegistry(tempDir(), tempDir());

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

	it("reflect is a one-shot action, not pinnable, reachable by its aliases", () => {
		expect(registry.get("reflect")?.pinnable).toBe(false);
		expect(registry.get("reframe")?.name).toBe("reflect");
		expect(registry.get("clarify")?.name).toBe("reflect");
	});

	it("create-snippet is a one-shot helper whose body reaches the model untouched by the parser", () => {
		const def = registry.get("create-snippet");
		expect(def).toBeDefined();
		expect(registry.get("new-snippet")).toBe(def);
		expect(def?.pinnable).toBe(false);
		expect(isRoleDef(def)).toBe(false);
		expect(def?.diagnostics).toBeUndefined();

		// A trigger, argument placeholder, or extra block tag in the body would
		// be expanded, blanked, or break the block parse instead of being read.
		const parsed = parseSnippetBlocks(def!.raw);
		expect(parsed?.append).toHaveLength(1);
		expect(parsed?.prepend).toHaveLength(0);
		expect(parsed?.inject).toHaveLength(0);

		const result = expandTriggers("::new-snippet a snippet for release notes", registry);
		expect(result.append).toEqual(parsed!.append);
		expect(result.prepend).toEqual([]);
		expect(result.inject).toEqual([]);
		expect(result.text).toContain("a snippet for release notes");

		const pinned = new Map<string, PinnedSnippet>();
		expect(processPinTriggers("::pin(create-snippet)", registry, pinned)).toBe("::pin(create-snippet)");
		expect(pinned.size).toBe(0);
	});



	it("::pin(careful) then ::pin(concise) both compose in the pinned system prompt block — no forced single slot", () => {
		const pinned = new Map<string, PinnedSnippet>();
		processPinTriggers("::pin(careful)", registry, pinned);
		processPinTriggers("::pin(concise)", registry, pinned);
		const blocks = buildPinnedSystemPromptBlocks(pinned);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('<pinned-style name="careful">');
		expect(blocks[0]).toContain('<pinned-style name="concise">');
	});

	it("::pin(reflect) is rejected since reflect is a one-shot action, not a standing style", () => {
		const pinned = new Map<string, PinnedSnippet>();
		const rewritten = processPinTriggers("::pin(reflect)", registry, pinned);
		expect(rewritten).toBe("::pin(reflect)");
		expect(pinned.size).toBe(0);
	});
});

// ============================================================================
// Extension callback harness
//
// Role and pin behavior is exercised through the real default-export factory
// with a fake ExtensionAPI/ExtensionContext, so every assertion observes what
// a live omp session observes — a per-turn system-prompt block, a
// `ui.setStatus` indicator, an appended session custom entry, the rendered
// picker widget — never module internals. The callbacks dispatched here are
// the ones the host actually emits: session_start, input,
// before_agent_start, tool_call, before_subagent_spawn, session_switch,
// session_branch, session_tree, session_shutdown.
// ============================================================================

interface BranchEntry {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
}

interface RoleRecord {
	version: number;
	role: { name: string; body: string } | null;
}

function roleRecordEntry(id: string, data: unknown, parentId: string | null = null): BranchEntry {
	return { type: "custom", id, parentId, customType: ROLE_CUSTOM_TYPE, data };
}

function roleSnapshot(name: string, body: string): RoleRecord {
	return { version: 1, role: { name, body } };
}

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

interface HarnessOptions {
	/** `null` models a host that exposes no documented agent identity at all. */
	agentKind?: "main" | "sub" | null;
	branch?: BranchEntry[];
	/** Global (all-branches) entry history; defaults to the active branch. */
	entries?: BranchEntry[];
	/** Global approval mode exposed on the fake ctx (`yolo`, …) — deliberately
	 *  hostile context, so a test can show the QA guard blocks independently
	 *  of whatever the host's approval config says. */
	approvalMode?: string;
	/** Runtime gate for QA pin activation: `false` models a mid-turn agent,
	 *  a non-null `jobs` snapshot with `running` entries models owned
	 *  in-flight work, and `runtimeApis: false` models a host that exposes
	 *  neither `isIdle` nor `getAsyncJobSnapshot`. */
	idle?: boolean;
	jobs?: { running: Array<{ id: string; label?: string }> } | null;
	runtimeApis?: boolean;
}

/** SGR the harness paints the theme tokens the picker reads with: the basic
 *  colours the host's own span parser reverse-maps (`32` → `success`, `35` →
 *  `accent`, `90` → `dim`), so a token the picker asks for comes back as the
 *  escape a live terminal would paint rather than vanishing. */
const ACCENT_SGR = "\x1b[35m";
const SUCCESS_SGR = "\x1b[32m";
const HARNESS_THEME_SGR: Record<string, string> = {
	accent: ACCENT_SGR,
	success: SUCCESS_SGR,
	warning: "\x1b[33m",
	muted: "\x1b[90m",
};
/** What the stub closes a coloured run with: `39` is the terminal's own
 *  foreground, the state every unstyled run stays in. */
const THEME_FG_RESET = "\x1b[39m";

/** The theme handle the host passes to a widget factory. The picker factory
 *  reads only `fg`, and this stub resolves each token it asks for to a real
 *  SGR colour (above), so terminal rows carry exactly what the host renders —
 *  a category colour that went missing would otherwise read as a correctly
 *  plain row. A token the stub does not know stays unstyled. */
interface WidgetTheme {
	fg(name: string, text: string): string;
}

/** The native (Tern) node shape the picker describes, declared locally: the
 *  widget's own node types are module-private. Only the fields an assertion
 *  reads — a `text` node's `spans`/`text`, an `ansi` node's raw `text`, the
 *  `min`/`max` box extent a label segment carries, and the `c` children of a
 *  `col`/`row`. */
interface NativeNode {
	readonly k: string;
	readonly p?: {
		readonly text?: string;
		readonly spans?: readonly { readonly t: string; readonly s?: string }[];
		readonly min?: { readonly w?: string };
		readonly max?: { readonly w?: string };
	};
	readonly c?: readonly NativeNode[];
}

/** The renderable the host accepts back from a widget factory. Only the
 *  surfaces the harness drives are modelled: `render` at the host's widget
 *  width, and `describe` for the native surface the host prefers when the
 *  terminal supports the `ansi` node (`null` = fall back to `render` rows). */
interface WidgetComponent {
	render(width: number): readonly string[];
	describe?(cx: { supports(kind: "ansi"): boolean }): NativeNode | null;
	invalidate?(): void;
}

/** A `setWidget` factory: the host invokes it with the live UI context and
 *  theme, then renders the returned component. (The host's declared factory
 *  type names the first argument `tui`, but the host passes `ctx.ui` — see
 *  `#createHookWidget` in pi-coding-agent's extension-ui-controller.) That
 *  argument is deliberately unmodelled (`unknown`) here: the picker factory
 *  never reads it, so the harness passes the same `ui` stub the extension
 *  already holds. */
type WidgetFactory = (ui: unknown, theme: WidgetTheme) => WidgetComponent;

/** What the extension may hand to `setWidget`: legacy plain rows, or a
 *  factory the host renders into rows. */
type WidgetContent = string[] | WidgetFactory | undefined;

/** Host widget render width. The host lays widgets out at the terminal width;
 *  the harness pins the width its rows are captured at. */
const WIDGET_RENDER_WIDTH = 120;

interface SnippetsHarness {
	readonly appended: Array<{ customType: string; data: unknown }>;
	readonly statuses: Map<string, string | undefined>;
	readonly notices: Array<{ message: string; type?: string }>;
	/** Rows the host would paint, keyed by widget key: plain rows are stored
	 *  as-is, factory content is rendered at {@link WIDGET_RENDER_WIDTH}. */
	readonly widgets: Map<string, string[] | undefined>;
	/** Every `setWidget` call in order — a write log, so a repaint can be told
	 *  apart from the write that merely cleared the widget. Stores the raw
	 *  content (rows, factory, or `undefined`), not the rendered rows. */
	readonly widgetWrites: Array<{ key: string; content: WidgetContent }>;
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	input(text: string): Promise<{ text?: string } | undefined>;
	beforeAgentStart(systemPrompt: string[]): Promise<{ systemPrompt?: string[]; message?: { content?: unknown } } | undefined>;
	setBranch(entries: BranchEntry[]): void;
	setEditorText(text: string): void;
	editorText(): string;
	pressKey(data: string): { consume?: boolean } | undefined;
	/** Replace what the fake host reports at activation time. Deliberately
	 *  `unknown`: the gate must fail closed on states a real host never
	 *  returns (an `undefined` snapshot, a non-boolean idle), not only on the
	 *  documented `{ running } | null` / boolean shapes. */
	setIdle(idle: unknown): void;
	setJobs(jobs: unknown): void;
	removeRuntimeApis(): void;
	/** One `tool_call` dispatch through the registered handler(s). `input` is
	 *  deliberately `unknown`: adversarial shapes are part of the matrix. */
	toolCall(toolName: string, input: unknown): Promise<{ block?: boolean; reason?: string } | undefined>;
	/** One `before_subagent_spawn` dispatch through the registered handler(s). */
	beforeSubagentSpawn(payload: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
	/** The raw-input handler currently installed, so a test can hold the one a
	 *  later lifecycle event disposes. */
	capturedKeyHandler(): ((data: string) => { consume?: boolean } | undefined) | undefined;
	pendingTimers(): number;
	flushTimers(): void;
	/** Render the most recently written widget at an arbitrary terminal width,
	 *  through the same UI/theme handles the host passes to the factory — so a
	 *  test can measure what the host would actually paint at that width
	 *  instead of only the harness's pinned capture width. `undefined` when the
	 *  last write was a clear or a plain row array. */
	renderWidget(width: number): readonly string[] | undefined;
	/** Describe the most recently written widget natively (the Tern surface a
	 *  host prefers when the terminal supports `ansi`), through the same
	 *  handles the host passes to the factory. `undefined` when the last write
	 *  was a clear or a plain row array, `null` when the widget describes
	 *  nothing natively. */
	describeWidget(): NativeNode | null | undefined;
}

function createSnippetsHarness(cwd: string, options: HarnessOptions = {}): SnippetsHarness {
	const handlers = new Map<string, ExtensionHandler[]>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const statuses = new Map<string, string | undefined>();
	const notices: Array<{ message: string; type?: string }> = [];
	const widgets = new Map<string, string[] | undefined>();
	const widgetWrites: Array<{ key: string; content: WidgetContent }> = [];
	const timers: Array<() => void> = [];
	// The one theme handle the harness exposes on `ui` and passes to widget
	// factories, so extension styling and factory invocation resolve against
	// the same stub.
	const theme: WidgetTheme = {
		fg: (name: string, text: string) => {
			const sgr = HARNESS_THEME_SGR[name];
			return sgr === undefined ? text : `${sgr}${text}${THEME_FG_RESET}`;
		},
	};
	let branch: BranchEntry[] = options.branch ?? [];
	let entries: BranchEntry[] = options.entries ?? branch;
	let editor = "";
	let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let idle: unknown = options.idle ?? true;
	let jobs: unknown = options.jobs ?? null;

	const pi = {
		setLabel() {},
		on(event: string, handler: ExtensionHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		appendEntry(customType: string, data?: unknown) {
			appended.push({ customType, data });
		},
		sendMessage() {},
		sendUserMessage() {},
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	};

	// Extracted so a widget factory can be invoked with the same UI handle the
	// host passes (`ctx.ui`), mirroring pi-coding-agent's `#createHookWidget`.
	// `widgetUi` is filled in right after `ui` is built: the object cannot name
	// itself in its own initializer (that would be a circular inference).
	let widgetUi: unknown;
	const ui = {
		setStatus: (key: string, text: string | undefined) => {
			statuses.set(key, text);
		},
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notices.push({ message, type });
		},
		setWidget: (key: string, content: WidgetContent) => {
			// The host renders factory content into rows itself; mirror that
			// here so behavior tests read what a live session paints.
			const rows = Array.isArray(content)
				? content.slice()
				: content === undefined
					? undefined
					: [...content(widgetUi, theme).render(WIDGET_RENDER_WIDTH)];
			widgets.set(key, rows);
			widgetWrites.push({ key, content });
		},
		theme,
		onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
			terminalHandler = handler;
			return () => {
				terminalHandler = undefined;
			};
		},
		getEditorText: () => editor,
		setEditorText: (text: string) => {
			editor = text;
		},
	};
	widgetUi = ui;

	const ctx: Record<string, unknown> = {
		cwd,
		mode: "tui",
		hasUI: true,
		agent:
			options.agentKind === null
				? undefined
				: { kind: options.agentKind ?? "main", id: "agent-1", name: "main", depth: 0 },
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => entries,
			getLeafId: () => branch.at(-1)?.id ?? null,
			getEntry: (id: string) => branch.find((entry) => entry.id === id),
		},
		setTimeout: (fn: () => void) => {
			timers.push(fn);
			return timers.length;
		},
		...(options.approvalMode === undefined ? {} : { tools: { approvalMode: options.approvalMode } }),
		...(options.runtimeApis === false
			? {}
			: {
					isIdle: () => idle,
					getAsyncJobSnapshot: () => jobs,
				}),
		ui,
	};

	snippetsExtension(pi as never);

	const emit = async (event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
		return results;
	};

	return {
		appended,
		statuses,
		notices,
		widgets,
		widgetWrites,
		emit,
		async input(text) {
			const results = await emit("input", { text, source: "interactive" });
			return results[results.length - 1] as { text?: string } | undefined;
		},
		async beforeAgentStart(systemPrompt) {
			const results = await emit("before_agent_start", { prompt: "test prompt", systemPrompt });
			return results[results.length - 1] as { systemPrompt?: string[]; message?: { content?: unknown } } | undefined;
		},
		setBranch(next) {
			branch = next;
		},
		setIdle(next) {
			idle = next;
		},
		setJobs(next) {
			jobs = next;
		},
		removeRuntimeApis() {
			delete ctx["isIdle"];
			delete ctx["getAsyncJobSnapshot"];
		},
		async toolCall(toolName, input) {
			const results = await emit("tool_call", { toolCallId: "call-1", toolName, input });
			return results[0] as { block?: boolean; reason?: string } | undefined;
		},
		async beforeSubagentSpawn(payload) {
			const results = await emit("before_subagent_spawn", payload);
			return results[0] as { block?: boolean; reason?: string } | undefined;
		},
		setEditorText(text) {
			editor = text;
		},
		editorText() {
			return editor;
		},
		pressKey(data) {
			return terminalHandler?.(data);
		},
		capturedKeyHandler() {
			return terminalHandler;
		},
		pendingTimers() {
			return timers.length;
		},
		flushTimers() {
			while (timers.length > 0) timers.shift()!();
		},
		renderWidget(width) {
			const content = widgetWrites.at(-1)?.content;
			if (typeof content !== "function") return undefined;
			return content(widgetUi, theme).render(width);
		},
		describeWidget() {
			const content = widgetWrites.at(-1)?.content;
			if (typeof content !== "function") return undefined;
			return content(widgetUi, theme).describe?.({ supports: () => true }) ?? null;
		},
	};
}

function writeRole(dir: string, name: string, body: string, extraFrontmatter: string[] = []): void {
	writeSnippet(dir, `${name}.md`, ["---", "kind: role", ...extraFrontmatter, "---", body].join("\n"));
}

function roleAppends(harness: SnippetsHarness): Array<{ customType: string; data: unknown }> {
	return harness.appended.filter((entry) => entry.customType === ROLE_CUSTOM_TYPE);
}

function lastRoleRecord(harness: SnippetsHarness): RoleRecord | undefined {
	return roleAppends(harness).at(-1)?.data as RoleRecord | undefined;
}

function promptText(result: { systemPrompt?: string[] } | undefined): string {
	return result?.systemPrompt?.join("\n\n") ?? "";
}

function pinnedStylesBlock(text: string): string {
	return /<pinned-styles>[\s\S]*?<\/pinned-styles>/.exec(text)?.[0] ?? "";
}

function roleStatusText(harness: SnippetsHarness): string {
	return harness.statuses.get(ROLE_STATUS_KEY) ?? "";
}

/** Concatenated picker rows currently rendered by the extension's widget. */
function pickerRows(harness: SnippetsHarness): string {
	return [...harness.widgets.values()]
		.filter((content): content is string[] => Array.isArray(content))
		.flat()
		.join("\n");
}

/** Order in which the given snippet names appear in the rendered picker.
 *  Each name is matched as a whole `::name` token, so a longer sibling
 *  (`::zzq-style`) can never stand in for a shorter one (`::zzq`). Every name
 *  must actually be present: sorting an absent row as `-1` would place it
 *  first and silently satisfy any expectation that listed it first — exactly
 *  the "pinnables cluster above" claim these tests exist to make — so a
 *  missing row throws instead. */
function pickerOrder(harness: SnippetsHarness, names: string[]): string[] {
	const rows = pickerRows(harness);
	const tokenIndex = (name: string): number => {
		const index = new RegExp(`::${name}(?![\\w-])`).exec(rows)?.index;
		if (index === undefined) throw new Error(`picker row ::${name} is missing — ordering cannot be asserted`);
		return index;
	};
	return [...names].sort((a, b) => tokenIndex(a) - tokenIndex(b));
}

/** The footer hint line the picker renders under the highlighted row. */
function pickerHint(harness: SnippetsHarness): string {
	const lines = [...harness.widgets.values()]
		.filter((content): content is string[] => Array.isArray(content))
		.flat();
	return lines.at(-1) ?? "";
}

// ============================================================================
// Roles — selection, refresh, clear (through the extension callbacks)
// ============================================================================

describe("roles — selection, refresh, clear", () => {
	it("activates a role from a bare ::name submission and injects its body after the untouched native prompt", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).toContain("ROLE-BODY-ALPHA");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zz-alpha");
	});

	it("keeps the role body out of the submitted message text (short confirmation instead)", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const submitted = await harness.input("::zz-alpha");
		expect(submitted?.text ?? "").not.toContain("ROLE-BODY-ALPHA");
		expect(submitted?.text ?? "").toContain("zz-alpha");
	});

	it("does not select a role written inside a spaced ordinary name's argument span", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		// The shipped spaced name (`q&a`, reachable as `question and answer`) and a
		// real role: the `(` belongs to the whole spaced name, so the reference
		// inside it is an argument, not a top-level role trigger.
		writeSnippet(dir, "q&a.md", fs.readFileSync(path.join(path.resolve(import.meta.dir, "../examples"), "q&a.md"), "utf8"));
		writeRole(dir, "zz-review", "ZZ-REVIEW-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::question and answer(::zz-review)");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(roleStatusText(harness)).toBe("");

		// The masking is the enclosing spaced head's doing, not a broken role: the
		// same reference selects normally on its own.
		await harness.input("::zz-review");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zz-review");
	});

	it("selects a role through a spaced alias and rewrites the whole head", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA", ["aliases: [zz spaced role]"]);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const submitted = await harness.input("::zz spaced role");
		// The alias is one head: its confirmation replaces all of it, leaving no
		// fragment of the name behind in the submitted text.
		expect(submitted?.text).toBe("(role: zz-alpha)");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zz-alpha");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");
	});

	it("re-selecting the same role refreshes it instead of toggling it off", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-alpha");
		await harness.input("::zz-alpha");
		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).toContain("ROLE-BODY-ALPHA");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zz-alpha");
	});

	it("switching roles replaces the previous body with the newly selected one", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-beta", "ROLE-BODY-BETA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-alpha");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");

		await harness.input("::zz-beta");
		const switched = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(switched)).toContain("ROLE-BODY-BETA");
		expect(promptText(switched)).not.toContain("ROLE-BODY-ALPHA");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zz-beta");
	});

	it("resolves a role alias to its canonical role", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA", ["aliases: [zz-alt]"]);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-alt");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zz-alpha");
	});

	it("::unrole clears the active role, drops its body from the prompt, and persists a null tombstone", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-alpha");
		expect(roleStatusText(harness)).toContain("zz-alpha");

		await harness.input("::unrole");
		const cleared = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(cleared)).not.toContain("ROLE-BODY-ALPHA");
		expect(cleared?.systemPrompt ?? ["NATIVE-BASE"]).toEqual(["NATIVE-BASE"]);
		expect(lastRoleRecord(harness)?.role).toBeNull();
		expect(lastRoleRecord(harness)?.version).toBe(1);
		expect(roleStatusText(harness)).not.toContain("zz-alpha");
	});

	it("::unrole on a session with no active role is a harmless no-op", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::unrole");
		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).not.toContain("ROLE-BODY-ALPHA");
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("::unrole stays the reserved clear even when a snippet named unrole.md exists", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA");
		writeSnippet(dir, "unrole.md", "UNROLE-SNIPPET-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		await harness.input("::unrole");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		expect(lastRoleRecord(harness)?.role).toBeNull();
	});

	it("honours the reserved triggers case-insensitively and leaves pin words to the pin pass", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(dir, "pins", "PINS-ROLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		// `::Pins` belongs to the pin pass: it reports pin state and never selects
		// the role that happens to be named `pins`.
		const pinsResult = await harness.input("::Pins");
		expect(pinsResult?.text).toContain("no active pins");
		const afterPins = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(afterPins)).toContain("ROLE-BODY-ALPHA");
		expect(promptText(afterPins)).not.toContain("PINS-ROLE-BODY");

		// The clear trigger is reserved case-insensitively as well.
		await harness.input("::UNROLE");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		expect(lastRoleRecord(harness)?.role).toBeNull();
		expect(roleAppends(harness)).toHaveLength(2); // selection + tombstone; ::Pins wrote nothing
	});

	it("refuses a reserved canonical role name reached through an alias — no activation, no record, no injection", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(dir, "pins", "PINS-ROLE-BODY", ["aliases: [captain]"]);
		writeSnippet(dir, "zz-style.md", "---\npinnable: true\n---\nZZ-STYLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// A valid role and a valid style pin are active first, so the refusals
		// below are shown to leave both untouched instead of merely failing alone.
		await harness.input("::zz-alpha");
		await harness.input("::pin(zz-style)");
		const before = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(before)).toContain("ROLE-BODY-ALPHA");
		expect(pinnedStylesBlock(promptText(before))).toContain("ZZ-STYLE-BODY");
		const recordsBefore = roleAppends(harness).length;

		// The alias is neither a role action, nor a pin trigger, nor an ordinary
		// trigger: nothing rewrites or expands it, so the handler reports "no
		// change" for both the lower- and upper-case spelling.
		expect(await harness.input("::captain")).toBeUndefined();
		expect(await harness.input("::CAPTAIN")).toBeUndefined();

		const after = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(after)).toContain("ROLE-BODY-ALPHA");
		expect(promptText(after)).not.toContain("PINS-ROLE-BODY");
		expect(pinnedStylesBlock(promptText(after))).toBe(pinnedStylesBlock(promptText(before)));
		expect(roleAppends(harness)).toHaveLength(recordsBefore);
		expect(roleStatusText(harness)).toContain("zz-alpha");
	});

	it("does not let a stray << in the message hide a later role selection", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const submitted = await harness.input("Discuss x << 2, then ::zz-alpha");
		expect(submitted?.text).toContain("zz-alpha");
		expect(roleAppends(harness)).toHaveLength(1);
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");
	});

	it("writes no role record for ordinary turns", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-alpha");
		const afterSelection = roleAppends(harness).length;
		await harness.input("just a normal message");
		expect(roleAppends(harness).length).toBe(afterSelection);
	});
});

// ============================================================================
// Roles — per-turn prompt composition, pin/style coexistence
// ============================================================================

describe("roles — prompt composition and style pins", () => {
	it("keeps an active BLUF-style pin byte-identical through role selection, switch, and clear", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-beta", "ROLE-BODY-BETA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(bluf)");

		const baseline = pinnedStylesBlock(promptText(await harness.beforeAgentStart(["NATIVE-BASE"])));
		expect(baseline).toContain("bluf");

		await harness.input("::zz-alpha");
		const withRole = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(pinnedStylesBlock(promptText(withRole))).toBe(baseline);
		expect(promptText(withRole)).toContain("ROLE-BODY-ALPHA");
		expect(pinnedStylesBlock(promptText(withRole))).not.toContain("ROLE-BODY-ALPHA");

		await harness.input("::zz-beta");
		expect(pinnedStylesBlock(promptText(await harness.beforeAgentStart(["NATIVE-BASE"])))).toBe(baseline);

		await harness.input("::unrole");
		const cleared = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(pinnedStylesBlock(promptText(cleared))).toBe(baseline);
		expect(promptText(cleared)).not.toContain("ROLE-BODY");
	});

	it("delivers the role body in a dedicated block, not merged into the native base prompt", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		const base = ["NATIVE-ONE", "NATIVE-TWO"];
		const result = await harness.beforeAgentStart(base);
		expect(result?.systemPrompt?.slice(0, base.length)).toEqual(base);
		expect(result?.systemPrompt?.some((block) => block.includes("ROLE-BODY-ALPHA"))).toBe(true);
	});

	it("injects the role body on every turn, not only the turn that selected it", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		await harness.input("an ordinary follow-up turn");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");
	});
});

// ============================================================================
// Roles — main/sub identity gating
// ============================================================================

describe("roles — main/sub identity gating", () => {
	it("does not activate roles in a sub agent session", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, { agentKind: "sub" });
		await harness.emit("session_start");

		await harness.input("::zz-alpha");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("keeps a sub agent's role attempt from leaking into the main session", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-beta", "ROLE-BODY-BETA");
		const main = createSnippetsHarness(cwd, { agentKind: "main" });
		const sub = createSnippetsHarness(cwd, { agentKind: "sub" });
		await main.emit("session_start");
		await sub.emit("session_start");

		await main.input("::zz-alpha");
		await sub.input("::zz-beta");

		const mainPrompt = promptText(await main.beforeAgentStart(["NATIVE-BASE"]));
		expect(mainPrompt).toContain("ROLE-BODY-ALPHA");
		expect(mainPrompt).not.toContain("ROLE-BODY-BETA");
	});

	it("does not restore a persisted role into a sub agent session", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, {
			agentKind: "sub",
			branch: [roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ROLE-BODY"))],
		});
		await harness.emit("session_start");

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("SAVED-ROLE-BODY");
	});

	it("disables role effects with an explicit notice when the host exposes no agent identity, while styles still work", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, { agentKind: null });
		await harness.emit("session_start");

		await harness.input("::zz-alpha");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(harness.notices.length).toBeGreaterThan(0);

		await harness.input("::pin(concise)");
		expect(pinnedStylesBlock(promptText(await harness.beforeAgentStart(["NATIVE-BASE"])))).toContain("concise");
	});
});

// ============================================================================
// Roles — persistence and lifecycle restoration
// ============================================================================

describe("roles — lifecycle restoration", () => {
	it("restores the latest role recorded on the active branch at session_start", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, {
			branch: [roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ROLE-BODY"))],
		});
		await harness.emit("session_start");

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).toContain("SAVED-ROLE-BODY");
		expect(roleStatusText(harness)).toContain("zz-alpha");
	});

	it("starts a fresh session with no role when the branch has no role record", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, { branch: [] });
		await harness.emit("session_start");

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(result?.systemPrompt ?? ["NATIVE-BASE"]).toEqual(["NATIVE-BASE"]);
	});

	it("uses the saved body on resume even when the role file is missing, with a nonblocking notice", async () => {
		const cwd = tempDir();
		const harness = createSnippetsHarness(cwd, {
			branch: [roleRecordEntry("r1", roleSnapshot("zz-gone", "SAVED-ROLE-BODY"))],
		});
		await harness.emit("session_start");

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).toContain("SAVED-ROLE-BODY");
		expect(harness.notices.some((notice) => notice.message.includes("zz-gone"))).toBe(true);
	});

	it("does not resurrect an earlier role when the latest role record is invalid", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, {
			branch: [
				roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ROLE-BODY")),
				roleRecordEntry("r2", { version: 1, role: "not-an-object" }),
			],
		});
		await harness.emit("session_start");

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("SAVED-ROLE-BODY");
	});

	it("reconstructs the role from the destination branch on session_switch", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-beta", "ROLE-BODY-BETA");
		const harness = createSnippetsHarness(cwd, {
			branch: [roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))],
		});
		await harness.emit("session_start");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("SAVED-ALPHA");

		harness.setBranch([roleRecordEntry("r2", roleSnapshot("zz-beta", "SAVED-BETA"))]);
		await harness.emit("session_switch", { reason: "resume", previousSessionFile: undefined });

		const switched = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(switched)).toContain("SAVED-BETA");
		expect(promptText(switched)).not.toContain("SAVED-ALPHA");
	});

	it("drops the in-memory role when switching to a branch without a role record", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");

		harness.setBranch([]);
		await harness.emit("session_switch", { reason: "new", previousSessionFile: undefined });

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
	});

	it("reconstructs the retained branch's role on session_branch and session_tree", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, {
			branch: [roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))],
		});
		await harness.emit("session_start");

		harness.setBranch([roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))]);
		await harness.emit("session_branch", { previousSessionFile: undefined });
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("SAVED-ALPHA");

		harness.setBranch([roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))]);
		await harness.emit("session_tree", { newLeafId: "r1", oldLeafId: null });
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("SAVED-ALPHA");
	});

	it("a rewind to a branch with a tombstone leaves no role behind", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, {
			branch: [roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))],
		});
		await harness.emit("session_start");

		harness.setBranch([
			roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA")),
			roleRecordEntry("r2", { version: 1, role: null }),
		]);
		await harness.emit("session_tree", { newLeafId: "r2", oldLeafId: "r1" });

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("SAVED-ALPHA");
	});

	it("keeps style pins across a session_switch that restores a role", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(concise)");
		const baseline = pinnedStylesBlock(promptText(await harness.beforeAgentStart(["NATIVE-BASE"])));

		harness.setBranch([roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))]);
		await harness.emit("session_switch", { reason: "resume", previousSessionFile: undefined });

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).toContain("SAVED-ALPHA");
		expect(pinnedStylesBlock(promptText(result))).toBe(baseline);
	});

	it("keeps the role across a compaction boundary on the branch", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");
		const appendsAfterSelection = roleAppends(harness).length;

		// A compaction boundary is just another entry appended to the branch: the
		// role record stays on the parentId path a restore walks, so the saved
		// snapshot is still what gets injected — and nothing new is written.
		harness.setBranch([
			roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA")),
			{ type: "compaction", id: "c1", parentId: "r1" },
		]);
		await harness.emit("session_branch", { previousSessionFile: undefined });

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("SAVED-ALPHA");
		expect(roleAppends(harness)).toHaveLength(appendsAfterSelection);
	});

	it("reconstructs from the active branch, not from global entry history", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd, {
			branch: [],
			entries: [roleRecordEntry("r1", roleSnapshot("zz-alpha", "GLOBAL-HISTORY-ROLE"))],
		});
		await harness.emit("session_start");

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("GLOBAL-HISTORY-ROLE");
	});

	it("does not drop a pending snippet inject when lifecycle restoration runs", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA");
		writeSnippet(dir, "zz-injector.md", "<inject>\nHIDDEN-CONTEXT\n</inject>\nvisible");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-injector");
		harness.setBranch([roleRecordEntry("r1", roleSnapshot("zz-alpha", "SAVED-ALPHA"))]);
		await harness.emit("session_switch", { reason: "resume", previousSessionFile: undefined });

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(String(result?.message?.content ?? "")).toContain("HIDDEN-CONTEXT");
		expect(promptText(result)).toContain("SAVED-ALPHA");
	});
});

// ============================================================================
// Roles — registry isolation and tier precedence
// ============================================================================

describe("roles — registry isolation and tier precedence", () => {
	it("keeps role definitions out of ordinary snippet expansion", () => {
		const dir = tempDir();
		writeRole(dir, "zz-role", "ROLE-BODY");
		const registry = loadSnippetDir(dir);
		expect(expandTriggers("::zz-role", registry).text).toBe("::zz-role");
	});

	it("a project-level role overrides a personal role of the same name", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeRole(path.join(userDir, "snippets"), "zz-shared", "PERSONAL-ROLE-BODY");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-shared", "PROJECT-ROLE-BODY");
		const registry = buildSnippetRegistry(cwd, userDir);
		const merged = registry.get("zz-shared");
		expect(merged?.raw).toBe("PROJECT-ROLE-BODY");
		expect(merged && isRoleDef(merged)).toBe(true);
	});

	it("a project-level role overrides a personal snippet of the same name", () => {
		const userDir = tempDir();
		const cwd = tempDir();
		writeSnippet(path.join(userDir, "snippets"), "zz-shared.md", "PERSONAL-INLINE");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-shared", "PROJECT-ROLE-BODY");
		const registry = buildSnippetRegistry(cwd, userDir);
		expect(expandTriggers("::zz-shared", registry).text).toBe("::zz-shared");
	});
});

// ============================================================================
// Roles — pure seams: token boundaries, snapshot extraction, persisted record
// ============================================================================

describe("findRoleActions", () => {
	function roleRegistry(): Map<string, SnippetDef> {
		const dir = tempDir();
		writeRole(dir, "zz-role", "ROLE-BODY");
		writeRole(dir, "zz-beta", "BETA-BODY");
		writeRole(dir, "pins", "PINS-ROLE-BODY");
		writeSnippet(dir, "zz-plain.md", "PLAIN-BODY");
		return loadSnippetDir(dir);
	}

	/** Scanned actions as `name`/`kind` strings, so expectations read like the scan. */
	function scan(text: string, registry: Map<string, SnippetDef>): string[] {
		return findRoleActions(text, registry).map((action) => (action.kind === "select" ? action.name : action.kind));
	}

	it("finds a bare role trigger and a bare clear in left-to-right order", () => {
		expect(scan("::zz-role then ::unrole", roleRegistry())).toEqual(["zz-role", "clear"]);
	});

	it("ignores ordinary snippets and unknown names", () => {
		expect(findRoleActions("::zz-plain ::unknown", roleRegistry())).toEqual([]);
	});

	it("skips parameterized, heredoc, chained, and quoted-argument occurrences", () => {
		const registry = roleRegistry();
		expect(findRoleActions("::zz-role(args)", registry)).toEqual([]);
		expect(findRoleActions("::zz-role<<args>>", registry)).toEqual([]);
		expect(findRoleActions("::zz-plain::zz-role<<shared>>", registry)).toEqual([]);
		expect(findRoleActions("::zz-plain(::zz-role)", registry)).toEqual([]);
	});

	it("still finds a role after an unrelated << in the surrounding text", () => {
		const registry = roleRegistry();
		expect(scan("Discuss x << 2, then ::zz-role", registry)).toEqual(["zz-role"]);
		expect(scan("Discuss x << 2 >> then ::zz-role", registry)).toEqual(["zz-role"]);
	});

	it("treats an unterminated bracket argument as opaque, chained head included", () => {
		const registry = roleRegistry();
		expect(findRoleActions("::zz-role<<draft", registry)).toEqual([]);
		expect(findRoleActions("::zz-plain::zz-role<<draft", registry)).toEqual([]);
	});

	it("draws the same chain boundaries as the expander", () => {
		const registry = roleRegistry();
		expect(scan("::zz-role << draft", registry)).toEqual([]); // whitespace may separate a head from its bracket
		expect(scan("::zz-role<<", registry)).toEqual([]); // bracket with no content
		expect(scan("::zz-plain<<::zz-role>>", registry)).toEqual([]); // head inside a trigger-fed bracket
		expect(scan("::zz-plain(x)::zz-role<<y>>", registry)).toEqual([]); // bracket after an argument list
		expect(scan("::zz-plain(x)::zz-role", registry)).toEqual(["zz-role"]); // argument list ends the run
		expect(scan("::zz-role(x) ::zz-beta", registry)).toEqual(["zz-beta"]); // parameterized head does not eat a later one
	});

	it("compares reserved trigger names case-insensitively", () => {
		const registry = roleRegistry();
		expect(scan("::UNROLE", registry)).toEqual(["clear"]);
		expect(scan("::Unrole", registry)).toEqual(["clear"]);
		// A role named after a pin trigger stays unreachable — the pin pass owns it.
		expect(scan("::pins", registry)).toEqual([]);
		expect(scan("::Pins", registry)).toEqual([]);
	});

	it("refuses a reserved canonical role name reached through an alias, in any case", () => {
		const dir = tempDir();
		// Each reserved word is a role's CANONICAL name, reachable under a
		// harmless alias. The registry maps every alias key to that same
		// definition, so a check on the typed name alone would hand the role the
		// very trigger the reserved word protects.
		const cases: Array<[canonical: string, alias: string]> = [
			["pin", "bosun"],
			["unpin", "second-mate"],
			["pins", "captain"],
			["unrole", "skipper"],
		];
		for (const [canonical, alias] of cases) {
			writeRole(dir, canonical, `${canonical.toUpperCase()}-ROLE-BODY`, [`aliases: [${alias}]`]);
		}
		const registry = loadSnippetDir(dir);

		for (const [, alias] of cases) {
			expect(scan(`::${alias}`, registry)).toEqual([]);
			expect(scan(`::${alias.toUpperCase()}`, registry)).toEqual([]);
		}
		// The reserved triggers still win over the role's own canonical name.
		expect(scan("::pins", registry)).toEqual([]);
		expect(scan("::unrole", registry)).toEqual(["clear"]);
	});

	it("still selects a role through a valid alias, canonical name returned", () => {
		const dir = tempDir();
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA", ["aliases: [zz-alt]"]);
		const registry = loadSnippetDir(dir);
		expect(scan("::zz-alt", registry)).toEqual(["zz-alpha"]);
		expect(scan("::ZZ-ALT", registry)).toEqual(["zz-alpha"]);
	});

	it("selects a role through a spaced alias as one complete head", () => {
		const dir = tempDir();
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA", ["aliases: [zz spaced role]"]);
		const registry = loadSnippetDir(dir);
		expect(scan("::zz spaced role", registry)).toEqual(["zz-alpha"]);
		expect(scan("::ZZ SPACED ROLE", registry)).toEqual(["zz-alpha"]);
	});

	it("masks the argument span of a spaced ordinary name, nested role included", () => {
		const dir = tempDir();
		// The spaced name is the shipped `q&a` definition (canonical id plus its
		// `question and answer` alias); the nested reference is a real role.
		writeSnippet(dir, "q&a.md", fs.readFileSync(path.join(path.resolve(import.meta.dir, "../examples"), "q&a.md"), "utf8"));
		writeRole(dir, "zz-review", "ZZ-REVIEW-BODY");
		const registry = loadSnippetDir(dir);

		// The enclosing `(` belongs to the whole spaced name, so the role inside
		// is an argument, not a top-level action.
		expect(scan("::question and answer(::zz-review)", registry)).toEqual([]);
		expect(scan("::q&a(::zz-review)", registry)).toEqual([]);
		// A spaced name with a bracket argument masks the same way.
		expect(scan("::question and answer<<::zz-review>>", registry)).toEqual([]);
		// ...while the bare spaced name is an ordinary one-shot, never a role.
		expect(scan("::question and answer", registry)).toEqual([]);
		// The masking is the spaced head's doing, not the role's name: the same
		// nested role IS selectable on its own.
		expect(scan("::zz-review", registry)).toEqual(["zz-review"]);
	});
});

describe("readPersistedRole", () => {
	it("reads the latest role record, ignoring unrelated and older entries", () => {
		const entries = [
			{ type: "message", id: "m1" },
			roleRecordEntry("r1", roleSnapshot("zz-alpha", "OLD-BODY")),
			roleRecordEntry("r2", roleSnapshot("zz-beta", "NEW-BODY")),
		];
		expect(readPersistedRole(entries)).toEqual({ status: "role", role: { name: "zz-beta", body: "NEW-BODY" } });
	});

	it("reports an invalid latest record as invalid without falling back to the older role", () => {
		const entries = [roleRecordEntry("r1", roleSnapshot("zz-alpha", "OLD-BODY")), roleRecordEntry("r2", { version: 1, role: "nope" })];
		expect(readPersistedRole(entries)).toEqual({ status: "invalid" });
	});

	it("keeps walking past a compaction boundary to the role record on the branch", () => {
		// Compaction appends an entry and never removes earlier ones, so the role
		// record stays on the parentId path a restore walks.
		const compactionEntry = { type: "compaction", id: "c1", parentId: "r1", firstKeptEntryId: "r1" };
		expect(readPersistedRole([roleRecordEntry("r1", roleSnapshot("zz-alpha", "BODY")), compactionEntry])).toEqual({
			status: "role",
			role: { name: "zz-alpha", body: "BODY" },
		});
		expect(
			readPersistedRole([
				roleRecordEntry("r1", roleSnapshot("zz-alpha", "BODY")),
				compactionEntry,
				roleRecordEntry("r2", { version: 1, role: null }),
			]),
		).toEqual({ status: "cleared" });
	});
});

describe("extractRoleBody", () => {
	it("prefers append blocks over inline text and expands nested ordinary snippets", () => {
		const dir = tempDir();
		writeSnippet(dir, "zz-helper.md", "HELPER-TEXT");
		writeRole(dir, "zz-role", "<append>\nuses ::zz-helper\n</append>\n\ninline text");
		const registry = loadSnippetDir(dir);
		expect(extractRoleBody(registry.get("zz-role")!, registry)).toBe("uses HELPER-TEXT");
	});

	it("falls back to inline text and keeps a nested role reference literal", () => {
		const dir = tempDir();
		writeRole(dir, "zz-inner", "INNER-BODY");
		writeRole(dir, "zz-role", "refers to ::zz-inner");
		const registry = loadSnippetDir(dir);
		expect(extractRoleBody(registry.get("zz-role")!, registry)).toBe("refers to ::zz-inner");
	});

	it("keeps the role's own expanded body alongside blocks a nested snippet hoists", () => {
		const dir = tempDir();
		writeSnippet(dir, "zz-helper.md", "<append>\nHELPER-TASK\n</append>\n\nHELPER-INLINE");
		writeRole(dir, "zz-outer", "<append>\nCoordinate ::zz-helper\n</append>");
		writeSnippet(dir, "zz-outer-twin.md", "---\npinnable: true\n---\n<append>\nCoordinate ::zz-helper\n</append>");
		writeRole(dir, "zz-inline", "Coordinate ::zz-helper");
		writeSnippet(dir, "zz-inline-twin.md", "---\npinnable: true\n---\nCoordinate ::zz-helper");
		const registry = loadSnippetDir(dir);

		// The role's own text comes first, the hoisted block after it — and the
		// pinned snapshot of the identical definition agrees, so role selection
		// and ::pin stay one rule.
		const body = extractRoleBody(registry.get("zz-outer")!, registry);
		expect(body).toBe("Coordinate HELPER-INLINE\n\nHELPER-TASK");

		const pinned = new Map<string, PinnedSnippet>();
		pinSnippetByName("zz-outer-twin", registry, pinned);
		expect(pinned.get("zz-outer-twin")?.content).toBe(body);

		// Inline-only definitions keep ::pin's rule verbatim: a hoisted block wins
		// over the inline text. Asymmetric on purpose — both branches mirror ::pin.
		const inlineBody = extractRoleBody(registry.get("zz-inline")!, registry);
		expect(inlineBody).toBe("HELPER-TASK");
		pinSnippetByName("zz-inline-twin", registry, pinned);
		expect(pinned.get("zz-inline-twin")?.content).toBe(inlineBody);
	});
});

// ============================================================================
// Roles — snapshot semantics, unsupported forms, invalid definitions
// ============================================================================

describe("roles — snapshot and rejection semantics", () => {
	it("keeps using the body captured at selection after the file changes on disk", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		writeSnippet(dir, "zz-alpha.md", "---\nkind: role\n---\nROLE-BODY-CHANGED");

		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(result)).toContain("ROLE-BODY-ALPHA");
		expect(promptText(result)).not.toContain("ROLE-BODY-CHANGED");

		await harness.input("::zz-alpha");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-CHANGED");
	});

	it("does not activate a role from a parameterized or heredoc trigger form", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		for (const unsupported of ["::zz-alpha(some argument)", "::zz-alpha<<some argument>>"]) {
			const submitted = await harness.input(unsupported);
			expect(submitted?.text ?? unsupported).toBe(unsupported);
			expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		}
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("does not activate a role from an unterminated bracket argument", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		for (const unsupported of ["::zz-alpha<<draft", "::zz-alpha << draft", "::zz-alpha::zz-beta<<draft"]) {
			const submitted = await harness.input(unsupported);
			expect(submitted?.text ?? unsupported).toBe(unsupported);
			expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		}
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("does not treat a ::unrole-prefixed token as the reserved clear", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-alpha", "ROLE-BODY-ALPHA");
		writeSnippet(dir, "unrole-extra.md", "UNROLE-EXTRA-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zz-alpha");

		const submitted = await harness.input("::unrole-extra");
		expect(submitted?.text).toContain("UNROLE-EXTRA-BODY");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-BODY-ALPHA");
	});

	it("does not activate a role referenced inside another snippet's body", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zz-wrapper.md", "see ::zz-alpha for details");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-wrapper");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("does not activate a role referenced inside another snippet's argument", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zz-echo.md", "echo($1)");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-echo(::zz-alpha)");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-BODY-ALPHA");
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("takes the last valid role action when one submission carries several", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-beta", "ROLE-BODY-BETA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zz-alpha ::zz-beta");
		const last = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(last)).toContain("ROLE-BODY-BETA");
		expect(promptText(last)).not.toContain("ROLE-BODY-ALPHA");

		await harness.input("::zz-alpha ::unrole");
		const cleared = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(promptText(cleared)).not.toContain("ROLE-BODY-ALPHA");
		expect(promptText(cleared)).not.toContain("ROLE-BODY-BETA");
	});

	it("a malformed role body does not break loading or expansion of valid snippets", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-bad", "<append><prepend>nested</prepend></append>");
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zz-ok.md", "ZZ-OK-INLINE");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const ok = await harness.input("::zz-ok");
		expect(ok?.text).toContain("ZZ-OK-INLINE");

		await harness.input("::zz-bad");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(harness.notices.some((notice) => notice.type === "warning" && notice.message.includes("zz-bad"))).toBe(true);
	});

	it("leaves a role that declares pinnable/group out of the pin channel without breaking unrelated snippets", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-badrole", "BAD-ROLE-BODY", ["pinnable: true", "group: answer-delivery"]);
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zz-ok.md", "ZZ-OK-INLINE");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(zz-badrole)");
		const afterPin = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(pinnedStylesBlock(promptText(afterPin))).not.toContain("BAD-ROLE-BODY");

		const ok = await harness.input("::zz-ok");
		expect(ok?.text).toContain("ZZ-OK-INLINE");
		expect(harness.notices.some((notice) => notice.type === "warning" && notice.message.includes("zz-badrole"))).toBe(true);
	});

	it("::pin(role) neither pins nor activates the role", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-alpha", "ROLE-BODY-ALPHA");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(zz-alpha)");
		const result = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(pinnedStylesBlock(promptText(result))).toBe("");
		expect(promptText(result)).not.toContain("ROLE-BODY-ALPHA");
		expect(roleAppends(harness)).toHaveLength(0);
	});
});

// ============================================================================
// Roles — unsupported argument forms stay literal through every pass
//
// `::role(args)` / `::role<<...>>` are unsupported: the role scanner already
// refuses to activate them, but the submitted text then passes through the
// pin preprocessor and both expansion passes. A nested `::unpin`, `::pin`,
// `::pins`, or ordinary snippet inside such a span must never execute or
// expand — including when the span is nested in an ordinary argument, produced
// by a recursive snippet body, or left unclosed. The guard checks after each
// attempt are the actual consumer contract: Q&A enforcement must still block
// write/bash/spawn. Positive controls in the same suite prove ordinary
// commands outside the span keep working.
// ============================================================================

describe("roles — unsupported argument forms are opaque", () => {
	it("leaves canonical role argument forms literal while the Q&A guard, pins, and role journal stay untouched", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		const unsupportedForms = ["::zz-captain(::unpin(q&a))", "::zz-captain<<::unpin(q&a)>>", "::zz-captain(::pins)"];
		for (const form of unsupportedForms) {
			const submitted = await harness.input(form);
			expect(submitted?.text ?? form).toBe(form);
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
			expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);
			expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
			expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);
			expect(roleAppends(harness)).toHaveLength(0);
		}

		// The guarded pin itself is still addressable and listed.
		const listed = await harness.input("::pins");
		expect(listed?.text).toBe("(pinned: q&a)");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("CAPTAIN-BODY");
	});

	it("recognizes alias, case-variant, spaced, and ampersand role names as opaque", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY", ["aliases: [zz-cap, the captain]"]);
		writeRole(dir, "r&d", "RND-BODY", ["aliases: [research]"]);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		for (const form of [
			"::zz-cap(::unpin(q&a))",
			"::ZZ-CAPTAIN(::unpin(q&a))",
			"::the captain(::unpin(q&a))",
			"::r&d(::unpin(q&a))",
			"::R&D(::unpin(q&a))",
			"::research(::unpin(q&a))",
		]) {
			const submitted = await harness.input(form);
			expect(submitted?.text ?? form).toBe(form);
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
			expect(roleAppends(harness)).toHaveLength(0);
		}
	});

	it("protects a nested role wrapper in ordinary arguments, recursive bodies, and block material", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		writeSnippet(dir, "zz-echo.md", "echo($1)");
		writeSnippet(dir, "zz-expandable.md", "EXPANDABLE-BODY");
		writeSnippet(dir, "zz-wrapper.md", "::zz-captain<<::unpin(q&a)>>");
		writeSnippet(dir, "zz-body.md", "::zz-captain(::zz-expandable)");
		writeSnippet(dir, "zz-blocks.md", "<prepend>PRE $1</prepend><append>APP $1</append><inject>INJ $1</inject>");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		// A role wrapper nested inside an ordinary argument is consumed
		// verbatim, and its nested unpin never reaches the pin pass.
		const nested = await harness.input("::zz-echo(::zz-captain(::unpin(q&a)))");
		expect(nested?.text).toContain("::zz-captain(::unpin(q&a))");
		expect(nested?.text).not.toContain("(unpinned: q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
		expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);
		const nestedBracket = await harness.input("::zz-echo<<::zz-captain(::unpin(q&a))>>");
		expect(nestedBracket?.text ?? "").toContain("echo(::zz-captain(::unpin(q&a)))");
		expect(nestedBracket?.text ?? "").not.toContain("(unpinned: q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);

		// A recursive body that produces a role wrapper protects the next rescan.
		const viaBody = await harness.input("::zz-wrapper");
		expect(viaBody?.text ?? "").toContain("::zz-captain<<::unpin(q&a)>>");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		const expandableBody = await harness.input("::zz-body");
		expect(expandableBody?.text ?? "").toContain("::zz-captain(::zz-expandable)");
		expect(expandableBody?.text ?? "").not.toContain("EXPANDABLE-BODY");

		// Block material may carry the literal wrapper, never its expansion.
		const blocked = await harness.input("::zz-blocks(::zz-captain<<::zz-expandable>>)");
		expect(blocked?.text ?? "").toContain("PRE ::zz-captain<<::zz-expandable>>");
		expect(blocked?.text ?? "").toContain("APP ::zz-captain<<::zz-expandable>>");
		expect(blocked?.text ?? "").not.toContain("EXPANDABLE-BODY");
		const injected = await harness.beforeAgentStart(["NATIVE-BASE"]);
		expect(String(injected?.message?.content ?? "")).toContain("INJ ::zz-captain<<::zz-expandable>>");
		expect(String(injected?.message?.content ?? "")).not.toContain("EXPANDABLE-BODY");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("keeps block-shaped argument data literal without consuming the definition's actual blocks", () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		writeSnippet(dir, "zz-echo.md", "$1");
		writeSnippet(dir, "zz-actual-block.md", "<append>ACTUAL $1</append>");
		writeSnippet(dir, "zz-relay.md", "::zz-echo<<$1>>");
		const registry = buildSnippetRegistry(cwd);

		for (const data of [
			"<inject>HIDDEN-INJECT</inject>",
			"<prepend>HIDDEN-PREPEND</prepend>",
			"<append>HIDDEN-APPEND</append>",
			"</append><inject>MIXED</inject><prepend>TAIL",
		]) {
			const literal = `::zz-captain(${data})`;
			expect(expandTriggers(`::zz-echo<<${literal}>>`, registry)).toEqual({
				text: literal, prepend: [], append: [], inject: [],
			});
			expect(expandTriggers(`::zz-actual-block<<${literal}>>`, registry)).toEqual({
				text: "", prepend: [], append: [`ACTUAL ${literal}`], inject: [],
			});
		}
		const recursive = "::zz-captain(<inject>RECURSIVE-DATA</inject>)";
		expect(expandTriggers(`::zz-relay<<${recursive}>>`, registry)).toEqual({
			text: recursive, prepend: [], append: [], inject: [],
		});
	});

	it("keeps block-like data inside a substituted role argument literal", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		writeSnippet(dir, "zz-echo.md", "$1");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		const opaque =
			"::zz-captain(<inject>INERT-INJECT ::unpin(q&a)</inject><append>INERT-APPEND</append><prepend>INERT-PREPEND</prepend>)";
		const submitted = await harness.input(`::zz-echo<<${opaque}>>`);
		expect(submitted?.text ?? "").toContain(opaque);
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
		expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);

		const beforeStart = await harness.beforeAgentStart(["NATIVE-BASE"]);
		const injected = String(beforeStart?.message?.content ?? "");
		expect(injected).not.toContain("INERT-INJECT");
		expect(injected).not.toContain("INERT-APPEND");
		expect(injected).not.toContain("INERT-PREPEND");
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("protects complete role-fed bracket runs from native and ordinary siblings", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		writeSnippet(
			dir,
			"zz-leak.md",
			"<inject>RUN-HIDDEN-INJECT</inject><prepend>RUN-HIDDEN-PREPEND</prepend><append>RUN-HIDDEN-APPEND</append>LEAK",
		);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		const baseline = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));

		for (const form of [
			"::zz-captain::pins<<::unpin(q&a)>>",
			"::pins::zz-captain<<::unpin(q&a)>>",
			"::zz-captain ::pins<<::unpin(q&a)>>",
			"::pins ::zz-captain<<::unpin(q&a)>>",
			"::zz-captain::pins<<::unpin(q&a)",
			"::pins ::zz-captain<<::unpin(q&a)",
			"::zz-captain ::pins<<::unpin(q&a)",
			"::pins::zz-captain<<::unpin(q&a)",
		]) {
			const submitted = await harness.input(form);
			expect(submitted?.text ?? form).toBe(form);
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
			const after = await harness.beforeAgentStart(["NATIVE-BASE"]);
			expect(promptText(after)).toBe(baseline);
			expect(String(after?.message?.content ?? "")).not.toContain("RUN-HIDDEN");
			expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);
			expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
			expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);
			expect(roleAppends(harness)).toHaveLength(0);
		}

		for (const form of [
			"::zz-captain::zz-leak<<PAYLOAD>>",
			"::zz-leak::zz-captain<<PAYLOAD>>",
			"::zz-captain ::zz-leak<<PAYLOAD>>",
			"::zz-leak ::zz-captain<<PAYLOAD>>",
			"::zz-captain::zz-leak<<PAYLOAD",
			"::zz-leak ::zz-captain<<PAYLOAD",
			"::zz-captain ::zz-leak<<PAYLOAD",
			"::zz-leak::zz-captain<<PAYLOAD",
		]) {
			const submitted = await harness.input(form);
			expect(submitted?.text ?? form).toBe(form);
			const after = await harness.beforeAgentStart(["NATIVE-BASE"]);
			expect(promptText(after)).toBe(baseline);
			expect(String(after?.message?.content ?? "")).not.toContain("RUN-HIDDEN");
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		}
	});

	it("keeps the first ordinary close outside a protected role wrapper for exact argument substitution", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY", ["aliases: [the captain]"]);
		writeSnippet(dir, "zz-echo.md", "ECHO($1)");
		writeSnippet(dir, "zz-all.md", "ALL($ARGUMENTS)");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");

		for (const [input, expected] of [
			['::zz-echo("::zz-captain(::unpin(q&a))")', "ECHO(::zz-captain(::unpin(q&a)))"],
			['::zz-echo("::zz-captain<<::unpin(q&a)>>")', "ECHO(::zz-captain<<::unpin(q&a)>>)"],
			['::zz-echo(::the captain("two words"))', 'ECHO(::the captain("two words"))'],
			[`::zz-echo("::zz-captain('two words')")`, "ECHO(::zz-captain('two words'))"],
			[`::zz-all(before ::the captain("two words") after "normal quoted")`, 'ALL(before ::the captain("two words") after normal quoted)'],
		] as const) {
			const submitted = await harness.input(input);
			expect(submitted?.text).toBe(expected);
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
			expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);
			expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
			expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);
		}
	});

	it("recomputes role opacity before consuming suffixes hidden by generated openers", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		writeSnippet(dir, "zz-open-paren.md", "::zz-captain(");
		writeSnippet(dir, "zz-open-bracket.md", "::zz-captain<<");
		writeSnippet(dir, "zz-head.md", "::zz-captain");
		writeSnippet(dir, "zz-paren-delimiter.md", "(");
		writeSnippet(dir, "zz-bracket-delimiter.md", "<<");
		writeSnippet(dir, "zz-outer.md", "[$1]");
		writeSnippet(dir, "zz-inner.md", "INNER");
		writeSnippet(
			dir,
			"zz-leak.md",
			"<inject>OPEN-HIDDEN-INJECT</inject><prepend>OPEN-HIDDEN-PREPEND</prepend><append>OPEN-HIDDEN-APPEND</append>LEAK",
		);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		const baseline = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));

		for (const [input, expected] of [
			["::zz-open-paren ::zz-leak)", "::zz-captain( ::zz-leak)"],
			["::zz-open-bracket<<>> ::zz-leak<<PAYLOAD>>", "::zz-captain<< ::zz-leak<<PAYLOAD>>"],
			["::zz-head::zz-paren-delimiter ::zz-leak)", "::zz-captain( ::zz-leak)"],
			["::zz-head<<>>::zz-bracket-delimiter() ::zz-leak)", "::zz-captain<< ::zz-leak)"],
			["::zz-open-bracket<<>> protected >> ::zz-outer(::zz-inner<<two words>>)", "::zz-captain<< protected >> [INNER]"],
		] as const) {
			const submitted = await harness.input(input);
			expect(submitted?.text).toBe(expected);
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
			const after = await harness.beforeAgentStart(["NATIVE-BASE"]);
			expect(promptText(after)).toBe(baseline);
			expect(String(after?.message?.content ?? "")).not.toContain("OPEN-HIDDEN");
			expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);
			expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
			expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);
			expect(roleAppends(harness)).toHaveLength(0);
		}
	});

	it("treats unclosed role argument spans as opaque to the end of the text", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-captain", "CAPTAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		for (const form of ["::zz-captain(::unpin(q&a)", "::zz-captain<<::unpin(q&a)", "::zz-captain ::zz-cap<<::unpin(q&a)"]) {
			const submitted = await harness.input(form);
			expect(submitted?.text ?? form).toBe(form);
			expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
			expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zz-out.txt"), content: "x" }))).toBe(true);
			expect(roleAppends(harness)).toHaveLength(0);
		}
	});

	it("keeps ordinary expansion, explicit unpin, and role selection working outside a protected span", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		writeSnippet(dir, "zz-ok.md", "OK-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();

		const mixed = await harness.input("::zz-captain(::unpin(q&a)) ::zz-ok ::unpin(q&a)");
		expect(mixed?.text ?? "").toContain("::zz-captain(::unpin(q&a))");
		expect(mixed?.text ?? "").toContain("OK-BODY");
		expect(mixed?.text ?? "").toContain("(unpinned: q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(false);

		await harness.input("::zz-captain");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("CAPTAIN-BODY");
		expect(roleAppends(harness)).toHaveLength(1);
	});

	it("preserves pin ordering and group replacement for commands outside the span", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zz-captain", "CAPTAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(bluf)");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain('<pinned-style name="bluf">');

		// Nested inside the role argument it is literal; bluf stays pinned and
		// socratic is not activated.
		await harness.input("::zz-captain(::pin(socratic))");
		const afterNested = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(afterNested).toContain('<pinned-style name="bluf">');
		expect(afterNested).not.toContain('<pinned-style name="socratic">');

		// The same command outside replaces bluf through the style group.
		await harness.input("::pin(socratic)");
		const afterSwap = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(afterSwap).toContain('<pinned-style name="socratic">');
		expect(afterSwap).not.toContain('<pinned-style name="bluf">');
		expect(harness.notices.some((notice) => notice.message.includes("socratic replaces bluf"))).toBe(true);
	});

	it("does not treat a category:role pin as a real role for opacity", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zz-rolelike.md", "---\npinnable: true\ncategory: role\n---\nROLELIKE($1)");
		writeSnippet(dir, "zz-expandable.md", "EXPANDABLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const submitted = await harness.input("::zz-rolelike(::zz-expandable)");
		expect(submitted?.text ?? "").toContain("ROLELIKE(EXPANDABLE-BODY)");
		expect(roleAppends(harness)).toHaveLength(0);
	});

	it("keeps reserved pin controls ahead of a role with the same name", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "pins", "PINS-ROLE-BODY");
		writeRole(dir, "zz-captain", "CAPTAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(q&a)");

		expect((await harness.input("::pins"))?.text).toBe("(pinned: q&a)");
		expect((await harness.input("::PINS"))?.text).toBe("(pinned: q&a)");
		expect(roleAppends(harness)).toHaveLength(0);

		// Inside a real role's unsupported form, the reserved control is inert.
		const wrapped = await harness.input("::zz-captain(::pins)");
		expect(wrapped?.text ?? "::zz-captain(::pins)").toBe("::zz-captain(::pins)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
	});
});

// ============================================================================
// Picker — group ordering, relevance, rendering, and toggle stability
//
// Driven through the extension's real terminal-input seam: keystrokes go to
// the same handler the TUI feeds, the debounced recompute is flushed
// explicitly, and the rendered `belowEditor` widget is read back. Rows are
// compared by where each snippet's name appears, so the assertions pin order
// and behavior, not badge/heading wording. Ordering groups first — every role,
// then every non-role pinnable, then every ordinary one-shot — with the
// existing relevance/category/active/alphabetical keys preserved *inside* each
// group; rendering is measured on the widget's own `render(width)` at real
// terminal widths, so a wrapped second line, a row wider than its surface, or
// a stray color is a failure rather than a shape assertion, and the label
// column itself is asserted where it is visible: the index every description
// starts at.
// ============================================================================

function openPicker(harness: SnippetsHarness, typed: string): void {
	harness.setEditorText(typed);
	harness.pressKey(typed.slice(-1) || ":");
	harness.flushTimers();
}

// --- rendering helpers ------------------------------------------------------

/** The one fixed violet the picker paints role names with (xterm 256). The
 *  other two colours a row can carry are the theme tokens `SUCCESS_SGR` (a
 *  non-role pinnable name) and `ACCENT_SGR` (the selection caret) resolve to
 *  in the harness. */
const PURPLE = "\x1b[38;5;141m";

/** Every SGR sequence, so a row's *visible* text can be read back. */
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR, "");
}

/** The item rows the widget paints — the rows that name a snippet. Footer rows
 *  (the scroll counter and the hint) carry no `::name`, so filtering on the
 *  token keeps an assertion from counting chrome as an item. */
function itemRows(rows: readonly string[]): string[] {
	return rows.filter((row) => stripAnsi(row).includes("::"));
}

/** The cell every description in a rendered row starts at: the end of the run
 *  of spaces behind the padded label column. A row with no label/description
 *  split (no description at all) throws, so a test expecting a description
 *  can never read an absent one as "aligned at -1". */
function descriptionStart(row: string): number {
	const match = /^([\s\S]*)( {3,})(\S.*)$/.exec(row);
	if (!match) throw new Error(`row has no label/description split: ${JSON.stringify(row)}`);
	return match[1]!.length + match[2]!.length;
}

/** Every run of text the row wraps in `color`, up to the next SGR sequence.
 *  Empty for a row that never enters that colour. */
function colorSpans(row: string, color: string): string[] {
	const spans: string[] = [];
	let from = 0;
	for (;;) {
		const start = row.indexOf(color, from);
		if (start === -1) return spans;
		const end = row.indexOf("\x1b[", start + color.length);
		spans.push(row.slice(start + color.length, end === -1 ? row.length : end));
		from = end === -1 ? row.length : end;
	}
}

/** The visible text of a described native node: its own `text` (or the text
 *  its `spans` concatenate to) plus its children's, so a row can be found by
 *  the name it paints. */
function nativeText(node: NativeNode): string {
	const own = node.p?.text ?? (node.p?.spans ?? []).map((span) => span.t).join("");
	return `${own}${(node.c ?? []).map(nativeText).join("")}`;
}

/** True when `text` contains a surrogate code unit with no partner — the
 *  signature of a width slice that cut an astral character (emoji, rare CJK)
 *  in half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Grapheme-cluster segmenter: the unit a codepoint cap or a cell-width
 *  truncation must never split. A combining mark belongs to its base
 *  (`e\u0301`), and a ZWJ emoji (`👩💻`) is several code points and one glyph. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Asserts `rendered` is `source` truncated on whole grapheme clusters only: a
 *  truncation may drop the final glyph entirely, but every cluster that
 *  survives must be a complete source cluster — never a base without its
 *  combining mark, never a lone ZWJ component. A single trailing ellipsis is
 *  ignored. Stronger than "no lone surrogate", which a split cluster passes. */
function assertGraphemeSafeTruncation(source: string, rendered: string): void {
	const body = rendered.endsWith("…") ? rendered.slice(0, -1) : rendered;
	const sourceClusters = [...GRAPHEME_SEGMENTER.segment(source)].map((part) => part.segment);
	const renderedClusters = [...GRAPHEME_SEGMENTER.segment(body)].map((part) => part.segment);
	expect(renderedClusters).toEqual(sourceClusters.slice(0, renderedClusters.length));
}

/** Terminal widths the picker must stay single-line at: a narrow dock, a
 *  typical shell, and a wide surface. */
const RENDER_WIDTHS = [40, 80, 120] as const;

describe("picker — rendering", () => {
	it("paints exactly one single-line row per item at every terminal width", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzrow-role", "ROLE-ROW-BODY");
		writeSnippet(dir, "zzrow-pin.md", "---\npinnable: true\n---\nZZROW-PIN-BODY");
		writeSnippet(dir, "zzrow-plain.md", "ZZROW-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzrow");

		for (const width of RENDER_WIDTHS) {
			const rows = harness.renderWidget(width);
			expect(rows).toBeDefined();
			// No entry may smuggle a second line: a wrapped description would
			// show up as an embedded newline or as one item spanning two rows.
			for (const row of rows!) expect(row).not.toMatch(/[\r\n]/);
			const items = itemRows(rows!);
			for (const name of ["zzrow-role", "zzrow-pin", "zzrow-plain"]) {
				const hits = items.filter((row) => new RegExp(`::${name}(?![\\w-])`).test(stripAnsi(row)));
				expect(hits).toHaveLength(1);
			}
			for (const row of rows!) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("aligns every description behind one shared column — the widest visible label plus a three-space gap", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzalign-a.md", "ZZALIGN-A-BODY");
		writeSnippet(dir, "zzalign-longer-name.md", "ZZALIGN-LONGER-BODY");
		writeSnippet(dir, "zzalign-mid.md", "ZZALIGN-MID-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzalign");

		// At a wide surface nothing truncates, so each row's description is its
		// full preview; what varies between rows is only how much padding sits
		// between the label and that description.
		const items = buildSnippetAutocompleteItems(cwd, "zzalign");
		const rows = harness.renderWidget(120)!;
		const plain = itemRows(rows).map(stripAnsi);
		expect(plain).toHaveLength(3);

		const starts = plain.map(descriptionStart);
		expect(new Set(starts).size).toBe(1);
		// The column is the widest visible label — `::zzalign-longer-name`, not
		// a fixed 28-cell pad — so its own gap is exactly the three spaces and
		// the shared start is that label's end plus those three.
		const widest = "::zzalign-longer-name";
		expect(starts[0]).toBe(`   ${widest}`.length + 3);
		for (const row of plain) {
			const name = /::zzalign-[\w-]+/.exec(row)![0].slice(2);
			const item = items.find((i) => i.value === name);
			expect(row.slice(descriptionStart(row))).toBe(item?.description ?? "");
		}
	});

	it("leaves a short list with a short column — no fixed label pad", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzgap-one.md", "ZZGAP-DESCRIPTION-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzgap-one");

		const description = buildSnippetAutocompleteItems(cwd, "zzgap-one").find((i) => i.value === "zzgap-one")?.description;
		expect(description).toBeTruthy();
		if (typeof description !== "string") throw new Error("zzgap-one has no description");

		// One short label is the whole visible list, so the column is exactly
		// that label's width and the row is `caret + label + three spaces +
		// description`, with nothing trailing. A fixed 22/28-cell label column
		// (the shape this replaced) breaks the equality.
		const rows = harness.renderWidget(120)!;
		const row = itemRows(rows).find((r) => stripAnsi(r).includes("::zzgap-one"));
		expect(row).toBeDefined();
		expect(stripAnsi(row!)).toBe(` ▸ ::zzgap-one   ${description}`);
	});

	it("paints a 60-code-point description on one line at a wide surface, cut on a word boundary", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		// A body far past the cap, with a line break and runs of whitespace that
		// must be normalized away before the cap applies.
		const long = `${"lorem ".repeat(40)}\n\n  second   paragraph ${"tail ".repeat(20)}`;
		writeSnippet(dir, "zzcap-one.md", long);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzcap-one");

		const description = buildSnippetAutocompleteItems(cwd, "zzcap-one").find((i) => i.value === "zzcap-one")?.description;
		expect(description).toBeTruthy();
		if (typeof description !== "string") throw new Error("zzcap-one has no description");
		expect([...description].length).toBeLessThanOrEqual(60);
		expect(description.endsWith("…")).toBe(true);
		expect(description).not.toMatch(/\s\s|[\r\n]/);
		// The cut stopped at a whole word: the kept prefix is a prefix of the
		// normalized body and the next body character is the space it backed
		// off to, never the middle of a word.
		const kept = description.slice(0, -1);
		const normalized = long.trim().replace(/\s+/g, " ");
		expect(normalized.startsWith(kept)).toBe(true);
		expect(normalized[kept.length]).toBe(" ");

		// The rendered description is the same capped text (nothing wider is
		// available to paint), and it never spills to a second row.
		const rows = harness.renderWidget(120)!;
		const row = itemRows(rows).find((r) => stripAnsi(r).includes("::zzcap-one"));
		expect(row).toBeDefined();
		const plain = stripAnsi(row!);
		expect(plain.slice(descriptionStart(plain))).toBe(description);
		expect(plain).not.toMatch(/[\r\n]/);
	});

	it("shrinks the label column on a narrow surface so every row keeps a meaningful description", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zz-narrow-longname-here.md", "NARROW-LONG-BODY-TEXT");
		writeSnippet(dir, "zz-narrow-s.md", "NARROW-SHORT-BODY-TEXT");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zz-narrow");

		// 30 cells cannot hold the 25-cell label plus a description, so the
		// shared column shrinks: both names are cut with `…`, the column stays
		// aligned, and each description keeps the reserved twelve-cell budget
		// instead of being dropped to a stub.
		const rows = harness.renderWidget(30)!;
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(30);
		const plain = itemRows(rows).map(stripAnsi);
		expect(plain).toHaveLength(2);
		expect(new Set(plain.map(descriptionStart)).size).toBe(1);
		for (const row of plain) {
			const tail = row.slice(descriptionStart(row));
			expect(Bun.stringWidth(tail)).toBeGreaterThanOrEqual(12);
			expect(tail.startsWith("NARROW-")).toBe(true);
			expect(tail.endsWith("…")).toBe(true);
			expect(row.slice(0, descriptionStart(row))).toContain("…");
		}
	});

	it("keeps descriptions meaningful at 40 columns — the label column yields, marks and colors stay", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zz40-role", "Coordinate the release checks");
		writeSnippet(dir, "zz40-long-name-pinnable.md", "---\npinnable: true\n---\nKeep it short and concrete");
		writeSnippet(dir, "zz40-plain-name-also-long.md", "Summarize the findings first");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zz40");

		// 40 cells cannot hold the 28-cell labels plus a description, so the
		// shared column gives width up instead of leaving `Coo…`-style stubs:
		// every row keeps the reserved description budget, and every row starts
		// that description at the same cell.
		const rows = harness.renderWidget(40)!;
		for (const row of rows) {
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
			expect(row).not.toMatch(/[\r\n]/);
		}
		const ansiRows = itemRows(rows);
		const plain = ansiRows.map(stripAnsi);
		expect(plain).toHaveLength(3);
		expect(new Set(plain.map(descriptionStart)).size).toBe(1);

		const items = buildSnippetAutocompleteItems(cwd, "zz40");
		for (const row of plain) {
			const tail = row.slice(descriptionStart(row));
			expect(Bun.stringWidth(tail)).toBeGreaterThanOrEqual(12);
			// A real prefix of the row's own description, not a stub: the first
			// word of the description survives the row's cut.
			const item = items.find((i) => (i.description ?? "").startsWith(tail.slice(0, -1)));
			expect(item).toBeDefined();
			const firstWord = (item?.description ?? "").split(" ")[0]!;
			expect(tail.startsWith(firstWord)).toBe(true);
		}

		// The two long names are what yielded: cut with `…`, while the short
		// role name keeps its full label.
		const roleRow = plain.find((row) => row.includes("::zz40-role"))!;
		expect(roleRow.slice(0, descriptionStart(roleRow))).not.toContain("…");
		for (const row of plain.filter((row) => !row.includes("::zz40-role"))) {
			expect(row.slice(0, descriptionStart(row))).toContain("…");
		}

		// Colors and marks survive the shrink: the pinnable row keeps a whole
		// `☐` outside its green name, the role stays violet, the plain row
		// carries neither color.
		const byMark = (mark: string): string => ansiRows[plain.findIndex((row) => row.includes(mark))]!;
		const pinRow = byMark("☐");
		const green = colorSpans(pinRow, SUCCESS_SGR);
		expect(green).toHaveLength(1);
		expect(green[0]).not.toMatch(/[☐📌]/);
		expect(stripAnsi(pinRow)).toContain(" ☐");
		const roleAnsi = byMark("::zz40-role");
		expect(colorSpans(roleAnsi, PURPLE)).toHaveLength(1);
		expect(colorSpans(roleAnsi, SUCCESS_SGR)).toHaveLength(0);
		const plainAnsi = byMark("::zz40-plain");
		expect(colorSpans(plainAnsi, PURPLE)).toHaveLength(0);
		expect(colorSpans(plainAnsi, SUCCESS_SGR)).toHaveLength(0);
	});

	it("truncates long unbroken words and wide characters to the row without splitting a surrogate", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		// One unbroken token (no space to wrap at), an astral emoji run whose
		// width slice could land mid-character, and a full-width CJK run.
		writeSnippet(dir, "zzwide-a.md", `${"W".repeat(200)}`);
		writeSnippet(dir, "zzwide-b.md", `${"😀".repeat(40)}`);
		writeSnippet(dir, "zzwide-c.md", `${"漢".repeat(60)}`);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzwide");

		for (const width of [40, 80]) {
			const rows = harness.renderWidget(width)!;
			for (const row of rows) {
				expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
				expect(row).not.toMatch(LONE_SURROGATE);
			}
			// The truncated rows still identify their item on the single line.
			for (const name of ["zzwide-a", "zzwide-b", "zzwide-c"]) {
				expect(itemRows(rows).some((r) => stripAnsi(r).includes(`::${name}`))).toBe(true);
			}
		}
	});

	it("truncates to whole graphemes at the metadata cap and the row-width boundary — never half a glyph", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		// The 60-code-point cap keeps 59 code points plus its ellipsis, so this
		// body lands that boundary between the base "e" and its combining acute:
		// a code-point slice leaves a bare "e…", a grapheme slice drops the whole
		// "é" and keeps 58 a's.
		const combining = `${"a".repeat(58)}e\u0301${"z".repeat(40)}`;
		// A ZWJ emoji is three code points (woman, joiner, laptop); both the cap
		// and a cell-width slice can land between its parts.
		const zwj = "👩‍💻".repeat(40);
		writeSnippet(dir, "zzgr-combining.md", combining);
		writeSnippet(dir, "zzgr-zwj.md", zwj);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzgr");

		const cases = [
			["zzgr-combining", combining],
			["zzgr-zwj", zwj],
		] as const;

		// Metadata cap: the stored description is the grapheme-safe truncation.
		for (const [name, source] of cases) {
			const description = buildSnippetAutocompleteItems(cwd, name).find((i) => i.value === name)?.description;
			expect(description).toBeTruthy();
			if (typeof description !== "string") throw new Error(`${name} has no description`);
			expect([...description].length).toBeLessThanOrEqual(60);
			expect(description.endsWith("…")).toBe(true);
			assertGraphemeSafeTruncation(source, description);
		}

		// Row-width boundary: the rendered description is truncated again to fit
		// the row, and must stay grapheme-safe there too.
		for (const width of [40, 80]) {
			const rows = harness.renderWidget(width)!;
			for (const [name, source] of cases) {
				const row = itemRows(rows).find((r) => stripAnsi(r).includes(`::${name}`));
				expect(row).toBeDefined();
				expect(Bun.stringWidth(row!)).toBeLessThanOrEqual(width);
				const plain = stripAnsi(row!);
				assertGraphemeSafeTruncation(source, plain.slice(descriptionStart(plain)));
			}
		}
	});

	it("colors a row's name by category — violet role, green pinnable, plain ordinary — and nothing else", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzcol-role", "ZZCOL-ROLE-BODY");
		writeSnippet(dir, "zzcol-pin.md", "---\npinnable: true\n---\nZZCOL-PIN-BODY");
		writeSnippet(dir, "zzcol-plain.md", "ZZCOL-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzcol");

		const rows = harness.renderWidget(80)!;
		const byName = (name: string): string => {
			const row = itemRows(rows).find((r) => stripAnsi(r).includes(`::${name}`));
			if (!row) throw new Error(`no rendered row for ::${name}`);
			return row;
		};

		// The role row is the highlighted one (roles sort first), and the violet
		// covers the name alone: strip the selection caret and it is the bare
		// label, with no description dragged in behind it.
		const roleRow = byName("zzcol-role");
		const purple = colorSpans(roleRow, PURPLE);
		expect(purple).toHaveLength(1);
		expect(purple[0]!.replace(/^[▸\s]+/, "")).toBe("::zzcol-role");
		expect(roleRow).not.toContain(SUCCESS_SGR);

		// A non-role pinnable name is the theme's `success` green, and the green
		// stops at the pin mark: the checkbox is plain and the description behind
		// it is too, so neither can be read as part of the name.
		const pinRow = byName("zzcol-pin");
		expect(colorSpans(pinRow, PURPLE)).toHaveLength(0);
		expect(colorSpans(pinRow, SUCCESS_SGR)).toEqual(["::zzcol-pin"]);
		const plainPinRow = stripAnsi(pinRow);
		expect(plainPinRow).toContain("☐");
		expect(plainPinRow).toContain("ZZCOL-PIN-BODY");

		// An ordinary row carries neither color — its name and its description
		// keep the normal foreground.
		const plainRow = byName("zzcol-plain");
		expect(colorSpans(plainRow, PURPLE)).toHaveLength(0);
		expect(colorSpans(plainRow, SUCCESS_SGR)).toHaveLength(0);
		expect(stripAnsi(plainRow)).toContain("ZZCOL-PLAIN-BODY");
	});

	it("keeps a pinnable name green through the selected and the pinned state — the caret and the mark carry those", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzgp-one.md", "---\npinnable: true\n---\nZZGP-ONE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const onlyRow = (): string => {
			const row = itemRows(harness.renderWidget(80)!).find((r) => stripAnsi(r).includes("::zzgp-one"));
			if (!row) throw new Error("no rendered row for ::zzgp-one");
			return row;
		};

		// Unpinned, and the only match — so it is also the selected row. The
		// caret is what the selection adds; the name keeps its category color.
		openPicker(harness, "::zzgp-one");
		const selected = onlyRow();
		expect(colorSpans(selected, SUCCESS_SGR)).toEqual(["::zzgp-one"]);
		expect(colorSpans(selected, ACCENT_SGR)).toEqual(["▸ "]);
		expect(stripAnsi(selected)).toContain("☐");

		// Pinned: the glyph replaces the checkbox, and the green still ends
		// before it.
		await harness.input("::pin(zzgp-one)");
		openPicker(harness, "::zzgp-one");
		const pinned = onlyRow();
		expect(colorSpans(pinned, SUCCESS_SGR)).toEqual(["::zzgp-one"]);
		expect(stripAnsi(pinned)).toContain("📌");
	});

	it("keeps a selected, active role purple rather than repainting it", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzact-role", "ZZACT-ROLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::zzact-role");
		openPicker(harness, "::zzact-role");

		const rows = harness.renderWidget(80)!;
		const row = itemRows(rows).find((r) => stripAnsi(r).includes("::zzact-role"));
		expect(row).toBeDefined();
		const spans = colorSpans(row!, PURPLE);
		expect(spans).toHaveLength(1);
		expect(spans[0]!.replace(/^[▸\s]+/, "")).toBe("::zzact-role");
	});

	it("describes the same category colors natively — violet role, `success` pinnable name, plain ordinary label and description", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zznat-role", "ZZNAT-ROLE-BODY");
		writeSnippet(dir, "zznat-pin.md", "---\npinnable: true\n---\nZZNAT-PIN-BODY");
		writeSnippet(dir, "zznat-plain.md", "ZZNAT-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zznat");

		const tree = harness.describeWidget();
		if (tree == null) throw new Error("the picker described no native node");
		// The footer hint is a bare `text` node, not a row, so only the item
		// rows are considered here.
		const described = (tree.c ?? []).filter((node) => node.k === "row");
		const rowFor = (name: string): NativeNode => {
			const row = described.find((r) => nativeText(r).includes(`::${name}`));
			if (!row) throw new Error(`no described row for ::${name}`);
			return row;
		};
		const labelOf = (row: NativeNode): NativeNode => {
			const label = row.c?.[0];
			if (!label) throw new Error("described row has no label child");
			return label;
		};

		// The role label is the one raw-`ansi` segment, and its violet ends at
		// the name — the same place the terminal path resets.
		const roleLabel = labelOf(rowFor("zznat-role"));
		expect(roleLabel.k).toBe("ansi");
		expect(colorSpans(roleLabel.p?.text ?? "", PURPLE)).toEqual(["::zznat-role"]);

		// A pinnable name travels as the `success` token and the pin mark as an
		// unstyled span of its own, so the terminal ends the green exactly at
		// that boundary.
		const pinRow = rowFor("zznat-pin");
		const pinLabel = labelOf(pinRow);
		expect(pinLabel.k).toBe("text");
		const pinSpans = pinLabel.p?.spans ?? [];
		expect(pinSpans.filter((span) => span.s === "success").map((span) => span.t)).toEqual(["::zznat-pin"]);
		expect(pinSpans.find((span) => span.t.includes("☐"))?.s).toBeUndefined();
		// Its description is a plain text node — no token anywhere near it.
		expect(pinRow.c?.[1]?.p?.spans).toBeUndefined();
		expect(pinRow.c?.[1]?.p?.text).toContain("ZZNAT-PIN-BODY");

		// An ordinary row's label carries no token at all.
		const plainLabel = labelOf(rowFor("zznat-plain"));
		expect(plainLabel.k).toBe("text");
		expect((plainLabel.p?.spans ?? []).every((span) => span.s === undefined)).toBe(true);
		expect(nativeText(plainLabel)).toContain("::zznat-plain");
	});

	it("describes one shared label extent on every native row, so the descriptions line up", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzext-role", "ZZEXT-ROLE-BODY");
		writeSnippet(dir, "zzext-s.md", "ZZEXT-SHORT-BODY");
		writeSnippet(dir, "zzext-a-much-longer-name.md", "ZZEXT-LONG-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzext");

		const tree = harness.describeWidget();
		if (tree == null) throw new Error("the picker described no native node");
		const described = (tree.c ?? []).filter((node) => node.k === "row");
		expect(described).toHaveLength(3);

		// Every item row — the raw-`ansi` role label included — is pinned to the
		// same box: the widest visible label plus the three-space gap, reserved
		// as empty cells after the label text. One shared extent is what makes
		// the native descriptions start at one column instead of stepping with
		// each label's length.
		const extents = described.map((row) => row.c?.[0]?.p?.min?.w);
		expect(new Set(extents).size).toBe(1);
		const widest = "::zzext-a-much-longer-name";
		expect(Number.parseInt(String(extents[0]), 10)).toBe(`   ${widest}   `.length);
		for (const row of described) {
			// The gap is reserved, not appended: no label segment may trail
			// spaces of its own.
			expect(nativeText(row)).toBe(nativeText(row).trimEnd());
		}
	});
});

describe("picker — group ordering", () => {
	it("orders roles above every non-role pinnable, which stay above ordinary snippets", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzcat-role", "ROLE-CAT-BODY");
		writeSnippet(dir, "zzcat-style.md", "---\npinnable: true\ncategory: style\n---\nZZCAT-STYLE-BODY");
		writeSnippet(dir, "zzcat-behavior.md", "---\npinnable: true\n---\nZZCAT-BEHAVIOR-BODY");
		writeSnippet(dir, "zzcat-alpha.md", "---\ncategory: alpha\n---\nZZCAT-ALPHA-BODY");
		writeSnippet(dir, "zzcat-plain.md", "ZZCAT-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzcat");
		expect(pickerOrder(harness, ["zzcat-role", "zzcat-style", "zzcat-behavior", "zzcat-alpha", "zzcat-plain"])).toEqual([
			"zzcat-role",
			"zzcat-style",
			"zzcat-behavior",
			"zzcat-alpha",
			"zzcat-plain",
		]);

		// The unqueried view keeps the same grouping, asserted on the pure
		// exported rows rather than the rendered widget: with the bundled
		// pinnable examples ahead of these rows, the widget paints only its
		// first page, so an order assertion over rendered rows would compare
		// absent names. Filtering to this test's own names keeps the
		// subsequence — and therefore the relative order — independent of how
		// many bundled rows precede them.
		const unqueried = buildSnippetAutocompleteItems(cwd, "")
			.map((item) => item.value)
			.filter((value) => value.startsWith("zzcat-"));
		expect(unqueried).toEqual(["zzcat-role", "zzcat-style", "zzcat-behavior", "zzcat-alpha", "zzcat-plain"]);
	});

	it("lets the group key outrank relevance — a role substring beats a non-role pinnable exact match", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		// For query "zzq": an ordinary EXACT match, a non-role pinnable PREFIX
		// match, and a role SUBSTRING match. Grouping first puts the role above
		// the pinnable above the ordinary snippet, so the boundary is proven to
		// outrank match relevance rather than coinciding with it. The old
		// pinnable-first ordering would have put zzq-pin at the very top.
		writeSnippet(dir, "zzq.md", "ZZQ-EXACT-BODY");
		writeSnippet(dir, "zzq-pin.md", "---\npinnable: true\n---\nZZQ-PIN-BODY");
		writeRole(dir, "zz-zzq-role", "ZZQ-ROLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzq");
		expect(pickerOrder(harness, ["zz-zzq-role", "zzq-pin", "zzq"])).toEqual(["zz-zzq-role", "zzq-pin", "zzq"]);
	});

	it("keeps exact over prefix over substring inside a group", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzrel.md", "ZZREL-EXACT-BODY");
		writeSnippet(dir, "zzrel-style.md", "---\ncategory: style\n---\nZZREL-PREFIX-BODY");
		writeSnippet(dir, "zz-zzrel-tail.md", "ZZREL-SUBSTRING-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzrel");
		expect(pickerOrder(harness, ["zzrel", "zzrel-style", "zz-zzrel-tail"])).toEqual(["zzrel", "zzrel-style", "zz-zzrel-tail"]);
	});

	it("breaks equal relevance by category inside a group", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		// Three ordinary rows with identical relevance (equal prefix matches):
		// category ranks the styled row, then the named one, then the
		// uncategorized one.
		writeSnippet(dir, "zzbrk-a.md", "---\ncategory: style\n---\nZZBRK-A-BODY");
		writeSnippet(dir, "zzbrk-b.md", "---\ncategory: alpha\n---\nZZBRK-B-BODY");
		writeSnippet(dir, "zzbrk-c.md", "ZZBRK-C-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzbrk");
		expect(pickerOrder(harness, ["zzbrk-a", "zzbrk-b", "zzbrk-c"])).toEqual(["zzbrk-a", "zzbrk-b", "zzbrk-c"]);
	});

	it("puts the active row first within its group, alphabetically among equals", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzrank-a.md", "---\npinnable: true\ncategory: style\n---\nZZRANK-A-BODY");
		writeSnippet(dir, "zzrank-b.md", "---\npinnable: true\ncategory: style\n---\nZZRANK-B-BODY");
		writeRole(dir, "zzrank-role-a", "ROLE-RANK-A");
		writeRole(dir, "zzrank-role-b", "ROLE-RANK-B");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zzrank-b)");
		await harness.input("::zzrank-role-b");

		openPicker(harness, "::zzrank");
		expect(pickerOrder(harness, ["zzrank-role-a", "zzrank-role-b"])).toEqual(["zzrank-role-b", "zzrank-role-a"]);
		expect(pickerOrder(harness, ["zzrank-a", "zzrank-b"])).toEqual(["zzrank-b", "zzrank-a"]);
	});

	it("groups a role that also declares a category with the roles, not with that category", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzgrp-role", "ROLE-GRP-BODY", ["category: style"]);
		writeSnippet(dir, "zzgrp-style.md", "---\ncategory: style\n---\nZZGRP-STYLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzgrp");
		expect(pickerOrder(harness, ["zzgrp-role", "zzgrp-style"])).toEqual(["zzgrp-role", "zzgrp-style"]);
	});

	it("finds a snippet through its alias in the picker", async () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zzalias.md", "---\naliases: [zzalt]\n---\nZZALIAS-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzalt");
		expect(pickerRows(harness)).toContain("::zzalias");
	});

	it("shows one override row whose preview, accept, raw alias, and Right-arrow all use the effective definition", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(
			dir,
			"careful.md",
			"---\npinnable: true\ncategory: style\ndescription: PROJECT CAREFUL\n---\nPROJECT-CAREFUL-BODY",
		);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const items = buildSnippetAutocompleteItems(cwd, "safe");
		const rows = items.filter((item) => item.value === "careful");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.description).toBe("PROJECT CAREFUL");
		expect(items.some((item) => item.description?.includes("Think step by step"))).toBe(false);

		openPicker(harness, "::safe");
		expect(pickerRows(harness)).toContain("::careful");
		expect(pickerRows(harness)).toContain("PROJECT CAREFUL");
		harness.pressKey("\t");
		expect(harness.editorText()).toBe("::careful ");

		// Right-arrow on the same row pins the effective body, not the shadowed one.
		openPicker(harness, "::safe");
		harness.pressKey("\x1b[C");
		const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(prompt).toContain("PROJECT-CAREFUL-BODY");
		expect(prompt).not.toContain("Ask clarifying questions");

		// A raw alias invocation resolves that same definition.
		const raw = await harness.input("::safe");
		expect(raw?.text ?? "").toContain("PROJECT-CAREFUL-BODY");
		expect(raw?.text ?? "").not.toContain("Ask clarifying questions");
	});

	it("follows a canonical kind change through a bundled alias with one role row and activation", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "reflect", "PROJECT-ROLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const items = buildSnippetAutocompleteItems(cwd, "reframe");
		const rows = items.filter((item) => item.value === "reflect");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.isRole).toBe(true);
		expect(rows[0]?.description).toContain("PROJECT-ROLE-BODY");
		expect(items.some((item) => item.description?.includes("core intent"))).toBe(false);

		openPicker(harness, "::reframe");
		expect(pickerRows(harness)).toContain("::reflect");
		harness.pressKey("\t");
		expect(harness.editorText()).toBe("::reflect ");

		const submitted = await harness.input("::reframe");
		expect(roleAppends(harness)).toHaveLength(1);
		expect(lastRoleRecord(harness)?.role?.name).toBe("reflect");
		expect(submitted?.text ?? "").toContain("(role: reflect)");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("PROJECT-ROLE-BODY");
	});

	it("advertises no row for a canonical owner shadowed by a higher-tier alias", () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zz-other.md", "---\naliases: [careful]\n---\nZZ-OTHER-BODY");

		const items = buildSnippetAutocompleteItems(cwd, "careful");
		expect(items.filter((item) => item.value === "careful")).toHaveLength(0);
		expect(items.some((item) => item.value === "zz-other")).toBe(true);
		expect(items.some((item) => item.description?.startsWith("Think step by step"))).toBe(false);
		expect(expandTriggers("::careful", buildSnippetRegistry(cwd)).text).toBe("ZZ-OTHER-BODY");
	});

	it("clusters an active pinnable above a non-pinnable exact match", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzq.md", "ZZQ-EXACT-BODY");
		writeSnippet(dir, "zz-zzq-pinned.md", "---\npinnable: true\n---\nZZQ-PINNED-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zz-zzq-pinned)");

		openPicker(harness, "::zzq");
		expect(pickerOrder(harness, ["zzq", "zz-zzq-pinned"])).toEqual(["zz-zzq-pinned", "zzq"]);
	});

	it("keeps a reserved-canonical role out of the picker, even when queried by its alias", () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "pins", "PINS-ROLE-BODY", ["aliases: [captain]"]);
		writeRole(dir, "zz-second", "SECOND-BODY", ["aliases: [second-mate]"]);

		// The alias scores the row in as an exact match, so only the reserved
		// canonical name can be keeping it out.
		expect(buildSnippetAutocompleteItems(cwd, "captain").some((item) => item.value === "pins")).toBe(false);
		// A valid alias still brings its role row in — the check above is not vacuous.
		expect(buildSnippetAutocompleteItems(cwd, "second-mate").some((item) => item.value === "zz-second")).toBe(true);
	});
});

// ============================================================================
// Picker — role-like pins (`category: role`, a display classification)
//
// `category: role` on a PINNABLE snippet is display metadata, not a
// `kind: role`: the row takes the role violet and leads the first group, while
// every operational behavior stays a pin's — Right-arrow toggles it, the footer
// keeps the pin hint, a bare `::name` expands the body as a one-shot instead of
// selecting a conversation role, and the Q&A guard keeps its explicit-`::unpin`
// lifetime. Assertions run through rendered colors, row order, and real input,
// so a regression shows up as a color, a position, or an activation that
// changed.
// ============================================================================

describe("picker — role-like pins (`category: role`)", () => {
	/** A PINNABLE ordinary snippet authored with a display category — the
	 *  shape `category: role` turns into a role-like pin. */
	function writeCategorized(dir: string, name: string, category: string, body: string): void {
		writeSnippet(dir, `${name}.md`, ["---", "pinnable: true", `category: ${category}`, "---", body].join("\n"));
	}

	/** The rendered row naming one item, at a width that fits every label. The
	 *  name is anchored the way `pickerOrder` matches it, so a longer name that
	 *  merely starts with it can never be read back as this row. */
	function renderedRow(harness: SnippetsHarness, name: string): string {
		const row = itemRows(harness.renderWidget(80)!).find((r) => new RegExp(`::${name}(?![\\w-])`).test(stripAnsi(r)));
		if (!row) throw new Error(`no rendered row for ::${name}`);
		return row;
	}

	it("matches the `&` in the canonical name and inserts the canonical trigger on accept", async () => {
		const examplesDir = path.resolve(import.meta.dir, "../examples");
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "q&a.md", fs.readFileSync(path.join(examplesDir, "q&a.md"), "utf8"));
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// A partial `&` query — the character the old token class could not type.
		openPicker(harness, "::q&");
		expect(pickerRows(harness)).toContain("::q&a");

		// Accepting the canonical row splices the canonical trigger into the
		// buffer — the exact form the expansion resolves (queried exactly, so no
		// personal snippet can outrank the row this test is about).
		openPicker(harness, "::q&a");
		harness.pressKey("\t");
		expect(harness.editorText()).toBe("::q&a ");
		expect((await harness.input("::q&a"))?.text).toBeDefined();
	});

	it("completes the spaced alias across spaces, and never holds the dropdown open for prose", async () => {
		const examplesDir = path.resolve(import.meta.dir, "../examples");
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "q&a.md", fs.readFileSync(path.join(examplesDir, "q&a.md"), "utf8"));
		writeSnippet(dir, "zzprose.md", "ZZPROSE-BODY");
		// A decoy whose alias CONTAINS a phrase: an ungated substring match would
		// list it for that phrase, which is exactly what must not happen.
		writeSnippet(dir, "zzdecoy.md", "---\naliases: [zz-alpha and more]\n---\nZZDECOY-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// Prose after a single-word trigger is not a name being typed: no rows,
		// no dropdown (checked first, on a buffer that never opened one).
		openPicker(harness, "::alpha and more");
		expect(pickerRows(harness)).toBe("");
		openPicker(harness, "::zzprose and then");
		expect(pickerRows(harness)).toBe("");

		// An incomplete prefix of the spaced alias still offers its row...
		openPicker(harness, "::question and answ");
		expect(pickerRows(harness)).toContain("::q&a");

		// ...and Tab on the full alias completes to the canonical trigger.
		openPicker(harness, "::question and answer");
		expect(pickerRows(harness)).toContain("::q&a");
		harness.pressKey("\t");
		expect(harness.editorText()).toBe("::q&a ");
	});

	it("paints a `category: role` pin violet, a style pin green and an ordinary row plain — terminal and native, in that order", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeCategorized(dir, "zzrl-pin", "role", "ZZRL-PIN-BODY");
		writeCategorized(dir, "zzrl-style", "style", "ZZRL-STYLE-BODY");
		writeSnippet(dir, "zzrl-plain.md", "ZZRL-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzrl");

		expect(pickerOrder(harness, ["zzrl-pin", "zzrl-style", "zzrl-plain"])).toEqual(["zzrl-pin", "zzrl-style", "zzrl-plain"]);

		// The role-like pin is violet over the name alone: the checkbox behind
		// it stays in the normal foreground, exactly like the green row's mark.
		const pinRow = renderedRow(harness, "zzrl-pin");
		expect(colorSpans(pinRow, PURPLE)).toEqual(["::zzrl-pin"]);
		expect(colorSpans(pinRow, SUCCESS_SGR)).toHaveLength(0);
		expect(stripAnsi(pinRow)).toContain("☐");

		const styleRow = renderedRow(harness, "zzrl-style");
		expect(colorSpans(styleRow, SUCCESS_SGR)).toEqual(["::zzrl-style"]);
		expect(colorSpans(styleRow, PURPLE)).toHaveLength(0);

		const plainRow = renderedRow(harness, "zzrl-plain");
		expect(colorSpans(plainRow, PURPLE)).toHaveLength(0);
		expect(colorSpans(plainRow, SUCCESS_SGR)).toHaveLength(0);

		// Native surface: the violet travels as the raw-`ansi` label and still
		// resets before the mark, so the checkbox is not painted violet there
		// either.
		const tree = harness.describeWidget();
		if (tree == null) throw new Error("the picker described no native node");
		const described = (tree.c ?? []).filter((node) => node.k === "row");
		const pinLabel = described.find((row) => nativeText(row).includes("::zzrl-pin"))?.c?.[0];
		if (!pinLabel) throw new Error("no described label for ::zzrl-pin");
		expect(pinLabel.k).toBe("ansi");
		const text = pinLabel.p?.text ?? "";
		expect(colorSpans(text, PURPLE)).toEqual(["::zzrl-pin"]);
		expect(text.endsWith("☐")).toBe(true);
		// The violet is closed by a foreground reset before the mark, so the
		// checkbox is never painted with it.
		expect(text).toContain(`${PURPLE}::zzrl-pin${THEME_FG_RESET}`);
	});

	it("keeps the row a pin in the picker: Right-arrow toggles it, the footer keeps the pin hint, and no role is selected", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeCategorized(dir, "zzrlt-pin", "role", "ZZRLT-PIN-BODY");
		writeRole(dir, "zzrlt-role", "ZZRLT-ROLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// The role-like pin sorts before the real role (same tier, then
		// alphabetical), so both hints are read off the same picker.
		openPicker(harness, "::zzrlt");
		expect(pickerHint(harness)).toContain("right arrow to toggle pin");
		harness.pressKey("\x1b[B");
		expect(pickerHint(harness)).toContain("conversation role");

		// Back onto the pin and toggle it: the buffer is untouched, no role is
		// selected, and the body reaches the prompt as a pin.
		harness.pressKey("\x1b[A");
		harness.pressKey("\x1b[C");
		expect(harness.editorText()).toBe("::zzrlt");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(roleStatusText(harness)).toBe("");
		const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(prompt).toContain("ZZRLT-PIN-BODY");
		expect(prompt).not.toContain("ZZRLT-ROLE-BODY");
		expect(prompt).not.toContain("<operational-role");
	});

	it("expands a bare `::name` for a role-like pin as an ordinary one-shot, selecting no conversation role", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(
			dir,
			"zzrle-pin.md",
			"---\npinnable: true\ncategory: role\n---\n<append>\n<task>ZZRLE-PIN-BODY</task>\n</append>\n\nZZRLE-PIN-INLINE",
		);
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		const submitted = await harness.input("::zzrle-pin");
		expect(submitted?.text).toContain("ZZRLE-PIN-INLINE");
		expect(submitted?.text).toContain("ZZRLE-PIN-BODY");
		expect(submitted?.text).not.toContain("(role: zzrle-pin)");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(roleStatusText(harness)).toBe("");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("<operational-role");
	});

	it("normalizes `role` case- and whitespace-insensitively, while any other label stays an ordinary green pin", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeCategorized(dir, "zznorm-upper", "ROLE", "ZZNORM-UPPER-BODY");
		writeCategorized(dir, "zznorm-pad", "  Role  ", "ZZNORM-PAD-BODY");
		writeCategorized(dir, "zznorm-plural", "roles", "ZZNORM-PLURAL-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zznorm");

		for (const name of ["zznorm-pad", "zznorm-upper"]) {
			expect(colorSpans(renderedRow(harness, name), PURPLE)).toEqual([`::${name}`]);
		}
		const pluralRow = renderedRow(harness, "zznorm-plural");
		expect(colorSpans(pluralRow, PURPLE)).toHaveLength(0);
		expect(colorSpans(pluralRow, SUCCESS_SGR)).toEqual(["::zznorm-plural"]);

		// Both spellings of `role` lead the pinnables; the plural is a verbatim
		// label and stays in the second group.
		expect(pickerOrder(harness, ["zznorm-pad", "zznorm-upper", "zznorm-plural"])).toEqual([
			"zznorm-pad",
			"zznorm-upper",
			"zznorm-plural",
		]);
	});

	it("keeps a NON-pinnable `category: role` snippet ordinary — no violet, no checkbox, no leading group", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zznp-role-cat.md", "---\ncategory: role\n---\nZZNP-ROLE-CAT-BODY");
		writeCategorized(dir, "zznp-pin", "role", "ZZNP-PIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zznp");

		expect(pickerOrder(harness, ["zznp-pin", "zznp-role-cat"])).toEqual(["zznp-pin", "zznp-role-cat"]);
		expect(colorSpans(renderedRow(harness, "zznp-pin"), PURPLE)).toEqual(["::zznp-pin"]);
		const plainRow = renderedRow(harness, "zznp-role-cat");
		expect(colorSpans(plainRow, PURPLE)).toHaveLength(0);
		expect(colorSpans(plainRow, SUCCESS_SGR)).toHaveLength(0);
		expect(stripAnsi(plainRow)).not.toContain("☐");
	});

	it("keeps the Q&A guard's explicit-`::unpin` lifetime on a `category: role` pin", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzrlq-mode.md", "---\npinnable: true\ncategory: role\nguard: qa\n---\nZZRLQ-MODE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(zzrlq-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzrlq-out.txt"), content: "x" }))).toBe(true);
		expect(roleAppends(harness)).toHaveLength(0);
		expect(roleStatusText(harness)).toBe("");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ZZRLQ-MODE-BODY");

		// Prose approval does not release it — the pin's own `::unpin` does.
		await harness.input("sounds good, go ahead");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
		await harness.input("::unpin(zzrlq-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzrlq-out.txt"), content: "x" }))).toBe(false);
	});
});

describe("picker — insertion and toggle stability", () => {
	it("inserts a role trigger on Tab without activating the role until submission", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzcat-role", "ROLE-CAT-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzcat-role");
		harness.pressKey("\t");
		expect(harness.editorText()).toBe("::zzcat-role ");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-CAT-BODY");

		await harness.input(harness.editorText().trim());
		expect(roleAppends(harness)).toHaveLength(1);
		expect(lastRoleRecord(harness)?.role?.name).toBe("zzcat-role");
	});

	it("selects a role immediately on Enter and clears it on a second Enter, leaving the buffer alone", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzent-role", "ROLE-ENTER-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzent-role");
		harness.pressKey("\r");
		expect(harness.editorText()).toBe("::zzent-role");
		expect(lastRoleRecord(harness)?.role?.name).toBe("zzent-role");
		expect(roleStatusText(harness)).toBe("Role: zzent-role");
		expect(pickerHint(harness)).toContain("enter to clear");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ROLE-ENTER-BODY");

		harness.pressKey("\r");
		expect(lastRoleRecord(harness)?.role).toBeNull();
		expect(roleStatusText(harness)).toBe("");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("ROLE-ENTER-BODY");
	});

	it("refuses an Enter role selection in a subagent session", async () => {
		const cwd = tempDir();
		writeRole(path.join(cwd, ".omp", "snippets"), "zzsub-role", "ROLE-SUB-BODY");
		const harness = createSnippetsHarness(cwd, { agentKind: "sub" });
		await harness.emit("session_start");

		openPicker(harness, "::zzsub-role");
		harness.pressKey("\r");
		expect(roleAppends(harness)).toHaveLength(0);
		expect(roleStatusText(harness)).toBe("");
	});

	it("toggles a pin on Enter in place, binding a parameterized body blank, and still inserts ordinary rows", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzcap.md", "---\npinnable: true\n---\nCap at [$1] chars");
		writeSnippet(dir, "zzplain.md", "ZZPLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzcap");
		harness.pressKey("\r");
		expect(harness.editorText()).toBe("::zzcap");
		expect(pinnedStylesBlock(promptText(await harness.beforeAgentStart(["NATIVE-BASE"])))).toContain("Cap at [] chars");

		harness.pressKey("\r");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("Cap at");

		openPicker(harness, "::zzplain");
		harness.pressKey("\r");
		expect(harness.editorText()).toBe("::zzplain ");
	});

	it("keeps the highlighted row in place when the right-arrow toggle changes pin state", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzpin-a.md", "---\npinnable: true\ncategory: style\n---\nZZPIN-A-BODY");
		writeSnippet(dir, "zzpin-b.md", "---\npinnable: true\ncategory: style\n---\nZZPIN-B-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzpin");
		expect(pickerOrder(harness, ["zzpin-a", "zzpin-b"])).toEqual(["zzpin-a", "zzpin-b"]);

		harness.pressKey("\x1b[B"); // move the highlight to the second row
		harness.pressKey("\x1b[C"); // toggle that row's pin in place
		expect(pickerOrder(harness, ["zzpin-a", "zzpin-b"])).toEqual(["zzpin-a", "zzpin-b"]);

		harness.pressKey("\t");
		expect(harness.editorText()).toBe("::zzpin-b ");

		expect(pinnedStylesBlock(promptText(await harness.beforeAgentStart(["NATIVE-BASE"])))).toContain("ZZPIN-B-BODY");
	});

	it("unsubscribes the picker on session_shutdown and reinstalls it on the next session_start", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzpin-a.md", "---\npinnable: true\ncategory: style\n---\nZZPIN-A-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		openPicker(harness, "::zzpin");
		expect(pickerRows(harness)).toContain("zzpin-a");

		await harness.emit("session_shutdown");
		expect(harness.pressKey("x")).toBeUndefined();
		expect(pickerRows(harness)).toBe("");

		await harness.emit("session_start");
		openPicker(harness, "::zzpin");
		expect(pickerRows(harness)).toContain("zzpin-a");
	});

	it("never repaints the picker from a debounce callback queued before disposal", async () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zzpin-a.md", "---\npinnable: true\ncategory: style\n---\nZZPIN-A-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// One keystroke queues one debounce callback against the live picker.
		openPicker(harness, "::zzpin");
		const handlerBeforeSwitch = harness.capturedKeyHandler();
		harness.pressKey("n");
		expect(harness.pendingTimers()).toBe(1);

		// A session switch reinstalls the picker on the new context, disposing the
		// one that queued the callback — its last write is the clearing one.
		await harness.emit("session_switch", { reason: "resume", previousSessionFile: undefined });
		const writesAfterSwitch = harness.widgetWrites.length;
		expect(harness.widgetWrites.at(-1)?.content).toBeUndefined();

		harness.flushTimers();
		expect(harness.widgetWrites.length).toBe(writesAfterSwitch);

		// The host may still hold the disposed handler, so it must stay inert too.
		expect(handlerBeforeSwitch?.("x")).toBeUndefined();
		expect(harness.pendingTimers()).toBe(0);
		expect(harness.widgetWrites.length).toBe(writesAfterSwitch);

		// The freshly installed picker is unaffected.
		openPicker(harness, "::zzpin");
		expect(pickerRows(harness)).toContain("::zzpin-a");

		// Same guarantee for a callback queued right before shutdown.
		harness.pressKey("n");
		expect(harness.pendingTimers()).toBe(1);
		await harness.emit("session_shutdown");
		const writesAfterShutdown = harness.widgetWrites.length;
		harness.flushTimers();
		expect(harness.widgetWrites.length).toBe(writesAfterShutdown);
		expect(harness.widgetWrites.at(-1)?.content).toBeUndefined();
	});

	it("hints what sending a role row does, distinctly from the pin-toggle hint", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeRole(dir, "zzhint-role", "ROLE-HINT-BODY");
		writeSnippet(dir, "zzhint-pin.md", "---\npinnable: true\ncategory: style\n---\nZZHINT-PIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzhint-role");
		const inactiveRoleHint = pickerHint(harness);
		expect(inactiveRoleHint.trim().length).toBeGreaterThan(0);

		openPicker(harness, "::zzhint-pin");
		expect(pickerHint(harness)).not.toBe(inactiveRoleHint);

		await harness.input("::zzhint-role");
		openPicker(harness, "::zzhint-role");
		expect(pickerHint(harness)).not.toBe(inactiveRoleHint);
	});
});

// ============================================================================
// QA guard — snapshot, activation gating, and tool interception
//
// A `guard: qa` pin is the enforced Q&A-only mode: the guard is snapshotted
// with the pin body at activation, and the extension answers every `tool_call`
// / `before_subagent_spawn` the host dispatches through the same registered
// handlers a live session uses. Assertions stay mechanism-level: which routes
// come back blocked, whether a refused activation left the pinned set intact,
// and whether the guard follows the pin's exact lifetime.
// ============================================================================

/** A pinnable snippet whose frontmatter opts into the enforced Q&A guard. */
function writeQaSnippet(dir: string, name: string, body: string, extraFrontmatter: string[] = []): void {
	writeSnippet(dir, `${name}.md`, ["---", "pinnable: true", "guard: qa", ...extraFrontmatter, "---", body].join("\n"));
}

/** A harness with one guarded pin already active under the default gate
 *  (idle agent, no owned jobs). */
async function guardedHarness(options: HarnessOptions = {}): Promise<{ harness: SnippetsHarness; cwd: string }> {
	const cwd = tempDir();
	writeQaSnippet(path.join(cwd, ".omp", "snippets"), "zzqa-mode", "ZZQA-MODE-BODY");
	const harness = createSnippetsHarness(cwd, options);
	await harness.emit("session_start");
	await harness.input("::pin(zzqa-mode)");
	return { harness, cwd };
}

/** A block verdict needs both the flag and a non-empty reason — a bare
 *  `{ block: true }` with nothing for the model would be a silent denial. */
function toolBlocked(result: { block?: boolean; reason?: string } | undefined): boolean {
	return result?.block === true && typeof result.reason === "string" && result.reason.length > 0;
}

describe("QA guard — pin helpers", () => {
	it("snapshots the guard with the pin body when the activation gate allows it", () => {
		const registry = pinnableRegistryFrom({ "zzqa-mode": { raw: "ZZQA-MODE-BODY", pinnable: true, guard: "qa" } });
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("zzqa-mode", registry, pinned, () => null)).toEqual({ status: "pinned", autoUnpinned: [] });
		expect(pinned.get("zzqa-mode")).toEqual({ content: "ZZQA-MODE-BODY", guard: "qa" });
	});

	it("keeps the guard of an active snapshot when the definition is refreshed without one", () => {
		// The file dropped `guard: qa` after the pin was armed.
		const registry = pinnableRegistryFrom({ "zzqa-mode": { raw: "ZZQA-MODE-CHANGED", pinnable: true } });
		const pinned = new Map<string, PinnedSnippet>([["zzqa-mode", { content: "ZZQA-MODE-BODY", guard: "qa" }]]);

		// A refresh re-reads the body but keeps enforcement: only an explicit
		// unpin (or a group replacement) may end it.
		expect(pinSnippetByName("zzqa-mode", registry, pinned, () => null)).toEqual({ status: "pinned", autoUnpinned: [] });
		expect(pinned.get("zzqa-mode")).toEqual({ content: "ZZQA-MODE-CHANGED", guard: "qa" });

		// And the refresh is still gated like any guarded activation.
		const refused = () => "zzqa gate refused";
		expect(pinSnippetByName("zzqa-mode", registry, pinned, refused)).toEqual({ status: "guard-refused", reason: "zzqa gate refused" });
		expect(pinned.get("zzqa-mode")).toEqual({ content: "ZZQA-MODE-CHANGED", guard: "qa" });

		// Fails closed with no gate at all, exactly like a live guarded definition.
		expect(pinSnippetByName("zzqa-mode", registry, pinned).status).toBe("guard-refused");
		expect(pinned.get("zzqa-mode")?.guard).toBe("qa");
	});

	it("fails closed when a guarded pin is attempted without an activation gate", () => {
		const registry = pinnableRegistryFrom({ "zzqa-mode": { raw: "ZZQA-MODE-BODY", pinnable: true, guard: "qa" } });
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("zzqa-mode", registry, pinned).status).toBe("guard-refused");
		expect(pinned.size).toBe(0);

		const rewritten = processPinTriggers("::pin(zzqa-mode)", registry, pinned);
		expect(rewritten).toContain("zzqa-mode");
		expect(pinned.size).toBe(0);
	});

	it("keeps the pinned set and group siblings untouched when the gate refuses", () => {
		const registry = pinnableRegistryFrom({
			"zzqa-mode": { raw: "ZZQA-MODE-BODY", pinnable: true, guard: "qa", group: "zzqa-pair" },
			"zzqa-sib": { raw: "ZZQA-SIB-BODY", pinnable: true, group: "zzqa-pair" },
		});
		const pinned = new Map<string, PinnedSnippet>();
		expect(pinSnippetByName("zzqa-sib", registry, pinned).status).toBe("pinned");
		const refused = () => "zzqa gate refused";

		expect(pinSnippetByName("zzqa-mode", registry, pinned, refused).status).toBe("guard-refused");
		expect(pinned.has("zzqa-sib")).toBe(true);
		expect(pinned.has("zzqa-mode")).toBe(false);

		const autoUnpinned: string[] = [];
		processPinTriggers("::pin(zzqa-mode)", registry, pinned, autoUnpinned, refused);
		expect(autoUnpinned).toEqual([]);
		expect(pinned.has("zzqa-sib")).toBe(true);
		expect(pinned.has("zzqa-mode")).toBe(false);
	});

	it("emits one extra notice block only when a pinned descriptor carries the guard", () => {
		const plain = new Map<string, PinnedSnippet>([["zzqa-plain", { content: "ZZQA-PLAIN-BODY" }]]);
		const guarded = new Map<string, PinnedSnippet>([["zzqa-mode", { content: "ZZQA-MODE-BODY", guard: "qa" }]]);
		expect(buildPinnedSystemPromptBlocks(plain)).toHaveLength(1);
		expect(buildPinnedSystemPromptBlocks(guarded)).toHaveLength(2);
	});
});

describe("QA guard — frontmatter parsing", () => {
	it("arms only `guard: qa` on a pinnable ordinary snippet and diagnoses every other form", () => {
		const dir = tempDir();
		writeQaSnippet(dir, "zzqa-ok", "ZZQA-OK-BODY");
		writeSnippet(dir, "zzqa-bad-value.md", "---\npinnable: true\nguard: strict\n---\nZZQA-BAD-VALUE-BODY");
		writeSnippet(dir, "zzqa-role.md", "---\nkind: role\nguard: qa\n---\nZZQA-ROLE-BODY");
		writeSnippet(dir, "zzqa-oneshot.md", "---\nguard: qa\n---\nZZQA-ONESHOT-BODY");
		const registry = loadSnippetDir(dir);

		expect(registry.get("zzqa-ok")?.guard).toBe("qa");
		for (const name of ["zzqa-bad-value", "zzqa-role", "zzqa-oneshot"]) {
			expect({ name, guard: registry.get(name)?.guard ?? null, diagnosed: (registry.get(name)?.diagnostics ?? []).length > 0 }).toEqual({ name, guard: null, diagnosed: true });
		}
	});
});

describe("QA guard — bundled q&a opt-in", () => {
	it("enforces the shipped q&a example once pinned through an alias, releasing it on the canonical ::unpin", async () => {
		const cwd = tempDir();
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// Pinned through the old alias, released through the canonical id: one
		// definition, one pin, whichever name addresses it.
		await harness.input("::pin(plan-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(true);

		await harness.input("::unpin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(false);
	});

	it("pins and releases the same pin through the spaced alias and the canonical id, in either direction", async () => {
		const cwd = tempDir();
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(question and answer)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(true);

		await harness.input("::unpin(planning)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(false);

		await harness.input("::pin(Q&A)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		await harness.input("::unpin(ask-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
	});

	it("keeps the Q&A guard active until the last distinct no-group guarded pin is released", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zzqa-first", "ZZQA-FIRST-BODY");
		writeQaSnippet(dir, "zzqa-second", "ZZQA-SECOND-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(zzqa-first)");
		await harness.input("::pin(zzqa-second)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toContain("zzqa-first");
		expect(harness.statuses.get(QA_STATUS_KEY)).toContain("zzqa-second");
		const both = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(both).toContain("ZZQA-FIRST-BODY");
		expect(both).toContain("ZZQA-SECOND-BODY");
		const bothBlocked = await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" });
		expect(toolBlocked(bothBlocked)).toBe(true);
		expect(bothBlocked?.reason).toContain("zzqa-first");
		expect(bothBlocked?.reason).toContain("zzqa-second");

		await harness.input("::unpin(zzqa-first)");
		const survivorStatus = harness.statuses.get(QA_STATUS_KEY) ?? "";
		expect(survivorStatus).toContain("zzqa-second");
		expect(survivorStatus).not.toContain("zzqa-first");
		const survivorPrompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(survivorPrompt).not.toContain("ZZQA-FIRST-BODY");
		expect(survivorPrompt).toContain("ZZQA-SECOND-BODY");

		const survivorTool = await harness.toolCall("bash", { command: "true" });
		expect(toolBlocked(survivorTool)).toBe(true);
		expect(survivorTool?.reason).toContain("zzqa-second");
		expect(survivorTool?.reason).not.toContain("zzqa-first");
		const survivorSpawn = await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] });
		expect(toolBlocked(survivorSpawn)).toBe(true);
		expect(survivorSpawn?.reason).toContain("zzqa-second");
		expect(survivorSpawn?.reason).not.toContain("zzqa-first");

		await harness.input("::unpin(zzqa-second)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(false);
		expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(false);
	});

	it("does not arm the guard from a bare ::q&a one-shot trigger", async () => {
		const cwd = tempDir();
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		expect(await harness.input("::q&a")).toBeDefined();
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(false);
	});

	it("keeps one guarded identity through inherited aliases after a project override", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "q&a", "PROJECT-QA-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		// Pinned through an inherited alias: the snapshot and the guard come
		// from the effective project definition, never the bundled shadow.
		await harness.input("::pin(qa)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
		expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(true);
		const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(prompt).toContain("PROJECT-QA-BODY");
		expect(prompt).not.toContain("Stay in Q&A mode");

		// One entry: released through a different inherited alias, re-armed
		// through another, then released by canonical id.
		await harness.input("::unpin(planning)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(false);

		await harness.input("::pin(plan-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(true);

		await harness.input("::unpin(q&a)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.beforeSubagentSpawn({ agent: "task", invocationKind: "task", patterns: [] }))).toBe(false);

		// Right-arrow on the single q&a row arms the same effective pin.
		openPicker(harness, "::qa");
		harness.pressKey("\x1b[C");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("PROJECT-QA-BODY");
	});
});

describe("QA guard — activation gating", () => {
	it("refuses a guarded pin while busy, while owned jobs run, or when the gate API is missing — ordinary pins still work", async () => {
		const gates: Array<{ name: string; apply: (harness: SnippetsHarness) => void }> = [
			{ name: "mid-turn", apply: (harness) => harness.setIdle(false) },
			{ name: "owned jobs in flight", apply: (harness) => harness.setJobs({ running: [{ id: "job-1", label: "zzqa job" }] }) },
			{ name: "gate API missing", apply: (harness) => harness.removeRuntimeApis() },
		];
		for (const gate of gates) {
			const cwd = tempDir();
			const dir = path.join(cwd, ".omp", "snippets");
			writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY");
			writeSnippet(dir, "zzqa-plain.md", "---\npinnable: true\n---\nZZQA-PLAIN-BODY");
			writeSnippet(dir, "zzqa-extra.md", "---\npinnable: true\n---\nZZQA-EXTRA-BODY");
			const harness = createSnippetsHarness(cwd);
			await harness.emit("session_start");
			await harness.input("::pin(zzqa-plain)");
			gate.apply(harness);

			const refused = await harness.input("::pin(zzqa-mode)");
			await harness.input("::pin(zzqa-extra)");
			const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
			expect({
				gate: gate.name,
				refusalNames: refused?.text?.includes("zzqa-mode") ?? false,
				modePinned: prompt.includes("ZZQA-MODE-BODY"),
				plainPinned: prompt.includes("ZZQA-PLAIN-BODY"),
				extraPinned: prompt.includes("ZZQA-EXTRA-BODY"),
				qaStatus: harness.statuses.get(QA_STATUS_KEY) ?? null,
				blocked: toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" })),
			}).toEqual({ gate: gate.name, refusalNames: true, modePinned: false, plainPinned: true, extraPinned: true, qaStatus: null, blocked: false });
		}
	});

	it("rejects the picker's Right-arrow toggle for a guarded row while busy, keeping the pinned group sibling", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY", ["group: zzqa-pair"]);
		writeSnippet(dir, "zzqa-plain.md", "---\npinnable: true\ngroup: zzqa-pair\n---\nZZQA-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zzqa-plain)");
		harness.setIdle(false);

		openPicker(harness, "::zzqa");
		// The pinned sibling sorts first; move the highlight onto the guarded row.
		expect(pickerOrder(harness, ["zzqa-mode", "zzqa-plain"])).toEqual(["zzqa-plain", "zzqa-mode"]);
		harness.pressKey("\x1b[B");
		const noticesBefore = harness.notices.length;
		harness.pressKey("\x1b[C");
		expect(harness.notices.length).toBeGreaterThan(noticesBefore);

		const afterRefusal = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect({
			modePinned: afterRefusal.includes("ZZQA-MODE-BODY"),
			plainPinned: afterRefusal.includes("ZZQA-PLAIN-BODY"),
			blocked: toolBlocked(await harness.toolCall("bash", { command: "true" })),
		}).toEqual({ modePinned: false, plainPinned: true, blocked: false });

		// Same row, gate released: the toggle now pins it and arms the guard,
		// replacing the sibling through the shared group.
		harness.setIdle(true);
		openPicker(harness, "::zzqa");
		harness.pressKey("\x1b[B");
		harness.pressKey("\x1b[C");
		const accepted = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(accepted).toContain("ZZQA-MODE-BODY");
		expect(accepted).not.toContain("ZZQA-PLAIN-BODY");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
	});

	it("keeps an already-active guarded pin and its guard when a re-pin is refused", async () => {
		const { harness } = await guardedHarness();
		harness.setIdle(false);

		const refused = await harness.input("::pin(zzqa-mode)");
		expect(refused?.text).toContain("zzqa-mode");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);
	});

	it("refuses activation on an unreadable idle/job state without touching pins or group siblings", async () => {
		const states: Array<{ name: string; apply: (harness: SnippetsHarness) => void }> = [
			{ name: "undefined snapshot", apply: (harness) => harness.setJobs(undefined) },
			{ name: "snapshot without a running array", apply: (harness) => harness.setJobs({}) },
			{ name: "non-boolean idle", apply: (harness) => harness.setIdle(undefined) },
		];
		for (const state of states) {
			const cwd = tempDir();
			const dir = path.join(cwd, ".omp", "snippets");
			writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY", ["group: zzqa-pair"]);
			writeSnippet(dir, "zzqa-plain.md", "---\npinnable: true\ngroup: zzqa-pair\n---\nZZQA-PLAIN-BODY");
			const harness = createSnippetsHarness(cwd);
			await harness.emit("session_start");
			await harness.input("::pin(zzqa-plain)");
			state.apply(harness);

			const refused = await harness.input("::pin(zzqa-mode)");
			const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
			expect({
				state: state.name,
				refusalNames: refused?.text?.includes("zzqa-mode") ?? false,
				modePinned: prompt.includes("ZZQA-MODE-BODY"),
				siblingPinned: prompt.includes("ZZQA-PLAIN-BODY"),
				blocked: toolBlocked(await harness.toolCall("bash", { command: "true" })),
			}).toEqual({ state: state.name, refusalNames: true, modePinned: false, siblingPinned: true, blocked: false });
		}
	});
});

describe("QA guard — snapshot and lifetime", () => {
	it("releases a guarded `&` pin by its canonical name after its definition file is deleted, leaving unrelated pins alone", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zz&mode", "ZZ-AMP-MODE-BODY");
		writeSnippet(dir, "zz style.md", "---\npinnable: true\n---\nZZ-SPACE-STYLE-BODY");
		// A shorter name that survives the deletion: without preferring the pinned
		// key, `::unpin(zz&mode)` would resolve to this live `zz` and unpin it.
		writeSnippet(dir, "zz.md", "---\npinnable: true\n---\nZZ-SHORT-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		await harness.input("::pin(zz)");
		await harness.input("::pin(zz style)");
		await harness.input("::pin(zz&mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzamp-out.txt"), content: "x" }))).toBe(true);

		// Both definition files are gone: the pins stay (they are snapshots), and
		// each canonical name — `&` and space included — must still release its own
		// pin. A name that no longer resolves in the registry must never trap the
		// guard, and must never take an unrelated pin down with it.
		fs.rmSync(path.join(dir, "zz&mode.md"));
		fs.rmSync(path.join(dir, "zz style.md"));
		await harness.input("::unpin(zz&mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzamp-out.txt"), content: "x" }))).toBe(false);
		const afterGuard = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(afterGuard).toContain("ZZ-SHORT-BODY");
		expect(afterGuard).toContain("ZZ-SPACE-STYLE-BODY");
		expect(afterGuard).not.toContain("ZZ-AMP-MODE-BODY");

		await harness.input("::unpin(zz style)");
		const afterStyle = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(afterStyle).toContain("ZZ-SHORT-BODY");
		expect(afterStyle).not.toContain("ZZ-SPACE-STYLE-BODY");
	});

	it("keeps the guard and the pinned body snapshot after the definition changes on disk", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zzqa-mode)");

		// The file loses the guard and changes body: the pin is a snapshot.
		writeSnippet(dir, "zzqa-mode.md", "---\npinnable: true\n---\nZZQA-MODE-CHANGED");
		const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(prompt).toContain("ZZQA-MODE-BODY");
		expect(prompt).not.toContain("ZZQA-MODE-CHANGED");
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(true);

		// Re-pinning the changed definition arms nothing — the guard came from
		// the snapshot, not from the live file.
		await harness.input("::unpin(zzqa-mode)");
		await harness.input("::pin(zzqa-mode)");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ZZQA-MODE-CHANGED");
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(false);
	});

	it("does not arm the guard when the definition only gains it after the pin", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeSnippet(dir, "zzqa-late.md", "---\npinnable: true\n---\nZZQA-LATE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zzqa-late)");

		writeQaSnippet(dir, "zzqa-late", "ZZQA-LATE-BODY");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(false);
	});

	it("keeps the guard across an in-process /new (session switch)", async () => {
		const { harness, cwd } = await guardedHarness();
		await harness.emit("session_switch", { reason: "new", previousSessionFile: undefined });

		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("ZZQA-MODE-BODY");
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(true);
	});

	it("keeps enforcement when the definition is refreshed without its guard metadata", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zzqa-mode)");
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("<qa-enforcement>");

		// The file loses `guard: qa` and the user refreshes the pin: a source edit
		// must not unlock the session — the enforcement block stays, and the write
		// stays blocked until the explicit unpin below.
		writeSnippet(dir, "zzqa-mode.md", "---\npinnable: true\n---\nZZQA-MODE-CHANGED");
		await harness.input("::pin(zzqa-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).toContain("<qa-enforcement>");
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(true);

		await harness.input("::unpin(zzqa-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(promptText(await harness.beforeAgentStart(["NATIVE-BASE"]))).not.toContain("<qa-enforcement>");
		expect(toolBlocked(await harness.toolCall("write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }))).toBe(false);
	});

	it("drops the guard on ::unpin while an unrelated pin and the active role survive", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY");
		writeSnippet(dir, "zzqa-plain.md", "---\npinnable: true\n---\nZZQA-PLAIN-BODY");
		writeRole(dir, "zzqa-role", "ZZQA-ROLE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::zzqa-role");
		await harness.input("::pin(zzqa-plain)");
		await harness.input("::pin(zzqa-mode)");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);

		await harness.input("::unpin(zzqa-mode)");
		const prompt = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(prompt).toContain("ZZQA-PLAIN-BODY");
		expect(prompt).toContain("ZZQA-ROLE-BODY");
		expect(prompt).not.toContain("ZZQA-MODE-BODY");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(false);
	});

	it("drops the guard when the guarded pin is replaced through its group", async () => {
		const cwd = tempDir();
		const dir = path.join(cwd, ".omp", "snippets");
		writeQaSnippet(dir, "zzqa-mode", "ZZQA-MODE-BODY", ["group: zzqa-pair"]);
		writeSnippet(dir, "zzqa-other.md", "---\npinnable: true\ngroup: zzqa-pair\n---\nZZQA-OTHER-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		await harness.input("::pin(zzqa-mode)");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);

		await harness.input("::pin(zzqa-other)");
		const replaced = promptText(await harness.beforeAgentStart(["NATIVE-BASE"]));
		expect(replaced).toContain("ZZQA-OTHER-BODY");
		expect(replaced).not.toContain("ZZQA-MODE-BODY");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(false);
	});

	it("drops the guard when the guarded pin is toggled off with the picker's Right arrow", async () => {
		const cwd = tempDir();
		writeQaSnippet(path.join(cwd, ".omp", "snippets"), "zzqa-mode", "ZZQA-MODE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");

		openPicker(harness, "::zzqa");
		harness.pressKey("\x1b[C");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(true);

		harness.pressKey("\x1b[C");
		expect(toolBlocked(await harness.toolCall("bash", { command: "true" }))).toBe(false);
	});
});

describe("QA guard — tool interception", () => {
	it("blocks execution, mutation, delegation, and unknown tools under a yolo approval mode", async () => {
		const { harness, cwd } = await guardedHarness({ approvalMode: "yolo" });
		const routes: Array<[string, unknown]> = [
			["write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }],
			["edit", { path: path.join(cwd, "zzqa-out.txt"), old_string: "a", new_string: "b" }],
			["bash", { command: "rm -rf /tmp/zzqa" }],
			["eval", { language: "py", code: "print(1)" }],
			["task", { description: "zzqa", prompt: "zzqa" }],
			["mcp__zzqa__write", { args: {} }],
			["computer", { action: "screenshot" }],
			["browser", { action: "navigate", url: "https://example.com" }],
			["zzqa-custom-tool", { anything: true }],
		];
		for (const [toolName, input] of routes) {
			const result = await harness.toolCall(toolName, input);
			expect({ toolName, blocked: toolBlocked(result) }).toEqual({ toolName, blocked: true });
		}
	});

	it("keeps read-only investigation, session state, and readonly LSP routes allowed", async () => {
		const { harness } = await guardedHarness();
		const routes: Array<[string, unknown]> = [
			["read", { path: "zzqa.ts" }],
			["grep", { pattern: "zzqa" }],
			["glob", { pattern: "*.ts" }],
			["web_search", { query: "zzqa" }],
			["ask", { question: "zzqa?" }],
			["todo", { action: "list" }],
			["wait", {}],
			["lsp", { action: "definition", file: "zzqa.ts", line: 1 }],
			["lsp", { action: "type_definition", file: "zzqa.ts", line: 1 }],
			["lsp", { action: "implementation", file: "zzqa.ts", line: 1 }],
			["lsp", { action: "references", file: "zzqa.ts", line: 1 }],
			["lsp", { action: "hover", file: "zzqa.ts", line: 1 }],
			["lsp", { action: "symbols", query: "zzqa" }],
			["lsp", { action: "diagnostics", file: "zzqa.ts" }],
			["lsp", { action: "status" }],
			["lsp", { action: "capabilities" }],
			["lsp", { action: "code_actions", file: "zzqa.ts", line: 1 }],
			["lsp", { action: "code_actions", file: "zzqa.ts", line: 1, apply: false }],
			["write", { path: "xd://lsp", content: JSON.stringify({ action: "hover", file: "zzqa.ts", line: 1 }) }],
			["write", { path: "xd://lsp", content: JSON.stringify({ action: "code_actions", file: "zzqa.ts", apply: false }) }],
		];
		for (const [toolName, input] of routes) {
			const result = await harness.toolCall(toolName, input);
			expect({ toolName, input, blocked: toolBlocked(result) }).toEqual({ toolName, input, blocked: false });
		}
	});

	it("blocks LSP mutation/raw routes and every mounted write that is not exact xd://lsp readonly JSON", async () => {
		const { harness, cwd } = await guardedHarness();
		const routes: Array<[string, unknown]> = [
			["lsp", { action: "rename", file: "zzqa.ts", line: 1, new_name: "zzqa2.ts" }],
			["lsp", { action: "rename_file", file: "zzqa.ts", new_name: "zzqa2.ts" }],
			["lsp", { action: "request", payload: "{}" }],
			["lsp", { action: "reload" }],
			["lsp", { action: "code_actions", file: "zzqa.ts", line: 1, apply: true }],
			["lsp", { action: "code_actions", file: "zzqa.ts", line: 1, apply: "yes" }],
			["lsp", { action: "zzqa-unknown-action" }],
			["lsp", {}],
			["lsp", "not-an-object"],
			["write", { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "zzqa.ts", new_name: "zzqa2.ts" }) }],
			["write", { path: "xd://lsp", content: JSON.stringify({ action: "code_actions", file: "zzqa.ts", apply: true }) }],
			["write", { path: "xd://lsp", content: "not json" }],
			["write", { path: "xd://lsp", content: JSON.stringify(["hover"]) }],
			["write", { path: "xd://lsp", content: 42 }],
			["write", { path: "xd://lsp/extra", content: JSON.stringify({ action: "hover" }) }],
			["write", { path: "xd://lsp?action=hover", content: "{}" }],
			["write", { path: "xd://LSP", content: JSON.stringify({ action: "hover" }) }],
			["write", { path: "xd://debug", content: "{}" }],
			["write", { path: "local://zzqa.md", content: "x" }],
			["write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }],
			["write", {}],
		];
		for (const [toolName, input] of routes) {
			const result = await harness.toolCall(toolName, input);
			expect({ toolName, input, blocked: toolBlocked(result) }).toEqual({ toolName, input, blocked: true });
		}
	});

	it("leaves the same mutation routes untouched while no guarded pin is active", async () => {
		const cwd = tempDir();
		writeSnippet(path.join(cwd, ".omp", "snippets"), "zzqa-plain.md", "---\npinnable: true\n---\nZZQA-PLAIN-BODY");
		const harness = createSnippetsHarness(cwd, { approvalMode: "yolo" });
		await harness.emit("session_start");
		await harness.input("::pin(zzqa-plain)");

		const routes: Array<[string, unknown]> = [
			["write", { path: path.join(cwd, "zzqa-out.txt"), content: "x" }],
			["edit", { path: path.join(cwd, "zzqa-out.txt"), old_string: "a", new_string: "b" }],
			["bash", { command: "true" }],
			["eval", { language: "js", code: "1" }],
			["task", { description: "zzqa", prompt: "zzqa" }],
			["zzqa-custom-tool", { anything: true }],
		];
		for (const [toolName, input] of routes) {
			const result = await harness.toolCall(toolName, input);
			expect({ toolName, blocked: toolBlocked(result) }).toEqual({ toolName, blocked: false });
		}
	});

	it("denies subagent spawns while the guard is active and releases them once unpinned", async () => {
		const { harness } = await guardedHarness();
		const spawn = { agent: "task", invocationKind: "task", patterns: [], spawnKey: "zzqa-spawn" };
		const denied = await harness.beforeSubagentSpawn(spawn);
		expect(denied?.block).toBe(true);
		expect(denied?.reason).toBeTruthy();

		await harness.input("::unpin(zzqa-mode)");
		expect((await harness.beforeSubagentSpawn(spawn))?.block).not.toBe(true);
	});

	it("adds the enforcement notice and Q&A-only status only while the guard is active", async () => {
		const cwd = tempDir();
		writeQaSnippet(path.join(cwd, ".omp", "snippets"), "zzqa-mode", "ZZQA-MODE-BODY");
		const harness = createSnippetsHarness(cwd);
		await harness.emit("session_start");
		const native = ["NATIVE-BASE"];

		await harness.input("::pin(zzqa-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeDefined();
		const guarded = await harness.beforeAgentStart(native);
		expect(guarded?.systemPrompt).toHaveLength(native.length + 2);
		expect(promptText(guarded)).toContain("ZZQA-MODE-BODY");

		await harness.input("::unpin(zzqa-mode)");
		expect(harness.statuses.get(QA_STATUS_KEY)).toBeUndefined();
		expect((await harness.beforeAgentStart(native))?.systemPrompt).toBeUndefined();
	});
});
