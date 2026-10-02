#!/usr/bin/env bash
# Check, on this machine, that a build's sandbox holds: start Claude Code the
# way start-build.sh does, in a scratch project with the same settings, have it
# run one probe script, and judge what the probe managed to do.
#
#   sandbox-check.sh
#
# Every line should say ok. It costs one short Claude Code run.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ -r "$HOME/.config/jarvis/env" ] && . "$HOME/.config/jarvis/env"
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code (claude) is not installed on this machine." >&2
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
project="$work/project"
mkdir -p "$project"
"$here/sandbox-settings.sh" "$project"
cat >"$project/probe.sh" <<'PROBE'
out=probe.out
: >"$out"
say() { printf '%s=%s\n' "$1" "$2" >>"$out"; }
if cat "$HOME/.config/jarvis/alerts-token" >/dev/null 2>&1; then say token-read yes; else say token-read no; fi
f="$HOME/.sandbox-check-$$"
if (: >"$f") 2>/dev/null; then say home-write yes; rm -f "$f"; else say home-write no; fi
say npm-registry "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://registry.npmjs.org/left-pad || true)"
say other-site "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com || true)"
if npm --version >/dev/null 2>&1; then say npm yes; else say npm no; fi
say done yes
PROBE

(
  cd "$project"
  env -u JARVIS_ALERTS_TOKEN npm_config_cache="$project/.npm-cache" claude -p \
    "Run this one command with the Bash tool, exactly as written, and nothing else: bash probe.sh" \
    --permission-mode acceptEdits --setting-sources project --strict-mcp-config >"$work/claude.log" 2>&1
) || true

if ! grep -q '^done=yes$' "$project/probe.out" 2>/dev/null; then
  echo "FAIL  Claude Code did not run the probe, so builds can't run commands either. It said: $(tail -c 400 "$work/claude.log" | tr '\n' ' ')"
  exit 1
fi
got() { sed -n "s/^$1=//p" "$project/probe.out"; }
bad=0
ok() { echo "ok    $1"; }
no() { echo "FAIL  $1"; bad=1; }

if [ -e "$HOME/.config/jarvis/alerts-token" ]; then
  [ "$(got token-read)" = no ] && ok "the alerts token can't be read" || no "the alerts token can be read"
else
  echo "skip  the alerts token: there is no ~/.config/jarvis/alerts-token yet"
fi
[ "$(got home-write)" = no ] && ok "nothing can be written outside the project" || no "files can be written outside the project"
[ "$(got npm-registry)" = 200 ] && ok "npm's registry is reachable" || no "npm's registry is not reachable (it answered $(got npm-registry)): npm install would fail"
[ "$(got other-site)" != 200 ] && ok "other websites are not reachable" || no "other websites are reachable"
[ "$(got npm)" = yes ] && ok "npm runs" || echo "note  npm isn't installed: builds can't use npm, plain HTML still works"
exit "$bad"
