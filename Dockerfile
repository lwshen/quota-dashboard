FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --no-frozen-lockfile

FROM base AS build
COPY --from=deps /app/ /app/
COPY . .
RUN pnpm --filter @quota/web build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
VOLUME ["/app/apps/web/data"]
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
