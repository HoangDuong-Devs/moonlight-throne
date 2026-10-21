# shellcheck shell=bash
# mth_env OUTVAR NAME [mặc định]: gán giá trị biến môi trường của mth vào biến OUTVAR của nơi gọi.
# Tên mới MTH_* thắng; tên cũ CODER_* vẫn được nhận (cảnh báo lỗi thời MỘT lần mỗi tên trong tiến trình).
# Giá trị rỗng = chưa đặt. NAME có thể bỏ tiền tố MTH_. KHÔNG dùng dạng in ra stdout: nơi gọi phải gọi
# trực tiếp (không `$(...)`) để bộ nhớ cảnh báo sống trong tiến trình.
# Đây là chỗ DUY NHẤT trong shell đọc tên cũ CODER_*.
_MTH_ENV_WARNED=""
mth_env() {
  local __mth_out="${1:-}" __mth_name="${2:-}" __mth_fallback="${3-}" __mth_legacy __mth_val
  if [ -z "$__mth_out" ] || [ -z "$__mth_name" ]; then
    echo "mth_env: cú pháp: mth_env OUTVAR NAME [mặc định]" >&2; return 2
  fi
  case "$__mth_out" in
    ""|[0-9]*|*[!A-Za-z0-9_]*)
      echo "mth_env: tên biến đích không hợp lệ: $__mth_out" >&2; return 2 ;;
  esac
  case "$__mth_name" in MTH_*) ;; *) __mth_name="MTH_$__mth_name" ;; esac
  case "$__mth_name" in
    *[!A-Za-z0-9_]*)
      echo "mth_env: tên biến không hợp lệ: $__mth_name" >&2; return 2 ;;
  esac
  __mth_legacy="CODER_${__mth_name#MTH_}"
  eval "__mth_val=\${$__mth_name-}"
  if [ -z "$__mth_val" ]; then
    eval "__mth_val=\${$__mth_legacy-}"
    if [ -n "$__mth_val" ]; then
      case " $_MTH_ENV_WARNED " in
        *" $__mth_legacy "*) ;;
        *)
          echo "mth: cảnh báo: $__mth_legacy đã lỗi thời, hãy đổi sang $__mth_name" >&2
          _MTH_ENV_WARNED="$_MTH_ENV_WARNED $__mth_legacy"
          ;;
      esac
    else
      __mth_val="$__mth_fallback"
    fi
  fi
  printf -v "$__mth_out" '%s' "$__mth_val"
  return 0
}

# mth_agent_dir_get OUTVAR [mặc định]: gán thư mục agent vào OUTVAR (không subshell, giữ bộ nhớ cảnh báo).
# MTH_AGENT_DIR > CODER_AGENT_DIR (lỗi thời, cảnh báo) > PI_CODING_AGENT_DIR (lỗi thời, cảnh báo) > mặc định.
mth_agent_dir_get() {
  local __mth_out="${1:-}" __mth_fallback="${2-}" __mth_dir
  if [ -z "$__mth_out" ]; then echo "mth_agent_dir_get: thiếu tên biến đích" >&2; return 2; fi
  mth_env __mth_dir MTH_AGENT_DIR
  if [ -z "$__mth_dir" ] && [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    echo "mth: cảnh báo: PI_CODING_AGENT_DIR đã lỗi thời, hãy đổi sang MTH_AGENT_DIR" >&2
    __mth_dir="$PI_CODING_AGENT_DIR"
  fi
  [ -n "$__mth_dir" ] || __mth_dir="$__mth_fallback"
  printf -v "$__mth_out" '%s' "$__mth_dir"
  return 0
}

# Tương thích ngược: in thư mục agent ra stdout. Script MỚI nên dùng mth_agent_dir_get (không subshell).
mth_agent_dir() {
  local __mth_dirln
  mth_agent_dir_get __mth_dirln "${1-}"
  printf '%s\n' "$__mth_dirln"
}

# Bí danh lỗi thời (deprecated): giữ cho script cũ gọi coder_agent_dir.
coder_agent_dir() { mth_agent_dir "$@"; }
