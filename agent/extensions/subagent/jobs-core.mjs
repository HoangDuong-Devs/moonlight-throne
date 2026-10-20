/**
 * Logic job subagent dùng chung cho extension (index.ts) và CLI (lib/subagent-cli.mjs).
 * Node thuần, không phụ thuộc Pi. Trạng thái nằm ở file meta:
 *   <agentDir>/sessions/subagents/<id>.meta.json  (+ <id>.spec.json cho job tách rời)
 *
 * Job "tách rời" (detached) chạy qua một tiến trình điều phối (supervisor, chính file này
 * chạy với đối số `supervise`) có session riêng (setsid): cha thoát thì job vẫn sống, kết quả
 * được supervisor ghi vào meta. Tiến trình chết bất thường được phát hiện bằng pid + starttime.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const TERMINAL = ["completed", "failed", "timeout", "cancelled"];

export const dirOf = (agentDir) => path.join(agentDir, "sessions", "subagents");
const metaFile = (agentDir, id) => path.join(dirOf(agentDir), `${id}.meta.json`);
const specFile = (agentDir, id) => path.join(dirOf(agentDir), `${id}.spec.json`);

export function readMeta(agentDir, id) {
	if (!SESSION_ID_RE.test(id)) return undefined;
	try {
		const m = JSON.parse(fs.readFileSync(metaFile(agentDir, id), "utf-8"));
		// Meta giả: tên file là nguồn tin cậy duy nhất cho id; nội dung không khớp thì coi như hỏng.
		return m && typeof m === "object" && m.sessionID === id ? m : undefined;
	} catch {
		return undefined;
	}
}

/** Ghi nguyên tử (tmp + rename) để người đọc không thấy file dở dang. */
export function writeMeta(agentDir, meta) {
	try {
		fs.mkdirSync(dirOf(agentDir), { recursive: true });
		const f = metaFile(agentDir, meta.sessionID);
		const tmp = `${f}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, f);
	} catch {}
}

/** Cập nhật meta theo bản mới nhất trên đĩa (read-modify-write). */
export function patchMeta(agentDir, id, patch) {
	const cur = readMeta(agentDir, id);
	if (!cur) return undefined;
	const next = { ...cur, ...patch };
	writeMeta(agentDir, next);
	return next;
}

// ---------------------------------------------------------------- liveness

/**
 * Quyền sở hữu theo cây: trả về lý do từ chối nếu job thuộc cây khác; undefined nếu được phép.
 * strictParent: true (mặc định) | false (tắt) | "always".
 *  - true: chỉ từ chối khi CẢ HAI bên có rootId và khác nhau. Thiếu rootId ở một bên (vd. chạy --no-session, meta cũ)
 *    thì MỞ (cố ý, để không phá luồng --no-session hợp lệ).
 *  - "always": chỉ cho phép khi cả hai có rootId và bằng nhau; thiếu rootId (kể cả cả hai) => từ chối.
 */
export function denyForeign(strictParent, rootId, meta) {
	if (strictParent === false) return undefined;
	const a = rootId;
	const b = meta.rootId;
	const mismatch = strictParent === "always" ? !(a && b && a === b) : a && b && a !== b;
	return mismatch ? `Phiên ${meta.sessionID} không thuộc cây subagent hiện tại (khác namespace/phiên cha).` : undefined;
}

/** pid hợp lệ để NHẮM tín hiệu: số nguyên dương, không phải init, không phải chính mình. */
export function isSignalablePid(pid) {
	return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

export function procInfo(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const s = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const r = s.slice(s.lastIndexOf(")") + 2).split(" ");
		return { state: r[0], pgrp: Number(r[2]), start: r[19] };
	} catch {
		return undefined;
	}
}

function procArgv(pid) {
	try {
		return fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0");
	} catch {
		return undefined;
	}
}

/** Còn sống thật không (loại zombie, chống tái dùng pid nhờ starttime). BẮT BUỘC có `start`: thiếu => không tin. */
export function isAlive(pid, start) {
	if (!Number.isInteger(pid) || pid <= 0 || !start) return false;
	const p = procInfo(pid);
	if (p) return p.state !== "Z" && p.state !== "X" && p.start === start;
	if (process.platform === "linux") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
}

/** pid có đúng là supervisor `jobs-core.mjs supervise <agentDir> <id>` của job này không (cmdline + starttime). */
export function isSupervisorOf(pid, start, id) {
	if (!isSignalablePid(pid) || !isAlive(pid, start)) return false;
	const argv = procArgv(pid);
	if (!argv) return process.platform !== "linux";
	const i = argv.findIndex((x) => path.basename(x) === "jobs-core.mjs");
	return i >= 0 && argv[i + 1] === "supervise" && argv[i + 3] === id;
}

/** pid có đúng là tiến trình pi con của job (--session-id <id>) không. */
export function isChildOf(pid, start, id) {
	if (!isSignalablePid(pid) || !isAlive(pid, start)) return false;
	const argv = procArgv(pid);
	if (!argv) return process.platform !== "linux";
	const i = argv.indexOf("--session-id");
	return i >= 0 && argv[i + 1] === id;
}

/**
 * Gửi tín hiệu cho tiến trình con của job. CHỈ khi đã xác minh (pid + starttime + cmdline có `--session-id <id>`);
 * `trusted` dành cho nơi chính ta vừa spawn (chỉ kiểm starttime). Nhóm tiến trình chỉ bị giết khi pid là trưởng nhóm
 * thật (pgrp === pid) và không phải nhóm của chính ta; ngược lại chỉ giết đúng pid đó.
 */
function killTree(pid, start, sig, id, { trusted = false } = {}) {
	if (!isSignalablePid(pid)) return false;
	if (!(trusted ? isAlive(pid, start) : isChildOf(pid, start, id))) return false;
	const info = procInfo(pid);
	const own = procInfo(process.pid);
	try {
		if (info && info.pgrp === pid && (!own || own.pgrp !== pid)) process.kill(-pid, sig);
		else process.kill(pid, sig);
		return true;
	} catch {
		return false;
	}
}

const SPAWN_GRACE_MS = 15_000;

/** pid chủ của job còn đúng không: detached => phải là supervisor của job; attached => pid + starttime khớp. */
function ownerAlive(meta) {
	if (meta.mode === "detached") return isSupervisorOf(meta.pid, meta.pidStart, meta.sessionID);
	return isAlive(meta.pid, meta.pidStart);
}

/** Nếu job còn "running" mà tiến trình sở hữu đã chết/không xác minh được → đánh dấu failed (và dọn con mồ côi đã xác minh). */
export function reconcile(agentDir, meta) {
	if (!meta || meta.status !== "running") return meta;
	// Cửa sổ khởi tạo: meta được ghi trước khi biết pid.
	if (meta.pid === undefined && meta.pidStart === undefined && Date.now() - (meta.startedAt ?? 0) < SPAWN_GRACE_MS) return meta;
	if (ownerAlive(meta)) return meta;
	const fresh = readMeta(agentDir, meta.sessionID);
	if (!fresh || fresh.status !== "running") return fresh ?? meta;
	killTree(fresh.childPid, fresh.childStart, "SIGKILL", fresh.sessionID);
	const unverifiable = !fresh.pidStart;
	return (
		patchMeta(agentDir, fresh.sessionID, {
			status: "failed",
			error: unverifiable
				? "Meta không hợp lệ (thiếu pid/pidStart); không gửi tín hiệu cho tiến trình nào"
				: `Tiến trình ${fresh.mode === "detached" ? "điều phối" : "cha"} (pid ${fresh.pid}) đã chết bất thường hoặc không còn là tiến trình của job`,
			endedAt: Date.now(),
		}) ?? fresh
	);
}

export function getJob(agentDir, id) {
	return reconcile(agentDir, readMeta(agentDir, id));
}

export function listJobs(agentDir) {
	let names = [];
	try {
		names = fs.readdirSync(dirOf(agentDir));
	} catch {}
	const out = [];
	for (const n of names) {
		if (!n.endsWith(".meta.json")) continue;
		const m = getJob(agentDir, n.slice(0, -".meta.json".length));
		if (m) out.push(m);
	}
	return out.sort((a, b) => b.startedAt - a.startedAt);
}

export const countRunning = (agentDir) => listJobs(agentDir).filter((m) => m.status === "running").length;

/** Xóa job đã kết thúc quá hạn (meta, spec và file phiên). Trả về số job đã xóa. */
/** Tên file thuộc job (khớp CHÍNH XÁC): meta, spec, và file phiên pi `<timestamp>_<id>.jsonl` / `<id>.jsonl`. */
export function jobFileMatcher(id) {
	const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const sess = new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_)?${esc}\\.jsonl$`);
	return (f) => f === `${id}.meta.json` || f === `${id}.spec.json` || sess.test(f);
}

/** Xóa job đã kết thúc quá hạn (meta, spec và file phiên). Trả về số job đã xóa. */
export function pruneJobs(agentDir, retentionMs) {
	if (!(retentionMs > 0)) return 0;
	const dir = dirOf(agentDir);
	let n = 0;
	for (const m of listJobs(agentDir)) {
		if (m.status === "running" || !m.endedAt || Date.now() - m.endedAt < retentionMs) continue;
		if (!SESSION_ID_RE.test(m.sessionID)) continue;
		try {
			const match = jobFileMatcher(m.sessionID);
			for (const f of fs.readdirSync(dir)) if (match(f)) fs.rmSync(path.join(dir, f), { force: true });
			n++;
		} catch {}
	}
	return n;
}

export async function waitJob(agentDir, id, { timeoutMs, signal } = {}) {
	const t0 = Date.now();
	for (;;) {
		const m = getJob(agentDir, id);
		if (!m || m.status !== "running") return { meta: m, timedOut: false };
		if (signal?.aborted) return { meta: m, timedOut: true };
		if (timeoutMs !== undefined && Date.now() - t0 >= timeoutMs) return { meta: m, timedOut: true };
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Hủy job. Detached: SIGTERM supervisor (nó giết con và ghi "cancelled"). Attached: giết con, cha ghi kết quả. Chỉ tác động tiến trình đã xác minh. */
export async function cancelJob(agentDir, id) {
	let m = getJob(agentDir, id);
	if (!m || m.status !== "running") return m;
	const detached = m.mode === "detached";
	if (detached) {
		if (!isSupervisorOf(m.pid, m.pidStart, id)) {
			return patchMeta(agentDir, id, { status: "failed", error: "Meta không hợp lệ: pid không phải supervisor của job; không gửi tín hiệu", endedAt: Date.now() }) ?? m;
		}
		try {
			process.kill(m.pid, "SIGTERM");
		} catch {}
	} else killTree(m.childPid, m.childStart, "SIGTERM", id);
	const r = await waitJob(agentDir, id, { timeoutMs: 15000 });
	m = r.meta;
	if (m?.status === "running") {
		killTree(m.childPid, m.childStart, "SIGKILL", id);
		if (detached && isSupervisorOf(m.pid, m.pidStart, id)) {
			try {
				process.kill(m.pid, "SIGKILL");
			} catch {}
		}
		m = patchMeta(agentDir, id, { status: "cancelled", error: "Đã hủy (buộc)", endedAt: Date.now() }) ?? m;
	}
	return m;
}

// ---------------------------------------------------------------- khởi chạy tách rời

/**
 * Tạo supervisor tách rời. `spec` = {command, args, cwd, env (phần bổ sung), timeoutMs}.
 * Meta (status running) phải đã được ghi trước; hàm này cập nhật pid/pidStart.
 */
export function launchDetached(agentDir, meta, spec) {
	fs.mkdirSync(dirOf(agentDir), { recursive: true });
	fs.writeFileSync(specFile(agentDir, meta.sessionID), JSON.stringify(spec), { mode: 0o600 });
	const self = fileURLToPath(import.meta.url);
	const proc = spawn(process.execPath, [self, "supervise", agentDir, meta.sessionID], {
		detached: true,
		stdio: "ignore",
		cwd: spec.cwd,
		env: process.env,
	});
	proc.on("error", () => {});
	proc.unref();
	const info = proc.pid ? procInfo(proc.pid) : undefined;
	return patchMeta(agentDir, meta.sessionID, { mode: "detached", pid: proc.pid, pidStart: info?.start }) ?? meta;
}

// ---------------------------------------------------------------- supervisor

function superviseMain(agentDir, id) {
	let spec;
	try {
		spec = JSON.parse(fs.readFileSync(specFile(agentDir, id), "utf-8"));
	} catch {
		patchMeta(agentDir, id, { status: "failed", error: "Thiếu file spec của job", endedAt: Date.now() });
		return;
	} finally {
		try {
			fs.rmSync(specFile(agentDir, id), { force: true });
		} catch {}
	}
	const me = procInfo(process.pid);
	patchMeta(agentDir, id, { mode: "detached", pid: process.pid, pidStart: me?.start });
	for (const s of ["SIGHUP", "SIGPIPE"]) process.on(s, () => {});

	const finishMeta = (patch) => {
		patchMeta(agentDir, id, { ...patch, endedAt: Date.now() });
	};
	process.on("uncaughtException", (e) => {
		finishMeta({ status: "failed", error: `Supervisor lỗi: ${e?.message ?? e}` });
		process.exit(1);
	});

	let proc;
	try {
		proc = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: { ...process.env, ...(spec.env ?? {}) },
			shell: false,
			detached: true, // nhóm tiến trình riêng để hủy được cả cây
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		finishMeta({ status: "failed", error: e.message });
		return;
	}
	const ci = proc.pid ? procInfo(proc.pid) : undefined;
	patchMeta(agentDir, id, { childPid: proc.pid, childStart: ci?.start });

	let buffer = "";
	let stderr = "";
	let lastText = "";
	let stopReason;
	let errorMessage;
	let done = false;
	let cause;
	const kill = (why) => {
		if (done) return;
		cause ??= why;
		killTree(proc.pid, ci?.start, "SIGTERM", id, { trusted: true });
		setTimeout(() => {
			if (!done) killTree(proc.pid, ci?.start, "SIGKILL", id, { trusted: true });
		}, 5000).unref();
	};
	const timer = spec.timeoutMs > 0 ? setTimeout(() => kill("timeout"), spec.timeoutMs) : undefined;
	for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => kill("cancelled"));

	const handleLine = (line) => {
		if (!line.trim()) return;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const text = (ev.message.content ?? [])
				.filter((p) => p.type === "text")
				.map((p) => p.text)
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
	const finish = (code, spawnError, signal) => {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		if (buffer.trim()) handleLine(buffer);
		let r;
		if (cause === "timeout") r = { status: "timeout", result: lastText, error: `Hết thời gian (${spec.timeoutMs} ms)` };
		else if (cause === "cancelled") r = { status: "cancelled", result: lastText, error: "Đã hủy" };
		else if (spawnError) r = { status: "failed", result: lastText, error: spawnError };
		else if (code !== 0 || stopReason === "error" || stopReason === "aborted")
			r = { status: "failed", result: lastText, error: errorMessage || (signal ? `pi con bị giết bởi tín hiệu ${signal}` : stderr.trim() || `pi con thoát với mã ${code}`) };
		else r = { status: "completed", result: lastText || "(không có đầu ra)" };
		finishMeta({ ...r, childPid: undefined, childStart: undefined });
		process.exit(0);
	};
	proc.on("close", (code, sig) => finish(code, undefined, sig));
	proc.on("error", (e) => finish(1, e.message));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "supervise") {
	superviseMain(process.argv[3], process.argv[4]);
}
