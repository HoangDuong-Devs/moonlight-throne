// Helper tra cứu biến môi trường MTH_* (fallback CODER_* + cảnh báo một lần) — bản .mjs và bản shell — và detectSandbox.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SH = path.join(here, "..", "lib", "agent-dir.sh");
const ENV_URL = pathToFileURL(path.join(here, "..", "lib", "env.mjs")).href;
const POLICY = pathToFileURL(path.join(here, "..", "agent/extensions/bot-permissions/policy.ts")).href;

// Import kèm query = một module instance mới => bộ nhớ "đã cảnh báo" riêng cho từng ca kiểm thử.
let seq = 0;
const freshEnv = () => import(`${ENV_URL}?case=${++seq}`);

test("mthEnv: MTH_* thắng, không cảnh báo", async () => {
	const { mthEnv } = await freshEnv();
	const w = [];
	assert.equal(mthEnv("MTH_FOO", { MTH_FOO: "a" }, undefined, (m) => w.push(m)), "a");
	assert.deepEqual(w, []);
});
test("mthEnv: CODER_* vẫn dùng được, cảnh báo đúng một lần dù đọc hai lần", async () => {
	const { mthEnv } = await freshEnv();
	const w = [];
	const env = { CODER_FOO: "a" };
	assert.equal(mthEnv("MTH_FOO", env, undefined, (m) => w.push(m)), "a");
	assert.equal(mthEnv("MTH_FOO", env, undefined, (m) => w.push(m)), "a");
	assert.deepEqual(w, ["mth: cảnh báo: CODER_FOO đã lỗi thời, hãy đổi sang MTH_FOO"]);
});
test("mthEnv: đặt cả hai => MTH_* thắng, không cảnh báo", async () => {
	const { mthEnv } = await freshEnv();
	const w = [];
	assert.equal(mthEnv("MTH_FOO", { MTH_FOO: "new", CODER_FOO: "old" }, undefined, (m) => w.push(m)), "new");
	assert.deepEqual(w, []);
});
test("mthEnv: không đặt => mặc định; giá trị rỗng coi như chưa đặt", async () => {
	const { mthEnv } = await freshEnv();
	assert.equal(mthEnv("MTH_FOO", {}, "def", () => assert.fail("không được cảnh báo")), "def");
	assert.equal(mthEnv("MTH_FOO", { MTH_FOO: "" }, "def", () => assert.fail("không được cảnh báo")), "def");
	assert.equal(mthEnv("MTH_FOO", { MTH_FOO: "", CODER_FOO: "old" }, "def", () => {}), "old");
});
test("mthEnv: cảnh báo ra stderr đúng một lần (tiến trình thật)", () => {
	const code = `import { mthEnv } from ${JSON.stringify(ENV_URL)}; process.stdout.write(String(mthEnv("MTH_FOO"))); mthEnv("MTH_FOO");`;
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH, CODER_FOO: "vc" } });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "vc");
	const lines = r.stderr.split("\n").filter((l) => l.includes("CODER_FOO"));
	assert.deepEqual(lines, ["mth: cảnh báo: CODER_FOO đã lỗi thời, hãy đổi sang MTH_FOO"]);
});

const sh = (script, env = {}) =>
	spawnSync("bash", ["-c", `. "$1"; ${script}`, "bash", SH], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const warnLines = (r) => r.stderr.split("\n").filter((l) => l.includes("đã lỗi thời"));
const READ_TWICE = "mth_env A MTH_FOO; mth_env B MTH_FOO; printf '%s\\n' \"$A\" \"$B\"";

test("mth_env (shell): MTH_* thắng, không cảnh báo", () => {
	const r = sh(READ_TWICE, { MTH_FOO: "a", CODER_FOO: "b" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "a\na\n");
	assert.equal(r.stderr, "");
});
test("mth_env (shell): CODER_FOO=1 đọc hai lần => cả hai giá trị '1', cảnh báo đúng một lần", () => {
	const r = sh(READ_TWICE, { CODER_FOO: "1" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "1\n1\n");
	assert.deepEqual(warnLines(r), ["mth: cảnh báo: CODER_FOO đã lỗi thời, hãy đổi sang MTH_FOO"]);
});
test("mth_env (shell): mặc định + giá trị rỗng coi như chưa đặt", () => {
	let r = sh("mth_env A MTH_NOPE fallback; printf '%s\\n' \"$A\"", {});
	assert.equal(r.stdout, "fallback\n");
	assert.equal(r.stderr, "");
	r = sh("mth_env A MTH_FOO fallback; printf '%s\\n' \"$A\"", { MTH_FOO: "", CODER_FOO: "old" });
	assert.equal(r.stdout, "old\n");
	assert.deepEqual(warnLines(r), ["mth: cảnh báo: CODER_FOO đã lỗi thời, hãy đổi sang MTH_FOO"]);
});
test("mth_agent_dir_get (shell): CODER_AGENT_DIR chỉ cảnh báo một lần trong tiến trình", () => {
	const r = sh("mth_agent_dir_get A /d; mth_agent_dir_get B /d; printf '%s\\n' \"$A\" \"$B\"", { CODER_AGENT_DIR: "/a" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "/a\n/a\n");
	assert.deepEqual(warnLines(r), ["mth: cảnh báo: CODER_AGENT_DIR đã lỗi thời, hãy đổi sang MTH_AGENT_DIR"]);
});
test("mth run --bogus: mỗi cảnh báo CODER_* xuất hiện tối đa một lần trên stderr", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mth-envwarn-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "tools/mth");
	fs.mkdirSync(home, { recursive: true });
	fs.copyFileSync(path.join(here, "..", "mth"), path.join(home, "mth"));
	fs.chmodSync(path.join(home, "mth"), 0o755);
	fs.cpSync(path.join(here, "..", "lib"), path.join(home, "lib"), { recursive: true });
	fs.mkdirSync(path.join(home, "agent"));
	const engineDir = path.join(root, "tools/pi/packages/coding-agent/dist/bundle");
	fs.mkdirSync(engineDir, { recursive: true });
	fs.writeFileSync(path.join(engineDir, "cli.js"), "");
	const r = spawnSync(path.join(home, "mth"), ["run", "--bogus"], {
		cwd: root, encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, CODER_ENV_FILE: path.join(root, "no-such.env"), CODER_ALLOW_STDIN: "1" },
	});
	assert.equal(r.status, 64, r.stderr);
	const counts = {};
	for (const m of r.stderr.matchAll(/mth: cảnh báo: (CODER_[A-Z0-9_]+) đã lỗi thời/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
	assert.equal(counts.CODER_ENV_FILE, 1, r.stderr);
	assert.ok((counts.CODER_ALLOW_STDIN ?? 0) <= 1, r.stderr);
	for (const [name, n] of Object.entries(counts)) assert.ok(n <= 1, `${name} cảnh báo ${n} lần: ${r.stderr}`);
	assert.equal(JSON.parse(r.stdout.trim()).error.code, "usage");
});

const { detectSandbox } = await import(POLICY);

test("detectSandbox: cần cả MTH_SANDBOXED/CODER_SANDBOXED = 1 lẫn PID 1 = bwrap", () => {
	assert.equal(detectSandbox({}, () => "bwrap\n"), false);
	assert.equal(detectSandbox({ MTH_SANDBOXED: "1" }, () => "systemd\n"), false);
	assert.equal(detectSandbox({ CODER_SANDBOXED: "1" }, () => "systemd\n"), false);
	assert.equal(detectSandbox({ MTH_SANDBOXED: "1" }, () => { throw new Error("no /proc"); }), false);
	assert.equal(detectSandbox({ MTH_SANDBOXED: "1" }, () => "bwrap\n"), true);
	assert.equal(detectSandbox({ CODER_SANDBOXED: "1" }, () => "bwrap\n"), true);
});
