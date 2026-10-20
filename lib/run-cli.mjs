#!/usr/bin/env node
// run-cli: chạy `coder --mode json` như tiến trình con và in MỘT đối tượng JSON ổn định ra stdout (log -> stderr).
//   node lib/run-cli.mjs [--model M] [--session ID] [--dir D] [--timeout SEC] [--sandbox] [--plan] [--] "<prompt>"
//   node lib/run-cli.mjs ... --prompt-file F
// Mã thoát: 0 done | 10 partial | 11 blocked | 20 error | 21 auth | 22 timeout | 23 rate_limit | 64 sai tham số.
// Chỉ dùng Node thuần. Không đọc .env / auth.json.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { agentEnv, resolveAgentDir } from "./agent-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coderRoot = path.resolve(here, "..");
const agentDir = resolveAgentDir(undefined, process.env, undefined, path.join(coderRoot, "agent"));
const startedAt = Date.now();

const EXIT = { done: 0, partial: 10, blocked: 11, error: 20, auth: 21, timeout: 22, rate_limit: 23, usage: 64 };
const log = (...a) => process.stderr.write(`[run-cli] ${redact(a.join(" "))}\n`);

// ---------- che secret ----------
const secretEnvValues = Object.entries(process.env)
	.filter(([k, v]) => /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(k) && v && v.length >= 8)
	.map(([, v]) => v);
function redact(s) {
	if (typeof s !== "string" || !s) return s;
	for (const v of secretEnvValues) if (s.includes(v)) s = s.split(v).join("[REDACTED]");
	return s
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, "$1 [REDACTED]")
		.replace(/\b(sk|pk|xai|key|tok|ghp|gho|ghs|github_pat|glpat|AKIA|AIza)[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
		.replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g, "[REDACTED]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|x-api-key)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;&\\}{]{6,}/gi,
			"$1[REDACTED]",
		);
}

// ---------- tham số ----------
function usageError(msg) {
	emit(
		{
			ok: false, status: "error", session_id: null, model: null, final_text: "", status_line: null,
			summary: { changed: [] }, files_changed: [], tool_calls: { total: 0, by_name: {}, errors: 0 },
			pending_permissions: [], needs_clarification: null, usage: null, duration_ms: Date.now() - startedAt, warnings: [],
			error: { code: "usage", message: msg, retryable: false },
		},
		EXIT.usage,
	);
}
let emitted = false;
let auditCtx = null; // đặt sau khi đọc xong tham số; dùng để ghi nhật ký kiểm toán PHÍA HOST
// Nhật ký kiểm toán phía host: do tiến trình NGOÀI sandbox ghi (agent-dir chỉ-đọc với mã trong sandbox), nên mã/model không xóa hay sửa được.
function hostAudit(obj, code) {
	const file = path.join(agentDir, "host-audit.jsonl");
	try {
		if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + ".1");
	} catch {
		/* chưa có file */
	}
	const rec = {
		ts: new Date().toISOString(), session: obj.session_id ?? auditCtx.sessionId, model: obj.model ?? auditCtx.model,
		dir: auditCtx.dir, sandbox: auditCtx.sandbox, plan: auditCtx.plan,
		prompt_sha256: auditCtx.promptSha, prompt_len: auditCtx.promptLen,
		status: obj.status, exit: code, error: obj.error ? obj.error.code : null,
		tool_calls: obj.tool_calls, pending_permissions: (obj.pending_permissions || []).map((p) => p.id),
		files_changed: (obj.files_changed || []).slice(0, 50), files_changed_total: (obj.files_changed || []).length,
		duration_ms: obj.duration_ms, pid: process.pid,
	};
	fs.appendFileSync(file, redact(JSON.stringify(rec)) + "\n", { mode: 0o600 });
}
function writeAllSync(fd, text) {
	const buf = Buffer.from(text);
	let off = 0;
	while (off < buf.length) {
		try {
			off += fs.writeSync(fd, buf, off);
		} catch (e) {
			if (e.code !== "EAGAIN") throw e; // pipe đầy: thử lại
		}
	}
}
// Ghi ĐỒNG BỘ rồi thoát ngay: không để mã phía sau chạy tiếp (vd. tùy chọn sai nhưng vẫn khởi chạy coder) và đảm bảo đúng MỘT đối tượng JSON.
function emit(obj, code) {
	if (emitted) process.exit(code);
	emitted = true;
	if (auditCtx) {
		try {
			hostAudit(obj, code);
		} catch {
			/* không để lỗi ghi nhật ký làm hỏng kết quả */
		}
	}
	try {
		writeAllSync(1, redact(JSON.stringify(obj)) + "\n");
	} catch {
		/* stdout đã đóng */
	}
	process.exit(code);
}

const argv = process.argv.slice(2);
const opt = { model: process.env.CODER_DEFAULT_MODEL || "deepseek-v4.1-flash-fast", session: undefined, dir: undefined, timeout: 900, sandbox: false, plan: false, promptFile: undefined };
let promptParts = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const val = () => {
		if (i + 1 >= argv.length) usageError(`thiếu giá trị cho ${a}`);
		return argv[++i];
	};
	if (a === "--") { promptParts = promptParts.concat(argv.slice(i + 1)); break; }
	else if (a === "--model") opt.model = val();
	else if (a === "--session") opt.session = val();
	else if (a === "--dir") opt.dir = val();
	else if (a === "--timeout") opt.timeout = Number(val());
	else if (a === "--prompt-file") opt.promptFile = val();
	else if (a === "--sandbox") opt.sandbox = true;
	else if (a === "--plan") opt.plan = true;
	else if (a.startsWith("-") && a.length > 1) usageError(`tùy chọn không hợp lệ: ${a} (dùng -- trước prompt bắt đầu bằng '-')`);
	else promptParts.push(a);
}
if (!opt.model || !/^[^\s]+$/.test(opt.model)) usageError("--model không hợp lệ");
if (!Number.isFinite(opt.timeout) || opt.timeout <= 0) usageError("--timeout phải là số giây > 0");
let prompt;
if (opt.promptFile) {
	if (promptParts.length) usageError("chỉ dùng một trong --prompt-file hoặc prompt trên dòng lệnh");
	try { prompt = fs.readFileSync(opt.promptFile, "utf8"); } catch (e) { usageError(`không đọc được --prompt-file: ${e.code || e.message}`); }
} else prompt = promptParts.join(" ");
if (!prompt || !prompt.trim()) usageError("thiếu prompt");
const sessionId = opt.session ?? `run-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
if (!/^[A-Za-z0-9_.-]{1,120}$/.test(sessionId) || sessionId.startsWith(".")) usageError("--session chỉ gồm A-Z a-z 0-9 _ . - (tối đa 120 ký tự)");
let workDir;
try {
	workDir = fs.realpathSync(path.resolve(opt.dir ?? process.cwd()));
	if (!fs.statSync(workDir).isDirectory()) throw new Error("not dir");
} catch { usageError(`--dir không tồn tại hoặc không phải thư mục: ${opt.dir}`); }

auditCtx = {
	sessionId, model: opt.model, dir: workDir, sandbox: !!opt.sandbox, plan: !!opt.plan,
	promptSha: crypto.createHash("sha256").update(prompt).digest("hex"), promptLen: Buffer.byteLength(prompt),
};

// ---------- trạng thái thu thập ----------
const st = {
	sessionId, tools: new Map(), byName: {}, total: 0, errors: 0, files: new Set(), pending: new Map(), clarif: null,
	usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0, seen: false },
	lastAssistant: null, lastText: "", aborted: false, sawAgentEnd: false, stderr: "", badLines: 0,
};
const abs = (p) => (typeof p === "string" && p ? path.resolve(workDir, p) : null);
const textOf = (content) =>
	Array.isArray(content) ? content.filter((c) => c && c.type === "text").map((c) => c.text).join("") : typeof content === "string" ? content : "";

function noteFile(p) { const a = abs(p); if (a) st.files.add(a); }
function parsePermFromText(text) {
	for (const line of String(text).split("\n")) {
		const i = line.indexOf('{"needs_permission"');
		if (i < 0) continue;
		try { const o = JSON.parse(line.slice(i)); if (o.needs_permission) return o.needs_permission; } catch { /* bỏ qua */ }
	}
	return null;
}
function addPending(np) {
	if (!np || !np.id || st.pending.has(np.id)) return;
	st.pending.set(np.id, {
		id: np.id, tool: np.tool ?? null, subject: np.subject ?? null, rule: np.rule ?? null,
		approve: `coder approve ${np.id} [--always]`, deny: `coder deny ${np.id}`,
	});
}
function qText(q) {
	if (typeof q === "string") return q;
	let s = String(q?.question ?? JSON.stringify(q));
	const opts = Array.isArray(q?.options) ? q.options.map((o) => o?.label).filter(Boolean) : [];
	if (opts.length) s += ` [options: ${opts.join(" | ")}]`;
	return s;
}

function onToolEnd(ev) {
	const name = ev.toolName ?? "unknown";
	const start = st.tools.get(ev.toolCallId);
	const args = start?.args ?? {};
	st.total++;
	st.byName[name] = (st.byName[name] || 0) + 1;
	if (ev.isError) st.errors++;
	const res = ev.result ?? {};
	const text = textOf(res.content);
	const details = res.details && typeof res.details === "object" ? res.details : {};
	if (details.needs_permission) addPending(details.needs_permission);
	else if (ev.isError || /needs_permission/.test(text)) addPending(parsePermFromText(text));
	if (name === "question" && details.needs_clarification === true && Array.isArray(details.questions)) {
		st.clarif = (st.clarif || []).concat(details.questions.map(qText));
	}
	if (ev.isError) return;
	if (name === "write" || name === "edit") noteFile(args.path ?? args.file_path);
	else if (name === "apply_patch") {
		if (Array.isArray(details.files) && details.files.length) details.files.forEach(noteFile);
		else {
			const src = typeof args === "string" ? args : args.input ?? args.patch ?? args.patchText ?? "";
			for (const m of String(src).matchAll(/^\*\*\* (?:Add|Update) File:\s*(.+?)\s*$/gm)) noteFile(m[1]);
		}
	}
}

function onEvent(ev) {
	switch (ev.type) {
		case "session": if (ev.id) st.sessionId = ev.id; break;
		case "tool_execution_start": st.tools.set(ev.toolCallId, { name: ev.toolName, args: ev.args }); break;
		case "tool_execution_end": onToolEnd(ev); break;
		case "entry_appended":
			if (ev.entry?.customType === "permission_request") addPending(ev.entry.data);
			break;
		case "message_end": {
			const m = ev.message;
			if (m?.role !== "assistant") break;
			st.lastAssistant = m;
			const t = textOf(m.content);
			if (t.trim()) st.lastText = t;
			else if (m.stopReason === "stop") st.lastText = "";
			if (m.usage) {
				const u = m.usage;
				st.usage.seen = true;
				st.usage.input += u.input || 0;
				st.usage.output += u.output || 0;
				st.usage.cache_read += u.cacheRead || 0;
				st.usage.cache_write += u.cacheWrite || 0;
				st.usage.total_tokens += u.totalTokens || 0;
				st.usage.cost += u.cost?.total || 0;
			}
			break;
		}
		case "agent_end": st.sawAgentEnd = true; break;
		case "agent_settled": if (ev.aborted) st.aborted = true; break;
	}
}

// ---------- chạy tiến trình con ----------
const launcher = process.env.CODER_RUN_LAUNCHER || path.join(coderRoot, opt.sandbox ? "coder-sandbox" : "coder"); // CODER_RUN_LAUNCHER: chỉ để test bằng fixture
const sessionDir = path.join(agentDir, "sessions");
const childArgs = ["--mode", "json", "--model", opt.model, "--session-id", sessionId, "--session-dir", sessionDir];
if (opt.plan) childArgs.push("--plan");
childArgs.push("--", prompt);
const childEnv = { ...process.env, ...agentEnv(agentDir), CODER_WORKDIR: workDir };
if (opt.plan) childEnv.CODER_PLAN = "1";

log(`launcher=${path.basename(launcher)} model=${opt.model} session=${sessionId} dir=${workDir} timeout=${opt.timeout}s${opt.plan ? " plan" : ""}`);
let timedOut = false, interrupted = false, exited = false, exitCode = null, exitSignal = null, spawnErr = null;
let child;
try {
	child = spawn(launcher, childArgs, { cwd: workDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
} catch (e) {
	spawnErr = e;
	const r = finalize();
	emit(r.obj, r.code);
}
const decoder = new StringDecoder("utf8");
let buf = "";
child?.stdout.on("data", (d) => {
	buf += decoder.write(d);
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		let line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		handleLine(line);
	}
});
function handleLine(line) {
	if (!line.trim()) return;
	let ev;
	try { ev = JSON.parse(line); } catch { st.badLines++; return; }
	try { onEvent(ev); } catch (e) { log("lỗi xử lý sự kiện:", e.message); }
}
child?.stderr.on("data", (d) => {
	const s = d.toString("utf8");
	if (st.stderr.length < 64 * 1024) st.stderr += s;
	process.stderr.write(redact(s));
});
child?.on("error", (e) => {
	spawnErr = e;
	if (!exited) { exited = true; clearTimeout(timer); const r = finalize(); emit(r.obj, r.code); }
});

const killGroup = (sig) => { try { process.kill(-child.pid, sig); return true; } catch { return false; } };
let killTimer = null;
function terminate(why) {
	log(`${why}: gửi SIGTERM cho nhóm tiến trình ${child.pid}`);
	killGroup("SIGTERM");
	killTimer = setTimeout(() => {
		log("SIGKILL nhóm tiến trình");
		killGroup("SIGKILL");
		// pipe có thể bị cháu giữ mở nên 'close' không tới: chốt cứng
		setTimeout(() => { if (!exited) { exited = true; const r = finalize({ forced: true }); emit(r.obj, r.code); } }, 1500);
	}, 5000);
}
const timer = setTimeout(() => { timedOut = true; terminate("hết timeout"); }, opt.timeout * 1000);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { interrupted = true; terminate(`nhận ${sig}`); });

// Chờ cả 'close' (stdout đóng) lẫn dọn nhóm; nếu nhóm còn sót sau khi leader thoát thì SIGKILL.
child?.on("close", (code, signal) => {
	exited = true; exitCode = code; exitSignal = signal;
	clearTimeout(timer);
	if (buf.trim()) handleLine(buf);
	const rest = decoder.end();
	if (rest) handleLine(rest);
	const leftover = killGroup(0) ? killGroup("SIGKILL") : false;
	if (killTimer) clearTimeout(killTimer);
	const r = finalize({ leftover });
	emit(r.obj, r.code);
});
// ---------- phân loại lỗi ----------
function classify(blob, exit) {
	const s = blob || "";
	if (/model\b.{0,80}\bnot found|unknown model|no such model|model_not_found|model .* does not exist|invalid model/i.test(s))
		return { code: "model_not_found", retryable: false };
	if (/\b429\b|rate[ _-]?limit|too many requests|quota|usage limit|insufficient[_ ]quota|credit/i.test(s))
		return { code: "rate_limit", retryable: true };
	if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?(api[_ -]?)?key|incorrect api key|token[^.\n]{0,30}expired|expired[^.\n]{0,30}token|not (logged|signed) in|\blog ?in\b|please (login|sign in)|authentication|no api key|missing api key|credentials?/i.test(s))
		return { code: "auth", retryable: false };
	if (/\b5\d\d\b|overloaded|econn(reset|refused)|etimedout|enotfound|eai_again|fetch failed|socket hang up|network|bad gateway|service unavailable|gateway timeout|upstream|provider|stream (ended|error)/i.test(s))
		return { code: "provider", retryable: true };
	return { code: exit ? "internal" : "provider", retryable: false };
}

// ---------- tách dòng STATUS và tóm tắt ----------
function parseFinal(text) {
	const lines = text.split("\n");
	let statusIdx = -1, status = null;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		const m = lines[i].match(/^\s*[*_`#>\s-]*STATUS\s*:\s*[*_`]*\s*(done|partial|blocked)\b/i);
		if (m) { statusIdx = i; status = m[1].toLowerCase(); }
		break;
	}
	const statusLine = statusIdx >= 0 ? lines[statusIdx].trim() : null;
	const body = lines.slice(statusIdx + 1);
	const heads = {
		changed: /^(?:changed|changes|đã (?:sửa|thay đổi)|thay đổi|đã thay đổi|sửa đổi)/i,
		verification: /^(?:verification|verified|kiểm chứng|xác minh|kiểm tra|đã kiểm tra)/i,
		pending: /^(?:pending|còn (?:lại|tồn đọng)|tồn đọng|chờ xử lý|chưa xong|chờ)/i,
	};
	const sec = { changed: [], verification: [], pending: [] };
	let cur = null;
	for (const raw of body) {
		const m = raw.match(/^\s*(?:[-*•]\s+)?[*_`]*([^:*_`]{2,30}?)[*_`]*\s*:[*_`]*\s*(.*)$/);
		let hit = null;
		if (m) for (const k of Object.keys(heads)) if (heads[k].test(m[1].trim())) hit = k;
		if (hit) { cur = hit; if (m[2].trim()) sec[cur].push(m[2].trim()); continue; }
		if (cur && raw.trim()) sec[cur].push(raw.trim().replace(/^[-*•]\s+/, ""));
	}
	const summary = { changed: sec.changed };
	if (sec.verification.length) summary.verification = sec.verification.join("\n");
	if (sec.pending.length) summary.pending = sec.pending.join("\n");
	return { status, statusLine, summary };
}

function finalize(extra = {}) {
	const warnings = [];
	const stderrClean = st.stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !/^Warning: No project session found with id/.test(l));
	const stderrTail = stderrClean.slice(-5).join("\n").slice(0, 800);
	const last = st.lastAssistant;
	const lastErr = last && (last.stopReason === "error" || last.stopReason === "aborted") ? last.errorMessage || last.stopReason : null;

	let error = null;
	if (spawnErr) {
		error = { code: "internal", message: `không chạy được ${path.basename(launcher)}: ${spawnErr.message}`, retryable: false };
	} else if (timedOut) {
		error = { code: "timeout", message: `quá ${opt.timeout}s; đã dừng nhóm tiến trình`, retryable: true };
	} else if (interrupted) {
		error = { code: "internal", message: "run-cli bị ngắt (tín hiệu); đã dừng nhóm tiến trình", retryable: true };
	} else if (exitCode !== 0 || exitSignal) {
		const blob = [lastErr, stderrTail].filter(Boolean).join("\n");
		const c = classify(blob, true);
		error = {
			code: c.code,
			message: (blob || `lõi agent thoát với mã ${exitCode ?? exitSignal}`).slice(0, 800),
			retryable: c.retryable,
		};
		if (exitCode === 127) { error.code = "internal"; error.retryable = false; }
	} else if (lastErr && !st.lastText.trim()) {
		const c = classify(String(lastErr), false);
		error = { code: c.code, message: String(lastErr).slice(0, 800), retryable: c.retryable };
	} else if (st.aborted) {
		error = { code: "internal", message: "phiên bị hủy (aborted)", retryable: true };
	} else if (lastErr) {
		warnings.push(`lượt cuối kết thúc bằng lỗi nhưng đã có câu trả lời: ${String(lastErr).slice(0, 200)}`);
	}
	if (!error && stderrTail && st.badLines === 0 && !last) {
		error = { code: "internal", message: `lõi agent không phát sự kiện nào: ${stderrTail}`.slice(0, 800), retryable: false };
	}
	if (extra.leftover) warnings.push("còn tiến trình con sót lại sau khi lõi agent thoát; đã SIGKILL cả nhóm");
	if (extra.forced) warnings.push("pipe của tiến trình con không đóng; chốt kết quả sau SIGKILL");
	if (st.badLines) warnings.push(`${st.badLines} dòng stdout không phải JSON (bỏ qua)`);
	if (!error && stderrTail && /error|fail|exception/i.test(stderrTail)) warnings.push(`stderr: ${stderrTail.slice(0, 300)}`);

	const pending = [...st.pending.values()];
	const clarif = st.clarif && st.clarif.length ? st.clarif : null;
	const finalText = st.lastText.trim();
	const parsed = parseFinal(finalText);
	let status;
	if (error) status = "error";
	else {
		status = parsed.status;
		if (!status) {
			status = "partial";
			warnings.push(finalText ? "câu trả lời cuối không có dòng 'STATUS: done|partial|blocked' ở đầu" : "không có câu trả lời cuối từ model");
		}
		if (clarif && status !== "blocked") {
			if (status === "done") warnings.push("model báo done nhưng có câu hỏi làm rõ; hạ xuống blocked");
			status = "blocked";
		}
		if (pending.length && status === "done") {
			status = "partial";
			warnings.push("model báo done nhưng còn yêu cầu quyền chưa duyệt; hạ xuống partial");
		}
	}
	let code = EXIT[status];
	if (error) code = error.code === "auth" ? EXIT.auth : error.code === "timeout" ? EXIT.timeout : error.code === "rate_limit" ? EXIT.rate_limit : EXIT.error;

	const obj = {
		ok: status === "done",
		status,
		session_id: st.sessionId,
		model: opt.model,
		final_text: finalText,
		status_line: parsed.statusLine,
		summary: parsed.summary,
		files_changed: [...st.files],
		tool_calls: { total: st.total, by_name: st.byName, errors: st.errors },
		pending_permissions: pending,
		needs_clarification: clarif,
		usage: st.usage.seen
			? { input: st.usage.input, output: st.usage.output, cache_read: st.usage.cache_read, cache_write: st.usage.cache_write, total_tokens: st.usage.total_tokens, cost: st.usage.cost }
			: null,
		duration_ms: Date.now() - startedAt,
		warnings,
		error,
	};
	return { obj, code };
}
