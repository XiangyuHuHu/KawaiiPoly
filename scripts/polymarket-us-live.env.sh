# 给盒子上的 polyus-loop.sh / polyus-live-observe-loop.sh source 用。
# 这两个循环脚本不在仓库里。source 时 $0 是循环脚本，不是本文件。
# 用 dirname "$0" 会把 ROOT 指到循环脚本所在目录（常常还再往上一层），
# KawaiiPoly/.env 载不进来。环境里可能仍有 API 密钥，实盘开关缺失，
# 下单就停在 live_flag_off / dry-run。
#
# 正确：BASH_SOURCE[0] 即使被 source，也是本文件。
# 错误：ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#
# 循环脚本里这样引用（路径按检出目录改）：
#   source /path/to/KawaiiPoly/scripts/polymarket-us-live.env.sh

if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _US_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  _US_ENV_DIR="$(cd "$(dirname "$0")" && pwd)"
fi
US_REPO_ROOT="$(cd "${_US_ENV_DIR}/.." && pwd)"
if [ -f "${US_REPO_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${US_REPO_ROOT}/.env"
  set +a
fi
unset _US_ENV_DIR
