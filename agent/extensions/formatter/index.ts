/**
 * formatter: sau khi write/edit/apply_patch ghi file, chạy formatter theo đuôi file (cổng từ opencode formatter/builtins.ts).
 * Cấu hình: <MTH_AGENT_DIR>/formatter.json
 *   {
 *     "enabled": true,                 // false = tắt hẳn
 *     "timeoutMs": 10000,
 *     "disabled": ["prettier"],        // tên formatter tắt riêng
 *     "formatters": {                  // thêm/ghi đè; $FILE được thay bằng đường dẫn file
 *       "mine": { "command": ["mybin", "--fix", "$FILE"], "extensions": [".foo"] },
 *       "gofmt": { "disabled": true }
 *     },
 *     "trustRepoBinaries": false,      // true = tìm formatter trong node_modules/.bin của repo (đi lên từ cwd); mặc định KHÔNG tin repo
 *     "trustRepoConfig": false,        // true = bật formatter đọc cấu hình chạy mã của repo (prettier, rubocop, standardrb, mix)
 *     "passEnv": []                    // tên biến môi trường được chuyển cho formatter (mặc định chỉ PATH tin cậy, HOME tạm, LANG)
 *   }
 * Bảo mật: binary chỉ tìm trong PATH tin cậy (bỏ mục tương đối, mục nằm trong workdir, thư mục ai cũng ghi được); formatter chạy với
 * môi trường đã lọc (không có khóa/secret); formatter có cấu hình chạy mã (.prettierrc plugin, .rubocop.yml require, .formatter.exs) tắt mặc định.
 * Lỗi/timeout của formatter không làm hỏng tool result, chỉ thêm ghi chú. Formatter không cài thì không chạy gì.
 */
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Which = (bin: string) => string | null;
type Candidate = {
	name: string;
	extensions: string[];
	command: (cwd: string, which: Which) => string[] | null;
	/** true: formatter đọc cấu hình do repo cung cấp có thể chạy mã (plugin/require/.exs) -> chỉ bật khi trustRepoConfig */
	runsRepoConfig?: boolean;
};
type Config = {
	enabled?: boolean;
	timeoutMs?: number;
	disabled?: string[];
	trustRepoBinaries?: boolean;
	trustRepoConfig?: boolean;
	passEnv?: string[];
	formatters?: Record<string, { disabled?: boolean; command?: string[]; extensions?: string[] }>;
};

const realOr = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};
const isInside = (base: string, p: string) => {
	const r = relative(base, p);
	return r === "" || !(r === ".." || r.startsWith(".." + sep) || isAbsolute(r));
};

/** Thư mục PATH tin cậy: tuyệt đối, tồn tại, không nằm trong workdir, không phải thư mục ai cũng ghi được. */
export function trustedPathDirs(cwd: string, pathVar: string | undefined = process.env.PATH): string[] {
	const realCwd = realOr(cwd);
	const out: string[] = [];
	for (const d of (pathVar ?? "").split(delimiter)) {
		if (!d || !isAbsolute(d)) continue; // bỏ mục rỗng, ".", đường dẫn tương đối
		let rd: string;
		try {
			rd = realpathSync(d);
			const st = statSync(rd);
			if (!st.isDirectory() || (st.mode & 0o002) !== 0) continue;
		} catch {
			continue;
		}
		if (isInside(realCwd, rd) || isInside(realCwd, resolve(d))) continue;
		if (!out.includes(d)) out.push(d);
	}
	return out;
}

/** node_modules/.bin đi lên từ cwd (chỉ dùng khi trustRepoBinaries). */
function repoBinDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let d = cwd;
	for (;;) {
		dirs.push(join(d, "node_modules", ".bin"));
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return dirs;
}

/** Danh sách thư mục binary và hàm tìm, theo chính sách tin cậy. */
function makeFinder(cwd: string, cfg: Config): { dirs: string[]; which: Which } {
	const trust = cfg.trustRepoBinaries === true;
	const realCwd = realOr(cwd);
	const dirs = [...(trust ? repoBinDirs(cwd) : []), ...trustedPathDirs(cwd)];
	const which: Which = (bin) => {
		if (!bin || bin.includes("/") || bin.includes("\\") || bin.startsWith("-")) return null;
		for (const dir of dirs) {
			const p = join(dir, bin);
			try {
				accessSync(p, constants.X_OK);
				if (!statSync(p).isFile()) continue;
				if (!trust && isInside(realCwd, realpathSync(p))) continue; // symlink từ PATH tin cậy vào repo
				return p;
			} catch {
				/* next */
			}
		}
		return null;
	};
	return { dirs, which };
}

function findUp(name: string, cwd: string): string | null {
	let d = cwd;
	for (;;) {
		const p = join(d, name);
		try {
			accessSync(p, constants.R_OK);
			return p;
		} catch {
			/* next */
		}
		const up = dirname(d);
		if (up === d) return null;
		d = up;
	}
}

const readText = (p: string) => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
};

const simple = (name: string, extensions: string[], args: string[], runsRepoConfig = false): Candidate => ({
	name,
	extensions,
	runsRepoConfig,
	command: (_cwd, which) => {
		const bin = which(name);
		return bin ? [bin, ...args] : null;
	},
});

const WEB = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".md", ".mdx", ".graphql", ".gql"];

const BUILTINS: Candidate[] = [
	simple("gofmt", [".go"], ["-w", "$FILE"]),
	simple("mix", [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"], ["format", "$FILE"], true), // .formatter.exs là mã Elixir
	{
		// như opencode: chỉ bật khi package.json (gần nhất) khai báo prettier
		name: "prettier",
		extensions: WEB,
		runsRepoConfig: true, // plugin trong .prettierrc / prettier.config.js chạy mã
		command: (cwd, which) => {
			const pj = findUp("package.json", cwd);
			if (!pj) return null;
			try {
				const j = JSON.parse(readText(pj));
				if (!(j?.dependencies?.prettier || j?.devDependencies?.prettier)) return null;
			} catch {
				return null;
			}
			const bin = which("prettier");
			return bin ? [bin, "--write", "$FILE"] : null;
		},
	},
	{
		name: "biome",
		extensions: WEB,
		command: (cwd, which) => {
			if (!findUp("biome.json", cwd) && !findUp("biome.jsonc", cwd)) return null;
			const bin = which("biome");
			return bin ? [bin, "format", "--write", "$FILE"] : null;
		},
	},
	simple("zig", [".zig", ".zon"], ["fmt", "$FILE"]),
	{
		name: "clang-format",
		extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino"],
		command: (cwd, which) => {
			if (!findUp(".clang-format", cwd)) return null;
			const bin = which("clang-format");
			return bin ? [bin, "-i", "$FILE"] : null;
		},
	},
	simple("ktlint", [".kt", ".kts"], ["-F", "$FILE"]),
	{
		// như opencode: ruff cần có cấu hình ruff hoặc khai báo ruff trong requirements/pyproject/Pipfile
		name: "ruff",
		extensions: [".py", ".pyi"],
		command: (cwd, which) => {
			const bin = which("ruff");
			if (!bin) return null;
			for (const c of ["pyproject.toml", "ruff.toml", ".ruff.toml"]) {
				const f = findUp(c, cwd);
				if (!f) continue;
				if (c !== "pyproject.toml" || readText(f).includes("[tool.ruff]")) return [bin, "format", "$FILE"];
			}
			for (const c of ["requirements.txt", "pyproject.toml", "Pipfile"]) {
				const f = findUp(c, cwd);
				if (f && readText(f).includes("ruff")) return [bin, "format", "$FILE"];
			}
			return null;
		},
	},
	simple("rubocop", [".rb", ".rake", ".gemspec", ".ru"], ["--autocorrect", "$FILE"], true), // .rubocop.yml `require:` chạy mã
	simple("standardrb", [".rb", ".rake", ".gemspec", ".ru"], ["--fix", "$FILE"], true),
	simple("dart", [".dart"], ["format", "$FILE"]),
	simple("terraform", [".tf", ".tfvars"], ["fmt", "$FILE"]),
	simple("gleam", [".gleam"], ["format", "$FILE"]),
	simple("shfmt", [".sh", ".bash"], ["-w", "$FILE"]),
	simple("nixfmt", [".nix"], ["$FILE"]),
	simple("rustfmt", [".rs"], ["$FILE"]),
	simple("ormolu", [".hs"], ["-i", "$FILE"]),
	simple("cljfmt", [".clj", ".cljs", ".cljc", ".edn"], ["fix", "--quiet", "$FILE"]),
	simple("dfmt", [".d"], ["-i", "$FILE"]),
];

function loadConfig(): Config {
	try {
		return JSON.parse(readFileSync(join(getAgentDir(), "formatter.json"), "utf8")) as Config;
	} catch {
		return {}; // không có file / lỗi JSON: dùng mặc định (bật)
	}
}

function pickCommand(cfg: Config, file: string, cwd: string, finder = makeFinder(cwd, cfg)): { name: string; argv: string[] } | null {
	const ext = extname(file);
	const off = new Set(cfg.disabled ?? []);
	const candidates: Candidate[] = [];
	for (const [name, f] of Object.entries(cfg.formatters ?? {})) {
		if (f.disabled) off.add(name);
		else if (f.command?.length && f.extensions?.length) {
			const cmd = f.command;
			candidates.push({
				name,
				extensions: f.extensions,
				command: () => {
					const first = String(cmd[0]);
					let bin: string | null;
					if (isAbsolute(first)) bin = first; // đường dẫn tuyệt đối do người vận hành chỉ định trong formatter.json
					else if (first.includes("/")) bin = cfg.trustRepoBinaries === true ? resolve(cwd, first) : null; // tương đối = trong repo
					else bin = finder.which(first);
					return bin ? [bin, ...cmd.slice(1)] : null;
				},
			});
		}
	}
	for (const c of [...candidates, ...BUILTINS.filter((b) => !(cfg.formatters ?? {})[b.name]?.command)]) {
		if (off.has(c.name) || !c.extensions.includes(ext)) continue;
		if (c.runsRepoConfig && cfg.trustRepoConfig !== true) continue;
		const cmd = c.command(cwd, finder.which);
		if (cmd) return { name: c.name, argv: cmd };
	}
	return null;
}

const SAFE_ENV = ["LANG", "LC_ALL", "LC_CTYPE", "TZ"];
// trỏ tới cấu hình toolchain (không phải secret); cần để shim rustup/go tìm được toolchain khi HOME bị thay
const TOOLCHAIN_ENV = ["RUSTUP_HOME", "CARGO_HOME", "GOROOT"];

/** Môi trường đã lọc: PATH tin cậy, HOME tạm, LANG...; KHÔNG chứa khóa/secret. */
export function buildEnv(dirs: string[], home: string, cfg: Config, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = { PATH: dirs.join(delimiter), HOME: home, TMPDIR: home, LANG: "C.UTF-8" };
	for (const k of SAFE_ENV) if (src[k]) env[k] = src[k]!;
	for (const k of TOOLCHAIN_ENV) if (src[k]) env[k] = src[k]!;
	if (src.HOME) {
		if (!env.RUSTUP_HOME) env.RUSTUP_HOME = join(src.HOME, ".rustup");
		if (!env.CARGO_HOME) env.CARGO_HOME = join(src.HOME, ".cargo");
	}
	for (const k of cfg.passEnv ?? []) if (typeof k === "string" && src[k] !== undefined) env[k] = src[k]!;
	return env;
}

/** Tên file bắt đầu bằng "-" không được thành cờ: luôn truyền dạng tuyệt đối hoặc ./x */
const fileArg = (abs: string) => (isAbsolute(abs) ? abs : abs.startsWith("-") ? "./" + abs : abs);

function run(argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<{ ok: boolean; msg: string }> {
	return new Promise((res) => {
		execFile(argv[0], argv.slice(1), { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, _out, stderr) => {
			if (!err) return res({ ok: true, msg: "" });
			const e = err as NodeJS.ErrnoException & { killed?: boolean };
			if (e.killed) return res({ ok: false, msg: `timeout after ${timeoutMs}ms` });
			res({ ok: false, msg: (String(stderr).trim() || e.message).split("\n").slice(0, 5).join(" | ").slice(0, 400) });
		});
	});
}

/** Format một file; trả ghi chú (rỗng nếu không có gì đáng báo). Không bao giờ ném lỗi. */
export async function formatFile(abs: string, cwd: string, cfg: Config): Promise<string> {
	try {
		const finder = makeFinder(cwd, cfg);
		const picked = pickCommand(cfg, abs, cwd, finder);
		if (!picked) return "";
		return await withFileMutationQueue(abs, async () => {
			const before = await readFile(abs, "utf8").catch(() => null);
			if (before === null) return "";
			const home = await mkdtemp(join(tmpdir(), "fmt-home-"));
			let r;
			try {
				r = await run(picked.argv.map((a) => (a === "$FILE" ? fileArg(abs) : a)), cwd, cfg.timeoutMs ?? 10000, buildEnv(finder.dirs, home, cfg));
			} finally {
				await rm(home, { recursive: true, force: true }).catch(() => {});
			}
			if (!r.ok) return `[formatter ${picked.name} failed on ${abs}: ${r.msg} (file left as written)]`;
			const after = await readFile(abs, "utf8").catch(() => before);
			return after !== before ? `[formatter ${picked.name} reformatted ${abs}; re-read the file before further edits]` : "";
		});
	} catch (e) {
		return `[formatter error on ${abs}: ${(e as Error).message}]`;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		const cfg = loadConfig();
		if (cfg.enabled === false) return;
		let files: string[] = [];
		if (event.toolName === "write" || event.toolName === "edit") {
			const p = (event.input as { path?: unknown }).path;
			if (typeof p === "string" && p) files = [resolve(ctx.cwd, p.replace(/^@/, ""))];
		} else if (event.toolName === "apply_patch") {
			const f = (event.details as { files?: unknown } | undefined)?.files;
			if (Array.isArray(f)) files = f.filter((x): x is string => typeof x === "string");
		}
		if (files.length === 0) return;
		const notes: string[] = [];
		for (const f of files) {
			const n = await formatFile(f, ctx.cwd, cfg);
			if (n) notes.push(n);
		}
		if (notes.length === 0) return;
		return { content: [...event.content, { type: "text" as const, text: "\n" + notes.join("\n") }] };
	});
}
