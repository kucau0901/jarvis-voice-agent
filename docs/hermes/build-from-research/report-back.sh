#!/usr/bin/env bash
# Tell the owner something through Jarvis: an alert on their phone, car screen
# or glasses (POST /api/v1/notify).
#
#   report-back.sh "<title>" "<text>"
#   report-back.sh "<title>" --file <path>   the text from a file: for an agent,
#                                            whose shell would expand $ and backticks
#
# Needs, on this machine only:
#   JARVIS_URL, in ~/.config/jarvis/env or the environment (e.g. https://jarvis.example.com)
#   a Jarvis device token holding only the "alerts" permission, in
#   ~/.config/jarvis/alerts-token (chmod 600) or JARVIS_ALERTS_TOKEN.
# An alerts token can also receive that person's alerts: keep it here, and never
# hand it to a build.
set -euo pipefail

[ -r "$HOME/.config/jarvis/env" ] && . "$HOME/.config/jarvis/env"
usage='usage: report-back.sh "<title>" "<text>", or report-back.sh "<title>" --file <path>'
title="${1:?$usage}"
if [ "${2:-}" = "--file" ]; then
  text="$(cat -- "${3:?$usage}")"
else
  text="${2:?$usage}"
fi
[ -n "$text" ] || { echo "$usage" >&2; exit 2; }
url="${JARVIS_URL:?set JARVIS_URL in ~/.config/jarvis/env, e.g. JARVIS_URL=https://jarvis.example.com}"

token="${JARVIS_ALERTS_TOKEN:-}"
if [ -z "$token" ] && [ -r "$HOME/.config/jarvis/alerts-token" ]; then
  token="$(tr -d '[:space:]' <"$HOME/.config/jarvis/alerts-token")"
fi
if [ -z "$token" ]; then
  echo "No alerts token: put it in ~/.config/jarvis/alerts-token." >&2
  exit 2
fi

# JSON built by Python, never by pasting text into quotes: the text may hold anything.
body="$(python3 -c 'import json, sys; print(json.dumps({"title": sys.argv[1][:80], "text": sys.argv[2][:1500]}))' "$title" "$text")"

curl -fsS --max-time 20 -X POST "${url%/}/api/v1/notify" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary "$body" >/dev/null
