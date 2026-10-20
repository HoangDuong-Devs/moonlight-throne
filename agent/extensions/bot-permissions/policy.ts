/**
 * Chính sách quyền cho bot: nạp/kiểm tra permissions.json, so khớp mẫu, xử lý đường dẫn
 * (path jail có xét ../ và symlink), che secret, ghi audit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp } from "./shell.ts";

export interface Rules {
	allow: string[];
	deny: string[];
	/**
	 * Chỉ bash: lệnh (đã khớp allow) chạy mã của repo (test/build) => CHỈ tự chạy trong coder-sandbox.
	 * Ngoài sandbox => ask (rule "bash.sandbox"). Rỗng/không khai báo = không ràng buộc.
	 */
	sandbox?: string[];
	/** Cần duyệt (ask): thắng allow, thua deny và luật cứng. */
	ask: string[];
}
export interface Policy {
	mode: "allowlist" | "denylist";
	bash: Rules;
	read: Rules;
	write: Rules;
	tools: { allow?: string[]; deny: string[]; ask: string[] };
	/** Cấu hình hỏi quyền: hết giờ (ms) thì coi như từ chối. */
	askConfig: { timeoutMs: number };
	audit: boolean;
}

export const DEFAULT_POLICY: Policy = {
	mode: "allowlist",
	bash: { allow: [], deny: [], ask: [] },
	read: { allow: ["**"], deny: [], ask: [] },
	write: { allow: ["**"], deny: [], ask: [] },
	tools: { deny: [], ask: [] },
	askConfig: { timeoutMs: 120_000 },
	audit: true,
};

// ---------- nạp & kiểm tra policy ----------

export type Loaded = { policy: Policy; error?: undefined; missing: boolean } | { policy?: undefined; error: string; missing?: false };

const cache = new Map<string, { mtime: number; loaded: Loaded }>();

function strArray(v: unknown, name: string, errs: string[]): string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
		errs.push(`${name} phải là mảng chuỗi`);
		return [];
	}
	return v as string[];
}

function rules(v: unknown, name: string, errs: string[], regexOk: boolean): Rules {
	if (v === undefined) return { allow: [], deny: [], ask: [] };
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		errs.push(`${name} phải là object {allow,deny,ask}`);
		return { allow: [], deny: [], ask: [] };
	}
	const o = v as Record<string, unknown>;
	const r = {
		allow: strArray(o.allow, `${name}.allow`, errs),
		deny: strArray(o.deny, `${name}.deny`, errs),
		ask: strArray(o.ask, `${name}.ask`, errs),
	} as Rules;
	if (name === "bash") r.sandbox = strArray(o.sandbox, `${name}.sandbox`, errs);
	else if (o.sandbox !== undefined) errs.push(`${name}.sandbox chỉ dùng được cho bash`);
	if (regexOk) for (const p of [...r.allow, ...r.deny, ...r.ask, ...(r.sandbox ?? [])]) {
		const e = checkPattern(p);
		if (e) errs.push(`${name}: mẫu '${p}': ${e}`);
	}
	return r;
}

/** Trả lỗi nếu mẫu `re:` không an toàn/không hợp lệ. */
export function checkPattern(p: string): string | null {
	if (!p.startsWith("re:")) return null;
	const src = p.slice(3);
	if (src.length > 200) return "regex quá dài (>200)";
	if (/\\[1-9]/.test(src)) return "không cho phép backreference";
	if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) return "nghi ngờ quantifier lồng nhau (ReDoS)";
	try {
		new RegExp(src);
	} catch (e) {
		return `regex lỗi: ${(e as Error).message}`;
	}
	return null;
}

function askTimeout(v: unknown, errs: string[]): number {
	if (v === undefined) return DEFAULT_POLICY.askConfig.timeoutMs;
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		errs.push("ask phải là object {timeoutMs}");
		return DEFAULT_POLICY.askConfig.timeoutMs;
	}
	const t = (v as Record<string, unknown>).timeoutMs;
	if (t === undefined) return DEFAULT_POLICY.askConfig.timeoutMs;
	if (typeof t !== "number" || !Number.isFinite(t) || t < 1000 || t > 3_600_000) {
		errs.push("ask.timeoutMs phải là số trong [1000, 3600000]");
		return DEFAULT_POLICY.askConfig.timeoutMs;
	}
	return t;
}

export function loadPolicy(agentDir: string): Loaded {
	const file = path.join(agentDir, "permissions.json");
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return { policy: DEFAULT_POLICY, missing: true };
	}
	const hit = cache.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit.loaded;
	let loaded: Loaded;
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const errs: string[] = [];
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("gốc phải là object");
		if (raw.mode !== undefined && raw.mode !== "allowlist" && raw.mode !== "denylist") errs.push("mode phải là 'allowlist' hoặc 'denylist'");
		const tools = (raw.tools ?? {}) as Record<string, unknown>;
		const policy: Policy = {
			mode: raw.mode === "denylist" ? "denylist" : "allowlist",
			bash: rules(raw.bash, "bash", errs, true),
			read: rules(raw.read, "read", errs, false),
			write: rules(raw.write, "write", errs, false),
			tools: {
				allow: tools.allow === undefined ? undefined : strArray(tools.allow, "tools.allow", errs),
				deny: strArray(tools.deny, "tools.deny", errs),
				ask: strArray(tools.ask, "tools.ask", errs),
			},
			askConfig: { timeoutMs: askTimeout(raw.ask, errs) },
			audit: raw.audit !== false,
		};
		loaded = errs.length ? { error: errs.join("; ") } : { policy, missing: false };
	} catch (e) {
		loaded = { error: `không đọc được permissions.json: ${(e as Error).message}` };
	}
	cache.set(file, { mtime: st.mtimeMs, loaded });
	return loaded;
}

// ---------- phát hiện sandbox ----------

/**
 * Đang chạy trong coder-sandbox? Cần CẢ HAI: CODER_SANDBOXED=1 (coder-sandbox đặt bằng --setenv sau --clearenv)
 * VÀ PID 1 của namespace là bwrap (coder-sandbox luôn --unshare-pid). Model không đặt được env của tiến trình extension;
 * chỉ đặt biến ở host mà không có namespace bwrap thì vẫn bị coi là NGOÀI sandbox (fail-closed).
 */
export function detectSandbox(env: NodeJS.ProcessEnv = process.env, readComm: () => string = () => fs.readFileSync("/proc/1/comm", "utf8")): boolean {
	if (env.CODER_SANDBOXED !== "1") return false;
	try {
		return readComm().trim() === "bwrap";
	} catch {
		return false;
	}
}

// ---------- khớp mẫu ----------

const reCache = new Map<string, RegExp>();
function cachedRe(key: string, make: () => RegExp): RegExp {
	let r = reCache.get(key);
	if (!r) {
		r = make();
		reCache.set(key, r);
	}
	return r;
}

/** Mẫu lệnh: glob (`*` khớp mọi thứ) hoặc `re:<regex>`. Khớp toàn bộ đoạn lệnh. */
export function matchCommand(pattern: string, cmd: string): boolean {
	if (cmd.length > 8000) return false;
	if (pattern.startsWith("re:")) return cachedRe(pattern, () => new RegExp(pattern.slice(3), "s")).test(cmd);
	// như opencode: "ls *" khớp cả "ls" trần
	if (pattern.endsWith(" *") && cmd === pattern.slice(0, -2)) return true;
	return cachedRe(`g:${pattern}`, () => globToRegExp(pattern)).test(cmd);
}

/** Mẫu đường dẫn kiểu gitignore: không có "/" -> khớp tên ở mọi cấp; "dir/" -> cả thư mục. */
export function matchPathPattern(pattern: string, lex: string, real: string, root: string, realOnly = false): boolean {
	let pat = pattern;
	if (pat === "~" || pat.startsWith("~/")) pat = os.homedir() + pat.slice(1);
	const abs = path.isAbsolute(pat);
	if (!abs) {
		if (pat.endsWith("/")) pat += "**";
		if (!pat.includes("/")) pat = `**/${pat}`;
	} else if (pat.endsWith("/")) pat += "**";
	const re = cachedRe(`p:${pat}`, () => globToRegExp(pat, { pathMode: true }));
	for (const c of realOnly ? [real] : [lex, real]) {
		if (abs) {
			if (re.test(c)) return true;
		} else {
			const rel = path.relative(root, c);
			if (!rel.startsWith("..") && !path.isAbsolute(rel) && re.test(rel === "" ? "." : rel.split(path.sep).join("/"))) return true;
		}
	}
	return false;
}

// ---------- đường dẫn ----------

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** realpath cho cả đường dẫn chưa tồn tại (đi lên tổ tiên gần nhất tồn tại; theo symlink treo). */
export function realish(abs: string, depth = 0): string {
	const rest: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			return path.join(fs.realpathSync(cur), ...rest.reverse());
		} catch {
			try {
				if (fs.lstatSync(cur).isSymbolicLink() && depth < 10) {
					const target = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
					return realish(path.join(target, ...rest.reverse()), depth + 1);
				}
			} catch {
				/* không tồn tại */
			}
			const parent = path.dirname(cur);
			if (parent === cur) return path.join(cur, ...rest.reverse());
			rest.push(path.basename(cur));
			cur = parent;
		}
	}
}

export interface Resolved {
	lex: string;
	real: string;
}
export function resolvePath(p: string, cwd: string): Resolved {
	const lex = path.resolve(cwd, expandHome(p.replace(/^@/, "")));
	return { lex, real: realish(lex) };
}

export function isInside(child: string, root: string): boolean {
	return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// ---------- vùng bảo vệ cố định (không cấu hình được) ----------

const SECRET_NAME = [
	/^\.env($|\.)/,
	/^auth\.json$/,
	/^\.npmrc$/,
	/^\.netrc$/,
	/^\.pypirc$/,
	/^\.git-credentials$/,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
	/\.(pem|key|p12|pfx)$/i,
	/^credentials(\.json)?$/,
];
const ENV_SAFE = /^\.env\..*\.(example|sample|template|dist)$|^\.env\.(example|sample|template|dist)$/;
export const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);

export function isSecretName(name: string): boolean {
	if (ENV_SAFE.test(name)) return false;
	return SECRET_NAME.some((r) => r.test(name));
}

export function protectedRead(r: Resolved, agentDir: string): string | null {
	for (const c of [r.lex, r.real]) {
		const parts = c.split(path.sep);
		const name = parts[parts.length - 1];
		if (isSecretName(name)) return `'${name}' là file chứa secret/credential`;
		if (parts.some((p) => SECRET_DIRS.has(p))) return "thư mục credential (.ssh/.aws/.gnupg/.kube/.docker)";
		if (/^\/proc(\/|$)/.test(c) && !/^\/proc\/(cpuinfo|meminfo|version|loadavg|uptime)$/.test(c)) return "/proc chứa environ/cmdline/fd của tiến trình (secret)";
		if (isInside(c, agentDir) && /^(models|models-store|auth)\.json$/.test(name)) return `'${name}' trong thư mục agent chứa credential`;
	}
	return null;
}

export function protectedWrite(r: Resolved, agentDir: string): string | null {
	const pr = protectedRead(r, agentDir);
	if (pr) return pr;
	for (const c of [r.lex, r.real]) {
		const parts = c.split(path.sep);
		if (parts.includes(".git")) return "thư mục .git (lịch sử/cấu hình repo)";
		if (parts.includes(".pi")) return "thư mục .pi (cấu hình/extension của agent)";
		if (isInside(c, agentDir)) return "thư mục cấu hình agent (chứa chính sách, extension, credential, audit)";
	}
	return null;
}

// ---------- che secret ----------

let secretValues: string[] | undefined;
export function secrets(): string[] {
	if (!secretValues) {
		secretValues = Object.entries(process.env)
			.filter(([k, v]) => /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i.test(k) && typeof v === "string" && v.length >= 8)
			.map(([, v]) => v as string)
			.sort((a, b) => b.length - a.length);
	}
	return secretValues;
}

export function scrub(text: string): string {
	let out = text;
	for (const s of secrets()) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
	return out
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]")
		.replace(/\b(api[_-]?key|token|secret|passw(?:or)?d|authorization|auth)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, "$1$2[REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]")
		.replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[REDACTED]@")
		.replace(/(\s-u\s+[^\s:]+:)\S+/g, "$1[REDACTED]");
}

// ---------- audit ----------

/**
 * Ghi audit.log. LƯU Ý: file này nằm trong vùng sandbox ghi được => KHÔNG TIN CẬY làm bằng chứng
 * (mã trong sandbox xóa/sửa/chèn dòng giả được). Nhật ký tin cậy là bản phía host. Lỗi ghi không được làm sập agent.
 */
export function audit(agentDir: string, enabled: boolean, rec: Record<string, unknown>): void {
	if (!enabled) return;
	try {
		fs.mkdirSync(agentDir, { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...rec });
		// O_NOFOLLOW: không đi theo symlink do ai đó đặt thay audit.log
		const fd = fs.openSync(path.join(agentDir, "audit.log"), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
		try {
			fs.writeSync(fd, `${line}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		/* audit lỗi không được làm sập agent */
	}
}
