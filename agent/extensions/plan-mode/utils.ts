/**
 * Kiểm tra lệnh bash CHỈ-ĐỌC cho plan-mode (whitelist chặt, fail-closed), dùng chung engine với bot-permissions (./shell.ts).
 * Lệnh hợp lệ khi: không có command substitution/heredoc/mở rộng biến, redirect chỉ tới /dev/null, mọi đoạn (tách bởi ; && || |)
 * là lệnh trong tập chỉ-đọc của engine VÀ mọi cờ nằm trong whitelist của lệnh đó. Lệnh/cờ lạ => chặn.
 * Tập chỉ-đọc hẹp hơn tập của bot: không mkdir/touch/cp/mv, không npm/yarn/pip/go/cargo (đọc cấu hình chạy mã từ repo),
 * node/python chỉ --version, git chỉ subcommand đọc.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mthEnv } from "../../../lib/env.mjs";
import { parseShell, vetCommand, type Fail, type VetCtx } from "./shell.ts";

/** File/thư mục chứa secret: plan-mode tự chặn thêm một lớp (bot-permissions kiểm tra đầy đủ hơn khi cùng được nạp). */
const SECRET_PART = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|auth\.json|models(-store)?\.json|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)|\.(pem|key|p12|pfx)$|^\/proc\/[^/]+\/environ$/;

const secretFail = (p: string): Fail | null => (SECRET_PART.test(p) ? { rule: "protected-read", reason: `'${p.slice(0, 60)}' là file/thư mục chứa secret` } : null);

/** File nhập do cờ chỉ định (jq --rawfile, grep -f...) phải nằm trong thư mục làm việc. */
function jailFail(p: string): Fail | null {
	const s = secretFail(p);
	if (s) return s;
	const root = path.resolve(mthEnv("MTH_WORKDIR") || process.cwd());
	const abs = path.resolve(root, p.replace(/^@/, "").replace(/^~(?=\/|$)/, os.homedir()));
	let real = abs;
	try {
		real = fs.realpathSync(abs);
	} catch {
		/* chưa tồn tại: dùng đường dẫn tuyệt đối đã chuẩn hóa */
	}
	let rootReal = root;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		/* giữ nguyên */
	}
	return real === rootReal || real.startsWith(rootReal + path.sep) ? null : { rule: "path-jail", reason: `file nhập '${p.slice(0, 60)}' nằm ngoài thư mục làm việc` };
}

/** Duyệt đệ quy không được bắt đầu từ gốc / hoặc tổ tiên của thư mục home. */
function treeFail(p: string): Fail | null {
	let abs = path.resolve(mthEnv("MTH_WORKDIR") || process.cwd(), p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
	try {
		abs = fs.realpathSync(abs);
	} catch {
		/* giữ nguyên */
	}
	const home = os.homedir();
	if (abs === path.parse(abs).root || abs === home || home.startsWith(abs + path.sep) || /^\/proc(\/|$)/.test(abs))
		return { rule: "protected-read", reason: `duyệt đệ quy từ '${p.slice(0, 60)}' sẽ quét vùng nhạy cảm; chỉ định thư mục dự án cụ thể` };
	return null;
}

const CTX: VetCtx = {
	mode: "readonly",
	readTree: treeFail,
	read: (p) => secretFail(p),
	readJail: jailFail,
	write: (p) => ({ rule: "plan-mode", reason: `plan-mode chỉ-đọc: không ghi '${p.slice(0, 60)}'` }),
	readGlob: (p) => secretFail(p),
};

/** Trả về null nếu lệnh chỉ-đọc, ngược lại trả lý do (tiếng Việt, ngắn). */
export function whyNotReadOnly(command: string): string | null {
	const p = parseShell(command);
	if (p.unterminated) return "lệnh không phân tích được (dấu nháy/escape chưa đóng, ký tự \\r/NUL hoặc quá dài)";
	if (p.substitution) return "không cho phép command substitution ($(...), `...`, <(...))";
	if (p.heredoc) return "không cho phép heredoc";
	if (p.group) return "không cho phép subshell/nhóm lệnh ( )";
	if (p.segments.length === 0) return "lệnh rỗng";
	for (const seg of p.segments) {
		for (const r of seg.redirects) {
			if (r.target !== "/dev/null" || r.expands || r.glob) return `redirect ghi/đọc '${r.op} ${r.target}' không được phép`;
		}
		if (seg.tokens.length === 0) continue;
		const bad = seg.tokens.find((t) => t.expands);
		if (bad) return `token có mở rộng biến/brace/tilde ('${bad.text.slice(0, 40)}') không được phép`;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg.tokens[0].text)) return "gán biến môi trường đầu lệnh không được phép";
		const f = vetCommand(seg.tokens, CTX);
		if (f) return f.reason;
	}
	return null;
}
