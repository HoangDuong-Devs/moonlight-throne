/**
 * Kho grants + yêu cầu quyền (ask).
 *
 *   <agent-dir>/grants/<sessionId>.json           NGUỒN CHỈ DO NGƯỜI VẬN HÀNH GHI (lib/permissions-cli.mjs chạy NGOÀI sandbox).
 *                                                 { sessionId, grants: [{grantId,id,key,tool,subject,mode,createdAt,source:"cli"}] }
 *   <agent-dir>/grants-used/<sessionId>.json      SỔ "đã dùng" (chỉ-thêm), extension ghi; sandbox ghi được.
 *                                                 { sessionId, used: [grantId,...] }
 *   <agent-dir>/permission-requests/<id>.json     yêu cầu do extension ghi; sandbox ghi được => KHÔNG TIN CẬY (CLI tự kiểm lại).
 *
 * Grant hiệu lực = có trong grants/ (grantId đúng định dạng ngẫu nhiên do CLI sinh) VÀ chưa có grantId trong sổ used.
 * Extension chỉ ĐỌC grants/ và chỉ GHI grants-used/. Ghi sổ used lỗi => coi như KHÔNG có grant (fail-closed).
 * Giả mạo/xóa sổ used chỉ có thể làm giảm quyền hoặc phát lại một lệnh ĐÃ được duyệt đúng session đó (xem docs).
 * grants/ phải được gắn chỉ-đọc trong sandbox; extension không bao giờ ghi vào đó.
 *
 * key = sha256(tool \0 chủ thể chính xác) -> grant chỉ khớp ĐÚNG lệnh/đường dẫn đó, đúng session.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type GrantMode = "once" | "session";
export interface Grant {
	grantId: string;
	id: string;
	key: string;
	tool: string;
	subject: string; // chỉ để hiển thị
	mode: GrantMode;
	createdAt: string;
	source: "cli";
}
export interface PermRequest {
	id: string;
	sessionId: string;
	key: string;
	tool: string;
	kind: "bash" | "path" | "tool";
	/** NGUYÊN VĂN (chưa che) để CLI tính lại key; file này không tin cậy, CLI tự xác minh và che khi hiển thị. */
	subject: string;
	rule: string;
	pattern: string;
	reason: string;
	status: "pending" | "approved" | "denied";
	createdAt: string;
	decidedAt?: string;
}

export const GRANT_ID_RE = /^g_[0-9a-f]{32}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const MAX_FILE = 1_000_000;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const grantKey = (tool: string, subject: string) => sha(`${tool}\0${subject}`);
export const requestId = (sessionId: string, key: string) => `pr_${sha(`${sessionId}\0${key}`).slice(0, 12)}`;
/** Tên file an toàn từ sessionId (chống ../). */
export const safeName = (sessionId: string) => (/^[A-Za-z0-9_.-]{1,120}$/.test(sessionId) && !sessionId.startsWith(".") ? sessionId : `h_${sha(sessionId).slice(0, 24)}`);

const grantsFile = (agentDir: string, sessionId: string) => path.join(agentDir, "grants", `${safeName(sessionId)}.json`);
const usedFile = (agentDir: string, sessionId: string) => path.join(agentDir, "grants-used", `${safeName(sessionId)}.json`);
const requestFile = (agentDir: string, id: string) => path.join(agentDir, "permission-requests", `${id}.json`);

/** Đọc JSON, không đi theo symlink, chỉ file thường, có giới hạn kích thước. null = không có/hỏng/không hợp lệ. */
function readJsonNoFollow(file: string): unknown | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > MAX_FILE) return null;
		return JSON.parse(fs.readFileSync(fd, "utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd); } catch { /* bỏ qua */ }
	}
}

function writeAtomic(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	fs.renameSync(tmp, file);
}

/** Đọc grants (chỉ đọc); file hỏng/không có => rỗng. Bỏ qua mục thiếu grantId hợp lệ (không do CLI sinh). */
export function readGrants(agentDir: string, sessionId: string): Grant[] {
	const raw = readJsonNoFollow(grantsFile(agentDir, sessionId)) as { sessionId?: unknown; grants?: unknown } | null;
	if (!raw || raw.sessionId !== sessionId || !Array.isArray(raw.grants)) return [];
	return (raw.grants as Grant[]).filter(
		(g) => g && typeof g === "object" && typeof g.grantId === "string" && GRANT_ID_RE.test(g.grantId) && typeof g.key === "string" && KEY_RE.test(g.key) && (g.mode === "once" || g.mode === "session"),
	);
}

/** Sổ used: tập grantId đã dùng. File chưa có => rỗng. File có nhưng hỏng/sai session/symlink => null (fail-closed). */
export function readUsed(agentDir: string, sessionId: string): Set<string> | null {
	const f = usedFile(agentDir, sessionId);
	try {
		fs.lstatSync(f);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null;
	}
	const raw = readJsonNoFollow(f) as { sessionId?: unknown; used?: unknown } | null;
	if (!raw || raw.sessionId !== sessionId || !Array.isArray(raw.used)) return null;
	return new Set((raw.used as unknown[]).filter((x): x is string => typeof x === "string"));
}

/** Đã dùng trong CHÍNH tiến trình này (phòng sổ used bị xóa/cắt giữa chừng). */
const usedInMemory = new Set<string>();

/** Thêm grantId vào sổ used (chỉ-thêm). Ném lỗi nếu không ghi được. */
function markUsed(agentDir: string, sessionId: string, grantId: string): void {
	const cur = readUsed(agentDir, sessionId);
	if (cur === null) throw new Error("sổ grants-used hỏng/không đọc được");
	cur.add(grantId);
	writeAtomic(usedFile(agentDir, sessionId), { sessionId, used: [...cur] });
}

/**
 * Tìm grant khớp key, còn hiệu lực. Grant 'once' được GHI VÀO SỔ USED trước khi trả về; ghi lỗi => null (không có grant).
 * Không bao giờ ghi vào grants/.
 */
export function takeGrant(agentDir: string, sessionId: string, key: string): Grant | null {
	const used = readUsed(agentDir, sessionId);
	if (used === null) return null; // sổ hỏng: không biết grant nào đã dùng => fail-closed
	const hit = readGrants(agentDir, sessionId).find((g) => g.key === key && !used.has(g.grantId) && !usedInMemory.has(`${agentDir}\0${g.grantId}`));
	if (!hit) return null;
	if (hit.mode === "once") {
		try {
			markUsed(agentDir, sessionId, hit.grantId);
		} catch {
			return null;
		}
		usedInMemory.add(`${agentDir}\0${hit.grantId}`);
	}
	return hit;
}

export function readRequest(agentDir: string, id: string): PermRequest | null {
	const r = readJsonNoFollow(requestFile(agentDir, id)) as PermRequest | null;
	return r && typeof r === "object" && r.id === id ? r : null;
}

/** Ghi yêu cầu pending (id ổn định). 'denied' được giữ nguyên (chặn vòng lặp xin lại); 'approved' đã dùng hết thì mở lại pending. */
export function saveRequest(agentDir: string, req: PermRequest): PermRequest {
	const old = readRequest(agentDir, req.id);
	if (old && old.status === "denied") return old;
	writeAtomic(requestFile(agentDir, req.id), req);
	return req;
}

export function setRequestStatus(agentDir: string, id: string, status: "approved" | "denied" | "pending"): void {
	const r = readRequest(agentDir, id);
	if (!r) return;
	writeAtomic(requestFile(agentDir, id), { ...r, status, decidedAt: new Date().toISOString() });
}
