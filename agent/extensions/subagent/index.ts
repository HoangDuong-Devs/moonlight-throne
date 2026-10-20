/**
 * Extension `subagent` (kiểu opencode) cho coder.
 *
 * - Tool `subagent` {agent, description, prompt, model?, sessionID?, background?}
 *   chạy một tiến trình agent con với phiên riêng (ngữ cảnh sạch) lưu ở
 *   <agent-dir>/sessions/subagents. Trả về sessionID để gọi lại và tiếp tục
 *   đúng cuộc hội thoại con (resume).
 * - foreground: trả kết quả cuối. background: trả ngay {sessionID, status:"running"},
 *   khi xong thì thông báo cho agent cha.
 * - Tool `subagent_status` {sessionID?, wait?, cancel?} xem/chờ/hủy job nền.
 * - Giới hạn: độ sâu lồng, số job nền đồng thời, timeout; con của agent chỉ-đọc
 *   (explore...) không bao giờ có quyền ghi.
 *
 * Cấu hình tùy chọn: <agent-dir>/subagent.json (hoặc biến môi trường):
 *   maxDepth (CODER_SUBAGENT_MAX_DEPTH, mặc định 2)
 *   maxBackground (CODER_SUBAGENT_MAX_BACKGROUND, mặc định 4)
 *   timeoutMs (CODER_SUBAGENT_TIMEOUT_MS, mặc định 600000)
 *   allowProjectAgents (mặc định false: chỉ nạp <agent-dir>/agents)
 *   waitForBackground (mặc định true: ở chế độ -p/json, cha chờ job nền xong rồi nhận thông báo)
 *   detached (mặc định false: job nền chạy TÁCH RỜI, sống tiếp sau khi cha thoát; tham số tool `detached` ghi đè)
 *   strictParent (mặc định true: từ chối resume/status/cancel job thuộc cây khác CHỈ khi cả hai bên có rootId và khác nhau;
 *     thiếu rootId ở một bên (vd. chạy --no-session) thì MỞ, cố ý để không phá luồng --no-session hợp lệ.
 *     "always": chỉ cho phép khi cả hai có rootId và bằng nhau (thiếu root => từ chối); false: tắt)
 *   rootKey (hoặc env CODER_JOB_NAMESPACE): namespace chung cho nhiều lần gọi `coder -p` khác nhau
 *   retentionDays (mặc định 7: dọn job đã xong quá hạn)
 *
 * Job tách rời được quản lý bằng lib/subagent-cli.mjs (list/status/wait/result/cancel).
 * Logic job dùng chung nằm ở jobs-core.mjs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
// @ts-ignore - module Node thuần dùng chung với lib/subagent-cli.mjs
import * as core from "./jobs-core.mjs";

// ---------------------------------------------------------------- cấu hình

interface Config {
	maxDepth: number;
	maxBackground: number;
	timeoutMs: number;
	allowProjectAgents: boolean;
	waitForBackground: boolean;
	detached: boolean;
	strictParent: boolean | "always";
	rootKey?: string;
	retentionDays: number;
}

const validKey = (v: unknown): string | undefined =>
	typeof v === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(v) ? v : undefined;

function loadConfig(): Config {
	let file: Record<string, unknown> = {};
	try {
		file = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "subagent.json"), "utf-8"));
	} catch {}
	const num = (env: string, key: string, def: number) => {
		const raw = process.env[env] ?? process.env[env.replace(/^CODER_/, "PI_")] ?? file[key]; // PI_*: tên cũ, vẫn nhận
		const v = Number(raw);
		return Number.isFinite(v) && v >= 0 && raw !== undefined ? v : def;
	};
	return {
		maxDepth: num("CODER_SUBAGENT_MAX_DEPTH", "maxDepth", 2),
		maxBackground: num("CODER_SUBAGENT_MAX_BACKGROUND", "maxBackground", 4),
		timeoutMs: num("CODER_SUBAGENT_TIMEOUT_MS", "timeoutMs", 600_000),
		allowProjectAgents: file.allowProjectAgents === true,
		waitForBackground: file.waitForBackground !== false,
		detached: file.detached === true,
		strictParent: file.strictParent === "always" ? "always" : file.strictParent !== false,
		rootKey: validKey(process.env.CODER_JOB_NAMESPACE) ?? validKey(file.rootKey),
		retentionDays: num("CODER_SUBAGENT_RETENTION_DAYS", "retentionDays", 7),
	};
}

const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const OUTPUT_CAP = 50 * 1024;

const currentDepth = () => {
	const n = Number(process.env.CODER_SUBAGENT_DEPTH);
	return Number.isFinite(n) && n > 0 ? n : 0;
};
const readonlyCeiling = () => process.env.CODER_SUBAGENT_READONLY === "1";
const sessionsDir = () => path.join(getAgentDir(), "sessions", "subagents");

// ---------------------------------------------------------------- metadata phiên con

type Status = "running" | "completed" | "failed" | "timeout" | "cancelled";

interface Meta {
	sessionID: string;
	agent: string;
	description: string;
	cwd: string;
	status: Status;
	result?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
	/** "detached": supervisor tách rời; "attached": con của tiến trình cha (pid = pid cha). */
	mode?: "attached" | "detached";
	background?: boolean;
	pid?: number;
	pidStart?: string;
	childPid?: number;
	childStart?: string;
	/** Cây sở hữu: "ns:<CODER_JOB_NAMESPACE|rootKey>" hoặc "sess:<id phiên gốc>". */
	rootId?: string;
	parentSessionId?: string;
}

const readMeta = (id: string): Meta | undefined => core.getJob(getAgentDir(), id);
const writeMeta = (meta: Meta) => core.writeMeta(getAgentDir(), meta);

/** rootId của người gọi: gốc kế thừa từ cha subagent > namespace cấu hình > phiên bền của chính nó. */
function callerRoot(config: Config, ctx: ExtensionContext): { rootId?: string; sessionId?: string } {
	let sessionId: string | undefined;
	try {
		if (ctx.sessionManager.isPersisted()) sessionId = ctx.sessionManager.getSessionId();
	} catch {}
	const inherited = validKey(process.env.CODER_SUBAGENT_ROOT);
	if (inherited) return { rootId: inherited, sessionId };
	if (config.rootKey) return { rootId: `ns:${config.rootKey}`, sessionId };
	return { rootId: sessionId ? `sess:${sessionId}` : undefined, sessionId };
}

/** Trả về lý do từ chối nếu job thuộc cây khác; undefined nếu được phép (xem core.denyForeign về ngữ nghĩa thiếu rootId). */
function denyForeign(config: Config, rootId: string | undefined, meta: Meta): string | undefined {
	return core.denyForeign(config.strictParent, rootId, meta);
}

// ---------------------------------------------------------------- chạy tiến trình con

interface RunOptions {
	agent: AgentConfig;
	sessionID: string;
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onProc?: (p: ChildProcess) => void;
	rootId?: string;
	/** Gốc jail kế thừa từ cha (CODER_WORKDIR của cha, hoặc cwd của cha). */
	jailRoot: string;
}

interface RunOutcome {
	status: Exclude<Status, "running">;
	text: string;
	error?: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exec = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function isReadonlyTools(tools: string[] | undefined): boolean {
	return !!tools && tools.length > 0 && tools.every((t) => READONLY_TOOLS.includes(t));
}

/** Tool cho tiến trình con: khi trần chỉ-đọc đang áp dụng thì chỉ giữ các tool đọc. */
function effectiveTools(agent: AgentConfig): string[] | undefined {
	if (!readonlyCeiling()) return agent.tools;
	const kept = (agent.tools ?? READONLY_TOOLS).filter((t) => READONLY_TOOLS.includes(t));
	return kept.length > 0 ? kept : READONLY_TOOLS;
}

/** Dòng lệnh + biến môi trường bổ sung cho tiến trình agent con (dùng chung attached/detached). */
function buildInvocation(opts: RunOptions): { command: string; args: string[]; extraEnv: Record<string, string> } {
	const tools = effectiveTools(opts.agent);
	const args = ["--mode", "json", "-p", "--session-dir", sessionsDir(), "--session-id", opts.sessionID];
	if (opts.model) args.push("--model", opts.model);
	const thinking = opts.agent.thinking ?? opts.thinking;
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	if (opts.agent.systemPrompt.trim()) args.push("--append-system-prompt", opts.agent.systemPrompt);
	// LUÔN có tiền tố: prompt bắt đầu bằng "/" bị lõi agent hiểu là lệnh extension (vd. /revert latest), vượt ranh giới
	// chỉ-đọc của agent con (--tools chỉ chặn tool, không chặn lệnh); "-"/"@" bị hiểu là cờ/tệp.
	args.push(`Task: ${opts.prompt}`);
	const extraEnv: Record<string, string> = {
		CODER_SUBAGENT_DEPTH: String(currentDepth() + 1),
		// Con nạp lại đúng cấu hình/bot-permissions của cha và bị nhốt trong cùng jail.
		CODER_AGENT_DIR: getAgentDir(),
		PI_CODING_AGENT_DIR: getAgentDir(), // nội bộ: thư viện lõi đọc tên này
		CODER_WORKDIR: opts.jailRoot,
	};
	if (opts.rootId) extraEnv.CODER_SUBAGENT_ROOT = opts.rootId;
	if (readonlyCeiling() || isReadonlyTools(tools)) extraEnv.CODER_SUBAGENT_READONLY = "1";
	return { ...getPiInvocation(args), extraEnv };
}

function killGroup(proc: ChildProcess, sig: NodeJS.Signals) {
	try {
		if (proc.pid) process.kill(-proc.pid, sig);
	} catch {
		try {
			proc.kill(sig);
		} catch {}
	}
}

function runChild(opts: RunOptions): Promise<RunOutcome> {
	return new Promise((resolve) => {
		const built = buildInvocation(opts);
		const env: NodeJS.ProcessEnv = { ...process.env, ...built.extraEnv };

		fs.mkdirSync(sessionsDir(), { recursive: true });
		const proc = spawn(built.command, built.args, {
			cwd: opts.cwd,
			env,
			shell: false,
			detached: true, // nhóm riêng để hủy được cả cây lệnh con
			stdio: ["ignore", "pipe", "pipe"],
		});
		opts.onProc?.(proc);

		let buffer = "";
		let stderr = "";
		let lastText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let done = false;
		let cause: "timeout" | "cancelled" | undefined;

		const kill = (why: "timeout" | "cancelled") => {
			if (done) return;
			cause ??= why;
			killGroup(proc, "SIGTERM");
			setTimeout(() => {
				if (!done) killGroup(proc, "SIGKILL");
			}, 5000).unref();
		};
		const timer = opts.timeoutMs > 0 ? setTimeout(() => kill("timeout"), opts.timeoutMs) : undefined;
		timer?.unref();
		const onAbort = () => kill("cancelled");
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		(proc as ChildProcess & { __kill?: typeof kill }).__kill = kill;

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const text = (ev.message.content ?? [])
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text)
					.join("\n");
				if (text) lastText = text;
				stopReason = ev.message.stopReason;
				errorMessage = ev.message.errorMessage;
			}
		};

		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			lines.forEach(handleLine);
		});
		proc.stderr.on("data", (d) => {
			if (stderr.length < 8192) stderr += d.toString();
		});
		const finish = (code: number | null, spawnError?: string, sig?: string | null) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) handleLine(buffer);
			if (cause === "timeout")
				return resolve({ status: "timeout", text: lastText, error: `Hết thời gian (${opts.timeoutMs} ms)` });
			if (cause === "cancelled") return resolve({ status: "cancelled", text: lastText, error: "Đã hủy" });
			if (spawnError) return resolve({ status: "failed", text: lastText, error: spawnError });
			if (code !== 0 || stopReason === "error" || stopReason === "aborted") {
				return resolve({
					status: "failed",
					text: lastText,
					error: errorMessage || (sig ? `agent con bị giết bởi tín hiệu ${sig}` : stderr.trim() || `agent con thoát với mã ${code}`),
				});
			}
			resolve({ status: "completed", text: lastText || "(không có đầu ra)" });
		};
		proc.on("close", (code, sig) => finish(code, undefined, sig));
		proc.on("error", (e) => finish(1, e.message));
	});
}

// ---------------------------------------------------------------- job nền

interface Job {
	meta: Meta;
	proc?: ChildProcess;
	promise: Promise<void>;
}

/** Job attached của tiến trình này (cha chờ kết quả). */
const jobs = new Map<string, Job>();
/** Job detached mà tiến trình này đang theo dõi để thông báo (tui/rpc). */
const watched = new Set<string>();
const pendingNotices: { sessionID: string; text: string }[] = [];

const clip = (s: string) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n... [cắt bớt ${s.length - OUTPUT_CAP} ký tự]` : s);

function formatOutcome(meta: Meta): string {
	const head = `sessionID: ${meta.sessionID} (agent: ${meta.agent}, status: ${meta.status})`;
	const body = meta.result ? `\n\n${clip(meta.result)}` : "";
	const err = meta.error ? `\n\nLỗi: ${meta.error}` : "";
	return `${head}${body}${err}\n\nĐể tiếp tục cuộc hội thoại con này, gọi lại subagent với sessionID trên.`;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

type Killable = ChildProcess & { __kill?: (w: "cancelled") => void };

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	// Ngữ cảnh gần nhất, dùng để chọn cách thông báo khi job nền xong.
	let lastMode: ExtensionContext["mode"] | undefined;

	const listAgents = (cwd: string) => discoverAgents(cwd, config.allowProjectAgents);
	const agentLines = (agents: AgentConfig[]) =>
		agents.map((a) => `- ${a.name}: ${a.description}`).join("\n") || "(chưa có agent nào)";

	try {
		core.pruneJobs(getAgentDir(), config.retentionDays * 86_400_000);
	} catch {}

	function notify(meta: Meta) {
		const text = `[Subagent nền đã xong] ${meta.description}\n${formatOutcome(meta)}`;
		if (lastMode === "tui" || lastMode === "rpc") {
			try {
				pi.sendMessage(
					{ customType: "subagent-result", content: text, display: true, details: { sessionID: meta.sessionID } },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			} catch {}
		}
		pendingNotices.push({ sessionID: meta.sessionID, text });
	}

	function startJob(
		agent: AgentConfig,
		meta: Meta,
		opts: Omit<RunOptions, "agent" | "sessionID" | "timeoutMs" | "signal" | "onProc">,
		signal: AbortSignal | undefined,
		background: boolean,
	): Job {
		const job: Job = { meta, promise: Promise.resolve() };
		jobs.set(meta.sessionID, job);
		meta.mode = "attached";
		meta.pid = process.pid;
		meta.pidStart = core.procInfo(process.pid)?.start;
		writeMeta(meta);
		job.promise = runChild({
			...opts,
			agent,
			sessionID: meta.sessionID,
			timeoutMs: config.timeoutMs,
			signal: background ? undefined : signal,
			onProc: (p) => {
				job.proc = p;
				meta.childPid = p.pid;
				meta.childStart = p.pid ? core.procInfo(p.pid)?.start : undefined;
				writeMeta(meta);
			},
		}).then((out) => {
			meta.status = out.status;
			meta.result = out.text;
			meta.error = out.error;
			meta.endedAt = Date.now();
			meta.childPid = undefined;
			meta.childStart = undefined;
			writeMeta(meta);
			if (background && out.status !== "cancelled") notify(meta);
		});
		return job;
	}

	/** Chạy tách rời: supervisor sống tiếp sau khi cha thoát. Trong tui/rpc, cha theo dõi để thông báo. */
	function startDetached(agent: AgentConfig, meta: Meta, opts: Omit<RunOptions, "agent" | "sessionID" | "timeoutMs" | "signal" | "onProc">) {
		const built = buildInvocation({ ...opts, agent, sessionID: meta.sessionID, timeoutMs: config.timeoutMs });
		const m = core.launchDetached(getAgentDir(), meta, {
			command: built.command,
			args: built.args,
			cwd: opts.cwd,
			env: built.extraEnv,
			timeoutMs: config.timeoutMs,
		}) as Meta;
		if (lastMode === "tui" || lastMode === "rpc") {
			watched.add(m.sessionID);
			const t = setInterval(() => {
				const cur = readMeta(m.sessionID);
				if (cur && cur.status === "running") return;
				clearInterval(t);
				watched.delete(m.sessionID);
				if (cur && cur.status !== "cancelled") notify(cur);
			}, 2000);
			t.unref();
		}
		return m;
	}

	const SubagentParams = Type.Object({
		agent: Type.String({ description: "Tên agent con (xem danh sách trong mô tả tool)." }),
		description: Type.String({ description: "Nhãn ngắn 3-5 từ cho tác vụ, hiển thị cho người dùng." }),
		prompt: Type.String({ description: "Nhiệm vụ giao cho agent con. Phải tự chứa đủ ngữ cảnh." }),
		model: Type.Optional(Type.String({ description: "Model cho agent con (mặc định kế thừa model của agent cha)." })),
		sessionID: Type.Optional(
			Type.String({
				description:
					"Tiếp tục đúng cuộc hội thoại con trước đó bằng sessionID. Không truyền thì tạo cuộc hội thoại mới.",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description: "true: trả ngay {sessionID, status:'running'} và được thông báo khi xong.",
			}),
		),
		detached: Type.Optional(
			Type.Boolean({
				description:
					"true: chạy nền TÁCH RỜI (ngụ ý background): job sống tiếp cả khi bạn thoát; lấy kết quả sau bằng subagent_status (hoặc CLI jobs). Mặc định theo cấu hình.",
			}),
		),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Giao việc cho một agent con chuyên biệt chạy trong phiên riêng có ngữ cảnh sạch.",
			"Kết quả có sessionID; truyền lại sessionID để tiếp tục đúng cuộc hội thoại con đó.",
			"Phiên mới KHÔNG thấy ngữ cảnh của bạn: prompt phải chứa đủ thông tin.",
			"Đặt background=true cho việc dài: tool trả ngay status 'running', bạn sẽ được thông báo tự động khi xong; ĐỪNG ngủ/poll hay làm trùng việc của nó.",
			"detached=true: job tách rời, không bị hủy khi phiên này kết thúc (kết quả lấy sau bằng subagent_status).",
			"Có thể gọi nhiều subagent song song trong cùng một lượt.",
			`Agent khả dụng:\n${agentLines(listAgents(process.cwd()))}`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			lastMode = ctx.mode;
			const depth = currentDepth();
			if (depth >= config.maxDepth) {
				throw new Error(
					`Đã đạt độ sâu subagent tối đa (${config.maxDepth}). Hãy tự làm việc này thay vì giao tiếp.`,
				);
			}
			const agents = listAgents(ctx.cwd);
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				throw new Error(`Không có agent "${params.agent}". Khả dụng: ${agents.map((a) => a.name).join(", ") || "không có"}`);
			}

			const { rootId, sessionId: parentSessionId } = callerRoot(config, ctx);
			// Jail của con = jail của cha; cwd của con (kể cả khi resume) phải nằm trong jail.
			const jailRoot = path.resolve(process.env.CODER_WORKDIR || ctx.cwd);
			const inJail = (p: string) => p === jailRoot || p.startsWith(jailRoot + path.sep);

			let sessionID = params.sessionID;
			let cwd = ctx.cwd;
			if (sessionID) {
				if (!SESSION_ID_RE.test(sessionID)) throw new Error(`sessionID không hợp lệ: ${sessionID}`);
				const prev = readMeta(sessionID);
				if (!prev) throw new Error(`Không tìm thấy phiên subagent: ${sessionID}`);
				const deny = denyForeign(config, rootId, prev);
				if (deny) throw new Error(deny);
				if (prev.status === "running") {
					throw new Error(`Phiên ${sessionID} đang chạy nền; chờ nó xong (subagent_status) rồi hãy tiếp tục.`);
				}
				if (fs.existsSync(prev.cwd) && inJail(path.resolve(prev.cwd))) cwd = prev.cwd;
			} else {
				sessionID = `sub_${randomBytes(8).toString("hex")}`;
			}

			const detached = params.detached ?? (params.background === true ? config.detached : false);
			const background = params.background === true || detached;
			if (background) {
				const running = (core.listJobs(getAgentDir()) as Meta[]).filter((m) => m.status === "running" && m.background).length;
				if (running >= config.maxBackground) {
					throw new Error(
						`Đã đạt số job nền đồng thời tối đa (${config.maxBackground}). Chờ một job xong hoặc chạy foreground.`,
					);
				}
			}

			const model = params.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			const prevMeta = params.sessionID ? readMeta(params.sessionID) : undefined;
			const meta: Meta = {
				sessionID,
				agent: agent.name,
				description: params.description,
				cwd,
				status: "running",
				startedAt: Date.now(),
				background,
				// Resume giữ nguyên cây sở hữu ban đầu; job mới gắn vào cây của người gọi.
				rootId: prevMeta?.rootId ?? rootId,
				parentSessionId: prevMeta?.parentSessionId ?? parentSessionId,
			};
			const runOpts = { prompt: params.prompt, cwd, model, thinking: ctx.thinkingLevel, rootId: meta.rootId, jailRoot };

			if (detached) {
				writeMeta(meta);
				startDetached(agent, meta, runOpts);
				return textResult(
					[
						`Subagent đang chạy nền TÁCH RỜI (sessionID: ${sessionID}); nó sống tiếp kể cả khi phiên này kết thúc.`,
						`Lấy kết quả sau bằng subagent_status {sessionID:"${sessionID}", wait:true} hoặc CLI: subagent-cli.mjs wait|result|status|cancel ${sessionID} [--json].`,
						"ĐỪNG ngủ/poll liên tục hay làm trùng việc của nó.",
					].join("\n"),
					{ sessionID, status: "running", detached: true },
				);
			}

			const job = startJob(agent, meta, runOpts, signal, background);
			if (background) {
				return textResult(
					[
						`Subagent đang chạy nền (sessionID: ${sessionID}). Bạn sẽ được thông báo tự động khi nó xong.`,
						"ĐỪNG ngủ, poll tiến độ, hỏi trạng thái hay làm trùng việc của nó; tránh đụng cùng file/chủ đề.",
					].join("\n"),
					{ sessionID, status: "running" },
				);
			}

			await job.promise;
			if (meta.status === "completed") return textResult(formatOutcome(meta), { sessionID, status: meta.status });
			throw new Error(formatOutcome(meta));
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description:
			"Xem trạng thái/kết quả job subagent (kể cả job tách rời từ các lần chạy trước, cùng cây/namespace). Không truyền sessionID thì liệt kê job. wait=true chờ job xong (timeoutSec tùy chọn); cancel=true hủy job đang chạy. Job nền thường tự thông báo khi xong; job tách rời thì dùng tool này để lấy kết quả.",
		parameters: Type.Object({
			sessionID: Type.Optional(Type.String({ description: "sessionID của subagent." })),
			wait: Type.Optional(Type.Boolean({ description: "Chờ job xong rồi trả kết quả." })),
			cancel: Type.Optional(Type.Boolean({ description: "Hủy job đang chạy." })),
			timeoutSec: Type.Optional(Type.Number({ description: "Với wait: số giây chờ tối đa (mặc định chờ tới khi xong)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastMode = ctx.mode;
			const { rootId } = callerRoot(config, ctx);
			const dir = getAgentDir();
			if (!params.sessionID) {
				const rows = (core.listJobs(dir) as Meta[])
					.filter((m) => !denyForeign(config, rootId, m))
					.map((m) => `${m.sessionID}\t${m.status}\t${m.agent}\t${m.mode ?? "attached"}\t${m.description}`);
				return textResult(rows.join("\n") || "(không có job nào)");
			}
			const id = params.sessionID;
			if (!SESSION_ID_RE.test(id)) throw new Error("sessionID không hợp lệ");
			const first = readMeta(id);
			if (!first) throw new Error(`Không tìm thấy phiên subagent: ${id}`);
			const deny = denyForeign(config, rootId, first);
			if (deny) throw new Error(deny);
			const job = jobs.get(id);
			if (first.status === "running") {
				if (params.cancel) {
					if (job?.meta.status === "running") {
						(job.proc as Killable | undefined)?.__kill?.("cancelled");
						await job.promise;
					} else {
						await core.cancelJob(dir, id);
					}
				} else if (params.wait) {
					const timeoutMs = params.timeoutSec !== undefined ? Math.max(0, params.timeoutSec) * 1000 : undefined;
					if (job?.meta.status === "running" && timeoutMs === undefined) {
						await Promise.race([
							job.promise,
							new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true })),
						]);
					} else {
						await core.waitJob(dir, id, { timeoutMs, signal });
					}
				}
			}
			const meta = (job && job.meta.status !== "running" ? job.meta : undefined) ?? readMeta(id);
			if (!meta) throw new Error(`Không tìm thấy phiên subagent: ${id}`);
			// Kết quả đã được trả qua đây thì bỏ thông báo chờ tương ứng.
			if (meta.status !== "running") {
				const i = pendingNotices.findIndex((n) => n.sessionID === meta.sessionID);
				if (i >= 0) pendingNotices.splice(i, 1);
			}
			return textResult(formatOutcome(meta), { sessionID: meta.sessionID, status: meta.status });
		},
	});

	// Chế độ -p / json: tiến trình cha sẽ thoát ngay khi agent dừng, nên giữ nó lại
	// cho tới khi job nền (attached) xong rồi đưa kết quả vào ngữ cảnh. Job tách rời KHÔNG được chờ.
	pi.on("agent_before_settle", async (event, ctx) => {
		lastMode = ctx.mode;
		if (!config.waitForBackground || (ctx.mode !== "print" && ctx.mode !== "json")) return;
		if (event.outcome === "aborted") return;
		while (pendingNotices.length === 0) {
			const running = [...jobs.values()].filter((j) => j.meta.status === "running" && j.meta.background);
			if (running.length === 0) return;
			await Promise.race(running.map((j) => j.promise));
		}
		const notices = pendingNotices.splice(0);
		return {
			continue: true,
			entries: notices.map((n) => ({
				type: "custom_message" as const,
				customType: "subagent-result",
				content: n.text,
				display: true,
				details: { sessionID: n.sessionID },
			})),
		};
	});

	// Chỉ hủy job attached; job tách rời sống tiếp.
	pi.on("session_shutdown", () => {
		for (const j of jobs.values()) {
			if (j.meta.status === "running") (j.proc as Killable | undefined)?.__kill?.("cancelled");
		}
	});
}
