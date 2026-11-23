FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --chown=node:node . .
RUN npm run build

FROM dependencies AS tooling
COPY --chown=node:node . .

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=dependencies --chown=node:node /app/node_modules/pdfjs-dist/build/pdf.worker.min.mjs ./public/pdf.worker.min.mjs
USER node
EXPOSE 3000
CMD ["node", "server.js"]
