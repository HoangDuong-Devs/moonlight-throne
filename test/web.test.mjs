// Test hồi quy web: isBlockedIp (W2), giới hạn DoS html->markdown (W1), tệp tạm (W1c)
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readdir, stat, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const withFileMutationQueue=(p,f)=>f(); export const getAgentDir=()=>process.env.PI_CODING_AGENT_DIR; export const DEFAULT_MAX_BYTES=51200, DEFAULT_MAX_LINES=2000; export const formatSize=(n)=>n+'B'; export const truncateHead=(t,o)=>{const lines=t.split('\\\\n');const c=lines.slice(0,o.maxLines).join('\\\\n').slice(0,o.maxBytes);return {content:c,truncated:c.length<t.length,outputLines:1,totalLines:lines.length,outputBytes:c.length,totalBytes:t.length}};"), shortCircuit: true };
  if (s === "typebox") return { url: "data:text/javascript," + encodeURIComponent("const p=new Proxy(()=>({}),{get:()=>p,apply:()=>({})}); export const Type=p;"), shortCircuit: true };
  return n(s, c);
}`),
	import.meta.url,
);
const base = new URL("../agent/extensions/web/", import.meta.url);
const core = await import(pathToFileURL(new URL("core.ts", base).pathname).href);
const html = await import(pathToFileURL(new URL("html.ts", base).pathname).href);
const webIndex = await import(pathToFileURL(new URL("index.ts", base).pathname).href);

// ---------- W2 ----------
const BLOCKED = [
	// IPv4
	"0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255",
	// IPv6 nội bộ
	"::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1", "febf::1", "ff02::1", "ff00::",
	// IPv4 nhúng
	"::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254",
	"::7f00:1", "::a00:1", "::127.0.0.1", "::10.0.0.1",
	"64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
	"2002:a00:1::", "2002:7f00:1::1", "2002:c0a8:101::", "2002:a9fe:a9fe::5",
	"::ffff:0:a00:1", "::ffff:0:127.0.0.1",
	"2001:0::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::",
	"2001:db8::1", "100::1", "::5efe:10.0.0.1", "2001:db8:1:2:0:5efe:a00:1",
	"0:0:0:0:0:0:0:1", "[::1]",
	// rác
	"not-an-ip", "",
];
const ALLOWED = [
	"93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1",
	"2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2620:fe::fe",
	"::ffff:93.184.216.34", "::ffff:808:808", "64:ff9b::808:808", "64:ff9b::93.184.216.34", "2002:5db8:d822::1",
	"2001:200::1", "2400:cb00::1", "[2606:4700:4700::1111]",
];
test("W2: isBlockedIp chặn đủ bảng", () => {
	for (const ip of BLOCKED) assert.equal(core.isBlockedIp(ip), true, `phải chặn ${ip}`);
});
test("W2: isBlockedIp không chặn địa chỉ công cộng hợp lệ", () => {
	for (const ip of ALLOWED) assert.equal(core.isBlockedIp(ip), false, `không được chặn ${ip}`);
});
test("W2: assertUrlAllowed chặn URL IPv6 nhúng IPv4 (URL() chuẩn hoá thành hex)", async () => {
	for (const u of ["http://[::ffff:127.0.0.1]/", "http://[64:ff9b::a00:1]/", "http://[2002:a00:1::]/", "http://[fec0::1]/", "http://[::7f00:1]/"])
		await assert.rejects(core.assertUrlAllowed(new URL(u), { allowPrivateNetwork: false, allowedHosts: [] }), /Blocked/, u);
	await core.assertUrlAllowed(new URL("http://93.184.216.34/"), { allowPrivateNetwork: false, allowedHosts: [] });
	await core.assertUrlAllowed(new URL("http://[2606:4700:4700::1111]/"), { allowPrivateNetwork: false, allowedHosts: [] });
});

// ---------- W1 ----------
const timed = (f) => {
	const t = Date.now();
	let out, err;
	try {
		out = f();
	} catch (e) {
		err = e;
	}
	return { ms: Date.now() - t, out, err };
};

test("W1a: <pre> + nhiều dấu cách chạy tuyến tính (5MB)", () => {
	const r = timed(() => html.convertHTMLToMarkdown("<pre>" + " ".repeat(4_900_000) + "x</pre>"));
	assert.ok(r.ms < 3000, `mất ${r.ms}ms`);
	const r2 = timed(() => html.convertHTMLToMarkdown("<p>" + "a \t".repeat(100) + "\n" + " ".repeat(2_000_000) + "\n<br>x</p>"));
	assert.ok(r2.ms < 3000, `mất ${r2.ms}ms`);
});
test("W1a: giữ hành vi khoảng trắng cuối dòng", () => {
	assert.equal(html.convertHTMLToMarkdown("<p>hi  <br>there</p>"), "hi  \nthere");
	assert.equal(html.convertHTMLToMarkdown("<pre>a \t\nb  \nc</pre>"), "```\na\nb  \nc\n```");
});
test("W1b: <div>xN rồi </z>xN không bình phương / không tràn stack", () => {
	const r = timed(() => html.convertHTMLToMarkdown("<div>".repeat(300_000) + "</z>".repeat(300_000)));
	assert.ok(r.ms < 3000 && !r.err, `mất ${r.ms}ms ${r.err}`);
	const r2 = timed(() => html.extractText("<div>x".repeat(300_000) + "</z>".repeat(300_000)));
	assert.ok(r2.ms < 3000 && !r2.err, `mất ${r2.ms}ms ${r2.err}`);
	const r3 = timed(() => html.convertHTMLToMarkdown("</z>".repeat(1_000_000) + "<div>".repeat(500_000)));
	assert.ok(r3.ms < 3000 && !r3.err, `mất ${r3.ms}ms ${r3.err}`);
});
test("W1b: nhiều <script> không bình phương; backtick nhiều không tràn spread", () => {
	assert.ok(timed(() => html.convertHTMLToMarkdown("<script>x</script>".repeat(250_000))).ms < 3000);
	const r = timed(() => html.convertHTMLToMarkdown("<pre>" + "`a".repeat(1_000_000) + "</pre>"));
	assert.ok(!r.err && r.ms < 3000, String(r.err));
});
test("W1c: blockquote lồng 190 + <p> không khuếch đại đầu ra", () => {
	const input = "<blockquote>".repeat(190) + "<p>a</p>".repeat(100_000);
	const r = timed(() => html.convertHTMLToMarkdown(input));
	assert.ok(!r.err, String(r.err));
	assert.ok(r.out.length <= html.MAX_OUTPUT_CHARS + 200, `đầu ra ${r.out.length}`);
	assert.ok(r.ms < 4000, `mất ${r.ms}ms`);
	assert.match(r.out, /plain text|truncated/);
});
test("W1c: tài liệu bình thường vẫn chuyển đổi đúng", () => {
	const md = html.convertHTMLToMarkdown(
		"<h1>Tiêu đề</h1><p>Một <b>đậm</b> và <a href='http://x.y/z'>link</a></p><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><blockquote><p>q</p></blockquote><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code class='language-js'>let x = `1`;</code></pre>",
	);
	assert.equal(
		md,
		"# Tiêu đề\n\nMột **đậm** và [link](http://x.y/z)\n\n- a\n- b\n\n  - c\n\n> q\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x = `1`;\n```",
	);
});
test("W1: giới hạn thời gian parse/render", () => {
	const input = "<p>a</p>".repeat(200_000);
	assert.throws(() => html.convertHTMLToMarkdown(input, Date.now() - 1), /time limit/);
	assert.throws(() => html.extractText(input, Date.now() - 1), /time limit/);
});

test("W1: webFetch end-to-end với máy chủ cục bộ (HTML độc hại), kết quả bị giới hạn", async () => {
	const evil = "<blockquote>".repeat(190) + "<p>a</p>".repeat(100_000);
	const srv = http.createServer((req, res) => {
		res.setHeader("content-type", "text/html");
		res.end(req.url === "/evil" ? evil : "<h1>ok</h1><p>hi</p>");
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	try {
		const { port } = srv.address();
		const cfg = { allowPrivateNetwork: true, allowedHosts: [] };
		const t = Date.now();
		const r = await core.webFetch({ url: `http://127.0.0.1:${port}/evil` }, cfg);
		assert.ok(r.output.length <= html.MAX_OUTPUT_CHARS + 200 && Date.now() - t < 5000);
		assert.equal((await core.webFetch({ url: `http://127.0.0.1:${port}/ok` }, cfg)).output, "# ok\n\nhi");
		// mặc định chặn localhost
		await assert.rejects(core.webFetch({ url: `http://127.0.0.1:${port}/ok` }, { allowPrivateNetwork: false, allowedHosts: [] }), /Blocked/);
	} finally {
		srv.closeAllConnections?.();
		await new Promise((r) => srv.close(r));
	}
});

// ---------- tệp tạm ----------
test("W1c: tệp kết quả đầy đủ 0600 trong thư mục 0700; dọn thư mục cũ", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "web-tmp-"));
	const oldTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = tmp;
	try {
		// thư mục cũ phải bị dọn, thư mục lạ (không khớp tiền tố) giữ nguyên
		await mkdir(join(tmp, "pi-webfetch-old"));
		await utimes(join(tmp, "pi-webfetch-old"), new Date(Date.now() - 48 * 3600_000), new Date(Date.now() - 48 * 3600_000));
		await mkdir(join(tmp, "other-dir"));
		let tool;
		webIndex.default({ registerTool: (t) => t.name === "webfetch" && (tool = t) });
		const srv = http.createServer((_q, res) => {
			res.setHeader("content-type", "text/plain");
			res.end("line\n".repeat(100_000));
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "web-agent-"));
		await (await import("node:fs/promises")).writeFile(join(process.env.PI_CODING_AGENT_DIR, "web.json"), JSON.stringify({ allowPrivateNetwork: true }));
		try {
			const r = await tool.execute("id", { url: `http://127.0.0.1:${srv.address().port}/`, format: "text" });
			const p = r.details.fullOutputPath;
			assert.ok(p, "có đường dẫn đầy đủ");
			assert.equal((await stat(p)).mode & 0o777, 0o600);
			assert.equal((await stat(join(p, ".."))).mode & 0o777, 0o700);
		} finally {
			srv.closeAllConnections?.();
			await new Promise((r) => srv.close(r));
			await rm(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		}
		const names = await readdir(tmp);
		assert.ok(!names.includes("pi-webfetch-old"), "thư mục cũ đã dọn");
		assert.ok(names.includes("other-dir"));
	} finally {
		if (oldTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = oldTmpdir;
		await rm(tmp, { recursive: true });
	}
});
test("W1c: sweepOutputs giữ tối đa 20 thư mục mới nhất", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "web-sweep-"));
	for (let i = 0; i < 25; i++) await mkdir(join(tmp, `pi-websearch-${i}`));
	await webIndex.sweepOutputs(tmp);
	assert.equal((await readdir(tmp)).length, 20);
	await rm(tmp, { recursive: true });
});
