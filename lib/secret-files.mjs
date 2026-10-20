// secret-files.mjs <dir>: liệt kê file/thư mục secret trong thư mục làm việc để lib/sandbox-exec.sh che (--ro-bind /dev/null | --tmpfs).
// Dùng ĐÚNG isSecretName/SECRET_DIRS của bot-permissions. Độ sâu tối đa 6, bỏ qua node_modules/.git/vendor, không theo symlink thư mục.
// Xuất mỗi mục một dòng "f <path>" (file) hoặc "d <path>" (thư mục credential), ngăn bằng NUL. Quá MAX mục => thoát 3 (wrapper từ chối chạy).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.resolve(new URL("..", import.meta.url).pathname);
const { isSecretName, SECRET_DIRS } = await import(pathToFileURL(path.join(HERE, "agent/extensions/bot-permissions/policy.ts")).href);
const MAX_DEPTH = 6, MAX = 5000, PRUNE = new Set(["node_modules", ".git", "vendor"]);
const root = path.resolve(process.argv[2] ?? ".");
const out = [];
function walk(dir, depth) {
	let ents;
	try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of ents) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (SECRET_DIRS.has(e.name)) out.push(`d ${p}`);
			else if (!PRUNE.has(e.name) && depth < MAX_DEPTH) walk(p, depth + 1);
		} else if ((e.isFile() || e.isSymbolicLink()) && isSecretName(e.name)) out.push(`f ${p}`);
		if (out.length > MAX) { process.stderr.write(`secret-files: quá ${MAX} mục\n`); process.exit(3); }
	}
}
walk(root, 1);
process.stdout.write(out.map((x) => x + "\0").join(""));
