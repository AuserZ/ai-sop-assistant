FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /fixture
RUN chown node:node /fixture
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --no-audit --no-fund
COPY --chown=node:node gateway.mjs server.mjs worker.mjs ./
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
