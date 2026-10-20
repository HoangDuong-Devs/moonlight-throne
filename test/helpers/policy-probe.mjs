// Tiến trình phụ cho test/sandbox-test-build.test.mjs: nạp bot-permissions, chạy từng lệnh bash trong argv[2] (JSON),
// in kết quả JSON. Được gọi cả ngoài lẫn TRONG bwrap để kiểm tra nhánh detectSandbox().
// Env: PI_CODING_AGENT_DIR, CODER_WORKDIR (bắt buộc).
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const getAgentDir=()=>process.env.PI_CODING_AGENT_DIR;"), shortCircuit: true };
  return n(s, c);
}`),
	import.meta.url,
);
const CODER = path.resolve(new URL("../..", import.meta.url).pathname);
const mod = await import(pathToFileURL(path.join(CODER, "agent/extensions/bot-permissions/index.ts")).href);
const handlers = {};
mod.default({ on: (n, f) => (handlers[n] = f), appendEntry() {} });
const work = process.env.CODER_WORKDIR;
const ctx = { cwd: work, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "probe" } };
const out = {};
for (const command of JSON.parse(process.argv[2])) out[command] = (await handlers.tool_call({ toolName: "bash", input: { command } }, ctx)) ?? null;
process.stdout.write(JSON.stringify(out));
