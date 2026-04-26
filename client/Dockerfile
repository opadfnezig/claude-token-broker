FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

COPY package.json pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY client/package.json client/

RUN pnpm install --frozen-lockfile=false --filter @ctb/client... --filter @ctb/shared

COPY shared/ shared/
COPY client/ client/

RUN pnpm --filter @ctb/shared build && pnpm --filter @ctb/client build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/shared/package.json shared/
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/client/package.json client/
COPY --from=build /repo/client/dist client/dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/shared/node_modules shared/node_modules
COPY --from=build /repo/client/node_modules client/node_modules

EXPOSE 9991
WORKDIR /app/client
CMD ["node", "dist/index.js"]
