// HTML -> markdown / text, không phụ thuộc npm. Cổng hành vi từ opencode tool/html-markdown.ts
// (bỏ htmlparser2; dùng tokenizer + cây DOM tối giản). Không phải parser HTML5 đầy đủ.

export const OMITTED = new Set(["script", "style", "noscript", "iframe", "object", "embed", "meta", "link", "template", "head"])
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
const BLOCKS = new Set([
	"address", "article", "aside", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure",
	"footer", "form", "header", "main", "nav", "p", "section", "summary", "ul", "ol", "li", "table", "tr",
	"blockquote", "pre", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "caption",
])
const MAX_DEPTH = 200
// Giới hạn chống DoS (đầu vào tối đa 5MB, chạy đồng bộ nên phải tự giới hạn):
export const MAX_STACK_DEPTH = 256 // độ sâu cây; sâu hơn thì phần tử được "dàn phẳng" (không đẩy vào stack)
export const MAX_NODES = 400_000 // số phần tử + text; quá thì dừng parse, giữ phần đã có
export const MAX_OUTPUT_CHARS = 4 * 1024 * 1024 // kích thước markdown tối đa
const MAX_WORK_CHARS = 64 * 1024 * 1024 // tổng ký tự sinh ra qua mọi cấp lồng (chặn khuếch đại blockquote/list lồng sâu)
export const TIME_BUDGET_MS = 5000 // tổng thời gian cho một lần chuyển đổi

export class HtmlLimitError extends Error {}
const now = () => Date.now()

interface El {
	name: string
	attrs: Record<string, string>
	children: Node[]
}
type Node = El | string

const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—",
	ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•",
	trade: "™", euro: "€", pound: "£", yen: "¥", times: "×", rarr: "→", larr: "←",
}
export function decodeEntities(s: string): string {
	if (!s.includes("&")) return s
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
			try {
				return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m
			} catch {
				return m
			}
		}
		return ENTITIES[e.toLowerCase()] ?? m
	})
}

// Phần tử mở mới sẽ ngầm đóng phần tử nào đang mở (chỉ tìm trong "phạm vi" gần nhất).
const IMPLIED_CLOSE: Record<string, { closes: string[]; stop: string[] }> = {
	li: { closes: ["li"], stop: ["ul", "ol"] },
	dt: { closes: ["dt", "dd"], stop: ["dl"] },
	dd: { closes: ["dt", "dd"], stop: ["dl"] },
	tr: { closes: ["tr", "td", "th"], stop: ["table"] },
	td: { closes: ["td", "th"], stop: ["tr", "table"] },
	th: { closes: ["td", "th"], stop: ["tr", "table"] },
	option: { closes: ["option"], stop: ["select"] },
}
const P_CLOSERS = new Set([
	"address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figure", "footer", "form",
	"h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
])

export function parseHTML(html: string, deadline: number = now() + TIME_BUDGET_MS): El {
	const root: El = { name: "#root", attrs: {}, children: [] }
	const stack: El[] = [root]
	const openCount = new Map<string, number>() // tên -> số phần tử đang mở trong stack (closeTo O(1) khi không có)
	let nodes = 0
	let full = false
	const top = () => stack[stack.length - 1]
	const addText = (t: string) => {
		if (!t) return
		if (++nodes > MAX_NODES) full = true
		else top().children.push(t)
	}
	const truncateStack = (len: number) => {
		for (let k = stack.length - 1; k >= len; k--) openCount.set(stack[k].name, (openCount.get(stack[k].name) ?? 1) - 1)
		stack.length = len
	}
	const closeTo = (name: string) => {
		if (!openCount.get(name)) return
		for (let i = stack.length - 1; i > 0; i--) {
			if (stack[i].name === name) {
				truncateStack(i)
				return
			}
		}
	}
	const open = (name: string, attrs: Record<string, string>, selfClose: boolean) => {
		if (++nodes > MAX_NODES) {
			full = true
			return
		}
		const rule = IMPLIED_CLOSE[name]
		if (rule) {
			let cut = -1
			for (let i = stack.length - 1; i > 0; i--) {
				if (rule.stop.includes(stack[i].name)) break
				if (rule.closes.includes(stack[i].name)) cut = i
			}
			if (cut > 0) truncateStack(cut)
		}
		if (P_CLOSERS.has(name)) {
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].name === "p") {
					truncateStack(i)
					break
				}
				if (!["a", "span", "b", "i", "em", "strong", "code"].includes(stack[i].name)) break
			}
		}
		const el: El = { name, attrs, children: [] }
		top().children.push(el)
		if (!VOID.has(name) && !selfClose && stack.length < MAX_STACK_DEPTH) {
			stack.push(el)
			openCount.set(name, (openCount.get(name) ?? 0) + 1)
		}
	}
	const RAW_END: Record<string, RegExp> = {}

	const n = html.length
	let i = 0
	let tick = 0
	while (i < n && !full) {
		if ((++tick & 255) === 0 && now() > deadline) throw new HtmlLimitError("HTML too complex (time limit exceeded while parsing)")
		const lt = html.indexOf("<", i)
		if (lt === -1) {
			addText(decodeEntities(html.slice(i)))
			break
		}
		if (lt > i) addText(decodeEntities(html.slice(i, lt)))
		i = lt
		if (html.startsWith("<!--", i)) {
			const end = html.indexOf("-->", i + 4)
			i = end === -1 ? n : end + 3
			continue
		}
		if (html.startsWith("<![CDATA[", i)) {
			const end = html.indexOf("]]>", i)
			addText(html.slice(i + 9, end === -1 ? n : end))
			i = end === -1 ? n : end + 3
			continue
		}
		const next = html[i + 1]
		if (next === "!" || next === "?") {
			const end = html.indexOf(">", i)
			i = end === -1 ? n : end + 1
			continue
		}
		if (next === "/") {
			const m = /^<\/([a-zA-Z][^\s>/]*)[^>]*>?/.exec(html.slice(i, i + 300))
			if (!m) {
				addText("<")
				i++
				continue
			}
			closeTo(m[1].toLowerCase())
			i += m[0].length
			continue
		}
		if (!next || !/[a-zA-Z]/.test(next)) {
			addText("<")
			i++
			continue
		}
		// thẻ mở: đọc tên + thuộc tính (tôn trọng nháy)
		let j = i + 1
		while (j < n && !/[\s/>]/.test(html[j])) j++
		const name = html.slice(i + 1, j).toLowerCase()
		const attrs: Record<string, string> = {}
		let selfClose = false
		while (j < n) {
			while (j < n && /\s/.test(html[j])) j++
			if (j >= n) break
			if (html[j] === ">") {
				j++
				break
			}
			if (html[j] === "/") {
				if (html[j + 1] === ">") selfClose = true
				j++
				continue
			}
			let k = j
			while (k < n && !/[\s=/>]/.test(html[k])) k++
			if (k === j) {
				j++
				continue
			}
			const an = html.slice(j, k).toLowerCase()
			j = k
			while (j < n && /\s/.test(html[j])) j++
			let val = ""
			if (html[j] === "=") {
				j++
				while (j < n && /\s/.test(html[j])) j++
				const q = html[j]
				if (q === '"' || q === "'") {
					const e = html.indexOf(q, j + 1)
					val = html.slice(j + 1, e === -1 ? n : e)
					j = e === -1 ? n : e + 1
				} else {
					k = j
					while (k < n && !/[\s>]/.test(html[k])) k++
					val = html.slice(j, k)
					j = k
				}
			}
			if (!(an in attrs)) attrs[an] = decodeEntities(val)
		}
		i = j
		open(name, attrs, selfClose)
		if (name === "script" || name === "style" || name === "textarea" || name === "title") {
			// global + lastIndex: không cắt html.slice(i) mỗi thẻ (tránh bình phương khi có rất nhiều <script>)
			const re = (RAW_END[name] ??= new RegExp(`</${name}\\s*>`, "gi"))
			re.lastIndex = i
			const m = re.exec(html)
			const end = m ? m.index : n
			if (name === "textarea" || name === "title") addText(decodeEntities(html.slice(i, end)))
			i = m ? end + m[0].length : n
			closeTo(name)
		}
	}
	return root
}

function hidden(el: El): boolean {
	return OMITTED.has(el.name) || "hidden" in el.attrs || el.attrs["aria-hidden"]?.toLowerCase() === "true"
}

// ---------- text ----------
export function extractText(html: string, deadline: number = now() + TIME_BUDGET_MS): string {
	const out: string[] = []
	let outLen = 0
	let tick = 0
	const walk = (node: Node, depth: number) => {
		if ((++tick & 1023) === 0 && now() > deadline) throw new HtmlLimitError("HTML too complex (time limit exceeded)")
		if (typeof node === "string") {
			if (outLen <= MAX_OUTPUT_CHARS) out.push(node)
			outLen += node.length
			return
		}
		if (hidden(node) || depth > 2000) return
		const block = BLOCKS.has(node.name) || node.name === "br"
		if (block) out.push("\n")
		for (const c of node.children) walk(c, depth + 1)
		if (block) out.push("\n")
	}
	walk(parseHTML(html, deadline), 0)
	return out
		.join("")
		.slice(0, MAX_OUTPUT_CHARS)
		.replace(/[ \t\f\r]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

// ---------- markdown ----------
const escapeText = (s: string) =>
	s
		.replace(/([\\`*_[\]<>|])/g, "\\$1")
		.replace(/~/g, "\\~")
		.replace(/^([#+-])/, "\\$1")
		.replace(/^(\d+)\./, "$1\\.")
/** Độ dài lớn nhất của một dải backtick liên tiếp (tuyến tính; không spread mảng lớn vào Math.max). */
function longestTicks(s: string): number {
	let best = 0
	let cur = 0
	for (let k = 0; k < s.length; k++) {
		if (s.charCodeAt(k) === 96) {
			if (++cur > best) best = cur
		} else cur = 0
	}
	return best
}
/** Bỏ khoảng trắng cuối dòng (tuyến tính). Giữ hard break "  " nếu dải bắt đầu bằng 2 dấu cách như hành vi cũ. */
function trimTrailingWs(s: string): string {
	return s
		.split("\n")
		.map((l, idx, arr) => {
			if (idx === arr.length - 1) return l // dòng cuối không có "\n" theo sau
			let k = l.length
			while (k > 0 && (l.charCodeAt(k - 1) === 32 || l.charCodeAt(k - 1) === 9)) k--
			if (k === l.length) return l
			return l.slice(0, k) + (l.startsWith("  ", k) ? "  " : "")
		})
		.join("\n")
}
const dest = (v: string) => v.replace(/([\\()])/g, "\\$1").replace(/\s+/g, "%20")
const titleOf = (v: string | undefined) => (v ? ` "${v.replace(/\s+/g, " ").trim().replace(/([\\"])/g, "\\$1")}"` : "")
const textOf = (n: Node): string =>
	typeof n === "string" ? n : hidden(n) ? "" : n.children.map(textOf).join("")

export function convertHTMLToMarkdown(html: string, deadline: number = now() + TIME_BUDGET_MS): string {
	try {
		return convertMarkdown(html, deadline)
	} catch (e) {
		if (!(e instanceof HtmlLimitError) || e.message.includes("time limit")) throw e
		// Đầu ra khuếch đại quá mức (lồng sâu): lùi về văn bản thuần (tuyến tính theo đầu vào)
		return "[HTML too large or deeply nested for markdown conversion; showing plain text]\n\n" + extractText(html, deadline)
	}
}

function convertMarkdown(html: string, deadline: number): string {
	const BR = "\n\n"
	let work = 0
	let tick = 0
	const charge = (n: number) => {
		work += n
		if (work > MAX_WORK_CHARS || n > MAX_OUTPUT_CHARS) throw new HtmlLimitError("HTML output too large (amplification limit)")
	}
	function inline(nodes: Node[], depth: number): string {
		return nodes.map((n) => node(n, depth)).join("")
	}
	function prefixLines(s: string, prefix: string, first = prefix) {
		charge(s.length)
		return s
			.split("\n")
			.map((l, i) => (l.trim() === "" && prefix.trim() === "" ? "" : (i === 0 ? first : prefix) + l))
			.join("\n")
	}
	function table(el: El, depth: number): string {
		const rows: string[][] = []
		let caption = ""
		let simple = true
		const walk = (n: Node) => {
			if (typeof n === "string" || hidden(n)) return
			if (n.name === "caption") caption = inline(n.children, depth + 1).replace(/\s+/g, " ").trim()
			else if (n.name === "tr") {
				const row: string[] = []
				for (const c of n.children) {
					if (typeof c === "string" || (c.name !== "td" && c.name !== "th")) continue
					if (c.attrs.colspan || c.attrs.rowspan) simple = false
					row.push(inline(c.children, depth + 1).replace(/\s+/g, " ").trim().replace(/(?<!\\)\|/g, "\\|"))
				}
				rows.push(row)
			} else if (n.name !== "table") n.children.forEach(walk)
			else return
		}
		el.children.forEach(walk)
		const width = rows[0]?.length ?? 0
		let body: string
		if (simple && width > 0 && rows.every((r) => r.length === width)) {
			body =
				`| ${rows[0].join(" | ")} |\n|${" --- |".repeat(width)}` +
				rows
					.slice(1)
					.map((r) => `\n| ${r.join(" | ")} |`)
					.join("")
		} else body = rows.map((r) => r.join(" | ")).join(BR)
		return BR + (caption ? caption + BR : "") + body + BR
	}
	function list(el: El, depth: number): string {
		const ordered = el.name === "ol"
		let num = parseInt(el.attrs.start ?? "1", 10)
		if (Number.isNaN(num)) num = 1
		const items: string[] = []
		for (const c of el.children) {
			if (typeof c === "string") {
				if (c.trim()) items.push(`- ${escapeText(c.trim())}`)
				continue
			}
			if (hidden(c)) continue
			if (c.name !== "li") {
				items.push(node(c, depth + 1).trim())
				continue
			}
			const v = parseInt(c.attrs.value ?? "", 10)
			if (ordered && !Number.isNaN(v)) num = v
			const marker = ordered ? `${num++}.` : "-"
			const body = inline(c.children, depth + 1)
				.replace(/\n{3,}/g, "\n\n")
				.trim()
			items.push(prefixLines(body, " ".repeat(marker.length + 1), `${marker} `))
		}
		return BR + items.join("\n") + BR
	}
	function node(n: Node, depth: number): string {
		if ((++tick & 511) === 0 && now() > deadline) throw new HtmlLimitError("HTML too complex (time limit exceeded)")
		const r = node0(n, depth)
		charge(r.length)
		return r
	}
	function node0(n: Node, depth: number): string {
		if (typeof n === "string") return escapeText(n.replace(/[\t\n\f\r ]+/g, " "))
		if (hidden(n)) return ""
		if (depth > MAX_DEPTH) return textOf(n).replace(/\s+/g, " ")
		const d = depth + 1
		const name = n.name
		if (/^h[1-6]$/.test(name)) {
			const t = inline(n.children, d).replace(/\s+/g, " ").trim()
			return t ? `${BR}${"#".repeat(Number(name[1]))} ${t}${BR}` : ""
		}
		switch (name) {
			case "br":
				return "  \n"
			case "hr":
				return `${BR}---${BR}`
			case "strong":
			case "b":
			case "em":
			case "i":
			case "s":
			case "strike":
			case "del": {
				const mk = name === "strong" || name === "b" ? "**" : name === "em" || name === "i" ? "*" : "~~"
				const t = inline(n.children, d)
				const core = t.trim()
				if (!core || core.includes("\n")) return t
				return `${t.startsWith(" ") ? " " : ""}${mk}${core}${mk}${t.endsWith(" ") ? " " : ""}`
			}
			case "a": {
				const href = n.attrs.href
				const t = inline(n.children, d)
				if (!href || !t.trim()) return t
				const core = t.trim().replace(/\n+/g, " ")
				return `${t.startsWith(" ") ? " " : ""}[${core}](${dest(href)}${titleOf(n.attrs.title)})${t.endsWith(" ") ? " " : ""}`
			}
			case "img": {
				const alt = (n.attrs.alt ?? "").replace(/([\\\]])/g, "\\$1")
				return `![${alt}](${dest(n.attrs.src ?? "")}${titleOf(n.attrs.title)})`
			}
			case "pre": {
				const code = n.children.find((c): c is El => typeof c !== "string" && c.name === "code")
				const lang = (code?.attrs.class ?? "").match(/(?:language-|lang-)([^\s]+)/)?.[1] ?? ""
				const raw = (function pre(x: Node): string {
					if (typeof x === "string") return x
					if (hidden(x)) return ""
					return x.name === "br" ? "\n" : x.children.map(pre).join("")
				})(n)
				const longest = longestTicks(raw)
				const fence = "`".repeat(Math.max(3, longest + 1))
				return `${BR}${fence}${lang}\n${raw.replace(/\n$/, "")}\n${fence}${BR}`
			}
			case "code": {
				const raw = textOf(n)
				if (!raw) return ""
				const longest = longestTicks(raw)
				const fence = "`".repeat(longest + 1)
				const pad = /^[ `]|[ `]$/.test(raw) && !/^ +$/.test(raw) ? " " : ""
				return `${fence}${pad}${raw}${pad}${fence}`
			}
			case "blockquote": {
				const body = inline(n.children, d).replace(/\n{3,}/g, "\n\n").trim()
				return body ? BR + prefixLines(body, "> ").replace(/^> $/gm, ">") + BR : ""
			}
			case "ul":
			case "ol":
				return list(n, d)
			case "li":
				return list({ name: "ul", attrs: {}, children: [n] }, d)
			case "table":
				return table(n, d)
			case "dt":
				return `${BR}**${inline(n.children, d).trim()}**${BR}`
			case "dd":
				return `\n: ${inline(n.children, d).trim()}${BR}`
			case "details": {
				const open = "open" in n.attrs
				const kids = n.children.filter(
					(c) => open || (typeof c !== "string" && c.name === "summary"),
				)
				return BR + inline(kids, d) + BR
			}
		}
		const t = inline(n.children, d)
		return BLOCKS.has(name) ? BR + t + BR : t
	}

	const out = inline(parseHTML(html, deadline).children, 0)
	let fence = ""
	const final = trimTrailingWs(out)
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((l) => {
			const m = /^(`{3,})/.exec(l)
			if (m) fence = fence ? (l.startsWith(fence) ? "" : fence) : m[1]
			else if (!fence && /^ \S/.test(l)) return l.slice(1)
			return l
		})
		.join("\n")
		.trim()
	return final.length > MAX_OUTPUT_CHARS
		? final.slice(0, MAX_OUTPUT_CHARS) + "\n\n[output truncated: converted markdown exceeded the size limit]"
		: final
}
