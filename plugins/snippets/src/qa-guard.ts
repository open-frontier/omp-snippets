/**
 * Q&A-only guard — the enforced half of the `guard: qa` snippet metadata.
 *
 * A pinnable ordinary snippet can opt into `guard: qa` in frontmatter (the
 * bundled `q&a` example does). While any active pin snapshot carries
 * that guard, this module decides which tool calls still run: the read-only
 * investigation allowlist plus exactly the read-only LSP routes. Everything
 * else — every mutating, executing, delegating, or unknown tool — is blocked
 * by the extension's `tool_call` handler with `{ block: true, reason }`, so
 * the refusal reaches the model as the tool's error instead of executing
 * anything. The same predicate backs the `before_subagent_spawn` denial,
 * because spawns are not always model tool calls (`eval`/`workpool` can spawn
 * directly and never route through a tool call).
 *
 * Fail-closed by construction: only names on the allowlist pass, so a tool
 * this module has never heard of (a new builtin, an MCP tool, a custom tool)
 * is blocked rather than assumed harmless. The `write` tool is the model's
 * one transport into mounted `xd://` devices, so it is allowed only for the
 * exact `xd://lsp` route with a JSON-object body that passes the same
 * read-only action check — every other route, suffixed or alternate spelling
 * included, stays blocked.
 *
 * This is host tool interception, not containment: the user's own `!`/`$`
 * shell commands, native slash commands, other OMP sessions, and external
 * processes are outside the plugin's tool-hook authority. It is also
 * deliberately independent of `tools.approvalMode`: an active guard blocks
 * these calls even under yolo or an explicit per-tool allow, because the
 * guard's contract is "nothing mutating runs until the user unpins", not
 * "ask first". Nothing here writes approval settings or toggles native
 * plan/execute mode.
 */

import type { PinnedSnippet } from "./snippets.ts";

/** Native tools the guard never blocks: read-only investigation plus
 *  UI/session-only planning state (`ask` prompts the user, `todo`/`wait`
 *  touch only session-local state). Deliberately exact names — a suffixed or
 *  unknown variant falls through to the fail-closed default. */
const QA_ALLOWED_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	web_search: true,
	ask: true,
	todo: true,
	wait: true,
};

/** LSP actions that only read — the host's own `LSP_READONLY_ACTIONS` set
 *  (verified against the shipped runtime, 17.2.4/18.10.4). `code_actions` is
 *  deliberately absent and handled separately: listing actions reads,
 *  applying one rewrites files. */
const LSP_READONLY_ACTIONS: Record<string, true> = {
	capabilities: true,
	definition: true,
	diagnostics: true,
	hover: true,
	implementation: true,
	references: true,
	status: true,
	symbols: true,
	type_definition: true,
};

/** True while at least one active pin snapshot carries the QA guard. */
export function isQaGuardedPin(pinned: ReadonlyMap<string, PinnedSnippet>): boolean {
	for (const pin of pinned.values()) {
		if (pin.guard === "qa") return true;
	}
	return false;
}

/** Names of the QA-guarded pins, sorted — the guard's status/notice/reason
 *  text always derives from the live map, never from a second set that could
 *  drift when a pin is unpinned or replaced by group exclusivity. */
export function qaPinnedNames(pinned: ReadonlyMap<string, PinnedSnippet>): string[] {
	const names: string[] = [];
	for (const [name, pin] of pinned) {
		if (pin.guard === "qa") names.push(name);
	}
	return names.sort();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when an LSP argument object (a direct `lsp` tool call or the JSON body
 *  written to the `xd://lsp` device) only reads. Unknown actions, a missing or
 *  non-string action, and `code_actions` with anything but an explicit no-apply
 *  are all treated as writes. */
function lspArgsAllowed(args: Record<string, unknown>): boolean {
	const action = args.action;
	if (typeof action !== "string") return false;
	if (action === "code_actions") return args.apply === undefined || args.apply === false;
	return LSP_READONLY_ACTIONS[action] === true;
}

/** The `write` tool stays usable only for the exact `xd://lsp` route with a
 *  JSON object body that passes the LSP read-only check — exact string
 *  equality on purpose, so `xd://lsp?x`, `xd://lsp/...`, case variants, and
 *  every other device or write scheme (plain paths, `local://`, `ssh://`, …)
 *  fall through to the blocked default. */
function xdevLspWriteAllowed(input: Record<string, unknown>): boolean {
	if (input.path !== "xd://lsp") return false;
	const content = input.content;
	if (typeof content !== "string") return false;
	let args: unknown;
	try {
		args = JSON.parse(content);
	} catch {
		return false;
	}
	return isJsonObject(args) && lspArgsAllowed(args);
}

/** Short description of the blocked call, embedded in the reason so the model
 *  (and the transcript) can see what was attempted without echoing unbounded
 *  model-supplied text back into the prompt. */
function describeCall(toolName: string, input: unknown): string {
	if (toolName === "lsp" && isJsonObject(input) && typeof input.action === "string") {
		const action = input.action.length > 40 ? `${input.action.slice(0, 39)}…` : input.action;
		return `tool "lsp" (action "${action}")`;
	}
	if (toolName === "write" && isJsonObject(input) && typeof input.path === "string") {
		const route = input.path.length > 80 ? `${input.path.slice(0, 79)}…` : input.path;
		return `tool "write" (route "${route}")`;
	}
	return `tool "${toolName}"`;
}

/** The one place the refusal wording lives — shared by the `tool_call` block,
 *  the subagent-spawn denial, and the tests that assert on it. */
export function qaBlockedMessage(pinnedNames: readonly string[], what: string): string {
	const unpin = pinnedNames.map((name) => `::unpin(${name})`).join(" / ");
	return (
		`Q&A-only guard active (pinned: ${pinnedNames.join(", ")}): ${what} is blocked until the user unpins (${unpin}). ` +
		"Allowed: read, grep, glob, web_search, ask, todo, wait; read-only lsp queries."
	);
}

/** The guard decision for one tool call: `null` when it may run, otherwise the
 *  refusal reason to return to the model. Callers check this on every
 *  `tool_call` event while the guard is active — it is the enforcement point,
 *  not a hint. */
export function qaBlockReason(toolName: string, input: unknown, pinned: ReadonlyMap<string, PinnedSnippet>): string | null {
	const names = qaPinnedNames(pinned);
	if (names.length === 0) return null;
	if (QA_ALLOWED_TOOLS[toolName] === true) return null;
	if (toolName === "lsp" && isJsonObject(input) && lspArgsAllowed(input)) return null;
	if (toolName === "write" && isJsonObject(input) && xdevLspWriteAllowed(input)) return null;
	return qaBlockedMessage(names, describeCall(toolName, input));
}

/** Refusal reason for a subagent spawn while a QA-guarded pin is active, or
 *  `null` when spawning is fine — the extension's `before_subagent_spawn`
 *  denial. `agent` is the spawn's agent name, used for the reason text only. */
export function qaSpawnBlockReason(agent: string, pinned: ReadonlyMap<string, PinnedSnippet>): string | null {
	const names = qaPinnedNames(pinned);
	if (names.length === 0) return null;
	return qaBlockedMessage(names, agent ? `spawn "${agent}"` : "spawn");
}
