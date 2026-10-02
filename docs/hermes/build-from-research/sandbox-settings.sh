#!/usr/bin/env bash
# Write the Claude Code settings a build runs under: <project>/.claude/settings.json.
#
#   sandbox-settings.sh <project-folder>
#
# start-build.sh runs Claude Code with --setting-sources project, so this file
# is the only settings it loads. Commands run without anyone being asked, but
# only inside Claude Code's sandbox, never outside it:
#   - writing: the project folder (and the temporary folder) only;
#   - reading: not ~/.config/jarvis (the alerts token), ~/.hermes, ~/.ssh,
#     ~/.aws, or the sites share;
#   - network: npm's registry only, so npm install works and nothing else does.
# The same paths are closed to Claude Code's own Read and Edit tools, and its
# web tools are off: the build has the research it needs in RESEARCH.md.
# If the sandbox cannot start, Claude Code refuses to run rather than run without it.
set -euo pipefail

[ -r "$HOME/.config/jarvis/env" ] && . "$HOME/.config/jarvis/env"
dir="${1:?usage: sandbox-settings.sh <project-folder>}"
[ -d "$dir" ] || { echo "$dir is not a folder." >&2; exit 2; }

mkdir -p "$dir/.claude"
python3 - "$dir/.claude/settings.json" "$HOME" "${SITES_DIR:-}" <<'PY'
import json, sys
path, home, sites = sys.argv[1], sys.argv[2], sys.argv[3]
closed = [f"{home}/.config/jarvis", f"{home}/.hermes", f"{home}/.ssh", f"{home}/.aws"]
if sites:
    closed.append(sites)
settings = {
    "sandbox": {
        "enabled": True,
        "failIfUnavailable": True,
        "autoAllowBashIfSandboxed": True,
        "allowUnsandboxedCommands": False,
        "filesystem": {"denyRead": closed},
        "network": {"allowedDomains": ["registry.npmjs.org"], "allowLocalBinding": False},
    },
    "permissions": {
        # Permission rules write an absolute path with a leading "//".
        "deny": [f"{tool}(/{p}/**)" for p in closed for tool in ("Read", "Edit")] + ["WebFetch", "WebSearch"],
    },
}
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PY
