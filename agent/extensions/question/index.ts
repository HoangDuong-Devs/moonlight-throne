/**
 * question — tool hỏi người dùng (như `question` của opencode), có chế độ cho bot.
 *
 * - ctx.hasUI = true  (TUI/RPC): hỏi qua select/input, trả câu trả lời cho model.
 * - ctx.hasUI = false (-p, --mode json): KHÔNG chờ. Trả kết quả có cấu trúc
 *   {"needs_clarification":true,"questions":[...]} kèm chỉ dẫn "dừng, đừng đoán, trả lời cuối" => lượt kết thúc
 *   sau đúng một lượt model nữa (không dùng terminate:true vì khi đó -p không in gì).
 *   Bot/caller đọc JSON ở kết quả tool (--mode json) hoặc câu trả lời cuối, hỏi người thật, rồi chạy lại.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Opt {
	label: string;
	description?: string;
}
interface Q {
	question: string;
	header?: string;
	options?: Opt[];
	multiple?: boolean;
}
interface Details {
	needs_clarification: boolean;
	questions: Q[];
	answers?: string[][];
	cancelled?: boolean;
}

const Params = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "Complete question" }),
			header: Type.Optional(Type.String({ description: "Very short label (max 30 chars)" })),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Display text (1-5 words, concise)" }),
						description: Type.Optional(Type.String({ description: "Explanation of choice" })),
					}),
					{ description: "Available choices (a free-text answer is always possible)" },
				),
			),
			multiple: Type.Optional(Type.Boolean({ description: "Allow selecting more than one choice" })),
		}),
		{ minItems: 1, description: "Questions to ask" },
	),
});

const OTHER = "Type your own answer";
const DONE = "Done";

export default function questionExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user questions when you need a decision or clarification that you cannot resolve from the code or context. " +
			"Offer concrete options (put the recommended one first with '(Recommended)'); a free-text answer is always allowed. " +
			"If no human is available the call returns {needs_clarification:true, questions} and the run ends so the caller can ask; " +
			"in that case do not guess or continue: stop and wait.",
		parameters: Params,
		executionMode: "sequential",

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions = params.questions as Q[];

			if (!ctx.hasUI) {
				const payload = { needs_clarification: true, questions };
				return {
					content: [
						{
							type: "text",
							text: `${JSON.stringify(payload)}\nNo interactive user is available, so these questions cannot be answered now. Do NOT guess and do NOT call more tools. Reply now with a final message that states that clarification is needed and lists the questions (and their options) above, then stop.`,
						},
					],
					details: { needs_clarification: true, questions } as Details,
				};
			}

			const answers: string[][] = [];
			for (const q of questions) {
				const title = q.header ? `${q.header}: ${q.question}` : q.question;
				const labels = (q.options ?? []).map((o) => (o.description ? `${o.label} - ${o.description}` : o.label));
				const byLabel = new Map(labels.map((l, i) => [l, q.options![i].label]));
				const picked: string[] = [];
				if (labels.length === 0) {
					const t = await ctx.ui.input(title, "Your answer");
					if (t === undefined) return cancelled(questions);
					picked.push(t);
				} else if (q.multiple) {
					const remaining = [...labels];
					for (;;) {
						const c = await ctx.ui.select(`${title}\n(selected: ${picked.join(", ") || "none"})`, [DONE, ...remaining, OTHER]);
						if (c === undefined) return cancelled(questions);
						if (c === DONE) break;
						if (c === OTHER) {
							const t = await ctx.ui.input(title, "Your answer");
							if (t === undefined) return cancelled(questions);
							picked.push(t);
						} else {
							picked.push(byLabel.get(c) ?? c);
							remaining.splice(remaining.indexOf(c), 1);
						}
					}
				} else {
					const c = await ctx.ui.select(title, [...labels, OTHER]);
					if (c === undefined) return cancelled(questions);
					if (c === OTHER) {
						const t = await ctx.ui.input(title, "Your answer");
						if (t === undefined) return cancelled(questions);
						picked.push(t);
					} else picked.push(byLabel.get(c) ?? c);
				}
				answers.push(picked);
			}
			const formatted = questions
				.map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
				.join(", ");
			return {
				content: [{ type: "text", text: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.` }],
				details: { needs_clarification: false, questions, answers } as Details,
			};
		},

		renderCall(args, theme) {
			const qs = Array.isArray(args.questions) ? args.questions : [];
			return new Text(theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", qs.map((q: Q) => q.question).join(" | ")), 0, 0);
		},
		renderResult(result, _o, theme) {
			const d = result.details as Details | undefined;
			if (d?.needs_clarification) return new Text(theme.fg("warning", "needs clarification (no UI)"), 0, 0);
			if (d?.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const t = result.content[0];
			return new Text(t?.type === "text" ? theme.fg("success", "✓ ") + theme.fg("muted", t.text) : "", 0, 0);
		},
	});
}

function cancelled(questions: Q[]) {
	return {
		content: [{ type: "text" as const, text: "The user dismissed this question." }],
		details: { needs_clarification: false, questions, cancelled: true } as Details,
	};
}
