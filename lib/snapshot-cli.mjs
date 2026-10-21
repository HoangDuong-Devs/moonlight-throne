#!/usr/bin/env node
// snapshot-cli: hoàn tác theo git bằng kho "bóng" riêng (không đụng .git của người dùng).
// Vừa là thư viện (extension snapshot import) vừa là CLI độc lập. Node thuần, không dependency.
//
//   node snapshot-cli.mjs list   [--session ID] [--limit N] [--dir CWD] [--json]
//   node snapshot-cli.mjs diff   <snapshot> [<snapshot2>] [--patch] [--dir CWD] [--json]
//   node snapshot-cli.mjs revert <snapshot> [--paths a,b] [--dry-run] [--dir CWD] [--json]
//   node snapshot-cli.mjs take   [--label TXT] [--session ID] [--dir CWD] [--json]
//   node snapshot-cli.mjs prune  [--days N] [--max-mb M] [--dry-run] [--json]   (dọn kho của thư mục làm việc cũ)
//
// Kho bóng: <agent-dir>/snapshots/<sha1(realpath cwd)[0:16]>/ (GIT_DIR), GIT_WORK_TREE = cwd.
// agent-dir: --agent-dir hoặc env MTH_AGENT_DIR (mặc định ../agent cạnh thư mục lib này).
// Cấu hình: <agent-dir>/snapshot.json
//   { "enabled": true, "keep": 50, "maxFileBytes": 2097152, "maxRepoMB": 500, "maxFiles": 20000,
//     "exclude": ["*.log"], "capture": { "turn": true, "end": true },
//     "prune": { "enabled": true, "maxAgeDays": 14, "maxTotalMB": 1000 } }

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir as resolveAgentDirShared } from "./agent-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
	enabled: true,
	keep: 50,
	maxFileBytes: 2 * 1024 * 1024,
	maxRepoMB: 500,
	maxFiles: 20000,
	exclude: [],
	capture: { turn: true, end: true },
	prune: { enabled: true, maxAgeDays: 14, maxTotalMB: 1000 },
};

// Luôn loại khỏi snapshot (không cấu hình tắt được): .git của người dùng, secret, thư mục phụ thuộc.
const BUILTIN_EXCLUDE = [
	".git",
	".pi/",
	"node_modules/",
	".env",
	".env.*",
	"!.env.example",
	"!.env.sample",
	"!.env.template",
	".npmrc",
	".netrc",
	".pypirc",
	".git-credentials",
	"auth.json",
	"id_rsa*",
	"id_dsa*",
	"id_ecdsa*",
	"id_ed25519*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	".ssh/",
	".aws/",
	".gnupg/",
	".DS_Store",
	"__pycache__/",
	"*.pyc",
	".venv/",
	"venv/",
];

// Bộ lọc CỨNG trong code (không phụ thuộc .gitignore/info/exclude, vốn có thể bị negate bằng "!pattern"):
// một đường dẫn bị loại nếu BẤT KỲ thành phần nào của nó khớp. So khớp không phân biệt hoa/thường.
const SECRET_DIRS = new Set([".git", ".pi", "node_modules", ".ssh", ".aws", ".gnupg", ".venv", "venv", "__pycache__"]);
const ENV_OK = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_NAMES = new Set([".npmrc", ".netrc", ".pypirc", ".git-credentials", "auth.json", ".ds_store"]);
const SECRET_PREFIX = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials"];
const SECRET_SUFFIX = [".pem", ".key", ".p12", ".pfx", ".pyc"];

export function isExcludedPath(rel) {
	for (const raw of String(rel).split("/")) {
		const c = raw.toLowerCase();
		if (!c || c === ".") continue;
		if (SECRET_DIRS.has(c) || SECRET_NAMES.has(c)) return true;
		if ((c === ".env" || c.startsWith(".env.")) && !ENV_OK.has(c)) return true;
		if (SECRET_PREFIX.some((p) => c.startsWith(p)) || SECRET_SUFFIX.some((x) => c.endsWith(x))) return true;
	}
	return false;
}

export class SnapError extends Error {}

export function resolveAgentDir(explicit) {
	return resolveAgentDirShared(explicit, process.env, undefined, path.join(HERE, "..", "agent"));
}

export function loadConfig(agentDir) {
	let user = {};
	try {
		user = JSON.parse(fs.readFileSync(path.join(agentDir, "snapshot.json"), "utf8"));
	} catch {
		/* không có/hỏng -> mặc định */
	}
	const num = (v, d, min) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : d);
	return {
		enabled: user.enabled !== false,
		keep: Math.floor(num(user.keep, DEFAULTS.keep, 1)),
		maxFileBytes: num(user.maxFileBytes, DEFAULTS.maxFileBytes, 1),
		maxRepoMB: num(user.maxRepoMB, DEFAULTS.maxRepoMB, 1),
		maxFiles: Math.floor(num(user.maxFiles, DEFAULTS.maxFiles, 1)),
		exclude: Array.isArray(user.exclude) ? user.exclude.filter((x) => typeof x === "string") : [],
		capture: { ...DEFAULTS.capture, ...(user.capture && typeof user.capture === "object" ? user.capture : {}) },
		prune: (() => {
			const u = user.prune && typeof user.prune === "object" ? user.prune : {};
			return {
				enabled: u.enabled !== false,
				maxAgeDays: num(u.maxAgeDays, DEFAULTS.prune.maxAgeDays, Number.MIN_VALUE),
				maxTotalMB: num(u.maxTotalMB, DEFAULTS.prune.maxTotalMB, Number.MIN_VALUE),
			};
		})(),
	};
}

// ---------------- git helpers ----------------

/** Môi trường git sạch: bỏ mọi GIT_* của người gọi, không đọc cấu hình hệ thống/người dùng. */
function gitEnv(ctx, extra = {}) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
	return {
		...env,
		LC_ALL: "C",
		GIT_DIR: ctx.gitDir,
		GIT_WORK_TREE: ctx.cwd,
		GIT_INDEX_FILE: ctx.indexFile,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "coder-snapshot",
		GIT_AUTHOR_EMAIL: "snapshot@coder.local",
		GIT_COMMITTER_NAME: "coder-snapshot",
		GIT_COMMITTER_EMAIL: "snapshot@coder.local",
		...extra,
	};
}

// Vô hiệu các khóa nguy hiểm bằng dòng lệnh (ghi đè mọi cấu hình trong kho, kể cả tên không đoán trước được
// như filter.<tên>.*: những driver đó chỉ có tác dụng khi được định nghĩa trong config, mà config bị dựng lại).
const GIT_SAFE_C = [
	"core.quotepath=off",
	"core.fsmonitor=false",
	"core.hooksPath=/dev/null",
	"core.sshCommand=",
	"core.pager=cat",
	"core.editor=true",
	"core.attributesFile=/dev/null",
	"core.untrackedCache=false",
	"diff.external=",
	"protocol.allow=never",
	"commit.gpgsign=false",
	"gc.auto=0",
];
const gitArgs = (args) => ["--no-optional-locks", "--no-pager", ...GIT_SAFE_C.flatMap((c) => ["-c", c]), ...args];

const GIT_TIMEOUT_MS = 120_000;

function git(ctx, args, { input, env, allowFail } = {}) {
	// Config của kho nằm trong vùng sandbox ghi được: dựng lại ngay trước mỗi lần gọi (thu hẹp cửa sổ TOCTOU).
	refreshRepoConfig(ctx);
	return new Promise((resolve, reject) => {
		const p = spawn("git", gitArgs(args), {
			cwd: ctx.cwd,
			env: gitEnv(ctx, env),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out = [];
		const err = [];
		const killTimer = setTimeout(() => p.kill("SIGKILL"), GIT_TIMEOUT_MS);
		p.on("close", () => clearTimeout(killTimer));
		p.stdout.on("data", (d) => out.push(d));
		p.stderr.on("data", (d) => err.push(d));
		p.on("error", (e) => reject(new SnapError(`không chạy được git: ${e.message}`)));
		p.on("close", (code) => {
			const stdout = Buffer.concat(out).toString("utf8");
			const stderr = Buffer.concat(err).toString("utf8");
			if (code !== 0 && !allowFail) reject(new SnapError(`git ${args[0]} lỗi (${code}): ${stderr.trim() || stdout.trim()}`));
			else resolve({ stdout, stderr, code });
		});
		p.stdin.on("error", () => {});
		p.stdin.end(input ?? "");
	});
}

// ---------------- kho bóng là KHÔNG TIN CẬY ----------------
// <agent-dir>/snapshots/<key>/ nằm trong vùng sandbox ghi được, trong khi CLI chạy ngoài sandbox với quyền người vận hành.
// Mã trong sandbox có thể sửa config (filter/textconv/fsmonitor/...), hooks, info/attributes, alternates...
// Nên trước mỗi chuỗi thao tác phía host ta kiểm tra cấu trúc và DỰNG LẠI mọi tệp điều khiển hành vi git.

const CONFIG_BODY = [
	"[core]",
	"\trepositoryformatversion = 0",
	"\tfilemode = true",
	"\tbare = false",
	"\tsymlinks = true",
	"\tautocrlf = false",
	"\tfsmonitor = false",
	"\tlogallrefupdates = false",
	"[gc]",
	"\tauto = 0",
	"[user]",
	"\tname = coder-snapshot",
	"\temail = snapshot@coder.local",
	"",
].join("\n");

// Vô hiệu mọi thuộc tính của cây làm việc (filter/diff/text/eol/ident/working-tree-encoding): info/attributes
// có độ ưu tiên cao nhất, đè .gitattributes do kẻ tấn công kiểm soát (git 2.34 chưa có --attr-source).
const ATTRIBUTES_BODY = "* -filter -diff -merge -text -eol -ident -working-tree-encoding -export-ignore -export-subst\n";

// Tên được phép ở mức gốc kho (ngoài index.*, *.lock).
// Tên nội bộ trên đĩa giữ tiền tố `coder` cũ để tương thích với kho snapshot đã có trên máy người dùng; KHÔNG đổi tên.
const ROOT_ALLOWED = new Set(["HEAD", "config", "description", "hooks", "info", "objects", "refs", "packed-refs", "logs", "ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "coder-cwd", ".coder-snapshot-meta.json", "branches", "gc.pid", "gc.log"]);
// Tệp/thư mục nguy hiểm: xóa thay vì từ chối.
const ROOT_REMOVE = ["commondir", "gitdir", "shallow", "modules", "worktrees", "config.worktree", "hooks", "branches"];
const MAX_REPO_ENTRIES = 500_000;

/** Ghi tệp mới: gỡ bản cũ (symlink cũng bị gỡ, không bị đi theo) rồi tạo O_EXCL. */
function writeFresh(file, body, mode = 0o600) {
	fs.rmSync(file, { force: true, recursive: true });
	fs.writeFileSync(file, body, { flag: "wx", mode });
}

/** Dựng lại config + info/attributes (rẻ; gọi trước mỗi lệnh git). */
function refreshRepoConfig(ctx) {
	try {
		if (!fs.existsSync(ctx.gitDir)) return;
		fs.mkdirSync(path.join(ctx.gitDir, "info"), { recursive: true });
		writeFresh(path.join(ctx.gitDir, "config"), CONFIG_BODY);
		writeFresh(path.join(ctx.gitDir, "info", "attributes"), ATTRIBUTES_BODY);
	} catch (e) {
		throw new SnapError(`không dựng lại được cấu hình kho bóng: ${e.message}`);
	}
}

/**
 * Kiểm tra + chuẩn hóa kho bóng. Ném SnapError (kho hỏng/lạ) mà không chạy git. Mỗi ctx chỉ làm 1 lần.
 * @param {{ gitDir: string, indexFile: string, hostSide?: boolean, sanitized?: boolean }} ctx
 */
export function sanitizeRepo(ctx) {
	if (ctx.sanitized) return;
	const dir = ctx.gitDir;
	let st;
	try {
		st = fs.lstatSync(dir);
	} catch {
		return; // chưa có kho
	}
	if (st.isSymbolicLink() || !st.isDirectory()) throw new SnapError(`kho bóng hỏng: ${dir} không phải thư mục thật`);
	try {
		const ps = fs.lstatSync(path.dirname(dir));
		if (ps.isSymbolicLink() || !ps.isDirectory()) throw new SnapError(`kho bóng hỏng: ${path.dirname(dir)} không phải thư mục thật`);
	} catch (e) {
		if (e instanceof SnapError) throw e;
	}
	// 1. Tệp mức gốc: gỡ thứ nguy hiểm, từ chối thứ lạ.
	for (const name of ROOT_REMOVE) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ROOT_ALLOWED.has(e.name) || e.name.startsWith("index.") || e.name.endsWith(".lock") || /^\.coder-snapshot-meta\.json\.\d+\.tmp$/.test(e.name)) continue;
		throw new SnapError(`kho bóng hỏng: tệp lạ ở mức gốc (${e.name}) trong ${dir} — từ chối chạy git; xóa kho này để tạo lại`);
	}
	// 2. Toàn cây: không symlink, không tệp đặc biệt (FIFO/socket/thiết bị).
	let count = 0;
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (++count > MAX_REPO_ENTRIES) throw new SnapError(`kho bóng hỏng: quá nhiều mục trong ${dir}`);
			const p = path.join(d, e.name);
			if (e.isSymbolicLink()) throw new SnapError(`kho bóng hỏng: có symlink trong cấu trúc (${path.relative(dir, p)}) — từ chối chạy git; xóa kho này để tạo lại`);
			if (e.isDirectory()) stack.push(p);
			else if (!e.isFile()) throw new SnapError(`kho bóng hỏng: tệp đặc biệt trong cấu trúc (${path.relative(dir, p)})`);
		}
	}
	// 3. Chuẩn hóa: hooks rỗng, info/ chỉ gồm exclude + attributes, objects/info không có alternates, HEAD cố định.
	fs.mkdirSync(path.join(dir, "hooks"), { mode: 0o700 });
	const info = path.join(dir, "info");
	fs.mkdirSync(info, { recursive: true });
	for (const e of fs.readdirSync(info)) if (e !== "exclude") fs.rmSync(path.join(info, e), { force: true, recursive: true });
	const oinfo = path.join(dir, "objects", "info");
	try {
		for (const e of fs.readdirSync(oinfo)) fs.rmSync(path.join(oinfo, e), { force: true, recursive: true });
	} catch {
		/* chưa có */
	}
	if (fs.existsSync(path.join(dir, "HEAD"))) writeFresh(path.join(dir, "HEAD"), "ref: refs/heads/snapshot-unused\n");
	// Chỉ mục của CLI (phía host) nằm trong vùng ghi được: không tin, dựng lại từ đầu.
	if (ctx.hostSide && fs.existsSync(ctx.indexFile)) fs.rmSync(ctx.indexFile, { force: true, recursive: true });
	refreshRepoConfig(ctx);
	ctx.sanitized = true;
}

const sha = (s) => createHash("sha1").update(s).digest("hex");

/** Mở ngữ cảnh kho bóng cho cwd (chưa tạo kho). */
export function openContext({ cwd, agentDir, indexName = "index" }) {
	let real;
	try {
		real = fs.realpathSync(path.resolve(cwd));
	} catch {
		throw new SnapError(`thư mục không tồn tại: ${cwd}`);
	}
	const agent = resolveAgentDir(agentDir);
	const gitDir = path.join(agent, "snapshots", sha(real).slice(0, 16));
	const safeIdx = indexName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
	// hostSide: CLI chạy ngoài sandbox (indexName "cli"); chỉ mục của nó cũng nằm trong vùng ghi được nên bị dựng lại mỗi lần.
	return { cwd: real, agentDir: agent, gitDir, indexFile: path.join(gitDir, `index.${safeIdx}`), cfg: loadConfig(agent), hostSide: indexName === "cli" };
}

async function ensureRepo(ctx) {
	sanitizeRepo(ctx);
	if (!fs.existsSync(path.join(ctx.gitDir, "HEAD"))) {
		fs.mkdirSync(ctx.gitDir, { recursive: true, mode: 0o700 });
		await git(ctx, ["init", "--quiet", "--template="]);
		sanitizeRepo({ ...ctx, sanitized: false, hostSide: false }); // dựng lại config/hooks/HEAD sau init
		fs.writeFileSync(path.join(ctx.gitDir, "coder-cwd"), ctx.cwd + "\n", { mode: 0o600 });
	}
	// info/exclude: luật cứng + cấu hình + info/exclude của repo người dùng (nếu cwd là gốc repo).
	// Chỉ là tối ưu (giảm số ứng viên); ranh giới bảo mật thật là isExcludedPath() trong code.
	let userExclude = "";
	try {
		userExclude = fs.readFileSync(path.join(ctx.cwd, ".git", "info", "exclude"), "utf8");
	} catch {
		/* không có */
	}
	const body = [...BUILTIN_EXCLUDE, ...ctx.cfg.exclude, userExclude].join("\n") + "\n";
	fs.mkdirSync(path.join(ctx.gitDir, "info"), { recursive: true });
	writeFresh(path.join(ctx.gitDir, "info", "exclude"), body);
}

const hasSymlinkLeading = (ctx, rel) => {
	const parts = rel.split("/");
	let p = ctx.cwd;
	for (let i = 0; i < parts.length - 1; i++) {
		p = path.join(p, parts[i]);
		try {
			if (fs.lstatSync(p).isSymbolicLink()) return true;
		} catch {
			return false;
		}
	}
	return false;
};

/** Liệt kê + lọc ứng viên (đường dẫn tương đối) cần chụp. */
async function collectKeep(ctx) {
	const { stdout } = await git(ctx, ["ls-files", "-z", "-c", "-o", "--exclude-standard"]);
	const cand = stdout.split("\0").filter(Boolean);
	if (cand.length > ctx.cfg.maxFiles * 3) throw new SnapError(`quá nhiều file (${cand.length}) — thư mục này không hợp để chụp`);
	const keep = [];
	const seen = new Set();
	let skippedLarge = 0;
	for (const rel of cand) {
		if (rel.endsWith("/") || seen.has(rel)) continue; // repo con lồng nhau
		seen.add(rel);
		// Ranh giới bảo mật: bộ lọc cứng, bất chấp .gitignore có negate (!.env, !*.pem ...).
		if (isExcludedPath(rel)) continue;
		// Một thành phần cha là symlink (thư mục từng chụp bị thay bằng symlink): bỏ riêng file này.
		if (hasSymlinkLeading(ctx, rel)) continue;
		let st;
		try {
			st = fs.lstatSync(path.join(ctx.cwd, rel));
		} catch {
			continue; // đã xóa
		}
		if (st.isSymbolicLink()) {
			keep.push(rel);
			continue;
		}
		if (!st.isFile()) continue;
		if (st.size > ctx.cfg.maxFileBytes) {
			skippedLarge++;
			continue;
		}
		keep.push(rel);
	}
	if (keep.length > ctx.cfg.maxFiles) throw new SnapError(`quá nhiều file (${keep.length} > maxFiles=${ctx.cfg.maxFiles})`);
	return { keep, skippedLarge };
}

async function applyIndex(ctx, keep) {
	const keepSet = new Set(keep);
	const { stdout: tracked } = await git(ctx, ["ls-files", "-z"]);
	const drop = tracked.split("\0").filter((p) => p && !keepSet.has(p));
	if (drop.length) await git(ctx, ["update-index", "--force-remove", "-z", "--stdin"], { input: drop.join("\0") + "\0" });
	if (keep.length) {
		const input = keep.join("\0") + "\0";
		const run = () => git(ctx, ["update-index", "--add", "--replace", "-z", "--stdin"], { input });
		try {
			await run();
		} catch {
			await run(); // file có thể biến mất giữa chừng: thử lại một lần với trạng thái mới
		}
	}
}

/** Dựng index từ đầu, thêm từng file một; file lỗi riêng lẻ bị bỏ qua (không làm hỏng cả snapshot). */
async function rebuildIndexPerFile(ctx, keep) {
	fs.rmSync(ctx.indexFile, { force: true });
	const ok = [];
	for (const rel of keep) {
		try {
			await git(ctx, ["update-index", "--add", "--replace", "-z", "--stdin"], { input: rel + "\0" });
			ok.push(rel);
		} catch {
			/* bỏ qua file này */
		}
	}
	return ok;
}

/** Cập nhật index kho bóng theo trạng thái thư mục hiện tại; trả về { tree, files }. */
async function stageWorktree(ctx) {
	await ensureRepo(ctx);
	let { keep, skippedLarge } = await collectKeep(ctx);
	try {
		await applyIndex(ctx, keep);
	} catch {
		// Tự phục hồi (vd. "beyond a symbolic link" vì index cũ giữ mục dưới thư mục đã thành symlink):
		// xóa index hỏng, dựng lại; nếu vẫn lỗi thì thêm từng file và bỏ file lỗi.
		fs.rmSync(ctx.indexFile, { force: true });
		try {
			await applyIndex(ctx, keep);
		} catch {
			keep = await rebuildIndexPerFile(ctx, keep);
		}
	}
	const { stdout: tree } = await git(ctx, ["write-tree"]);
	return { tree: tree.trim(), files: keep.length, skippedLarge };
}

// ---------------- marker "lần dùng gần nhất" ----------------

// Tên nội bộ trên đĩa giữ tiền tố `coder` cũ để tương thích với kho snapshot đã có trên máy người dùng; KHÔNG đổi tên.
export const META_FILE = ".coder-snapshot-meta.json";

/** Ghi/chạm marker trong kho: { cwd, lastUsedAt }. Lỗi bị nuốt (không được làm hỏng việc chụp). */
function touchMarker(ctx) {
	try {
		const f = path.join(ctx.gitDir, META_FILE);
		const tmp = `${f}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ v: 1, cwd: ctx.cwd, lastUsedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, f);
	} catch {
		/* bỏ qua */
	}
}

// ---------------- dọn kho của thư mục làm việc cũ ----------------

const REPO_KEY_RE = /^[0-9a-f]{16}$/;

/** Tổng dung lượng (byte) của cây thư mục, KHÔNG đi theo symlink (lstat). */
async function treeBytes(dir) {
	let total = 0;
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		let ents;
		try {
			ents = await fsp.readdir(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) stack.push(p);
			else {
				try {
					total += (await fsp.lstat(p)).size;
				} catch {
					/* bỏ qua */
				}
			}
		}
	}
	return total;
}

function assertSafeAgentDir(agentDir) {
	if (typeof agentDir !== "string" || agentDir.trim() === "") throw new SnapError("agentDir rỗng — từ chối dọn");
	if (!path.isAbsolute(agentDir)) throw new SnapError(`agentDir phải là đường dẫn tuyệt đối: ${agentDir}`);
	const norm = path.resolve(agentDir);
	const bad = new Set([path.parse(norm).root, path.resolve(os.homedir())]);
	if (process.env.HOME) bad.add(path.resolve(process.env.HOME));
	if (bad.has(norm)) throw new SnapError(`agentDir nguy hiểm (${norm}) — từ chối dọn`);
	return norm;
}

/**
 * Dọn các kho bóng cũ trong <agentDir>/snapshots/. AN TOÀN: chỉ xóa thư mục con TRỰC TIẾP có tên ^[0-9a-f]{16}$,
 * không phải symlink, realpath nằm đúng trong snapshots/. Kho trong protectKeys (tên thư mục) không bao giờ bị xóa.
 * (a) lần dùng gần nhất > maxAgeDays ngày; (b) tổng > maxTotalMB: xóa kho cũ nhất trước tới khi dưới ngưỡng.
 * "Lần dùng": marker .coder-snapshot-meta.json (lastUsedAt); không có thì mtime của thư mục kho.
 */
export async function pruneRepos({ agentDir, maxAgeDays = 14, maxTotalMB = 1000, dryRun = false, protectKeys = [] } = {}) {
	const agent = assertSafeAgentDir(agentDir);
	const days = typeof maxAgeDays === "number" && Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULTS.prune.maxAgeDays;
	const maxMB = typeof maxTotalMB === "number" && Number.isFinite(maxTotalMB) && maxTotalMB > 0 ? maxTotalMB : DEFAULTS.prune.maxTotalMB;
	const protect = new Set((protectKeys ?? []).filter((k) => typeof k === "string"));
	const snapsDir = path.join(agent, "snapshots");
	const result = { agentDir: agent, snapshotsDir: snapsDir, dryRun: !!dryRun, maxAgeDays: days, maxTotalMB: maxMB, scanned: 0, removed: [], kept: 0, totalBeforeBytes: 0, totalAfterBytes: 0, freedBytes: 0, errors: [] };

	let st;
	try {
		st = await fsp.lstat(snapsDir);
	} catch {
		return result; // chưa có kho nào
	}
	if (!st.isDirectory() || st.isSymbolicLink()) throw new SnapError(`${snapsDir} không phải thư mục thật (symlink?) — từ chối dọn`);
	const realSnaps = await fsp.realpath(snapsDir);

	const repos = [];
	for (const e of await fsp.readdir(snapsDir, { withFileTypes: true })) {
		if (!REPO_KEY_RE.test(e.name) || !e.isDirectory() || e.isSymbolicLink()) continue;
		const p = path.join(snapsDir, e.name);
		let real;
		let lst;
		try {
			lst = await fsp.lstat(p);
			real = await fsp.realpath(p);
		} catch {
			continue;
		}
		if (lst.isSymbolicLink() || !lst.isDirectory() || real !== path.join(realSnaps, e.name)) continue;
		let lastUsed = lst.mtimeMs;
		let cwd = null;
		try {
			const m = JSON.parse(await fsp.readFile(path.join(real, META_FILE), "utf8"));
			const t = Date.parse(m.lastUsedAt);
			if (Number.isFinite(t)) lastUsed = t;
			if (typeof m.cwd === "string") cwd = m.cwd;
		} catch {
			/* chưa có marker: dùng mtime */
		}
		repos.push({ key: e.name, real, cwd, lastUsed, sizeBytes: await treeBytes(real), protected: protect.has(e.name) });
	}
	result.scanned = repos.length;
	result.totalBeforeBytes = repos.reduce((a, r) => a + r.sizeBytes, 0);

	const now = Date.now();
	const doomed = new Map(); // key -> reason
	for (const r of repos) if (!r.protected && now - r.lastUsed > days * 86400_000) doomed.set(r.key, `quá ${days} ngày không dùng`);
	let total = repos.reduce((a, r) => (doomed.has(r.key) ? a : a + r.sizeBytes), 0);
	const limit = maxMB * 1048576;
	if (total > limit) {
		const rest = repos.filter((r) => !doomed.has(r.key) && !r.protected).sort((a, b) => a.lastUsed - b.lastUsed);
		for (const r of rest) {
			if (total <= limit) break;
			doomed.set(r.key, `tổng dung lượng vượt ${maxMB}MB`);
			total -= r.sizeBytes;
		}
	}

	for (const r of repos) {
		const reason = doomed.get(r.key);
		if (!reason) continue;
		const row = { key: r.key, cwd: r.cwd, lastUsedAt: new Date(r.lastUsed).toISOString(), sizeBytes: r.sizeBytes, reason };
		if (!dryRun) {
			try {
				// kiểm tra lại ngay trước khi xóa: vẫn là thư mục thật, không symlink, đúng vị trí
				const lst = await fsp.lstat(path.join(snapsDir, r.key));
				if (lst.isSymbolicLink() || !lst.isDirectory()) throw new SnapError("không còn là thư mục thật");
				if ((await fsp.realpath(path.join(snapsDir, r.key))) !== r.real || path.dirname(r.real) !== realSnaps) throw new SnapError("realpath ngoài snapshots/");
				await fsp.rm(r.real, { recursive: true, force: true });
			} catch (e) {
				result.errors.push({ key: r.key, error: e.message });
				continue;
			}
		}
		result.removed.push(row);
		result.freedBytes += r.sizeBytes;
	}
	result.kept = repos.length - result.removed.length;
	result.totalAfterBytes = result.totalBeforeBytes - result.freedBytes;
	return result;
}

/** Gọi pruneRepos tối đa 1 lần/minIntervalMs nhờ file khóa thời gian (mtime). Không ném lỗi; trả null nếu bỏ qua. */
export async function maybePruneRepos({ agentDir, protectKeys, minIntervalMs = 3600_000 } = {}) {
	try {
		const agent = assertSafeAgentDir(agentDir);
		const cfg = loadConfig(agent);
		if (!cfg.prune.enabled) return null;
		const snapsDir = path.join(agent, "snapshots");
		const lock = path.join(snapsDir, ".prune-last");
		try {
			if (Date.now() - fs.statSync(lock).mtimeMs < minIntervalMs) return null;
		} catch {
			/* chưa có khóa */
		}
		fs.mkdirSync(snapsDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(lock, new Date().toISOString() + "\n");
		return await pruneRepos({ agentDir: agent, maxAgeDays: cfg.prune.maxAgeDays, maxTotalMB: cfg.prune.maxTotalMB, protectKeys });
	} catch {
		return null;
	}
}

// ---------------- snapshot store ----------------

const REF_PREFIX = "refs/snap/";

export async function listSnapshots(ctx, { session, limit } = {}) {
	sanitizeRepo(ctx);
	if (!fs.existsSync(path.join(ctx.gitDir, "HEAD"))) return [];
	const { stdout } = await git(ctx, [
		"for-each-ref",
		"--sort=-refname",
		"--format=%(refname)%00%(objectname)%00%(tree)%00%(contents:subject)",
		REF_PREFIX,
	]);
	const rows = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [ref, commit, tree, subject] = line.split("\0");
		let meta = {};
		try {
			meta = JSON.parse(subject);
		} catch {
			/* bỏ qua */
		}
		const ms = Number(ref.slice(REF_PREFIX.length).split("-")[0]);
		rows.push({
			id: commit.slice(0, 12),
			time: new Date(ms).toISOString(),
			ms,
			session: meta.session ?? null,
			turn: meta.turn ?? null,
			kind: meta.kind ?? "unknown",
			label: meta.label ?? null,
			files: meta.files ?? null,
			revertOf: meta.revertOf ?? null,
			tree,
			commit,
			ref,
		});
	}
	const out = session ? rows.filter((r) => r.session === session) : rows;
	return limit ? out.slice(0, limit) : out;
}

async function resolveSnapshot(ctx, id) {
	const all = await listSnapshots(ctx);
	if (id === "latest") {
		if (!all.length) throw new SnapError("chưa có snapshot nào cho thư mục này");
		return all[0];
	}
	if (id === "first") {
		if (!all.length) throw new SnapError("chưa có snapshot nào cho thư mục này");
		return all[all.length - 1];
	}
	const m = all.filter((s) => id && (s.commit.startsWith(id) || s.id === id));
	if (m.length === 0) throw new SnapError(`không tìm thấy snapshot '${id}' (dùng 'list' để xem)`);
	if (m.length > 1) throw new SnapError(`'${id}' không rõ ràng (${m.length} snapshot khớp)`);
	return m[0];
}

async function dirSizeMB(dir) {
	let total = 0;
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else {
				try {
					total += fs.statSync(p).size;
				} catch {
					/* bỏ qua */
				}
			}
		}
	};
	try {
		walk(dir);
	} catch {
		/* bỏ qua */
	}
	return total / 1048576;
}

async function prune(ctx) {
	let all = await listSnapshots(ctx);
	let removed = 0;
	const del = async (rows) => {
		for (const r of rows) {
			await git(ctx, ["update-ref", "-d", r.ref], { allowFail: true });
			removed++;
		}
	};
	if (all.length > ctx.cfg.keep) await del(all.slice(ctx.cfg.keep));
	if (removed) await gc(ctx);
	// giới hạn dung lượng: bỏ dần snapshot cũ nhất (giữ tối thiểu 2)
	for (let guard = 0; guard < 20; guard++) {
		if ((await dirSizeMB(ctx.gitDir)) <= ctx.cfg.maxRepoMB) break;
		all = await listSnapshots(ctx);
		if (all.length <= 2) break;
		await del(all.slice(Math.max(2, Math.ceil(all.length / 2))));
		await gc(ctx);
	}
	cleanStaleIndexes(ctx);
	return removed;
}

async function gc(ctx) {
	await git(ctx, ["reflog", "expire", "--expire=now", "--all"], { allowFail: true });
	await git(ctx, ["gc", "--prune=now", "--quiet"], { allowFail: true });
}

function cleanStaleIndexes(ctx) {
	try {
		for (const f of fs.readdirSync(ctx.gitDir)) {
			if (!f.startsWith("index.") || f === path.basename(ctx.indexFile)) continue;
			const p = path.join(ctx.gitDir, f);
			if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400_000) fs.rmSync(p, { force: true });
		}
	} catch {
		/* bỏ qua */
	}
}

/**
 * Chụp snapshot trạng thái hiện tại của cwd.
 * meta: { session, turn, kind, label, revertOf }. Nếu cây giống hệt snapshot mới nhất CÙNG session & kind thì dùng lại.
 */
export async function takeSnapshot(ctx, meta = {}) {
	if (!ctx.cfg.enabled && !meta.force) throw new SnapError("snapshot bị tắt (snapshot.json: enabled=false)");
	const { tree, files, skippedLarge } = await stageWorktree(ctx);
	touchMarker(ctx);
	const prev = (await listSnapshots(ctx, { limit: 1 }))[0];
	if (prev && prev.tree === tree && prev.session === (meta.session ?? null) && !meta.force) {
		return { id: prev.id, tree, files, reused: true, skippedLarge };
	}
	const body = { v: 1, session: meta.session ?? null, turn: meta.turn ?? null, kind: meta.kind ?? "manual", label: meta.label ?? null, revertOf: meta.revertOf ?? null, files };
	const { stdout: commit } = await git(ctx, ["commit-tree", tree, "-m", JSON.stringify(body)]);
	const c = commit.trim();
	const ms = String(Date.now()).padStart(13, "0");
	await git(ctx, ["update-ref", `${REF_PREFIX}${ms}-${c.slice(0, 12)}`, c]);
	await prune(ctx);
	return { id: c.slice(0, 12), tree, files, reused: false, skippedLarge };
}

// ---------------- diff / revert ----------------

function parseNameStatus(out) {
	const parts = out.split("\0").filter((x) => x !== "");
	const rows = [];
	for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i][0], path: parts[i + 1] });
	return rows;
}

const STATUS_WORD = { A: "added", D: "deleted", M: "modified", T: "typechange" };

/** So sánh snapshot `from` với `to` (snapshot khác) hoặc với trạng thái hiện tại. */
export async function diffSnapshots(ctx, fromId, toId, { patch = false, maxPatchBytes = 200_000 } = {}) {
	const from = await resolveSnapshot(ctx, fromId);
	let toTree;
	let toLabel = "current";
	if (toId) {
		const t = await resolveSnapshot(ctx, toId);
		toTree = t.tree;
		toLabel = t.id;
	} else toTree = (await stageWorktree(ctx)).tree;
	const { stdout } = await git(ctx, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", from.tree, toTree]);
	const rows = parseNameStatus(stdout).filter((r) => !isExcludedPath(r.path)).map((r) => ({ path: r.path, status: STATUS_WORD[r.status] ?? r.status }));
	const { stdout: num } = await git(ctx, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", from.tree, toTree]);
	// numstat -z: "add\tdel\tpath\0"
	const stats = new Map();
	for (const rec of num.split("\0")) {
		const m = /^(\S+)\t(\S+)\t(.*)$/s.exec(rec);
		if (m) stats.set(m[3], { additions: m[1] === "-" ? null : Number(m[1]), deletions: m[2] === "-" ? null : Number(m[2]) });
	}
	for (const r of rows) Object.assign(r, stats.get(r.path) ?? {});
	const res = { from: from.id, to: toLabel, files: rows };
	if (patch) {
		let { stdout: p } = await git(ctx, ["diff-tree", "-r", "-p", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", from.tree, toTree]);
		const blocks = p.split(/^(?=diff --git )/m).filter((blk) => {
			const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(blk);
			return !m || !isExcludedPath(m[2]);
		});
		p = blocks.join("");
		res.patch = p.length > maxPatchBytes ? p.slice(0, maxPatchBytes) + "\n... [cắt bớt]\n" : p;
		res.patchTruncated = p.length > maxPatchBytes;
	}
	return res;
}

function matchesPaths(file, filters) {
	if (!filters || !filters.length) return true;
	return filters.some((f) => file === f || file.startsWith(f.endsWith("/") ? f : f + "/"));
}

function normFilters(ctx, paths) {
	return (paths ?? []).map((p) => {
		const abs = path.resolve(ctx.cwd, p);
		const rel = path.relative(ctx.cwd, abs).split(path.sep).join("/");
		if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SnapError(`đường dẫn ngoài thư mục làm việc: ${p}`);
		return rel === "" ? "" : rel;
	}).map((r) => (r === "" ? "." : r));
}

/** Các mục (không phải thư mục) bên trong `abs` mà KHÔNG thuộc `curSet` (tập đường dẫn của cây đã chụp). Không đi theo symlink. */
function foreignEntries(abs, rel, curSet) {
	const bad = [];
	const stack = [[abs, rel]];
	while (stack.length) {
		const [d, r] = stack.pop();
		let ents;
		try {
			ents = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			bad.push(r);
			continue;
		}
		for (const e of ents) {
			const er = `${r}/${e.name}`;
			if (e.isDirectory()) stack.push([path.join(d, e.name), er]);
			else if (isExcludedPath(er) || !curSet.has(er)) bad.push(er);
		}
	}
	return bad;
}

/**
 * Khôi phục cwd về trạng thái snapshot. Trả về kế hoạch + kết quả.
 * Trước khi sửa gì, chụp snapshot "pre-revert" (trừ khi dryRun) để revert được cả việc revert.
 */
export async function revertTo(ctx, id, { paths, dryRun = false, session } = {}) {
	const target = await resolveSnapshot(ctx, id);
	const filters = normFilters(ctx, paths);
	const useAll = filters.includes(".");
	const cur = await stageWorktree(ctx);
	const { stdout } = await git(ctx, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", target.tree, cur.tree]);
	// File thuộc diện loại trừ cứng (secret...) không bao giờ bị khôi phục/xóa, kể cả khi snapshot cũ có chứa chúng.
	const changes = parseNameStatus(stdout).filter((r) => !isExcludedPath(r.path) && (useAll || matchesPaths(r.path, filters)));
	const toDelete = changes.filter((r) => r.status === "A").map((r) => r.path);
	const toRestore = changes.filter((r) => r.status !== "A").map((r) => r.path);
	const plan = {
		target: target.id,
		delete: toDelete,
		restore: toRestore.map((p) => ({ path: p, change: STATUS_WORD[changes.find((c) => c.path === p).status] })),
	};
	if (dryRun) return { dryRun: true, ...plan, preRevertSnapshot: null, errors: [] };
	if (changes.length === 0) return { dryRun: false, ...plan, preRevertSnapshot: null, errors: [], note: "không có gì để hoàn tác" };

	const pre = await takeSnapshot(ctx, { session, kind: "pre-revert", label: `trước khi revert về ${target.id}`, revertOf: target.id, force: true });
	const errors = [];
	const deleted = [];
	for (const rel of toDelete) {
		if (hasSymlinkLeading(ctx, rel)) {
			errors.push({ path: rel, error: "thành phần thư mục là symlink, bỏ qua" });
			continue;
		}
		try {
			fs.unlinkSync(path.join(ctx.cwd, rel));
			deleted.push(rel);
			// dọn thư mục cha rỗng (không ra khỏi cwd)
			let d = path.dirname(path.join(ctx.cwd, rel));
			while (d !== ctx.cwd && d.startsWith(ctx.cwd + path.sep)) {
				try {
					fs.rmdirSync(d);
				} catch {
					break;
				}
				d = path.dirname(d);
			}
		} catch (e) {
			if (e.code !== "ENOENT") errors.push({ path: rel, error: e.message });
		}
	}
	const restoreList = [];
	for (const rel of toRestore) {
		if (hasSymlinkLeading(ctx, rel)) errors.push({ path: rel, error: "thành phần thư mục là symlink, bỏ qua" });
		else restoreList.push(rel);
	}
	let restored = restoreList;
	if (restoreList.length) {
		const tmpIdx = path.join(ctx.gitDir, `index.revert-${process.pid}`);
		const rctx = { ...ctx, indexFile: tmpIdx };
		try {
			await git(rctx, ["read-tree", target.tree]);
			// file đang là thư mục cản đường: chỉ xóa nếu MỌI mục bên trong đều thuộc snapshot (cây hiện tại đã chụp vào
			// pre-revert). Còn file loại trừ/ngoài snapshot (vd. build/.env) thì KHÔNG xóa, bỏ qua mục này và báo lỗi.
			let curSet;
			const blocked = new Set();
			for (const rel of restoreList) {
				const abs = path.join(ctx.cwd, rel);
				let st;
				try {
					st = fs.lstatSync(abs);
				} catch {
					continue; // chưa có
				}
				if (!st.isDirectory()) continue;
				if (!curSet) {
					const { stdout: lt } = await git(rctx, ["ls-tree", "-r", "-z", "--name-only", cur.tree]);
					curSet = new Set(lt.split("\0").filter(Boolean));
				}
				const foreign = foreignEntries(abs, rel, curSet);
				if (foreign.length) {
					blocked.add(rel);
					errors.push({ path: rel, error: `là thư mục còn chứa file ngoài snapshot/loại trừ (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", ..." : ""}); không xóa, bỏ qua` });
				} else fs.rmSync(abs, { recursive: true, force: true });
			}
			const finalList = restoreList.filter((r) => !blocked.has(r));
			restored = finalList;
			if (finalList.length) await git(rctx, ["checkout-index", "-f", "-z", "--stdin"], { input: finalList.join("\0") + "\0" });
		} catch (e) {
			errors.push({ path: "*", error: e.message });
		} finally {
			fs.rmSync(tmpIdx, { force: true });
		}
	}
	return { dryRun: false, ...plan, deleted, restored, preRevertSnapshot: pre.id, errors };
}

// ---------------- CLI ----------------

function parseArgs(argv) {
	const flags = {};
	const pos = [];
	const valued = new Set(["session", "dir", "agent-dir", "paths", "limit", "label", "days", "max-mb"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split(/=(.*)/s, 2);
			if (valued.has(k)) flags[k] = v ?? argv[++i];
			else flags[k] = true;
		} else pos.push(a);
	}
	return { flags, pos };
}

const USAGE = `snapshot-cli <lệnh> [tuỳ chọn]
  list   [--session ID] [--limit N]   liệt kê snapshot (mới nhất trước)
  diff   <snapshot> [<snapshot2>] [--patch]   khác biệt snapshot với hiện tại (hoặc với snapshot2)
  revert <snapshot> [--paths a,b] [--dry-run]  khôi phục về snapshot (tự chụp snapshot "pre-revert")
  take   [--label TXT] [--session ID]  chụp thủ công
  prune  [--days N] [--max-mb M] [--dry-run]  xóa kho của thư mục làm việc cũ (mặc định theo snapshot.json: 14 ngày, 1000MB; không đụng kho của --dir/cwd)
Chung: --dir CWD (mặc định cwd hiện tại), --agent-dir DIR (mặc định $MTH_AGENT_DIR), --json
<snapshot> là id (12 ký tự) hoặc 'latest' / 'first'.`;

export async function main(argv) {
	const { flags, pos } = parseArgs(argv);
	const json = !!flags.json;
	const cmd = pos[0];
	const out = (obj, text) => console.log(json ? JSON.stringify(obj, null, 2) : text);
	try {
		if (!cmd || cmd === "help" || flags.help) {
			console.log(USAGE);
			return cmd ? 0 : 2;
		}
		if (cmd === "auto-prune") {
			// Dành cho launcher: im lặng, tối đa 1 lần/giờ (khóa), không bao giờ làm hỏng lệnh gọi.
			const agent = resolveAgentDir(flags["agent-dir"]);
			let protectKeys = [];
			try {
				protectKeys = [path.basename(openContext({ cwd: flags.dir || process.cwd(), agentDir: agent }).gitDir)];
			} catch {
				/* cwd không tồn tại */
			}
			await maybePruneRepos({ agentDir: agent, protectKeys });
			return 0;
		}
		if (cmd === "prune") {
			const agent = resolveAgentDir(flags["agent-dir"]);
			const cfg = loadConfig(agent).prune;
			const numFlag = (name, d) => {
				if (flags[name] === undefined) return d;
				const n = Number(flags[name]);
				if (!Number.isFinite(n) || n <= 0) throw new SnapError(`--${name} phải là số > 0`);
				return n;
			};
			let protectKeys = [];
			try {
				protectKeys = [path.basename(openContext({ cwd: flags.dir || process.cwd(), agentDir: agent }).gitDir)];
			} catch {
				/* cwd không tồn tại: không có gì để bảo vệ */
			}
			const r = await pruneRepos({ agentDir: agent, maxAgeDays: numFlag("days", cfg.maxAgeDays), maxTotalMB: numFlag("max-mb", cfg.maxTotalMB), dryRun: !!flags["dry-run"], protectKeys });
			const mb = (b) => (b / 1048576).toFixed(1) + "MB";
			const lines = [
				`${r.dryRun ? "[dry-run] sẽ xóa" : "đã xóa"} ${r.removed.length}/${r.scanned} kho (ngưỡng: ${r.maxAgeDays} ngày, ${r.maxTotalMB}MB)`,
				...r.removed.map((x) => `${x.key}  ${mb(x.sizeBytes).padStart(9)}  dùng lần cuối ${x.lastUsedAt}  ${x.cwd ?? "(không rõ cwd)"}  [${x.reason}]`),
				...r.errors.map((e) => `LỖI ${e.key}: ${e.error}`),
				`${r.dryRun ? "sẽ giải phóng" : "đã giải phóng"} ${mb(r.freedBytes)}; tổng ${mb(r.totalBeforeBytes)} -> ${mb(r.totalAfterBytes)}`,
			];
			out({ ok: !r.errors.length, ...r }, lines.join("\n"));
			return r.errors.length ? 1 : 0;
		}
		const ctx = openContext({ cwd: flags.dir || process.cwd(), agentDir: flags["agent-dir"], indexName: "cli" });
		if (cmd === "list") {
			const rows = await listSnapshots(ctx, { session: flags.session, limit: flags.limit ? Number(flags.limit) : undefined });
			const clean = rows.map(({ ms, ref, commit, ...r }) => r);
			out({ ok: true, cwd: ctx.cwd, snapshots: clean }, clean.length ? clean.map((r) => `${r.id}  ${r.time}  ${r.kind.padEnd(10)} session=${r.session ?? "-"} turn=${r.turn ?? "-"} files=${r.files ?? "?"}${r.label ? "  " + r.label : ""}`).join("\n") : "(chưa có snapshot)");
		} else if (cmd === "diff") {
			if (!pos[1]) throw new SnapError("thiếu <snapshot>");
			const d = await diffSnapshots(ctx, pos[1], pos[2], { patch: !!flags.patch });
			out({ ok: true, ...d }, [`${d.from} -> ${d.to}: ${d.files.length} file`, ...d.files.map((f) => `${f.status.padEnd(10)} ${f.path}  (+${f.additions ?? "?"} -${f.deletions ?? "?"})`), d.patch ?? ""].join("\n"));
		} else if (cmd === "revert") {
			if (!pos[1]) throw new SnapError("thiếu <snapshot>");
			const paths = flags.paths ? String(flags.paths).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
			const r = await revertTo(ctx, pos[1], { paths, dryRun: !!flags["dry-run"], session: flags.session });
			const lines = [
				r.dryRun ? `[dry-run] revert về ${r.target}` : `đã revert về ${r.target}`,
				...r.delete.map((p) => `xóa      ${p}`),
				...r.restore.map((p) => `khôi phục ${p.path} (${p.change})`),
				...(r.errors ?? []).map((e) => `LỖI ${e.path}: ${e.error}`),
				r.preRevertSnapshot ? `snapshot trước khi revert: ${r.preRevertSnapshot} (revert ${r.preRevertSnapshot} để hoàn tác)` : r.note ?? "",
			];
			out({ ok: !(r.errors && r.errors.length), ...r }, lines.join("\n"));
			return r.errors && r.errors.length ? 1 : 0;
		} else if (cmd === "take") {
			const r = await takeSnapshot(ctx, { session: flags.session, kind: "manual", label: flags.label, force: true });
			out({ ok: true, ...r }, `snapshot ${r.id} (${r.files} file)`);
		} else {
			throw new SnapError(`lệnh không hợp lệ: ${cmd}\n${USAGE}`);
		}
		return 0;
	} catch (e) {
		if (json) console.log(JSON.stringify({ ok: false, error: e.message }));
		else console.error(`snapshot-cli: ${e.message}`);
		return 1;
	}
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then((c) => process.exit(c));
}
