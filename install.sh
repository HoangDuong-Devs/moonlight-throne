#!/usr/bin/env bash
# Cài đặt/kiểm tra coder (idempotent, chạy lại an toàn).
#   ./install.sh            kiểm tra + cài những gì thiếu (clone pi ghim commit, npm install/build, tạo .env)
#   ./install.sh --check    chỉ kiểm tra, không đổi gì; mã thoát != 0 nếu có mục FAIL
#   ./install.sh --no-build không npm install/build (vẫn clone pi nếu thiếu)
# Không bao giờ ghi đè .env có sẵn; không in giá trị key.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="$(cd "$HERE/.." && pwd)"
PI="$TOOLS/pi"
CLI="$PI/packages/coding-agent/dist/bundle/cli.js"
CHECK=0; NOBUILD=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --no-build) NOBUILD=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "install: cờ lạ: $a" >&2; exit 2 ;;
  esac
done
RES=(); FAILS=0
add() { RES+=("$1|$2|$3"); [ "$1" = FAIL ] && FAILS=$((FAILS+1)); return 0; }

# 1. node >= min (so sánh số từng phần)
MIN="22.19.0"
[ -f "$TOOLS/MANIFEST.json" ] && command -v node >/dev/null && \
  MIN="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).node.min)}catch{console.log("22.19.0")}' "$TOOLS/MANIFEST.json")"
if command -v node >/dev/null; then
  NV="$(node -p 'process.versions.node')"
  if node -e 'const p=s=>s.split(".").map(Number),a=p(process.argv[1]),b=p(process.argv[2]);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))process.exit((a[i]||0)>(b[i]||0)?0:1)}process.exit(0)' "$NV" "$MIN"; then
    add OK node "v$NV (>= $MIN)"
  else add FAIL node "v$NV < $MIN"; fi
else add FAIL node "không tìm thấy (cần >= $MIN)"; fi

# 2. git, bwrap
if command -v git >/dev/null; then add OK git "$(git --version)"; else add FAIL git "không tìm thấy"; fi
if command -v bwrap >/dev/null; then add OK bwrap "có (coder-sandbox dùng được)"; else add WARN bwrap "không có: chỉ dùng ./coder, không dùng coder-sandbox"; fi

# 3. pi ở đúng commit
PINNED=""
command -v node >/dev/null && [ -f "$TOOLS/MANIFEST.json" ] && PINNED="$(node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tools.find(x=>x.name==="pi");console.log(t?t.commit:"")' "$TOOLS/MANIFEST.json")"
if [ ! -d "$PI/.git" ] && [ ! -f "$PI/.git" ]; then
  if [ $CHECK = 1 ]; then add FAIL pi "chưa có $PI (chạy ./install.sh để clone)"
  elif [ -x "$TOOLS/clone-all.sh" ] && command -v git >/dev/null; then
    if "$TOOLS/clone-all.sh" pi >/dev/null 2>&1; then add OK pi "đã clone, ghim ${PINNED:0:12}"; else add FAIL pi "clone lỗi (xem: $TOOLS/clone-all.sh pi)"; fi
  else add FAIL pi "chưa có và không gọi được clone-all.sh/git"; fi
else
  H="$(git -C "$PI" rev-parse HEAD 2>/dev/null || echo '?')"
  if [ -z "$PINNED" ]; then add WARN pi "có, nhưng không đọc được commit ghim"
  elif [ "$H" = "$PINNED" ]; then add OK pi "commit ghim ${H:0:12}"
  else add WARN pi "HEAD ${H:0:12} khác commit ghim ${PINNED:0:12} (không tự đổi; dùng clone-all.sh --update pi)"; fi
fi

# 4. dist (npm install + build)
LOGDIR=""
if [ -f "$CLI" ]; then add OK build "có $CLI"
elif [ $CHECK = 1 ] || [ $NOBUILD = 1 ]; then add FAIL build "chưa build Pi ($CLI)"
elif [ ! -d "$PI" ]; then add FAIL build "không có pi để build"
elif ! command -v npm >/dev/null; then add FAIL build "thiếu npm"
else
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/coder-install.XXXXXX")"
  echo "Đang npm install (log: $LOGDIR/install.log) ..."
  if (cd "$PI" && npm install --no-audit --no-fund) >"$LOGDIR/install.log" 2>&1; then
    echo "Đang npm run build (log: $LOGDIR/build.log) ..."
    if (cd "$PI" && npm run build) >"$LOGDIR/build.log" 2>&1 && [ -f "$CLI" ]; then add OK build "đã build ($LOGDIR)"
    else add FAIL build "build lỗi, 20 dòng cuối: $LOGDIR/build.log"; tail -n 20 "$LOGDIR/build.log" >&2; fi
  else add FAIL build "npm install lỗi, 20 dòng cuối: $LOGDIR/install.log"; tail -n 20 "$LOGDIR/install.log" >&2; fi
fi

# 5. .env (không bao giờ ghi đè)
ENVF="$HERE/.env"
if [ -e "$ENVF" ]; then
  add OK ".env" "đã có (giữ nguyên)"
elif [ $CHECK = 1 ]; then add WARN ".env" "chưa có (./install.sh sẽ tạo từ .env.example)"
elif [ ! -f "$HERE/.env.example" ]; then add FAIL ".env" "thiếu .env.example"
else
  ( umask 077; { grep -v '^PI_CODING_AGENT_DIR=' "$HERE/.env.example"; echo "PI_CODING_AGENT_DIR=$HERE/agent"; } > "$ENVF" ) \
    && chmod 600 "$ENVF" && add OK ".env" "đã tạo từ .env.example (chmod 600), cần điền key" || add FAIL ".env" "không tạo được"
fi

# 6. quyền thực thi
for f in coder coder-sandbox; do
  if [ ! -f "$HERE/$f" ]; then add FAIL "$f" "thiếu file"
  elif [ -x "$HERE/$f" ]; then add OK "$f" "có quyền thực thi"
  elif [ $CHECK = 1 ]; then add WARN "$f" "thiếu quyền +x"
  else chmod +x "$HERE/$f" && add OK "$f" "đã chmod +x" || add FAIL "$f" "chmod lỗi"; fi
done

# 7. smoke test (không gọi API)
if [ -f "$CLI" ] && [ -x "$HERE/coder" ]; then
  if "$HERE/coder" models </dev/null >/dev/null 2>&1; then add OK "smoke:models" "./coder models chạy được"; else add FAIL "smoke:models" "./coder models lỗi"; fi
  V="$("$HERE/coder" --version </dev/null 2>/dev/null | head -n1)"
  if [ -n "$V" ]; then add OK "smoke:version" "$V"; else add FAIL "smoke:version" "./coder --version lỗi"; fi
else add WARN smoke "bỏ qua (chưa build hoặc thiếu launcher)"; fi

echo
echo "== Tóm tắt coder install$([ $CHECK = 1 ] && echo ' (--check)') =="
for r in "${RES[@]}"; do IFS='|' read -r s n d <<< "$r"; printf '%-5s %-14s %s\n' "$s" "$n" "$d"; done
echo
if [ $FAILS -gt 0 ]; then echo "Kết quả: $FAILS mục FAIL."; [ $CHECK = 1 ] && echo "Chạy ./install.sh (không --check) để cài phần thiếu."; exit 1; fi
echo "Kết quả: sẵn sàng."
echo "Bước tiếp: điền COMMANDCODE_API_KEY / XAI_API_KEY vào $ENVF (hoặc dùng OAuth xAI đã lưu),"
echo "rồi thử: $HERE/coder -p --model <tên> \"...\"; cấp cấu hình riêng cho từng bot: node $HERE/lib/provision.mjs create <bot>"
exit 0
