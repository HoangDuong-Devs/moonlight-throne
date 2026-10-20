/**
 * Bộ phân tích shell tối giản, thận trọng (fail-closed) + engine WHITELIST CỜ cho bot-permissions và plan-mode.
 * Không thực thi gì. Gồm hai phần:
 *  1. parseShell: tách lệnh thành các "đoạn" (segment) theo ; && || | & xuống dòng, tách token có tôn trọng
 *     dấu nháy, và phát hiện: command substitution, redirect, heredoc, mở rộng ($VAR, ${..}, $1, $?, $'..', brace {a,b},
 *     tilde ~user) và glob (* ? [) ngoài dấu nháy.
 *  2. vetCommand: với từng lệnh đã biết (ls, cat, grep, find, sed, git...), CHỈ chấp nhận các cờ nằm trong whitelist
 *     và kiểm tra đường dẫn qua callback của người gọi. Cờ/lệnh lạ => chặn (fail-closed).
 *
 * (File này PHẢI GIỐNG HỆT bản ở plan-mode/shell.ts; sửa thì sửa cả hai: `cp bot-permissions/shell.ts plan-mode/shell.ts`.)
 */

export interface Token {
	/** Nội dung sau khi bỏ dấu nháy. */
	text: string;
	/** Có ký tự glob (* ? [) nằm ngoài dấu nháy. */
	glob: boolean;
	/** Có mở rộng ngoài nháy đơn: $VAR, ${..}, $1, $?, $'..', {a,b}, ~user. Bash sẽ đổi nội dung token lúc chạy. */
	expands: boolean;
}

export interface Redirect {
	op: string;
	target: string;
	expands: boolean;
	glob: boolean;
}

export interface Segment {
	tokens: Token[];
	/** Dấu phân cách đứng TRƯỚC đoạn này: "" (đầu), "|", "&&", "||", ";", "&". */
	sep: string;
	redirects: Redirect[];
	/** Văn bản đoạn (khoảng trắng đã gọn), dùng để khớp mẫu. */
	text: string;
}

export interface Parsed {
	segments: Segment[];
	/** $( ... ), `...`, <( ), >( ). */
	substitution: boolean;
	heredoc: boolean;
	/** Có ( ) ngoài nháy: subshell/nhóm lệnh, không hỗ trợ. */
	group: boolean;
	unterminated: boolean;
}

const MAX_LEN = 16000;
const DOLLAR_UNQUOTED = /[A-Za-z0-9_{@*#?$!'"-]/;
const DOLLAR_QUOTED = /[A-Za-z0-9_{@*#?$!-]/;
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

export function parseShell(input: string): Parsed {
	const out: Parsed = { segments: [], substitution: false, heredoc: false, group: false, unterminated: false };
	if (input.length > MAX_LEN || /[\r\0]/.test(input)) {
		out.unterminated = true;
		return out;
	}
	let seg: Segment = { tokens: [], sep: "", redirects: [], text: "" };
	let segStart = 0;
	let cur = "";
	/** Song song với cur: ký tự nguyên văn nếu nằm ngoài nháy/escape, "\0" nếu được che. */
	let curU = "";
	let inTok = false;
	let glob = false;
	let expands = false;
	let pendingRedirect: string | null = null;
	let nextSep = "";

	const pushTok = () => {
		if (!inTok) return;
		if (BRACE_EXPANSION.test(curU)) expands = true;
		if (curU[0] === "~" && cur.length > 1 && cur[1] !== "/") expands = true; // ~user, ~+, ~-
		if (pendingRedirect !== null) {
			// dup fd như 2>&1 hoặc >&- : bỏ qua
			if (!(pendingRedirect.endsWith("&") && /^(\d+|-)$/.test(cur))) {
				seg.redirects.push({ op: pendingRedirect, target: cur, expands, glob });
			}
			pendingRedirect = null;
		} else {
			seg.tokens.push({ text: cur, glob, expands });
		}
		cur = "";
		curU = "";
		inTok = false;
		glob = false;
		expands = false;
	};
	const endSeg = (i: number, sepAfter: string) => {
		pushTok();
		seg.text = input.slice(segStart, i).trim().replace(/\s+/g, " ");
		if (seg.tokens.length > 0 || seg.redirects.length > 0) out.segments.push(seg);
		seg = { tokens: [], sep: sepAfter, redirects: [], text: "" };
		nextSep = sepAfter;
	};
	const lit = (s: string) => {
		cur += s;
		curU += "\0".repeat(s.length);
	};

	let i = 0;
	while (i < input.length) {
		const c = input[i];
		if (c === "\\") {
			if (i + 1 < input.length) {
				if (input[i + 1] === "\n") {
					i += 2;
					continue;
				}
				lit(input[i + 1]);
				inTok = true;
				i += 2;
				continue;
			}
			out.unterminated = true;
			break;
		}
		if (c === "'") {
			const end = input.indexOf("'", i + 1);
			if (end < 0) {
				out.unterminated = true;
				break;
			}
			lit(input.slice(i + 1, end));
			inTok = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			inTok = true;
			i++;
			let closed = false;
			while (i < input.length) {
				const d = input[i];
				if (d === "\\" && i + 1 < input.length) {
					const n = input[i + 1];
					if ('"\\$`'.includes(n)) lit(n);
					else lit(d + n);
					i += 2;
					continue;
				}
				if (d === '"') {
					closed = true;
					i++;
					break;
				}
				if (d === "`") out.substitution = true;
				if (d === "$") {
					const n = input[i + 1] ?? "";
					if (n === "(") out.substitution = true;
					else if (DOLLAR_QUOTED.test(n)) expands = true;
				}
				lit(d);
				i++;
			}
			if (!closed) {
				out.unterminated = true;
				break;
			}
			continue;
		}
		if (c === "`") {
			out.substitution = true;
			lit(c);
			inTok = true;
			i++;
			continue;
		}
		if (c === "$") {
			const n = input[i + 1] ?? "";
			if (n === "(") out.substitution = true;
			else if (DOLLAR_UNQUOTED.test(n)) expands = true;
			cur += c;
			curU += c;
			inTok = true;
			i++;
			continue;
		}
		if (c === "#" && !inTok) {
			// comment tới hết dòng
			while (i < input.length && input[i] !== "\n") i++;
			continue;
		}
		if (c === " " || c === "\t") {
			pushTok();
			i++;
			continue;
		}
		if (c === "\n") {
			endSeg(i, ";");
			segStart = i + 1;
			i++;
			continue;
		}
		if (c === ";") {
			endSeg(i, ";");
			segStart = i + 1;
			i++;
			continue;
		}
		if (c === "|") {
			const sep = input[i + 1] === "|" ? "||" : "|";
			endSeg(i, sep);
			i += sep.length;
			if (sep === "|" && input[i] === "&") i++;
			segStart = i;
			continue;
		}
		if (c === "&") {
			if (input[i + 1] === ">") {
				// &> file
				pushTok();
				i += input[i + 2] === ">" ? 3 : 2;
				pendingRedirect = "&>";
				continue;
			}
			const sep = input[i + 1] === "&" ? "&&" : "&";
			endSeg(i, sep);
			i += sep.length;
			segStart = i;
			continue;
		}
		if (c === "<" || c === ">") {
			if (input[i + 1] === "(") {
				out.substitution = true;
				i += 2;
				continue;
			}
			if (c === "<" && input[i + 1] === "<") {
				out.heredoc = true;
				i += input[i + 2] === "<" ? 3 : 2;
				// ở đây chỉ đánh dấu; hầu hết caller sẽ chặn heredoc
				continue;
			}
			// fd số đứng trước (2>) : bỏ token số
			if (inTok && /^\d+$/.test(cur)) {
				cur = "";
				curU = "";
				inTok = false;
			} else {
				pushTok();
			}
			let op = c;
			i++;
			if (input[i] === ">" && c === ">") {
				op += ">";
				i++;
			} else if (input[i] === "&") {
				op += "&";
				i++;
			} else if (input[i] === "|") {
				i++;
			}
			pendingRedirect = op;
			continue;
		}
		if (c === "(" || c === ")") out.group = true;
		if (c === "*" || c === "?" || c === "[") glob = true;
		cur += c;
		curU += c;
		inTok = true;
		i++;
	}
	if (pendingRedirect !== null && !inTok) out.unterminated = true;
	endSeg(input.length, nextSep);
	return out;
}

/** Chuyển glob đơn giản (* ? **) thành RegExp. `*` khớp mọi ký tự (kể cả khoảng trắng). */
export function globToRegExp(glob: string, opts: { pathMode?: boolean } = {}): RegExp {
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (opts.pathMode) {
				if (glob[i + 1] === "*") {
					i++;
					if (glob[i + 1] === "/") {
						i++;
						re += "(?:.*/)?";
					} else re += ".*";
				} else re += "[^/]*";
			} else {
				while (glob[i + 1] === "*") i++;
				re += ".*";
			}
		} else if (c === "?") re += opts.pathMode ? "[^/]" : ".";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${re}$`, "s");
}

// =====================================================================================================
// Engine whitelist cờ
// =====================================================================================================

/** Kết quả chặn. Tương thích với Decision của index.ts (ask: cần duyệt thay vì chặn cứng). */
export type Fail = { rule: string; reason: string; ask?: { pattern: string } };

export interface VetCtx {
	/** "bot": tập lệnh của bot (gồm mkdir/touch/cp/mv, git ghi cần duyệt). "readonly": plan-mode, tập hẹp hơn. */
	mode: "bot" | "readonly";
	/** Kiểm tra ĐỌC một đường dẫn (không chứa glob). null = ổn. */
	read(p: string): Fail | null;
	/** Kiểm tra file nhập do CỜ chỉ định (jq --rawfile, grep -f...): đọc được VÀ nằm trong jail. Mặc định như read. */
	readJail?(p: string): Fail | null;
	/** Gốc của duyệt đệ quy (grep -r, rg, find, ls -R, tree, du...): không được là tổ tiên của vùng nhạy cảm (/, home, agent-dir, /proc). */
	readTree?(p: string): Fail | null;
	/** Kiểm tra GHI/đích (jail + vùng bảo vệ). */
	write(p: string): Fail | null;
	/** Kiểm tra token đường dẫn có glob (ở thành phần cuối): phần cố định + file khớp. */
	readGlob(p: string): Fail | null;
}

function readGlob(ctx: VetCtx, p: string): Fail | null {
	const e = globStructureError(p);
	if (e) stop(e);
	return ctx.readGlob(p);
}

class Stop extends Error {
	fail: Fail;
	constructor(fail: Fail) {
		super(fail.reason);
		this.fail = fail;
	}
}
const stop = (reason: string): never => {
	throw new Stop({ rule: "shell-unsafe", reason });
};
const stopGlob = (): never =>
	stop("glob (* ? [) không nháy chỉ được dùng ở toán hạng đường dẫn của lệnh đọc/liệt kê (ls, cat, grep, find...). Đặt mẫu trong dấu nháy hoặc liệt kê file tường minh.");

interface Spec {
	/** Cờ ngắn không giá trị. */
	bool?: string;
	/** Cờ ngắn có giá trị dính liền (-U3), không lấy token kế. */
	att?: string;
	/** Cờ ngắn có giá trị (dính liền hoặc token kế). */
	val?: string;
	/** Cờ ngắn có giá trị là đường dẫn ĐỌC. */
	readShort?: string;
	/** Cờ ngắn có giá trị là đường dẫn GHI (đích). */
	writeShort?: string;
	/** Cờ dài không giá trị bắt buộc (cho phép --x=giá_trị tùy chọn). */
	long?: string[];
	/** Cờ dài có giá trị (--x=v hoặc --x v). */
	longVal?: string[];
	readLong?: string[];
	writeLong?: string[];
	/** Cờ dài nhận HAI giá trị (--arg name value). */
	long2?: string[];
	/** Cờ dài nhận hai giá trị, giá trị thứ hai là đường dẫn đọc. */
	long2read?: string[];
	/** Cho phép -NUM (head -20). */
	digits?: boolean;
	/** Cờ cung cấp mẫu (grep -e) nên toán hạng đầu không phải mẫu. */
	patShort?: string;
	patLong?: string[];
	/**
	 * paths: mọi toán hạng là đường dẫn; pat-paths: toán hạng đầu là mẫu/script; revs: rev hoặc pathspec; free: không phải đường dẫn;
	 * none: không có toán hạng.
	 */
	pos: "paths" | "pat-paths" | "revs" | "free" | "none";
	patOptional?: boolean;
	maxPos?: number;
	/** Toán hạng paths là đích ghi (mkdir/touch/cp/mv). */
	write?: boolean;
	/** Lệnh duyệt đệ quy: "always" hoặc danh sách cờ (ngắn/dài) bật đệ quy. */
	rec?: "always" | { short: string; long: string[] };
	/** Có dùng trong plan-mode (chỉ-đọc). */
	ro: boolean;
	/** Chỉ dùng ở chế độ readonly (không thuộc tập lệnh của bot, vd node --version). */
	roOnly?: boolean;
	post?: (sc: Scanned, ctx: VetCtx) => void;
}

interface Scanned {
	flags: Set<string>;
	pos: Token[];
	reads: Token[];
	writes: Token[];
	patGiven: boolean;
	pat?: Token;
}

function scan(cmd: string, spec: Spec, args: Token[]): Scanned {
	const s: Scanned = { flags: new Set(), pos: [], reads: [], writes: [], patGiven: false };
	const nope = (a: string): never => stop(`cờ '${a.slice(0, 40)}' của '${cmd}' không nằm trong whitelist (chặn để an toàn)`);
	let i = 0;
	let dd = false;
	const take = (): Token => {
		const t = args[++i];
		if (!t) return stop(`thiếu giá trị cho cờ của '${cmd}'`);
		if (t.glob) stopGlob();
		return t;
	};
	const lit = (text: string): Token => ({ text, glob: false, expands: false });
	for (; i < args.length; i++) {
		const tk = args[i];
		const a = tk.text;
		if (dd || a === "-" || !a.startsWith("-")) {
			s.pos.push(tk);
			continue;
		}
		if (tk.glob) {
			// `--include=*.ts` (không nháy): bash không khớp file nào thì giữ nguyên; tiền tố `--tên=` không đổi dù có file khớp.
			// Chỉ chấp nhận khi glob nằm SAU dấu '=' của cờ dài không-đường-dẫn đã whitelist.
			const eq0 = a.indexOf("=");
			const nm = eq0 > 2 && a.startsWith("--") && !/[*?[]/.test(a.slice(0, eq0)) ? a.slice(2, eq0) : "";
			if (!nm || !(spec.long?.includes(nm) || spec.longVal?.includes(nm))) stopGlob();
		}
		if (a === "--") {
			dd = true;
			continue;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
			const val = eq < 0 ? undefined : a.slice(eq + 1);
			if (spec.long?.includes(name)) s.flags.add(name);
			else if (spec.longVal?.includes(name)) {
				if (val === undefined) take();
				s.flags.add(name);
			} else if (spec.readLong?.includes(name)) s.reads.push(val !== undefined ? lit(val) : take());
			else if (spec.writeLong?.includes(name)) s.writes.push(val !== undefined ? lit(val) : take());
			else if (spec.long2?.includes(name)) {
				if (val !== undefined) nope(a);
				take();
				take();
			} else if (spec.long2read?.includes(name)) {
				if (val !== undefined) nope(a);
				take();
				s.reads.push(take());
			} else nope(a);
			if (spec.patLong?.includes(name)) s.patGiven = true;
			continue;
		}
		if (spec.digits && /^-\d+$/.test(a)) continue;
		for (let k = 1; k < a.length; k++) {
			const ch = a[k];
			const rest = a.slice(k + 1);
			if (spec.bool?.includes(ch)) {
				s.flags.add(ch);
				continue;
			}
			if (spec.att?.includes(ch)) {
				s.flags.add(ch);
				break;
			}
			if (spec.val?.includes(ch)) {
				if (!rest) take();
				s.flags.add(ch);
			} else if (spec.readShort?.includes(ch)) s.reads.push(rest ? lit(rest) : take());
			else if (spec.writeShort?.includes(ch)) s.writes.push(rest ? lit(rest) : take());
			else nope(a);
			if (spec.patShort?.includes(ch)) s.patGiven = true;
			break;
		}
	}
	return s;
}

function runSpec(cmd: string, spec: Spec, args: Token[], ctx: VetCtx): void {
	const sc = scan(cmd, spec, args);
	const chk = (f: Fail | null) => {
		if (f) throw new Stop(f);
	};
	for (const t of sc.reads) chk((ctx.readJail ?? ctx.read)(t.text));
	for (const t of sc.writes) chk(ctx.write(t.text));
	let pos = sc.pos;
	if (spec.pos === "none" && pos.length) stop(`'${cmd}' không nhận toán hạng`);
	if (spec.maxPos !== undefined && pos.length > spec.maxPos) stop(`'${cmd}' chỉ nhận tối đa ${spec.maxPos} toán hạng`);
	if (spec.pos === "pat-paths" && !sc.patGiven) {
		const p = pos[0];
		if (!p) {
			if (!spec.patOptional) stop(`'${cmd}' thiếu mẫu`);
		} else {
			if (p.glob) stopGlob();
			sc.pat = p;
			pos = pos.slice(1);
		}
	}
	spec.post?.(sc, ctx);
	if (spec.rec && ctx.readTree) {
		const on = spec.rec === "always" || [...sc.flags].some((f) => (f.length === 1 ? spec.rec.short.includes(f) : spec.rec.long.includes(f)));
		if (on) {
			const roots = pos.filter((t) => t.text !== "-" && !(spec.pos === "revs"));
			for (const t of roots.length ? roots : [{ text: ".", glob: false, expands: false }]) chk(ctx.readTree(t.text.replace(/[*?[][^/]*$/, "") || "."));
		}
	}
	for (const t of pos) {
		if (spec.pos === "free") {
			if (t.glob) stopGlob();
		} else if (spec.pos === "revs") {
			if (t.glob) stopGlob();
			if (t.text === "-") continue;
			// rev hoặc pathspec: luôn kiểm tra như đường dẫn (tên file bí mật), và phần sau ':' của 'REV:path'
			chk(ctx.read(t.text.replace(/^:+(\([^)]*\))?/, "") || "."));
			const colon = t.text.indexOf(":");
			if (colon > 0 && colon < t.text.length - 1) chk(ctx.read(t.text.slice(colon + 1)));
		} else if (t.text === "-") continue;
		else if (spec.write) {
			if (t.glob) stopGlob();
			chk(ctx.write(t.text));
		} else if (t.glob) chk(readGlob(ctx, t.text));
		else chk(ctx.read(t.text));
	}
}

// ---------- spec từng lệnh ----------

const SPECS: Record<string, Spec> = {
	ls: {
		rec: { short: "R", long: ["recursive"] },
		bool: "aAlhRrtSdF1pisnGgoXUcuvqBLkxm",
		long: ["all", "almost-all", "human-readable", "recursive", "reverse", "directory", "classify", "size", "inode", "dereference", "group-directories-first", "full-time", "color", "no-group", "numeric-uid-gid", "si", "literal", "hide-control-chars", "time", "sort", "time-style", "format", "indicator-style"],
		pos: "paths",
		ro: true,
	},
	cat: { bool: "nbsAEeTtuv", long: ["number", "number-nonblank", "squeeze-blank", "show-all", "show-ends", "show-tabs", "show-nonprinting"], pos: "paths", ro: true },
	head: { bool: "qv", val: "nc", digits: true, long: ["quiet", "silent", "verbose"], longVal: ["lines", "bytes"], pos: "paths", ro: true },
	tail: { bool: "qv", val: "nc", digits: true, long: ["quiet", "silent", "verbose"], longVal: ["lines", "bytes"], pos: "paths", ro: true },
	wc: { bool: "lwcmL", long: ["lines", "words", "bytes", "chars", "max-line-length"], pos: "paths", ro: true },
	sort: {
		bool: "bdfgiMhnRrsuVzcCm",
		val: "ktS",
		long: ["reverse", "numeric-sort", "unique", "ignore-case", "human-numeric-sort", "version-sort", "stable", "ignore-leading-blanks", "dictionary-order", "general-numeric-sort", "month-sort", "random-sort", "check", "merge", "zero-terminated", "ignore-nonprinting"],
		longVal: ["key", "field-separator", "buffer-size", "sort"],
		pos: "paths",
		ro: true,
	},
	uniq: { bool: "cdiuzD", val: "fsw", long: ["count", "repeated", "unique", "ignore-case", "zero-terminated"], longVal: ["skip-fields", "skip-chars", "check-chars"], pos: "paths", maxPos: 1, ro: true },
	diff: {
		rec: { short: "r", long: ["recursive"] },
		bool: "uqrNwBbiEZatsydT",
		val: "UCxLFIW",
		long: ["brief", "recursive", "new-file", "ignore-all-space", "ignore-space-change", "ignore-blank-lines", "ignore-case", "side-by-side", "text", "report-identical-files", "unidirectional-new-file", "color", "expand-tabs", "minimal", "speed-large-files", "no-dereference", "strip-trailing-cr", "ignore-trailing-space", "suppress-common-lines", "left-column", "show-c-function", "initial-tab", "normal", "unified", "context"],
		longVal: ["label", "ignore-matching-lines", "exclude", "width", "tabsize", "show-function-line", "palette"],
		pos: "paths",
		maxPos: 2,
		ro: true,
	},
	cmp: { bool: "lsb", val: "inI", long: ["verbose", "silent", "quiet", "print-bytes"], longVal: ["ignore-initial", "bytes"], pos: "paths", maxPos: 2, ro: true },
	file: { bool: "bikLnNs", long: ["brief", "mime", "mime-type", "mime-encoding", "dereference", "keep-going", "no-dereference"], pos: "paths", ro: true },
	stat: { bool: "Lft", val: "c", long: ["dereference", "file-system", "terse"], longVal: ["format", "printf"], pos: "paths", ro: true },
	du: {
		rec: "always",
		bool: "ahkmbscxLDPSH",
		val: "dt",
		long: ["all", "human-readable", "summarize", "total", "si", "bytes", "one-file-system", "apparent-size", "dereference", "count-links", "separate-dirs"],
		longVal: ["max-depth", "exclude", "threshold", "block-size"],
		pos: "paths",
		ro: true,
	},
	df: { bool: "hHkPTilax", long: ["human-readable", "si", "local", "all", "print-type"], longVal: ["type", "exclude-type", "output", "block-size"], pos: "paths", ro: true },
	tree: {
		rec: "always",
		bool: "adfhilnpqrstuvxDFNCSJ",
		val: "LPI",
		long: ["dirsfirst", "noreport", "gitignore", "prune", "du", "si", "inodes", "device", "ignore-case", "matchdirs", "noreport", "nolinks", "fflinks"],
		longVal: ["filelimit", "charset", "sort", "timefmt"],
		pos: "paths",
		ro: true,
	},
	pwd: { bool: "LP", pos: "none", ro: true },
	echo: { pos: "free", bool: "neE", ro: true },
	printf: { pos: "free", ro: true },
	true: { pos: "free", ro: true },
	false: { pos: "free", ro: true },
	grep: undefined as unknown as Spec, // gán bên dưới
	rg: undefined as unknown as Spec,
	fd: {
		bool: "HIisgFaL0pu",
		val: "teEdSjcC",
		long: ["hidden", "no-ignore", "ignore-case", "case-sensitive", "glob", "fixed-strings", "absolute-path", "follow", "full-path", "print0", "unrestricted", "one-file-system", "no-ignore-vcs", "no-ignore-parent", "color", "version"],
		longVal: ["type", "extension", "exclude", "max-depth", "min-depth", "size", "changed-within", "changed-before", "owner", "max-results", "threads"],
		pos: "pat-paths",
		patOptional: true,
		ro: true,
	},
	basename: { bool: "az", val: "s", long: ["multiple", "zero"], longVal: ["suffix"], pos: "free", ro: true },
	dirname: { bool: "z", long: ["zero"], pos: "free", ro: true },
	realpath: { bool: "Eemsqz", long: ["canonicalize-existing", "canonicalize-missing", "no-symlinks", "strip", "quiet", "zero"], pos: "paths", ro: true },
	readlink: { bool: "fenmqsvz", long: ["canonicalize", "canonicalize-existing", "canonicalize-missing", "no-newline", "quiet", "silent", "verbose", "zero"], pos: "paths", ro: true },
	nl: { val: "bhfdivnlsw", long: [], pos: "paths", ro: true },
	tr: { bool: "cdsCt", long: ["complement", "delete", "squeeze-repeats", "truncate-set1"], pos: "free", ro: true },
	cut: { bool: "sz", val: "bcdf", long: ["only-delimited", "zero-terminated", "complement"], longVal: ["bytes", "characters", "delimiter", "fields", "output-delimiter"], pos: "paths", ro: true },
	paste: { bool: "sz", val: "d", long: ["serial", "zero-terminated"], longVal: ["delimiters"], pos: "paths", ro: true },
	column: { bool: "tnxJe", val: "scoNORTH", pos: "paths", ro: true },
	rev: { pos: "paths", ro: true },
	tac: { pos: "paths", ro: true },
	fold: { bool: "bs", val: "w", long: ["bytes", "spaces"], longVal: ["width"], pos: "paths", ro: true },
	expand: { bool: "i", val: "t", long: ["initial"], longVal: ["tabs"], pos: "paths", ro: true },
	md5sum: { bool: "bctwz", long: ["binary", "text", "tag", "zero", "quiet", "status", "warn", "check"], pos: "paths", ro: true },
	sha1sum: undefined as unknown as Spec,
	sha256sum: undefined as unknown as Spec,
	cksum: { bool: "", pos: "paths", ro: true },
	seq: { bool: "w", val: "fs", digits: true, long: ["equal-width"], longVal: ["format", "separator"], pos: "free", ro: true },
	date: { bool: "uIR", val: "d", long: ["utc", "universal", "iso-8601", "rfc-email"], longVal: ["date"], pos: "free", ro: true },
	uname: { bool: "asnrvmpio", pos: "none", ro: true },
	whoami: { pos: "none", ro: true },
	id: { bool: "ugGnrzZ", pos: "free", ro: true },
	hostname: { bool: "sfidI", pos: "none", ro: true },
	uptime: { bool: "ps", pos: "none", ro: true },
	nproc: { long: ["all"], longVal: ["ignore"], pos: "none", ro: true },
	free: { bool: "bkmghtl", long: ["human", "si", "total", "lohi", "bytes", "kilo", "mega", "giga"], pos: "none", ro: true },
	which: { bool: "a", pos: "free", ro: true },
	type: { bool: "ptaP", pos: "free", ro: true },
	mkdir: { bool: "pv", val: "m", long: ["parents", "verbose"], longVal: ["mode"], pos: "paths", write: true, ro: false },
	touch: { bool: "acm", val: "dt", long: ["no-create"], longVal: ["date", "time"], readLong: ["reference"], readShort: "r", pos: "paths", write: true, ro: false },
	cp: { bool: "rRafnpvTiuPdx", writeShort: "t", long: ["recursive", "archive", "force", "no-clobber", "preserve", "verbose", "no-target-directory", "interactive", "update", "no-dereference"], writeLong: ["target-directory"], pos: "paths", write: true, ro: false },
	mv: { bool: "fnvTiu", writeShort: "t", long: ["force", "no-clobber", "verbose", "no-target-directory", "interactive", "update"], writeLong: ["target-directory"], pos: "paths", write: true, ro: false },
};
SPECS.sha1sum = SPECS.md5sum;
SPECS.sha256sum = SPECS.md5sum;

SPECS.grep = {
	bool: "EFGPiIvwxcLloqsHhnbTrRzaUZ",
	val: "ABCmdDe",
	readShort: "f",
	patShort: "ef",
	patLong: ["regexp", "file"],
	digits: true,
	long: ["extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "ignore-case", "no-ignore-case", "invert-match", "word-regexp", "line-regexp", "count", "color", "colour", "files-with-matches", "files-without-match", "only-matching", "quiet", "silent", "no-messages", "with-filename", "no-filename", "line-number", "byte-offset", "initial-tab", "null", "null-data", "text", "recursive", "dereference-recursive", "line-buffered", "no-group-separator", "unix-byte-offsets"],
	longVal: ["max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "binary-files", "directories", "devices", "label", "group-separator", "regexp"],
	readLong: ["file", "exclude-from"],
	pos: "pat-paths",
	ro: true,
};
SPECS.grep.rec = { short: "rR", long: ["recursive", "dereference-recursive"] };
SPECS.egrep = SPECS.grep;
SPECS.fgrep = SPECS.grep;
SPECS.rg = {
	bool: "iSsvwxcLlonNqHIuUaFPpb0.V",
	val: "ABCmetTgjEMdr",
	readShort: "f",
	patShort: "ef",
	patLong: ["regexp", "file", "files", "type-list"],
	digits: false,
	long: ["files", "files-with-matches", "files-without-match", "count", "count-matches", "line-number", "no-line-number", "ignore-case", "smart-case", "case-sensitive", "invert-match", "word-regexp", "line-regexp", "only-matching", "hidden", "no-hidden", "no-ignore", "no-ignore-vcs", "no-ignore-dot", "no-ignore-parent", "no-ignore-global", "no-ignore-exclude", "no-messages", "follow", "fixed-strings", "pcre2", "multiline", "multiline-dotall", "text", "binary", "null", "null-data", "heading", "no-heading", "column", "no-column", "stats", "json", "vimgrep", "trim", "color", "no-config", "with-filename", "no-filename", "type-list", "quiet", "unrestricted", "byte-offset", "crlf", "glob-case-insensitive", "no-unicode", "line-buffered", "block-buffered", "pretty", "passthru", "one-file-system", "max-columns-preview", "no-require-git", "no-binary", "version"],
	longVal: ["after-context", "before-context", "context", "max-count", "max-depth", "maxdepth", "glob", "iglob", "type", "type-not", "replace", "regexp", "sort", "sortr", "threads", "encoding", "max-columns", "max-filesize", "context-separator", "field-context-separator", "field-match-separator", "colors", "path-separator", "engine", "type-add"],
	readLong: ["file", "ignore-file"],
	pos: "pat-paths",
	ro: true,
};
SPECS.rg.rec = "always";
SPECS.fd.rec = "always";
SPECS.jq = {
	bool: "cCMrRsSnejaV",
	readShort: "f",
	patShort: "f",
	patLong: ["from-file"],
	long: ["compact-output", "color-output", "monochrome-output", "raw-output", "raw-input", "slurp", "sort-keys", "null-input", "exit-status", "join-output", "ascii-output", "tab", "seq", "stream", "unbuffered", "raw-output0", "version"],
	longVal: ["indent"],
	readLong: ["from-file"],
	long2: ["arg", "argjson"],
	long2read: ["rawfile", "slurpfile", "argfile"],
	pos: "pat-paths",
	ro: true,
	post: (sc) => {
		if (!sc.pat) return;
		const f = sc.pat.text;
		if (/(?<![A-Za-z0-9_.$"'@])env(?![A-Za-z0-9_])|\$ENV|input_filename|\$__prog_args|\$__loc__|get_search_list|modulemeta|(?<![A-Za-z0-9_.$"'@])(?:import|include)(?![A-Za-z0-9_])/.test(f))
			stop("jq: 'env'/$ENV/input_filename/import/include không được phép (lộ biến môi trường hoặc đọc file ngoài).");
	},
};
SPECS.sed = {
	bool: "n",
	long: ["quiet", "silent"],
	pos: "pat-paths",
	ro: true,
	post: (sc) => {
		if (!sc.flags.has("n") && !sc.flags.has("quiet") && !sc.flags.has("silent")) stop("sed chỉ cho phép dạng 'sed -n <địa chỉ>p [file]'");
		if (!sc.pat || !/^(\$|\d+)(,(\$|\d+))?p$/.test(sc.pat.text)) stop("sed chỉ cho phép script dạng 'N,Mp' (in dòng); cấm -e/-f/-i/-s và lệnh w/e/r/W/R.");
	},
};

// ---------- find ----------

const FIND_ZERO = new Set(["-print", "-print0", "-empty", "-prune", "-true", "-false", "-depth", "-mount", "-xdev", "-readable", "-writable", "-executable", "-nouser", "-nogroup", "-not", "!", "-a", "-and", "-o", "-or", "(", ")", ",", "-ls", "-quit", "-follow"]);
const FIND_ONE = new Set([
	"-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname", "-type", "-xtype", "-size",
	"-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-perm", "-user", "-group", "-uid", "-gid", "-links", "-inum", "-maxdepth",
	"-mindepth", "-regextype", "-printf", "-newermt", "-newerat", "-newerct",
]);

function vetFind(args: Token[], ctx: VetCtx): void {
	let i = 0;
	const chk = (f: Fail | null) => {
		if (f) throw new Stop(f);
	};
	while (i < args.length && /^-[HLP]$/.test(args[i].text)) i++;
	const isExpr = (t: string) => t.startsWith("-") || t === "!" || t === "(" || t === ")" || t === ",";
	let roots = 0;
	for (; i < args.length && !isExpr(args[i].text); i++, roots++) {
		chk(args[i].glob ? readGlob(ctx, args[i].text) : ctx.read(args[i].text));
		if (ctx.readTree) chk(ctx.readTree(args[i].text.replace(/[*?[][^/]*$/, "") || "."));
	}
	if (!roots && ctx.readTree) chk(ctx.readTree("."));
	for (; i < args.length; i++) {
		const t = args[i];
		if (t.glob) stopGlob();
		const a = t.text;
		if (FIND_ZERO.has(a)) continue;
		if (a === "-newer" || a === "-anewer" || a === "-cnewer") {
			const v = args[++i];
			if (!v) stop(`find: thiếu giá trị cho ${a}`);
			if (v.glob) stopGlob();
			chk((ctx.readJail ?? ctx.read)(v.text));
			continue;
		}
		if (FIND_ONE.has(a)) {
			const v = args[++i];
			if (!v) stop(`find: thiếu giá trị cho ${a}`);
			if (v.glob) stopGlob();
			continue;
		}
		stop(`find: '${a.slice(0, 40)}' không nằm trong whitelist (cấm -exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls; chỉ cho phép tiêu chí tìm và -print)`);
	}
}

// ---------- git ----------

const GIT_REV_LONG = [
	"stat", "shortstat", "numstat", "summary", "name-only", "name-status", "oneline", "abbrev-commit", "no-abbrev-commit", "graph", "decorate", "no-decorate",
	"all", "branches", "tags", "remotes", "first-parent", "merges", "no-merges", "reverse", "since", "until", "after", "before", "author", "committer",
	"grep", "all-match", "invert-grep", "regexp-ignore-case", "extended-regexp", "fixed-strings", "perl-regexp", "max-count", "skip", "follow", "no-color",
	"color", "cached", "staged", "patch", "no-patch", "unified", "raw", "patch-with-stat", "patch-with-raw", "minimal", "patience", "histogram",
	"diff-algorithm", "ignore-space-change", "ignore-all-space", "ignore-space-at-eol", "ignore-blank-lines", "ignore-cr-at-eol", "word-diff",
	"word-diff-regex", "color-words", "check", "find-renames", "find-copies", "find-copies-harder", "no-renames", "diff-filter", "stat-width",
	"stat-name-width", "stat-count", "dirstat", "full-index", "binary", "text", "relative", "abbrev", "pretty", "format", "date", "date-order",
	"topo-order", "author-date-order", "ancestry-path", "simplify-by-decoration", "left-right", "cherry-pick", "cherry-mark", "cherry", "boundary",
	"children", "parents", "source", "full-history", "dense", "sparse", "show-pulls", "min-parents", "max-parents", "use-mailmap", "mailmap",
	"no-mailmap", "show-notes", "no-notes", "exclude", "glob", "not", "count", "left-only", "right-only", "diff-merges", "cc", "no-ext-diff",
	"no-textconv", "exit-code", "quiet", "function-context", "show-function", "inter-hunk-context", "root", "no-prefix", "src-prefix", "dst-prefix",
	"pickaxe-all", "pickaxe-regex", "indent-heuristic", "no-indent-heuristic", "ws-error-highlight", "submodule", "ita-invisible-in-index",
	"no-merge-base", "merge-base", "no-walk", "do-walk", "since-as-filter", "date-order", "reflog", "remotes", "no-max-parents", "no-min-parents",
	"encoding", "expand-tabs", "no-expand-tabs", "abbrev-commit", "relative-date", "break-rewrites",
	"irreversible-delete", "ignore-submodules", "compact-summary", "ignore-matching-lines",
];
const GIT_REV_SPEC: Omit<Spec, "pos" | "ro"> = {
	bool: "pusqzwbaRiEFPcmrtvk",
	att: "UMCBlA",
	val: "SGLn",
	digits: true,
	long: GIT_REV_LONG,
};
const GIT_SUBS: Record<string, Spec> = {
	diff: { ...GIT_REV_SPEC, pos: "revs", ro: true },
	log: { ...GIT_REV_SPEC, pos: "revs", ro: true },
	show: { ...GIT_REV_SPEC, pos: "revs", ro: true },
	"rev-list": { ...GIT_REV_SPEC, pos: "revs", ro: true },
	shortlog: { ...GIT_REV_SPEC, bool: "snec" + GIT_REV_SPEC.bool, pos: "revs", ro: true },
	status: { bool: "sbvz", att: "u", long: ["short", "branch", "porcelain", "long", "verbose", "ignored", "ignore-submodules", "untracked-files", "renames", "no-renames", "show-stash", "ahead-behind", "no-ahead-behind", "column", "no-column", "null", "find-renames"], pos: "revs", ro: true },
	branch: {
		bool: "arvlq",
		long: ["all", "remotes", "verbose", "list", "show-current", "no-color", "color", "ignore-case", "merged", "no-merged", "contains", "no-contains", "sort", "format", "points-at", "abbrev", "no-abbrev"],
		pos: "free",
		ro: true,
		post: (sc) => {
			const listy = ["l", "list", "merged", "no-merged", "contains", "no-contains", "points-at"].some((f) => sc.flags.has(f));
			if (sc.pos.length && !listy) stop("git branch chỉ cho phép liệt kê (tạo/xóa/đổi tên nhánh không được phép)");
		},
	},
	"rev-parse": { bool: "q", long: ["show-toplevel", "git-dir", "absolute-git-dir", "git-common-dir", "abbrev-ref", "short", "is-inside-work-tree", "is-inside-git-dir", "is-bare-repository", "show-prefix", "show-cdup", "show-superproject-working-tree", "verify", "symbolic-full-name", "symbolic", "quiet", "sq", "all", "branches", "tags", "remotes", "show-object-format", "git-path"], pos: "revs", ro: true },
	"ls-files": { bool: "cdmoiksuvztf", val: "x", readShort: "X", long: ["cached", "deleted", "modified", "others", "ignored", "stage", "directory", "unmerged", "killed", "eol", "empty-directory", "no-empty-directory", "full-name", "deduplicate", "exclude-standard", "error-unmatch", "resolve-undo", "debug", "sparse", "format", "with-tree", "abbrev", "exclude-per-directory"], longVal: ["exclude"], readLong: ["exclude-from"], pos: "revs", ro: true },
	blame: { bool: "ltwpesfnb", val: "L", att: "MC", long: ["porcelain", "line-porcelain", "incremental", "root", "show-stats", "show-name", "show-number", "show-email", "progress", "no-progress", "date", "abbrev", "minimal", "reverse", "first-parent"], pos: "revs", ro: true },
	describe: { long: ["tags", "all", "always", "long", "dirty", "broken", "contains", "exact-match", "first-parent", "abbrev", "match", "exclude", "candidates"], pos: "revs", ro: true },
	"ls-tree": { bool: "rtdlz", long: ["name-only", "name-status", "full-name", "full-tree", "long", "abbrev", "object-only", "format"], pos: "revs", ro: true },
	"cat-file": { bool: "tspe", pos: "revs", ro: true },
	grep: {
		bool: "nIivwhHcalLEFPpqWz",
		val: "ABCme",
		patShort: "e",
		digits: true,
		long: ["cached", "untracked", "no-exclude-standard", "exclude-standard", "text", "ignore-case", "invert-match", "word-regexp", "extended-regexp", "basic-regexp", "fixed-strings", "perl-regexp", "line-number", "column", "files-with-matches", "name-only", "files-without-match", "count", "only-matching", "quiet", "no-color", "color", "heading", "break", "full-name", "show-function", "function-context", "and", "or", "not", "all-match", "null", "max-depth", "max-count", "after-context", "before-context", "context", "no-recursive"],
		patLong: [],
		pos: "pat-paths",
		ro: true,
	},
	remote: { bool: "v", long: ["verbose"], pos: "none", ro: true },
	tag: {
		bool: "l",
		att: "n",
		long: ["list", "contains", "no-contains", "points-at", "sort", "merged", "no-merged", "format", "column", "no-column", "ignore-case", "color", "no-color"],
		pos: "free",
		ro: true,
		post: (sc) => {
			if (sc.pos.length && !sc.flags.has("l") && !sc.flags.has("list")) stop("git tag chỉ cho phép liệt kê (-l)");
		},
	},
	stash: { pos: "free", ro: true, post: (sc) => {
		if (sc.pos.length !== 1 || !["list", "show"].includes(sc.pos[0].text)) stop("git stash chỉ cho phép 'list' hoặc 'show'");
	}, bool: "pu", long: ["stat", "patch", "include-untracked", "only-untracked"] },
};
/** Subcommand ghi: chỉ dùng ở chế độ bot (người điều phối duyệt qua bash.ask); ở đây chỉ chặn cờ nguy hiểm. */
const GIT_MUTATING = new Set(["add", "commit", "stash", "switch", "checkout", "merge", "rebase", "cherry-pick", "tag"]);
const GIT_DANGEROUS_FLAG = /^(--exec(-path)?(=.*)?|--upload-pack(=.*)?|--receive-pack(=.*)?|--git-dir(=.*)?|--work-tree(=.*)?|--interactive|--edit|--template(=.*)?|--gpg-sign(=.*)?|--no-verify|--file(=.*)?|--open-files-in-pager(=.*)?|--ext-diff|--output(=.*)?|-e|-i|-F|-c|-O.*|-S.*)$/;
const GIT_ALLOWED_GLOBAL = new Set(["--no-pager", "--no-optional-locks", "-P", "--no-replace-objects", "--literal-pathspecs", "--no-lazy-fetch"]);

function vetGit(args: Token[], ctx: VetCtx): void {
	const chk = (f: Fail | null) => {
		if (f) throw new Stop(f);
	};
	let i = 0;
	if (args.length === 1 && args[0].text === "--version") return;
	for (; i < args.length; i++) {
		const a = args[i].text;
		if (!a.startsWith("-")) break;
		if (args[i].glob) stopGlob();
		if (GIT_ALLOWED_GLOBAL.has(a)) continue;
		if (a === "-C") {
			const v = args[++i];
			if (!v) stop("git -C thiếu đường dẫn");
			if (v.glob) stopGlob();
			chk(ctx.write(v.text)); // phải nằm trong jail
			continue;
		}
		stop(`git: cờ toàn cục '${a.slice(0, 40)}' không được phép (cấm -c, --exec-path, --git-dir, --work-tree, --upload-pack...)`);
	}
	const sub = args[i]?.text;
	if (!sub) stop("git cần subcommand");
	const rest = args.slice(i + 1);
	if (sub && GIT_MUTATING.has(sub) && ctx.mode === "bot") {
		let dd = false;
		for (const t of rest) {
			if (t.glob) stopGlob();
			if (t.text === "--") {
				dd = true;
				continue;
			}
			if (!dd && t.text.startsWith("-")) {
				if (GIT_DANGEROUS_FLAG.test(t.text) || (sub === "rebase" && /^(-x|--exec.*)$/.test(t.text)))
					stop(`git ${sub}: cờ '${t.text.slice(0, 40)}' không được phép (chạy lệnh ngoài/mở editor/đọc cấu hình lạ)`);
			} else if (/[/~]|^\./.test(t.text)) chk(ctx.write(t.text));
		}
		return;
	}
	const spec = sub ? GIT_SUBS[sub] : undefined;
	if (!spec || !sub) return stop(`git '${sub}' không nằm trong tập lệnh git cho phép`);
	runSpec(`git ${sub}`, spec, rest, ctx);
}

// ---------- API ----------

const FREEFORM = new Set(["echo", "printf", "true", "false"]);
const ALIASES: Record<string, string> = { fdfind: "fd" };
/** Lệnh nằm trong whitelist engine ở chế độ này? */
export function knownCommand(cmd: string, mode: "bot" | "readonly"): boolean {
	const c = ALIASES[cmd] ?? cmd;
	if (c === "git") return true;
	if (c === "find") return true;
	if (c === "test") return true;
	if (mode === "readonly" && ["npm", "node", "python", "python3"].includes(c)) return true;
	const s = SPECS[c];
	return !!s && (mode === "bot" || s.ro);
}

/** Lệnh bị cấm tuyệt đối vì chạy lệnh qua pager/ngôn ngữ nhúng (bất kể chế độ). */
export const HARD_BLOCKED_CMDS = new Set(["less", "more", "man", "vi", "vim", "view", "nano", "emacs", "ed", "ex", "awk", "gawk", "mawk", "nawk", "bat", "batcat"]);

/**
 * Kiểm tra một lệnh đã biết. `tokens[0]` là tên lệnh (đã bỏ wrapper/gán biến). Trả null nếu ổn, ngược lại lý do chặn.
 * Gọi `knownCommand` trước; lệnh lạ => caller tự quyết định (plan-mode: chặn).
 */
export function vetCommand(tokens: Token[], ctx: VetCtx): Fail | null {
	if (!tokens.length) return null;
	const head = tokens[0];
	const cmd0 = head.text.split("/").pop() ?? head.text;
	const cmd = ALIASES[cmd0] ?? cmd0;
	const args = tokens.slice(1);
	try {
		if (head.expands) stop("tên lệnh có mở rộng biến/brace; không được phép");
		if (head.glob) stop("tên lệnh có glob; không được phép");
		if (HARD_BLOCKED_CMDS.has(cmd)) stop(`'${cmd}' bị cấm (pager/trình soạn thảo/ngôn ngữ nhúng chạy được lệnh ngoài).`);
		if (!knownCommand(cmd, ctx.mode)) return { rule: "shell-unsafe", reason: `lệnh '${cmd}' không nằm trong danh sách lệnh được phép` };
		if (FREEFORM.has(cmd)) {
			for (const a of args) if (a.glob) stopGlob();
		} else if (cmd === "git") vetGit(args, ctx);
		else if (cmd === "find") vetFind(args, ctx);
		else if (cmd === "test") {
			for (const a of args) if (a.glob) stopGlob();
			for (const a of args) if (/[/~]|^\./.test(a.text)) {
				const f = ctx.read(a.text);
				if (f) return f;
			}
		} else if (ctx.mode === "readonly" && (cmd === "node" || cmd === "python" || cmd === "python3")) {
			if (!(args.length === 1 && /^(-v|-V|--version)$/.test(args[0].text))) stop(`${cmd} chỉ cho phép --version ở plan-mode`);
		} else if (ctx.mode === "readonly" && cmd === "npm") {
			const sub = args.find((a) => !a.text.startsWith("-"));
			if (!sub || !["ls", "list"].includes(sub.text)) stop("npm chỉ cho phép 'ls' ở plan-mode");
			runSpec("npm ls", { bool: "al", long: ["json", "all", "long", "production", "prod", "dev", "parseable", "omit", "depth", "global"], pos: "free", ro: true, post: () => {} }, args.filter((a) => a !== sub), ctx);
		} else runSpec(cmd, SPECS[cmd], args, ctx);
	} catch (e) {
		if (e instanceof Stop) return e.fail;
		throw e;
	}
	return null;
}

/** Kiểm tra cấu trúc glob ở toán hạng đường dẫn: chỉ cho ở thành phần cuối. Trả null nếu ổn. */
export function globStructureError(p: string): string | null {
	const dir = p.slice(0, Math.max(0, p.lastIndexOf("/")));
	if (/[*?[]/.test(dir)) return "glob chỉ được đặt ở thành phần CUỐI của đường dẫn (không glob trong tên thư mục); liệt kê thư mục tường minh.";
	return null;
}
