/**
 * todo — todowrite/todoread của opencode, gộp trong một tool `todo` (action: write | read).
 *
 * Trạng thái lưu trong `details` của kết quả tool (như mẫu todo.ts) nên đúng theo session/nhánh
 * và khôi phục khi resume. `write` thay toàn bộ danh sách (giống todowrite của opencode).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "completed" | "cancelled";
type Priority = "high" | "medium" | "low";

interface TodoItem {
	content: string;
	status: Status;
	priority: Priority;
}
interface TodoDetails {
	action: "write" | "read";
	todos: TodoItem[];
	error?: string;
}

const ItemSchema = Type.Object({
	content: Type.String({ description: "Brief description of the task" }),
	status: StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, {
		description: "Current status: pending, in_progress (max one at a time), completed, cancelled",
	}),
	priority: Type.Optional(StringEnum(["high", "medium", "low"] as const, { description: "Priority (default medium)" })),
});

const Params = Type.Object({
	action: StringEnum(["write", "read"] as const, {
		description: "write: replace the whole todo list with `todos`; read: return the current list",
	}),
	todos: Type.Optional(Type.Array(ItemSchema, { description: "Full updated todo list (required for write)" })),
});

const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" };

function format(todos: TodoItem[]): string {
	if (!todos.length) return "No todos";
	const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
	return [`${open} open / ${todos.length} total`, ...todos.map((t, i) => `${i + 1}. ${MARK[t.status]} (${t.priority}) ${t.content}`)].join("\n");
}

export default function todoExtension(pi: ExtensionAPI): void {
	let todos: TodoItem[] = [];

	const reconstruct = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const d = msg.details as TodoDetails | undefined;
			if (d && !d.error) todos = d.todos;
		}
	};
	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Create and manage a structured task list for the current session. Use it proactively for tasks with 3+ steps: " +
			"action=write replaces the full list (each item: content, status pending|in_progress|completed|cancelled, priority high|medium|low); " +
			"action=read returns the list. Keep at most one item in_progress; mark items completed immediately when done.",
		parameters: Params,
		async execute(_id, params) {
			if (params.action === "read") {
				return { content: [{ type: "text", text: format(todos) }], details: { action: "read", todos: [...todos] } as TodoDetails };
			}
			if (!params.todos) {
				return {
					content: [{ type: "text", text: "Error: `todos` is required for action=write" }],
					details: { action: "write", todos: [...todos], error: "todos required" } as TodoDetails,
				};
			}
			const next: TodoItem[] = params.todos.map((t) => ({ content: t.content, status: t.status, priority: t.priority ?? "medium" }));
			const inProgress = next.filter((t) => t.status === "in_progress").length;
			todos = next;
			const warn = inProgress > 1 ? `\nWarning: ${inProgress} items are in_progress; keep only one at a time.` : "";
			return {
				content: [{ type: "text", text: `Todo list updated.\n${format(todos)}${warn}` }],
				details: { action: "write", todos: [...todos] } as TodoDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as TodoDetails | undefined;
			if (!d) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (d.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
			const shown = expanded ? d.todos : d.todos.slice(0, 6);
			let text = theme.fg("muted", `${d.todos.length} todo(s)`);
			for (const t of shown) text += `\n${MARK[t.status]} ${t.status === "completed" ? theme.fg("dim", t.content) : t.content}`;
			if (!expanded && d.todos.length > 6) text += `\n${theme.fg("dim", `... ${d.todos.length - 6} more`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => ctx.ui.notify(format(todos), "info"),
	});
}
