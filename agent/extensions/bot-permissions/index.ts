/**
 * bot-permissions — hệ thống quyền KHÔNG cần người cho bot (thay hộp thoại xin quyền của opencode).
 *
 * Chính sách: <agent-dir>/permissions.json (xem file mẫu). Thứ tự quyết định cho mỗi tool call:
 *   1. Luật CỨNG (không cấu hình được): path jail, .env/.git/credential, sudo, rm -r rộng, curl|sh, dump env...
 *   2. `deny` trong policy  (deny luôn thắng allow)
 *   3. mode allowlist: phải khớp `allow`; mode denylist: mọi thứ không bị deny đều được
 * Chặn trả {block:true, reason} để model tự điều chỉnh. Mọi quyết định ghi JSONL ở <agent-dir>/audit.log
 * (đã che secret). Policy lỗi/không đọc được => chặn hết (fail-closed). Không bao giờ hỏi người.
 *
 * LƯU Ý: đây là lớp kiểm soát ở tầng tool, KHÔNG phải sandbox. Chương trình được phép chạy (node, python...)
 * vẫn có thể làm điều bất kỳ; muốn an toàn thật phải chạy trong container/user riêng.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mthEnv } from "../../../lib/env.mjs";
import {
	audit,
	detectSandbox,
	isInside,
	isSecretName,
	loadPolicy,
	matchCommand,
	matchPathPattern,
	type Policy,
	protectedRead,
	protectedWrite,
	realish,
	type Resolved,
	resolvePath,
	scrub,
	SECRET_DIRS,
} from "./policy.ts";
import { type Fail, HARD_BLOCKED_CMDS, knownCommand, parseShell, type Segment, vetCommand, type VetCtx } from "./shell.ts";
import { grantKey, type PermRequest, readRequest, requestId, saveRequest, setRequestStatus, takeGrant } from "./grants.ts";

/** `ask` có mặt => không chặn cứng mà cần duyệt (chỉ phát sinh sau luật cứng và deny). */
type Decision = { ok: true } | { ok: false; rule: string; reason: string; ask?: { pattern: string } };
const OK: Decision = { ok: true };
const no = (rule: string, reason: string): Decision => ({ ok: false, rule, reason });
const askD = (rule: string, reason: string, pattern: string): Decision => ({ ok: false, rule, reason, ask: { pattern } });
const isAsk = (d: Decision) => !d.ok && !!d.ask;

interface Env {
	policy: Policy;
	agentDir: string;
	root: string; // realpath của gốc jail
	cwd: string;
	sandboxed: boolean; // detectSandbox(): đang chạy trong mth-sandbox (bwrap)
}

// ---------- kiểm tra đường dẫn ----------

function pathAllowedByRules(kind: "read" | "write", r: Resolved, env: Env): Decision {
	const rules = env.policy[kind];
	if (rules.deny.some((p) => matchPathPattern(p, r.lex, r.real, env.root)))
		return no(`${kind}.deny`, `${kind} '${r.lex}' bị chặn bởi quy tắc deny trong permissions.json`);
	const askPat = rules.ask.find((p) => matchPathPattern(p, r.lex, r.real, env.root));
	if (askPat) return askD(`${kind}.ask`, `${kind} '${r.lex}' cần duyệt (khớp ${kind}.ask '${askPat}')`, askPat);
	if (env.policy.mode === "allowlist" && !rules.allow.some((p) => matchPathPattern(p, r.lex, r.real, env.root, true)))
		return no(
			`${kind}.allow`,
			`${kind} '${r.lex}' không nằm trong allowlist ${kind}.allow (chỉ được ${kind} trong thư mục làm việc ${env.root} nếu được allow)`,
		);
	return OK;
}

function checkRead(p: string, cwd: string, env: Env): Decision {
	const r = resolvePath(p, cwd);
	const prot = protectedRead(r, env.agentDir);
	if (prot) return no("protected-read", `Không được đọc ${r.lex}: ${prot}`);
	// Skill do chính harness cung cấp: cho phép ĐỌC (không ghi) để model nạp được SKILL.md và tài liệu kèm theo.
	const skillsDir = path.join(env.agentDir, "skills");
	if (isInside(r.lex, skillsDir) && isInside(r.real, skillsDir)) return OK;
	return pathAllowedByRules("read", r, env);
}

function checkWrite(p: string, cwd: string, env: Env, requireAllow: boolean): Decision {
	const r = resolvePath(p, cwd);
	const prot = protectedWrite(r, env.agentDir);
	if (prot) return no("protected-write", `Không được ghi ${r.lex}: ${prot}`);
	if (!isInside(r.real, env.root))
		return no(
			"path-jail",
			`Không được ghi ngoài thư mục làm việc (${env.root}): '${p}' -> ${r.real}. Dùng đường dẫn bên trong thư mục làm việc (không dùng ../ hay symlink ra ngoài).`,
		);
	if (requireAllow) return pathAllowedByRules("write", r, env);
	if (env.policy.write.deny.some((q) => matchPathPattern(q, r.lex, r.real, env.root)))
		return no("write.deny", `ghi '${r.lex}' bị chặn bởi quy tắc write.deny`);
	const askPat = env.policy.write.ask.find((q) => matchPathPattern(q, r.lex, r.real, env.root));
	if (askPat) return askD("write.ask", `ghi '${r.lex}' cần duyệt (khớp write.ask '${askPat}')`, askPat);
	return OK;
}

// ---------- phân tích bash ----------

const READ_CMDS = new Set([
	"cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "diff", "cmp", "file", "stat", "du", "tree", "ls",
	"grep", "egrep", "fgrep", "rg", "fd", "fdfind", "find", "sed", "awk", "jq", "bat", "nl", "cut", "column",
	"md5sum", "sha1sum", "sha256sum", "cksum", "realpath", "readlink", "basename", "dirname", "test", "[", "echo", "printf",
]);
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "jq"]);
const WRAPPERS = new Set(["env", "command", "nohup", "time", "nice", "timeout", "exec", "stdbuf", "ionice", "setsid", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "nc", "ncat"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python3", "node", "perl", "ruby", "php", "source", ".", "eval", "sudo", "doas", "xargs"]);
const BAD_ASSIGN = /^(LD_[A-Za-z_]*|DYLD_[A-Za-z_]*|BASH[A-Za-z_]*|GIT_[A-Za-z_]*|BUN_[A-Za-z_]*|(?:npm|NPM|YARN|PNPM|yarn|pnpm)_[A-Za-z_]*|NODE_(?:OPTIONS|PATH)|PYTHON(?:STARTUP|HOME|PATH)|PATH|ENV|PAGER|MANPAGER|LESS[A-Z]*|EDITOR|VISUAL|IFS|SHELL|HOME|TMPDIR|XDG_[A-Z_]*|RIPGREP_CONFIG_PATH|JQ_[A-Z_]*|GREP_[A-Z_]*|PERL5[A-Z]*|RUBY[A-Z]*|SSH_[A-Z_]*)$/;
const PROTECTED_MENTION = /(^|[/\s'"=(,:@])(\.env(\.[A-Za-z0-9_.-]+)?|auth\.json|models(-store)?\.json|id_rsa|id_ed25519|\.netrc|\.npmrc)($|[/\s'"),:;])/;

const WRITEISH = /^(rm|rmdir|mv|cp|touch|mkdir|chmod|chown|ln|tee|truncate|install|rsync|sed|tar|unzip|patch|git|npm|npx|pnpm|yarn|pip|pip3|python|python3|node)$/;
const baseName = (t: string) => t.split("/").pop() ?? t;

function unwrap(tokens: string[]): { tokens: string[]; err?: string } {
	let t = tokens.slice();
	for (let guard = 0; guard < 8; guard++) {
		while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) {
			const name = t[0].split("=")[0];
			if (BAD_ASSIGN.test(name)) return { tokens: t, err: `gán biến môi trường '${name}' không được phép` };
			t.shift();
		}
		if (!t.length) return { tokens: t };
		const c = baseName(t[0]);
		if (!WRAPPERS.has(c)) return { tokens: t };
		t.shift();
		if (c === "env" && t.length && t[0].startsWith("-") && t[0] !== "-i") return { tokens: t, err: "'env' chỉ cho phép dạng 'env [-i] [NAME=VALUE]... lệnh'" };
		while (t.length && t[0].startsWith("-")) t.shift();
		if ((c === "timeout" || c === "nice") && t.length && /^\d+(\.\d+)?[smhd]?$/.test(t[0])) t.shift();
		if (c === "env" && t.length === 0) return { tokens: t, err: "'env' không đối số in toàn bộ biến môi trường (chứa secret)" };
	}
	return { tokens: t, err: "lồng quá nhiều lệnh bọc (env/time/nice/...)" };
}

function looksPathish(t: string): boolean {
	return t === "." || t === ".." || t === "~" || t.startsWith("/") || t.startsWith("~/") || t.includes("/");
}

/**
 * Glob không nháy ở thành phần cuối: liệt kê thư mục (phần cố định) và xem có khớp file/thư mục nhạy cảm không
 * (secret, .git, thư mục credential, /proc/PID/environ, file credential trong agent-dir).
 */
function globHitsSecret(tok: string, cwd: string, agentDir: string): string | null {
	const dir = path.dirname(tok);
	const pat = path.basename(tok);
	if (/[*?[]/.test(dir)) return "glob trong tên thư mục";
	let entries: string[];
	const dirAbs = path.resolve(cwd, dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
	try {
		entries = fs.readdirSync(dirAbs).slice(0, 20000);
	} catch {
		return null;
	}
	let src = "";
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i];
		if (c === "*") src += ".*";
		else if (c === "?") src += ".";
		else if (c === "[") {
			const e = pat.indexOf("]", i + 2);
			if (e < 0) src += "\\[";
			else {
				let cls = pat.slice(i, e + 1);
				if (cls[1] === "!") cls = `[^${cls.slice(2)}`;
				src += cls.replace(/\\/g, "\\\\");
				i = e;
			}
		} else src += c.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	let re: RegExp;
	try {
		re = new RegExp(`^${src}$`);
	} catch {
		return pat; // mẫu không hiểu được: chặn
	}
	const dotLiteral = pat.startsWith(".");
	for (const name of entries) {
		if (name.startsWith(".") && !dotLiteral) continue;
		if (!re.test(name)) continue;
		if (isSecretName(name) || name === ".git" || SECRET_DIRS.has(name)) return name;
		if (protectedRead(resolvePath(path.join(dirAbs, name), cwd), agentDir)) return name;
	}
	return null;
}

function checkSegment(seg: Segment, env: Env, state: { cwd: string }, depth: number): Decision {
	const raw = seg.tokens.map((t) => t.text);

	// kho grants/yêu cầu và CLI duyệt: model không được đụng tới (đây là luật cứng, không ask được)
	for (const t of seg.tokens)
		if (/permissions-cli|permission-requests|(^|\/)grants(-used)?(\/|$)|grants-used/.test(t.text))
			return no("protected-ask-store", "Lệnh nhắc tới kho duyệt quyền/CLI duyệt (grants, permission-requests, permissions-cli); chỉ bot điều phối được dùng.");

	for (const rd of seg.redirects)
		if (/permissions-cli|permission-requests|(^|\/)grants(-used)?(\/|$)|grants-used/.test(rd.target))
			return no("protected-ask-store", "Redirect tới kho duyệt quyền (grants, grants-used, permission-requests) bị cấm.");

	// Mở rộng lúc chạy ($VAR, ${IFS}, $1, $'..', {a,b}, ~user) ở BẤT KỲ vị trí nào (lệnh/cờ/toán hạng/redirect): bash đổi nội dung
	// token sau khi ta đã kiểm tra => lách whitelist (find -fprint${IFS}/x) hoặc lộ secret (echo $API_KEY). Trong nháy đơn thì không sao.
	for (const t of seg.tokens)
		if (t.expands)
			return no("shell-unsafe", `Token có mở rộng biến/brace/tilde ('${t.text.slice(0, 40)}') không được phép; dùng giá trị tường minh (hoặc đặt trong dấu nháy đơn nếu muốn ký tự '$' nguyên văn).`);
	for (const rd of seg.redirects)
		if (rd.expands || rd.glob) return no("shell-unsafe", "Đích redirect có mở rộng biến/glob không được phép.");

	// token nhắc tới file secret (kể cả trong `python -c "open('.env')"`)
	for (const t of seg.tokens) {
		if (PROTECTED_MENTION.test(t.text) && !/^\.env\.(example|sample|template|dist)$/.test(baseName(t.text)))
			return no("protected-read", `Lệnh nhắc tới file chứa secret ('${t.text.slice(0, 60)}'); không được phép.`);
		if (t.glob) {
			const hit = globHitsSecret(t.text, state.cwd, env.agentDir);
			if (hit) return no("protected-read", `Mẫu glob '${t.text}' khớp file nhạy cảm '${hit}'; không được phép.`);
		}
	}

	const checkRedirects = (): Decision => {
		for (const rd of seg.redirects) {
			if (rd.target === "/dev/null") continue;
			if (rd.op.startsWith("<")) {
				const d = checkRead(rd.target, state.cwd, env);
				if (!d.ok) return d;
				continue;
			}
			const d = checkWrite(rd.target, state.cwd, env, true);
			if (!d.ok) return d;
		}
		return OK;
	};

	const un = unwrap(raw);
	if (un.err) return no("shell-unsafe", un.err);
	const t = un.tokens;
	if (!t.length) return checkRedirects(); // lệnh chỉ có redirect (> file) cũng phải qua kiểm tra ghi
	const cmd = baseName(t[0]);
	const args = t.slice(1);
	const unTokens = seg.tokens.slice(seg.tokens.length - t.length);

	if (["sudo", "su", "doas", "pkexec", "runuser"].includes(cmd))
		return no("sudo", `'${cmd}' bị cấm: bot không được leo quyền.`);
	if (cmd === "eval") return no("shell-unsafe", "'eval' bị cấm: hãy viết lệnh tường minh.");
	if (cmd === "xargs") return no("shell-unsafe", "'xargs' bị cấm: hãy liệt kê lệnh tường minh.");
	if (cmd === "source" || cmd === ".") return no("shell-unsafe", "'source' bị cấm.");
	if (["printenv", "set", "declare", "typeset", "compgen"].includes(cmd) || (cmd === "export" && args.includes("-p")))
		return no("env-dump", `'${cmd}' có thể in biến môi trường chứa secret; bị cấm.`);
	if (/^mkfs/.test(cmd) || cmd === "shutdown" || cmd === "reboot" || cmd === "halt")
		return no("destructive", `'${cmd}' bị cấm.`);
	if (cmd === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return no("destructive", "dd ghi vào thiết bị bị cấm.");

	// shell -c "<chuỗi>": phân tích đệ quy
	if (SHELLS.has(cmd)) {
		const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
		if (ci >= 0) {
			if (depth >= 2 || !args[ci + 1]) return no("shell-unsafe", "shell -c lồng quá sâu hoặc thiếu chuỗi lệnh.");
			return checkBashString(args[ci + 1], env, { cwd: state.cwd }, depth + 1, true);
		}
	}

	if (cmd === "cd" || cmd === "pushd" || cmd === "popd") {
		if (cmd !== "cd") return no("shell-unsafe", `'${cmd}' bị cấm; dùng cd <thư mục tường minh>.`);
		const target = args.find((a) => !a.startsWith("-"));
		if (!target || unTokens[args.indexOf(target) + 1]?.expands) return no("path-jail", "cd cần đường dẫn tường minh trong thư mục làm việc.");
		const r = resolvePath(target, state.cwd);
		if (!isInside(r.real, env.root)) return no("path-jail", `cd ra ngoài thư mục làm việc (${env.root}) bị cấm: '${target}'.`);
		state.cwd = r.real;
		return OK;
	}

	// bunx / bun x: chỉ chạy typescript (tsc), không cho tải/chạy gói tùy ý từ registry
	if (cmd === "bun" && args[0] === "x") return no("bunx-package", "'bun x' bị cấm; dùng 'bunx -p typescript@5.9.3 tsc --noEmit'.");
	if (cmd === "bunx") {
		const d = checkBunx(args, state.cwd, env);
		if (!d.ok) return d;
	}

	// rm -r trên đường dẫn rộng
	if (cmd === "rm" || cmd === "rmdir" || cmd === "shred" || cmd === "unlink") {
		const recursive = args.some((a) => /^--recursive$|^-[a-zA-Z]*[rR]/.test(a));
		if (args.includes("--no-preserve-root")) return no("rm-broad", "--no-preserve-root bị cấm.");
		if (recursive) {
			const targets = args.filter((a) => !a.startsWith("-"));
			if (!targets.length) return no("rm-broad", "rm -r thiếu đường dẫn.");
			for (const tg of targets) {
				const tok = unTokens[args.indexOf(tg) + 1];
				const r = resolvePath(tg.replace(/\/\*+$/, "") || "/", state.cwd);
				const broadText = /^(\.|\.\.|\*|\.\*|\/|~|\.\/|\.\/\*|\/\*|~\/\*)$/.test(tg);
				if (tok?.expands || broadText || r.real === env.root || !isInside(r.real, env.root) || r.real === path.parse(r.real).root)
					return no(
						"rm-broad",
						`rm -r '${tg}' bị chặn: đường dẫn quá rộng/ngoài thư mục làm việc. Chỉ xóa đệ quy một thư mục con cụ thể bên trong ${env.root}.`,
					);
			}
		}
	}

	if (knownCommand(cmd, "bot") || HARD_BLOCKED_CMDS.has(cmd)) {
		// Lệnh thuộc whitelist engine: chỉ cờ nằm trong whitelist, đường dẫn qua jail/secret (xem shell.ts)
		if (cmd === "git") {
			const risk = gitConfigRisk(env.root, state.cwd);
			if (risk) return no("shell-unsafe", `Cấu hình git của repo có khóa chạy lệnh ngoài (${risk}); git bị chặn để an toàn.`);
		}
		const f = vetCommand(unTokens, makeCtx(env, state));
		if (f) return { ok: false, ...f };
	} else {
		// Lệnh ngoài whitelist engine (test runner, rm, ...): glob không được phép; kiểm tra đường dẫn kiểu chung
		for (const tk of unTokens)
			if (tk.glob) return no("shell-unsafe", "Glob (* ? [) không nháy chỉ được dùng ở toán hạng đường dẫn của lệnh đọc/liệt kê (ls, cat, grep, find...); ở đây hãy liệt kê file tường minh hoặc đặt mẫu trong dấu nháy.");
		if (cmd === "yarn") {
			const risk = yarnConfigRisk(env.root, state.cwd);
			if (risk) return no("shell-unsafe", `Cấu hình yarn của repo chạy mã (${risk}); yarn bị chặn.`);
		}
		const readCmd = READ_CMDS.has(cmd);
		let skipFirst = PATTERN_FIRST.has(cmd) && !args.some((a) => /^(-e|-f|--regexp|--file)/.test(a));
		for (let i = 0; i < args.length; i++) {
			let a = args[i];
			if (a.startsWith("-")) {
				const eq = a.indexOf("=");
				if (a.startsWith("--") && eq > 0) a = a.slice(eq + 1);
				else continue;
			} else if (skipFirst) {
				skipFirst = false;
				continue;
			}
			if (!looksPathish(a) && !isSecretName(baseName(a))) continue;
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) continue; // URL
			if (readCmd) {
				const d = checkRead(a, state.cwd, env);
				if (!d.ok) return d;
			} else {
				const r = resolvePath(a, state.cwd);
				const pr = protectedRead(r, env.agentDir);
				if (pr) return no("protected-read", `Không được truy cập ${r.lex}: ${pr}`);
				if (looksPathish(a)) {
					const d = checkWrite(a, state.cwd, env, false);
					if (!d.ok && (d.rule === "path-jail" || WRITEISH.test(cmd))) return d;
				}
			}
		}
	}

	return checkRedirects();
}

/** TypeScript ghim CHÍNH XÁC (install.sh cài vào <MTH_HOME>/vendor; shim bunx trong sandbox lồng dùng bản này, không mạng). */
export const TS_PINNED = "typescript@5.9.3";
const vendorTsc = () => {
	const home = mthEnv("MTH_HOME");
	return home ? path.join(home, "vendor/node_modules/typescript/bin/tsc") : "";
};

/**
 * Luật cứng cho bunx (không tắt được bằng permissions.json): chỉ 2 dạng
 *   bunx -p|--package typescript@5.9.3 tsc ...   (đúng phiên bản; dải như typescript@5 bị từ chối)
 *   bunx tsc ...   khi có <cwd>/node_modules/typescript nằm trong thư mục làm việc, HOẶC đang trong mth-sandbox và có
 *                  vendor tsc (shim bunx của sandbox lồng trỏ vào đó). Nếu không, bunx sẽ tải gói "tsc" giả trên npm.
 * `bun x` và mọi gói/cờ khác bị chặn.
 */
function checkBunx(args: string[], cwd: string, env: Env): Decision {
	const bad = (why: string) => no("bunx-package", `bunx chỉ được chạy TypeScript (tsc): ${why}. Dùng 'bunx -p ${TS_PINNED} tsc --noEmit'.`);
	if (args[0] === "-p" || args[0] === "--package") {
		if (args[1] !== TS_PINNED) return bad(`gói '${(args[1] ?? "").slice(0, 60)}' không được phép (chỉ ${TS_PINNED})`);
		if (args[2] !== "tsc") return bad(`sau -p ${TS_PINNED} phải là 'tsc'`);
		return OK;
	}
	if (args[0] !== "tsc") return bad(`'${(args[0] ?? "").slice(0, 60)}' không được phép`);
	const pkg = path.join(cwd, "node_modules", "typescript", "package.json");
	if (fs.existsSync(pkg) && isInside(realish(pkg), env.root)) return OK;
	if (env.sandboxed && vendorTsc() && fs.existsSync(vendorTsc())) return OK;
	return bad("không có node_modules/typescript cục bộ (hoặc vendor tsc trong sandbox); bunx sẽ tải gói 'tsc' giả trên npm");
}

/** Lệnh có đoạn nào khớp bash.sandbox (test/build chạy mã của repo)? */
function matchesSandboxList(command: string, env: Env): boolean {
	const list = env.policy.bash.sandbox ?? [];
	if (!list.length) return false;
	const p = parseShell(command);
	return p.segments.some((seg) => {
		const forms = [seg.text, unwrap(seg.tokens.map((t) => t.text)).tokens.join(" ")];
		return list.some((pat) => forms.some((f) => matchCommand(pat, f)));
	});
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Trong mth-sandbox: lệnh khớp bash.sandbox được viết lại để chạy trong sandbox LỒNG (lib/sandbox-exec.sh: không mạng,
 * env allowlist không key, agent-dir/.env/bots bị che). Trả lý do chặn nếu không bọc được (fail-closed).
 */
function wrapNested(input: Record<string, unknown>, env: Env): string | null {
	if (!env.sandboxed) return null;
	const command = String(input.command ?? "");
	if (!matchesSandboxList(command, env)) return null;
	const home = mthEnv("MTH_HOME");
	const wrapper = home ? path.join(home, "lib/sandbox-exec.sh") : "";
	if (!wrapper || !fs.existsSync(wrapper)) return "Lệnh test/build phải chạy trong sandbox lồng nhưng không thấy lib/sandbox-exec.sh (MTH_HOME); bị chặn.";
	input.command = `${shq(wrapper)} -- ${shq(command)}`;
	return null;
}

function makeCtx(env: Env, state: { cwd: string }): VetCtx {
	const dec = (d: Decision): Fail | null => (d.ok ? null : d);
	return {
		mode: "bot",
		read: (p) => dec(checkRead(p, state.cwd, env)),
		readTree: (p) => {
			const r = resolvePath(p, state.cwd);
			const home = realish(os.homedir());
			for (const c of [r.lex, r.real]) {
				if (c === path.parse(c).root || isInside(home, c) || isInside(env.agentDir, c) || isInside(env.agentDir.replace(/\/[^/]*$/, ""), c))
					return dec(no("protected-read", `Duyệt đệ quy từ '${p}' sẽ quét cả vùng nhạy cảm (gốc /, thư mục home, agent-dir); hãy chỉ định thư mục dự án cụ thể.`));
			}
			return null;
		},
		readJail: (p) => {
			const d = checkRead(p, state.cwd, env);
			if (!d.ok) return d;
			const r = resolvePath(p, state.cwd);
			return isInside(r.real, env.root) ? null : dec(no("path-jail", `File nhập '${p}' nằm ngoài thư mục làm việc (${env.root}); không được phép.`));
		},
		write: (p) => dec(checkWrite(p, state.cwd, env, false)),
		readGlob: (p) => {
			const d = checkRead(path.dirname(p), state.cwd, env);
			if (!d.ok) return d;
			const hit = globHitsSecret(p, state.cwd, env.agentDir);
			return hit ? dec(no("protected-read", `Mẫu glob '${p}' khớp file nhạy cảm '${hit}'; không được phép.`)) : null;
		},
	};
}

/** Cấu hình repo (.git/config) mà sandbox/mã trong repo có thể ghi, khiến lệnh git ĐỌC cũng chạy lệnh ngoài. */
function gitConfigRisk(root: string, cwd: string): string | null {
	for (const dir of new Set([root, cwd])) {
		let txt: string;
		try {
			txt = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
		} catch {
			continue;
		}
		if (txt.length > 500_000) return "config quá lớn";
		let sect = "";
		for (const line of txt.split(/\r?\n/)) {
			const m = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
			if (m) {
				sect = m[1].toLowerCase();
				if (sect === "include" || sect === "includeif") return "[include]";
				continue;
			}
			const kv = /^\s*([A-Za-z0-9-]+)\s*=?\s*(.*)$/.exec(line);
			if (!kv) continue;
			const key = kv[1].toLowerCase();
			const val = kv[2].trim();
			if (sect === "core" && ["pager", "sshcommand", "hookspath", "gitproxy", "askpass", "editor"].includes(key)) return `core.${key}`;
			if (sect === "core" && key === "fsmonitor" && !/^"?(true|false|yes|no|on|off|1|0)"?$/i.test(val)) return "core.fsmonitor";
			if (sect === "diff" && ["textconv", "command", "external"].includes(key)) return `diff.${key}`;
			if (sect === "merge" && key === "driver") return "merge.driver";
			if (sect === "pager") return "pager.*";
			if ((sect === "gpg" || sect === "gpg.ssh" || sect === "gpg.x509") && key === "program") return "gpg.program";
			if (sect === "filter" && ["clean", "smudge", "process"].includes(key) && !/^"?git-lfs\b/.test(val)) return `filter.${key}`;
		}
	}
	return null;
}

function yarnConfigRisk(root: string, cwd: string): string | null {
	for (const dir of new Set([root, cwd]))
		for (const f of [".yarnrc.yml", ".yarnrc"]) {
			try {
				const txt = fs.readFileSync(path.join(dir, f), "utf8");
				if (/^\s*(yarnPath|yarn-path)\b|^\s*plugins\s*:/m.test(txt)) return `${f}: yarnPath/plugins`;
			} catch {
				/* không có */
			}
		}
	return null;
}

function checkBashString(command: string, env: Env, state: { cwd: string }, depth: number, inner = false): Decision {
	const p = parseShell(command);
	if (p.unterminated) return no("shell-unsafe", "Lệnh không phân tích được (dấu nháy/escape chưa đóng hoặc quá dài).");
	if (p.substitution) return no("shell-unsafe", "Không cho phép command substitution ($(...), `...`, <(...)); viết lệnh tường minh từng bước.");
	if (p.heredoc) return no("shell-unsafe", "Không cho phép heredoc (<<); dùng tool write để tạo file.");
	if (p.group) return no("shell-unsafe", "Không cho phép subshell/nhóm lệnh ( ); chạy từng lệnh riêng.");
	if (/:\s*\(\s*\)\s*\{/.test(command)) return no("destructive", "Fork bomb bị cấm.");
	if (!p.segments.length) return no("shell-unsafe", "Lệnh rỗng.");

	// curl ... | sh
	let sawDownload = false;
	for (const seg of p.segments) {
		if (seg.sep !== "|") sawDownload = false;
		const c = baseName(unwrap(seg.tokens.map((t) => t.text)).tokens[0] ?? "");
		if (sawDownload && INTERPRETERS.has(c))
			return no("curl-pipe-sh", `Chặn "tải về rồi pipe vào '${c}'" (curl|sh). Tải file về, đọc nội dung, rồi mới quyết định.`);
		if (DOWNLOADERS.has(c)) sawDownload = true;
	}

	let pendingAsk: Decision | undefined;
	for (const seg of p.segments) {
		const d = checkSegment(seg, env, state, depth);
		if (!d.ok) {
			if (!isAsk(d)) return d;
			pendingAsk ??= d; // ask không che được luật cứng ở đoạn sau
		}
	}
	if (inner) return pendingAsk ?? OK;

	// policy: deny rồi allow (trên TỪNG đoạn; bản đã bỏ wrapper cũng được thử)
	const unwrappedText = (seg: Segment) => {
		const u = unwrap(seg.tokens.map((t) => t.text));
		return u.tokens.join(" ");
	};
	for (const seg of p.segments) {
		const forms = [seg.text, unwrappedText(seg)];
		const denied = env.policy.bash.deny.find((pat) => forms.some((f) => matchCommand(pat, f)) || matchCommand(pat, command.replace(/\s+/g, " ").trim()));
		if (denied) return no("bash.deny", `Lệnh '${seg.text.slice(0, 100)}' bị chặn bởi quy tắc deny '${denied}' trong permissions.json.`);
	}
	{
		for (const seg of p.segments) {
			if (seg.tokens[0]?.text === "cd") continue; // cd đã được kiểm tra jail ở checkSegment
			const forms = [seg.text, unwrappedText(seg)];
			const askPat = env.policy.bash.ask.find((pat) => forms.some((f) => matchCommand(pat, f)));
			if (askPat) {
				pendingAsk ??= askD("bash.ask", `Lệnh '${scrub(seg.text).slice(0, 100)}' cần duyệt (khớp bash.ask '${askPat}')`, askPat);
				continue;
			}
			const sbPat = env.sandboxed ? undefined : (env.policy.bash.sandbox ?? []).find((pat) => forms.some((f) => matchCommand(pat, f)));
			if (sbPat) {
				// lệnh test/build chạy mã tùy ý của repo: ngoài mth-sandbox thì không tự chạy, phải được duyệt
				pendingAsk ??= askD(
					"bash.sandbox",
					`Lệnh '${scrub(seg.text).slice(0, 100)}' chạy mã của repo (test/build), chỉ tự chạy trong mth-sandbox; đang chạy ngoài sandbox nên cần duyệt (khớp bash.sandbox '${sbPat}')`,
					sbPat,
				);
			}
			if (env.policy.mode !== "allowlist") continue;
			if (!env.policy.bash.allow.some((pat) => forms.some((f) => matchCommand(pat, f))))
				return no(
					"bash.allow",
					`Lệnh '${seg.text.slice(0, 100)}' không nằm trong allowlist của bot. Chỉ chạy các lệnh được cho phép (ví dụ: ${env.policy.bash.allow.slice(0, 6).join(", ") || "chưa có lệnh nào"}); hoặc dùng tool read/grep/find/ls/write/edit thay cho bash.`,
				);
		}
	}
	return pendingAsk ?? OK;
}

// ---------- tool khác ----------

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "applypatch", "patch", "multiedit"]);

function collectPaths(input: Record<string, unknown>): string[] {
	const out = new Set<string>();
	const addStr = (v: unknown) => typeof v === "string" && v && out.add(v);
	for (const k of ["path", "file_path", "filePath", "file", "filename", "target", "destination"]) addStr(input[k]);
	for (const k of ["paths", "files"]) if (Array.isArray(input[k])) for (const v of input[k] as unknown[]) addStr(typeof v === "object" && v ? (v as Record<string, unknown>).path : v);
	for (const v of Object.values(input)) {
		if (typeof v !== "string" || v.length > 2_000_000) continue;
		for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) out.add(m[1].trim());
		for (const m of v.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) out.add(m[1].trim());
		for (const m of v.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)) if (m[1] !== "/dev/null") out.add(m[1]);
	}
	return [...out];
}

function checkTool(toolName: string, input: Record<string, unknown>, env: Env): Decision {
	const { tools } = env.policy;
	if (tools.deny.includes(toolName)) return no("tools.deny", `Tool '${toolName}' bị chặn bởi permissions.json (tools.deny).`);
	if (tools.allow && !tools.allow.includes(toolName)) return no("tools.allow", `Tool '${toolName}' không nằm trong tools.allow của permissions.json.`);

	let d: Decision = OK;
	if (toolName === "bash") d = checkBashString(String(input.command ?? ""), env, { cwd: env.cwd }, 0);
	else if (READ_TOOLS.has(toolName)) {
		const p = typeof input.path === "string" && input.path ? input.path : ".";
		d = checkRead(p, env.cwd, env);
	} else if (WRITE_TOOLS.has(toolName)) {
		const paths = collectPaths(input);
		if (!paths.length) return no("write-target", `Không xác định được đường dẫn đích của tool '${toolName}'; bị chặn (fail-closed).`);
		for (const p of paths) {
			const x = checkWrite(p, env.cwd, env, true);
			if (!x.ok) {
				if (!isAsk(x)) return x;
				if (d.ok) d = x;
			}
		}
	}
	if (!d.ok) return d;
	const askTool = tools.ask.find((p) => p === toolName || p === "*");
	if (askTool) return askD("tools.ask", `Tool '${toolName}' cần duyệt (khớp tools.ask '${askTool}')`, askTool);
	return OK;
}

/** Chủ thể chính xác của yêu cầu (dùng để tạo key grant). */
function subjectOf(toolName: string, input: Record<string, unknown>, env: Env): { kind: "bash" | "path" | "tool"; subject: string } {
	if (toolName === "bash") return { kind: "bash", subject: String(input.command ?? "").replace(/\s+/g, " ").trim() };
	const paths = collectPaths(input);
	if (paths.length) {
		const real = [...new Set(paths.map((p) => resolvePath(p, env.cwd).real))].sort();
		return { kind: "path", subject: real.join("\n") };
	}
	return { kind: "tool", subject: JSON.stringify(input).slice(0, 4000) };
}

function summarize(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash") return scrub(String(input.command ?? "")).slice(0, 600);
	const paths = collectPaths(input);
	return scrub(paths.join(", ")).slice(0, 600);
}

// ---------- extension ----------

export default function botPermissions(pi: ExtensionAPI): void {
	const agentDir = path.resolve(getAgentDir());
	const agentReal = realish(agentDir);

	function rootOf(cwd: string): string {
		return realish(path.resolve(mthEnv("MTH_WORKDIR") || cwd));
	}

	const denied = new Set<string>(); // key đã bị bot từ chối trong tiến trình này (chống vòng lặp xin lại)
	// allow_always_session qua RPC chỉ sống trong tiến trình này (extension KHÔNG ghi vào grants/; grants/ chỉ do CLI của người vận hành ghi)
	const sessionAllow = new Set<string>();

	async function resolveAsk(
		toolName: string,
		input: Record<string, unknown>,
		d: Extract<Decision, { ok: false }>,
		env: Env,
		ctx: { hasUI: boolean; ui: { select(t: string, o: string[], x?: { timeout?: number }): Promise<string | undefined> }; sessionManager: { getSessionId(): string } },
		target: string,
	): Promise<{ block: true; reason: string } | undefined> {
		const on = env.policy.audit;
		const sessionId = ctx.sessionManager.getSessionId();
		const { kind, subject } = subjectOf(toolName, input, env);
		const key = grantKey(toolName, subject);
		const id = requestId(sessionId, key);
		const base = { tool: toolName, rule: d.rule, pattern: d.ask?.pattern, request: id, session: sessionId, target };
		const block = (code: string, text: string, extra?: unknown) => {
			const tail = extra ? `\n${JSON.stringify(extra)}` : "";
			return { block: true as const, reason: `Blocked by bot policy [${code}]: ${text}${tail}` };
		};

		// 1) grant đã có cho đúng (session, lệnh/đường dẫn) này? (đọc grants/, ghi sổ grants-used/; lỗi ghi sổ => không có grant)
		if (sessionAllow.has(`${sessionId}\0${key}`)) {
			audit(agentDir, on, { ...base, decision: "allow", event: "grant_used", mode: "session", via: "rpc" });
			return;
		}
		let g = null;
		try {
			g = takeGrant(agentDir, sessionId, key);
		} catch {
			/* không đọc được grants => coi như chưa có (fail-closed) */
		}
		if (g) {
			audit(agentDir, on, { ...base, decision: "allow", event: "grant_used", mode: g.mode, grantId: g.grantId });
			if (g.mode === "once") try { setRequestStatus(agentDir, id, "approved"); } catch { /* bỏ qua */ }
			return;
		}
		// 2) đã bị từ chối?
		if (denied.has(key) || readRequest(agentDir, id)?.status === "denied") {
			audit(agentDir, on, { ...base, decision: "block", event: "ask_denied_repeat" });
			return block("permission_denied", `Yêu cầu quyền ${id} đã bị bot điều phối TỪ CHỐI. Đừng thử lại lệnh này; chọn cách khác hoặc báo lại cho người điều phối.`, { permission_denied: { id } });
		}

		if (subject.length > 8000) return block("permission_denied", "Chủ thể yêu cầu quá dài (>8000 ký tự) để duyệt; bị chặn.");
		const shown = scrub(subject).slice(0, 2000);
		const request: PermRequest = {
			id, sessionId, key, tool: toolName, kind, subject, // NGUYÊN VĂN: CLI tính lại key từ đây (file không tin cậy)
			rule: d.rule, pattern: d.ask?.pattern ?? "", reason: scrub(d.reason),
			status: "pending", createdAt: new Date().toISOString(),
		};

		// 3) có kênh hỏi (RPC / TUI): hỏi bot cha ngay trong phiên
		if (ctx.hasUI) {
			const envT = Number(mthEnv("MTH_ASK_TIMEOUT_MS")); // bot cha có thể ép hạn chót khác cho tiến trình này
			const timeoutMs = Number.isFinite(envT) && envT >= 1000 && envT <= 3_600_000 ? envT : env.policy.askConfig.timeoutMs;
			const payload = {
				type: "permission_request", id, session: sessionId, tool: toolName, kind,
				subject: shown, rule: d.rule, pattern: request.pattern, reason: request.reason,
				choices: ["allow_once", "allow_always_session", "deny"], timeoutMs,
			};
			audit(agentDir, on, { ...base, decision: "ask", event: "ask", mode: "ui" });
			let answer: string | undefined;
			try {
				answer = await ctx.ui.select(JSON.stringify(payload), payload.choices, { timeout: timeoutMs });
			} catch {
				answer = undefined;
			}
			if (answer === "allow_once") {
				audit(agentDir, on, { ...base, decision: "allow", event: "approve", mode: "once", via: "rpc" });
				return;
			}
			if (answer === "allow_always_session") {
				sessionAllow.add(`${sessionId}\0${key}`);
				audit(agentDir, on, { ...base, decision: "allow", event: "approve", mode: "session", via: "rpc" });
				return;
			}
			denied.add(key);
			const why = answer === "deny" ? "deny" : "timeout_or_cancelled";
			audit(agentDir, on, { ...base, decision: "block", event: "deny", why, via: "rpc" });
			return block("permission_denied", `Bot điều phối ${why === "deny" ? "từ chối" : "không trả lời kịp (coi là từ chối)"} yêu cầu ${id}. Đừng thử lại lệnh này; chọn cách khác.`, { permission_denied: { id, why } });
		}

		// 4) không UI (-p / --mode json): ghi yêu cầu, chặn với needs_permission; bot duyệt bằng CLI rồi gọi lại cùng session
		try {
			saveRequest(agentDir, request);
		} catch (e) {
			return block("permission_denied", `Không ghi được yêu cầu quyền (${(e as Error).message}); bị chặn.`);
		}
		audit(agentDir, on, { ...base, decision: "ask", event: "ask", mode: "headless" });
		const info = {
			code: "needs_permission", id, session: sessionId, tool: toolName, kind, subject: shown,
			rule: d.rule, pattern: request.pattern, reason: request.reason,
			approve: `permissions-cli approve ${id} [--always]`, deny: `permissions-cli deny ${id}`,
		};
		try {
			pi.appendEntry("permission_request", info);
		} catch {
			/* không bắt buộc */
		}
		return block(
			"needs_permission",
			`Hành động này cần bot điều phối duyệt (yêu cầu ${id}). Hãy DỪNG việc này và báo lại kết quả hiện có; sau khi được duyệt, phiên sẽ được chạy lại.`,
			{ needs_permission: info },
		);
	}

	pi.on("tool_call", async (event, ctx) => {
		const loaded = loadPolicy(agentDir);
		const target = summarize(event.toolName, event.input as Record<string, unknown>);
		if (!loaded.policy) {
			const reason = `Policy file invalid, all tools are blocked (fail-closed): ${loaded.error}`;
			audit(agentDir, true, { tool: event.toolName, decision: "block", rule: "policy-invalid", reason, target });
			return { block: true, reason };
		}
		const env: Env = {
			policy: loaded.policy,
			agentDir: agentReal,
			root: rootOf(ctx.cwd),
			cwd: path.resolve(ctx.cwd),
			sandboxed: detectSandbox(),
		};
		let d: Decision;
		try {
			d = checkTool(event.toolName, event.input as Record<string, unknown>, env);
		} catch (e) {
			d = no("internal-error", `Lỗi khi kiểm tra quyền (chặn để an toàn): ${(e as Error).message}`);
		}
		const nest = () => {
			if (event.toolName !== "bash") return undefined;
			const why = wrapNested(event.input as Record<string, unknown>, env);
			if (!why) return undefined;
			audit(agentDir, env.policy.audit, { tool: event.toolName, decision: "block", rule: "nested-sandbox", reason: why, target });
			return { block: true as const, reason: `Blocked by bot policy [nested-sandbox]: ${why}` };
		};
		if (d.ok) {
			audit(agentDir, env.policy.audit, { tool: event.toolName, decision: "allow", mode: env.policy.mode, target });
			return nest();
		}
		if (d.ask) return (await resolveAsk(event.toolName, event.input as Record<string, unknown>, d, env, ctx, target)) ?? nest();
		const reason = `Blocked by bot policy [${d.rule}]: ${d.reason}`;
		audit(agentDir, env.policy.audit, { tool: event.toolName, decision: "block", rule: d.rule, reason: scrub(reason), target });
		return { block: true, reason };
	});

	// Lớp phòng thủ thứ hai: che secret xuất hiện trong kết quả tool, bỏ dòng thuộc file .env.
	pi.on("tool_result", async (event) => {
		let changed = false;
		const content = event.content.map((c) => {
			if (c.type !== "text") return c;
			let text = scrub(c.text);
			if (event.toolName === "bash" || event.toolName === "grep") {
				const kept = text.split("\n").filter((l) => !/^(?:\.\/)?(?:[^\s:]*\/)?\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w.-]+)?[:-]/.test(l));
				if (kept.length !== text.split("\n").length) text = kept.join("\n");
			}
			if (text !== c.text) changed = true;
			return text === c.text ? c : { ...c, text };
		});
		if (changed) return { content };
	});
}
