// Test hồi quy apply-patch (node --test --experimental-strip-types test/)
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, chmod, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Stub gói Pi + typebox (không có node_modules trong coder)
register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const withFileMutationQueue=(p,f)=>f(); export const getAgentDir=()=>process.env.PI_CODING_AGENT_DIR; export const truncateHead=(t)=>({content:t,truncated:false}); export const DEFAULT_MAX_BYTES=51200, DEFAULT_MAX_LINES=2000; export const formatSize=(n)=>n+'B';"), shortCircuit: true };
  if (s === "typebox") return { url: "data:text/javascript," + encodeURIComponent("const p=new Proxy(()=>({}),{get:()=>p,apply:()=>({})}); export const Type=p;"), shortCircuit: true };
  return n(s, c);
}`),
	import.meta.url,
);
const mod = await import(pathToFileURL(new URL("../agent/extensions/apply-patch/index.ts", import.meta.url).pathname).href);

let tool;
mod.default({ registerTool: (t) => (tool = t) });
const patch = (cwd, text) => tool.execute("id", { patchText: text }, undefined, undefined, { cwd });
const mk = async () => await mkdtemp(join(tmpdir(), "ap-test-"));
const rejects = (p, re) => assert.rejects(p, re);

test("P1: Add File qua symlink treo trỏ ra ngoài cwd bị từ chối", async () => {
	const cwd = await mk();
	const outside = await mk();
	const target = join(outside, "pwned.txt");
	await symlink(target, join(cwd, "dang"));
	await rejects(patch(cwd, "*** Begin Patch\n*** Add File: dang\n+x\n*** End Patch"), /symbolic link/);
	await assert.rejects(lstat(target), { code: "ENOENT" });
	await rm(cwd, { recursive: true });
	await rm(outside, { recursive: true });
});

test("P1: thư mục giữa là symlink treo / trỏ ra ngoài bị từ chối", async () => {
	const cwd = await mk();
	const outside = await mk();
	await symlink(join(outside, "nodir"), join(cwd, "d1"));
	await symlink(outside, join(cwd, "d2"));
	await rejects(patch(cwd, "*** Begin Patch\n*** Add File: d1/a.txt\n+x\n*** End Patch"), /dangling|outside/);
	await rejects(patch(cwd, "*** Begin Patch\n*** Add File: d2/a.txt\n+x\n*** End Patch"), /outside/);
	await rejects(patch(cwd, "*** Begin Patch\n*** Add File: d2/sub/a.txt\n+x\n*** End Patch"), /outside/);
	assert.deepEqual(await readdir(outside), []);
	await rm(cwd, { recursive: true });
	await rm(outside, { recursive: true });
});

test("P1: Update/Delete/Move qua symlink bị từ chối; symlink trong cwd (file) cũng không ghi xuyên", async () => {
	const cwd = await mk();
	const outside = await mk();
	await writeFile(join(outside, "secret.txt"), "s\n");
	await symlink(join(outside, "secret.txt"), join(cwd, "l"));
	await writeFile(join(cwd, "real.txt"), "a\n");
	await symlink(join(cwd, "real.txt"), join(cwd, "inl"));
	await rejects(patch(cwd, "*** Begin Patch\n*** Update File: l\n@@\n-s\n+t\n*** End Patch"), /symbolic link/);
	await rejects(patch(cwd, "*** Begin Patch\n*** Delete File: l\n*** End Patch"), /symbolic link/);
	await rejects(patch(cwd, "*** Begin Patch\n*** Update File: real.txt\n*** Move to: l\n@@\n-a\n+b\n*** End Patch"), /symbolic link/);
	await rejects(patch(cwd, "*** Begin Patch\n*** Update File: inl\n@@\n-a\n+b\n*** End Patch"), /symbolic link/);
	assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "s\n");
	assert.equal(await readFile(join(cwd, "real.txt"), "utf8"), "a\n");
	await rm(cwd, { recursive: true });
	await rm(outside, { recursive: true });
});

test("P1: giữ chặn .. và đường dẫn tuyệt đối ngoài cwd; thêm file bình thường vẫn chạy", async () => {
	const cwd = await mk();
	await rejects(patch(cwd, "*** Begin Patch\n*** Add File: ../x.txt\n+x\n*** End Patch"), /outside/);
	await rejects(patch(cwd, "*** Begin Patch\n*** Add File: /etc/zz-x\n+x\n*** End Patch"), /outside/);
	await patch(cwd, "*** Begin Patch\n*** Add File: a/b/c.txt\n+hi\n*** End Patch");
	assert.equal(await readFile(join(cwd, "a/b/c.txt"), "utf8"), "hi\n");
	await rm(cwd, { recursive: true });
});

test("P2: file latin1 không phải UTF-8 bị từ chối Update, byte nguyên vẹn", async () => {
	const cwd = await mk();
	const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]); // "café" latin1
	await writeFile(join(cwd, "l.txt"), bytes);
	await rejects(patch(cwd, "*** Begin Patch\n*** Update File: l.txt\n@@\n-x\n+y\n*** End Patch"), /not valid UTF-8/);
	assert.deepEqual(await readFile(join(cwd, "l.txt")), bytes);
	await rm(cwd, { recursive: true });
});

test("P2: CRLF trộn được giữ nguyên từng dòng", async () => {
	const cwd = await mk();
	await writeFile(join(cwd, "m.txt"), "a\r\nb\nx\nc\r\n");
	await patch(cwd, "*** Begin Patch\n*** Update File: m.txt\n@@\n a\n b\n-x\n+y\n c\n*** End Patch");
	assert.equal(await readFile(join(cwd, "m.txt"), "utf8"), "a\r\nb\ny\nc\r\n");
	// file CRLF thuần: dòng thêm kế thừa CRLF
	await writeFile(join(cwd, "c.txt"), "1\r\n2\r\n3\r\n");
	await patch(cwd, "*** Begin Patch\n*** Update File: c.txt\n@@\n 2\n+2b\n 3\n*** End Patch");
	assert.equal(await readFile(join(cwd, "c.txt"), "utf8"), "1\r\n2\r\n2b\r\n3\r\n");
	await rm(cwd, { recursive: true });
});

test("P2: không có newline cuối được giữ khi không đụng dòng cuối; BOM giữ", async () => {
	const cwd = await mk();
	await writeFile(join(cwd, "n.txt"), "﻿a\nb\nc");
	await patch(cwd, "*** Begin Patch\n*** Update File: n.txt\n@@\n-a\n+A\n b\n*** End Patch");
	assert.equal(await readFile(join(cwd, "n.txt"), "utf8"), "﻿A\nb\nc");
	await rm(cwd, { recursive: true });
});

test("P2: giữ mode file (kể cả khi Move) và không để lại tệp tạm", async () => {
	const cwd = await mk();
	await writeFile(join(cwd, "s.sh"), "echo a\n");
	await chmod(join(cwd, "s.sh"), 0o750);
	await patch(cwd, "*** Begin Patch\n*** Update File: s.sh\n@@\n-echo a\n+echo b\n*** End Patch");
	assert.equal((await stat(join(cwd, "s.sh"))).mode & 0o777, 0o750);
	await patch(cwd, "*** Begin Patch\n*** Update File: s.sh\n*** Move to: t.sh\n@@\n-echo b\n+echo c\n*** End Patch");
	assert.equal((await stat(join(cwd, "t.sh"))).mode & 0o777, 0o750);
	assert.deepEqual((await readdir(cwd)).sort(), ["t.sh"]);
	await rm(cwd, { recursive: true });
});

test("P2: rollback khôi phục byte nhị phân và mode", async () => {
	const cwd = await mk();
	const bin = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]);
	await writeFile(join(cwd, "bin.dat"), bin);
	await chmod(join(cwd, "bin.dat"), 0o700);
	// Delete file nhị phân rồi ghi lỗi ở file kế (thư mục cha là file) -> rollback
	await writeFile(join(cwd, "blocker"), "x");
	await rejects(
		patch(cwd, "*** Begin Patch\n*** Delete File: bin.dat\n*** Add File: blocker/sub.txt\n+x\n*** End Patch"),
		/rolled back|verification failed/,
	);
	assert.deepEqual(await readFile(join(cwd, "bin.dat")), bin);
	assert.equal((await stat(join(cwd, "bin.dat"))).mode & 0o777, 0o700);
	await rm(cwd, { recursive: true });
});

test("P2: Move to vào file đã tồn tại bị từ chối; hợp lệ nếu patch xoá đích trước", async () => {
	const cwd = await mk();
	await writeFile(join(cwd, "a.txt"), "a\n");
	await writeFile(join(cwd, "b.txt"), "keep\n");
	await rejects(patch(cwd, "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+A\n*** End Patch"), /already exists/);
	assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "keep\n");
	assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "a\n");
	await patch(cwd, "*** Begin Patch\n*** Delete File: b.txt\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+A\n*** End Patch");
	assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "A\n");
	await assert.rejects(lstat(join(cwd, "a.txt")));
	await rm(cwd, { recursive: true });
});
