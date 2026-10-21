# shellcheck shell=bash
# mth_agent_dir <mặc định>: in thư mục agent. CODER_AGENT_DIR > PI_CODING_AGENT_DIR (lỗi thời, cảnh báo) > mặc định.
mth_agent_dir() {
  if [ -n "${CODER_AGENT_DIR:-}" ]; then printf '%s\n' "$CODER_AGENT_DIR"
  elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    echo "mth: cảnh báo: PI_CODING_AGENT_DIR đã lỗi thời, hãy đổi sang CODER_AGENT_DIR" >&2
    printf '%s\n' "$PI_CODING_AGENT_DIR"
  else printf '%s\n' "$1"; fi
}

# Bí danh lỗi thời (deprecated): giữ cho script cũ gọi coder_agent_dir.
coder_agent_dir() { mth_agent_dir "$@"; }
