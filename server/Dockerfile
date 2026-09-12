# Multi-stage image for the HiveDesk API. The same image runs both the API
# (default CMD) and the analytics worker (compose overrides `command:` to
# `node src/jobs/worker.js`) — both go through docker-entrypoint.sh first,
# which waits for Postgres and runs `prisma migrate deploy`.

# ---- Stage 1: install full deps + generate the Prisma client ----
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Prisma schema is needed before `prisma generate`
COPY prisma ./prisma
RUN npx prisma generate

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# `nc` is used by docker-entrypoint.sh to wait for Postgres.
RUN apk add --no-cache netcat-openbsd

RUN addgroup -S hivedesk && adduser -S hivedesk -G hivedesk

# Prod-only node_modules for a smaller runtime image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# `npm ci --omit=dev` above reinstalls a clean @prisma/client with no
# generated code, and never installs `prisma` (a devDependency) at all — so
# layer the generated client and the CLI back in from the deps stage. The CLI
# is needed at runtime because docker-entrypoint.sh runs `prisma migrate deploy`.
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

COPY prisma ./prisma
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x docker-entrypoint.sh && chown -R hivedesk:hivedesk /app

USER hivedesk

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
