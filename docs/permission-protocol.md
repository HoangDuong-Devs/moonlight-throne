# Giao thức hỏi quyền (ask) của coder

Dành cho người viết BOT điều phối gọi `coder`. Extension `bot-permissions` có 3 kết quả cho mỗi lần gọi tool: **cho chạy**, **chặn cứng**, hoặc **cần duyệt (ask)**. Tài liệu này mô tả ask.

## 1. Thứ tự quyết định

1. Luật cứng (jail ngoài cwd, `.env`/`auth.json`/credential, `sudo`, `rm -r` rộng, `curl|sh`, dump env, đụng vào kho grants/grants-used/CLI duyệt, và hai luật dưới đây): chặn luôn, KHÔNG bao giờ ask, grant không vượt được.
   - **Không mở rộng lúc chạy**: token nào có `$VAR`, `${..}`, `$1`/`$?`/`$$`, `$'..'`, `$(..)`, backtick, brace `{a,b}`/`{1..3}` hoặc `~user` ngoài dấu nháy đơn đều bị chặn ở BẤT KỲ vị trí (lệnh, cờ, toán hạng, đích redirect), vì bash đổi nội dung token sau khi ta kiểm tra (vd `find -fprint${IFS}/x`). Glob `* ? [` chỉ được ở toán hạng ĐƯỜNG DẪN của lệnh đọc/liệt kê (ls, cat, head, tail, wc, grep, rg, find, diff...), chỉ ở thành phần cuối, và phần cố định + các file khớp phải qua kiểm tra jail/secret. Muốn ký tự `$`/`*` nguyên văn: đặt trong dấu nháy đơn.
   - **Whitelist cờ**: với mọi lệnh đã biết (ls cat head tail wc sort uniq diff cmp file stat du df tree grep rg fd find sed jq git echo mkdir touch cp mv và vài lệnh đọc nhỏ), CHỈ cờ nằm trong whitelist của lệnh đó mới qua; cờ lạ => chặn (fail-closed). Ví dụ: `sed` chỉ `-n` + một script `N,Mp` (cấm `-e/-f/-i/-s` và w/e/r/W/R); `find` cấm `-exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls`; `sort` cấm `-o/-T/--compress-program`; `uniq` tối đa một file; `jq` cấm `env/$ENV/input_filename/import/include` và `--rawfile/--slurpfile/--argfile/-f` ra ngoài jail; `rg` cấm `--pre/--pre-glob/--hostname-bin/-z`; `tree` cấm `-o`; `git` chỉ subcommand đọc (diff log show status branch rev-parse ls-files blame describe ls-tree cat-file grep ...) và cấm `-c`, `--exec-path`, `--git-dir`, `--work-tree`, `-C` ra ngoài jail, `-O/--open-files-in-pager`, `--output`, `--ext-diff`, `--textconv`, `--no-index`; `cp/mv/mkdir/touch` đích phải trong jail. `fd -x`, `bat`, `less`, `man`, `awk`, trình soạn thảo bị cấm. Mẫu `bash.allow` trong permissions.json chỉ quyết định lệnh NÀO được chạy; whitelist cờ luôn áp dụng thêm.
   - Repo có cấu hình chạy mã khi đọc (`.git/config` với `core.fsmonitor`/`core.pager`/`diff.*.textconv`/`diff.external`/`filter.*`(không phải git-lfs)/`include`..., `.yarnrc.yml` với `yarnPath`/`plugins`) => `git`/`yarn` bị chặn.
2. `deny` trong `permissions.json`: chặn luôn.
3. `ask` (`bash.ask`, `read.ask`, `write.ask`, `tools.ask`): cần bot duyệt. Ask thắng allow (nghiêm hơn allow) nên dùng để khoanh vùng trong một allow rộng như `write.allow: ["**"]`.
4. `allow`: chạy.
5. Mặc định ở mode allowlist: chặn.

Mỗi lệnh bash được tách theo `;`, `&&`, `|`...: chỉ cần một đoạn khớp ask (và các đoạn khác hợp lệ) là cả lệnh thành một yêu cầu; một đoạn bị chặn cứng thì cả lệnh bị chặn, không ask.

Mẫu ask khởi điểm: `git add/commit/stash/switch/checkout/merge/rebase/cherry-pick/tag`, `npm|pnpm|yarn install/add/ci/update/uninstall`, `pip install`, `cargo add/install`, `go get`, ghi vào lockfile (`package-lock.json`, `*.lock`, `pnpm-lock.yaml`, `go.sum`), tool `web_fetch`/`web_search`. `git push`, `npm install -g`, `rm -rf` vẫn nằm trong deny (không ask được). Chỉnh trong `agent/permissions.json`; hết giờ hỏi: `"ask": {"timeoutMs": 120000}` (hoặc env `CODER_ASK_TIMEOUT_MS` cho một tiến trình).

## 2. Định danh và phạm vi duyệt

- `id` yêu cầu = `pr_` + 12 hex của sha256(sessionId, tool, chủ thể chính xác). Cùng session + cùng lệnh => cùng `id` (ổn định, gọi lại không sinh thêm).
- Chủ thể chính xác: bash = nguyên chuỗi lệnh (gộp khoảng trắng); tool ghi = đường dẫn thật đã resolve. Grant khớp ĐÚNG chủ thể đó, đúng session; đổi một ký tự là yêu cầu mới.
- `allow_once` / `approve` thường: dùng đúng một lần (lần gọi sau cùng lệnh phải xin lại). `allow_always_session` / `approve --always`: mọi lần gọi đúng lệnh đó trong session này. Không có "always" rộng hơn thế.
- Từ chối là dính trong session: lần gọi lại cùng lệnh bị chặn `permission_denied` ngay, không hỏi lại (bot có thể `approve` sau để đảo ngược ở chế độ -p).
- **Mô hình tin cậy của kho quyền** (sandbox gắn `grants/` CHỈ-ĐỌC, `grants-used/` và `permission-requests/` ghi được):
  - `<agent-dir>/grants/<sessionId>.json`: NGUỒN CHỈ DO NGƯỜI VẬN HÀNH GHI (CLI chạy ngoài sandbox). Mỗi grant có `grantId` ngẫu nhiên `g_<32 hex>` do CLI sinh. Extension chỉ ĐỌC file này, KHÔNG BAO GIỜ ghi; mục thiếu/sai `grantId` bị bỏ qua.
  - `<agent-dir>/grants-used/<sessionId>.json` `{sessionId, used:[grantId...]}`: sổ "đã dùng" chỉ-thêm do extension ghi. Grant hiệu lực = có trong `grants/` VÀ chưa có `grantId` trong sổ. Grant `once` được ghi vào sổ TRƯỚC khi cho chạy; ghi sổ lỗi, hoặc sổ hỏng/là symlink => coi như KHÔNG có grant (fail-closed). Giả mạo sổ chỉ làm GIẢM quyền. Xóa/cắt sổ có thể phát lại một lệnh đã được duyệt đúng session đó (tiến trình đang chạy thì nhớ trong bộ nhớ nên không phát lại được); grant `session` (`approve --always`) không bao giờ ghi sổ.
  - `allow_always_session` qua RPC chỉ nhớ trong bộ nhớ tiến trình (không ghi file nào).
  - `<agent-dir>/permission-requests/<id>.json`: KHÔNG TIN CẬY (sandbox ghi được). Extension lưu `subject` nguyên văn để CLI tính lại `key = sha256(tool\0subject)` và `id` rồi so khớp; CLI hiển thị `subject` nguyên văn (che secret, ký tự điều khiển thoát thành `\xNN`).
  - Model không ghi được kho (ghi vào agent-dir bị chặn cứng; lệnh/redirect nhắc tới `permissions-cli`/`grants`/`grants-used`/`permission-requests` bị chặn cứng). Mã chạy trong sandbox (vd `python3 -m pytest`) vẫn có thể ghi `grants-used/` và `permission-requests/` — hai nơi này được thiết kế để làm vậy cũng không cấp thêm quyền.
- Audit (`agent/audit.log`, đã che secret) ghi các `event`: `ask`, `approve` (via rpc|cli), `deny`, `grant_used`, `ask_denied_repeat`, `revoke`. **`audit.log` do sandbox ghi được nên KHÔNG phải nguồn tin cậy** (chèn/xóa dòng giả được); nhật ký tin cậy là bản phía host. Extension ghi bằng `O_NOFOLLOW` và không bao giờ sập khi ghi lỗi.

## 3. Chế độ RPC (`coder --mode rpc`)

Tool cần duyệt => extension gửi `extension_ui_request` (method `select`) và chờ. `title` là MỘT chuỗi JSON (parse nó):

```json
{"type":"extension_ui_request","id":"6d2529d6-...","method":"select","title":"{\"type\":\"permission_request\",\"id\":\"pr_ed003e00231b\",\"session\":\"01a154aa-...\",\"tool\":\"bash\",\"kind\":\"bash\",\"subject\":\"git add a.txt\",\"rule\":\"bash.ask\",\"pattern\":\"git add*\",\"reason\":\"...\",\"choices\":[\"allow_once\",\"allow_always_session\",\"deny\"],\"timeoutMs\":120000}","options":["allow_once","allow_always_session","deny"],"timeout":120000}
```

Trả lời (stdin, một dòng JSONL, `id` = id của extension_ui_request, KHÔNG phải `pr_...`):

```json
{"type":"extension_ui_response","id":"6d2529d6-...","value":"allow_once"}
```

`value` là một trong `allow_once`, `allow_always_session`, `deny`. Không trả lời trong `timeout` ms, hoặc `cancelled:true`, hoặc giá trị khác = từ chối (model nhận `permission_denied` với `why: "timeout_or_cancelled"`). Lúc chờ, lượt agent bị treo: bot phải đọc stdout liên tục. `subject` đã che secret. Trường `kind`: `bash` | `path` | `tool`.

Luồng thô (bot gửi `>`, nhận `<`):

```
> {"type":"prompt","message":"chạy git add a.txt","id":"p1"}
< {"id":"p1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
< {"type":"extension_ui_request","id":"u1","method":"select","title":"{...permission_request...}","options":[...],"timeout":120000}
> {"type":"extension_ui_response","id":"u1","value":"allow_once"}
< {"type":"tool_execution_end","toolName":"bash","isError":false,...}
< {"type":"agent_end", ...}
> {"type":"get_last_assistant_text","id":"q1"}
< {"type":"response","id":"q1","command":"get_last_assistant_text","success":true,"data":{"text":"..."}}
```

Điểm cần biết khi viết bot RPC (đã kiểm chứng):
- Khung JSONL tách theo LF (`\n`) thuần; tự xử lý `\r` cuối dòng nếu có; KHÔNG dùng `readline` (nó tách cả U+2028/2029 làm vỡ JSON).
- `prompt` được xác nhận ngay bằng `response ... disposition:"started"`; kết quả thật đến sau qua event. Lỗi từ lệnh đến qua `response` với `success:false`.
- Kết thúc lượt: event `agent_end` (rồi `agent_settled`). Lấy văn bản cuối bằng lệnh `get_last_assistant_text` SAU `agent_end`. Event `message_update` rất nhiều (hàng trăm/lượt), có thể bỏ qua.
- Hủy: gửi `{"type":"abort"}`; một ask đang chờ cũng nên được trả lời `deny` để lượt kết thúc nhanh.
- Kết quả tool bị từ chối vẫn là một `tool_execution_end` có `isError:true`, nội dung bắt đầu bằng `Blocked by bot policy [permission_denied]`.
- Chạy song song nhiều tool có thể gửi nhiều `extension_ui_request` cùng lúc; trả lời theo `id` của từng cái.

## 4. Chế độ không UI (`-p`, `--mode json`)

Không có kênh hỏi, nên lần gọi bị chặn với `needs_permission` và yêu cầu được ghi ra file. Tool result (`tool_execution_end`, `isError:true`) có dạng:

```
Blocked by bot policy [needs_permission]: Hành động này cần bot điều phối duyệt (yêu cầu pr_734d04f88440). ...
{"needs_permission":{"code":"needs_permission","id":"pr_734d04f88440","session":"s-test1","tool":"bash","kind":"bash","subject":"git add a.txt .","rule":"bash.ask","pattern":"git add*","reason":"...","approve":"permissions-cli approve pr_734d04f88440 [--always]","deny":"permissions-cli deny pr_734d04f88440"}}
```

Cùng thông tin có trong luồng JSON dưới dạng event `entry_appended` (entry `customType: "permission_request"`) và trong file `permission-requests/<id>.json` (thêm `status`, `createdAt`). Bot nên dùng `--session-id` cố định để gọi lại đúng session.

CLI (`node lib/permissions-cli.mjs`, Node thuần; thêm `--json` để xuất JSON một dòng; `--agent-dir DIR` nếu cần, mặc định `$CODER_AGENT_DIR` hoặc `<coder>/agent`):

| Lệnh | Ý nghĩa |
|---|---|
| `pending [--session ID]` | liệt kê yêu cầu đang chờ ĐÃ XÁC MINH: `{"ok":true,"pending":[{id,sessionId,tool,subject,rule,pattern,status,...}],"invalid":[{file,reason}]}`; mục không hợp lệ bị bỏ qua và liệt kê ở `invalid` |
| `approve <id> [--always]` | xác minh yêu cầu (tính lại key/id, định dạng, kích thước, không symlink) rồi tạo grant `once` (mặc định, tiêu thụ qua sổ used) hoặc `session` (`--always`, không bị tiêu thụ): `{"ok":true,"id":"pr_..","session":"..","mode":"once","grantId":"g_..","subject":"..."}` |
| `deny <id>` | đánh dấu từ chối (dính trong session), gỡ grant cùng chủ thể (và ghi sổ used) |
| `grants [--session ID]` | liệt kê grant kèm trạng thái: `once`: `available`\|`used`; `session`: `active`\|`revoked`; `invalid(no-grantId)`; `ledger-corrupt(inactive)` |
| `revoke <id\|grantId> [--session ID]` | thu hồi grant (gỡ khỏi `grants/` và ghi `grantId` vào sổ used) |

Lỗi: `{"ok":false,"error":"not_found|bad_id|session_mismatch|invalid_request","message":"..."}`, mã thoát 1. `invalid_request`: file yêu cầu bị sửa/giả (key hoặc id không khớp nội dung, id sai định dạng, symlink, quá lớn >64KB, subject >8000 ký tự).

Vòng lặp bot mẫu (-p):

```js
import { spawnSync } from "node:child_process";
const CODER = "/path/to/coder", CLI = ["node", "/path/to/lib/permissions-cli.mjs"];
const run = (msg) => spawnSync(CODER, ["--mode","json","-p","--model","M","--session-id","job-42","--session-dir","./sessions", msg], { encoding: "utf8" }).stdout;
let out = run("làm việc X");
for (let round = 0; round < 5; round++) {
  const pend = JSON.parse(spawnSync(CLI[0], [CLI[1], "pending", "--session", "job-42", "--json"], { encoding: "utf8" }).stdout).pending;
  if (!pend.length) break;
  for (const r of pend) {
    const ok = botDecides(r);                       // r.tool, r.subject, r.rule
    spawnSync(CLI[0], [CLI[1], ok ? "approve" : "deny", r.id, "--json"]);
  }
  out = run("Yêu cầu quyền đã được xử lý; hãy thử lại bước vừa bị chặn.");
}
```

Lưu ý: duyệt `once` bị tiêu thụ khi lệnh chạy (ghi vào `grants-used/`); nếu model đổi lệnh dù một ký tự thì là yêu cầu mới. CLI phải chạy NGOÀI sandbox (nó ghi `grants/`).

## 5. Giới hạn

`bash.sandbox` (mảng mẫu lệnh, chỉ cho bash): lệnh đã khớp `allow` mà khớp `bash.sandbox` chỉ tự chạy khi extension phát hiện đang ở trong `coder-sandbox` (`CODER_SANDBOXED=1` do coder-sandbox đặt VÀ `/proc/1/comm` = `bwrap`); ngoài sandbox => ask với `rule: "bash.sandbox"`. Trong sandbox, extension viết lại lệnh khớp `bash.sandbox` thành `<CODER_HOME>/lib/sandbox-exec.sh -- '<lệnh>'` (bwrap lồng: `--unshare-net`, PID ns + /proc mới, `--clearenv` + env allowlist, chính tiến trình bwrap chạy với `env -i`, `$HOME`//tmp tmpfs, agent-dir tmpfs, `.env`/`bots/` bị che, file secret trong workdir theo `isSecretName` tới độ sâu 6 bị che bằng `lib/secret-files.mjs` (bỏ qua node_modules/.git/vendor; liệt kê lỗi => từ chối chạy), `.git` + gitdir/commondir của worktree gắn chỉ-đọc SAU bind rw của workdir); thiếu wrapper => chặn. `bunx *` vẫn nằm trong `bash.sandbox` có chủ ý (phòng thủ nhiều lớp). Luật cứng bunx: chỉ `bunx -p|--package typescript@5.9.3 tsc ...` (đúng phiên bản) hoặc `bunx tsc ...` khi có `node_modules/typescript` cục bộ (realpath trong thư mục làm việc) hoặc đang trong sandbox và có vendor tsc; `bun x` bị cấm; biến `BUN_*` bị cấm gán trước lệnh.

Đây là kiểm soát ở tầng tool, không phải sandbox: một chương trình đã được allow (ví dụ `node --test`, `python3 -m pytest`) vẫn chạy mã tùy ý (kể cả ghi `.git/config`, hook, `package.json`...). Muốn an toàn thật hãy chạy coder qua `coder-sandbox` (user/container riêng) với `grants/` gắn CHỈ-ĐỌC và CLI duyệt chạy ngoài sandbox. Còn lại: (1) chỉ kiểm tra được `.git/config` của repo ở thời điểm gọi (TOCTOU nhỏ), cấu hình git toàn cục/hệ thống tin tưởng như cũ; (2) `git commit`/`rebase` đã duyệt vẫn chạy hook trong `.git/hooks` (nếu mã trong sandbox đã cài hook); (3) `plan-mode` chỉ chặn đường dẫn secret cơ bản — kiểm tra jail/đọc đầy đủ do `bot-permissions` thực hiện khi cùng được nạp.
