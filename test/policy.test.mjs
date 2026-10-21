// Test hồi quy lớp quyền (bot-permissions + plan-mode + permissions-cli).
// Chạy: node --test --experimental-strip-types test/policy.test.mjs
// Nạp THẲNG hook `tool_call` của index.ts với `pi` giả; không chạy lệnh nguy hiểm (chỉ file đánh dấu trong thư mục tạm).
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const getAgentDir=()=>process.env.PI_CODING_AGENT_DIR;"), shortCircuit: true };
  return n(s, c);
}`),
	import.meta.url,
);

const CODER = path.resolve(new URL("..", import.meta.url).pathname);
const EXT = path.join(CODER, "agent/extensions");
const CLI = path.join(CODER, "lib/permissions-cli.mjs");
const mod = await import(pathToFileURL(path.join(EXT, "bot-permissions/index.ts")).href);
const planUtils = await import(pathToFileURL(path.join(EXT, "plan-mode/utils.ts")).href);
const grantsMod = await import(pathToFileURL(path.join(EXT, "bot-permissions/grants.ts")).href);

const cleanups = [];
test.after(() => {
	for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

/** Dựng agent-dir + workdir tạm (workdir là repo git thật), nạp extension và trả hàm chạy tool_call. */
function setup(sid = "sess-1") {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pol-test-")));
	cleanups.push(root);
	const agent = path.join(root, "agent");
	const work = path.join(root, "work");
	for (const d of ["grants", "grants-used", "permission-requests"]) fs.mkdirSync(path.join(agent, d), { recursive: true });
	fs.mkdirSync(path.join(work, "src"), { recursive: true });
	fs.copyFileSync(path.join(CODER, "agent/permissions.json"), path.join(agent, "permissions.json"));
	fs.writeFileSync(path.join(work, "a.ts"), "export const a = 1;\nconst foo = 2;\n");
	fs.writeFileSync(path.join(work, "src/b.ts"), "export const b = 2;\n");
	fs.writeFileSync(path.join(work, "notes.txt"), "x\ny\nx\n");
	fs.writeFileSync(path.join(work, "package.json"), '{"name":"t","scripts":{"test":"node --test"}}\n');
	fs.writeFileSync(path.join(work, ".env"), "SECRET_TOKEN=abcdefgh12345678\n");
	execFileSync("git", ["init", "-q"], { cwd: work });
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.MTH_WORKDIR = work;
	const handlers = {};
	mod.default({ on: (n, f) => (handlers[n] = f), appendEntry() {} });
	const ctx = { cwd: work, hasUI: false, ui: {}, sessionManager: { getSessionId: () => sid } };
	const call = async (toolName, input) => {
		process.env.PI_CODING_AGENT_DIR = agent; // extension khác đã chạy có thể đổi env: đặt lại
		process.env.MTH_WORKDIR = work;
		return handlers.tool_call({ toolName, input }, ctx);
	};
	const bash = (command) => call("bash", { command });
	const cli = (...args) => {
		const r = spawnSync("node", [CLI, "--agent-dir", agent, "--json", ...args], { encoding: "utf8" });
		let j;
		try {
			j = JSON.parse(r.stdout);
		} catch {
			j = { raw: r.stdout, err: r.stderr };
		}
		return { status: r.status, ...j };
	};
	return { root, agent, work, bash, call, cli, sid };
}
const isBlocked = (r) => !!r && r.block === true;
async function assertBlocked(h, cmd, why = "") {
	const r = await h.bash(cmd);
	assert.ok(isBlocked(r), `PHẢI chặn: ${cmd} ${why}`);
	return r;
}
async function assertAllowed(h, cmd) {
	const r = await h.bash(cmd);
	assert.ok(!isBlocked(r), `KHÔNG được chặn nhầm: ${cmd} => ${r?.reason}`);
}

// ====================================================================================================
// A. mở rộng biến/${IFS}/brace/tilde/glob
// ====================================================================================================

test("A0: xác nhận bash thật sự tách ${IFS} lúc chạy (file đánh dấu trong tmp) => cần chặn ở policy", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "ifs-"));
	cleanups.push(d);
	const marker = path.join(d, "marker");
	execFileSync("bash", ["-c", `cd ${d} && find . -maxdepth 0 -fprint\${IFS}${marker}`]);
	assert.ok(fs.existsSync(marker), "bash đã ghi file đánh dấu qua -fprint${IFS}...");
});

test("A: payload mở rộng biến/${IFS}/$()/backtick/brace/tilde bị chặn ở mọi vị trí", async () => {
	const h = setup();
	const m = path.join(h.root, "marker-a");
	const payloads = [
		`find . -maxdepth 0 -fprint\${IFS}${m}`,
		`find . -maxdepth 1 -exec\${IFS}touch\${IFS}${m}\${IFS}{}\${IFS}+`,
		"echo $SOME_API_KEY",
		"echo ${SOME_API_KEY}",
		'echo "$SOME_API_KEY"',
		"echo $HOME",
		"cat $HOME/a.ts",
		"ls $1",
		"echo $?",
		"echo $$",
		"echo $@",
		"echo $'\\x41'",
		'echo $"abc"',
		"ls {a.ts,notes.txt}",
		"ls {1..3}",
		"cat ~root/a.ts",
		"cat ~+/a.ts",
		"$CMD a.ts",
		"ls ${IFS}",
		"cat a.ts > $OUT",
		"git log --output=${X}",
		"echo $(id)",
		"echo `id`",
		"grep -rn foo $PWD",
		"npm test -- --x=$HOME",
	];
	for (const p of payloads) await assertBlocked(h, p);
	assert.ok(!fs.existsSync(m));
});

test("A: ký tự $ trong dấu nháy đơn hoặc bị escape thì ĐƯỢC (không phải mở rộng)", async () => {
	const h = setup();
	for (const c of ["grep -rn '$foo' src", "sed -n '$p' a.ts", "grep -n 'foo$' a.ts", 'grep -n "foo$" a.ts', "grep -n \"^a$|b\" a.ts", "echo 'cost is $5'", "echo \\$HOME", 'echo "a\\$b"'])
		await assertAllowed(h, c);
});

test("A: glob chỉ ở toán hạng ĐƯỜNG DẪN của lệnh đọc/liệt kê, ở thành phần cuối", async () => {
	const h = setup();
	for (const c of ["ls *.ts", "cat *.ts", "cat src/*.ts", "wc -l src/*.ts", "grep -n foo *.ts", "rg -n foo src/*.ts", "head -5 src/b*.ts", "find src -name '*.ts'", "grep -rn foo --include=*.ts ."])
		await assertAllowed(h, c);
	for (const c of [
		"echo *",
		"cat */a.ts",
		"ls */",
		"find . -name *.ts",
		"grep foo* a.ts",
		"cp *.ts src/",
		"mv *.txt src/",
		"touch *.x",
		"mkdir d*",
		"git log -- *.ts",
		"npm test -- *.js",
		"cat a.ts > out*.txt",
		"cat .env*",
		"cat ./.env*",
		"cat .en?",
		"ls /proc/self/envir*",
		"cat /pro?/self/environ",
		"cat ~/.s*/id_*",
		"ls ~/.ss?",
		"rm *",
	])
		await assertBlocked(h, c);
});

test("A: engine cho plan-mode cũng chặn mở rộng/glob sai chỗ", () => {
	for (const c of ["echo $HOME", "find . -fprint${IFS}/tmp/x", "ls {a,b}", "cat ~root/x", "echo *", "cat */x", "find . -name *.ts"]) assert.ok(planUtils.whyNotReadOnly(c), `plan-mode phải chặn: ${c}`);
});

// ====================================================================================================
// B. whitelist cờ
// ====================================================================================================

const B_BLOCK = [
	// sed
	"sed -n 1p --expression='1e id' a.ts",
	"sed -n 1p -e 'w /tmp/x' a.ts",
	"sed -n -e 1p a.ts",
	"sed -i s/a/b/ a.ts",
	"sed -n '1w /tmp/x' a.ts",
	"sed -n '1e id' a.ts",
	"sed -n '1r /etc/passwd' a.ts",
	"sed -n 1p -f s.sed a.ts",
	"sed -n 1p -s a.ts",
	"sed -n 1p --in-place a.ts",
	"sed 1p a.ts",
	"sed -n 's/a/b/p' a.ts",
	"sed -n 1p;1w a.ts",
	// find
	"find . -exec rm {} ;",
	"find . -exec touch x {} +",
	"find . -execdir sh -c id ;",
	"find . -ok rm {} ;",
	"find . -okdir rm {} ;",
	"find . -delete",
	"find . -fprint /tmp/x",
	"find . -fprint0 /tmp/x",
	"find . -fprintf /tmp/x %p",
	"find . -fls /tmp/x",
	"find . -name a -o -exec id ;",
	"find . -newer",
	"find . -files0-from /tmp/x",
	// uniq/sort
	"uniq notes.txt out.txt",
	"sort -o out.txt notes.txt",
	"sort --output=out.txt notes.txt",
	"sort -ofoo notes.txt",
	"sort --compress-program=sh notes.txt",
	"sort -T /tmp notes.txt",
	"sort --files0-from=x",
	// jq
	"jq env package.json",
	"jq '$ENV.PATH' package.json",
	"jq '.[] | env' package.json",
	"jq input_filename package.json",
	"jq --rawfile x /etc/hostname . package.json",
	"jq --slurpfile x /etc/hostname . package.json",
	"jq --argfile x /etc/hostname . package.json",
	"jq -f /etc/x.jq package.json",
	"jq --from-file /etc/x.jq package.json",
	"jq 'include \"x\"; .' package.json",
	"jq -L /tmp . package.json",
	"jq --args . x",
	// rg / grep
	"rg --pre sh foo",
	"rg --pre=sh foo",
	"rg --pre-glob '*.x' foo",
	"rg --hostname-bin sh foo",
	"rg -z foo",
	"rg --search-zip foo",
	"grep -f /etc/passwd a.ts",
	"grep --file=/etc/passwd a.ts",
	"grep --exec x a.ts",
	// tree/diff
	"tree -o out.txt",
	"tree --fromfile x",
	"diff --to-file=x a.ts b.ts",
	"diff a.ts b.ts c.ts",
	// git
	"git -c core.pager=sh log",
	"git -c alias.x=!id log",
	"git --exec-path=/x status",
	"git --git-dir=/x log",
	"git --work-tree=/x status",
	"git -C /etc status",
	"git -C .. status",
	"git log --output=/tmp/x",
	"git log --outp=/tmp/x",
	"git diff --ext-diff",
	"git diff --ext-d",
	"git diff --textconv",
	"git log --open-files-in-pager=sh",
	"git log -O sh",
	"git grep -O'sh' foo",
	"git grep -Osh foo",
	"git grep --open-files-in-pager=sh foo",
	"git diff --no-index /etc/passwd a.ts",
	"git log --show-signature",
	"git branch newbranch",
	"git branch -D x",
	"git config --list",
	"git push origin main",
	"git remote add x y",
	"git fetch",
	"git rev-parse --git-dir x --upload-pack=sh",
	"git commit --exec=sh",
	"git rebase -x 'id' HEAD~1",
	"git rebase -i HEAD~2",
	"git add -e",
	"git upload-pack .",
	// cat/head/tail/wc/ls/stat/file
	"cat --foo a.ts",
	"head -f a.ts",
	"tail -f a.ts",
	"tail --follow a.ts",
	"wc --files0-from=x",
	"ls --hyperlink a.ts",
	"stat --foo a.ts",
	"file -m /x a.ts",
	"file -f /x",
	// cp/mv/mkdir/touch: đích ngoài jail
	"cp a.ts /tmp/x",
	"cp -t /tmp a.ts",
	"cp --target-directory=/tmp a.ts",
	"cp -s a.ts link",
	"mkdir /tmp/pol-x",
	"mkdir ../x",
	"touch /tmp/pol-x",
	"touch ../x",
	"mv a.ts ../x",
	"mv /tmp/x a.ts",
	"cp a.ts .git/x",
	"touch .env",
	// biến thể chưa cài trên máy
	"fd -x id",
	"fd --exec id",
	"fd -X id",
	"fd --exec-batch id",
	"bat --pager 'sh -c id' a.ts",
	"bat a.ts",
	"less '+!id' a.ts",
	"less a.ts",
	"more a.ts",
	"man ls",
	"awk 'BEGIN{system(\"id\")}'",
	"vim a.ts",
	"env -S 'cat a.ts'",
	"FOO=1 BASH_ENV=/x ls",
	"GIT_PAGER=sh git log",
	"npm_config_script_shell=sh npm test",
	"xargs ls",
	"sort -z -S 1 -T /tmp a",
];

test("B: payload lách cờ (sed/find/sort/uniq/jq/rg/grep/tree/diff/git/cp/mv/...) bị chặn", async () => {
	const h = setup();
	const m = path.join(h.root, "marker-b");
	for (const p of B_BLOCK) await assertBlocked(h, p);
	assert.ok(!fs.existsSync(m));
	assert.ok(!fs.existsSync("/tmp/pol-x"));
});

test("B: yarn/npm đọc cấu hình chạy mã từ repo bị chặn (.yarnrc.yml yarnPath, plugins)", async () => {
	const h = setup();
	fs.writeFileSync(path.join(h.work, ".yarnrc.yml"), "yarnPath: .yarn/releases/evil.cjs\n");
	const r = await h.bash("yarn add left-pad");
	assert.ok(isBlocked(r));
	assert.ok(/yarn/.test(r.reason) && !/needs_permission/.test(r.reason), r.reason);
	fs.writeFileSync(path.join(h.work, ".yarnrc.yml"), "nodeLinker: node-modules\n");
	const r2 = await h.bash("yarn add left-pad");
	assert.ok(/needs_permission/.test(r2.reason), "yarn sạch vẫn đi qua luồng ask: " + r2.reason);
});

test("B: cấu hình git của repo có khóa chạy lệnh ngoài (fsmonitor/textconv/pager...) => chặn git", async () => {
	const h = setup();
	await assertAllowed(h, "git status");
	fs.appendFileSync(path.join(h.work, ".git/config"), '[core]\n\tfsmonitor = touch /tmp/pol-evil\n');
	await assertBlocked(h, "git status");
	fs.writeFileSync(path.join(h.work, ".git/config"), '[diff "x"]\n\ttextconv = sh -c id\n');
	await assertBlocked(h, "git diff");
	fs.writeFileSync(path.join(h.work, ".git/config"), '[core]\n\tbare = false\n\tfsmonitor = true\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
	await assertAllowed(h, "git status");
});

const VALID_BOT = [
	"git status",
	"git status --short",
	"git status -sb",
	"git diff",
	"git diff --stat",
	"git diff --stat HEAD~1",
	"git diff HEAD -- src/b.ts",
	"git diff --cached --name-only",
	"git log",
	"git log --oneline -n 5",
	"git log -5 --format=%H",
	"git log --oneline --graph --decorate --all",
	"git log --author=bob --since=2.days -- a.ts",
	"git show HEAD --stat",
	"git show HEAD:a.ts",
	"git branch",
	"git branch --show-current",
	"git branch -a",
	"git rev-parse --show-toplevel",
	"git rev-parse --abbrev-ref HEAD",
	"git ls-files",
	"git ls-files -m",
	"git blame -L 1,5 a.ts",
	"ls",
	"ls -la",
	"ls -lah src",
	"cat a.ts",
	"cat -n a.ts src/b.ts",
	"cat a.ts | head -5",
	"grep -rn foo src",
	"grep -rn pattern .",
	"grep -rn -i 'foo bar' --include='*.ts' src",
	"grep -n -e foo -e bar a.ts",
	"grep -c foo a.ts",
	"grep -rln foo . | sort | uniq",
	"rg -n foo src",
	"rg --files",
	"rg -i -n --glob '*.ts' foo",
	"rg -l foo -t ts",
	"find . -name '*.ts' -type f",
	'find src -type f -name "*.ts" -not -path "*/node_modules/*"',
	"find . -maxdepth 2 -type d",
	"find . \\( -name '*.ts' -o -name '*.js' \\) -type f -print",
	"find . -type f -newer a.ts -size +1k",
	"sed -n 1,20p a.ts",
	"sed -n '5p' a.ts",
	"sed -n '3,$p' a.ts",
	"sed -n '$p' a.ts",
	"head a.ts",
	"head -n 20 a.ts",
	"head -20 a.ts",
	"tail -n 5 a.ts",
	"tail -5 a.ts",
	"tail -n +3 a.ts",
	"wc -l a.ts",
	"wc -l src/*.ts",
	"sort notes.txt | uniq -c",
	"sort -u -k1,1 notes.txt",
	"sort -rn notes.txt",
	"uniq notes.txt",
	"jq .name package.json",
	"jq -r '.scripts.test' package.json",
	"jq '.scripts | keys' package.json",
	"jq --arg k name '.[$k]' package.json",
	"diff a.ts src/b.ts",
	"diff -u a.ts src/b.ts",
	"stat a.ts",
	"file a.ts",
	"tree -L 2",
	"pwd",
	"echo hello",
	"echo 'a b' && echo done",
	"node --version",
	"node --test",
	"node --test test/",
	"npm test",
	"npm test 2>&1 | tail -20",
	"npm run lint",
	"python3 -m pytest -q",
	"python3 --version",
	"mkdir -p build/out",
	"mkdir newdir",
	"cp a.ts a2.ts",
	"cp -r src src2",
	"cp -v a.ts src/",
	"touch new.txt",
	"mv notes.txt notes2.txt",
	"cd src && ls",
	"ls 2>/dev/null",
	"ls nonexistent 2>&1 | head -3",
	"ls && echo ok",
];

test("B: lệnh hợp lệ phổ biến VẪN chạy (không chặn nhầm quá tay)", async () => {
	const h = setup();
	for (const c of VALID_BOT) {
		const r = await h.bash(c);
		// lệnh test/build (bash.sandbox) ngoài mth-sandbox => ask bash.sandbox (không chặn cứng); còn lại phải chạy thẳng
		if (/^(node --test|npm (test|run (lint|build|test))|python3 -m pytest)/.test(c))
			assert.ok(isBlocked(r) && /needs_permission/.test(r.reason) && /"rule":"bash\.sandbox"/.test(r.reason), `test/build ngoài sandbox phải ask bash.sandbox: ${c} => ${r?.reason}`);
		else assert.ok(!isBlocked(r), `KHÔNG được chặn nhầm: ${c} => ${r?.reason}`);
	}
});

test("B: lệnh cần duyệt vẫn đi vào luồng ask (git add/commit, npm install)", async () => {
	const h = setup();
	for (const c of ["git add a.ts", "git add -A", 'git commit -m "msg"', "npm install left-pad"]) {
		const r = await h.bash(c);
		assert.ok(isBlocked(r) && /needs_permission/.test(r.reason), `${c} => ${r?.reason}`);
	}
	for (const c of ["git add -e", "git commit --exec=x -m m", "git rebase -x id HEAD~1"]) {
		const r = await h.bash(c);
		assert.ok(isBlocked(r) && !/needs_permission/.test(r.reason), `${c} phải bị chặn cứng: ${r?.reason}`);
	}
});

test("B: plan-mode (chỉ-đọc) dùng cùng engine: payload B bị chặn, lệnh đọc hợp lệ được", () => {
	const mustBlock = B_BLOCK.filter((c) => !/^(cp|mv|mkdir|touch|FOO=|GIT_PAGER|npm_config)/.test(c));
	for (const c of mustBlock) assert.ok(planUtils.whyNotReadOnly(c), `plan-mode phải chặn: ${c}`);
	for (const c of ["cp a b", "mv a b", "mkdir x", "touch x", "npm test", "yarn install", "pip list", "go env", "cargo metadata", "node -e 1", "python3 x.py", "git add a", "git stash", "git config --get x", "ps aux", "less a.ts", "date -s 1", "git branch x", "tee x", "rm a", "sed -n 1p a.ts > x", "cat a.ts > /tmp/x"])
		assert.ok(planUtils.whyNotReadOnly(c), `plan-mode phải chặn: ${c}`);
	for (const c of [
		"git status", "git diff", "git diff --stat HEAD~1", "git log --oneline -5", "git show HEAD", "git branch -a", "git blame -L 1,3 a.ts", "ls -la", "cat a.ts", "rg -n foo src",
		"grep -rn foo src", "find . -name '*.ts' -type f", "sed -n 1,5p a.ts", "wc -l a.ts", "head -5 a.ts", "tail -5 a.ts", "sort a | uniq -c", "jq .name package.json", "npm ls", "node --version",
		"python3 --version", "git status 2>/dev/null", "pwd", "echo hi", "diff a b", "tree -L 2", "stat a.ts", "file a.ts", "cat a.ts | grep foo | head", "git diff -- src/b.ts", "git rev-parse HEAD", "git ls-files",
	])
		assert.equal(planUtils.whyNotReadOnly(c), null, `plan-mode không được chặn nhầm: ${c}`);
});

test("bot-permissions/shell.ts và plan-mode/shell.ts GIỐNG HỆT nhau", () => {
	assert.equal(fs.readFileSync(path.join(EXT, "bot-permissions/shell.ts"), "utf8"), fs.readFileSync(path.join(EXT, "plan-mode/shell.ts"), "utf8"));
});

test("redirect-only (> file) cũng bị kiểm tra ghi; redirect ra ngoài jail bị chặn", async () => {
	const h = setup();
	await assertBlocked(h, "> /tmp/pol-redirect");
	await assertBlocked(h, "echo x > /tmp/pol-redirect");
	await assertBlocked(h, "echo x > ../pol-redirect");
	await assertAllowed(h, "echo x > out.txt");
	assert.ok(!fs.existsSync("/tmp/pol-redirect"));
});

test("đọc secret: .env, HEAD:.env, glob, auth.json vẫn bị chặn", async () => {
	const h = setup();
	for (const c of ["cat .env", "git show HEAD:.env", "git show :.env", "cat ./.env", "grep -r TOKEN .env", "head .env", "cat auth.json", "sed -n 1p .env"]) await assertBlocked(h, c);
	await assertBlocked(h, "grep -rn SECRET_TOKEN .env");
});

test("mkdir/cp/touch trong jail: ghi vào .git/agent-dir bị chặn", async () => {
	const h = setup();
	await assertBlocked(h, `cp a.ts ${path.join(h.agent, "x")}`);
	await assertBlocked(h, "mkdir .git/x");
	await assertBlocked(h, "touch .pi/x");
});

// ====================================================================================================
// C. grants: nguồn chỉ do CLI ghi; sổ used riêng
// ====================================================================================================

const ASK = "git add a.ts";
async function ask(h) {
	const r = await h.bash(ASK);
	assert.ok(isBlocked(r) && /needs_permission/.test(r.reason), r?.reason);
	const id = /pr_[0-9a-f]{12}/.exec(r.reason)[0];
	return id;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("C: grant 'once' qua CLI dùng đúng một lần; extension KHÔNG ghi grants/, chỉ ghi grants-used/", async () => {
	const h = setup();
	const id = await ask(h);
	const ap = h.cli("approve", id);
	assert.equal(ap.ok, true, JSON.stringify(ap));
	assert.match(ap.grantId, /^g_[0-9a-f]{32}$/);
	const gfile = path.join(h.agent, "grants", `${h.sid}.json`);
	const before = fs.readFileSync(gfile, "utf8");
	const mtime = fs.statSync(gfile).mtimeMs;
	assert.ok(!isBlocked(await h.bash(ASK)), "lần 1 được chạy");
	assert.equal(fs.readFileSync(gfile, "utf8"), before, "grants/ không bị extension ghi");
	assert.equal(fs.statSync(gfile).mtimeMs, mtime);
	const used = readJson(path.join(h.agent, "grants-used", `${h.sid}.json`));
	assert.deepEqual(used.used, [ap.grantId]);
	const r2 = await h.bash(ASK);
	assert.ok(isBlocked(r2) && /needs_permission/.test(r2.reason), "lần 2 phải xin lại");
	// CLI hiểu sổ used
	const g = h.cli("grants");
	assert.equal(g.grants[0].status, "used");
	// duyệt lại => grant mới, chạy được lần nữa
	const id2 = /pr_[0-9a-f]{12}/.exec(r2.reason)[0];
	assert.equal(h.cli("approve", id2).ok, true);
	assert.ok(!isBlocked(await h.bash(ASK)));
});

test("C: grant 'session' (approve --always) dùng lại được, không bị tiêu thụ; revoke hiểu sổ used", async () => {
	const h = setup();
	const id = await ask(h);
	const ap = h.cli("approve", id, "--always");
	assert.equal(ap.mode, "session");
	for (let i = 0; i < 3; i++) assert.ok(!isBlocked(await h.bash(ASK)), `lần ${i + 1}`);
	assert.ok(!fs.existsSync(path.join(h.agent, "grants-used", `${h.sid}.json`)) || readJson(path.join(h.agent, "grants-used", `${h.sid}.json`)).used.length === 0);
	assert.equal(h.cli("grants").grants[0].status, "active");
	const rv = h.cli("revoke", id);
	assert.equal(rv.ok, true);
	assert.ok(isBlocked(await h.bash(ASK)), "sau revoke phải bị chặn");
	assert.deepEqual(h.cli("grants").grants, []);
	assert.ok(readJson(path.join(h.agent, "grants-used", `${h.sid}.json`)).used.includes(ap.grantId), "revoke ghi sổ used");
});

test("C: grant GIẢ (không do CLI: thiếu/sai grantId, sai session/key) bị bỏ qua", async () => {
	const h = setup();
	const id = await ask(h);
	const req = readJson(path.join(h.agent, "permission-requests", `${id}.json`));
	const forge = (grants, sessionId = h.sid) => fs.writeFileSync(path.join(h.agent, "grants", `${h.sid}.json`), JSON.stringify({ sessionId, grants }));
	const base = { id, key: req.key, tool: "bash", subject: ASK, mode: "session", createdAt: new Date().toISOString(), source: "cli" };
	forge([base]); // thiếu grantId (định dạng grant cũ)
	assert.ok(isBlocked(await h.bash(ASK)), "thiếu grantId");
	forge([{ ...base, grantId: "g_123" }]);
	assert.ok(isBlocked(await h.bash(ASK)), "grantId sai định dạng");
	forge([{ ...base, grantId: "g_" + "a".repeat(32) }], "other-session");
	assert.ok(isBlocked(await h.bash(ASK)), "sai session");
	forge([{ ...base, key: "0".repeat(64), grantId: "g_" + "b".repeat(32) }]);
	assert.ok(isBlocked(await h.bash(ASK)), "sai key");
	fs.rmSync(path.join(h.agent, "grants", `${h.sid}.json`));
	fs.symlinkSync("/dev/null", path.join(h.agent, "grants", `${h.sid}.json`));
	assert.ok(isBlocked(await h.bash(ASK)), "symlink");
});

test("C: sổ used KHÔNG ghi được => coi như không có grant (fail-closed), grant 'once' không bị dùng", async () => {
	const h = setup();
	const id = await ask(h);
	h.cli("approve", id);
	fs.chmodSync(path.join(h.agent, "grants-used"), 0o500);
	try {
		const r = await h.bash(ASK);
		assert.ok(isBlocked(r) && /needs_permission/.test(r.reason), "ghi sổ lỗi => chặn: " + r?.reason);
	} finally {
		fs.chmodSync(path.join(h.agent, "grants-used"), 0o700);
	}
	assert.ok(!isBlocked(await h.bash(ASK)), "sau khi sổ ghi được lại thì grant còn nguyên và dùng được");
});

test("C: sổ used hỏng/là symlink => chặn mọi grant; sổ giả chỉ GIẢM quyền", async () => {
	const h = setup();
	const id = await ask(h);
	const ap = h.cli("approve", id, "--always");
	const usedFile = path.join(h.agent, "grants-used", `${h.sid}.json`);
	fs.writeFileSync(usedFile, "{ not json");
	assert.ok(isBlocked(await h.bash(ASK)), "sổ hỏng");
	fs.rmSync(usedFile);
	fs.symlinkSync("/dev/null", usedFile);
	assert.ok(isBlocked(await h.bash(ASK)), "sổ symlink");
	fs.rmSync(usedFile);
	fs.writeFileSync(usedFile, JSON.stringify({ sessionId: h.sid, used: [ap.grantId] })); // sandbox giả: chỉ làm mất quyền
	assert.ok(isBlocked(await h.bash(ASK)), "grantId bị ghi vào sổ => mất hiệu lực");
	fs.rmSync(usedFile);
	assert.ok(!isBlocked(await h.bash(ASK)), "sổ sạch => grant session lại hiệu lực");
});

test("C: xóa sổ used sau khi dùng 'once' không phát lại grant trong CÙNG tiến trình", async () => {
	const h = setup();
	const id = await ask(h);
	h.cli("approve", id);
	assert.ok(!isBlocked(await h.bash(ASK)));
	fs.rmSync(path.join(h.agent, "grants-used", `${h.sid}.json`));
	assert.ok(isBlocked(await h.bash(ASK)), "không phát lại được trong cùng tiến trình");
});

test("C: grant chỉ khớp ĐÚNG lệnh + đúng session", async () => {
	const h = setup();
	const id = await ask(h);
	h.cli("approve", id, "--always");
	const r = await h.bash("git add a.ts ");
	assert.ok(!isBlocked(r), "khoảng trắng thừa được chuẩn hóa");
	const r2 = await h.bash("git add src/b.ts");
	assert.ok(isBlocked(r2) && /needs_permission/.test(r2.reason), "lệnh khác phải xin riêng");
	const h2 = setup("sess-other");
	assert.ok(isBlocked(await h2.bash(ASK)));
});

test("C: lệnh model nhắc tới grants/grants-used/permissions-cli bị chặn cứng", async () => {
	const h = setup();
	for (const c of [`cat ${h.agent}/grants/x.json`, "ls grants-used", "node lib/permissions-cli.mjs approve pr_000000000000", "echo x > grants/a.json", "cat ../agent/permission-requests/x.json"])
		await assertBlocked(h, c);
	for (const p of ["grants/x.json", "grants-used/x.json"]) {
		const r = await h.call("write", { path: path.join(h.agent, p), content: "{}" });
		assert.ok(isBlocked(r));
	}
});

test("C: allow_always_session qua RPC chỉ giữ trong bộ nhớ, KHÔNG ghi grants/", async () => {
	const h = setup();
	const handlers = {};
	process.env.PI_CODING_AGENT_DIR = h.agent;
	mod.default({ on: (n, f) => (handlers[n] = f), appendEntry() {} });
	let asked = 0;
	const ctx = { cwd: h.work, hasUI: true, ui: { select: async () => (asked++, "allow_always_session") }, sessionManager: { getSessionId: () => "rpc-1" } };
	const ev = { toolName: "bash", input: { command: ASK } };
	assert.ok(!isBlocked(await handlers.tool_call(ev, ctx)));
	assert.ok(!isBlocked(await handlers.tool_call(ev, ctx)));
	assert.equal(asked, 1, "lần 2 dùng grant bộ nhớ, không hỏi lại");
	assert.deepEqual(fs.readdirSync(path.join(h.agent, "grants")), []);
});

test("C: grants.ts export không còn hàm ghi grants/", () => {
	assert.equal(grantsMod.addGrant, undefined);
});

// ====================================================================================================
// D. permissions-cli: yêu cầu không đáng tin
// ====================================================================================================

import crypto from "node:crypto";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const keyOf = (tool, subject) => sha(`${tool}\0${subject}`);
const idOf = (sid, key) => `pr_${sha(`${sid}\0${key}`).slice(0, 12)}`;
function plant(h, over = {}, subject = "git commit -m forged", sid = "forged-sess") {
	const key = keyOf("bash", subject);
	const id = idOf(sid, key);
	const req = { id, sessionId: sid, key, tool: "bash", kind: "bash", subject, rule: "bash.ask", pattern: "git commit*", reason: "x", status: "pending", createdAt: new Date().toISOString(), ...over };
	const file = path.join(h.agent, "permission-requests", `${over.id ?? id}.json`);
	fs.writeFileSync(file, JSON.stringify(req));
	return { id: over.id ?? id, req, file };
}

test("D: approve từ chối yêu cầu giả (key không khớp / id không khớp / sai định dạng / symlink / quá lớn)", () => {
	const h = setup();
	// key hợp lệ cho lệnh vô hại nhưng subject bị thay bằng lệnh nguy hiểm
	const benignKey = keyOf("bash", "git status");
	const a = plant(h, { key: benignKey }, "git commit -m x", "s1");
	let r = h.cli("approve", a.id);
	assert.equal(r.ok, false);
	assert.equal(r.error, "invalid_request");
	assert.match(r.message, /key không khớp/);
	// id trong file khác tên file
	const b = plant(h, {}, "git commit -m y", "s1");
	const swapped = idOf("s1", keyOf("bash", "git commit -m z"));
	fs.copyFileSync(b.file, path.join(h.agent, "permission-requests", `${swapped}.json`));
	r = h.cli("approve", swapped);
	assert.equal(r.error, "invalid_request");
	// sessionId bị sửa (id tính lại không khớp)
	const c = plant(h, {}, "git commit -m w", "s1");
	const q = readJson(c.file);
	q.sessionId = "victim-session";
	fs.writeFileSync(c.file, JSON.stringify(q));
	r = h.cli("approve", c.id);
	assert.equal(r.error, "invalid_request");
	assert.match(r.message, /id không khớp/);
	// id sai định dạng
	for (const bad of ["../x", "pr_zzz", "pr_0123456789abcde", "x"]) assert.equal(h.cli("approve", bad).error, "bad_id");
	// symlink
	const d = plant(h, {}, "git commit -m s", "s2");
	const target = path.join(h.root, "real.json");
	fs.renameSync(d.file, target);
	fs.symlinkSync(target, d.file);
	r = h.cli("approve", d.id);
	assert.equal(r.error, "invalid_request");
	assert.match(r.message, /file thường|symlink/);
	// quá lớn
	const e = plant(h, {}, "git commit -m big", "s3");
	const big = readJson(e.file);
	big.pad = "x".repeat(70 * 1024);
	fs.writeFileSync(e.file, JSON.stringify(big));
	r = h.cli("approve", e.id);
	assert.equal(r.error, "invalid_request");
	assert.match(r.message, /quá lớn/);
	// subject quá dài
	const longSubj = "git commit -m " + "y".repeat(8100);
	const f = plant(h, {}, longSubj, "s4");
	assert.equal(h.cli("approve", f.id).error, "invalid_request");
	// không có grant nào được tạo
	assert.deepEqual(fs.readdirSync(path.join(h.agent, "grants")), []);
});

test("D: yêu cầu nhất quán thì approve được và hiển thị đúng subject nguyên văn (che secret, thoát ký tự điều khiển)", () => {
	const h = setup();
	const subj = "git commit -m \u001b[2Jhello token=abcd1234efgh5678";
	const p = plant(h, {}, subj, "s5");
	const r = h.cli("approve", p.id, "--session", "s5");
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.ok(r.subject.includes("\\x1b[2Jhello"), r.subject);
	assert.ok(!r.subject.includes("abcd1234efgh5678"), "secret phải bị che");
	const gr = readJson(path.join(h.agent, "grants", "s5.json"));
	assert.equal(gr.grants[0].key, keyOf("bash", subj));
	assert.equal(gr.grants[0].mode, "once");
	assert.match(gr.grants[0].grantId, /^g_[0-9a-f]{32}$/);
});

test("D: pending bỏ qua và gắn cờ mục không hợp lệ; chỉ liệt kê mục xác minh được", () => {
	const h = setup();
	const good = plant(h, {}, "git commit -m good", "s6");
	plant(h, { key: "f".repeat(64) }, "git commit -m bad", "s6");
	fs.writeFileSync(path.join(h.agent, "permission-requests", "junk.json"), "{}");
	fs.writeFileSync(path.join(h.agent, "permission-requests", "pr_aaaaaaaaaaaa.json"), "not json");
	const r = h.cli("pending");
	assert.equal(r.ok, true);
	assert.deepEqual(r.pending.map((x) => x.id), [good.id]);
	assert.ok(r.invalid.length >= 3, JSON.stringify(r.invalid));
});

test("D: deny/revoke chỉ chạy trên yêu cầu hợp lệ; deny gỡ grant cùng chủ thể", () => {
	const h = setup();
	const p = plant(h, {}, "git commit -m d", "s7");
	assert.equal(h.cli("approve", p.id).ok, true);
	assert.equal(h.cli("grants").grants.length, 1);
	assert.equal(h.cli("deny", p.id).ok, true);
	assert.deepEqual(h.cli("grants").grants, []);
	assert.equal(readJson(p.file).status, "denied");
	const bad = plant(h, { key: "0".repeat(64) }, "git commit -m e", "s7");
	assert.equal(h.cli("deny", bad.id).error, "invalid_request");
});

test("D: luồng thật extension -> CLI: request do extension ghi qua được xác minh (key/id tính lại)", async () => {
	const h = setup();
	const id = await ask(h);
	const q = readJson(path.join(h.agent, "permission-requests", `${id}.json`));
	assert.equal(q.key, keyOf("bash", ASK));
	assert.equal(q.subject, ASK, "subject lưu nguyên văn để CLI tính lại key");
	assert.equal(h.cli("pending").pending[0].id, id);
	assert.equal(h.cli("approve", id).ok, true);
});

// ====================================================================================================
// E. audit.log không tin cậy / không crash
// ====================================================================================================

test("E: audit.log không ghi được (là thư mục / symlink / agent-dir chỉ-đọc) => extension không crash, vẫn quyết định đúng", async () => {
	const h = setup();
	fs.mkdirSync(path.join(h.agent, "audit.log"));
	assert.ok(!isBlocked(await h.bash("ls")));
	assert.ok(isBlocked(await h.bash("cat .env")));
	fs.rmdirSync(path.join(h.agent, "audit.log"));
	const victim = path.join(h.root, "victim.txt");
	fs.writeFileSync(victim, "keep\n");
	fs.symlinkSync(victim, path.join(h.agent, "audit.log"));
	assert.ok(!isBlocked(await h.bash("ls")));
	assert.equal(fs.readFileSync(victim, "utf8"), "keep\n", "audit không đi theo symlink");
	fs.rmSync(path.join(h.agent, "audit.log"));
	fs.chmodSync(h.agent, 0o500);
	try {
		assert.ok(!isBlocked(await h.bash("ls")));
		assert.ok(isBlocked(await h.bash("git add a.ts")), "vẫn ask/chặn đúng khi không ghi được request");
	} finally {
		fs.chmodSync(h.agent, 0o700);
	}
});

test("E: bình thường audit.log vẫn được ghi (chức năng giữ nguyên)", async () => {
	const h = setup();
	await h.bash("ls");
	await h.bash("cat .env");
	const lines = fs.readFileSync(path.join(h.agent, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(lines.some((l) => l.decision === "allow"));
	assert.ok(lines.some((l) => l.decision === "block"));
});

// ====================================================================================================
// Bổ sung: duyệt đệ quy từ gốc nhạy cảm, /proc, tên file bí mật trong rev/pathspec của git
// ====================================================================================================

test("duyệt đệ quy từ /, home, agent-dir, /proc bị chặn; trong thư mục dự án thì được", async () => {
	const h = setup();
	for (const c of ["grep -rn KEY /", "grep -rn KEY ~", `grep -rn KEY ${path.dirname(h.agent)}/agent`, "rg KEY /", "rg KEY ~", "find / -name environ", "find ~ -name id_rsa", "ls -R /", "du -a /", "tree /", "cat /proc/self/environ", "grep -r KEY /proc/self", "ls /proc/self/environ"])
		await assertBlocked(h, c);
	for (const c of ["grep -rn foo .", "rg foo", "find . -type f", "ls -R src", "tree -L 1"]) await assertAllowed(h, c);
	for (const c of ["grep -rn KEY /", "rg KEY ~", "find / -name x", "ls -R /", "tree ~", "du /"]) assert.ok(planUtils.whyNotReadOnly(c), `plan-mode phải chặn: ${c}`);
});

test("git: tên file bí mật trong rev:path / pathspec bị chặn", async () => {
	const h = setup();
	for (const c of ["git show HEAD:server.key", "git show HEAD:sub/cert.pem", "git log -p -- server.key", "git diff id_rsa", "git blame credentials.json", "git show HEAD:.env"]) await assertBlocked(h, c);
	for (const c of ["git show HEAD:a.ts", "git log -p -- a.ts", "git diff HEAD~1 HEAD", "git blame a.ts"]) await assertAllowed(h, c);
});
