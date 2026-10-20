// Thư mục agent của coder: CODER_AGENT_DIR (mặc định <coder>/agent).
// Tương thích ngược: biến cũ PI_CODING_AGENT_DIR vẫn được nhận (kèm cảnh báo deprecated) khi chưa đặt CODER_AGENT_DIR.
// Thư viện lõi đọc PI_CODING_AGENT_DIR: chỉ đặt biến đó NỘI BỘ (agentEnv) ngay trước khi gọi tiến trình con.
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agent");
const LEGACY = "PI_CODING_AGENT_DIR";

export function resolveAgentDir(explicit, env = process.env, warn = (m) => process.stderr.write(m + "\n"), fallback = DEFAULT) {
	if (explicit) return path.resolve(explicit);
	if (env.CODER_AGENT_DIR) return path.resolve(env.CODER_AGENT_DIR);
	if (env[LEGACY]) {
		warn(`coder: cảnh báo: ${LEGACY} đã lỗi thời, hãy đổi sang CODER_AGENT_DIR`);
		return path.resolve(env[LEGACY]);
	}
	return path.resolve(fallback);
}

/** Biến môi trường cho tiến trình con: CODER_AGENT_DIR + biến nội bộ mà thư viện lõi đọc. */
export function agentEnv(dir) {
	return { CODER_AGENT_DIR: dir, [LEGACY]: dir };
}
