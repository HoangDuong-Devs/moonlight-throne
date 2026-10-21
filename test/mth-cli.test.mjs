// Test CLI mth: cú pháp bash hợp lệ, lỗi tham số là MỘT đối tượng JSON, shim `coder` chuyển tiếp.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bố cục tạm: <tmp>/tools/mth/{mth,coder,mth-sandbox,coder-sandbox,lib} + lõi agent rỗng + agent-dir riêng. */
function layout(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mth-cli-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "tools/mth");
	fs.mkdirSync(home, { recursive: true });
	for (const f of ["mth", "coder", "mth-sandbox", "coder-sandbox"]) {
		fs.copyFileSync(path.join(repo, f), path.join(home, f));
		fs.chmodSync(path.join(home, f), 0o755);
	}
	fs.cpSync(path.join(repo, "lib"), path.join(home, "lib"), { recursive: true });
	const engineDir = path.join(root, "tools/pi/packages/coding-agent/dist/bundle");
	fs.mkdirSync(engineDir, { recursive: true });
	fs.writeFileSync(path.join(engineDir, "cli.js"), "");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const env = { ...process.env, MTH_ENV_FILE: path.join(root, "no-such.env"), MTH_AGENT_DIR: agentDir };
	return { root, home, env };
}

const run = (h, script, args = []) =>
	spawnSync(path.join(h.home, script), args, { cwd: h.root, encoding: "utf8", env: h.env });

test("mth: cú pháp bash hợp lệ", (t) => {
	const h = layout(t);
	const r = spawnSync("bash", ["-n", path.join(h.home, "mth")], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
});

test("mth run --bogus: stdout là đúng một JSON với error.code = usage", (t) => {
	const h = layout(t);
	const r = run(h, "mth", ["run", "--bogus"]);
	assert.equal(r.status, 64, r.stderr);
	const lines = r.stdout.trim().split("\n");
	assert.equal(lines.length, 1, r.stdout);
	const obj = JSON.parse(lines[0]);
	assert.equal(obj.status, "error");
	assert.equal(obj.error.code, "usage");
	assert.equal(obj.ok, false);
});

test("shim coder: cảnh báo lỗi thời rồi chuyển tiếp nguyên tham số sang mth", (t) => {
	const h = layout(t);
	const direct = JSON.parse(run(h, "mth", ["run", "--bogus"]).stdout);
	const shim = run(h, "coder", ["run", "--bogus"]);
	assert.equal(shim.status, 64, shim.stderr);
	assert.match(shim.stderr, /coder: cảnh báo: lệnh 'coder' đã lỗi thời, hãy dùng 'mth'/);
	const lines = shim.stdout.trim().split("\n");
	assert.equal(lines.length, 1, shim.stdout);
	const forward = JSON.parse(lines[0]);
	assert.equal(forward.error.code, "usage");
	assert.deepEqual({ ...forward, duration_ms: 0 }, { ...direct, duration_ms: 0 });
});

test("shim coder-sandbox: cảnh báo lỗi thời rồi chuyển tiếp sang mth-sandbox", (t) => {
	const h = layout(t);
	// `run` được mth-sandbox chuyển thẳng cho run-cli (lỗi tham số) nên không cần bwrap.
	const direct = run(h, "mth-sandbox", ["run", "--bogus"]);
	const shim = run(h, "coder-sandbox", ["run", "--bogus"]);
	assert.equal(shim.status, direct.status, shim.stderr + direct.stderr);
	assert.equal(shim.status, 64, shim.stderr);
	assert.match(shim.stderr, /coder-sandbox: cảnh báo: lệnh 'coder-sandbox' đã lỗi thời, hãy dùng 'mth-sandbox'/);
	const lines = shim.stdout.trim().split("\n");
	assert.equal(lines.length, 1, shim.stdout);
	const forward = JSON.parse(lines[0]);
	const expected = JSON.parse(direct.stdout);
	assert.equal(forward.error.code, "usage");
	assert.deepEqual({ ...forward, duration_ms: 0 }, { ...expected, duration_ms: 0 });
});

test("agent-dir.sh: bí danh coder_agent_dir vẫn hoạt động như mth_agent_dir", (t) => {
	const h = layout(t);
	const sh = path.join(h.home, "lib/agent-dir.sh");
	const agent = path.join(h.root, "agent-alias");
	const r = spawnSync("bash", ["-c", `. "$1"; mth_agent_dir /d; coder_agent_dir /d`, "bash", sh], { encoding: "utf8", env: { ...h.env, MTH_AGENT_DIR: agent } });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stderr, "");
	assert.deepEqual(r.stdout.trim().split("\n"), [agent, agent]);
});
