#!/bin/zsh
set -e
cd -- "${0:A:h}/editor"

url='http://127.0.0.1:4174/'
is_prism_running() {
  curl --noproxy '*' --silent --fail --max-time 1 "${url}api/health" | /usr/bin/grep -q '"engine": "prism-print/'
}

if is_prism_running; then
  open "$url"
  exit 0
fi

runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH:$runtime/node/bin:$runtime/bin/fallback"

if [[ ! -f dist/index.html ]]; then
  if ! command -v node >/dev/null || ! command -v pnpm >/dev/null; then
    print -u2 '请先安装 Node.js 和 pnpm，再双击启动。详见项目 README.md。'
    exit 1
  fi
  pnpm install --frozen-lockfile
  pnpm build
fi

if [[ -x .venv/bin/python ]]; then
  python_command=.venv/bin/python
elif [[ -x "$runtime/python/bin/python3" ]] && "$runtime/python/bin/python3" -c 'import numpy, PIL, pypdf, reportlab' 2>/dev/null; then
  python_command="$runtime/python/bin/python3"
else
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt
  python_command=.venv/bin/python
fi

"$python_command" -u server.py &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM HUP

for attempt in {1..50}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit 1
  fi
  if is_prism_running; then
    open "$url"
    wait "$server_pid"
    exit $?
  fi
  sleep 0.2
done
print -u2 'Prism 启动超时。请查看上方的错误信息后重试。'
exit 1
