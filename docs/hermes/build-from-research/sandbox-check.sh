#!/usr/bin/env bash
# Check, on this machine, that a build's sandbox holds: start Claude Code the
# way start-build.sh does (run-claude.sh), in a scratch project, have it run one
# probe script, and judge what the probe managed to do.
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
# Where gog keeps its Google keys, as sandbox-settings.sh closes them: the probe
# reads this list, since the build's environment has no XDG_CONFIG_HOME.
gog_dirs=("$HOME/Library/Application Support/gogcli" "${XDG_CONFIG_HOME:-$HOME/.config}/gogcli")
printf '%s\n' "${gog_dirs[@]}" >"$project/gog-dirs"
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
gog=no
# Anything listed counts as read: on Linux a hidden folder shows up empty.
while IFS= read -r d; do
  if [ -n "$(ls -A "$d" 2>/dev/null)" ]; then gog=yes; fi
done <gog-dirs
say gog-read "$gog"
say env " $(env | cut -d= -f1 | tr '\n' ' ')"
say done yes
PROBE

"$here/run-claude.sh" "$project" \
  "Run this one command with the Bash tool, exactly as written, and nothing else: bash probe.sh" \
  >"$work/claude.log" 2>&1 || true

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
if [ -d "${gog_dirs[0]}" ] || [ -d "${gog_dirs[1]}" ]; then
  [ "$(got gog-read)" = no ] && ok "gog's Google keys can't be read" || no "gog's Google keys can be read"
else
  echo "skip  gog's Google keys: gog isn't set up here"
fi
# The secrets in this environment (Hermes's) must not be in the build's. The
# sandbox adds its own proxy login, which is no secret of ours.
leaked=""
for v in $(env | cut -d= -f1 | grep -E 'TOKEN|SECRET|PASSWORD|_KEY' || true); do
  case "$(got env) " in *" $v "*) leaked="$leaked $v" ;; esac
done
[ -z "$leaked" ] && ok "none of this machine's secrets in the build's environment" || no "secrets in the build's environment:$leaked"
exit "$bad"
