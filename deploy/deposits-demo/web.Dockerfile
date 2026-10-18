# Deposits demo web image (Next production server). Build from the repository root:
#   docker build -f deploy/deposits-demo/web.Dockerfile -t dive-deposits-web .
FROM node:26.8.1-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Node 26 no longer bundles corepack; pin pnpm through npm instead.
RUN npm install --global pnpm@11.2.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN node tests/support/next-command.ts build && chown -R node:node .next
USER node
# Listens inside the API container's network namespace; the API stays on loopback.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
