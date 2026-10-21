#!/usr/bin/env node
// permissions-cli: bot điều phối duyệt/từ chối yêu cầu quyền (ask) của extension bot-permissions ở chế độ -p/json.
//   permissions-cli pending [--session ID]
//   permissions-cli approve <id> [--always]   (mặc định 'once' = dùng đúng 1 lần; --always = cả session, KHÔNG bị tiêu thụ, vẫn chỉ đúng lệnh đó)
//   permissions-cli deny <id>
//   permissions-cli grants [--session ID]
//   permissions-cli revoke <id|grantId> [--session ID]
// Cờ chung: --json (xuất JSON), --agent-dir DIR (mặc định $MTH_AGENT_DIR hoặc <mth>/agent).
// Chỉ dùng Node thuần. Đây là công cụ của BOT/NGƯỜI VẬN HÀNH, chạy NGOÀI sandbox; model không được gọi (extension chặn lệnh nhắc tới nó).
//
// Mô hình tin cậy:
//   grants/<session>.json        CHỈ CLI này ghi (sandbox gắn chỉ-đọc). Mỗi grant có grantId ngẫu nhiên (g_<32 hex>).
//   grants-used/<session>.json   sổ "đã dùng" (chỉ-thêm) do extension ghi; sandbox ghi được. Grant hiệu lực = có trong grants/ VÀ grantId chưa trong sổ.
//   permission-requests/<id>.json  KHÔNG TIN CẬY (sandbox ghi được): approve/deny/pending tự kiểm lại (key, id, định dạng, kích thước, symlink).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir } from "./agent-dir.mjs";

const argv = process.argv.slice(2);
const flags = { json: false, always: false, session: undefined, agentDir: undefined };
const pos = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--json") flags.json = true;
	else if (a === "--always") flags.always = true;
	else if (a === "--session") flags.session = argv[++i];
	else if (a === "--agent-dir") flags.agentDir = argv[++i];
	else pos.push(a);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = resolveAgentDir(flags.agentDir, process.env, undefined, path.join(here, "..", "agent"));
const ID_RE = /^pr_[0-9a-f]{12}$/;
const GRANT_ID_RE = /^g_[0-9a-f]{32}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const MAX_REQ_BYTES = 64 * 1024;
const MAX_SUBJECT = 8000;
const SHOW_MAX = 600;
// ký tự điều khiển (trừ \n), DEL, C1, và dấu ngắt dòng Unicode
const CTRL_RE = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeName = (sid) => (/^[A-Za-z0-9_.-]{1,120}$/.test(sid) && !sid.startsWith(".") ? sid : `h_${sha(sid).slice(0, 24)}`);
const grantKey = (tool, subject) => sha(`${tool}\0${subject}`);
const requestId = (sessionId, key) => `pr_${sha(`${sessionId}\0${key}`).slice(0, 12)}`;
const reqDir = path.join(agentDir, "permission-requests");
const grantDir = path.join(agentDir, "grants");
const usedDir = path.join(agentDir, "grants-used");

function out(obj, human) {
	if (flags.json) console.log(JSON.stringify(obj));
	else console.log(human ?? JSON.stringify(obj, null, 2));
}
function fail(code, msg) {
	if (flags.json) console.log(JSON.stringify({ ok: false, error: code, message: msg }));
	else console.error(`permissions-cli: ${msg}`);
	process.exit(1);
}
function writeAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	fs.renameSync(tmp, file);
}
/** Đọc JSON KHÔNG đi theo symlink, chỉ file thường, giới hạn kích thước. Trả { data } hoặc { error }. */
function readJsonSafe(file, maxBytes = MAX_REQ_BYTES) {
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return { error: "không phải file thường" };
		if (st.size > maxBytes) return { error: `quá lớn (${st.size} > ${maxBytes} byte)` };
		return { data: JSON.parse(fs.readFileSync(fd, "utf8")) };
	} catch (e) {
		if (e && e.code === "ENOENT") return { error: "không tồn tại", missing: true };
		if (e && (e.code === "ELOOP" || e.code === "EMLINK")) return { error: "là symlink (từ chối)" };
		return { error: `không đọc được: ${e?.message ?? e}` };
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd); } catch {}
	}
}
function audit(rec) {
	// audit.log do sandbox ghi được => không tin cậy; ghi để tiện theo dõi (nhật ký tin cậy là phía host).
	try {
		const fd = fs.openSync(path.join(agentDir, "audit.log"), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
		try { fs.writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, source: "permissions-cli", ...rec })}\n`); } finally { fs.closeSync(fd); }
	} catch {}
}

// ---------- che secret + hiển thị an toàn ----------
let secretVals;
function secrets() {
	secretVals ??= Object.entries(process.env)
		.filter(([k, v]) => /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i.test(k) && typeof v === "string" && v.length >= 8)
		.map(([, v]) => v)
		.sort((a, b) => b.length - a.length);
	return secretVals;
}
function scrub(text) {
	let o = text;
	for (const s of secrets()) if (o.includes(s)) o = o.split(s).join("[REDACTED]");
	return o
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]")
		.replace(/\b(api[_-]?key|token|secret|passw(?:or)?d|authorization|auth)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, "$1$2[REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]")
		.replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[REDACTED]@")
		.replace(/(\s-u\s+[^\s:]+:)\S+/g, "$1[REDACTED]");
}
/** Hiển thị subject NGUYÊN VĂN (đã che secret): ký tự điều khiển/ANSI được thể hiện bằng \xNN, cắt ở SHOW_MAX. */
function show(subject) {
	const esc = scrub(subject).replace(CTRL_RE, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
	return esc.length > SHOW_MAX ? `${esc.slice(0, SHOW_MAX)}…[+${esc.length - SHOW_MAX} ký tự]` : esc;
}

// ---------- kiểm tra yêu cầu (KHÔNG TIN CẬY) ----------
/** Trả { req } đã xác minh (key và id tính lại từ nội dung) hoặc { error }. */
function loadRequest(id) {
	if (!ID_RE.test(id)) return { error: "id sai định dạng" };
	const file = path.join(reqDir, `${id}.json`);
	let lst;
	try { lst = fs.lstatSync(file); } catch { return { error: "không tồn tại", missing: true }; }
	if (lst.isSymbolicLink() || !lst.isFile()) return { error: "không phải file thường (symlink/khác)" };
	const r = readJsonSafe(file);
	if (r.error) return r;
	return verifyRequest(r.data, id);
}
function verifyRequest(q, id) {
	const bad = (m) => ({ error: m });
	if (!q || typeof q !== "object" || Array.isArray(q)) return bad("nội dung không phải object");
	for (const f of ["id", "sessionId", "key", "tool", "kind", "subject"]) if (typeof q[f] !== "string") return bad(`thiếu/sai trường '${f}'`);
	if (q.id !== id) return bad("trường id không khớp tên file");
	if (!q.sessionId || q.sessionId.length > 200 || /[\u0000-\u001f\u007f]/.test(q.sessionId)) return bad("sessionId không hợp lệ");
	if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(q.tool)) return bad("tên tool không hợp lệ");
	if (!["bash", "path", "tool"].includes(q.kind)) return bad("kind không hợp lệ");
	if (!q.subject || q.subject.length > MAX_SUBJECT) return bad(`subject rỗng hoặc dài quá ${MAX_SUBJECT} ký tự`);
	if (q.kind === "bash" && q.subject !== q.subject.replace(/\s+/g, " ").trim()) return bad("subject bash chưa chuẩn hóa khoảng trắng");
	if (!KEY_RE.test(q.key)) return bad("key sai định dạng");
	const key = grantKey(q.tool, q.subject);
	if (q.key !== key) return bad("key không khớp sha256(tool\\0subject) tính lại (yêu cầu bị sửa/giả mạo)");
	if (requestId(q.sessionId, key) !== id) return bad("id không khớp id tính lại từ (session, key) (yêu cầu bị sửa/giả mạo)");
	if (q.status !== undefined && !["pending", "approved", "denied"].includes(q.status)) return bad("status không hợp lệ");
	return { req: { id, sessionId: q.sessionId, key, tool: q.tool, kind: q.kind, subject: q.subject, status: q.status ?? "pending", rule: typeof q.rule === "string" ? q.rule.slice(0, 200) : "", pattern: typeof q.pattern === "string" ? q.pattern.slice(0, 200) : "", createdAt: typeof q.createdAt === "string" ? q.createdAt.slice(0, 40) : "", raw: q } };
}
/** Liệt kê file yêu cầu: chỉ tên pr_<12 hex>.json là file thường (không symlink). */
function scanRequests() {
	const valid = [];
	const invalid = [];
	let names = [];
	try { names = fs.readdirSync(reqDir); } catch {}
	for (const n of names.sort()) {
		if (n.endsWith(".tmp")) continue;
		const m = /^(pr_[0-9a-f]{12})\.json$/.exec(n);
		if (!m) { invalid.push({ file: n.slice(0, 80), reason: "tên file không đúng định dạng" }); continue; }
		const r = loadRequest(m[1]);
		if (r.error) invalid.push({ file: n, reason: r.error });
		else valid.push(r.req);
	}
	return { valid, invalid };
}

// ---------- grants (chỉ CLI ghi) + sổ used ----------
const grantsPath = (sid) => path.join(grantDir, `${safeName(sid)}.json`);
const usedPath = (sid) => path.join(usedDir, `${safeName(sid)}.json`);
function readGrantFile(file) {
	const r = readJsonSafe(file, 2_000_000);
	if (r.error || !r.data || !Array.isArray(r.data.grants) || typeof r.data.sessionId !== "string") return null;
	return r.data;
}
function readUsed(sid) {
	if (!fs.existsSync(usedPath(sid)) && !isLink(usedPath(sid))) return new Set();
	const r = readJsonSafe(usedPath(sid), 2_000_000);
	if (r.error || !r.data || r.data.sessionId !== sid || !Array.isArray(r.data.used)) return null; // hỏng
	return new Set(r.data.used.filter((x) => typeof x === "string"));
}
function isLink(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function markUsed(sid, grantId) {
	const cur = readUsed(sid) ?? new Set();
	cur.add(grantId);
	writeAtomic(usedPath(sid), { sessionId: sid, used: [...cur] });
}
function allGrantFiles() {
	let names = [];
	try { names = fs.readdirSync(grantDir); } catch {}
	const rows = [];
	for (const n of names.filter((f) => f.endsWith(".json")).sort()) {
		const file = path.join(grantDir, n);
		const data = readGrantFile(file);
		if (data) rows.push({ file, data });
	}
	return rows;
}
function needId() {
	const id = pos[1];
	if (!id || !ID_RE.test(id)) fail("bad_id", "thiếu hoặc sai định dạng id (dạng pr_<12 hex>)");
	return id;
}
function needReq(id) {
	const r = loadRequest(id);
	if (r.missing) fail("not_found", `không có yêu cầu ${id}`);
	if (r.error) fail("invalid_request", `yêu cầu ${id} không hợp lệ/không đáng tin: ${r.error}`);
	return r.req;
}
const pub = (q) => ({ id: q.id, sessionId: q.sessionId, tool: q.tool, kind: q.kind, subject: show(q.subject), rule: q.rule, pattern: q.pattern, status: q.status, createdAt: q.createdAt });

const cmd = pos[0];
if (cmd === "pending") {
	const { valid, invalid } = scanRequests();
	let list = valid.filter((r) => r.status === "pending");
	if (flags.session) list = list.filter((r) => r.sessionId === flags.session);
	list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	out(
		{ ok: true, pending: list.map(pub), invalid },
		(list.length ? list.map((r) => `${r.id}  [${r.sessionId}]  ${r.tool}  ${show(r.subject).split("\n").join(" , ")}\n    rule=${r.rule} pattern=${r.pattern}`).join("\n") : "(không có yêu cầu đang chờ)") +
			(invalid.length ? `\n[!] ${invalid.length} mục không hợp lệ bị bỏ qua: ${invalid.map((x) => `${x.file} (${x.reason})`).join("; ")}` : ""),
	);
} else if (cmd === "approve") {
	const id = needId();
	const r = needReq(id);
	if (flags.session && r.sessionId !== flags.session) fail("session_mismatch", "yêu cầu thuộc session khác");
	const gf = grantsPath(r.sessionId);
	const cur = readGrantFile(gf);
	const list = cur && cur.sessionId === r.sessionId ? cur.grants.filter((g) => g && g.key !== r.key) : [];
	const mode = flags.always ? "session" : "once";
	const grant = { grantId: `g_${crypto.randomBytes(16).toString("hex")}`, id, key: r.key, tool: r.tool, subject: show(r.subject), mode, createdAt: new Date().toISOString(), source: "cli" };
	list.push(grant);
	writeAtomic(gf, { sessionId: r.sessionId, grants: list });
	try { writeAtomic(path.join(reqDir, `${id}.json`), { ...r.raw, status: "approved", decidedAt: grant.createdAt }); } catch {}
	audit({ event: "approve", decision: "allow", request: id, session: r.sessionId, tool: r.tool, mode, via: "cli", grantId: grant.grantId, target: show(r.subject).slice(0, 300) });
	out({ ok: true, id, session: r.sessionId, mode, grantId: grant.grantId, subject: show(r.subject) }, `đã duyệt ${id} (${mode === "once" ? "một lần" : "cả session"}) cho: ${show(r.subject)}\nchạy lại cùng --session-id ${r.sessionId}`);
} else if (cmd === "deny") {
	const id = needId();
	const r = needReq(id);
	try { writeAtomic(path.join(reqDir, `${id}.json`), { ...r.raw, status: "denied", decidedAt: new Date().toISOString() }); } catch {}
	for (const { file, data } of allGrantFiles()) {
		const kept = data.grants.filter((g) => g.key !== r.key);
		if (kept.length !== data.grants.length && data.sessionId === r.sessionId) {
			for (const g of data.grants) if (g.key === r.key && GRANT_ID_RE.test(g.grantId ?? "")) try { markUsed(data.sessionId, g.grantId); } catch {}
			writeAtomic(file, { ...data, grants: kept });
		}
	}
	audit({ event: "deny", decision: "block", request: id, session: r.sessionId, tool: r.tool, via: "cli", target: show(r.subject).slice(0, 300) });
	out({ ok: true, id, status: "denied" }, `đã từ chối ${id}`);
} else if (cmd === "grants") {
	const rows = [];
	for (const { data } of allGrantFiles()) {
		if (flags.session && data.sessionId !== flags.session) continue;
		const used = readUsed(data.sessionId);
		for (const g of data.grants) {
			if (!g || typeof g !== "object") continue;
			const status = !GRANT_ID_RE.test(g.grantId ?? "") ? "invalid(no-grantId)" : used === null ? "ledger-corrupt(inactive)" : g.mode === "once" ? (used.has(g.grantId) ? "used" : "available") : used.has(g.grantId) ? "revoked" : "active";
			rows.push({ session: data.sessionId, grantId: g.grantId, id: g.id, mode: g.mode, tool: g.tool, status, subject: show(String(g.subject ?? "")), createdAt: g.createdAt });
		}
	}
	out({ ok: true, grants: rows }, rows.length ? rows.map((g) => `${g.id}  ${g.grantId}  [${g.session}]  ${g.mode}  ${g.status}  ${g.tool}  ${g.subject.split("\n").join(" , ")}`).join("\n") : "(không có grant)");
} else if (cmd === "revoke") {
	const id = pos[1];
	if (!id || !(ID_RE.test(id) || GRANT_ID_RE.test(id))) fail("bad_id", "thiếu hoặc sai định dạng id (pr_<12 hex> hoặc g_<32 hex>)");
	let n = 0;
	for (const { file, data } of allGrantFiles()) {
		if (flags.session && data.sessionId !== flags.session) continue;
		const hit = data.grants.filter((g) => g && (g.id === id || g.grantId === id));
		if (!hit.length) continue;
		// ghi sổ used trước (bản sao cũ của grants/ nếu còn cũng vô hiệu), rồi gỡ khỏi grants/
		for (const g of hit) if (GRANT_ID_RE.test(g.grantId ?? "")) try { markUsed(data.sessionId, g.grantId); } catch {}
		writeAtomic(file, { ...data, grants: data.grants.filter((g) => !hit.includes(g)) });
		n += hit.length;
		audit({ event: "revoke", request: id, session: data.sessionId, via: "cli" });
	}
	if (!n) fail("not_found", `không có grant ${id}`);
	out({ ok: true, id, revoked: n }, `đã thu hồi ${id}`);
} else {
	console.error("dùng: permissions-cli pending|approve <id> [--always]|deny <id>|grants|revoke <id>  [--session ID] [--json] [--agent-dir DIR]");
	process.exit(cmd ? 2 : 0);
}
