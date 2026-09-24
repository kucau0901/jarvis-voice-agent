# Jarvis, self-hosted.
#
# The same code that runs on Cloudflare Workers, run by Cloudflare's own
# open-source runtime (workerd, driven by wrangler in local mode) — not a port,
# so every feature behaves identically. Memory, settings and device tokens live
# in /data; mount a volume there or they are lost when the container goes.
#
# Only JARVIS_SHARED_SECRET is required. Everything else is set in the app's
# settings panel. See README.md → Docker.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# A self-hosted Jarvis has no Cloudflare account: the template is all it needs.
RUN cp wrangler.example.jsonc wrangler.jsonc && npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Only the runtime, at the exact version the lockfile pins — not the whole
# toolchain the build needed.
COPY --from=build /app/package-lock.json ./
RUN npm install -g "wrangler@$(node -p "require('./package-lock.json').packages['node_modules/wrangler'].version")" \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/jarvis-entrypoint
RUN chmod +x /usr/local/bin/jarvis-entrypoint \
 && mkdir -p /data && chown node:node /data

ENV PORT=8787 \
    WRANGLER_SEND_METRICS=false \
    NODE_ENV=production
USER node
VOLUME ["/data"]
EXPOSE 8787
# The app page is public (the API is not), so it makes an honest liveness check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["jarvis-entrypoint"]
