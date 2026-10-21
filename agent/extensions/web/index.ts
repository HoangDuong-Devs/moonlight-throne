/**
 * Extension `web`: tool webfetch + websearch (cổng hành vi từ opencode).
 * Cấu hình tùy chọn: <agent-dir>/web.json  { "allowPrivateNetwork": false, "allowedHosts": [] }
 * websearch: Exa MCP (https://mcp.exa.ai/mcp); EXA_API_KEY tùy chọn (không có key vẫn chạy, bị giới hạn tốc độ).
 */
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateHead } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, loadConfig, webFetch, webSearch } from "./core.ts"

// Tệp kết quả đầy đủ nằm trong /tmp để model đọc lại sau: giới hạn tuổi + số lượng, quyền 0700/0600.
const OUTPUT_MAX_AGE_MS = 6 * 3600_000
const OUTPUT_KEEP = 20

/** Dọn các thư mục mth-webfetch-, mth-websearch- (và coder-webfetch-/coder-websearch-/pi-web... cũ) (cùng uid, không phải symlink). Best-effort. */
export async function sweepOutputs(dir: string = tmpdir(), now = Date.now()): Promise<void> {
	try {
		const uid = process.getuid?.()
		const found: { p: string; t: number }[] = []
		for (const name of await readdir(dir)) {
			if (!/^(coder|mth|pi)-(webfetch|websearch)-/.test(name)) continue
			const p = join(dir, name)
			const st = await lstat(p).catch(() => null)
			if (!st || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue
			found.push({ p, t: st.mtimeMs })
		}
		found.sort((a, b) => b.t - a.t)
		for (const [idx, f] of found.entries())
			if (idx >= OUTPUT_KEEP || now - f.t > OUTPUT_MAX_AGE_MS) await rm(f.p, { recursive: true, force: true }).catch(() => {})
	} catch {
		/* bỏ qua */
	}
}

async function limit(text: string, prefix: string): Promise<{ text: string; fullOutputPath?: string; truncated: boolean }> {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
	if (!t.truncated) return { text: t.content, truncated: false }
	await sweepOutputs()
	const dir = await mkdtemp(join(tmpdir(), `mth-${prefix}-`)) // mkdtemp tạo 0700
	const fullOutputPath = join(dir, "output.txt")
	await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 })
	return {
		text:
			`${t.content}\n\n[Output truncated: showing ${t.outputLines} of ${t.totalLines} lines ` +
			`(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full output saved to: ${fullOutputPath} ` +
			`(use the read tool with offset/limit to read more)]`,
		fullOutputPath,
		truncated: true,
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default. " +
			"Use a more targeted tool when one is available. Read-only. Local/private network addresses are blocked by default. " +
			`Large results are truncated (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}); the full output is saved to a temp file.`,
		parameters: Type.Object({
			url: Type.String({ description: "The HTTP or HTTPS URL to fetch content from" }),
			format: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
					description: "The format to return the content in. Defaults to markdown.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Optional timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS})`,
				}),
			),
		}),
		async execute(_id, params, signal) {
			let r
			try {
				r = await webFetch(params, loadConfig(getAgentDir()), signal)
			} catch (e) {
				throw new Error(`Unable to fetch ${params.url}: ${(e as Error).message}`)
			}
			const lim = await limit(r.output, "webfetch")
			return {
				content: [{ type: "text", text: lim.text }],
				details: { url: r.url, contentType: r.contentType, format: r.format, truncated: lim.truncated, fullOutputPath: lim.fullOutputPath },
			}
		},
	})

	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description:
			`Search the web (Exa). Use this for current information beyond knowledge cutoff. The current year is ${new Date().getFullYear()}; ` +
			"use this year when searching for recent information or current events.",
		parameters: Type.Object({ query: Type.String({ description: "Websearch query" }) }),
		async execute(_id, params, signal) {
			try {
				const r = await webSearch(params.query, process.env, signal)
				const lim = await limit(r.text, "websearch")
				return {
					content: [{ type: "text", text: lim.text }],
					details: { provider: r.provider, keyed: r.keyed, truncated: lim.truncated, fullOutputPath: lim.fullOutputPath },
				}
			} catch (e) {
				// Lỗi tìm kiếm được trả như thông báo rõ ràng cho model (không crash tool).
				throw new Error(`Unable to search the web for "${params.query}": ${(e as Error).message}`)
			}
		},
	})
}
