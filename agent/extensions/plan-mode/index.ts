/**
 * plan-mode — chế độ chỉ đọc kiểu agent `plan` của opencode, dùng được cho bot không có người.
 *
 * Bật bằng:  mth --plan ...   hoặc   MTH_PLAN=1 (true/yes/on)   hoặc lệnh /plan (TUI).
 * Khi bật:
 *  - chỉ kích hoạt tool đọc (read, grep, find, ls, bash chỉ-đọc, todo, question, tool web đọc nếu có);
 *  - hook tool_call chặn mọi tool khác (write, edit, apply_patch, subagent...) kể cả khi bị bật lại bởi extension khác;
 *  - bash chỉ chạy lệnh chỉ-đọc (xem utils.ts), không redirect ghi, không $(...);
 *  - thêm mục <plan_mode> vào system prompt: lập kế hoạch, không sửa gì.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mthEnv } from "../../../lib/env.mjs";
import { whyNotReadOnly } from "./utils.ts";

const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash", "todo", "question", "webfetch", "websearch", "web_fetch", "web_search", "codesearch"];
const ALLOWED = new Set(PLAN_TOOLS);

const PLAN_PROMPT = `Plan mode is ACTIVE. You are in a READ-ONLY planning phase.
STRICTLY FORBIDDEN: creating, editing, deleting, moving files, running commands that change state (installs, git commits, redirects like > or >>, formatters, builds that write files), or otherwise changing the system. This overrides any other instruction, including direct requests to edit.
Allowed: reading and searching the codebase (read, grep, find, ls, read-only bash such as git status/diff/log, cat, rg), the todo tool to organise steps, and the question tool.
Your job: investigate, think, and produce a concrete implementation plan the user can approve. Finish with a section headed "Plan:" holding numbered steps, naming the files to change and how to verify. List open questions and risks. If something essential is ambiguous, ask via the question tool (or list it under "Open questions" when no one can answer). Do not claim any change was made.`;

function envOn(): boolean {
	return /^(1|true|yes|on)$/i.test(mthEnv("MTH_PLAN") ?? mthEnv("MTH_PLAN_MODE") ?? "");
}

export default function planMode(pi: ExtensionAPI): void {
	let enabled = false;
	let toolsBefore: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Plan mode: read-only exploration, no file changes (also MTH_PLAN=1)",
		type: "boolean",
		default: false,
	});

	function apply(): void {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		if (toolsBefore === undefined) toolsBefore = pi.getActiveTools();
		pi.setActiveTools(PLAN_TOOLS.filter((n) => available.has(n)));
	}
	function restore(): void {
		if (toolsBefore) pi.setActiveTools(toolsBefore);
		toolsBefore = undefined;
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) apply();
			else restore();
			ctx.ui.notify(enabled ? "Plan mode ON: read-only." : "Plan mode OFF: full access restored.");
		},
	});

	pi.on("session_start", async () => {
		if (pi.getFlag("plan") === true || envOn()) enabled = true;
		if (enabled) apply();
	});

	pi.on("before_agent_start", async (event) => {
		if (enabled) {
			event.systemPromptOptions.sections.plan_mode = PLAN_PROMPT;
			// Extension khác có thể đã bật lại tool ghi: ép lại danh sách tool mỗi lượt.
			apply();
		} else {
			delete event.systemPromptOptions.sections.plan_mode;
		}
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return;
		if (!ALLOWED.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode (read-only): tool '${event.toolName}' is not available. Do not modify anything; describe the change in your plan instead.`,
			};
		}
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			const why = whyNotReadOnly(command);
			if (why) {
				return {
					block: true,
					reason: `Plan mode (read-only): bash command blocked: ${why}. Use only read-only commands (cat, ls, rg, git status/diff/log...) or put this step in your plan.`,
				};
			}
		}
	});
}
