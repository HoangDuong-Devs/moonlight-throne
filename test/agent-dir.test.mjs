// MTH_AGENT_DIR (mới) > CODER_AGENT_DIR (lỗi thời, cảnh báo) > PI_CODING_AGENT_DIR (lỗi thời, cảnh báo) > mặc định.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentEnv, resolveAgentDir } from "../lib/agent-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SH = path.join(here, "..", "lib", "agent-dir.sh");

test("resolveAgentDir: MTH_AGENT_DIR thắng, không cảnh báo", () => {
	const w = [];
	assert.equal(resolveAgentDir(undefined, { MTH_AGENT_DIR: "/a", CODER_AGENT_DIR: "/b", PI_CODING_AGENT_DIR: "/c" }, (m) => w.push(m), "/d"), "/a");
	assert.deepEqual(w, []);
});
test("resolveAgentDir: CODER_AGENT_DIR (lỗi thời) vẫn dùng được, cảnh báo đúng một lần", () => {
	const w = [];
	const env = { CODER_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/b" };
	assert.equal(resolveAgentDir(undefined, env, (m) => w.push(m), "/d"), "/a");
	assert.equal(resolveAgentDir(undefined, env, (m) => w.push(m), "/d"), "/a");
	assert.equal(w.length, 1);
	assert.match(w[0], /CODER_AGENT_DIR.*MTH_AGENT_DIR/);
});
test("resolveAgentDir: chỉ có PI_CODING_AGENT_DIR => dùng + cảnh báo deprecated", () => {
	const w = [];
	assert.equal(resolveAgentDir(undefined, { PI_CODING_AGENT_DIR: "/b" }, (m) => w.push(m), "/d"), "/b");
	assert.equal(w.length, 1);
	assert.match(w[0], /PI_CODING_AGENT_DIR.*MTH_AGENT_DIR/);
});
test("resolveAgentDir: không biến nào => mặc định; --agent-dir thắng tất cả", () => {
	assert.equal(resolveAgentDir(undefined, {}, () => assert.fail("không được cảnh báo"), "/d"), "/d");
	assert.equal(resolveAgentDir("/x", { MTH_AGENT_DIR: "/a" }, () => assert.fail("không được cảnh báo"), "/d"), "/x");
});
test("agentEnv: đặt cả MTH_AGENT_DIR, CODER_AGENT_DIR và biến nội bộ PI_CODING_AGENT_DIR", () => {
	assert.deepEqual(agentEnv("/a"), { MTH_AGENT_DIR: "/a", CODER_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/a" });
});
const sh = (env) => spawnSync("bash", ["-c", `. "${SH}"; mth_agent_dir /d`], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
test("agent-dir.sh: MTH_AGENT_DIR > CODER_AGENT_DIR (cảnh báo) > PI (cảnh báo) > mặc định", () => {
	let r = sh({ MTH_AGENT_DIR: "/a", CODER_AGENT_DIR: "/b", PI_CODING_AGENT_DIR: "/c" });
	assert.equal(r.stdout.trim(), "/a"); assert.equal(r.stderr, "");
	r = sh({ CODER_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/b" });
	assert.equal(r.stdout.trim(), "/a"); assert.match(r.stderr, /CODER_AGENT_DIR.*lỗi thời.*MTH_AGENT_DIR/);
	r = sh({ PI_CODING_AGENT_DIR: "/b" });
	assert.equal(r.stdout.trim(), "/b"); assert.match(r.stderr, /PI_CODING_AGENT_DIR.*lỗi thời.*MTH_AGENT_DIR/);
	r = sh({});
	assert.equal(r.stdout.trim(), "/d"); assert.equal(r.stderr, "");
});
test("subagent-cli: MTH_AGENT_DIR không cảnh báo; CODER_AGENT_DIR vẫn chạy, kèm cảnh báo", async () => {
	const os = await import("node:os"); const fs = await import("node:fs");
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "agentdir-"));
	const cli = (env) => spawnSync(process.execPath, [path.join(here, "..", "lib", "subagent-cli.mjs"), "list", "--all", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
	try {
		const r = cli({ MTH_AGENT_DIR: agent });
		assert.equal(r.status, 0, r.stderr);
		assert.doesNotMatch(r.stderr, /lỗi thời/);
		const r2 = cli({ CODER_AGENT_DIR: agent });
		assert.equal(r2.status, r.status);
		assert.match(r2.stderr, /CODER_AGENT_DIR.*MTH_AGENT_DIR/);
		const r3 = cli({ PI_CODING_AGENT_DIR: agent });
		assert.equal(r3.status, r.status);
		assert.match(r3.stderr, /PI_CODING_AGENT_DIR.*MTH_AGENT_DIR/);
	} finally { fs.rmSync(agent, { recursive: true, force: true }); }
});
