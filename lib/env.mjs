// Tra cứu biến môi trường của mth: tên mới MTH_* thắng; tên cũ CODER_* vẫn được nhận (cảnh báo lỗi thời MỘT lần mỗi tên
// trong tiến trình). Giá trị rỗng được coi là "chưa đặt" (để dòng `MTH_X=` trong .env không đè lên mặc định).
const warned = new Set();
const writeWarn = (m) => process.stderr.write(m + "\n");

const newName = (name) => (name.startsWith("MTH_") ? name : `MTH_${name}`);

/**
 * mthEnv("MTH_FOO" [, env [, fallback [, warn]]]): MTH_FOO > CODER_FOO (cảnh báo) > fallback.
 * Chỉ một bản duy nhất của hàm này (mọi thư viện/extension .mjs/.ts đều import từ đây).
 */
export function mthEnv(name, env = process.env, fallback, warn = writeWarn) {
	const current = newName(name);
	const value = env[current];
	if (value !== undefined && value !== "") return value;
	const legacy = `CODER_${current.slice(4)}`;
	const old = env[legacy];
	if (old !== undefined && old !== "") {
		if (!warned.has(current)) {
			warned.add(current);
			warn(`mth: cảnh báo: ${legacy} đã lỗi thời, hãy đổi sang ${current}`);
		}
		return old;
	}
	return fallback;
}
