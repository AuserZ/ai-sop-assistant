FROM docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencies
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM pgvector/pgvector:0.8.3-pg18-trixie@sha256:6232c5ea178707f278d060b51747c30f310164595674e95d5f9d100f4a48b56c AS runtime
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies --chown=1000:1000 /app/package.json /app/package.json
COPY --from=dependencies --chown=1000:1000 /app/node_modules /app/node_modules
COPY --chown=1000:1000 infra/backup ./infra/backup
COPY --chown=1000:1000 drizzle/meta/_journal.json ./drizzle/meta/_journal.json
COPY --chown=1000:1000 n8n ./n8n
USER 1000:1000
CMD ["node", "infra/backup/schedule.mjs"]
