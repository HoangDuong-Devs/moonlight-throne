// Test hồi quy cho subagent (J1, J2). Chạy: node --test test/*.test.mjs  (hoặc --experimental-strip-types)
// Mọi tiến trình "nạn nhân" là `sleep`/node nhàn rỗi do test tạo và dọn.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../agent/extensions/subagent/jobs-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "lib", "subagent-cli.mjs");
const base = fs.existsSync("/tmp/claude-1002") ? "/tmp/claude-1002" : os.tmpdir();
const root = fs.mkdtempSync(path.join(base, "subtest-"));
const procs = [];
after(() => {
	for (const p of procs) {
		try {
			process.kill(-p.pid, "SIGKILL");
		} catch {}
		try {
			p.kill("SIGKILL");
		} catch {}
	}
	fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
const newAgent = () => {
	const a = path.join(root, `agent${++n}`);
	fs.mkdirSync(core.dirOf(a), { recursive: true });
	return a;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		const st = core.procInfo(pid);
		return !!st && st.state !== "Z";
	} catch {
		return false;
	}
};
/** Nạn nhân vô hại: tiến trình ngủ (đầu của nhóm riêng nếu detached). */
function victim({ detached = true, extraArgs = [] } = {}) {
	const p = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", ...extraArgs], { detached, stdio: "ignore" });
	procs.push(p);
	return p;
}
const meta = (o) => ({ sessionID: o.sessionID, agent: "explore", description: "d", cwd: root, status: "running", startedAt: Date.now() - 60_000, ...o });
const put = (agent, m) => fs.writeFileSync(path.join(core.dirOf(agent), `${m.sessionID}.meta.json`), JSON.stringify(m));
const cli = (agent, args, env = {}) => {
	const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agent, CODER_JOB_NAMESPACE: "", ...env } });
	return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("J2: meta giả không khiến kill tiến trình tùy ý", () => {
	test("thiếu pidStart: không kill, meta bị đánh dấu hỏng (list/status/reconcile/cancel)", async () => {
		const agent = newAgent();
		const v = victim();
		for (const mode of ["detached", "attached"]) {
			const id = `forged_${mode}`;
			put(agent, meta({ sessionID: id, mode, pid: v.pid, childPid: v.pid }));
			const m = core.getJob(agent, id);
			assert.equal(m.status, "failed", mode);
			assert.match(m.error, /không hợp lệ/);
		}
		await sleep(100);
		assert.ok(alive(v.pid), "nạn nhân bị giết");
		// cancel trực tiếp trên meta giả có pid trùng nạn nhân
		put(agent, meta({ sessionID: "forged_cancel", mode: "detached", pid: v.pid }));
		await core.cancelJob(agent, "forged_cancel");
		await sleep(100);
		assert.ok(alive(v.pid));
	});

	test("pidStart khớp nhưng cmdline không phải supervisor/con của job: không kill", async () => {
		const agent = newAgent();
		const v = victim();
		const start = core.procInfo(v.pid).start;
		put(agent, meta({ sessionID: "forged_a", mode: "detached", pid: v.pid, pidStart: start }));
		const r = await core.cancelJob(agent, "forged_a");
		assert.equal(r.status, "failed");
		// con giả: cha attached đã chết, childPid trỏ nạn nhân (có pidStart đúng)
		const dead = spawnSync("true");
		put(agent, meta({ sessionID: "forged_b", mode: "attached", pid: 999999, pidStart: "1", childPid: v.pid, childStart: start }));
		assert.equal(core.getJob(agent, "forged_b").status, "failed");
		// con thật sự mang --session-id <id> khác => không phải của job này
		const other = victim({ extraArgs: ["--", "--session-id", "someone_else"] });
		put(agent, meta({ sessionID: "forged_c", mode: "attached", pid: 999999, pidStart: "1", childPid: other.pid, childStart: core.procInfo(other.pid).start }));
		core.getJob(agent, "forged_c");
		await sleep(150);
		assert.ok(alive(v.pid) && alive(other.pid));
		void dead;
	});

	test("pid 1 / chính mình / số âm không bao giờ bị nhắm", () => {
		for (const bad of [1, 0, -5, process.pid, 1.5, "1", undefined, null]) assert.equal(core.isSignalablePid(bad), false, String(bad));
		const agent = newAgent();
		put(agent, meta({ sessionID: "forged_pid1", mode: "attached", pid: 999999, pidStart: "1", childPid: 1, childStart: core.procInfo(1)?.start ?? "1" }));
		assert.equal(core.getJob(agent, "forged_pid1").status, "failed"); // và vẫn sống (đang chạy test)
		put(agent, meta({ sessionID: "forged_self", mode: "attached", pid: 999999, pidStart: "1", childPid: process.pid, childStart: core.procInfo(process.pid).start }));
		assert.equal(core.getJob(agent, "forged_self").status, "failed");
	});

	test("con mồ côi THẬT (đúng --session-id, đúng starttime) vẫn được dọn khi cha chết", async () => {
		const agent = newAgent();
		const id = "real_orphan";
		const child = victim({ extraArgs: ["--", "--session-id", id] });
		put(agent, meta({ sessionID: id, mode: "attached", pid: 999999, pidStart: "1", childPid: child.pid, childStart: core.procInfo(child.pid).start }));
		const m = core.getJob(agent, id);
		assert.equal(m.status, "failed");
		await sleep(300);
		assert.equal(alive(child.pid), false, "con mồ côi thật chưa bị dọn");
	});

	test("supervisor thật: hủy được qua cancelJob (đường hợp lệ vẫn chạy)", async () => {
		const agent = newAgent();
		const id = "real_detached";
		const m0 = meta({ sessionID: id, startedAt: Date.now(), status: "running" });
		core.writeMeta(agent, m0);
		const m = core.launchDetached(agent, m0, {
			command: process.execPath,
			args: ["-e", "setInterval(()=>{},1000)", "--", "--session-id", id],
			cwd: root,
			env: {},
			timeoutMs: 0,
		});
		for (let i = 0; i < 50 && !core.readMeta(agent, id).childPid; i++) await sleep(100);
		const cur = core.readMeta(agent, id);
		assert.ok(cur.childPid, "supervisor chưa spawn con");
		assert.ok(core.isSupervisorOf(cur.pid, cur.pidStart, id));
		assert.equal(core.isSupervisorOf(cur.pid, cur.pidStart, "other_id"), false);
		assert.equal(core.getJob(agent, id).status, "running");
		const r = await core.cancelJob(agent, id);
		assert.equal(r.status, "cancelled");
		await sleep(200);
		assert.equal(alive(cur.childPid), false);
		assert.equal(alive(m.pid), false);
	});

	test("pruneJobs khớp tên file CHÍNH XÁC", () => {
		const agent = newAgent();
		const dir = core.dirOf(agent);
		const old = Date.now() - 10 * 86400_000;
		put(agent, meta({ sessionID: "sub_a", status: "completed", endedAt: old }));
		put(agent, meta({ sessionID: "sub_ab", status: "completed", endedAt: Date.now() }));
		const keep = ["sub_ab.meta.json", "sub_ab.jsonl", "2026-10-20T12-00-00-000Z_sub_ab.jsonl", "other_sub_a.jsonl", "xsub_a.meta.json", "sub_a.txt", "notes-sub_a.jsonl"];
		const gone = ["sub_a.meta.json", "sub_a.jsonl", "sub_a.spec.json", "2026-10-20T12-00-00-000Z_sub_a.jsonl"];
		for (const f of [...keep, ...gone.filter((g) => g !== "sub_a.meta.json")]) fs.writeFileSync(path.join(dir, f), "x");
		// meta giả mang sessionID của job khác không được coi là job đó
		fs.writeFileSync(path.join(dir, "evil.meta.json"), JSON.stringify(meta({ sessionID: "sub_ab", status: "completed", endedAt: old })));
		assert.equal(core.pruneJobs(agent, 86400_000), 1);
		const left = fs.readdirSync(dir).sort();
		for (const g of gone) assert.ok(!left.includes(g), `${g} lẽ ra phải bị xóa`);
		for (const k of keep) assert.ok(left.includes(k), `${k} bị xóa nhầm`);
	});

	test("denyForeign: true mở khi thiếu root; always chặn", () => {
		const m = (rootId) => ({ sessionID: "x", rootId });
		assert.equal(core.denyForeign(true, "ns:a", m("ns:a")), undefined);
		assert.ok(core.denyForeign(true, "ns:a", m("ns:b")));
		assert.equal(core.denyForeign(true, undefined, m("ns:b")), undefined);
		assert.equal(core.denyForeign(true, "ns:a", m(undefined)), undefined);
		assert.equal(core.denyForeign(true, undefined, m(undefined)), undefined);
		assert.ok(core.denyForeign("always", undefined, m("ns:b")));
		assert.ok(core.denyForeign("always", "ns:a", m(undefined)));
		assert.ok(core.denyForeign("always", undefined, m(undefined)));
		assert.equal(core.denyForeign("always", "ns:a", m("ns:a")), undefined);
		assert.equal(core.denyForeign(false, "ns:a", m("ns:b")), undefined);
	});

	async function startReal(agent, id, rootId) {
		const m0 = meta({ sessionID: id, startedAt: Date.now(), rootId });
		core.writeMeta(agent, m0);
		core.launchDetached(agent, m0, { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", "--", "--session-id", id], cwd: root, env: {}, timeoutMs: 0 });
		for (let i = 0; i < 50 && !core.readMeta(agent, id).childPid; i++) await sleep(100);
		return core.readMeta(agent, id);
	}

	test("CLI cancel áp dụng namespace/strictParent như list", async () => {
		const agent = newAgent();
		const cur = await startReal(agent, "ns_job", "ns:B");
		// namespace khác: bị từ chối, job vẫn chạy
		let r = cli(agent, ["cancel", "ns_job"], { CODER_JOB_NAMESPACE: "A" });
		assert.equal(r.code, 1, r.out + r.err);
		assert.match(r.out, /forbidden/);
		assert.equal(core.getJob(agent, "ns_job").status, "running");
		assert.ok(alive(cur.childPid));
		// strictParent:"always" + không có namespace: từ chối; --all thì cho phép
		fs.writeFileSync(path.join(agent, "subagent.json"), JSON.stringify({ strictParent: "always" }));
		r = cli(agent, ["cancel", "ns_job"]);
		assert.equal(r.code, 1);
		assert.equal(core.getJob(agent, "ns_job").status, "running");
		// đúng namespace: hủy được
		r = cli(agent, ["cancel", "ns_job"], { CODER_JOB_NAMESPACE: "B" });
		assert.equal(r.code, 0, r.out + r.err);
		assert.equal(core.getJob(agent, "ns_job").status, "cancelled");
		await sleep(200);
		assert.equal(alive(cur.childPid), false);
	});

	test("CLI cancel --all (vận hành viên) vẫn hủy được job của namespace khác", async () => {
		const agent = newAgent();
		await startReal(agent, "ns_job2", "ns:B");
		const r = cli(agent, ["cancel", "ns_job2", "--all"], { CODER_JOB_NAMESPACE: "A" });
		assert.equal(r.code, 0, r.out + r.err);
		assert.equal(core.getJob(agent, "ns_job2").status, "cancelled");
	});
});

describe("J1: prompt của tiến trình con không bao giờ bắt đầu bằng '/'", () => {
	test("buildInvocation luôn bọc prompt bằng 'Task:'", () => {
		const src = fs.readFileSync(path.join(HERE, "..", "agent", "extensions", "subagent", "index.ts"), "utf8");
		const m = /args\.push\(([^\n]*opts\.prompt[^\n]*)\);/.exec(src);
		assert.ok(m, "không thấy dòng đẩy prompt");
		assert.equal(m[1].trim(), "`Task: ${opts.prompt}`", "prompt phải luôn có tiền tố, không có nhánh điều kiện");
		// mô phỏng: mọi dạng prompt nguy hiểm đều không bắt đầu bằng '/', '-', '@'
		const wrap = (p) => `Task: ${p}`;
		for (const p of ["/revert latest", "/snapshots", "/skill:x", "-p", "@file", "", "  /revert latest"]) assert.ok(!/^[/\-@]/.test(wrap(p)), p);
	});
});
