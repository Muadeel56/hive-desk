# Single-stage image for the HiveDesk API. Phase 9 turns this into a multi-stage
# build with an entrypoint that runs `prisma migrate deploy` on start.
FROM node:22-alpine

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Prisma schema is needed before `prisma generate`
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
