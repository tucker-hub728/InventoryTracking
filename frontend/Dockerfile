# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Frontend — Next.js 14. Multi-stage:
#
#   stage `base`  : node 20 alpine, no deps.
#   stage `deps`  : npm ci into /app/node_modules (cached).
#   stage `dev`   : runs `next dev`. Source is bind-mounted by compose.
#   stage `build` : runs `next build` to produce .next/.
#   stage `prod`  : runtime-only image using `next start`. Non-root.
#
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20.18-alpine

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV NODE_ENV=development
WORKDIR /app
# libc6-compat is needed for some prebuilt binaries (sharp, esbuild)
RUN apk add --no-cache libc6-compat

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ── dev ──────────────────────────────────────────────────────────────────────
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
# WATCHPACK_POLLING=true makes the watcher work over Windows bind mounts.
ENV WATCHPACK_POLLING=true \
    CHOKIDAR_USEPOLLING=true
CMD ["npm", "run", "dev"]

# ── build (used for prod image) ──────────────────────────────────────────────
FROM base AS build
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── prod ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS prod
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Run as a non-root user.
RUN addgroup --system --gid 10001 nodejs \
    && adduser  --system --uid 10001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next       ./.next
COPY --from=build --chown=nextjs:nodejs /app/public      ./public
COPY --from=build --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget --quiet --spider http://localhost:3000 || exit 1

CMD ["npm", "run", "start"]
