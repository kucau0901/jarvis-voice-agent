#!/bin/sh
# Start Jarvis in workerd. Settings may come from the environment, but only
# JARVIS_SHARED_SECRET has to — everything else can be set in the settings
# panel once Jarvis is running.
set -eu

if [ -z "${JARVIS_SHARED_SECRET:-}" ]; then
  echo "jarvis: set JARVIS_SHARED_SECRET — the key that unlocks Jarvis." >&2
  echo "        e.g.  JARVIS_SHARED_SECRET=\$(node -e \"console.log(require('crypto').randomBytes(12).toString('hex').toUpperCase())\")" >&2
  exit 1
fi

# Hand wrangler only names Jarvis knows, never the whole container
# environment: PATH, HOSTNAME and the like are not the Worker's business.
envfile="$(mktemp)"
chmod 600 "$envfile"
env | grep -E '^(JARVIS_SHARED_SECRET|JARVIS_ALLOWED_ORIGINS|OPENAI_API_KEY|ROUTER_MODEL|DISABLE_WEB_SEARCH|PUBLIC_URL|TIMEZONE|COUNTRY|LOCALE|UNITS|DEVICE_DAILY_LIMIT|HA_[A-Z_]+|TESSIE_[A-Z_]+|HERMES_[A-Z_]+|CF_ACCESS_[A-Z_]+|GOOGLE_[A-Z_]+|SPOTIFY_[A-Z_]+|G2_[A-Z_]+)=' > "$envfile" || true

config="$(ls dist/*/wrangler.json | head -n 1)"
echo "jarvis: starting on port ${PORT:-8787}, data in ${DATA_DIR:-/data}"
exec wrangler dev \
  --config "$config" \
  --local \
  --persist-to "${DATA_DIR:-/data}" \
  --env-file "$envfile" \
  --ip 0.0.0.0 \
  --port "${PORT:-8787}" \
  --show-interactive-dev-session=false
