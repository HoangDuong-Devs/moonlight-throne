// Test: giá trị env (key model, CODER_PASS_ENV) KHÔNG được xuất hiện trên argv => không lộ qua `ps` / /proc/<pid>/cmdline.
// Chạy: node --test --experimental-strip-types test/sandbox-env-argv.test.mjs
// Không in giá trị giả trong bất kỳ thông báo assert nào.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODER = path.resolve(new URL("..", import.meta.url).pathname);
const HAS_BWRAP = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "true"]).status === 0;
// bwrap chỉ nhận option từ --args; lệnh phải nằm trên argv thật.
const HAS_ARGS = HAS_BWRAP && spawnSync("bash", ["-c", "exec 3< <(printf '%s\\0' --clearenv --setenv BWRAP_ARGS_PROBE 1); bwrap --ro-bind / / --dev /dev --proc /proc --args 3 /bin/sh -c 'test -n \"$BWRAP_ARGS_PROBE\"'"], { stdio: "ignore" }).status === 0;
const SKIP = process.env.CODER_SANDBOXED === "1" ? "đang ở trong sandbox (CODER_SANDBOXED=1)" : !HAS_BWRAP ? "không có bwrap" : !HAS_ARGS ? "bwrap không hỗ trợ --args" : false;

const cleanups = [];
test.after(() => {
	for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

/** Quét cmdline của MỌI tiến trình + `ps -eo args`. Không quét /proc/<pid>/environ (cùng user luôn đọc được — xem docs). */
function scan(values) {
	const hits = [];
	const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
	for (const ent of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(ent)) continue;
		let raw = "";
		try { raw = fs.readFileSync(`/proc/${ent}/cmdline`, "utf8"); } catch { continue; }
		const cmd = raw.replace(/\0/g, " ");
		values.forEach((v, i) => { if (cmd.includes(v)) hits.push({ pid: ent, which: i }); });
	}
	const psText = ps.status === 0 ? ps.stdout : "";
	const psHits = values.map((v) => psText.includes(v));
	return { hits, psOk: ps.status === 0, psHits };
}

const describeHits = (r) => `pid: ${r.hits.map((h) => h.pid).join(",") || "không có"} (giá trị #${[...new Set(r.hits.map((h) => h.which))].join(",") || "-"})`;

/** Chờ tới khi `pred()` đúng (tối đa `ms`), trả về kết quả cuối cùng của `pred`. */
async function waitFor(pred, ms) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return pred();
}

/** Chờ tiến trình thoát (tối đa `ms`), trả về exit code hoặc "timeout". */
function waitExit(p, ms) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve("timeout"), ms);
		p.then((code) => { clearTimeout(t); resolve(code); });
	});
}

test("S15: mth-sandbox KHÔNG đặt giá trị env (key + CODER_PASS_ENV) lên argv; env vẫn được truyền vào trong", { skip: SKIP }, async () => {
	const key = `fake-LEAKCHECK-${crypto.randomBytes(12).toString("hex")}`;
	const passName = "CODER_FAKE_PASS_TOKEN";
	const passVal = `fake-LEAKCHECK-PASS-${crypto.randomBytes(12).toString("hex")}`;
	const values = [key, passVal];
	const redact = (s) => values.reduce((t, v) => t.split(v).join("[redacted]"), String(s));

	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-argv-")));
	cleanups.push(root);
	const here = path.join(root, "tools/mth");
	fs.mkdirSync(path.join(root, "tools/pi"), { recursive: true });
	fs.mkdirSync(path.join(here, "lib"), { recursive: true });
	fs.copyFileSync(path.join(CODER, "lib/agent-dir.sh"), path.join(here, "lib/agent-dir.sh"));
	fs.copyFileSync(path.join(CODER, "mth-sandbox"), path.join(here, "mth-sandbox"));
	fs.chmodSync(path.join(here, "mth-sandbox"), 0o755);
	const agent = path.join(root, "agent");
	fs.mkdirSync(agent);
	const work = path.join(root, "work");
	fs.mkdirSync(work);
	// Giá trị kỳ vọng nằm trong file của workdir: script bên trong không phải mang giá trị trên argv.
	fs.writeFileSync(path.join(work, "expect-key.txt"), `${key}\n`);
	fs.writeFileSync(path.join(work, "expect-pass.txt"), `${passVal}\n`);

	// Bộ quét phải thật sự phát hiện được giá trị khi nó NẰM trên argv (chứng minh test không "pass oan").
	const canary = spawn("sh", ["-c", "sleep 3", key], { stdio: "ignore" });
	try {
		const seen = await waitFor(() => scan(values).hits.some((h) => h.which === 0), 5000);
		assert.ok(seen, "bộ quét không thấy giá trị thử nghiệm trên cmdline");
	} finally {
		canary.kill("SIGKILL");
	}

	const script = [
		`[ "$COMMANDCODE_API_KEY" = "$(cat ${work}/expect-key.txt)" ] && echo KEY=inside-match || echo KEY=inside-no-match`,
		`[ "$${passName}" = "$(cat ${work}/expect-pass.txt)" ] && echo PASS=inside-match || echo PASS=inside-no-match`,
		// --clearenv vẫn hiệu lực: biến của shell gọi mà không nằm trong danh sách truyền phải biến mất
		`[ -z "${'$'}{HOST_ONLY_CANARY:-}" ] && echo HOSTVAR=unset || echo HOSTVAR=set`,
		// fd 3 (nguồn --args) không được để lại dữ liệu đọc được cho tiến trình trong sandbox
		"if [ -n \"$(cat <&3 2>/dev/null)\" ]; then echo FD3=has-data; else echo FD3=no-data; fi",
		"sleep 2",
	].join("; ");
	const env = {
		PATH: process.env.PATH, HOME: process.env.HOME, CODER_AGENT_DIR: agent, CODER_WORKDIR: work,
		CODER_ENV_FILE: path.join(root, "none.env"), CODER_SANDBOX_NET: "off",
		COMMANDCODE_API_KEY: key, [passName]: passVal, CODER_PASS_ENV: passName, HOST_ONLY_CANARY: "host-only-value",
	};
	const child = spawn(path.join(here, "mth-sandbox"), ["exec", "--", "sh", "-c", script], { env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => { out += d; });
	child.stderr.on("data", (d) => { out += d; });
	const exited = new Promise((r) => child.on("exit", (c) => r(c)));
	try {
		const deadline = Date.now() + 20000;
		while (!(/^KEY=/m.test(out) && /^PASS=/m.test(out))) {
			assert.ok(Date.now() < deadline && child.exitCode === null, `sandbox thoát sớm: ${redact(out)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
		// Sandbox đang chạy `sleep 2`: quét argv/cmdline của mọi tiến trình.
		const r = scan(values);
		assert.equal(r.hits.length, 0, `giá trị env lọt vào /proc/<pid>/cmdline — ${describeHits(r)}`);
		assert.ok(!r.psHits[0], "giá trị key lọt vào output của `ps -eo args`");
		assert.ok(!r.psHits[1], "giá trị CODER_PASS_ENV lọt vào output của `ps -eo args`");
		assert.ok(r.psOk, "không chạy được `ps -eo args` để kiểm tra");
		const code = await waitExit(exited, 20000);
		assert.equal(code, 0, redact(out));
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	assert.match(out, /^KEY=inside-match$/m, redact(out));
	assert.match(out, /^PASS=inside-match$/m, redact(out));
	assert.match(out, /^FD3=no-data$/m, redact(out));
	assert.match(out, /^HOSTVAR=unset$/m, redact(out));
});
