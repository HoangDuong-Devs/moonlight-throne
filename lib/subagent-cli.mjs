#!/usr/bin/env node
/**
 * CLI quản lý job subagent (nền / tách rời) của coder. Node thuần, không phụ thuộc gói ngoài.
 *
 *   subagent-cli.mjs list   [--all] [--root <ns>] [--status running|completed|...] [--json]
 *   subagent-cli.mjs status <id> [--json]
 *   subagent-cli.mjs wait   <id> [--timeout <giây|10s|2m|500ms>] [--json]
 *   subagent-cli.mjs result <id> [--json]
 *   subagent-cli.mjs cancel <id> [--all] [--root <ns>] [--json]   (cùng quy tắc namespace/strictParent như list)
 *   subagent-cli.mjs prune  [--days N] [--json]
 *
 * Thư mục agent: $PI_CODING_AGENT_DIR (mặc định <coder>/agent). Namespace mặc định lấy từ
 * $CODER_JOB_NAMESPACE (list chỉ hiện job cùng namespace, trừ khi --all).
 * Mã thoát: 0 ok; 1 job failed/timeout/cancelled (status/wait/result) hoặc lỗi; 2 còn đang chạy
 * (wait hết --timeout, result khi chưa xong); 64 sai cú pháp; 66 không thấy job.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { cancelJob, denyForeign, getJob, listJobs, pruneJobs, SESSION_ID_RE, waitJob } from "../agent/extensions/subagent/jobs-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR || path.resolve(here, "..", "agent");

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--json" || a === "--all") flags[a.slice(2)] = true;
	else if (["--timeout", "--root", "--status", "--days"].includes(a)) flags[a.slice(2)] = argv[++i];
	else if (a.startsWith("--")) usage(`Cờ không hợp lệ: ${a}`);
	else pos.push(a);
}
const [cmd, id] = pos;
const json = flags.json === true;

function usage(msg) {
	if (msg) console.error(msg);
	console.error("Dùng: subagent-cli.mjs <list|status|wait|result|cancel|prune> [id] [--json] [--timeout 30s] [--all] [--root ns] [--status s] [--days N]");
	process.exit(64);
}
const out = (obj, text) => console.log(json ? JSON.stringify(obj) : text);
const parseDur = (s) => {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(s));
	if (!m) usage(`--timeout không hợp lệ: ${s}`);
	return Number(m[1]) * (m[2] === "ms" ? 1 : m[2] === "m" ? 60000 : 1000);
};
const brief = (m) => ({
	sessionID: m.sessionID, status: m.status, agent: m.agent, description: m.description, mode: m.mode,
	rootId: m.rootId, parentSessionId: m.parentSessionId, cwd: m.cwd, pid: m.pid,
	startedAt: m.startedAt, endedAt: m.endedAt, error: m.error,
});
const need = () => {
	if (!id || !SESSION_ID_RE.test(id)) usage("Thiếu hoặc sai sessionID");
	const m = getJob(agentDir, id);
	if (!m) {
		out({ error: "not_found", sessionID: id }, `Không tìm thấy job ${id}`);
		process.exit(66);
	}
	return m;
};
const line = (m) => {
	const age = Math.round(((m.endedAt ?? Date.now()) - m.startedAt) / 1000);
	return `${m.sessionID}\t${m.status}\t${m.agent}\t${age}s\t${m.mode ?? "attached"}\t${m.description}`;
};
const code = (m) => (m.status === "completed" ? 0 : m.status === "running" ? 2 : 1);

switch (cmd) {
	case "list": {
		const root = flags.root ?? (flags.all ? undefined : process.env.CODER_JOB_NAMESPACE ? `ns:${process.env.CODER_JOB_NAMESPACE}` : undefined);
		let rows = listJobs(agentDir);
		if (root) rows = rows.filter((m) => m.rootId === root || m.rootId === `ns:${root}`);
		if (flags.status) rows = rows.filter((m) => m.status === flags.status);
		out(rows.map(brief), rows.map(line).join("\n") || "(không có job nào)");
		break;
	}
	case "status": {
		const m = need();
		out(brief(m), `${line(m)}${m.error ? `\nLỗi: ${m.error}` : ""}`);
		process.exit(m.status === "running" ? 0 : code(m));
		break;
	}
	case "wait": {
		need();
		const r = await waitJob(agentDir, id, { timeoutMs: flags.timeout !== undefined ? parseDur(flags.timeout) : undefined });
		const m = r.meta;
		if (r.timedOut) {
			out({ ...brief(m), timedOut: true }, `Hết thời gian chờ; job ${id} vẫn đang chạy`);
			process.exit(2);
		}
		out({ ...brief(m), result: m.result }, `${line(m)}${m.error ? `\nLỗi: ${m.error}` : ""}${m.result ? `\n\n${m.result}` : ""}`);
		process.exit(code(m));
		break;
	}
	case "result": {
		const m = need();
		out({ ...brief(m), result: m.result }, m.status === "running" ? `Job ${id} đang chạy` : `${m.result ?? ""}${m.error ? `\n\nLỗi: ${m.error}` : ""}`);
		process.exit(code(m));
		break;
	}
	case "cancel": {
		const target = need();
		// Cùng quy tắc với list: có namespace thì chỉ hủy job cùng namespace (trừ --all); strictParent:"always" thì thiếu namespace => từ chối.
		if (!flags.all) {
			const root = flags.root ?? (process.env.CODER_JOB_NAMESPACE ? `ns:${process.env.CODER_JOB_NAMESPACE}` : undefined);
			let strict = true;
			try {
				strict = JSON.parse(fs.readFileSync(path.join(agentDir, "subagent.json"), "utf-8")).strictParent;
			} catch {}
			strict = strict === "always" ? "always" : strict !== false;
			const foreign = root ? target.rootId !== root && target.rootId !== `ns:${root}` : undefined;
			const deny = foreign
				? `Job ${id} không thuộc namespace ${root}`
				: strict === "always"
					? denyForeign("always", root ? target.rootId : undefined, target)
					: undefined;
			if (deny) {
				out({ error: "forbidden", sessionID: id, message: deny }, deny);
				process.exit(1);
			}
		}
		const m = await cancelJob(agentDir, id);
		out(brief(m), `${line(m)}`);
		process.exit(m.status === "running" ? 1 : 0);
		break;
	}
	case "prune": {
		const days = flags.days !== undefined ? Number(flags.days) : 7;
		if (!(days >= 0)) usage("--days không hợp lệ");
		const n = pruneJobs(agentDir, Math.max(days, 0.0001) * 86400000);
		out({ pruned: n }, `Đã xóa ${n} job`);
		break;
	}
	default:
		usage();
}
