// Logic thuần của tool webfetch / websearch (không phụ thuộc lõi agent) để test trực tiếp bằng node.
import { lookup } from "node:dns/promises"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { join } from "node:path"
import { convertHTMLToMarkdown, extractText } from "./html.ts"

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120
const MAX_REDIRECTS = 5
export type Format = "text" | "markdown" | "html"

export interface WebConfig {
	/** true: cho phép localhost / mạng nội bộ / metadata (mặc định false). */
	allowPrivateNetwork: boolean
	/** Danh sách host (khớp chính xác hoặc hậu tố ".example.com") được miễn chặn SSRF. */
	allowedHosts: string[]
}

export function loadConfig(agentDir: string): WebConfig {
	const cfg: WebConfig = { allowPrivateNetwork: false, allowedHosts: [] }
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "web.json"), "utf8"))
		if (raw && typeof raw === "object") {
			if (raw.allowPrivateNetwork === true) cfg.allowPrivateNetwork = true
			if (Array.isArray(raw.allowedHosts)) cfg.allowedHosts = raw.allowedHosts.filter((h: unknown) => typeof h === "string")
		}
	} catch {
		/* không có file / sai JSON -> mặc định an toàn */
	}
	return cfg
}

// ---------- SSRF ----------
function ipv4Blocked(a: number, b: number): boolean {
	return (
		a === 0 || a === 10 || a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // link-local + metadata 169.254.169.254
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224 // multicast + reserved + broadcast
	)
}
/** Giải IPv6 (đã được isIP xác nhận) thành 16 byte; null nếu sai. Hỗ trợ "::" và đuôi IPv4 dạng a.b.c.d. */
function parseIPv6(ip: string): number[] | null {
	let head = ip
	let tail4: number[] = []
	const dot = ip.lastIndexOf(".")
	if (dot !== -1) {
		const colon = ip.lastIndexOf(":", dot)
		const v4 = ip.slice(colon + 1).split(".").map(Number)
		if (v4.length !== 4 || v4.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null
		tail4 = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
		head = ip.slice(0, colon + 1) + "0:0" // giữ chỗ; thay 2 nhóm cuối bên dưới
	}
	const halves = head.split("::")
	if (halves.length > 2) return null
	const grp = (p: string) => (p === "" ? [] : p.split(":"))
	const left = grp(halves[0])
	const right = halves.length === 2 ? grp(halves[1]) : []
	if (halves.length === 1 ? left.length !== 8 : left.length + right.length > 7) return null
	const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
	if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
	const nums = groups.map((g) => parseInt(g, 16))
	if (tail4.length) {
		nums[6] = tail4[0]
		nums[7] = tail4[1]
	}
	return nums.flatMap((n) => [n >> 8, n & 255])
}

/** IPv6 -> chặn nếu là dải nội bộ/đặc biệt, hoặc nếu IPv4 nhúng bên trong bị bộ chặn IPv4 chặn. */
function ipv6Blocked(b: number[]): boolean {
	const v4 = (o: number) => ipv4Blocked(b[o], b[o + 1])
	const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
	if (zero(0, 12)) return true // ::/96: ::, ::1 và IPv4-compatible (::a.b.c.d) - nội bộ/deprecated
	if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12) // ::ffff:a.b.c.d (IPv4-mapped)
	if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return v4(12) // ::ffff:0:a.b.c.d (SIIT)
	if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
		if (zero(4, 12)) return v4(12) // 64:ff9b::/96 NAT64
		if (b[4] === 0 && b[5] === 1) return true // 64:ff9b:1::/48 NAT64 dùng nội bộ
	}
	if (b[0] === 0x20 && b[1] === 0x02) return v4(2) // 2002::/16 6to4 (IPv4 ở byte 2..5)
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true // 2001::/32 Teredo
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true // 2001:db8::/32 tài liệu
	if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return true // 3fff::/20 tài liệu
	if (b[0] === 0x01 && b[1] === 0 && zero(2, 8)) return true // 100::/64 discard
	if ((b[8] & 0xfd) === 0 && b[9] === 0 && b[10] === 0x5e && b[11] === 0xfe) return v4(12) // ISATAP ::5efe:a.b.c.d
	if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 ULA
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 site-local (cũ)
	if (b[0] === 0xff) return true // ff00::/8 multicast
	return false
}

export function isBlockedIp(ip: string): boolean {
	ip = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase()
	const kind = isIP(ip)
	if (kind === 4) {
		const [a, b] = ip.split(".").map(Number)
		return ipv4Blocked(a, b)
	}
	if (kind === 6) {
		const bytes = parseIPv6(ip)
		return bytes === null ? true : ipv6Blocked(bytes)
	}
	return true
}
const hostAllowed = (host: string, cfg: WebConfig) =>
	cfg.allowedHosts.some((h) => {
		h = h.toLowerCase()
		return host === h || (h.startsWith(".") && host.endsWith(h))
	})

export async function assertUrlAllowed(url: URL, cfg: WebConfig): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
	if (cfg.allowPrivateNetwork) return
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
	if (hostAllowed(host, cfg)) return
	const blocked = () =>
		new Error(
			`Blocked: ${host} resolves to a local/private network address (SSRF protection). ` +
				`Set {"allowPrivateNetwork": true} or add the host to "allowedHosts" in <agent-dir>/web.json to allow it.`,
		)
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw blocked()
	if (isIP(host)) {
		if (isBlockedIp(host)) throw blocked()
		return
	}
	// Dạng số/hex lạ (http://2130706433/) đã được URL() chuẩn hóa thành IPv4; còn lại phân giải DNS.
	let addrs: { address: string }[]
	try {
		addrs = await lookup(host, { all: true, verbatim: true })
	} catch (e) {
		throw new Error(`DNS lookup failed for ${host}: ${(e as Error).message}`)
	}
	if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) throw blocked()
}

// ---------- fetch ----------
const UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PiCoder-User/1.0"
const acceptHeader = (f: Format) =>
	f === "markdown"
		? "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
		: f === "text"
			? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
			: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"

async function request(url: string, format: Format, ua: string, cfg: WebConfig, signal: AbortSignal): Promise<Response> {
	let current = new URL(url)
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await assertUrlAllowed(current, cfg)
		const res = await fetch(current, {
			method: "GET",
			redirect: "manual",
			signal,
			headers: { "User-Agent": ua, Accept: acceptHeader(format), "Accept-Language": "en-US,en;q=0.9" },
		})
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			await res.body?.cancel().catch(() => {})
			current = new URL(res.headers.get("location")!, current)
			continue
		}
		return res
	}
	throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`)
}

async function readBounded(res: Response, max: number): Promise<Uint8Array> {
	const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10)
	const tooLarge = () => new Error(`Response too large (exceeds ${max} byte limit)`)
	if (Number.isSafeInteger(declared) && declared > max) {
		await res.body?.cancel().catch(() => {})
		throw tooLarge()
	}
	if (!res.body) return new Uint8Array()
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > max) {
			await reader.cancel().catch(() => {})
			throw tooLarge()
		}
		chunks.push(value)
	}
	return Buffer.concat(chunks, size)
}

const isTextualMime = (mime: string) =>
	!mime || mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") ||
	mime === "application/xml" || mime.endsWith("+xml") || mime === "application/javascript" ||
	mime === "application/x-javascript" || mime === "application/xhtml+xml"

function decode(body: Uint8Array, contentType: string): string {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
	try {
		return new TextDecoder(charset || "utf-8").decode(body)
	} catch {
		return new TextDecoder().decode(body)
	}
}

export interface FetchResult {
	url: string
	contentType: string
	format: Format
	output: string
}

export async function webFetch(
	input: { url: string; format?: Format; timeout?: number },
	cfg: WebConfig,
	parentSignal?: AbortSignal,
): Promise<FetchResult> {
	const format = input.format ?? "markdown"
	if (!["text", "markdown", "html"].includes(format)) throw new Error(`Invalid format: ${format}`)
	let timeout = input.timeout ?? DEFAULT_TIMEOUT_SECONDS
	if (!(timeout > 0)) throw new Error("timeout must be greater than 0")
	timeout = Math.min(timeout, MAX_TIMEOUT_SECONDS)
	let parsed: URL
	try {
		parsed = new URL(input.url)
	} catch {
		throw new Error(`Invalid URL: ${input.url}`)
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must use http:// or https://")

	const timer = AbortSignal.timeout(timeout * 1000)
	const signal = parentSignal ? AbortSignal.any([parentSignal, timer]) : timer
	try {
		let res = await request(input.url, format, UA, cfg, signal)
		if (res.status === 403 && res.headers.get("cf-mitigated") === "challenge") {
			await res.body?.cancel().catch(() => {})
			res = await request(input.url, format, "mth", cfg, signal)
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => {})
			throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())
		}
		const contentType = res.headers.get("content-type") ?? ""
		const mime = contentType.split(";", 1)[0].trim().toLowerCase()
		if (mime.startsWith("image/") && mime !== "image/svg+xml") throw new Error(`Unsupported fetched image content type: ${mime}`)
		if (!isTextualMime(mime)) throw new Error(`Unsupported fetched file content type: ${mime}`)
		const content = decode(await readBounded(res, MAX_RESPONSE_BYTES), contentType)
		let output = content
		if (mime === "text/html" || mime === "application/xhtml+xml" || (!mime && /^\s*<(!doctype|html)/i.test(content))) {
			if (format === "markdown") output = convertHTMLToMarkdown(content)
			else if (format === "text") output = extractText(content)
		}
		return { url: input.url, contentType, format, output }
	} catch (e) {
		if (timer.aborted) throw new Error(`Request timed out after ${timeout}s`)
		if (parentSignal?.aborted) throw new Error("Request aborted")
		throw e
	}
}

// ---------- websearch (Exa MCP, như opencode) ----------
export const EXA_ENDPOINT = "https://mcp.exa.ai/mcp"
export const NO_RESULTS = "No search results found. Please try a different query."
const MAX_SEARCH_BYTES = 256 * 1024

export interface SearchResult {
	url: string
	title?: string
	content?: string
	published?: number
}

export function parseExaResults(text: string): SearchResult[] {
	return text.split(/\n\n---\n\n/).flatMap((block) => {
		const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
		if (!url) return []
		const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
		const pubText = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
		const published = pubText && pubText !== "N/A" ? Date.parse(pubText) : undefined
		const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
		return [{
			url,
			...(title && title !== "N/A" ? { title } : {}),
			...(content ? { content } : {}),
			...(published !== undefined && Number.isFinite(published) ? { published } : {}),
		}]
	})
}

export function formatResults(results: SearchResult[]): string {
	if (!results.length) return NO_RESULTS
	return results
		.map((r) => {
			const pub = r.published ? `\nPublished: ${new Date(r.published).toISOString()}` : ""
			return `## [${r.title ?? r.url}](${r.url})${pub}${r.content ? `\n\n${r.content}` : ""}`
		})
		.join("\n\n")
}

export async function webSearch(
	query: string,
	env: Record<string, string | undefined>,
	parentSignal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; provider: string; keyed: boolean }> {
	const key = env.EXA_API_KEY?.trim()
	const url = new URL(env.EXA_MCP_URL || EXA_ENDPOINT)
	if (key) url.searchParams.set("exaApiKey", key)
	const timer = AbortSignal.timeout(25_000)
	const signal = parentSignal ? AbortSignal.any([parentSignal, timer]) : timer
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0", id: 1, method: "tools/call",
				params: { name: "web_search_exa", arguments: { query, numResults: 8 } },
			}),
		})
		if (!res.ok) {
			await res.body?.cancel().catch(() => {})
			const hint =
				res.status === 429
					? "Web search rate limited (HTTP 429)." + (key ? "" : " Set EXA_API_KEY for higher limits.")
					: res.status === 401 || res.status === 403
						? `Web search authentication failed (HTTP ${res.status}). Check EXA_API_KEY.`
						: `Web search request failed (HTTP ${res.status})`
			throw new Error(hint)
		}
		const body = new TextDecoder().decode(await readBounded(res, MAX_SEARCH_BYTES))
		let result: any
		const tryParse = (s: string) => {
			s = s.trim()
			if (!s.startsWith("{")) return undefined
			try {
				return JSON.parse(s)
			} catch {
				return undefined
			}
		}
		const direct = tryParse(body)
		if (direct) result = direct
		else
			for (const line of body.split("\n")) {
				if (!line.startsWith("data: ")) continue
				const p = tryParse(line.slice(6))
				if (p) {
					result = p
					break
				}
			}
		if (!result) throw new Error("Web search returned an unreadable response")
		if (result.error) throw new Error(`Web search error: ${result.error.message ?? JSON.stringify(result.error)}`)
		const content = (result.result?.content ?? []).find((c: any) => c?.text)
		if (result.result?.isError) throw new Error(`Web search error: ${String(content?.text ?? "unknown").slice(0, 300)}`)
		if (result.result?._meta?.["ai.exa/rateLimited"])
			throw new Error(
				"Exa free MCP rate limit reached (no key). Set the EXA_API_KEY environment variable " +
					"(create one at https://dashboard.exa.ai/api-keys) or retry later.",
			)
		return { text: formatResults(content ? parseExaResults(content.text) : []), provider: "exa", keyed: !!key }
	} catch (e) {
		if (timer.aborted) throw new Error("Web search timed out")
		if (parentSignal?.aborted) throw new Error("Web search aborted")
		throw e
	}
}
