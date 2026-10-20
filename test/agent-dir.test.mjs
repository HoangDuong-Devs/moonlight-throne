// CODER_AGENT_DIR -> PI_CODING_AGENT_DIR (nội bộ) và tương thích ngược với biến cũ.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentEnv, resolveAgentDir } from "../lib/agent-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SH = path.join(here, "..", "lib", "agent-dir.sh");

test("resolveAgentDir: CODER_AGENT_DIR thắng, không cảnh báo", () => {
	const w = [];
	assert.equal(resolveAgentDir(undefined, { CODER_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/b" }, (m) => w.push(m), "/d"), "/a");
	assert.deepEqual(w, []);
});
test("resolveAgentDir: chỉ có PI_CODING_AGENT_DIR => dùng + cảnh báo deprecated", () => {
	const w = [];
	assert.equal(resolveAgentDir(undefined, { PI_CODING_AGENT_DIR: "/b" }, (m) => w.push(m), "/d"), "/b");
	assert.equal(w.length, 1);
	assert.match(w[0], /PI_CODING_AGENT_DIR.*CODER_AGENT_DIR/);
});
test("resolveAgentDir: không biến nào => mặc định; --agent-dir thắng tất cả", () => {
	assert.equal(resolveAgentDir(undefined, {}, () => assert.fail("không được cảnh báo"), "/d"), "/d");
	assert.equal(resolveAgentDir("/x", { CODER_AGENT_DIR: "/a" }, () => {}, "/d"), "/x");
});
test("agentEnv: đặt cả CODER_AGENT_DIR và biến nội bộ PI_CODING_AGENT_DIR", () => {
	assert.deepEqual(agentEnv("/a"), { CODER_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/a" });
});
const sh = (env) => spawnSync("bash", ["-c", `. "${SH}"; coder_agent_dir /d`], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
test("agent-dir.sh: CODER_AGENT_DIR / legacy + cảnh báo / mặc định", () => {
	let r = sh({ CODER_AGENT_DIR: "/a", PI_CODING_AGENT_DIR: "/b" });
	assert.equal(r.stdout.trim(), "/a"); assert.equal(r.stderr, "");
	r = sh({ PI_CODING_AGENT_DIR: "/b" });
	assert.equal(r.stdout.trim(), "/b"); assert.match(r.stderr, /lỗi thời.*CODER_AGENT_DIR/);
	r = sh({});
	assert.equal(r.stdout.trim(), "/d"); assert.equal(r.stderr, "");
});
test("subagent-cli: chỉ đặt PI_CODING_AGENT_DIR vẫn chạy, kèm cảnh báo", async () => {
	const os = await import("node:os"); const fs = await import("node:fs");
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "agentdir-"));
	try {
		const r = spawnSync(process.execPath, [path.join(here, "..", "lib", "subagent-cli.mjs"), "list", "--all", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent } });
		assert.match(r.stderr, /PI_CODING_AGENT_DIR.*CODER_AGENT_DIR/);
		const r2 = spawnSync(process.execPath, [path.join(here, "..", "lib", "subagent-cli.mjs"), "list", "--all", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, CODER_AGENT_DIR: agent } });
		assert.equal(r2.status, r.status);
		assert.doesNotMatch(r2.stderr, /lỗi thời|PI_CODING_AGENT_DIR/);
	} finally { fs.rmSync(agent, { recursive: true, force: true }); }
});
