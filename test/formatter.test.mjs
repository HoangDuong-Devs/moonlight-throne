// Test hồi quy formatter (node --test --experimental-strip-types test/)
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const withFileMutationQueue=(p,f)=>f(); export const getAgentDir=()=>process.env.PI_CODING_AGENT_DIR;"), shortCircuit: true };
  return n(s, c);
}`),
	import.meta.url,
);
const mod = await import(pathToFileURL(new URL("../agent/extensions/formatter/index.ts", import.meta.url).pathname).href);

const mk = () => mkdtemp(join(tmpdir(), "fmt-test-"));
/** script giả: ghi argv + env vào <dir>/<tag>.log rồi in "X" vào file được format (đổi nội dung) */
async function fake(dir, name, log) {
	await mkdir(dir, { recursive: true });
	const p = join(dir, name);
	await writeFile(p, `#!/bin/sh\n{ echo "ARGS:$*"; echo "HOME:$HOME"; echo "CWD:$PWD"; env; } > "${log}"\nfor a; do :; done\necho formatted >> "$a"\n`);
	await chmod(p, 0o755);
	return p;
}
const withPath = async (path, fn) => {
	const old = process.env.PATH;
	process.env.PATH = path;
	try {
		return await fn();
	} finally {
		process.env.PATH = old;
	}
};
const SYS = "/usr/bin:/bin";

test("F1: node_modules/.bin của repo (kể cả thư mục cha) KHÔNG được chạy mặc định", async () => {
	const parent = await mk();
	const cwd = join(parent, "work");
	await mkdir(cwd);
	const marker1 = join(parent, "m1.log");
	const marker2 = join(parent, "m2.log");
	await fake(join(cwd, "node_modules/.bin"), "gofmt", marker1);
	await fake(join(parent, "node_modules/.bin"), "gofmt", marker2); // thư mục cha
	await writeFile(join(cwd, "a.go"), "package x\n");
	await withPath("/nonexistent-dir", async () => {
		const note = await mod.formatFile(join(cwd, "a.go"), cwd, {});
		assert.equal(note, "");
	});
	assert.equal(existsSync(marker1), false);
	assert.equal(existsSync(marker2), false);
	await rm(parent, { recursive: true });
});

test("F1: mục PATH trong workdir / tương đối / '.' / rỗng bị loại; thư mục ai cũng ghi được bị loại", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	const inner = join(cwd, "bin");
	const log = join(root, "inner.log");
	await fake(inner, "gofmt", log);
	await writeFile(join(cwd, "a.go"), "package x\n");
	const ww = join(root, "ww");
	await mkdir(ww);
	await chmod(ww, 0o777);
	await fake(ww, "gofmt", join(root, "ww.log"));
	await withPath([inner, "bin", ".", "", ww].join(":"), async () => {
		assert.deepEqual(mod.trustedPathDirs(cwd), []);
		assert.equal(await mod.formatFile(join(cwd, "a.go"), cwd, {}), "");
	});
	assert.equal(existsSync(log), false);
	assert.equal(existsSync(join(root, "ww.log")), false);
	await rm(root, { recursive: true });
});

test("F1: symlink trong PATH tin cậy trỏ vào repo bị bỏ qua", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	const trusted = join(root, "trusted");
	await mkdir(trusted);
	const evil = await fake(join(cwd, "evil"), "x", join(root, "evil.log"));
	await symlink(evil, join(trusted, "gofmt"));
	await writeFile(join(cwd, "a.go"), "package x\n");
	await withPath(trusted, async () => assert.equal(await mod.formatFile(join(cwd, "a.go"), cwd, {}), ""));
	assert.equal(existsSync(join(root, "evil.log")), false);
	await rm(root, { recursive: true });
});

test("F1: PATH tin cậy chạy được, với môi trường đã lọc (không secret, HOME tạm)", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	await mkdir(cwd);
	const trusted = join(root, "trusted");
	const log = join(root, "t.log");
	await fake(trusted, "gofmt", log);
	await writeFile(join(cwd, "a.go"), "package x\n");
	process.env.OPENAI_API_KEY = "sk-SECRET-123";
	process.env.MY_TOKEN = "tok-456";
	try {
		await withPath(trusted + ":" + SYS, async () => {
			const note = await mod.formatFile(join(cwd, "a.go"), cwd, {});
			assert.match(note, /formatter gofmt reformatted/);
		});
	} finally {
		delete process.env.OPENAI_API_KEY;
		delete process.env.MY_TOKEN;
	}
	const out = await readFile(log, "utf8");
	assert.doesNotMatch(out, /SECRET|tok-456|OPENAI|MY_TOKEN/);
	assert.match(out, /HOME:\/.*fmt-home-/);
	assert.match(out, new RegExp(`ARGS:-w ${join(cwd, "a.go")}`));
	assert.equal(existsSync(out.match(/HOME:(.*)/)[1]), false, "HOME tạm đã được dọn");
	await rm(root, { recursive: true });
});

test("F1: trustRepoBinaries:true bật lại node_modules/.bin (vẫn môi trường lọc)", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	const log = join(root, "r.log");
	await fake(join(cwd, "node_modules/.bin"), "gofmt", log);
	await writeFile(join(cwd, "a.go"), "package x\n");
	process.env.MY_TOKEN = "tok-456";
	try {
		await withPath("/nonexistent", async () => {
			assert.match(await mod.formatFile(join(cwd, "a.go"), cwd, { trustRepoBinaries: true }), /reformatted/);
		});
	} finally {
		delete process.env.MY_TOKEN;
	}
	assert.doesNotMatch(await readFile(log, "utf8"), /tok-456/);
	await rm(root, { recursive: true });
});

test("F1: prettier/rubocop/mix tắt mặc định, bật bằng trustRepoConfig", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	await mkdir(cwd);
	const trusted = join(root, "trusted");
	for (const b of ["prettier", "rubocop", "mix"]) await fake(trusted, b, join(root, b + ".log"));
	await writeFile(join(cwd, "package.json"), JSON.stringify({ devDependencies: { prettier: "3" } }));
	await writeFile(join(cwd, "a.js"), "x=1\n");
	await writeFile(join(cwd, "a.rb"), "x=1\n");
	await writeFile(join(cwd, "a.ex"), "x=1\n");
	await withPath(trusted, async () => {
		for (const f of ["a.js", "a.rb", "a.ex"]) assert.equal(await mod.formatFile(join(cwd, f), cwd, {}), "", f);
		for (const b of ["prettier", "rubocop", "mix"]) assert.equal(existsSync(join(root, b + ".log")), false);
		for (const f of ["a.js", "a.rb", "a.ex"]) assert.match(await mod.formatFile(join(cwd, f), cwd, { trustRepoConfig: true }), /reformatted/, f);
	});
	await rm(root, { recursive: true });
});

test("F1: tên file bắt đầu bằng '-' không thành cờ", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	await mkdir(cwd);
	const trusted = join(root, "trusted");
	const log = join(root, "d.log");
	await fake(trusted, "gofmt", log);
	await writeFile(join(cwd, "-x.go"), "package x\n");
	await withPath(trusted, async () => {
		await mod.formatFile(join(cwd, "-x.go"), cwd, {});
	});
	const args = (await readFile(log, "utf8")).match(/ARGS:(.*)/)[1];
	assert.equal(args, `-w ${join(cwd, "-x.go")}`);
	assert.ok(args.split(" ")[1].startsWith("/"));
	await rm(root, { recursive: true });
});

test("F1: formatter tuỳ chỉnh: đường dẫn tuyệt đối chạy; tương đối trong repo bị từ chối nếu không trustRepoBinaries", async () => {
	const root = await mk();
	const cwd = join(root, "work");
	await mkdir(cwd);
	const abs = await fake(join(root, "opt"), "mine", join(root, "abs.log"));
	await fake(join(cwd, "tools"), "mine", join(root, "rel.log"));
	await writeFile(join(cwd, "a.foo"), "x\n");
	const cfgAbs = { formatters: { mine: { command: [abs, "$FILE"], extensions: [".foo"] } } };
	const cfgRel = { formatters: { mine: { command: ["./tools/mine", "$FILE"], extensions: [".foo"] } } };
	assert.match(await mod.formatFile(join(cwd, "a.foo"), cwd, cfgAbs), /reformatted/);
	assert.equal(await mod.formatFile(join(cwd, "a.foo"), cwd, cfgRel), "");
	assert.equal(existsSync(join(root, "rel.log")), false);
	assert.match(await mod.formatFile(join(cwd, "a.foo"), cwd, { ...cfgRel, trustRepoBinaries: true }), /reformatted/);
	await rm(root, { recursive: true });
});

test("F1: buildEnv chỉ có khóa trong danh sách cho phép", () => {
	const env = mod.buildEnv(["/usr/bin"], "/tmp/h", { passEnv: ["EXTRA"] }, { PATH: "/evil", HOME: "/home/u", LANG: "vi_VN.UTF-8", AWS_SECRET: "s", EXTRA: "e" });
	assert.deepEqual(Object.keys(env).sort(), ["CARGO_HOME", "EXTRA", "HOME", "LANG", "PATH", "RUSTUP_HOME", "TMPDIR"]);
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/tmp/h");
	assert.equal(env.LANG, "vi_VN.UTF-8");
});
