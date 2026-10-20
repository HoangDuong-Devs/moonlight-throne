/**
 * apply_patch: cổng hành vi từ opencode (tool/plugin/patch.ts + util/patch.ts).
 * Parser tự viết, không thêm dependency. Kiểm tra toàn bộ trước khi ghi; ghi lỗi giữa chừng thì hoàn tác.
 */
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

// ---------- mô tả tool (patch.txt của opencode, giữ nguyên + vài lưu ý cho Pi) ----------
const DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- Paths are relative to the working directory; paths outside it are rejected.
- In an Update File section, each change starts with \`@@\` (optionally followed by a context line such as a function signature), then lines prefixed with space (context), \`-\` (remove) or \`+\` (add).
- The whole patch is validated before anything is written; if any part fails, no file is changed.`;

// ---------- parser ----------
export type UpdateChunk = { oldLines: string[]; newLines: string[]; changeContext?: string; endOfFile?: boolean };
export type Hunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

class PatchError extends Error {}

const isBoundary = (l: string) =>
	l === "*** End Patch" || l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ");

const stripHeredoc = (s: string) => s.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? s;

function invalid(line: string, lineNumber: number, reason?: string): PatchError {
	return new PatchError(
		reason
			? `Invalid hunk at line ${lineNumber}: ${reason}`
			: `Invalid hunk at line ${lineNumber}: '${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
	);
}

export function parsePatch(patchText: string): Hunk[] {
	const lines = stripHeredoc(patchText.trim())
		.split("\n")
		.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (lines[0]?.trim() !== "*** Begin Patch") throw new PatchError("The first line of the patch must be '*** Begin Patch'");
	const end = lines.length - 1;
	if (end < 1 || lines[end].trim() !== "*** End Patch") throw new PatchError("The last line of the patch must be '*** End Patch'");

	const hunks: Hunk[] = [];
	let i = 1;
	while (i < end) {
		const header = lines[i].trim();
		if (header.startsWith("*** Add File: ")) {
			const path = header.slice("*** Add File: ".length).trim();
			const content: string[] = [];
			i++;
			while (i < end && !isBoundary(lines[i].trim())) {
				if (!lines[i].startsWith("+")) {
					const l = lines[i].trim();
					throw invalid(l, i + 1, `Invalid Add File line for '${path}': expected a line starting with '+', got '${l}'`);
				}
				content.push(lines[i].slice(1));
				i++;
			}
			hunks.push({ type: "add", path, contents: content.join("\n") });
			continue;
		}
		if (header.startsWith("*** Delete File: ")) {
			const path = header.slice("*** Delete File: ".length).trim();
			const next = lines[i + 1]?.trim();
			if (i + 1 < end && next !== undefined && !isBoundary(next)) {
				if (next.startsWith("*** ")) throw invalid(next, i + 2);
				throw invalid(next, i + 2, `Unexpected line after Delete File '${path}': '${next}'. Delete hunks do not contain body lines`);
			}
			hunks.push({ type: "delete", path });
			i++;
			continue;
		}
		if (header.startsWith("*** Update File: ")) {
			const path = header.slice("*** Update File: ".length).trim();
			let next = i + 1;
			let movePath: string | undefined;
			while (lines[next]?.trimEnd() === "*** End of File") next++;
			const move = lines[next]?.trimEnd();
			if (move === "*** Move to:" || move?.startsWith("*** Move to: ")) {
				movePath = move.slice("*** Move to: ".length).trim();
				if (!movePath) throw invalid(move, next + 1, `Move destination for '${path}' must not be empty`);
				next++;
			}
			const parsed = parseUpdate(lines, next, end, path, i);
			hunks.push({ type: "update", path, movePath, chunks: parsed.chunks });
			i = parsed.next;
			continue;
		}
		throw invalid(header, i + 1);
	}
	return hunks;
}

function parseUpdate(lines: string[], start: number, end: number, path: string, hunk: number) {
	const chunks: UpdateChunk[] = [];
	let i = start;
	let afterEof = false;
	const unexpected = (line: string, n: number, populated: boolean) =>
		invalid(
			line,
			n,
			populated
				? `Expected update hunk to start with a @@ context marker, got: '${line}'`
				: `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
		);
	while (i < end) {
		const line = lines[i];
		const t = line.trimEnd();
		if (afterEof) {
			if (t === "") {
				i++;
				continue;
			}
			if (t === "@@" || t.startsWith("@@ ")) afterEof = false;
			else if (isBoundary(t)) break;
			else throw invalid(line, i + 1, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
		}
		if (t === "*** End of File") {
			const c = chunks.at(-1);
			if (c && c.oldLines.length === 0 && c.newLines.length === 0)
				throw invalid(t, i + 1, "Update hunk does not contain any lines");
			if (c) {
				c.endOfFile = true;
				afterEof = true;
			}
			i++;
			continue;
		}
		if (isBoundary(t)) break;
		if (t === "@@" || t.startsWith("@@ ")) {
			const prev = chunks.at(-1);
			if (prev && prev.oldLines.length === 0 && prev.newLines.length === 0) throw unexpected(line, i + 1, false);
			chunks.push({ oldLines: [], newLines: [], changeContext: t === "@@" ? undefined : t.slice(3) });
			i++;
			continue;
		}
		if (chunks.length === 0) chunks.push({ oldLines: [], newLines: [] });
		const c = chunks.at(-1)!;
		if (line === "") {
			c.oldLines.push("");
			c.newLines.push("");
		} else if (line.startsWith(" ")) {
			c.oldLines.push(line.slice(1));
			c.newLines.push(line.slice(1));
		} else if (line.startsWith("-")) c.oldLines.push(line.slice(1));
		else if (line.startsWith("+")) c.newLines.push(line.slice(1));
		else throw unexpected(line, i + 1, c.oldLines.length > 0 || c.newLines.length > 0);
		i++;
	}
	if (chunks.length === 0) throw invalid(lines[hunk].trim(), hunk + 1, `Update file hunk for path '${path}' is empty`);
	const last = chunks.at(-1)!;
	if (last.oldLines.length === 0 && last.newLines.length === 0) {
		const l = (lines[i] ?? "").trim();
		throw invalid(
			l,
			i + 1,
			l === "*** End Patch"
				? "Update hunk does not contain any lines"
				: `Unexpected line found in update hunk: '${l}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
		);
	}
	return { chunks, next: i };
}

// ---------- áp chunk vào nội dung ----------
const norm = (v: string) =>
	v
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[  -   　]/g, " ");
const COMPARERS: Array<(a: string, b: string) => boolean> = [
	(a, b) => a === b,
	(a, b) => a.trimEnd() === b.trimEnd(),
	(a, b) => a.trim() === b.trim(),
	(a, b) => norm(a.trim()) === norm(b.trim()),
];

function seek(lines: string[], pattern: string[], start: number, eof = false): number {
	if (pattern.length === 0) return -1;
	const at = (off: number, cmp: (a: string, b: string) => boolean) => pattern.every((p, k) => cmp(lines[off + k], p));
	if (eof) {
		const off = lines.length - pattern.length;
		if (off < start) return -1;
		return COMPARERS.some((cmp) => at(off, cmp)) ? off : -1;
	}
	for (const cmp of COMPARERS) for (let off = start; off <= lines.length - pattern.length; off++) if (at(off, cmp)) return off;
	return -1;
}

export function deriveUpdate(path: string, chunks: UpdateChunk[], original: string): string {
	const bom = original.startsWith("\ufeff");
	const text = bom ? original.slice(1) : original;
	// tách dòng theo "\n"; "\r" cuối dòng được nhớ riêng để giữ nguyên kết thúc dòng gốc từng dòng
	const raw = text.split("\n");
	const hadFinalNewline = raw.length > 1 && raw.at(-1) === "";
	if (raw.at(-1) === "") raw.pop();
	const lines = raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	const eols = raw.map((l) => (l.endsWith("\r") ? "\r\n" : "\n"));
	const crlf = eols.filter((e) => e === "\r\n").length;
	const dominant = crlf * 2 > eols.length ? "\r\n" : "\n";
	const reps: Array<[number, number, string[]]> = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.changeContext) {
			const ctx = seek(lines, [chunk.changeContext], lineIndex);
			if (ctx === -1) throw new PatchError(`Failed to find context '${chunk.changeContext}' in ${path}`);
			lineIndex = ctx + 1;
		}
		if (chunk.oldLines.length === 0) {
			reps.push([lines.length, 0, chunk.newLines]);
			continue;
		}
		let oldL = chunk.oldLines;
		let newL = chunk.newLines;
		let found = seek(lines, oldL, lineIndex, chunk.endOfFile);
		if (found === -1 && oldL.at(-1) === "") {
			oldL = oldL.slice(0, -1);
			if (newL.at(-1) === "") newL = newL.slice(0, -1);
			found = seek(lines, oldL, lineIndex, chunk.endOfFile);
		}
		if (found === -1 && chunk.oldLines.every((l) => l === "")) {
			throw new PatchError(
				`Failed to find ${chunk.oldLines.length === 1 ? "an expected blank line" : `${chunk.oldLines.length} consecutive blank lines`} in ${path}`,
			);
		}
		if (found === -1) throw new PatchError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
		reps.push([found, oldL.length, newL]);
		lineIndex = found + oldL.length;
	}
	reps.sort((a, b) => a[0] - b[0]);
	const touchedEnd = reps.some(([s, r]) => s + r >= lines.length);
	for (const [s, r, ins] of reps.reverse()) {
		// dòng thay thế giữ EOL của dòng cũ cùng vị trí; dòng thêm kế thừa EOL dòng liền trước (hoặc EOL chủ đạo)
		const inheritFrom = r > 0 ? eols[s + r - 1] : s > 0 ? eols[s - 1] : dominant;
		const newEols = ins.map((_, k) => (k < r ? eols[s + k] : inheritFrom));
		lines.splice(s, r, ...ins);
		eols.splice(s, r, ...newEols);
	}
	const finalNewline = touchedEnd || hadFinalNewline || lines.length === 0;
	let out = "";
	for (let k = 0; k < lines.length; k++) out += lines[k] + (k < lines.length - 1 || finalNewline ? eols[k] : "");
	return (bom ? "\ufeff" : "") + out;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Giải mã UTF-8 nghiêm ngặt; ném PatchError nếu file không phải UTF-8 hợp lệ (tránh làm hỏng byte). */
function decodeUtf8(buf: Buffer, display: string): string {
	try {
		return strictUtf8.decode(buf);
	} catch {
		throw new PatchError(
			`${display} is not valid UTF-8 (binary or legacy-encoded file); refusing to Update it to avoid corrupting its bytes. Use another tool for this file`,
		);
	}
}

// ---------- đường dẫn ----------
const inside = (base: string, p: string) => {
	const r = relative(base, p);
	return !(r === ".." || r.startsWith(".." + sep) || isAbsolute(r));
};

/**
 * Kiểm tra từng thành phần đường dẫn bằng lstat (không dùng realpath của tổ tiên: symlink treo sẽ lọt).
 * - Thành phần cuối là symlink (kể cả treo) => từ chối.
 * - Thành phần giữa là symlink => chỉ chấp nhận nếu trỏ tới thư mục TỒN TẠI nằm trong cwd.
 */
async function resolveInside(cwd: string, p: string): Promise<string> {
	if (!p) throw new PatchError("empty path in patch");
	const abs = resolve(cwd, p);
	const rel = relative(cwd, abs);
	if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
		throw new PatchError(`path '${p}' is outside the working directory (${cwd}); refusing to touch it`);
	const realCwd = await realpath(cwd);
	const parts = rel.split(sep);
	let cur = realCwd;
	for (let k = 0; k < parts.length; k++) {
		cur = join(cur, parts[k]);
		let st;
		try {
			st = await lstat(cur);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException)?.code;
			if (code === "ENOENT") break; // phần còn lại chưa tồn tại: không có gì để đi theo
			throw e;
		}
		if (!st.isSymbolicLink()) continue;
		if (k === parts.length - 1)
			throw new PatchError(`path '${p}' is a symbolic link; refusing to write through it`);
		let real: string;
		try {
			real = await realpath(cur);
		} catch {
			throw new PatchError(`path '${p}' passes through a dangling symbolic link; refusing to touch it`);
		}
		if (!inside(realCwd, real))
			throw new PatchError(`path '${p}' resolves (via symlink) outside the working directory; refusing to touch it`);
	}
	return abs;
}

// ---------- diff ngắn ----------
function shortDiff(before: string, after: string, label: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.at(-1) === "") a.pop();
	if (b.at(-1) === "") b.pop();
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const ctx = 2;
	const from = Math.max(0, p - ctx);
	const out: string[] = [`--- ${label}`];
	for (let k = from; k < p; k++) out.push(` ${a[k]}`);
	for (let k = p; k < a.length - s; k++) out.push(`-${a[k]}`);
	for (let k = p; k < b.length - s; k++) out.push(`+${b[k]}`);
	for (let k = a.length - s; k < Math.min(a.length, a.length - s + ctx); k++) out.push(` ${a[k]}`);
	if (out.length > 41) return [...out.slice(0, 40), `... (diff truncated, ${out.length - 40} more lines)`].join("\n");
	return out.join("\n");
}

// ---------- chuẩn bị & áp dụng ----------
type FileState = { buf: Buffer; mode?: number };
type Change = { kind: "add" | "update" | "delete"; display: string; abs: string; before: string; after: string; moveFrom?: string };

const asText = (b: Buffer) => b.toString("utf8");

async function readIfExists(abs: string): Promise<FileState | null> {
	let st;
	try {
		st = await lstat(abs);
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw e;
	}
	if (st.isSymbolicLink()) throw new PatchError(`${abs} is a symbolic link; refusing to follow it`);
	if (!st.isFile()) throw new PatchError(`${abs} is not a regular file`);
	return { buf: await readFile(abs), mode: st.mode & 0o7777 };
}

/** Ghi qua tệp tạm (O_EXCL, không theo symlink) rồi rename đè; giữ mode. */
async function writeAtomic(abs: string, buf: Buffer, mode?: number): Promise<void> {
	const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	const fh = await open(tmp, "wx", mode ?? 0o666);
	try {
		try {
			await fh.writeFile(buf);
		} finally {
			await fh.close();
		}
		if (mode !== undefined) await chmod(tmp, mode);
		await rename(tmp, abs);
	} catch (e) {
		await rm(tmp, { force: true }).catch(() => {});
		throw e;
	}
}

async function prepare(hunks: Hunk[], cwd: string) {
	// trạng thái ảo: abs -> nội dung + mode (null = đã xoá); để nhiều hunk cùng file nối tiếp nhau
	const state = new Map<string, FileState | null>();
	const get = async (abs: string) => (state.has(abs) ? state.get(abs)! : await readIfExists(abs));
	const changes: Change[] = [];
	for (const h of hunks) {
		const abs = await resolveInside(cwd, h.path);
		if (h.type === "add") {
			const content = h.contents.endsWith("\n") || h.contents === "" ? h.contents : h.contents + "\n";
			const cur = await get(abs);
			changes.push({ kind: "add", display: h.path, abs, before: cur ? asText(cur.buf) : "", after: content });
			state.set(abs, { buf: Buffer.from(content, "utf8"), mode: cur?.mode });
		} else if (h.type === "delete") {
			const cur = await get(abs);
			if (cur === null) throw new PatchError(`Failed to delete ${h.path}: file does not exist`);
			changes.push({ kind: "delete", display: h.path, abs, before: asText(cur.buf), after: "" });
			state.set(abs, null);
		} else {
			const cur = await get(abs);
			if (cur === null) throw new PatchError(`Failed to read file to update ${h.path}: file does not exist`);
			const next = deriveUpdate(h.path, h.chunks, decodeUtf8(cur.buf, h.path));
			const nextBuf = Buffer.from(next, "utf8");
			if (h.movePath) {
				const dest = await resolveInside(cwd, h.movePath);
				if (dest !== abs) {
					const existing = await get(dest);
					if (existing !== null)
						throw new PatchError(
							`Move destination ${h.movePath} already exists; refusing to overwrite it (delete it first in the same patch if intended)`,
						);
				}
				changes.push({ kind: "update", display: h.movePath, abs: dest, before: asText(cur.buf), after: next, moveFrom: abs });
				if (dest !== abs) state.set(abs, null);
				state.set(dest, { buf: nextBuf, mode: cur.mode });
			} else {
				changes.push({ kind: "update", display: h.path, abs, before: asText(cur.buf), after: next });
				state.set(abs, { buf: nextBuf, mode: cur.mode });
			}
		}
	}
	return { changes, finalState: state };
}

async function withLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const sorted = [...new Set(paths)].sort();
	const run = (idx: number): Promise<T> => (idx >= sorted.length ? fn() : withFileMutationQueue(sorted[idx], () => run(idx + 1)));
	return run(0);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: DESCRIPTION,
		promptSnippet: "Apply a multi-file patch (add/update/move/delete files) in one atomic call",
		parameters: Type.Object({
			patchText: Type.String({ description: "The full patch text describing add, update, and delete operations" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			if (!params.patchText) throw new Error("patchText is required");
			let hunks: Hunk[];
			try {
				hunks = parsePatch(params.patchText);
			} catch (e) {
				throw new Error(`patch verification failed: ${(e as Error).message}`);
			}
			if (hunks.length === 0) throw new Error("patch rejected: empty patch");

			// khoá theo đường dẫn tuyệt đối (resolve thô; đã kiểm tra thoát cwd ở prepare)
			const lockPaths = hunks.flatMap((h) => [resolve(cwd, h.path), ...(h.type === "update" && h.movePath ? [resolve(cwd, h.movePath)] : [])]);
			return withLocks(lockPaths, async () => {
				let prepared;
				try {
					prepared = await prepare(hunks, cwd);
				} catch (e) {
					throw new Error(`patch verification failed: ${(e as Error).message}`);
				}
				const { changes, finalState } = prepared;

				// sao lưu byte-chính-xác (kèm mode) để hoàn tác nếu ghi lỗi giữa chừng
				const backup = new Map<string, FileState | null>();
				for (const abs of finalState.keys()) backup.set(abs, await readIfExists(abs));
				const done: string[] = [];
				try {
					for (const [abs, content] of finalState) {
						await resolveInside(cwd, relative(cwd, abs)); // kiểm tra lại ngay trước khi ghi
						if (content === null) await rm(abs, { force: true });
						else {
							await mkdir(dirname(abs), { recursive: true });
							await resolveInside(cwd, relative(cwd, abs));
							await writeAtomic(abs, content.buf, content.mode);
						}
						done.push(abs);
					}
				} catch (e) {
					for (const abs of done.concat([...finalState.keys()])) {
						const old = backup.get(abs);
						try {
							if (old === null || old === undefined) await rm(abs, { force: true });
							else await writeAtomic(abs, old.buf, old.mode);
						} catch {
							/* best effort */
						}
					}
					throw new Error(`Failed to write patch (changes rolled back): ${(e as Error).message}`);
				}

				const sym = { add: "A", update: "M", delete: "D" } as const;
				const summary = changes.map((c) => `${sym[c.kind]} ${c.display}${c.moveFrom ? ` (moved from ${relative(cwd, c.moveFrom)})` : ""}`);
				const diffs = changes.map((c) => shortDiff(c.before, c.after, c.display));
				const text = ["Success. Updated the following files:", ...summary, "", ...diffs].join("\n");
				const files = [...new Set(changes.filter((c) => c.kind !== "delete").map((c) => c.abs))];
				return { content: [{ type: "text" as const, text }], details: { files } };
			});
		},
	});
}
