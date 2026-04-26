FROM node:22-alpine AS build
WORKDIR /repo

# Build deps for native modules (better-sqlite3). Alpine = musl so the
# prebuilt artifacts don't apply; we compile from source.
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# Workspace skeleton
COPY package.json pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY server/package.json server/

RUN pnpm install --frozen-lockfile=false --filter @ctb/server... --filter @ctb/shared

# Source
COPY shared/ shared/
COPY server/ server/

RUN pnpm --filter @ctb/shared build && pnpm --filter @ctb/server build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache su-exec libstdc++

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/shared/package.json shared/
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/server/package.json server/
COPY --from=build /repo/server/dist server/dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/server/node_modules server/node_modules
COPY --from=build /repo/shared/node_modules shared/node_modules

ENV CTB_DB_PATH=/data/clients.sqlite \
    CTB_KEYS_PATH=/data/server-keypair.json \
    CTB_CREDENTIALS_PATH=/mirror/credentials.json \
    CTB_PORT=9990

EXPOSE 9990
WORKDIR /app/server
CMD ["node", "dist/index.js"]
