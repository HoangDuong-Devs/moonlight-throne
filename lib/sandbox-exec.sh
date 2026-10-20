#!/usr/bin/env bash
# sandbox-exec.sh -- '<lệnh>' : chạy MỘT lệnh bash (đã qua bot-permissions) trong sandbox LỒNG (bwrap thứ hai) bên trong coder-sandbox.
# bot-permissions tự bọc mọi lệnh khớp bash.sandbox (test/build chạy mã của repo) bằng script này khi đang trong coder-sandbox.
# Lớp lồng: KHÔNG mạng (--unshare-net), PID/IPC/UTS riêng (+ /proc mới: không đọc được environ của Pi),
# env theo ALLOWLIST (--clearenv; không key model nào lọt vào), $HOME + /tmp + /run tmpfs mới, agent-dir bị phủ tmpfs
# (auth.json, models-store.json, sessions, grants... không thấy), .env của coder và .env* ở gốc workdir bị che, bots/ bị che.
# Chỉ thư mục làm việc ghi được. Pi (tiến trình cha) vẫn giữ mạng + key.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "${1:-}" = "--" ] && shift
[ "$#" -eq 1 ] || { echo "sandbox-exec: cần đúng 1 chuỗi lệnh" >&2; exit 2; }
CMD="$1"
command -v bwrap >/dev/null || { echo "sandbox-exec: không có bwrap" >&2; exit 127; }
WORKDIR="$(readlink -f "${CODER_WORKDIR:-$PWD}")"
AGENT="$(readlink -f "${PI_CODING_AGENT_DIR:-$HERE/agent}")"
NODE_BIN="$(command -v node)" || { echo "sandbox-exec: không thấy node" >&2; exit 127; }
NODE_DIR="$(dirname "$(readlink -f "$NODE_BIN")")"
BUN_DIR=""; B="$(command -v bun 2>/dev/null || true)"; [ -n "$B" ] && BUN_DIR="$(dirname "$(readlink -f "$B")")"

A=(--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run --tmpfs "$HOME")
A+=(--ro-bind "$(dirname "$NODE_DIR")" "$(dirname "$NODE_DIR")")     # node (nvm dưới $HOME bị tmpfs che)
[ -n "$BUN_DIR" ] && A+=(--ro-bind "$BUN_DIR" "$BUN_DIR")
A+=(--ro-bind "$HERE" "$HERE")                                        # shim bunx + vendor/typescript (chỉ đọc)
A+=(--tmpfs "$AGENT")                                                 # SAU bind HERE: agent-dir thường nằm trong HERE
[ -e "$HERE/.env" ] && A+=(--ro-bind /dev/null "$HERE/.env")
[ -d "$HERE/bots" ] && A+=(--tmpfs "$HERE/bots")
A+=(--bind "$WORKDIR" "$WORKDIR")
shopt -s nullglob dotglob
for f in "$WORKDIR"/.env "$WORKDIR"/.env.*; do
  case "$(basename "$f")" in .env.example|.env.sample|.env.template|.env.dist) continue ;; esac
  [ -f "$f" ] && A+=(--ro-bind /dev/null "$f")
done
shopt -u nullglob dotglob
CWD="$PWD"; case "$CWD/" in "$WORKDIR"/*) ;; *) CWD="$WORKDIR" ;; esac
A+=(--unshare-net --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session --chdir "$CWD")
A+=(--clearenv --setenv HOME "$HOME" --setenv PATH "$HERE/lib/nested-bin:$NODE_DIR${BUN_DIR:+:$BUN_DIR}:/usr/local/bin:/usr/bin:/bin"
    --setenv CI 1 --setenv CODER_NESTED 1 --setenv CODER_HOME "$HERE" --setenv CODER_WORKDIR "$WORKDIR")
# env ALLOWLIST: chỉ biến vô hại; không bao giờ truyền biến có tên giống secret
for v in LANG LC_ALL TERM TZ NODE_ENV NO_COLOR FORCE_COLOR; do
  [ -n "${!v:-}" ] && A+=(--setenv "$v" "${!v}")
done
# Chính tiến trình bwrap (PID 1 của namespace lồng) cũng phải có env sạch: /proc/1/environ đọc được từ bên trong.
exec env -i PATH=/usr/local/bin:/usr/bin:/bin "$(command -v bwrap)" "${A[@]}" bash -c "$CMD"
