#!/usr/bin/env bash
# Run Claude Code once in a project folder, the one way start-build.sh and
# sandbox-check.sh start it:
#   - inside its sandbox, with the settings sandbox-settings.sh writes, and none
#     of this user's own settings, hooks or MCP servers;
#   - with a clean environment: only HOME, PATH and the like, so no secret this
#     machine keeps in the environment (the alerts token, gog's keyring
#     password, Hermes's own keys) reaches the build;
#   - with npm's cache in the project, the one place the sandbox lets it write.
#
#   run-claude.sh <project-folder> "<prompt>"
#
# What Claude Code prints goes to this script's output.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
usage='usage: run-claude.sh <project-folder> "<prompt>"'
dir="${1:?$usage}"
prompt="${2:?$usage}"

"$here/sandbox-settings.sh" "$dir"
cd "$dir"
keep=()
for v in HOME PATH USER LOGNAME SHELL TMPDIR LANG; do
  [ -n "${!v:-}" ] && keep+=("$v=${!v}")
done
exec env -i "${keep[@]}" npm_config_cache="$dir/.npm-cache" claude -p "$prompt" \
  --permission-mode acceptEdits --setting-sources project --strict-mcp-config </dev/null
