/**
 * snapshot — hoàn tác theo git (cổng từ opencode snapshot.ts): chụp trạng thái thư mục làm việc vào kho git "bóng"
 * <agent-dir>/snapshots/<hash cwd>/ (GIT_DIR) với GIT_WORK_TREE=cwd, nên chạy được cả khi cwd không phải git repo
 * và không bao giờ đụng .git/lịch sử của người dùng.
 *
 * - Tự chụp ở đầu mỗi lượt model (turn_start) và khi agent xong (agent_end); trùng cây thì dùng lại snapshot cũ.
 * - Tôn trọng .gitignore; luôn bỏ .git, node_modules, .env*, khóa/credential, file > maxFileBytes (mặc định 2MB).
 * - Ở session_start dọn nền (tối đa 1 lần/giờ) các kho của thư mục làm việc cũ: snapshot.json "prune":
 *   { enabled, maxAgeDays (14), maxTotalMB (1000) }. Kho của cwd hiện tại không bao giờ bị xóa.
 * - Giữ `keep` snapshot gần nhất (mặc định 50), giới hạn dung lượng maxRepoMB. Cấu hình: <agent-dir>/snapshot.json.
 * - Không đăng ký tool cho model. Cho người dùng TUI: /snapshots, /revert <id> [--dry-run]. Bot dùng lib/snapshot-cli.mjs.
 * - Logic dùng chung nằm ở tools/moonlight-throne/lib/snapshot-cli.mjs (một nguồn duy nhất).
 * Lỗi chụp không bao giờ làm hỏng lượt chạy (chỉ ghi stderr khi CODER_SNAPSHOT_DEBUG=1).
 */
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
// @ts-ignore: module .mjs thuần, không có kiểu
import { listSnapshots, maybePruneRepos, openContext, revertTo, takeSnapshot } from "../../../lib/snapshot-cli.mjs";

export default function snapshotExtension(pi: ExtensionAPI): void {
	let chain: Promise<unknown> = Promise.resolve();
	const debug = (m: string) => {
		if (process.env.CODER_SNAPSHOT_DEBUG || process.env.PI_SNAPSHOT_DEBUG) console.error(`[snapshot] ${m}`);
	};

	const sessionOf = (ctx: ExtensionContext): string | undefined => {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	};

	const open = (ctx: ExtensionContext) => openContext({ cwd: ctx.cwd, agentDir: getAgentDir(), indexName: `ext-${process.pid}` });

	// Tuần tự hóa mọi thao tác chụp để không đua nhau trên cùng index.
	const enqueue = (fn: () => Promise<unknown>): Promise<unknown> => {
		chain = chain.then(fn).catch((e) => debug(`lỗi: ${(e as Error).message}`));
		return chain;
	};

	const capture = (ctx: ExtensionContext, kind: "turn" | "end", turn?: number) =>
		enqueue(async () => {
			const sctx = open(ctx);
			if (!sctx.cfg.enabled || !sctx.cfg.capture[kind]) return;
			const r = await takeSnapshot(sctx, { session: sessionOf(ctx), turn, kind });
			debug(`${kind} turn=${turn ?? "-"} -> ${r.id}${r.reused ? " (dùng lại)" : ""} files=${r.files}`);
		});

	pi.on("session_start", async (_event, ctx) => {
		// Nền, không chặn khởi động; lỗi bị nuốt.
		try {
			const key = path.basename(open(ctx).gitDir);
			const t = setTimeout(() => {
				maybePruneRepos({ agentDir: getAgentDir(), protectKeys: [key] })
					.then((r: any) => r && debug(`prune: xóa ${r.removed.length} kho, ${(r.freedBytes / 1048576).toFixed(1)}MB`))
					.catch((e: Error) => debug(`prune lỗi: ${e.message}`));
			}, 3000);
			t.unref?.();
		} catch (e) {
			debug(`prune lỗi: ${(e as Error).message}`);
		}
	});

	pi.on("turn_start", async (event, ctx) => {
		await capture(ctx, "turn", (event as { turnIndex?: number }).turnIndex);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await capture(ctx, "end");
	});

	pi.registerCommand("snapshots", {
		description: "Liệt kê snapshot hoàn tác của thư mục làm việc",
		handler: async (_args, ctx) => {
			try {
				const rows = await listSnapshots(open(ctx), { limit: 20 });
				const text = rows.length
					? rows.map((r: any) => `${r.id}  ${r.time}  ${r.kind}  turn=${r.turn ?? "-"} files=${r.files ?? "?"}`).join("\n")
					: "(chưa có snapshot)";
				ctx.ui.notify(text, "info");
			} catch (e) {
				ctx.ui.notify(`snapshots: ${(e as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("revert", {
		description: "Khôi phục file về một snapshot: /revert <id|first|latest> [--dry-run]",
		handler: async (args, ctx) => {
			const words = (args ?? "").split(/\s+/).filter(Boolean);
			const dryRun = words.includes("--dry-run");
			const id = words.find((w) => !w.startsWith("--"));
			if (!id) {
				ctx.ui.notify("Cách dùng: /revert <snapshot-id|first|latest> [--dry-run] (xem /snapshots)", "warning");
				return;
			}
			try {
				const r = await revertTo(open(ctx), id, { dryRun, session: sessionOf(ctx) });
				const head = dryRun ? `[dry-run] revert về ${r.target}` : `Đã revert về ${r.target}`;
				const tail = r.preRevertSnapshot ? `\nHoàn tác việc revert: /revert ${r.preRevertSnapshot}` : "";
				ctx.ui.notify(`${head}: xóa ${r.delete.length}, khôi phục ${r.restore.length}, lỗi ${r.errors.length}${tail}`, r.errors.length ? "warning" : "info");
			} catch (e) {
				ctx.ui.notify(`revert: ${(e as Error).message}`, "error");
			}
		},
	});
}
