// Test hồi quy bảo mật cho lib/snapshot-cli.mjs (S1-S4). Chạy: node --test --experimental-strip-types test/
// Mọi thứ nằm trong thư mục tạm; "lệnh độc" chỉ `touch` một file đánh dấu.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { diffSnapshots, isExcludedPath, listSnapshots, openContext, revertTo, takeSnapshot } from "../lib/snapshot-cli.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "snapshot-cli.mjs");
const base = fs.existsSync("/tmp/claude-1002") ? "/tmp/claude-1002" : os.tmpdir();
const root = fs.mkdtempSync(path.join(base, "snaptest-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function fixture() {
	const dir = path.join(root, `t${++n}`);
	const work = path.join(dir, "work");
	const agent = path.join(dir, "agent");
	fs.mkdirSync(work, { recursive: true });
	fs.mkdirSync(agent, { recursive: true });
	const ctx = () => openContext({ cwd: work, agentDir: agent, indexName: "cli" });
	const cli = (args, env = {}, dir = work) => {
		const r = spawnSync(process.execPath, [CLI, ...args, "--agent-dir", agent, "--dir", dir, "--json"], { encoding: "utf8", env: { ...process.env, ...env } });
		let json;
		try {
			json = JSON.parse(r.stdout);
		} catch {}
		return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
	};
	const w = (rel, body = "x\n") => {
		fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
		fs.writeFileSync(path.join(work, rel), body);
	};
	const ex = (rel) => fs.existsSync(path.join(work, rel));
	return { dir, work, agent, ctx, cli, w, ex, marker: (name) => path.join(dir, `marker-${name}`) };
}

/** Các commit tree của snapshot -> danh sách file trong cây. */
function treeFiles(f, snapId) {
	const c = f.ctx();
	const r = spawnSync("git", ["--git-dir", c.gitDir, "ls-tree", "-r", "--name-only", snapId], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	return r.stdout.split("\n").filter(Boolean);
}

describe("S1: kho bóng không tin cậy", () => {
	function poison(f) {
		const gitDir = f.ctx().gitDir;
		fs.appendFileSync(
			path.join(gitDir, "config"),
			[
				'[filter "x"]',
				`\tclean = touch ${f.marker("clean")}; cat`,
				`\tsmudge = touch ${f.marker("smudge")}; cat`,
				`\tprocess = touch ${f.marker("process")}`,
				'[diff "x"]',
				`\ttextconv = touch ${f.marker("textconv")}; cat`,
				"[core]",
				`\tfsmonitor = touch ${f.marker("fsm")}; false`,
				`\tsshCommand = touch ${f.marker("ssh")}`,
				`\tpager = touch ${f.marker("pager")}`,
				`\teditor = touch ${f.marker("editor")}`,
				"[diff]",
				`\texternal = touch ${f.marker("extdiff")}`,
				"[alias]",
				`\tfoo = !touch ${f.marker("alias")}`,
				"[include]",
				`\tpath = ${path.join(f.dir, "evil.cfg")}`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(path.join(f.dir, "evil.cfg"), `[core]\n\tfsmonitor = touch ${f.marker("include")}; false\n`);
		fs.writeFileSync(path.join(f.work, ".gitattributes"), "* filter=x diff=x\n");
		fs.mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
		for (const h of ["pre-commit", "reference-transaction", "post-index-change", "post-checkout"]) {
			fs.writeFileSync(path.join(gitDir, "hooks", h), `#!/bin/sh\ntouch ${f.marker("hook-" + h)}\n`, { mode: 0o755 });
		}
		fs.mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
		fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), "/nonexistent\n");
		fs.writeFileSync(path.join(gitDir, "info", "attributes"), "* filter=x\n");
		fs.writeFileSync(path.join(gitDir, "shallow"), "0000000000000000000000000000000000000000\n");
		fs.writeFileSync(path.join(gitDir, "commondir"), "/etc\n");
	}
	const noMarkers = (f) => {
		const found = fs.readdirSync(f.dir).filter((x) => x.startsWith("marker-"));
		assert.deepEqual(found, [], `lệnh độc đã chạy: ${found}`);
	};

	test("list/diff/take/revert phía host không chạy filter/textconv/fsmonitor/hook/include", async () => {
		const f = fixture();
		f.w("a.txt", "one\n");
		assert.equal(f.cli(["take"]).code, 0);
		poison(f);
		f.w("a.txt", "two\n");
		f.w("b.txt", "new\n");
		assert.equal(f.cli(["list"]).code, 0);
		const d = f.cli(["diff", "latest", "--patch"]);
		assert.equal(d.code, 0, d.stdout + d.stderr);
		assert.equal(f.cli(["take"]).code, 0);
		poison(f);
		const r = f.cli(["revert", "first"]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(fs.readFileSync(path.join(f.work, "a.txt"), "utf8"), "one\n");
		noMarkers(f);
		const cfg = fs.readFileSync(path.join(f.ctx().gitDir, "config"), "utf8");
		assert.doesNotMatch(cfg, /filter|textconv|touch|include/);
		assert.equal(fs.existsSync(path.join(f.ctx().gitDir, "commondir")), false);
		assert.equal(fs.existsSync(path.join(f.ctx().gitDir, "objects", "info", "alternates")), false);
	});

	test("thư viện: listSnapshots/diffSnapshots/revertTo cũng dựng lại kho", async () => {
		const f = fixture();
		f.w("a.txt", "one\n");
		await takeSnapshot(f.ctx(), { force: true });
		poison(f);
		f.w("a.txt", "two\n");
		const rows = await listSnapshots(f.ctx());
		assert.equal(rows.length, 1);
		await diffSnapshots(f.ctx(), "latest", undefined, { patch: true });
		await revertTo(f.ctx(), "latest");
		noMarkers(f);
	});

	test("môi trường GIT_* của người gọi bị bỏ qua", () => {
		const f = fixture();
		f.w("a.txt");
		const env = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.fsmonitor",
			GIT_CONFIG_VALUE_0: `touch ${f.marker("env")}; false`,
			GIT_EXTERNAL_DIFF: `touch ${f.marker("envdiff")}`,
			GIT_SSH_COMMAND: `touch ${f.marker("envssh")}`,
			GIT_PAGER: `touch ${f.marker("envpager")}`,
			GIT_EDITOR: `touch ${f.marker("enveditor")}`,
			GIT_CONFIG_PARAMETERS: `'core.fsmonitor=touch ${f.marker("envparam")}; false'`,
		};
		assert.equal(f.cli(["take"], env).code, 0);
		f.w("a.txt", "y\n");
		assert.equal(f.cli(["diff", "latest", "--patch"], env).code, 0);
		assert.equal(f.cli(["revert", "latest"], env).code, 0);
		noMarkers(f);
	});

	test("symlink trong kho => từ chối, không chạy git", () => {
		const f = fixture();
		f.w("a.txt");
		assert.equal(f.cli(["take"]).code, 0);
		const gitDir = f.ctx().gitDir;
		fs.mkdirSync(path.join(f.dir, "elsewhere"));
		fs.symlinkSync(path.join(f.dir, "elsewhere"), path.join(gitDir, "refs", "evil"));
		for (const cmd of [["list"], ["diff", "latest"], ["take"], ["revert", "latest", "--dry-run"]]) {
			const r = f.cli(cmd);
			assert.equal(r.code, 1, cmd.join(" "));
			assert.match(r.json.error, /symlink/);
		}
	});

	test("tệp lạ ở mức gốc kho => từ chối; gitDir là symlink => từ chối", () => {
		const f = fixture();
		f.w("a.txt");
		assert.equal(f.cli(["take"]).code, 0);
		const gitDir = f.ctx().gitDir;
		fs.writeFileSync(path.join(gitDir, "payload.sh"), "x");
		let r = f.cli(["list"]);
		assert.equal(r.code, 1);
		assert.match(r.json.error, /tệp lạ/);
		fs.rmSync(path.join(gitDir, "payload.sh"));
		assert.equal(f.cli(["list"]).code, 0);
		// thay cả thư mục kho bằng symlink
		const moved = path.join(f.dir, "moved");
		fs.renameSync(gitDir, moved);
		fs.symlinkSync(moved, gitDir);
		r = f.cli(["list"]);
		assert.equal(r.code, 1);
		assert.match(r.json.error, /không phải thư mục thật/);
	});

	test("kho có sẵn trước (kẻ tấn công tạo thư mục + config) vẫn an toàn khi khởi tạo", () => {
		const f = fixture();
		f.w("a.txt");
		const gitDir = f.ctx().gitDir;
		fs.mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(gitDir, "hooks", "reference-transaction"), `#!/bin/sh\ntouch ${f.marker("preinit")}\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(gitDir, "config"), `[core]\n\tfsmonitor = touch ${f.marker("preinit-fsm")}; false\n`);
		assert.equal(f.cli(["take"]).code, 0);
		noMarkers(f);
	});
});

describe("S2: bộ lọc secret cứng trong code", () => {
	test("isExcludedPath", () => {
		for (const p of [".env", "a/.env.local", ".ENV", "id_rsa", "x/id_ed25519.pub", "k.pem", "dir/a.KEY", ".npmrc", "auth.json", "credentials.json", "cfg/credentials", ".ssh/config", "a/.aws/credentials", ".gnupg/x", "node_modules/x/y.js", "a/.git/config", ".git", ".pi/x"]) {
			assert.equal(isExcludedPath(p), true, p);
		}
		for (const p of [".env.example", "src/index.js", "README.md", "environment.ts", "keys.txt", "a/b/c.txt"]) assert.equal(isExcludedPath(p), false, p);
	});

	test(".gitignore negate và .git/info/exclude không mở lại file secret", async () => {
		const f = fixture();
		f.w(".gitignore", ["!.env", "!id_rsa", "!*.pem", "!auth.json", "!.ssh/", "!node_modules/", "!*.key", "!credentials*", ""].join("\n"));
		fs.mkdirSync(path.join(f.work, ".git", "info"), { recursive: true });
		fs.writeFileSync(path.join(f.work, ".git", "info", "exclude"), "!.env\n!.npmrc\n");
		fs.writeFileSync(path.join(f.work, ".git", "config"), "[core]\n");
		const secrets = [".env", "sub/.env", "id_rsa", "cert.pem", "auth.json", ".ssh/id", "node_modules/p/i.js", "a.key", "credentials.json", ".npmrc"];
		for (const s of secrets) f.w(s, "SECRET\n");
		f.w("ok.txt", "fine\n");
		f.w(".env.example", "K=\n");
		const r = await takeSnapshot(f.ctx(), { force: true });
		const files = treeFiles(f, r.id);
		for (const s of secrets) assert.ok(!files.includes(s), `${s} bị chụp`);
		assert.ok(files.includes("ok.txt") && files.includes(".env.example") && files.includes(".gitignore"));
		// revert không khôi phục/xóa secret
		fs.rmSync(path.join(f.work, "ok.txt"));
		fs.rmSync(path.join(f.work, ".env"));
		f.w("sub/.env", "CHANGED\n");
		await revertTo(f.ctx(), r.id);
		assert.equal(f.ex("ok.txt"), true);
		assert.equal(f.ex(".env"), false, "secret bị khôi phục");
		assert.equal(fs.readFileSync(path.join(f.work, "sub/.env"), "utf8"), "CHANGED\n");
		assert.equal(f.ex("id_rsa"), true);
	});

	test("snapshot cũ có chứa secret: revert không khôi phục/xóa chúng", async () => {
		const f = fixture();
		f.w("a.txt");
		const first = await takeSnapshot(f.ctx(), { force: true });
		// giả lập kho cũ (trước bản vá) đã lỡ chụp .env: dùng git trực tiếp trên bản sao có index riêng
		const c = f.ctx();
		fs.writeFileSync(path.join(f.work, ".env"), "OLD\n");
		const env = { PATH: process.env.PATH, GIT_DIR: c.gitDir, GIT_WORK_TREE: f.work, GIT_INDEX_FILE: path.join(f.dir, "idx"), GIT_CONFIG_GLOBAL: "/dev/null" };
		const g = (...a) => spawnSync("git", a, { env, encoding: "utf8", cwd: f.work }).stdout.trim();
		g("add", "-f", "a.txt", ".env");
		const tree = g("write-tree");
		const commit = g("-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", JSON.stringify({ v: 1, kind: "old" }));
		g("update-ref", `refs/snap/${String(Date.now() + 1000).padStart(13, "0")}-${commit.slice(0, 12)}`, commit);
		fs.rmSync(path.join(f.work, ".env"));
		fs.rmSync(path.join(f.work, "a.txt"));
		await revertTo(f.ctx(), commit.slice(0, 12));
		assert.equal(f.ex("a.txt"), true);
		assert.equal(f.ex(".env"), false);
		void first;
	});
});

describe("S3: thư mục đã chụp bị thay bằng symlink", () => {
	test("snapshot/diff/revert vẫn chạy, file lỗi bị bỏ qua", async () => {
		const f = fixture();
		f.w("d/inner.txt", "in\n");
		f.w("keep.txt", "k\n");
		await takeSnapshot(f.ctx(), { force: true });
		// d/ bị thay bằng symlink tới thư mục khác
		const other = path.join(f.dir, "other");
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(other, "inner.txt"), "other\n");
		fs.rmSync(path.join(f.work, "d"), { recursive: true });
		fs.symlinkSync(other, path.join(f.work, "d"));
		f.w("keep.txt", "k2\n");
		const s2 = await takeSnapshot(f.ctx(), { force: true });
		assert.ok(s2.id);
		assert.ok(!treeFiles(f, s2.id).includes("d/inner.txt"));
		assert.equal(f.cli(["list"]).code, 0);
		assert.equal(f.cli(["diff", "first"]).code, 0);
		const r = f.cli(["revert", "first"]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(fs.readFileSync(path.join(f.work, "keep.txt"), "utf8"), "k\n");
		// file ngoài thư mục (đích symlink) không bị đụng
		assert.equal(fs.readFileSync(path.join(other, "inner.txt"), "utf8"), "other\n");
	});

	test("index hỏng được dựng lại tự động", async () => {
		const f = fixture();
		f.w("d/inner.txt", "in\n");
		await takeSnapshot(f.ctx(), { force: true });
		fs.writeFileSync(f.ctx().indexFile, "RÁC");
		const r = await takeSnapshot(f.ctx(), { force: true });
		assert.equal(r.files, 1);
	});
});

describe("S4: revert không xóa thư mục còn file ngoài snapshot", () => {
	test("build/.env còn nguyên khi đích có file tên build", async () => {
		const f = fixture();
		f.w("build", "file\n");
		const first = await takeSnapshot(f.ctx(), { force: true });
		fs.rmSync(path.join(f.work, "build"));
		f.w("build/x.txt", "x\n");
		f.w("build/.env", "SECRET\n");
		await takeSnapshot(f.ctx(), { force: true });
		const r = await revertTo(f.ctx(), first.id);
		assert.equal(fs.readFileSync(path.join(f.work, "build/.env"), "utf8"), "SECRET\n");
		assert.ok(r.errors.some((e) => e.path === "build"), JSON.stringify(r.errors));
		assert.ok(!r.restored.includes("build"));
	});

	test("thư mục chỉ chứa file thuộc snapshot thì vẫn được thay bằng file", async () => {
		const f = fixture();
		f.w("build", "file\n");
		const first = await takeSnapshot(f.ctx(), { force: true });
		fs.rmSync(path.join(f.work, "build"));
		f.w("build/x.txt", "x\n");
		await takeSnapshot(f.ctx(), { force: true });
		const r = await revertTo(f.ctx(), first.id);
		assert.deepEqual(r.errors, []);
		assert.equal(fs.readFileSync(path.join(f.work, "build"), "utf8"), "file\n");
	});
});

describe("S5: tương thích tên nội bộ trên đĩa của kho bóng (giữ tiền tố coder)", () => {
	test("kho mới dùng coder-cwd + .coder-snapshot-meta.json; kho cũ vẫn chụp/revert/prune được", async () => {
		const f = fixture();
		f.w("a.txt", "one\n");
		const first = await takeSnapshot(f.ctx(), { force: true });
		const c = f.ctx();
		// Chuỗi literal (KHÔNG dùng META_FILE) để test bắt được nếu ai đó đổi tên lại.
		let names = fs.readdirSync(c.gitDir);
		assert.ok(names.includes("coder-cwd"), `thiếu coder-cwd ở mức gốc: ${names.join(", ")}`);
		assert.ok(names.includes(".coder-snapshot-meta.json"), `thiếu .coder-snapshot-meta.json ở mức gốc: ${names.join(", ")}`);
		assert.ok(!names.includes("mth-cwd") && !names.includes(".mth-snapshot-meta.json"), `kho mới chứa tên mth-*: ${names.join(", ")}`);

		// Mô phỏng kho cũ có sẵn: đúng marker tên cũ, lastUsedAt cũ.
		const oldMarker = () =>
			fs.writeFileSync(path.join(c.gitDir, ".coder-snapshot-meta.json"), JSON.stringify({ v: 1, cwd: c.cwd, lastUsedAt: new Date(0).toISOString() }) + "\n");
		oldMarker();

		// Chụp lại qua CLI (đi qua sanitizeRepo phía host), rồi revert về snapshot đầu.
		f.w("a.txt", "two\n");
		let r = f.cli(["take"]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stderr, /tệp lạ ở mức gốc/, r.stderr);
		names = fs.readdirSync(c.gitDir);
		assert.ok(names.includes("coder-cwd") && names.includes(".coder-snapshot-meta.json"), names.join(", "));

		oldMarker();
		r = f.cli(["revert", first.id]);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stderr, /tệp lạ ở mức gốc/, r.stderr);
		assert.equal(fs.readFileSync(path.join(f.work, "a.txt"), "utf8"), "one\n");

		// prune: --dir trỏ thư mục khác để kho này không nằm trong protectKeys.
		const other = path.join(f.dir, "other");
		fs.mkdirSync(other);
		const maybeOld = () => {
			if (fs.existsSync(path.join(c.gitDir, ".coder-snapshot-meta.json"))) oldMarker();
		};
		maybeOld();
		r = f.cli(["prune", "--days", "0.000001", "--max-mb", "1000000", "--dry-run"], {}, other);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stderr, /tệp lạ ở mức gốc/, r.stderr);
		assert.equal(r.json.ok, true);
		assert.equal(r.json.removed.length, 1, r.stdout);
		assert.equal(r.json.removed[0].cwd, c.cwd);
		assert.equal(fs.existsSync(c.gitDir), true, "dry-run phải giữ kho");

		maybeOld();
		r = f.cli(["prune", "--days", "0.000001", "--max-mb", "1000000"], {}, other);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stderr, /tệp lạ ở mức gốc/, r.stderr);
		assert.equal(r.json.ok, true);
		assert.equal(r.json.removed.length, 1, r.stdout);
		assert.equal(fs.existsSync(c.gitDir), false, "prune thật phải xóa kho cũ");
	});
});
