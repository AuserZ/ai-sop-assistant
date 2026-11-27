FROM docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencies
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
ARG R2_ENDPOINT=""
ENV NEXT_TELEMETRY_DISABLED=1 R2_ENDPOINT=${R2_ENDPOINT}
COPY --chown=node:node . .
RUN npm run build

FROM dependencies AS tooling
COPY --chown=node:node . .

FROM docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=dependencies --chown=node:node /app/node_modules/pdfjs-dist/build/pdf.worker.min.mjs ./public/pdf.worker.min.mjs
USER node
EXPOSE 3000
CMD ["node", "server.js"]
