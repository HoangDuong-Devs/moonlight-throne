// Thư mục agent của mth: MTH_AGENT_DIR (mặc định <mth>/agent).
// Tương thích ngược: CODER_AGENT_DIR (lỗi thời, cảnh báo) và tên cũ hơn PI_CODING_AGENT_DIR (lỗi thời, cảnh báo).
// Thư viện lõi đọc PI_CODING_AGENT_DIR: chỉ đặt biến đó NỘI BỘ (agentEnv) ngay trước khi gọi tiến trình con.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mthEnv } from "./env.mjs";

const DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agent");
const LEGACY = "PI_CODING_AGENT_DIR";

export function resolveAgentDir(explicit, env = process.env, warn = (m) => process.stderr.write(m + "\n"), fallback = DEFAULT) {
	if (explicit) return path.resolve(explicit);
	const dir = mthEnv("MTH_AGENT_DIR", env, undefined, warn);
	if (dir) return path.resolve(dir);
	if (env[LEGACY]) {
		warn(`mth: cảnh báo: ${LEGACY} đã lỗi thời, hãy đổi sang MTH_AGENT_DIR`);
		return path.resolve(env[LEGACY]);
	}
	return path.resolve(fallback);
}

/** Biến môi trường cho tiến trình con: cả tên mới MTH_AGENT_DIR, tên cũ CODER_AGENT_DIR, và biến nội bộ mà thư viện lõi đọc. */
export function agentEnv(dir) {
	return { MTH_AGENT_DIR: dir, CODER_AGENT_DIR: dir, [LEGACY]: dir };
}
