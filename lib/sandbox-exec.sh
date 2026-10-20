#!/usr/bin/env bash
# sandbox-exec.sh -- '<lệnh>' : chạy MỘT lệnh bash (đã qua bot-permissions) trong sandbox LỒNG (bwrap thứ hai) bên trong coder-sandbox.
# bot-permissions tự bọc mọi lệnh khớp bash.sandbox (test/build chạy mã của repo) bằng script này khi đang trong coder-sandbox.
# Lớp lồng: KHÔNG mạng (--unshare-net), PID/IPC/UTS riêng (+ /proc mới: không đọc được environ của Pi),
# env theo ALLOWLIST (--clearenv; không key model nào lọt vào), $HOME + /tmp + /run tmpfs mới, agent-dir bị phủ tmpfs
# (auth.json, models-store.json, sessions, grants... không thấy), .env của coder + mọi file secret trong workdir (lib/secret-files.mjs) bị che, bots/ bị che, .git chỉ-đọc.
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
# Che file secret ở MỌI cấp (độ sâu 6; bỏ node_modules/.git/vendor) theo đúng isSecretName/SECRET_DIRS; lỗi liệt kê => từ chối chạy.
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
node --experimental-strip-types --no-warnings "$HERE/lib/secret-files.mjs" "$WORKDIR" > "$LIST" || { echo "sandbox-exec: không liệt kê được file secret; từ chối chạy" >&2; exit 3; }
while IFS= read -r -d '' ent; do
  p="${ent#? }"
  case "$ent" in
    "f "*) A+=(--ro-bind /dev/null "$p") ;;
    "d "*) A+=(--tmpfs "$p") ;;
  esac
done < "$LIST"
CWD="$PWD"; case "$CWD/" in "$WORKDIR"/*) ;; *) CWD="$WORKDIR" ;; esac
# .git chỉ-đọc (SAU bind rw của workdir để đè lên): mã test không cấy được hook/config. Worktree: .git là file "gitdir: X"
# => gắn chỉ-đọc cả gitdir thật và commondir của nó.
ro_git() {
  local g="$1/.git" gd cd
  if [ -d "$g" ] && [ ! -L "$g" ]; then A+=(--ro-bind "$g" "$g")
  elif [ -f "$g" ]; then
    A+=(--ro-bind "$g" "$g")
    gd="$(sed -n 's/^gitdir: //p' "$g" | head -n1)"; [ -n "$gd" ] || return 0
    case "$gd" in /*) ;; *) gd="$1/$gd" ;; esac
    gd="$(readlink -f "$gd")"; [ -d "$gd" ] || return 0
    A+=(--ro-bind "$gd" "$gd")
    if [ -f "$gd/commondir" ]; then
      cd="$(head -n1 "$gd/commondir")"; case "$cd" in /*) ;; *) cd="$gd/$cd" ;; esac
      cd="$(readlink -f "$cd")"; [ -d "$cd" ] && A+=(--ro-bind "$cd" "$cd")
    fi
  fi
}
ro_git "$WORKDIR"
[ "$CWD" != "$WORKDIR" ] && ro_git "$CWD"
A+=(--unshare-net --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --new-session --chdir "$CWD")
A+=(--clearenv --setenv HOME "$HOME" --setenv PATH "$HERE/lib/nested-bin:$NODE_DIR${BUN_DIR:+:$BUN_DIR}:/usr/local/bin:/usr/bin:/bin"
    --setenv CI 1 --setenv CODER_NESTED 1 --setenv CODER_HOME "$HERE" --setenv CODER_WORKDIR "$WORKDIR")
# env ALLOWLIST: chỉ biến vô hại; không bao giờ truyền biến có tên giống secret
for v in LANG LC_ALL TERM TZ NODE_ENV NO_COLOR FORCE_COLOR; do
  [ -n "${!v:-}" ] && A+=(--setenv "$v" "${!v}")
done
# Chính tiến trình bwrap (PID 1 của namespace lồng) cũng phải có env sạch: /proc/1/environ đọc được từ bên trong.
exec env -i PATH=/usr/local/bin:/usr/bin:/bin "$(command -v bwrap)" "${A[@]}" bash -c "$CMD"
