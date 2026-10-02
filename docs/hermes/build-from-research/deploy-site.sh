#!/usr/bin/env bash
# Publish a built project as a static site on the Synology: copy its files into
# the shared folder the Caddy container there serves, so <name>.<domain> shows it.
#
#   deploy-site.sh <folder-name>
#
# Needs, in ~/.config/jarvis/env:
#   SITES_DIR=/Volumes/sites     the Synology's "sites" share, mounted on this Mac
#   SITE_DOMAIN=example.com      *.example.com reaches the Caddy container (Cloudflare Tunnel)
# Copies the folder without its Markdown files (the instruction, the report, any
# README or notes), build.log and dot-files. A name some other service already
# answers to is refused. Prints the site's address.
set -euo pipefail

[ -r "$HOME/.config/jarvis/env" ] && . "$HOME/.config/jarvis/env"
root="${BUILD_ROOT:-$HOME/projects}"
name="${1:-}"

case "$name" in
  "" | -* | *[!a-z0-9-]*)
    echo "The folder name must be lowercase letters, digits and dashes, e.g. ev-cost." >&2
    exit 2 ;;
esac
sites="${SITES_DIR:-}"
domain="${SITE_DOMAIN:-}"
if [ -z "$sites" ] || [ -z "$domain" ]; then
  echo "Set SITES_DIR and SITE_DOMAIN in ~/.config/jarvis/env first." >&2
  exit 2
fi
case "$sites" in
  / | "$HOME" | "$HOME"/ | "$root" | "$root"/*)
    echo "SITES_DIR looks wrong: $sites" >&2
    exit 2 ;;
esac
src="$root/$name"
if [ ! -f "$src/index.html" ]; then
  echo "$src has no index.html: there is nothing to publish." >&2
  exit 2
fi
if [ ! -d "$sites" ] || [ ! -w "$sites" ]; then
  echo "$sites is not mounted or not writable: connect to the Synology's sites share first." >&2
  exit 2
fi

url="https://$name.$domain"
# A name not published yet should get the web server's 404: any other answer
# is something else already living at that address.
if [ ! -d "$sites/$name" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)"
  case "$code" in
    404 | 000 | 5*) ;;
    *) echo "$url is already in use (it answers $code): choose another name." >&2; exit 2 ;;
  esac
fi

mkdir -p "$sites/$name"
rsync -a --delete --exclude '*.md' --exclude build.log --exclude '.*' "$src/" "$sites/$name/"
echo "$url"
